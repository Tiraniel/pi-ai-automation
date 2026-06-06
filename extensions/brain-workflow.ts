import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// --- Imports from extracted workflow modules --------------------------------

import {
	DEFAULT_CONFIG,
} from "./workflow/defaults";
import {
	GONKA_BROKER_API_KEY_ENV,
	GONKA_BROKER_URL_ENV,
	GONKA_HYBRID_PROFILE_ID,
	GONKA_MODELS,
	GONKA_PROVIDER_NAME,
	getGonkaBrokerUrl,
	getGonkaEnvStatus,
} from "./workflow/profiles";
import {
	KARPATHY_GUIDELINES_PROMPT,
} from "./workflow/prompts";
import type {
	AgentName,
	AgentPreset,
	DelegateProgressItem,
	DelegateRunResult,
	ReviewerSwarmConfig,
	ReviewerTargetResult,
	UsageStats,
	WorkflowConfig,
} from "./workflow/types";
import {
	appendAgentIdSuffix,
	buildRoomCommunicationBlock,
	getWorkflowRunsRoot,
	registerRoomTools,
	resolveRoomContextFromDelegateParams,
	ROOM_ENV_AGENT_ID,
	ROOM_ENV_AGENT_ROLE,
	ROOM_ENV_ROOM_ID,
	ROOM_ENV_ROOM_ROOT,
	ROOM_TOOL_NAMES,
	sanitizeAgentId,
	sanitizeRole,
	type ResolvedRoomContext,
} from "./workflow/rooms";
import {
	applyBrainPreset,
	deepMerge,
	formatPreset,
	getAgentPreset,
	getWorkflowProfile,
	loadGonkaEnvFromDefaultDotenv,
	loadWorkflowConfig,
	resolveModelArg,
	resolveModelLabel,
} from "./workflow/runtime/config";

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PROGRESS_ITEMS = 80;
const MAX_PROGRESS_TEXT = 240;
const MAX_RENDERED_PROGRESS = 14;
const MAX_TASK_PREVIEW = 140;
const MAX_FINAL_OUTPUT_PREVIEW = 500;
const MAX_TOOL_UPDATE_PREVIEW = 180;

const DELEGATE_DISPLAY_ENV = "PI_WORKFLOW_DELEGATE_DISPLAY";
const SUB_AGENT_DONE_TOOL_NAME = "sub_agent_done";
const DELEGATE_DONE_TOOL_NAME = "workflow_delegate_done";
const DELEGATE_DONE_ENV_VAR = "PI_WORKFLOW_DELEGATE_DONE_FILE";
const DELEGATE_PANE_POLL_MS = 600;
const DELEGATE_PANE_MAX_WAIT_MS = 600000;

// Local plain-object guard used by cmux JSON parsing and tool-update
// extraction. The deepMerge/findNearestFile/loadWorkflowConfig helpers in
// ./workflow/runtime/config have their own private copy.
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n");
		if (text.trim()) return text.trim();
	}
	return "";
}

function extractMessageText(message: Message | undefined): string {
	const msg = message as any;
	if (!msg || !Array.isArray(msg.content)) return "";
	return msg.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function extractMessageThinking(message: Message | undefined): { text: string; chars: number } {
	const msg = message as any;
	if (!msg || !Array.isArray(msg.content)) return { text: "", chars: 0 };
	const parts = msg.content.filter((part: any) => part?.type === "thinking" && typeof part.thinking === "string");
	const text = parts.map((part: any) => part.thinking).join("\n").trim();
	return { text, chars: text.length };
}

function findLastAssistantMessage(messages: Message[]): any | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg.role === "assistant") return msg;
	}
	return undefined;
}

function formatDelegateProgressLine(item: DelegateProgressItem, theme: any): string {
	switch (item.type) {
		case "status":
			return theme.fg("dim", `  · ${item.text}`);
		case "tool_start":
			return theme.fg("toolTitle", `  ${item.text}`);
		case "tool_update":
			return theme.fg("dim", `  ${item.text}`);
		case "tool_end":
			return theme.fg("success", `  ${item.text}`);
		case "error":
			return theme.fg("error", `  ${item.text}`);
		case "assistant":
			return theme.fg("muted", `  ${item.text}`);
		case "thinking":
			return theme.fg("thinkingText", `  ${item.text}`);
		default:
			return theme.fg("dim", `  ${item.text}`);
	}
}

function truncateText(text: string, max = MAX_PROGRESS_TEXT): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}

function countThinkingChars(messages: Message[]): number {
	const msg = findLastAssistantMessage(messages);
	return msg ? extractMessageThinking(msg).chars : 0;
}

function isFailed(result: DelegateRunResult): boolean {
	return result.aborted || result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function normalizeFinalStatus(result: Pick<DelegateRunResult, "aborted" | "stopReason" | "exitCode">): "failed" | "aborted" | "completed" {
	if (result.aborted || result.stopReason === "aborted") return "aborted";
	if (result.exitCode !== 0 || result.stopReason === "error") return "failed";
	return "completed";
}

function parseReviewerVerdict(text: string): "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN" {
	const normalized = text.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const token = trimmed.split(/\s+/)[0]?.toUpperCase() ?? "";
		if (token === "APPROVED") return "APPROVED";
		if (/^CHANGES[_\s-]?REQUESTED$/.test(token) || token === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
		if (/^CHANGES[_\s-]?REQUESTED$/.test(trimmed.toUpperCase())) return "CHANGES_REQUESTED";
		break;
	}

	const upper = normalized.toUpperCase();
	const approvedIndex = upper.search(/\bAPPROVED\b/);
	const changesIndex = upper.search(/\bCHANGES[_\s-]?REQUESTED\b/);
	if (approvedIndex >= 0 && (changesIndex < 0 || approvedIndex < changesIndex)) return "APPROVED";
	if (changesIndex >= 0) return "CHANGES_REQUESTED";
	return "UNKNOWN";
}

function resolveReviewerSwarmConfig(config: WorkflowConfig): Required<ReviewerSwarmConfig> {
	const merged = deepMerge(DEFAULT_CONFIG.reviewerSwarm ?? {}, config.reviewerSwarm ?? {});
	const targets = Array.isArray(merged.targets) ? merged.targets.filter((target): target is string => typeof target === "string" && target.trim().length > 0) : [];
	return {
		enabled: merged.enabled !== false,
		maxConcurrency: Math.max(1, Number(merged.maxConcurrency ?? 2) || 2),
		targets: targets.length ? targets : [...(DEFAULT_CONFIG.reviewerSwarm?.targets ?? [])],
	};
}

function buildReviewerGoalTask(task: string, goal: string): string {
	return `${task}\n\nAssigned review goal:\n- ${goal}\n\nFocus strictly on this goal. Start your response with APPROVED or CHANGES_REQUESTED.`;
}

function extractToolUpdatePreview(partialResult: unknown): string {
	if (typeof partialResult === "string") return truncateText(partialResult, MAX_TOOL_UPDATE_PREVIEW);
	if (!isPlainObject(partialResult)) return "";

	const candidates: unknown[] = [];
	const content = partialResult.content;
	if (typeof content === "string") candidates.push(content);
	if (Array.isArray(content)) {
		for (const item of content) {
			if (typeof item === "string") candidates.push(item);
			else if (isPlainObject(item) && typeof item.text === "string") candidates.push(item.text);
		}
	}
	if (typeof partialResult.output === "string") candidates.push(partialResult.output);
	if (typeof partialResult.stdout === "string") candidates.push(partialResult.stdout);
	if (typeof partialResult.stderr === "string") candidates.push(partialResult.stderr);
	if (typeof partialResult.summary === "string") candidates.push(partialResult.summary);
	if (isPlainObject(partialResult.details) && typeof partialResult.details.summary === "string") {
		candidates.push(partialResult.details.summary);
	}

	for (const candidate of candidates) {
		const text = truncateText(String(candidate), MAX_TOOL_UPDATE_PREVIEW);
		if (text) return text;
	}
	return "";
}

function appendCapped(current: string, next: string, maxBytes: number): string {
	const combined = current + next;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
	let trimmed = combined.slice(-maxBytes);
	while (Buffer.byteLength(trimmed, "utf8") > maxBytes) trimmed = trimmed.slice(1);
	return trimmed;
}

function resolveChildExtensionSource(source: string, parentCwd: string): string {
	const expanded = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
	if (path.isAbsolute(expanded)) return expanded;
	const abs = path.resolve(parentCwd, expanded);
	if (fs.existsSync(abs)) return abs;
	return source;
}

function getInheritedExtensionArgs(parentCwd: string): string[] {
	const argv = process.argv.slice(2);
	const inherited: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--no-extensions" || arg === "-ne") {
			inherited.push("--no-extensions");
			continue;
		}
		if (arg === "-e" || arg === "--extension") {
			const source = argv[i + 1];
			if (source) {
				inherited.push(arg, resolveChildExtensionSource(source, parentCwd));
				i++;
			}
			continue;
		}
		if (arg.startsWith("--extension=")) {
			const source = arg.slice("--extension=".length);
			inherited.push("--extension", resolveChildExtensionSource(source, parentCwd));
			continue;
		}
		// Forward the opt-in workflow profile so child delegates spawned by
		// the parent apply the same gonka-hybrid (or other) profile.
		if (arg === "--workflow-profile" && i + 1 < argv.length) {
			inherited.push(arg, argv[i + 1]);
			i++;
			continue;
		}
		if (arg.startsWith("--workflow-profile=")) {
			inherited.push(arg);
		}
	}
	return inherited;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

async function writeSystemPromptFile(agent: string, text: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-"));
	const safeAgent = agent.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `${safeAgent}-system.md`);
	await fs.promises.writeFile(filePath, text, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

async function removeTempPrompt(dir: string | null, filePath: string | null): Promise<void> {
	if (filePath) {
		try {
			await fs.promises.unlink(filePath);
		} catch {
			// ignore
		}
	}
	if (dir) {
		try {
			await fs.promises.rmdir(dir);
		} catch {
			// ignore
		}
	}
}

function resolveDelegateDisplayMode(config: WorkflowConfig): "headless" | "pane" {
	const fromEnv = process.env[DELEGATE_DISPLAY_ENV]?.trim().toLowerCase();
	if (fromEnv === "headless" || fromEnv === "pane") return fromEnv;
	const fromConfig = config.delegateDisplay?.trim().toLowerCase();
	if (fromConfig === "headless" || fromConfig === "pane") return fromConfig;
	if (fromEnv === "auto" || fromConfig === "auto") {
		return isCmuxAvailable() ? "pane" : "headless";
	}
	return "headless";
}

function isCmuxAvailable(): boolean {
	if (!process.env.CMUX_SOCKET_PATH) return false;
	try {
		const result = spawnSync("cmux", ["identify", "--json"], { encoding: "utf8", timeout: 3000 });
		return result.status === 0;
	} catch {
		try {
			const result = spawnSync("cmux", ["--version"], { encoding: "utf8", timeout: 3000 });
			return result.status === 0;
		} catch {
			return false;
		}
	}
}

function sendCmuxCommand(args: string[]): { stdout: string; stderr: string; ok: boolean } {
	try {
		const result = spawnSync("cmux", args, { encoding: "utf8", timeout: 10000 });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", ok: result.status === 0 };
	} catch (error) {
		return { stdout: "", stderr: String(error), ok: false };
	}
}

interface CmuxSurfaceContext {
	workspace?: string;
	pane?: string;
	window?: string;
}

function readStringField(source: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function parseCmuxSurfaceContext(stdout: string): CmuxSurfaceContext | undefined {
	try {
		const parsed = JSON.parse(stdout);
		if (!isPlainObject(parsed)) return undefined;
		const source = isPlainObject(parsed.caller) ? parsed.caller : isPlainObject(parsed.focused) ? parsed.focused : parsed;
		const context = {
			workspace: readStringField(source, ["workspace_ref", "workspace"]),
			pane: readStringField(source, ["pane_ref", "pane"]),
			window: readStringField(source, ["window_ref", "window"]),
		};
		return context.workspace || context.pane || context.window ? context : undefined;
	} catch {
		return undefined;
	}
}

const cmuxWorkspaceCache = new Map<string, string>();

function deriveGroupKeyAndTitle(roomContext: ResolvedRoomContext | undefined, task: string): { groupKey: string; groupTitle: string } {
	if (roomContext?.roomId) {
		return { groupKey: roomContext.roomId, groupTitle: roomContext.roomId };
	}
	const taskIdMatch = task.match(/\b([A-Z]+-\d+)\b/);
	if (taskIdMatch) {
		return { groupKey: taskIdMatch[1], groupTitle: taskIdMatch[1] };
	}
	const hash = createHash("sha256").update(task).digest("hex").slice(0, 8);
	const preview = task.slice(0, 20).replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
	const title = `${preview || "task"}-${hash}`;
	return { groupKey: title, groupTitle: title };
}

function buildTabTitle(groupTitle: string, roomContext: ResolvedRoomContext | undefined, agent: AgentName): string {
	const roleLabel = roomContext?.role
		? sanitizeRole(roomContext.role)
		: roomContext?.agentId
		? sanitizeAgentId(roomContext.agentId)
		: agent;
	const safeGroup = groupTitle.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
	const safeRole = roleLabel.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || agent;
	return `${safeGroup}-${safeRole}`;
}

function createCmuxDelegateTab(title: string, workspace?: string): string | null {
	const args = ["new-surface", "--type", "terminal"];
	if (workspace) {
		args.push("--workspace", workspace);
	} else {
		// Gather caller context so the new surface opens in the same workspace/pane
		const context = parseCmuxSurfaceContext(sendCmuxCommand(["identify", "--json"]).stdout);
		if (context?.workspace) args.push("--workspace", context.workspace);
		if (context?.pane) args.push("--pane", context.pane);
		if (context?.window) args.push("--window", context.window);
	}
	const result = sendCmuxCommand(args);
	if (!result.ok) return null;
	const match = result.stdout.trim().match(/surface:(\d+)/);
	if (!match) return null;
	const surfaceId = match[0]; // preserve "surface:<n>" form
	if (title) {
		sendCmuxCommand(["rename-tab", "--surface", surfaceId, title]);
	}
	return surfaceId;
}

function createCmuxWorkspaceForGroup(groupTitle: string, firstSurfaceId: string): string | undefined {
	const moveResult = sendCmuxCommand(["move-tab-to-new-workspace", "--surface", firstSurfaceId, "--title", groupTitle]);
	if (!moveResult.ok) return undefined;
	const identifyResult = sendCmuxCommand(["identify", "--json", "--no-caller", "--surface", firstSurfaceId]);
	const context = parseCmuxSurfaceContext(identifyResult.stdout);
	return context?.workspace;
}

function closeCmuxSurface(surfaceId: string): void {
	sendCmuxCommand(["close-surface", "--surface", surfaceId]);
}

function shellEscape(str: string): string {
	if (!/[^\w@%=+,./-]/.test(str)) return str;
	return "'" + str.replace(/'/g, "'\"'\"'") + "'";
}

function buildAgentSystemPrompt(agent: AgentName, preset: AgentPreset, roomContext?: ResolvedRoomContext, paneMode?: boolean): string {
	const configured = preset.instructions?.trim() ?? "";
	const includeKarpathyGuidelines = agent === "coder" ? preset.includeKarpathyGuidelines !== false : false;
	const footer = `You are running as ${agent} in the Pi brain -> coder -> reviewer workflow.
Work only in the current working directory. Follow all project context files loaded by Pi.
Return concise handoff output for Brain.`;

	const sections = [configured];
	if (roomContext) {
		sections.push(buildRoomCommunicationBlock(agent, roomContext));
	}
	if (includeKarpathyGuidelines) {
		sections.push(KARPATHY_GUIDELINES_PROMPT.trim());
	}
	if (paneMode) {
		sections.push(`You are running in a visible cmux pane. After producing your normal concise final handoff, you MUST call the \`${SUB_AGENT_DONE_TOOL_NAME}\` completion tool as your final action to return control to Brain. Final text alone is insufficient. Do not leak raw hidden chain-of-thought in the pane.`);
	}
	sections.push(footer);

	return sections.filter((part) => part && part.trim()).join("\n\n");
}

function buildChildArgs(
	parentCwd: string,
	agent: AgentName,
	preset: AgentPreset,
	task: string,
	tmpPromptPath: string | null,
	roomContext?: ResolvedRoomContext,
	paneMode?: boolean,
	sessionFile?: string,
): string[] {
	const args: string[] = [];
	if (!paneMode) {
		args.push("--mode", "json", "-p", "--no-session");
	} else if (sessionFile) {
		args.push("--session", sessionFile);
	}
	args.push(...getInheritedExtensionArgs(parentCwd));
	const modelArg = resolveModelArg(preset);
	if (modelArg) args.push("--model", modelArg);
	if (preset.thinkingLevel) args.push("--thinking", preset.thinkingLevel);
	if (preset.tools) {
		let effectiveTools = preset.tools.slice();
		const seen = new Set(effectiveTools);
		if (roomContext) {
			for (const name of ROOM_TOOL_NAMES) {
				if (!seen.has(name)) {
					effectiveTools.push(name);
					seen.add(name);
				}
			}
		}
		if (paneMode) {
			if (!seen.has(SUB_AGENT_DONE_TOOL_NAME)) {
				effectiveTools.push(SUB_AGENT_DONE_TOOL_NAME);
			}
			// Optionally register legacy alias for backward compat
			if (!seen.has(DELEGATE_DONE_TOOL_NAME)) {
				effectiveTools.push(DELEGATE_DONE_TOOL_NAME);
			}
		}
		if (effectiveTools.length > 0) args.push("--tools", effectiveTools.join(","));
		else args.push("--no-tools");
	} else if (paneMode) {
		// When tools are unrestricted, the child completion tool is globally
		// registered when PI_WORKFLOW_DELEGATE_DONE_FILE is set.
		// The primary tool is sub_agent_done; workflow_delegate_done is kept
		// as a backward-compatible alias.
	}
	if (tmpPromptPath) args.push("--append-system-prompt", tmpPromptPath);
	args.push(`Task from Brain to ${agent}:\n\n${task}`);
	return args;
}

function buildChildEnv(parentCwd: string, roomContext?: ResolvedRoomContext): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = {
		PI_WORKFLOW_CHILD: "1",
		PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? "1",
		HOME: process.env.HOME,
		PATH: process.env.PATH,
		TERM: process.env.TERM,
		SHELL: process.env.SHELL,
		USER: process.env.USER,
		LOGNAME: process.env.LOGNAME,
		TMPDIR: process.env.TMPDIR,
	};
	if (roomContext) {
		childEnv[ROOM_ENV_ROOM_ROOT] = getWorkflowRunsRoot(parentCwd);
		childEnv[ROOM_ENV_ROOM_ID] = roomContext.roomId;
		childEnv[ROOM_ENV_AGENT_ID] = roomContext.agentId;
		childEnv[ROOM_ENV_AGENT_ROLE] = roomContext.role;
	}
	return childEnv;
}

function buildHeadlessChildEnv(parentCwd: string, roomContext?: ResolvedRoomContext): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [ROOM_ENV_ROOM_ROOT, ROOM_ENV_ROOM_ID, ROOM_ENV_AGENT_ID, ROOM_ENV_AGENT_ROLE, DELEGATE_DONE_ENV_VAR]) {
		delete childEnv[key];
	}
	for (const [key, value] of Object.entries(buildChildEnv(parentCwd, roomContext))) {
		if (value !== undefined) childEnv[key] = value;
	}
	return childEnv;
}

interface DelegateEventState {
	usage: UsageStats;
	messages: Message[];
	progress: DelegateProgressItem[];
	activeTools: Map<string, { name: string }>;
	status: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	aborted: boolean;
	lastAssistantPreview: string;
	lastAssistantEmitAt: number;
	lastThinkingChars: number;
	lastThinkingEmitAt: number;
	latestThinkingChars: number;
}

function createDelegateEventState(): DelegateEventState {
	return {
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		messages: [],
		progress: [],
		activeTools: new Map(),
		status: "starting",
		stderr: "",
		aborted: false,
		lastAssistantPreview: "",
		lastAssistantEmitAt: 0,
		lastThinkingChars: 0,
		lastThinkingEmitAt: 0,
		latestThinkingChars: 0,
	};
}

function processEventLine(state: DelegateEventState, line: string, agent: AgentName, task: string, cwd: string, preset: AgentPreset, onUpdate?: (partial: any) => void) {
	if (!line.trim()) return;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}

	const { usage, messages, progress, activeTools, status } = state;
	const now = Date.now();
	const pushProgress = (item: DelegateProgressItem) => {
		progress.push(item);
		if (progress.length > MAX_PROGRESS_ITEMS) progress.splice(0, progress.length - MAX_PROGRESS_ITEMS);
	};
	const emitUpdate = () => {
		const output = getFinalAssistantText(messages);
		const finalOutputPreview = truncateText(output, MAX_FINAL_OUTPUT_PREVIEW);
		const thinkingChars = Math.max(countThinkingChars(messages), state.latestThinkingChars);
		onUpdate?.({
			content: [{ type: "text", text: finalOutputPreview || `${agent} ${state.status}...` }],
			details: {
				agent,
				taskPreview: truncateText(task, MAX_TASK_PREVIEW),
				cwd,
				model: resolveModelLabel(preset),
				usage,
				status: state.status,
				activeTools: Array.from(activeTools.entries()).map(([id, t]) => ({ id, name: t.name })),
				progress,
				finalOutputPreview,
				thinkingChars,
			},
		});
	};

	switch (event.type) {
		case "turn_start": {
			state.status = `turn ${Number(event.turnIndex ?? usage.turns + 1)} running`;
			pushProgress({ at: now, type: "status", text: state.status });
			emitUpdate();
			break;
		}
		case "turn_end": {
			state.status = "turn complete";
			pushProgress({ at: now, type: "status", text: state.status });
			emitUpdate();
			break;
		}
		case "tool_execution_start": {
			const name = String(event.toolName ?? "tool");
			const id = String(event.toolCallId ?? `${name}-${now}`);
			activeTools.set(id, { name });
			state.status = `${name} running`;
			pushProgress({ at: now, type: "tool_start", text: `→ ${name}` });
			emitUpdate();
			break;
		}
		case "tool_execution_update": {
			const name = String(event.toolName ?? "tool");
			const details = extractToolUpdatePreview(event.partialResult);
			pushProgress({ at: now, type: "tool_update", text: `… ${name}${details ? ` ${details}` : ""}` });
			emitUpdate();
			break;
		}
		case "tool_execution_end": {
			const name = String(event.toolName ?? "tool");
			const id = String(event.toolCallId ?? "");
			if (id) activeTools.delete(id);
			const ok = !event.isError;
			pushProgress({ at: now, type: ok ? "tool_end" : "error", text: `${ok ? "✓" : "✗"} ${name}` });
			state.status = ok ? "tool complete" : "tool failed";
			emitUpdate();
			break;
		}
		case "message_update": {
			const text = truncateText(extractMessageText(event.message as Message));
			if (text) {
				const shouldEmit =
					text !== state.lastAssistantPreview &&
					(text.length - state.lastAssistantPreview.length >= 40 || now - state.lastAssistantEmitAt > 400);
				if (shouldEmit) {
					state.lastAssistantPreview = text;
					state.lastAssistantEmitAt = now;
					pushProgress({ at: now, type: "assistant", text: truncateText(`💬 ${text}`) });
					emitUpdate();
				}
			}
			if (event.assistantMessageEvent) {
				const partialMsg = event.assistantMessageEvent.partial as any;
				if (partialMsg && Array.isArray(partialMsg.content)) {
					const thinkingParts = partialMsg.content.filter((part: any) => part?.type === "thinking" && typeof part.thinking === "string");
					if (thinkingParts.length > 0) {
						const totalChars = thinkingParts.reduce((sum: number, part: any) => sum + part.thinking.length, 0);
						state.latestThinkingChars = totalChars;
						if (totalChars > 0 && (totalChars - state.lastThinkingChars > 80 || now - state.lastThinkingEmitAt > 600)) {
							state.lastThinkingChars = totalChars;
							state.lastThinkingEmitAt = now;
							pushProgress({ at: now, type: "thinking", text: `thinking… (${totalChars} chars)` });
							emitUpdate();
						}
					}
				}
			}
			break;
		}
		case "message_end": {
			if (!event.message) break;
			const msg = event.message as Message;
			messages.push(msg);
			const asAny = msg as any;
			if (asAny.role === "assistant") {
				usage.turns++;
				if (asAny.usage) {
					usage.input += asAny.usage.input || 0;
					usage.output += asAny.usage.output || 0;
					usage.cacheRead += asAny.usage.cacheRead || 0;
					usage.cacheWrite += asAny.usage.cacheWrite || 0;
					usage.cost += asAny.usage.cost?.total || 0;
					usage.contextTokens = asAny.usage.totalTokens || usage.contextTokens;
				}
				if (asAny.stopReason) state.stopReason = asAny.stopReason;
				if (asAny.errorMessage) state.errorMessage = asAny.errorMessage;
				const assistantText = extractMessageText(msg);
				if (assistantText) pushProgress({ at: now, type: "assistant", text: `💬 ${truncateText(assistantText)}` });
			}
			emitUpdate();
			break;
		}
		case "tool_result_end": {
			if (event.message) messages.push(event.message as Message);
			emitUpdate();
			break;
		}
		case "agent_end": {
			state.status = state.aborted ? "aborted" : "completed";
			pushProgress({ at: now, type: "status", text: state.status });
			emitUpdate();
			break;
		}
		default: {
			if (typeof event.type === "string" && (event.type.startsWith("auto_retry") || event.type.startsWith("compaction"))) {
				pushProgress({ at: now, type: "status", text: truncateText(event.type) });
				emitUpdate();
			}
		}
	}
}

/**
 * Parse a Pi session JSONL entry for pane-mode tailing.
 * Updates state from finalized messages/tool calls rather than streaming events.
 * Live partials are not required because the user sees the live pane.
 */
function processSessionLine(state: DelegateEventState, line: string, agent: AgentName, task: string, cwd: string, preset: AgentPreset, onUpdate?: (partial: any) => void) {
	if (!line.trim()) return;
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}

	const { usage, messages, progress, activeTools } = state;
	const now = Date.now();
	const pushProgress = (item: DelegateProgressItem) => {
		progress.push(item);
		if (progress.length > MAX_PROGRESS_ITEMS) progress.splice(0, progress.length - MAX_PROGRESS_ITEMS);
	};
	const emitUpdate = () => {
		const output = getFinalAssistantText(messages);
		const finalOutputPreview = truncateText(output, MAX_FINAL_OUTPUT_PREVIEW);
		const thinkingChars = Math.max(countThinkingChars(messages), state.latestThinkingChars);
		onUpdate?.({
			content: [{ type: "text", text: finalOutputPreview || `${agent} ${state.status}...` }],
			details: {
				agent,
				taskPreview: truncateText(task, MAX_TASK_PREVIEW),
				cwd,
				model: resolveModelLabel(preset),
				usage,
				status: state.status,
				activeTools: Array.from(activeTools.entries()).map(([id, t]) => ({ id, name: t.name })),
				progress,
				finalOutputPreview,
				thinkingChars,
			},
		});
	};

	if (entry.type === "message" && entry.message) {
		const msg = entry.message as Message;
		messages.push(msg);
		const asAny = msg as any;
		if (asAny.role === "assistant") {
			usage.turns++;
			if (asAny.usage) {
				usage.input += asAny.usage.input || 0;
				usage.output += asAny.usage.output || 0;
				usage.cacheRead += asAny.usage.cacheRead || 0;
				usage.cacheWrite += asAny.usage.cacheWrite || 0;
				usage.cost += asAny.usage.cost?.total || 0;
				usage.contextTokens = asAny.usage.totalTokens || usage.contextTokens;
			}
			if (asAny.stopReason) state.stopReason = asAny.stopReason;
			if (asAny.errorMessage) state.errorMessage = asAny.errorMessage;
			const assistantText = extractMessageText(msg);
			if (assistantText) pushProgress({ at: now, type: "assistant", text: `💬 ${truncateText(assistantText)}` });
			const thinking = extractMessageThinking(msg);
			if (thinking.chars > 0) {
				state.latestThinkingChars = thinking.chars;
				pushProgress({ at: now, type: "thinking", text: `thinking… (${thinking.chars} chars)` });
			}
		} else if (asAny.role === "toolResult") {
			const name = asAny.toolName || asAny.name || "tool";
			const id = asAny.toolCallId || "";
			if (id) activeTools.delete(id);
			const ok = !asAny.isError;
			pushProgress({ at: now, type: ok ? "tool_end" : "error", text: `${ok ? "✓" : "✗"} ${name}` });
		}
		// Also emit progress for tool calls embedded in assistant content parts
		if (asAny.role === "assistant" && Array.isArray(asAny.content)) {
			for (const part of asAny.content) {
				if (part?.type === "toolCall") {
					const tcName = String(part.name ?? part.toolName ?? "tool");
					const tcId = String(part.id ?? `${tcName}-${now}`);
					activeTools.set(tcId, { name: tcName });
					state.status = `${tcName} running`;
					pushProgress({ at: now, type: "tool_start", text: `→ ${tcName}` });
				}
			}
		}
		emitUpdate();
	} else if (entry.type === "tool_call" && entry.tool_call) {
		const tc = entry.tool_call as any;
		const name = String(tc.name ?? "tool");
		const id = String(tc.id ?? `${name}-${now}`);
		activeTools.set(id, { name });
		state.status = `${name} running`;
		pushProgress({ at: now, type: "tool_start", text: `→ ${name}` });
		emitUpdate();
	} else if (entry.type === "tool_result" && entry.tool_result) {
		const tr = entry.tool_result as any;
		const name = String(tr.name ?? "tool");
		const id = String(tr.id ?? "");
		if (id) activeTools.delete(id);
		const ok = !tr.isError;
		pushProgress({ at: now, type: ok ? "tool_end" : "error", text: `${ok ? "✓" : "✗"} ${name}` });
		state.status = ok ? "tool complete" : "tool failed";
		emitUpdate();
	}
}

async function runDelegateAgentHeadless(
	ctx: ExtensionContext,
	agent: AgentName,
	task: string,
	requestedCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	roomContext?: ResolvedRoomContext,
): Promise<DelegateRunResult> {
	const loaded = loadWorkflowConfig(ctx.cwd);
	const preset = getAgentPreset(loaded.config, agent);
	const cwd = requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd;
	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;
	const state = createDelegateEventState();

	const args = buildChildArgs(ctx.cwd, agent, preset, task, null, roomContext, false);
	const systemPrompt = buildAgentSystemPrompt(agent, preset, roomContext, false);
	if (systemPrompt.trim()) {
		const tmp = await writeSystemPromptFile(agent, systemPrompt);
		tmpDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		// Insert prompt path at correct position (before task)
		const taskIndex = args.findIndex((a) => a.startsWith("Task from Brain"));
		if (taskIndex >= 0) args.splice(taskIndex, 0, "--append-system-prompt", tmpPromptPath);
		else args.push("--append-system-prompt", tmpPromptPath);
	}

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const childEnv: NodeJS.ProcessEnv = buildHeadlessChildEnv(ctx.cwd, roomContext);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});

			let stdoutBuffer = "";
			let killTimer: NodeJS.Timeout | undefined;

			proc.stdout.on("data", (chunk) => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) processEventLine(state, line, agent, task, cwd, preset, onUpdate);
			});

			proc.stderr.on("data", (chunk) => {
				state.stderr = appendCapped(state.stderr, chunk.toString(), MAX_STDERR_BYTES);
			});

			proc.on("close", (code) => {
				if (killTimer) clearTimeout(killTimer);
				if (stdoutBuffer.trim()) processEventLine(state, stdoutBuffer, agent, task, cwd, preset, onUpdate);
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				state.stderr = appendCapped(state.stderr, String(error), MAX_STDERR_BYTES);
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					state.aborted = true;
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		const finalStatus = normalizeFinalStatus({ aborted: state.aborted, stopReason: state.stopReason, exitCode });
		return {
			agent,
			task,
			cwd,
			model: resolveModelLabel(preset),
			thinkingLevel: preset.thinkingLevel,
			exitCode,
			messages: state.messages,
			stderr: state.stderr,
			usage: state.usage,
			stopReason: state.stopReason,
			errorMessage: state.errorMessage,
			aborted: state.aborted,
			status: finalStatus,
			activeTools: Array.from(state.activeTools.entries()).map(([id, t]) => ({ id, name: t.name })),
			progress: state.progress,
			finalOutput: getFinalAssistantText(state.messages),
			thinkingChars: countThinkingChars(state.messages),
		};
	} finally {
		await removeTempPrompt(tmpDir, tmpPromptPath);
	}
}

async function runDelegateAgentPane(
	ctx: ExtensionContext,
	agent: AgentName,
	task: string,
	requestedCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	roomContext?: ResolvedRoomContext,
): Promise<DelegateRunResult> {
	const loaded = loadWorkflowConfig(ctx.cwd);
	const preset = getAgentPreset(loaded.config, agent);
	const cwd = requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd;
	const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-pane-"));
	const sessionFile = path.join(runDir, "session.jsonl");
	const stderrFile = path.join(runDir, "stderr.log");
	const doneFile = path.join(runDir, "done.json");
	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;
	const state = createDelegateEventState();

	const systemPrompt = buildAgentSystemPrompt(agent, preset, roomContext, true);
	if (systemPrompt.trim()) {
		const tmp = await writeSystemPromptFile(agent, systemPrompt);
		tmpDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
	}

	const args = buildChildArgs(ctx.cwd, agent, preset, task, tmpPromptPath, roomContext, true, sessionFile);
	const invocation = getPiInvocation(args);
	const childEnv = buildChildEnv(ctx.cwd, roomContext);
	childEnv[DELEGATE_DONE_ENV_VAR] = doneFile;

	// Build shell script to run in the pane
	const scriptLines: string[] = [
		"#!/usr/bin/env bash",
		"set -uo pipefail",
		`cd ${shellEscape(cwd)}`,
	];
	for (const [key, value] of Object.entries(childEnv)) {
		if (value !== undefined) scriptLines.push(`export ${key}=${shellEscape(String(value))}`);
	}
	const piCmd = `${shellEscape(invocation.command)} ${invocation.args.map(shellEscape).join(" ")}`;
	scriptLines.push(
		piCmd,
		`EXIT_CODE=$?`,
		`if [ ! -f ${shellEscape(doneFile)} ]; then echo '{"done":true,"from_exit":true,"exit_code":'"$EXIT_CODE"'}' > ${shellEscape(doneFile)}; fi`,
		`exit $EXIT_CODE`,
	);
	const scriptPath = path.join(runDir, "run.sh");
	await fs.promises.writeFile(scriptPath, scriptLines.join("\n") + "\n", { mode: 0o700 });

	const autoClose = loaded.config.delegatePaneAutoClose !== false;
	let surfaceClosed = false;

	// Workspace grouping: derive group key/title from room or task
	const { groupKey, groupTitle } = deriveGroupKeyAndTitle(roomContext, task);
	let workspaceId = cmuxWorkspaceCache.get(groupKey);

	// Create the surface. If we have a cached workspace, reuse it; otherwise
	// open in caller context then move to a new workspace on first use.
	const tabTitle = buildTabTitle(groupTitle, roomContext, agent);
	let surfaceId: string | null = createCmuxDelegateTab(tabTitle, workspaceId);
	if (!surfaceId) {
		await removeTempPrompt(tmpDir, tmpPromptPath);
		try { await fs.promises.rm(runDir, { recursive: true }); } catch { /* ignore */ }
		return {
			agent, task, cwd,
			model: resolveModelLabel(preset),
			thinkingLevel: preset.thinkingLevel,
			exitCode: 1,
			messages: [],
			stderr: "cmux pane creation failed: cmux may not be running or socket not accessible",
			usage: state.usage,
			status: "failed",
			activeTools: [],
			progress: state.progress,
			finalOutput: "",
			thinkingChars: 0,
		};
	}

	if (!workspaceId) {
		// First delegate for this group: move tab to a new workspace
		const createdWorkspace = createCmuxWorkspaceForGroup(groupTitle, surfaceId);
		if (createdWorkspace) {
			cmuxWorkspaceCache.set(groupKey, createdWorkspace);
			workspaceId = createdWorkspace;
		}
		// Fallback: keep surface in caller context if move fails
	}

	// Send the script into the pane
	const sendResult = sendCmuxCommand(["send", "--surface", surfaceId, `bash ${shellEscape(scriptPath)}\n`]);
	if (!sendResult.ok) {
		if (autoClose && !surfaceClosed) {
			closeCmuxSurface(surfaceId);
			surfaceClosed = true;
		}
		await removeTempPrompt(tmpDir, tmpPromptPath);
		return {
			agent, task, cwd,
			model: resolveModelLabel(preset),
			thinkingLevel: preset.thinkingLevel,
			exitCode: 1,
			messages: [],
			stderr: `cmux send failed: ${sendResult.stderr}`,
			usage: state.usage,
			status: "failed",
			activeTools: [],
			progress: state.progress,
			finalOutput: "",
			thinkingChars: 0,
		};
	}

	let filePos = 0;
	let stderrPos = 0;
	let pendingSessionText = "";
	const startTime = Date.now();
	let finalDoneData: any;

	const poll = async (): Promise<number> => {
		while (true) {
			if (signal?.aborted) {
				state.aborted = true;
				// Send actual Escape byte to the pane
				sendCmuxCommand(["send", "--surface", surfaceId, "\x1b"]);
				return 1;
			}
			if (Date.now() - startTime > DELEGATE_PANE_MAX_WAIT_MS) {
				state.stderr = appendCapped(state.stderr, "\nPane delegate timed out after 10 minutes", MAX_STDERR_BYTES);
				closeCmuxSurface(surfaceId);
				surfaceClosed = true;
				return 1;
			}

			// Tail session file for new entries
			try {
				const stats = await fs.promises.stat(sessionFile);
				if (stats.size > filePos) {
					const fd = await fs.promises.open(sessionFile, "r");
					const buffer = Buffer.alloc(stats.size - filePos);
					await fd.read(buffer, 0, buffer.length, filePos);
					await fd.close();
					const text = buffer.toString("utf8");
					filePos = stats.size;
					pendingSessionText += text;
					const lines = pendingSessionText.split("\n");
					pendingSessionText = lines.pop() ?? "";
					for (const line of lines) {
						if (line.trim()) processSessionLine(state, line, agent, task, cwd, preset, onUpdate);
					}
				}
			} catch {
				// Session file may not exist yet
			}

			// Tail stderr file
			try {
				const stats = await fs.promises.stat(stderrFile);
				if (stats.size > stderrPos) {
					const fd = await fs.promises.open(stderrFile, "r");
					const buffer = Buffer.alloc(stats.size - stderrPos);
					await fd.read(buffer, 0, buffer.length, stderrPos);
					await fd.close();
					stderrPos = stats.size;
					state.stderr = appendCapped(state.stderr, buffer.toString("utf8"), MAX_STDERR_BYTES);
				}
			} catch {
				// stderr file may not exist yet
			}

			// Check done sidecar
			try {
				const doneText = await fs.promises.readFile(doneFile, "utf8");
				finalDoneData = JSON.parse(doneText);
				if (finalDoneData.done) {
					break;
				}
			} catch {
				// done file may not exist yet
			}

			await new Promise((r) => setTimeout(r, DELEGATE_PANE_POLL_MS));
		}

		// Drain remaining session lines after a short delay so final messages are captured
		await new Promise((r) => setTimeout(r, 300));
		try {
			const stats = await fs.promises.stat(sessionFile);
			if (stats.size > filePos) {
				const fd = await fs.promises.open(sessionFile, "r");
				const buffer = Buffer.alloc(stats.size - filePos);
				await fd.read(buffer, 0, buffer.length, filePos);
				await fd.close();
				const text = buffer.toString("utf8");
				pendingSessionText += text;
				const lines = pendingSessionText.split("\n");
				for (const line of lines) {
					if (line.trim()) processSessionLine(state, line, agent, task, cwd, preset, onUpdate);
				}
				pendingSessionText = "";
			}
		} catch { /* ignore */ }

		// Determine exit code from sidecar
		const sidecarExitCode = typeof finalDoneData?.exit_code === "number" ? finalDoneData.exit_code : undefined;
		const hasFinalOutput = getFinalAssistantText(state.messages).length > 0;
		const fromExit = finalDoneData?.from_exit === true;

		if (fromExit) {
			// Process exited without calling sub_agent_done — treat as failure
			state.stderr = appendCapped(
				state.stderr,
				`\npane delegate exited without calling ${SUB_AGENT_DONE_TOOL_NAME} (exit ${sidecarExitCode ?? "unknown"}). The child MUST call ${SUB_AGENT_DONE_TOOL_NAME} as its final action to return control to Brain.`,
				MAX_STDERR_BYTES,
			);
			return sidecarExitCode || 1;
		}

		// Normal done-tool sidecar (sub_agent_done was called)
		if (hasFinalOutput) return 0;
		if (typeof finalDoneData?.summary === "string" && finalDoneData.summary.trim()) {
			// Accept completion signaled with a summary even if no assistant text was captured
			return 0;
		}
		state.stderr = appendCapped(state.stderr, "\npane delegate completed without output or summary", MAX_STDERR_BYTES);
		return 1;
	};

	try {
		const exitCode = await poll();
		const finalStatus = normalizeFinalStatus({ aborted: state.aborted, stopReason: state.stopReason, exitCode });
		return {
			agent,
			task,
			cwd,
			model: resolveModelLabel(preset),
			thinkingLevel: preset.thinkingLevel,
			exitCode,
			messages: state.messages,
			stderr: state.stderr,
			usage: state.usage,
			stopReason: state.stopReason,
			errorMessage: state.errorMessage,
			aborted: state.aborted,
			status: finalStatus,
			activeTools: Array.from(state.activeTools.entries()).map(([id, t]) => ({ id, name: t.name })),
			progress: state.progress,
			finalOutput: getFinalAssistantText(state.messages),
			thinkingChars: countThinkingChars(state.messages),
			display: "pane",
			surface: surfaceId,
			sessionFile,
		};
	} finally {
		await removeTempPrompt(tmpDir, tmpPromptPath);
		if (autoClose && !surfaceClosed && surfaceId) {
			closeCmuxSurface(surfaceId);
			surfaceClosed = true;
		}
		// Leave runDir for potential inspection; do not delete
	}
}

async function runDelegateAgent(
	ctx: ExtensionContext,
	agent: AgentName,
	task: string,
	requestedCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	roomContext?: ResolvedRoomContext,
): Promise<DelegateRunResult> {
	const loaded = loadWorkflowConfig(ctx.cwd);
	const mode = resolveDelegateDisplayMode(loaded.config);
	if (mode === "pane") {
		return runDelegateAgentPane(ctx, agent, task, requestedCwd, signal, onUpdate, roomContext);
	}
	return runDelegateAgentHeadless(ctx, agent, task, requestedCwd, signal, onUpdate, roomContext);
}

async function runReviewerSwarm(
	ctx: ExtensionContext,
	task: string,
	requestedCwd: string | undefined,
	goals: string[] | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	roomContext?: ResolvedRoomContext,
): Promise<{ results: ReviewerTargetResult[]; failed: boolean; aborted: boolean }> {
	const loaded = loadWorkflowConfig(ctx.cwd);
	const swarm = resolveReviewerSwarmConfig(loaded.config);
	const targets = goals && goals.length ? goals : swarm.targets;
	const queue = targets.map((target) => target.trim()).filter(Boolean);
	const results: ReviewerTargetResult[] = queue.map((target) => ({ target, verdict: "UNKNOWN", status: "running" }));
	let cursor = 0;
	let aborted = false;

	const emit = () => {
		const completed = results.filter((item) => item.status !== "running").length;
		const lines = results.map((item, i) => `${item.status === "running" ? "…" : item.status === "completed" ? "✓" : "✗"} [${i + 1}] ${item.target} (${item.verdict})`);
		onUpdate?.({
			content: [{ type: "text", text: `reviewer swarm ${completed}/${results.length}` }],
			details: {
				agent: "reviewer",
				status: completed === results.length ? "completed" : aborted ? "aborted" : "running",
				progress: lines.slice(-MAX_RENDERED_PROGRESS).map((line) => ({ at: Date.now(), type: "status", text: line })),
				taskPreview: truncateText(task, MAX_TASK_PREVIEW),
				cwd: requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd,
				targets: results,
			},
		});
	};

	const markPendingAborted = () => {
		for (let i = 0; i < results.length; i++) {
			if (results[i].status === "running" && !results[i].result) {
				results[i] = { ...results[i], status: "aborted", verdict: "UNKNOWN" };
			}
		}
	};

	emit();
	const baseRoomAgentId = roomContext?.agentId;
	const worker = async () => {
		while (cursor < queue.length) {
			if (signal?.aborted) {
				aborted = true;
				markPendingAborted();
				emit();
				return;
			}
			const index = cursor;
			cursor++;
			const target = queue[index];
			emit();
			// When running with room context, give each parallel reviewer a unique agentId
			// so they don't share a single read cursor / status row. Reserve suffix space
			// before child-side sanitization/truncation.
			const perReviewerContext: ResolvedRoomContext | undefined = roomContext
				? { ...roomContext, agentId: appendAgentIdSuffix(baseRoomAgentId ?? "reviewer", String(index + 1)) }
				: roomContext;
			const result = await runDelegateAgent(ctx, "reviewer", buildReviewerGoalTask(task, target), requestedCwd, signal, undefined, perReviewerContext);
			if (result.aborted || signal?.aborted) aborted = true;
			const verdict = parseReviewerVerdict(result.finalOutput ?? "");
			results[index] = {
				target,
				verdict,
				status: normalizeFinalStatus(result),
				result,
			};
			emit();
			if (aborted) {
				markPendingAborted();
				emit();
				return;
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(swarm.maxConcurrency, queue.length) }, () => worker()));
	if (signal?.aborted) aborted = true;
	if (aborted) markPendingAborted();
	const failed = results.some((item) => item.status !== "completed" || item.verdict !== "APPROVED");
	return { results, failed, aborted };
}

function getDelegateFailureReason(toolName: string, result: any): string | null {
	if (!result || typeof result !== "object") return null;
	const details = (result as any).details;

	if (toolName === "delegate_to_reviewer") {
		if (details?.status === "failed" || details?.status === "aborted") return String(details.status);
		if (Array.isArray(details?.swarm)) {
			const failedItem = details.swarm.find(
				(item: any) => item?.status !== "completed" || item?.verdict === "CHANGES_REQUESTED" || item?.verdict === "UNKNOWN",
			);
			if (failedItem) return `swarm:${failedItem.status ?? "failed"}:${failedItem.verdict ?? "UNKNOWN"}`;
		}
	}

	if (details && typeof details === "object") {
		if (typeof details.status === "string" && details.status !== "completed") return `status:${details.status}`;
		if (typeof details.exitCode === "number" && details.exitCode !== 0) return `exitCode:${details.exitCode}`;
		if (details.aborted === true) return "aborted";
	}

	return null;
}

function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`in:${usage.input}`);
	if (usage.output) parts.push(`out:${usage.output}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(", ");
}

function makeDelegateTool(pi: ExtensionAPI, agent: "coder" | "reviewer") {
	const toolName = agent === "coder" ? "delegate_to_coder" : "delegate_to_reviewer";
	const label = agent === "coder" ? "Delegate to Coder" : "Delegate to Reviewer";
	const role = agent === "coder" ? "hands-on implementation" : "independent review";

	pi.registerTool({
		name: toolName,
		label,
		description: `Delegate a self-contained ${role} task to the ${agent} agent using its configured workflow preset. Project .pi/workflow.json overrides global presets.`,
		promptSnippet: `Delegate ${role} work to the ${agent} subagent`,
		promptGuidelines: [
			`Use ${toolName} when Brain needs ${role} in the brain -> coder -> reviewer workflow.`,
			`Tasks passed to ${toolName} must be self-contained: include goal, relevant files/context, constraints, and expected output.`,
			...(agent === "reviewer" ? ["Pass explicit goals whenever possible so each reviewer target validates one acceptance criterion."] : []),
			`If this delegation fails or returns CHANGES_REQUESTED, do NOT take over code edits/fixes yourself. Re-delegate a focused fix to coder (or a room worker) and then re-review. Brain may do read-only diagnosis/planning/admin only, and direct edits are limited to tiny non-code/admin cases.`,
		],
		parameters: Type.Object({
			task: Type.String({ description: `Self-contained task for ${agent}` }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the delegated Pi process; defaults to current cwd" })),
			room: Type.Optional(Type.Object({
				roomId: Type.Optional(Type.String({ description: "Workflow room id; falls back to PI_WORKFLOW_ROOM_ID env or the active room from .pi/workflow-runs/current.json" })),
				agentId: Type.Optional(Type.String({ description: "Agent id within the room; defaults to the agent name (coder or reviewer) or PI_WORKFLOW_AGENT_ID env" })),
				role: Type.Optional(Type.String({ description: "Agent role label (e.g. 'backend', 'frontend', 'planner'); defaults to PI_WORKFLOW_AGENT_ROLE env or the agent name" })),
			}, { description: "Optional workflow room context. When set, the delegated sub-agent receives PI_WORKFLOW_ROOM_ID/AGENT_ID/AGENT_ROLE env vars and a communication block in its system prompt." })),
			...(agent === "reviewer"
				? { goals: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional review goals/acceptance criteria. When reviewer swarm is enabled, one reviewer runs per goal." })) }
				: {}),
		}),
		renderCall(args: any, theme) {
			const task = truncateText(String(args?.task ?? ""), MAX_TASK_PREVIEW) || "(no task)";
			return new Text(
				`${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", agent)}\n${theme.fg("dim", task)}`,
				0,
				0,
			);
		},
		renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial?: boolean }, theme, context: { isError?: boolean } = {}) {
			const details = (result?.details ?? {}) as Partial<DelegateRunResult>;
			const progress = details.progress ?? [];
			const derivedFailed = typeof details.exitCode === "number" ? isFailed(details as DelegateRunResult) : false;
			const failed = Boolean(context.isError ?? result?.isError ?? derivedFailed);
			const status = details.status ?? (isPartial ? "running" : failed ? "failed" : "completed");
			const statusColor = isPartial ? "warning" : failed ? "error" : "success";
			const icon = isPartial ? "…" : failed ? "✗" : "✓";
			const recent = progress.slice(-(expanded ? MAX_RENDERED_PROGRESS : 5));
			const usageText = details.usage ? formatUsage(details.usage) : "";
			const taskText = details.task ?? (details as { taskPreview?: string }).taskPreview;
			const output = details.finalOutput || (result?.content?.[0]?.type === "text" ? result.content[0].text : "");
			const thinkingChars = (details as any).thinkingChars ?? 0;

			if (!expanded) {
				let text = `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", agent)} ${theme.fg(statusColor, `[${status}]`)} ${theme.fg(statusColor, icon)}`;
				if (taskText) text += `\n${theme.fg("dim", truncateText(taskText))}`;
				if (recent.length) {
					text += `\n${recent.map((p) => formatDelegateProgressLine(p, theme)).join("\n")}`;
				}
				if (thinkingChars > 0) {
					text += `\n${theme.fg("thinkingText", `  thinking… (${thinkingChars} chars)`)}`;
				}
				if ((details.progress?.length ?? 0) > recent.length) {
					text += `\n${theme.fg("muted", "  (Ctrl+O to expand)")}`;
				}
				return new Text(text, 0, 0);
			}

			const container = new Container();

			// Header: tool name + agent + status
			container.addChild(new Text(
				`${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", agent)} ${theme.fg(statusColor, `[${status}]`)} ${theme.fg(statusColor, icon)}`,
				0, 0,
			));

			// Task preview
			if (taskText) {
				container.addChild(new Text(theme.fg("dim", `task: ${truncateText(taskText, MAX_TASK_PREVIEW)}`), 0, 0));
			}

			// Model / cwd / usage line
			const metaParts: string[] = [];
			if (details.model) metaParts.push(`model: ${details.model}`);
			if (details.cwd) metaParts.push(`cwd: ${details.cwd}`);
			if (usageText) metaParts.push(usageText);
			if (metaParts.length) {
				container.addChild(new Text(theme.fg("dim", metaParts.join("  ")), 0, 0));
			}

			// Active tools
			if (details.activeTools && details.activeTools.length > 0) {
				const toolNames = details.activeTools.map((t) => t.name).join(", ");
				container.addChild(new Text(theme.fg("warning", `active: ${toolNames}`), 0, 0));
			}

			// Thinking indicator
			if (thinkingChars > 0) {
				container.addChild(new Text(theme.fg("thinkingText", `thinking… (${thinkingChars} chars hidden)`), 0, 0));
			}

			// Progress section
			if (recent.length) {
				container.addChild(new Spacer(1));
				const statusItems = recent.filter((p) => p.type === "status");
				const toolItems = recent.filter((p) => p.type === "tool_start" || p.type === "tool_update" || p.type === "tool_end" || p.type === "error");
				const assistantItems = recent.filter((p) => p.type === "assistant");
				const thinkingItems = recent.filter((p) => p.type === "thinking");

				if (statusItems.length) {
					container.addChild(new Text(theme.fg("dim", "status:"), 0, 0));
					for (const item of statusItems.slice(-4)) {
						container.addChild(new Text(formatDelegateProgressLine(item, theme), 0, 0));
					}
				}
				if (toolItems.length) {
					if (statusItems.length) container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", "tools:"), 0, 0));
					for (const item of toolItems.slice(-6)) {
						container.addChild(new Text(formatDelegateProgressLine(item, theme), 0, 0));
					}
				}
				if (thinkingItems.length) {
					if (toolItems.length || statusItems.length) container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", "thinking:"), 0, 0));
					for (const item of thinkingItems.slice(-3)) {
						container.addChild(new Text(formatDelegateProgressLine(item, theme), 0, 0));
					}
				}
				if (assistantItems.length) {
					if (toolItems.length || statusItems.length || thinkingItems.length) container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", "output:"), 0, 0));
					for (const item of assistantItems.slice(-4)) {
						container.addChild(new Text(formatDelegateProgressLine(item, theme), 0, 0));
					}
				}
			}

			// Final output
			if (output) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
			}

			return container;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = String((params as any).task ?? "").trim();
			const requestedCwd = (params as any).cwd;
			if (!task) {
				return {
					content: [{ type: "text", text: "Missing task." }],
					details: { agent, status: "failed", task, cwd: requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd },
					isError: true,
				};
			}

			let roomContext: ResolvedRoomContext | undefined;
			if ((params as any).room && typeof (params as any).room === "object") {
				try {
					roomContext = resolveRoomContextFromDelegateParams(agent, (params as any).room, ctx.cwd);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `Invalid room context: ${message}` }],
						details: { agent, status: "failed", task, room: (params as any).room },
						isError: true,
					};
				}
			}

			if (agent === "reviewer") {
				const goals = Array.isArray((params as any).goals)
					? (params as any).goals.map((goal: unknown) => String(goal).trim()).filter((goal: string) => goal.length > 0)
					: undefined;
				const swarmConfig = resolveReviewerSwarmConfig(loadWorkflowConfig(ctx.cwd).config);
				if (!swarmConfig.enabled) {
					const singleTask = goals?.length ? `${task}\n\nReview goals:\n${goals.map((goal: string) => `- ${goal}`).join("\n")}` : task;
					const result = await runDelegateAgent(ctx, "reviewer", singleTask, requestedCwd, signal, onUpdate, roomContext);
					const finalOutput = getFinalAssistantText(result.messages) || result.errorMessage || result.stderr || "(no output)";
					const status = normalizeFinalStatus(result);
					const usageText = formatUsage(result.usage);
					return {
						content: [{ type: "text", text: `[reviewer] ${status}${usageText ? ` (${usageText})` : ""}\n\n${finalOutput}` }],
						details: result,
						isError: status !== "completed",
					};
				}

				const swarm = await runReviewerSwarm(ctx, task, requestedCwd, goals, signal, onUpdate, roomContext);
				const lines = swarm.results.map((item, index) => {
					const detail = item.result?.finalOutput || item.result?.errorMessage || item.result?.stderr || "(no output)";
					return `[${index + 1}] ${item.target}\n${item.verdict} (${item.status})\n${detail}`;
				});
				const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
				for (const item of swarm.results) {
					if (!item.result) continue;
					usage.input += item.result.usage.input;
					usage.output += item.result.usage.output;
					usage.cacheRead += item.result.usage.cacheRead;
					usage.cacheWrite += item.result.usage.cacheWrite;
					usage.cost += item.result.usage.cost;
					usage.contextTokens = Math.max(usage.contextTokens, item.result.usage.contextTokens);
					usage.turns += item.result.usage.turns;
				}
				const finalOutput = lines.join("\n\n");
				const status = swarm.aborted ? "aborted" : swarm.failed ? "failed" : "completed";
				return {
					content: [{ type: "text", text: `[reviewer] ${status}\n\n${finalOutput}` }],
					details: {
						agent: "reviewer",
						task,
						cwd: requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd,
						status,
						swarm: swarm.results,
						progress: swarm.results.map((item, index) => ({ at: Date.now(), type: "status", text: `[${index + 1}] ${item.target} ${item.verdict} (${item.status})` })),
						usage,
						exitCode: swarm.failed ? 1 : 0,
						finalOutput,
					},
					isError: swarm.failed,
				};
			}

			const result = await runDelegateAgent(ctx, agent, task, requestedCwd, signal, onUpdate, roomContext);
			const finalOutput = getFinalAssistantText(result.messages) || result.errorMessage || result.stderr || "(no output)";
			const status = normalizeFinalStatus(result);
			const failed = status !== "completed";
			const usageText = formatUsage(result.usage);

			return {
				content: [
					{
						type: "text",
						text: `[${agent}] ${status}${usageText ? ` (${usageText})` : ""}\n\n${finalOutput}`,
					},
				],
				details: result,
				isError: failed,
			};
		},
	});
}

// --- Workflow Rooms extracted to ./workflow/rooms (TASK-018 Slice 1) --------
// --- Workflow runtime config/profile/preset helpers extracted to ------------
//     ./workflow/runtime/config (TASK-018 Slice 2) ----------------------------

export default function brainWorkflow(pi: ExtensionAPI) {
	loadGonkaEnvFromDefaultDotenv();

	pi.registerFlag("workflow-agent", {
		description: "Workflow agent for this process: brain or none",
		type: "string",
	});
	pi.registerFlag("workflow-profile", {
		description: `Opt-in workflow profile: default or ${GONKA_HYBRID_PROFILE_ID}`,
		type: "string",
	});

	// Register the Gonka provider unconditionally so it is always available,
	// but do not point any agent at it by default. Defaults stay premium.
	pi.registerProvider(GONKA_PROVIDER_NAME, {
		name: "Gonka",
		baseUrl: getGonkaBrokerUrl(),
		apiKey: `$${GONKA_BROKER_API_KEY_ENV}`,
		api: "openai-completions",
		models: GONKA_MODELS,
	});

	makeDelegateTool(pi, "coder");
	makeDelegateTool(pi, "reviewer");

	registerRoomTools(pi);

	// Child-only completion tools for pane delegates. Only registered when the
	// env var is set (parent sets it before launching a pane delegate).
	// sub_agent_done is the primary tool; workflow_delegate_done is a legacy alias.
	function makeDoneToolExecute(toolName: string) {
		return async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) => {
			const doneFile = process.env[DELEGATE_DONE_ENV_VAR];
			if (!doneFile) {
				return { content: [{ type: "text", text: "Done file path not set in env." }], isError: true, details: { reason: "missing_env" } };
			}
			try {
				const data = { done: true, summary: String(params?.summary ?? "").trim() || undefined, at: new Date().toISOString() };
				fs.writeFileSync(doneFile, JSON.stringify(data) + "\n", "utf8");
			} catch (error) {
				return { content: [{ type: "text", text: `Failed to write done file: ${error}` }], isError: true, details: { reason: "write_failed" } };
			}
			setTimeout(() => ctx.shutdown(), 500);
			return { content: [{ type: "text", text: "Delegate completion signaled. Shutting down." }], details: { doneFile, tool: toolName } };
		};
	}

	if (process.env[DELEGATE_DONE_ENV_VAR]) {
		pi.registerTool({
			name: SUB_AGENT_DONE_TOOL_NAME,
			label: "Sub-Agent Done",
			description: `Signal that the delegated task is complete. Only available in pane-delegate child sessions. Writes the done sidecar and shuts down the session.`,
			promptSnippet: "Signal task completion and shut down.",
			promptGuidelines: [
				"Call this as your final action after producing your normal concise handoff to return control to Brain.",
				"This tool writes the done sidecar and terminates the session.",
			],
			parameters: Type.Object({
				summary: Type.Optional(Type.String({ description: "Optional one-line completion summary" })),
			}),
			execute: makeDoneToolExecute(SUB_AGENT_DONE_TOOL_NAME),
		});
		pi.registerTool({
			name: DELEGATE_DONE_TOOL_NAME,
			label: "Delegate Done (legacy)",
			description: `Legacy alias for ${SUB_AGENT_DONE_TOOL_NAME}. Use ${SUB_AGENT_DONE_TOOL_NAME} instead.`,
			promptSnippet: "Signal task completion and shut down (legacy alias).",
			promptGuidelines: [
				`Prefer ${SUB_AGENT_DONE_TOOL_NAME}. This alias exists for backward compatibility only.`,
			],
			parameters: Type.Object({
				summary: Type.Optional(Type.String({ description: "Optional one-line completion summary" })),
			}),
			execute: makeDoneToolExecute(DELEGATE_DONE_TOOL_NAME),
		});
	}

	pi.registerCommand("workflow", {
		description: "Show effective brain/coder/reviewer workflow presets",
		handler: async (_args, ctx) => {
			const loaded = loadWorkflowConfig(ctx.cwd, { cliProfile: pi.getFlag("workflow-profile") as string | undefined });
			const reviewerSwarm = resolveReviewerSwarmConfig(loaded.config);
			const profile = getWorkflowProfile(loaded.profileId);
			const gonkaEnv = getGonkaEnvStatus();
			const delegateMode = resolveDelegateDisplayMode(loaded.config);
			const cmuxAvailable = isCmuxAvailable();
			const lines = [
				"Pi workflow: brain -> coder -> reviewer",
				`global: ${loaded.globalPath}`,
				`project override: ${loaded.projectPath ?? "(none)"}`,
				"",
				`profile: ${loaded.profileId} source=${loaded.profileSource} (${profile.label})`,
				`gonka: provider=${GONKA_PROVIDER_NAME} ${GONKA_BROKER_URL_ENV}=${gonkaEnv.url} ${GONKA_BROKER_API_KEY_ENV}=${gonkaEnv.apiKey}`,
				"",
				formatPreset("brain", getAgentPreset(loaded.config, "brain")),
				formatPreset("coder", getAgentPreset(loaded.config, "coder")),
				formatPreset("reviewer", getAgentPreset(loaded.config, "reviewer")),
				`reviewerSwarm: enabled=${reviewerSwarm.enabled} maxConcurrency=${reviewerSwarm.maxConcurrency}`,
				`reviewerSwarm targets: ${reviewerSwarm.targets.join(" | ")}`,
				"",
				`delegateDisplay: ${delegateMode}${delegateMode !== "headless" ? ` (cmux=${cmuxAvailable ? "available" : "unavailable"})` : ""}`,
				`delegatePaneAutoClose: ${loaded.config.delegatePaneAutoClose !== false ? "true (default)" : "false"}`,
				`env override: ${DELEGATE_DISPLAY_ENV}=${process.env[DELEGATE_DISPLAY_ENV] ?? "(not set)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("tool_result", async (event) => {
		const raw = event as any;
		const toolName = String(raw.toolName ?? "");
		if (toolName !== "delegate_to_coder" && toolName !== "delegate_to_reviewer") return;
		const failure = getDelegateFailureReason(toolName, { details: raw.details });
		if (!failure || raw.isError === true) return;
		return { isError: true };
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("workflow-agent") === "none") return;
		await applyBrainPreset(pi, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (process.env.PI_WORKFLOW_CHILD === "1") return;
		if (pi.getFlag("workflow-agent") === "none") return;

		const cliProfile = pi.getFlag("workflow-profile") as string | undefined;
		const loaded = loadWorkflowConfig(ctx.cwd, { cliProfile });
		const brain = getAgentPreset(loaded.config, "brain");
		if (!brain.instructions?.trim()) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${brain.instructions.trim()}`,
		};
	});
}
