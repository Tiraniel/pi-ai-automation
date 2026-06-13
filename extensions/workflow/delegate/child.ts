// Workflow delegate runtime — child Pi invocation helpers.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// This module owns everything needed to spawn a child Pi process for a
// delegated task: extension source resolution, argv inheritance, the
// headless/pane Pi invocation, system-prompt temp files, and the child
// environment construction (including the headless env that strips the
// delegate room/done sidecar vars). It depends on the rooms module for the
// room-context env-var names and the runtime/config module for the model
// arg resolution.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentName, AgentPreset } from "../types";
import {
	ROOM_ENV_AGENT_ID,
	ROOM_ENV_AGENT_ROLE,
	ROOM_ENV_ROOM_ID,
	ROOM_ENV_ROOM_ROOT,
	ROOM_TOOL_NAMES,
	type ResolvedRoomContext,
} from "../rooms";
import { getWorkflowRunsRoot, buildRoomCommunicationBlock } from "../rooms";
import { KARPATHY_GUIDELINES_PROMPT } from "../prompts";
import { resolveModelArg } from "../runtime/config";
import {
	DELEGATE_ACTIVITY_ENV_VAR,
	DELEGATE_DISPLAY_ENV,
	DELEGATE_DONE_ENV_VAR,
	DELEGATE_RUN_ID_ENV_VAR,
	SUB_AGENT_DONE_TOOL_NAME,
	DELEGATE_DONE_TOOL_NAME,
} from "./constants";

export function resolveChildExtensionSource(source: string, parentCwd: string): string {
	const expanded = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
	if (path.isAbsolute(expanded)) return expanded;
	const abs = path.resolve(parentCwd, expanded);
	if (fs.existsSync(abs)) return abs;
	return source;
}

export function getInheritedExtensionArgs(parentCwd: string): string[] {
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

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

export async function writeSystemPromptFile(agent: string, text: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-"));
	const safeAgent = agent.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `${safeAgent}-system.md`);
	await fs.promises.writeFile(filePath, text, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

export async function removeTempPrompt(dir: string | null, filePath: string | null): Promise<void> {
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

// TASK-002: explicit per-spawn completion context. The parent passes the
// done-sidecar path, activity-sidecar path, runId, an optional `display`
// override, and an `enabled` flag here so the child prompt / arg / env
// builders do not need to read `process.env` (which can race under
// concurrent headless delegates — the parent process's env is shared
// across all child spawns). The explicit per-spawn context is the
// SOLE source of authority for the completion env vars under the
// TASK-002 hard-cut.
export interface DelegateCompletionContext {
	doneFile?: string;
	activityFile?: string;
	runId?: string;
	display?: string;
	/** True when the child should register the completion tools / receive
	 *  the canonical completion prompt. The headless runner sets this
	 *  once a per-run sidecar is allocated; the pane runner sets it
	 *  whenever it spawns a pane delegate. */
	enabled?: boolean;
}

/** Compute whether a child should treat itself as completion-enabled.
 *  Precedence (highest to lowest): explicit `enabled` flag, presence of
 *  `doneFile`. This is the single source of truth for prompt / arg /
 *  env builders so they do not read `process.env`. */
function isCompletionEnabled(paneMode: boolean | undefined, completionContext: DelegateCompletionContext | undefined): boolean {
	if (completionContext) {
		if (completionContext.enabled === true) return true;
		if (typeof completionContext.doneFile === "string" && completionContext.doneFile.trim().length > 0) return true;
	}
	return paneMode === true;
}

export function buildAgentSystemPrompt(
	agent: AgentName,
	preset: AgentPreset,
	roomContext: ResolvedRoomContext | undefined,
	paneMode: boolean | undefined,
	completionContext?: DelegateCompletionContext,
): string {
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
	// TASK-002: tell headless delegates (and pane delegates) about the
	// typed completion contract when a done sidecar is allocated. The
	// source of truth is the explicit `completionContext` / `paneMode`
	// parameter — `process.env` is intentionally NOT consulted so
	// concurrent headless delegates cannot race through shared env
	// mutation.
	if (isCompletionEnabled(paneMode, completionContext)) {
		const setting = paneMode ? "visible cmux pane" : "headless child process";
		sections.push(`You are running in a ${setting}. After producing your normal concise final handoff, you MUST call the \`${SUB_AGENT_DONE_TOOL_NAME}\` completion tool as your final action to return control to Brain. Final text alone is insufficient. For matrix-gated work, pass an \`evidence\` envelope with typed \`coderEvidence\` (coder) or \`reviewerEvidence\` (reviewer) inside the canonical \`evidence\` parameter. The tool schema does NOT declare deprecated top-level \`coderEvidence\` / \`reviewerEvidence\` parameters — those fields are not accepted and are silently ignored. Gate decisions use stable enum / code / array fields; free-form text, summaries, Markdown, and approval phrases in any human language are diagnostic only and never satisfy pass/fail. Do not leak raw hidden chain-of-thought in the pane.`);
	}
	sections.push(footer);

	return sections.filter((part) => part && part.trim()).join("\n\n");
}

export function buildChildArgs(
	parentCwd: string,
	agent: AgentName,
	preset: AgentPreset,
	task: string,
	tmpPromptPath: string | null,
	roomContext: ResolvedRoomContext | undefined,
	paneMode: boolean | undefined,
	sessionFile?: string,
	completionContext?: DelegateCompletionContext,
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
	const completionEnabled = isCompletionEnabled(paneMode, completionContext);
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
		// TASK-002: register the completion tools whenever the child process
		// is configured to write a done sidecar (pane OR headless). Headless
		// delegates now allocate a done sidecar so typed completion
		// evidence is supported uniformly across both transports.
		if (completionEnabled) {
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
	} else if (completionEnabled) {
		// When tools are unrestricted, the child completion tool is globally
		// registered when the completion context is enabled.
		// The primary tool is sub_agent_done; workflow_delegate_done is kept
		// as a backward-compatible alias.
	}
	if (tmpPromptPath) args.push("--append-system-prompt", tmpPromptPath);
	args.push(`Task from Brain to ${agent}:\n\n${task}`);
	return args;
}

export function buildChildEnv(parentCwd: string, roomContext?: ResolvedRoomContext): NodeJS.ProcessEnv {
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

export function buildHeadlessChildEnv(
	parentCwd: string,
	roomContext: ResolvedRoomContext | undefined,
	completionContext?: DelegateCompletionContext,
): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	// TASK-002 HARD-CUT: clear ALL delegate completion env vars from
	// inherited `process.env` BEFORE applying the explicit per-spawn
	// completion context. The previous code only deleted the room vars
	// and then overlaid; that allowed a stale `PI_WORKFLOW_DELEGATE_*`
	// from the parent process (or from a previous headless spawn whose
	// context was never cleared) to leak into the new child and corrupt
	// done-sidecar ownership under concurrent headless delegates. The
	// explicit per-spawn context is the sole source of authority for
	// the completion env vars.
	for (const key of [
		DELEGATE_DONE_ENV_VAR,
		DELEGATE_ACTIVITY_ENV_VAR,
		DELEGATE_RUN_ID_ENV_VAR,
		DELEGATE_DISPLAY_ENV,
	]) {
		delete childEnv[key];
	}
	for (const key of [
		ROOM_ENV_ROOM_ROOT,
		ROOM_ENV_ROOM_ID,
		ROOM_ENV_AGENT_ID,
		ROOM_ENV_AGENT_ROLE,
	]) {
		delete childEnv[key];
	}
	// TASK-002: headless delegates can now opt-in to typed completion
	// evidence by allocating a done sidecar and passing the env vars. The
	// parent (headless.ts) passes the explicit `completionContext` so the
	// child env is race-free under concurrent headless delegates (the
	// shared parent `process.env` is never read here).
	for (const [key, value] of Object.entries(buildChildEnv(parentCwd, roomContext))) {
		if (value !== undefined) childEnv[key] = value;
	}
	// Overlay completion env vars from the explicit `completionContext`.
	// This replaces the old `process.env` round-trip; the parent must
	// allocate a per-run sidecar and pass it here.
	if (completionContext) {
		if (typeof completionContext.doneFile === "string" && completionContext.doneFile.trim().length > 0) {
			childEnv[DELEGATE_DONE_ENV_VAR] = completionContext.doneFile;
		}
		if (typeof completionContext.activityFile === "string" && completionContext.activityFile.trim().length > 0) {
			childEnv[DELEGATE_ACTIVITY_ENV_VAR] = completionContext.activityFile;
		}
		if (typeof completionContext.runId === "string" && completionContext.runId.trim().length > 0) {
			childEnv[DELEGATE_RUN_ID_ENV_VAR] = completionContext.runId;
		}
		if (typeof completionContext.display === "string" && completionContext.display.trim().length > 0) {
			childEnv[DELEGATE_DISPLAY_ENV] = completionContext.display;
		}
	}
	return childEnv;
}
