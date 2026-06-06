// Workflow Rooms — path/sanitize/locking/file helpers and room-context resolvers.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 1.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentName } from "../types";
import {
	AGENT_ID_MAX,
	ROLE_MAX,
	ROOM_BRAIN_AGENT_ID,
	ROOM_DEFAULT_AGENT_ID,
	ROOM_DIR_NAME,
	ROOM_ENV_AGENT_ID,
	ROOM_ENV_AGENT_ROLE,
	ROOM_ENV_ROOM_ID,
	ROOM_ENV_ROOM_ROOT,
	ROOM_ID_MAX,
	ROOM_LOCK_RETRY_BASE_MS,
	ROOM_LOCK_TIMEOUT_MS,
	type ResolvedRoomContext,
	type RoomAgentState,
	type RoomEvent,
} from "./types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile<T = Record<string, unknown>>(filePath: string): T | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch (error) {
		console.error(
			`[brain-workflow] Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function sanitizeRoomId(input: string): string {
	const base = String(input ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, ROOM_ID_MAX);
	return base || "room";
}

export function sanitizeAgentId(input: string): string {
	const base = String(input ?? "")
		.trim()
		.replace(/[^\w.-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, AGENT_ID_MAX);
	return base || ROOM_DEFAULT_AGENT_ID;
}

export function appendAgentIdSuffix(base: string, suffix: string): string {
	const cleanSuffix = sanitizeAgentId(suffix);
	const maxBase = Math.max(1, AGENT_ID_MAX - cleanSuffix.length - 1);
	const cleanBase =
		sanitizeAgentId(base).slice(0, maxBase).replace(/[._-]+$/g, "") || ROOM_DEFAULT_AGENT_ID;
	return sanitizeAgentId(`${cleanBase}-${cleanSuffix}`);
}

export function sanitizeRole(input: string): string {
	const base = String(input ?? "")
		.trim()
		.replace(/[^\w.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, ROLE_MAX);
	return base || ROOM_DEFAULT_AGENT_ID;
}

export function generateRoomId(): string {
	const stamp = new Date()
		.toISOString()
		.replace(/[-:.TZ]/g, "")
		.slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 8);
	return `room-${stamp}-${rand}`;
}

export function getWorkflowRunsRoot(cwd: string): string {
	const fromEnv = process.env[ROOM_ENV_ROOM_ROOT];
	if (fromEnv && fromEnv.trim()) return fromEnv;
	return path.join(cwd, ".pi", ROOM_DIR_NAME);
}

export function getRoomDir(cwd: string, roomId: string): string {
	return path.join(getWorkflowRunsRoot(cwd), roomId);
}

export function getRoomCurrentPointerPath(cwd: string): string {
	return path.join(getWorkflowRunsRoot(cwd), "current.json");
}

export function getRoomEventsPath(cwd: string, roomId: string): string {
	return path.join(getRoomDir(cwd, roomId), "events.jsonl");
}

export function getRoomAgentsPath(cwd: string, roomId: string): string {
	return path.join(getRoomDir(cwd, roomId), "agents.json");
}

export function getRoomLockPath(cwd: string, roomId: string): string {
	return path.join(getRoomDir(cwd, roomId), ".lock");
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export async function withRoomLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
	timeoutMs: number = ROOM_LOCK_TIMEOUT_MS,
): Promise<T> {
	ensureDir(path.dirname(lockPath));
	const deadline = Date.now() + timeoutMs;
	let fd: number | undefined;
	while (true) {
		try {
			fd = fs.openSync(lockPath, "wx");
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			if (Date.now() > deadline) throw new Error(`Room lock timeout: ${lockPath}`);
			await new Promise((r) =>
				setTimeout(r, ROOM_LOCK_RETRY_BASE_MS + Math.random() * ROOM_LOCK_RETRY_BASE_MS),
			);
		}
	}
	try {
		return await fn();
	} finally {
		try {
			if (fd !== undefined) fs.closeSync(fd);
		} catch {
			// ignore
		}
		try {
			fs.unlinkSync(lockPath);
		} catch {
			// ignore
		}
	}
}

export function readEventsFile(eventsPath: string): RoomEvent[] {
	if (!fs.existsSync(eventsPath)) return [];
	const text = fs.readFileSync(eventsPath, "utf-8");
	if (!text.trim()) return [];
	const events: RoomEvent[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as RoomEvent);
		} catch {
			// skip malformed line
		}
	}
	return events;
}

export function nextSeq(events: RoomEvent[]): number {
	let max = 0;
	for (const e of events) if (typeof e.seq === "number" && e.seq > max) max = e.seq;
	return max + 1;
}

export function readAgentsFile(agentsPath: string): Record<string, RoomAgentState> {
	if (!fs.existsSync(agentsPath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
		return isPlainObject(parsed) ? (parsed as Record<string, RoomAgentState>) : {};
	} catch {
		return {};
	}
}

export function writeAgentsFile(agentsPath: string, agents: Record<string, RoomAgentState>): void {
	fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2) + "\n", "utf-8");
}

export function readCurrentRoomPointer(cwd: string): string | undefined {
	const data = readJsonFile<{ roomId?: string }>(getRoomCurrentPointerPath(cwd));
	const candidate = typeof data?.roomId === "string" ? data.roomId : "";
	return candidate ? sanitizeRoomId(candidate) : undefined;
}

export function writeCurrentRoomPointer(cwd: string, roomId: string): void {
	ensureDir(getWorkflowRunsRoot(cwd));
	fs.writeFileSync(
		getRoomCurrentPointerPath(cwd),
		JSON.stringify({ roomId, updatedAt: nowIso() }, null, 2) + "\n",
		"utf-8",
	);
}

export function appendEventLine(eventsPath: string, event: RoomEvent): void {
	fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf-8");
}

export function isMessageRelevantTo(event: RoomEvent, agentId: string): boolean {
	if (event.type !== "message") return false;
	if (event.from && event.from === agentId) return false;
	const to = event.to;
	if (!to) return true;
	return to === agentId;
}

export function resolveRoomIdFromParamsOrEnv(
	params: { roomId?: unknown },
	cwd: string,
): string {
	const fromParams = typeof params.roomId === "string" ? sanitizeRoomId(params.roomId) : "";
	if (fromParams) return fromParams;
	const fromEnv = process.env[ROOM_ENV_ROOM_ID]
		? sanitizeRoomId(process.env[ROOM_ENV_ROOM_ID] ?? "")
		: "";
	if (fromEnv) return fromEnv;
	if (process.env.PI_WORKFLOW_CHILD === "1") {
		throw new Error(
			`roomId required in child sessions: pass it explicitly or delegate with room context so ${ROOM_ENV_ROOM_ID} is set`,
		);
	}
	const current = readCurrentRoomPointer(cwd);
	if (current) return current;
	throw new Error(
		`roomId required: pass it explicitly, set ${ROOM_ENV_ROOM_ID} env var, or call room_create first`,
	);
}

export function resolveAgentIdFromParamsOrEnv(params: { agentId?: unknown }): string {
	const fromParams =
		typeof params.agentId === "string" ? sanitizeAgentId(params.agentId) : "";
	if (fromParams && fromParams !== ROOM_DEFAULT_AGENT_ID) return fromParams;
	const fromEnv = process.env[ROOM_ENV_AGENT_ID]
		? sanitizeAgentId(process.env[ROOM_ENV_AGENT_ID] ?? "")
		: "";
	if (fromEnv && fromEnv !== ROOM_DEFAULT_AGENT_ID) return fromEnv;
	if (process.env.PI_WORKFLOW_CHILD !== "1") {
		return ROOM_BRAIN_AGENT_ID;
	}
	throw new Error(`agentId required: pass it explicitly or set ${ROOM_ENV_AGENT_ID} env var`);
}

export function resolveRoleFromParamsOrEnv(
	params: { role?: unknown },
	fallbackAgentId: string,
): string {
	const fromParams = typeof params.role === "string" ? sanitizeRole(params.role) : "";
	if (fromParams && fromParams !== ROOM_DEFAULT_AGENT_ID) return fromParams;
	const fromEnv = process.env[ROOM_ENV_AGENT_ROLE]
		? sanitizeRole(process.env[ROOM_ENV_AGENT_ROLE] ?? "")
		: "";
	if (fromEnv && fromEnv !== ROOM_DEFAULT_AGENT_ID) return fromEnv;
	return fallbackAgentId;
}

export function resolveRoomContextFromDelegateParams(
	agent: AgentName,
	params: { roomId?: unknown; agentId?: unknown; role?: unknown },
	cwd: string,
): ResolvedRoomContext {
	const fromParams =
		typeof params.roomId === "string" && params.roomId.trim()
			? sanitizeRoomId(params.roomId)
			: "";
	let roomId = fromParams;
	if (!roomId && process.env[ROOM_ENV_ROOM_ID]) {
		roomId = sanitizeRoomId(process.env[ROOM_ENV_ROOM_ID] ?? "");
	}
	if (!roomId && process.env.PI_WORKFLOW_CHILD === "1") {
		throw new Error(
			`delegate.${agent} called with room context in a child session but no explicit roomId/env is set; pass room.roomId or set ${ROOM_ENV_ROOM_ID}`,
		);
	}
	if (!roomId) roomId = readCurrentRoomPointer(cwd) ?? "";
	if (!roomId) {
		throw new Error(
			`delegate.${agent} called with room context but no roomId is set; pass room.roomId, set ${ROOM_ENV_ROOM_ID}, or call room_create first`,
		);
	}
	const defaultAgentId = agent;
	const agentId =
		typeof params.agentId === "string" && params.agentId.trim()
			? sanitizeAgentId(params.agentId)
			: process.env[ROOM_ENV_AGENT_ID]
				? sanitizeAgentId(process.env[ROOM_ENV_AGENT_ID] ?? "")
				: defaultAgentId;
	const role =
		typeof params.role === "string" && params.role.trim()
			? sanitizeRole(params.role)
			: process.env[ROOM_ENV_AGENT_ROLE]
				? sanitizeRole(process.env[ROOM_ENV_AGENT_ROLE] ?? "")
				: defaultAgentId;
	return { roomId, agentId, role };
}
