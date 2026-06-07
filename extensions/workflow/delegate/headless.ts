// Workflow delegate runtime — headless child Pi transport.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// `runDelegateAgentHeadless` spawns a child Pi as a normal subprocess with
// `--mode json -p --no-session` and streams the event JSONL through
// `processEventLine` to feed back progress updates. The headless transport
// is the default when `delegateDisplay` is `headless` (or auto-detected
// to headless because cmux is not available) and is what every CI /
// headless Pi instance uses.

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentName, AgentPreset, DelegateRunResult } from "../types";
import type { ResolvedRoomContext } from "../rooms";
import { getAgentPreset, loadWorkflowConfig, resolveModelLabel } from "../runtime/config";
import {
	appendCapped,
	countThinkingChars,
	getFinalAssistantText,
	normalizeFinalStatus,
} from "./messages";
import {
	buildAgentSystemPrompt,
	buildChildArgs,
	buildHeadlessChildEnv,
	getPiInvocation,
	removeTempPrompt,
	writeSystemPromptFile,
} from "./child";
import { MAX_STDERR_BYTES } from "./constants";
import { createDelegateEventState, processEventLine } from "./state";

export async function runAgentPresetHeadless(
	ctx: ExtensionContext,
	agent: AgentName,
	preset: AgentPreset,
	task: string,
	requestedCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	roomContext?: ResolvedRoomContext,
): Promise<DelegateRunResult> {
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

export async function runDelegateAgentHeadless(
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
	return runAgentPresetHeadless(ctx, agent, preset, task, requestedCwd, signal, onUpdate, roomContext);
}
