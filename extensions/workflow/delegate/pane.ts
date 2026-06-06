// Workflow delegate runtime — cmux pane child Pi transport.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// `runDelegateAgentPane` writes a self-contained shell script under a
// per-run tempdir and sends it into a new cmux surface. The pane writes
// the child's session JSONL to disk and a `done.json` sidecar on
// completion; this runner tails those files until the sidecar appears
// (signalling that the child called `sub_agent_done` to terminate) and
// then drains the final session lines to capture the assistant output.
//
// Failure modes preserved from the original:
//   - cmux surface creation failure -> early-return `failed` result and
//     remove the tempdir.
//   - cmux send failure -> early-return `failed`, close the surface if
//     autoClose is enabled, remove the temp prompt file.
//   - Process exit without calling `sub_agent_done` -> treated as
//     `failed` and an explanatory stderr line is appended.
//   - Pane timeout after 10 minutes -> surface is closed and 1 is
//     returned.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentName, DelegateRunResult } from "../types";
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
	buildChildEnv,
	getPiInvocation,
	removeTempPrompt,
	writeSystemPromptFile,
} from "./child";
import {
	closeCmuxSurface,
	cmuxWorkspaceCache,
	createCmuxDelegateTab,
	createCmuxWorkspaceForGroup,
	deriveGroupKeyAndTitle,
	buildTabTitle,
	sendCmuxCommand,
	shellEscape,
} from "./cmux";
import {
	DELEGATE_DONE_ENV_VAR,
	DELEGATE_PANE_MAX_WAIT_MS,
	DELEGATE_PANE_POLL_MS,
	MAX_STDERR_BYTES,
	SUB_AGENT_DONE_TOOL_NAME,
} from "./constants";
import { createDelegateEventState, processSessionLine } from "./state";

export async function runDelegateAgentPane(
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
