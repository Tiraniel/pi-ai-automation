// Workflow delegate runtime — headless child Pi transport.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// `runDelegateAgentHeadless` spawns a child Pi as a normal subprocess with
// `--mode json -p --no-session` and streams the event JSONL through
// `processEventLine` to feed back progress updates. The headless transport
// is the default when `delegateDisplay` is `headless` (or auto-detected
// to headless because cmux is not available) and is what every CI /
// headless Pi instance uses.
//
// TASK-002: headless delegates allocate a done sidecar before spawning
// the child and set `PI_WORKFLOW_DELEGATE_DONE_FILE` / `..._RUN_ID` so
// the child can call `sub_agent_done` (or `workflow_delegate_done`) and
// write typed canonical evidence to the sidecar. After the child exits
// the runner parses the sidecar and stamps `doneFile` / `completionSource`
// / `completionWarning` on the result so the coder/reviewer gates see the
// same fields they see in pane mode. When the child never calls the
// completion tool, the runner falls back to the existing free-form
// behaviour (auto-exit / process-exit / legacy).

import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentName, AgentPreset, DelegateCompletionSource, DelegateRunResult } from "../types";
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
	type DelegateCompletionContext,
} from "./child";
import { DELEGATE_HEADLESS_MAX_WAIT_MS, MAX_STDERR_BYTES } from "./constants";
import { parseDoneSidecar } from "./pane-status";
import { createDelegateEventState, processEventLine } from "./state";

/** Allocate a fresh done sidecar path under `os.tmpdir()` for a headless
 *  delegate. Returns the absolute file path and a cleanup callback. The
 *  runner must call the cleanup callback in a `finally` block.
 *
 *  TASK-002: the done sidecar itself is preserved on disk so the parent
 *  coder / reviewer gates can read `result.doneFile` after the child exits.
 *  Cleanup removes only the surrounding temp directory. This matches the
 *  pane runner, which keeps the sidecar at `<runDir>/done.json`. */
async function allocateHeadlessDoneSidecar(runId: string): Promise<{ doneFile: string; cleanup: () => Promise<void> }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-headless-done-"));
	const doneFile = path.join(dir, `${runId}.done.json`);
	const cleanup = async (): Promise<void> => {
		// Best-effort rmdir; the done sidecar is intentionally preserved
		// (when still present) so the parent gates can read it. rmdir
		// fails non-empty without removing the sidecar, so this is safe.
		try { await fs.promises.rmdir(dir); } catch { /* ignore — keep sidecar */ }
	};
	return { doneFile, cleanup };
}

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

	// TASK-002: allocate a per-run done sidecar so the child can call
	// sub_agent_done / workflow_delegate_done with typed canonical
	// evidence. The runner reads it back after exit. Backward-compat: when
	// the child never calls the tool, the existing free-form finalOutput
	// path still feeds the headless gate.
	const runId = roomContext?.agentId ? `headless-${roomContext.agentId}-${Date.now()}` : `headless-${agent}-${Date.now()}`;
	const sidecar = await allocateHeadlessDoneSidecar(runId);
	// TASK-002: explicit per-spawn completion context. We intentionally
	// do NOT mutate parent `process.env` to pass the done sidecar / runId
	// through; doing so races under concurrent headless delegates. The
	// completion context is the single per-spawn handoff.
	const completionContext: DelegateCompletionContext = {
		enabled: true,
		doneFile: sidecar.doneFile,
		runId,
	};

	const args = buildChildArgs(ctx.cwd, agent, preset, task, null, roomContext, false, undefined, completionContext);
	const systemPrompt = buildAgentSystemPrompt(agent, preset, roomContext, false, completionContext);
	if (systemPrompt.trim()) {
		const tmp = await writeSystemPromptFile(agent, systemPrompt);
		tmpDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		// Insert prompt path at correct position (before task)
		const taskIndex = args.findIndex((a) => a.startsWith("Task from Brain"));
		if (taskIndex >= 0) args.splice(taskIndex, 0, "--append-system-prompt", tmpPromptPath);
		else args.push("--append-system-prompt", tmpPromptPath);
	}

	let completionSource: DelegateCompletionSource = "legacy";
	let completionWarning: string | undefined;
	let didReadSidecar = false;
	const resultDetails: Record<string, unknown> = {};

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const childEnv: NodeJS.ProcessEnv = buildHeadlessChildEnv(ctx.cwd, roomContext, completionContext);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});

			let stdoutBuffer = "";
			let killTimer: NodeJS.Timeout | undefined;
			let timedOut = false;

			// Wall-clock cap: without it a hung child (stuck tool, dead network)
			// wedges the delegate tool forever and orphans the child on parent exit.
			const maxWaitTimer = setTimeout(() => {
				timedOut = true;
				state.errorMessage = state.errorMessage ?? `headless delegate exceeded ${DELEGATE_HEADLESS_MAX_WAIT_MS}ms and was killed`;
				state.stderr = appendCapped(state.stderr, `\n[delegate] headless run exceeded ${DELEGATE_HEADLESS_MAX_WAIT_MS}ms; killing child`, MAX_STDERR_BYTES);
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
			}, DELEGATE_HEADLESS_MAX_WAIT_MS);

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
				clearTimeout(maxWaitTimer);
				if (stdoutBuffer.trim()) processEventLine(state, stdoutBuffer, agent, task, cwd, preset, onUpdate);
				// Signal-killed children close with code null; a timed-out run is
				// a failure, not a completed run.
				resolve(code ?? (timedOut ? 1 : 0));
			});

			proc.on("error", (error) => {
				clearTimeout(maxWaitTimer);
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

		// TASK-002: read the done sidecar after exit. If the child called
		// the completion tool, prefer the typed payload + completionSource.
		// Otherwise mark completion as auto_exit / process_exit / legacy so
		// the gate treats the headless run like the pane path.
		const sidecarData = parseDoneSidecar(sidecar.doneFile);
		if (sidecarData) {
			didReadSidecar = true;
			resultDetails.done = sidecarData;
			if (sidecarData.completion === "auto_exit" || sidecarData.from_auto_exit === true) {
				completionSource = "auto_exit";
				completionWarning = typeof sidecarData.warning === "string" ? sidecarData.warning : "Headless delegate auto-exited without calling sub_agent_done.";
			} else if (sidecarData.completion === "process_exit" || sidecarData.from_exit === true) {
				completionSource = "process_exit";
				completionWarning = typeof sidecarData.warning === "string" ? sidecarData.warning : "Headless delegate process-exited without a done sidecar.";
			} else if (sidecarData.completion === "explicit") {
				completionSource = "explicit";
			}
		} else if (state.aborted) {
			completionSource = "process_exit";
			completionWarning = "Headless delegate was aborted before it could call sub_agent_done.";
		} else if (exitCode !== 0) {
			completionSource = "process_exit";
			completionWarning = `Headless delegate exited with code ${exitCode} without writing a done sidecar.`;
		}

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
			display: "headless",
			completionSource,
			completionWarning,
			runId,
			doneFile: sidecar.doneFile,
			details: Object.keys(resultDetails).length > 0 ? resultDetails : undefined,
		};
	} finally {
		// TASK-002: no `process.env` restoration needed because the
		// completion context is now passed explicitly per spawn.
		await sidecar.cleanup();
		await removeTempPrompt(tmpDir, tmpPromptPath);
		// didReadSidecar / completionSource locals are read in the success
		// path; this branch is only for cleanup safety.
		void didReadSidecar;
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
	presetOverride?: AgentPreset,
): Promise<DelegateRunResult> {
	const loaded = loadWorkflowConfig(ctx.cwd);
	const preset = presetOverride ?? getAgentPreset(loaded.config, agent);
	return runAgentPresetHeadless(ctx, agent, preset, task, requestedCwd, signal, onUpdate, roomContext);
}
