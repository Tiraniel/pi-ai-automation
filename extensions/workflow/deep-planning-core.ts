// Workflow deep-planning core helpers.

import * as fs from "node:fs";
import type { AgentPreset, DeepPlanningConfig, DeepPlanningPlannerConfig, DelegateRunResult, ThinkingLevel } from "./types";
import { THINKING_LEVELS } from "./types";
import {
	appendEventLine,
	ensureDir,
	generateRoomId,
	getRoomAgentsPath,
	getRoomDir,
	getRoomEventsPath,
	getRoomLockPath,
	nextSeq,
	readAgentsFile,
	readEventsFile,
	sanitizeAgentId,
	sanitizeRoomId,
	writeAgentsFile,
	withRoomLock,
	writeCurrentRoomPointer,
} from "./rooms/store";
import type { RoomEvent } from "./rooms";
import { previewEvent } from "./rooms/prompt";
import { DEFAULT_CONFIG } from "./defaults";
import { Type } from "typebox";

export const TOOL_NAME = "workflow_deep_plan";
export const MAX_ROOM_PREVIEW_LINES = 40;
export const MAX_RESULT_PREVIEW = 1200;
export const PLANNER_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"room_create",
	"room_job_start",
	"room_send",
	"room_read",
	"room_job_done",
	"room_status",
];

export const ThinkingLevelSchema = Type.Union(THINKING_LEVELS.map((value) => Type.Literal(value)));

export type PlannerRoundResult = {
	plannerId: string;
	plannerRole: string;
	round: number;
	status: string;
	exitCode: number;
	model?: string;
	thinkingLevel?: string;
	reason?: string;
	outputPreview: string;
};

export type DeepPlanningSummary = {
	roomId: string;
	roomDir: string;
	enabled: boolean;
	rounds: number;
	plannerCount: number;
	maxConcurrency: number;
	planners: Array<{
		id: string;
		role: string;
		provider?: string;
		model?: string;
		thinkingLevel?: string;
	}>;
	plannerResults: PlannerRoundResult[];
	transcriptPreview: string[];
};

export function truncate(value: string, max: number): string {
	if (!value) return "";
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function clampPositive(value: unknown, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
	return n && n > 0 ? n : fallback;
}

export function normalizePlanner(value: unknown): DeepPlanningPlannerConfig | undefined {
	if (!value || typeof value !== "object") return undefined;
	const source = value as Record<string, unknown>;
	const out: DeepPlanningPlannerConfig = {};
	const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : undefined;
	if (id) out.id = id;
	const role = typeof source.role === "string" && source.role.trim() ? source.role.trim() : undefined;
	if (role) out.role = role;
	const provider = typeof source.provider === "string" && source.provider.trim() ? source.provider.trim() : undefined;
	if (provider) out.provider = provider;
	const model = typeof source.model === "string" && source.model.trim() ? source.model.trim() : undefined;
	if (model) out.model = model;
	const modelPreset = typeof source.modelPreset === "string" && source.modelPreset.trim() ? source.modelPreset.trim() : undefined;
	if (modelPreset) out.modelPreset = modelPreset;
	const thinkingLevel = typeof source.thinkingLevel === "string" && THINKING_LEVELS.includes(source.thinkingLevel as ThinkingLevel)
		? (source.thinkingLevel as ThinkingLevel)
		: undefined;
	if (thinkingLevel) out.thinkingLevel = thinkingLevel;
	const instructions = typeof source.instructions === "string" ? source.instructions.trim() : undefined;
	if (instructions) out.instructions = instructions;
	if (Object.keys(out).length === 0) return undefined;
	return out;
}

export function normalizeDeepPlanningToolPlanners(value: unknown): DeepPlanningPlannerConfig[] {
	if (!Array.isArray(value)) return [];
	const out: DeepPlanningPlannerConfig[] = [];
	for (const entry of value) {
		const planner = normalizePlanner(entry);
		if (planner) out.push(planner);
	}
	return out;
}

function dedupePlanners(planners: DeepPlanningPlannerConfig[]): DeepPlanningPlannerConfig[] {
	const seen = new Set<string>();
	const out: DeepPlanningPlannerConfig[] = [];
	for (const planner of planners) {
		const next = { ...planner };
		next.id = next.id?.trim() || `planner-${out.length + 1}`;
		if (seen.has(next.id)) {
			next.id = `${next.id}-${out.length + 1}`;
		}
		if (!next.role?.trim()) next.role = `planner-${out.length + 1}`;
		seen.add(next.id);
		out.push(next);
	}
	return out;
}

export function mergeDeepPlanningConfig(
	base: DeepPlanningConfig | undefined,
	request: {
		force?: boolean;
		plannerCount?: number;
		rounds?: number;
		maxConcurrency?: number;
		planners?: DeepPlanningPlannerConfig[];
	},
): DeepPlanningConfig {
	const source = base ?? DEFAULT_CONFIG.deepPlanning;
	const hasPlannerOverrides = (request.planners ?? []).length > 0;
	const out: DeepPlanningConfig = {
		enabled:
			request.force === true
			|| request.plannerCount !== undefined
			|| request.rounds !== undefined
			|| request.maxConcurrency !== undefined
			|| hasPlannerOverrides
				? true
				: Boolean(source?.enabled),
		plannerCount: clampPositive(request.plannerCount, source?.plannerCount ?? 2),
		maxConcurrency: clampPositive(request.maxConcurrency, source?.maxConcurrency ?? 2),
		rounds: clampPositive(request.rounds, source?.rounds ?? 2),
		roomIdPrefix: source?.roomIdPrefix ?? "deep-plan",
		planners: dedupePlanners(hasPlannerOverrides ? (request.planners ?? []) : (source?.planners ?? [])),
	};
	if ((out.planners?.length ?? 0) > (out.plannerCount ?? 0)) {
		out.planners = (out.planners ?? []).slice(0, out.plannerCount);
	}
	return out;
}

export function buildPlannerRoundPrompt(task: string, planner: DeepPlanningPlannerConfig, round: number, rounds: number): string {
	const roundSummary = round === 1
		? "Round 1: independently inspect the codebase (read, grep, find, ls) and produce a PRD draft with resolved decisions, open questions, options, and risks."
		: "Round 2: read the room transcript, critique prior PRD items, ask at most one highest-value grill-me question with a recommended answer, and update the shared PRD.";
	return `${roundSummary}

Task:
${task}

You are a Product Requirements agent inside a workflow room.
- Do not edit files, write files, or run edit/bash commands.
- Use room_job_start before analysis and room_job_done after your final message.
- Use room_send to post PRD updates, assumptions, options, risks, and questions.
- Call room_read before finishing this round so you can incorporate other planner outputs.
- Ask at most one highest-value question per round; include a recommended answer or default.
- Inspect the codebase (read, grep, find, ls) before asking the user when possible.
- Maintain and update a PRD draft with resolved decisions and unresolved open questions.
- Do not produce implementation plans or code.
- Final output must include: PRD draft, resolved decisions, unresolved user questions, options, risks, ready_for_sprint: yes|no.

Planner context:
- id: ${planner.id}
- role: ${planner.role}
- instructions: ${planner.instructions || ""}
`;
}

export function buildPlannerPreset(planner: DeepPlanningPlannerConfig, task: string, round: number, rounds: number): AgentPreset {
	return {
		provider: planner.provider,
		model: planner.model,
		thinkingLevel: planner.thinkingLevel,
		tools: PLANNER_TOOLS,
		instructions: buildPlannerRoundPrompt(task, planner, round, rounds),
	};
}

export function isEnabledByConfig(config: DeepPlanningConfig): boolean {
	return Boolean(config.enabled);
}

export async function ensurePlanningRoom(
	workflowRoot: string,
	roomId: string | undefined,
	title: string | undefined,
	roomPrefix: string,
): Promise<{ roomId: string; roomDir: string }> {
	const prefix = sanitizeRoomId(roomPrefix) || "deep-plan";
	const requested = roomId ? sanitizeRoomId(roomId) : "";
	const resolvedRoomId = requested || `${prefix}-${generateRoomId()}`;
	const roomDir = getRoomDir(workflowRoot, resolvedRoomId);
	const eventsPath = getRoomEventsPath(workflowRoot, resolvedRoomId);
	const agentsPath = getRoomAgentsPath(workflowRoot, resolvedRoomId);
	const lockPath = getRoomLockPath(workflowRoot, resolvedRoomId);
	ensureDir(roomDir);
	await withRoomLock(lockPath, async () => {
		if (!fs.existsSync(eventsPath)) {
			appendEventLine(eventsPath, {
				seq: 1,
				roomId: resolvedRoomId,
				type: "room_created",
				from: "brain",
				topic: title?.trim() ? `deep-planning: ${title.trim()}` : "deep-planning",
				body: title?.trim() || "Deep-planning room",
				createdAt: new Date().toISOString(),
			});
		}
		if (!fs.existsSync(agentsPath)) writeAgentsFile(agentsPath, {});
	});
	writeCurrentRoomPointer(workflowRoot, resolvedRoomId);
	return { roomId: resolvedRoomId, roomDir };
}

export async function appendRoomMessage(
	workflowRoot: string,
	roomId: string,
	agentId: string,
	role: string,
	message: string,
	topic?: string,
): Promise<void> {
	const eventsPath = getRoomEventsPath(workflowRoot, roomId);
	const agentsPath = getRoomAgentsPath(workflowRoot, roomId);
	const lockPath = getRoomLockPath(workflowRoot, roomId);
	if (!fs.existsSync(eventsPath)) return;
	await withRoomLock(lockPath, async () => {
		const events = readEventsFile(eventsPath);
		const event: RoomEvent = {
			seq: nextSeq(events),
			roomId,
			type: "message",
			from: agentId,
			role,
			topic,
			body: message,
			createdAt: new Date().toISOString(),
		};
		appendEventLine(eventsPath, event);
		const agents = readAgentsFile(agentsPath);
		const existing = agents[agentId];
		agents[agentId] = {
			agentId,
			role,
			status: existing?.status ?? "active",
			lastReadSeq: existing?.lastReadSeq ?? 0,
			updatedAt: new Date().toISOString(),
		};
		writeAgentsFile(agentsPath, agents);
	});
}

export function readRoomTranscriptPreview(workflowRoot: string, roomId: string, limit = MAX_ROOM_PREVIEW_LINES): string[] {
	const eventsPath = getRoomEventsPath(workflowRoot, roomId);
	if (!fs.existsSync(eventsPath)) return [];
	const events = readEventsFile(eventsPath);
	return events.slice(-limit).map((event) => previewEvent(event));
}

export function plannerDescriptor(planner: DeepPlanningPlannerConfig) {
	return {
		id: planner.id || "planner",
		role: planner.role || "planner",
		provider: planner.provider,
		model: planner.model,
		thinkingLevel: planner.thinkingLevel,
	};
}

export function summarizeResult(result: DelegateRunResult): string {
	const final = result.finalOutput?.trim() || result.stderr?.trim() || result.errorMessage?.trim() || "(no output)";
	return truncate(final, MAX_RESULT_PREVIEW);
}

export function roomReadCommand(task: string): string {
	return `Current task: ${task}`;
}

export function readDeepPlanningTranscript(workflowRoot: string, roomId: string, limit = MAX_ROOM_PREVIEW_LINES): string[] {
	return readRoomTranscriptPreview(workflowRoot, roomId, limit);
}
