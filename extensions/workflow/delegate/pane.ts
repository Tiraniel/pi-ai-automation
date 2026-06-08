// Workflow delegate runtime — cmux pane transport.
//
// `runDelegateAgentPane` sends an interactive Pi session into a cmux surface and
// waits for durable completion sidecars instead of terminal scraping. It keeps a
// durable pane manifest under `.pi/workflow-runs/delegates/` for liveness checks,
// polls optional activity heartbeats for live status, and auto-closes the surface
// when configured.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentName, DelegateRunResult } from "../types";
import type { ResolvedRoomContext } from "../rooms";
import { getAgentPreset, loadWorkflowConfig, resolveModelLabel } from "../runtime/config";
import { ensureDir, getWorkflowRunsRoot } from "../rooms";
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
	createCmuxDelegateTab,
	deriveGroupKeyAndTitle,
	getPaneShellReadyDelayMs,
	buildTabTitle,
	sendCmuxCommand,
	sendCmuxShellCommand,
	shellEscape,
} from "./cmux";
import {
	DELEGATE_ACTIVITY_ENV_VAR,
	DELEGATE_DONE_ENV_VAR,
	DELEGATE_PANE_ACTIVITY_POLL_MS,
	DELEGATE_PANE_ACTIVITY_STALE_MS,
	DELEGATE_PANE_MAX_WAIT_MS,
	DELEGATE_PANE_POLL_MS,
	DELEGATE_RUN_ID_ENV_VAR,
	MAX_STDERR_BYTES,
} from "./constants";
import {
	ActivitySidecar,
	DoneSidecar,
	PaneManifest,
	buildManifest,
	manifestPathFromRunRoot,
	makeActivityPayload,
	parseActivitySidecar,
	parseDoneSidecar,
	writeActivitySidecar,
	writeManifest,
} from "./pane-status";
import { createDelegateEventState, processSessionLine } from "./state";
import { resolvePaneCompletionOutcome } from "./pane-completion";

function summarizeTask(task: string): string {
	return task.replace(/\s+/g, " ").trim().slice(0, 200) || "(no task)";
}

function appendStatusProgress(state: ReturnType<typeof createDelegateEventState>, text: string, onUpdate?: ((partial: any) => void) | undefined, details?: Record<string, any>) {
	const now = Date.now();
	const last = state.progress[state.progress.length - 1];
	if (last?.type === "status" && last.text === text) return;
	state.progress.push({ at: now, type: "status", text });
	if (state.progress.length > 80) state.progress.shift();
	if (onUpdate) {
		onUpdate({
			content: [{ type: "text", text }],
			details: {
				...details,
				activityText: text,
			},
		});
	}
}

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
	const autoClose = loaded.config.delegatePaneAutoClose !== false;
	const runDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-pane-"));
	const runId = `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const sessionFile = path.join(runDir, "session.jsonl");
	const stderrFile = path.join(runDir, "stderr.log");
	const doneFile = path.join(runDir, "done.json");
	const activityFile = path.join(runDir, "activity.json");
	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;
	const state = createDelegateEventState();
	let surfaceId: string | null = null;
	let surfaceClosed = false;
	let finalDoneData: DoneSidecar | undefined;
	let completionOutcome: ReturnType<typeof resolvePaneCompletionOutcome> | undefined;
	let finalOutput = "";
	let manifest: PaneManifest;
	let finalActivity: ActivitySidecar | undefined;

	const runRoot = getWorkflowRunsRoot(ctx.cwd);
	const manifestPath = manifestPathFromRunRoot(runRoot, runId);

	try {
		ensureDir(path.dirname(manifestPath));
	} catch {
		// best effort
	}

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
	childEnv[DELEGATE_ACTIVITY_ENV_VAR] = activityFile;
	childEnv[DELEGATE_RUN_ID_ENV_VAR] = runId;

	// Build shell script to run in the pane.
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
		`if [ ! -f ${shellEscape(doneFile)} ]; then printf '{\"done\":true,\"from_exit\":true,\"completion\":\"process_exit\",\"source\":\"shell_exit\",\"exit_code\":%s}\\n' "$EXIT_CODE" > ${shellEscape(doneFile)}; fi`,
		`exit $EXIT_CODE`,
	);
	const scriptPath = path.join(runDir, "run.sh");
	await fs.promises.writeFile(scriptPath, scriptLines.join("\n") + "\n", { mode: 0o700 });

	const { groupKey, groupTitle } = deriveGroupKeyAndTitle(roomContext, task);
	const tabTitle = buildTabTitle(groupTitle, roomContext, agent);
	manifest = buildManifest({
		runId,
		cwd,
		agent,
		task,
		taskPreview: summarizeTask(task),
		groupKey,
		groupTitle,
		tabTitle,
		roomContext: roomContext
			? { roomId: roomContext.roomId, agentId: roomContext.agentId, role: roomContext.role }
			: undefined,
		sessionFile,
		stderrFile,
		doneFile,
		activityFile,
	});
	await writeActivitySidecar(activityFile, makeActivityPayload(runId, "starting", "created"));
	await writeManifest(manifestPath, manifest);

	surfaceId = createCmuxDelegateTab(tabTitle, groupKey);
	if (!surfaceId) {
		await removeTempPrompt(tmpDir, tmpPromptPath);
		try { await fs.promises.rm(runDir, { recursive: true }); } catch { /* ignore */ }
		state.stderr = appendCapped(state.stderr, "cmux pane creation failed: cmux may not be running or socket not accessible", MAX_STDERR_BYTES);
		manifest.state = "failed";
		manifest.activity = finalActivity;
		manifest.updatedAt = new Date().toISOString();
		await writeManifest(manifestPath, manifest);
		return {
			agent,
			task,
			cwd,
			model: resolveModelLabel(preset),
			thinkingLevel: preset.thinkingLevel,
			exitCode: 1,
			messages: [],
			stderr: state.stderr,
			usage: state.usage,
			status: "failed",
			display: "pane",
			runId,
			surface: undefined,
			sessionFile,
			stderrFile,
			doneFile,
			activityFile,
			manifestFile: manifestPath,
			progress: state.progress,
			finalOutput: "",
			thinkingChars: 0,
		};
	}

	await writeManifest(manifestPath, { ...manifest, surface: surfaceId, updatedAt: new Date().toISOString() });
	manifest.surface = surfaceId;

	// Give the shell a moment to become ready before dispatching the first command.
	const shellReadyDelay = getPaneShellReadyDelayMs();
	if (shellReadyDelay > 0) await new Promise((r) => setTimeout(r, shellReadyDelay));

	const sendResult = sendCmuxShellCommand(surfaceId, `bash ${shellEscape(scriptPath)}`);
	if (sendResult.ok) {
		const startedActivity = makeActivityPayload(runId, "active", "command-sent");
		await writeActivitySidecar(activityFile, startedActivity);
		manifest.activity = startedActivity;
	}
	if (!sendResult.ok) {
		state.stderr = appendCapped(state.stderr, `cmux send failed: ${sendResult.stderr}`, MAX_STDERR_BYTES);
		if (autoClose && !surfaceClosed) {
			closeCmuxSurface(surfaceId);
			surfaceClosed = true;
		}
		await removeTempPrompt(tmpDir, tmpPromptPath);
		manifest.state = "failed";
		manifest.updatedAt = new Date().toISOString();
		await writeManifest(manifestPath, manifest);
		return {
			agent,
			task,
			cwd,
			model: resolveModelLabel(preset),
			thinkingLevel: preset.thinkingLevel,
			exitCode: 1,
			messages: [],
			stderr: state.stderr,
			usage: state.usage,
			status: "failed",
			display: "pane",
			runId,
			surface: surfaceId,
			sessionFile,
			stderrFile,
			doneFile,
			activityFile,
			manifestFile: manifestPath,
			progress: state.progress,
			finalOutput: "",
			thinkingChars: 0,
		};
	}

	let filePos = 0;
	let stderrPos = 0;
	let pendingSessionText = "";
	let lastActivity: ActivitySidecar | undefined;
	let lastStatusEmit = 0;
	let lastManifestWrite = 0;
	const startTime = Date.now();

	const runDirManifest = async (): Promise<void> => {
		if (Date.now() - lastManifestWrite < DELEGATE_PANE_ACTIVITY_POLL_MS) return;
		manifest.updatedAt = new Date().toISOString();
		manifest.activity = finalActivity;
		manifest.done = finalDoneData;
		await writeManifest(manifestPath, manifest);
		lastManifestWrite = Date.now();
	};

	const drainSession = async (): Promise<void> => {
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
			// session file may not exist yet
		}
	};

	const emitActivityStale = (activity: ActivitySidecar, now: number): void => {
		const phase = activity.phase ?? "waiting";
		const updatedAt = activity.updatedAt ?? now;
		const age = now - updatedAt;
		const stale = age > DELEGATE_PANE_ACTIVITY_STALE_MS;
		const details = {
			runId,
			agent,
			task,
			surface: surfaceId,
			sessionFile,
			doneFile,
			activity: { ...activity, stale: stale ? age : 0 },
			display: "pane",
		};
		if (activity.phase === lastActivity?.phase && activity.lastEvent === lastActivity?.lastEvent) {
			if (!stale || now - lastStatusEmit < DELEGATE_PANE_ACTIVITY_STALE_MS) return;
		}
		const line = stale
			? `pane ${runId} activity stalled: ${phase} for ${(Math.floor(age / 1000))}s (${activity.lastEvent ?? "unknown"})`
			: `pane ${runId} activity: ${phase}${activity.lastEvent ? ` (${activity.lastEvent})` : ""}`;
		appendStatusProgress(state, line, onUpdate, details);
		lastStatusEmit = now;
	};

	const poll = async (): Promise<number> => {
		while (true) {
			if (signal?.aborted) {
				state.aborted = true;
				sendCmuxCommand(["send", "--surface", surfaceId, "\u001b"]);
				state.stopReason = "aborted";
				return 1;
			}
			if (Date.now() - startTime > DELEGATE_PANE_MAX_WAIT_MS) {
				state.stderr = appendCapped(
					state.stderr,
					"\nPane delegate timed out after 10 minutes",
					MAX_STDERR_BYTES,
				);
				manifest.state = "failed";
				await writeManifest(manifestPath, { ...manifest, updatedAt: new Date().toISOString() });
				closeCmuxSurface(surfaceId);
				surfaceClosed = true;
				return 1;
			}

			const sidecar = parseDoneSidecar(doneFile);
			if (sidecar?.done) {
				finalDoneData = sidecar;
				break;
			}

			await drainSession();
			const now = Date.now();

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

			const activity = parseActivitySidecar(activityFile, runId);
			if (activity) {
				finalActivity = activity;
				manifest.activity = activity;
				if (
					!lastActivity ||
					activity.phase !== lastActivity?.phase ||
					activity.lastEvent !== lastActivity?.lastEvent ||
					activity.updatedAt !== (lastActivity?.updatedAt ?? 0)
				) {
					manifest.latestEvent = activity.lastEvent;
					emitActivityStale(activity, now);
					lastActivity = activity;
				} else {
					emitActivityStale(activity, now);
				}
				manifest.activity = activity;
			} else {
				emitActivityStale(makeActivityPayload(runId, "waiting", "missing", now), now);
			}

			await runDirManifest();
			await new Promise((r) => setTimeout(r, DELEGATE_PANE_POLL_MS));
		}

		// Drain final session lines after completion signal.
		await new Promise((r) => setTimeout(r, 300));
		await drainSession();
		if (pendingSessionText.trim()) {
			for (const line of pendingSessionText.split("\n")) {
				if (line.trim()) processSessionLine(state, line, agent, task, cwd, preset, onUpdate);
			}
		}
		pendingSessionText = "";
		const finalAssistantOutput = getFinalAssistantText(state.messages);
		completionOutcome = resolvePaneCompletionOutcome(finalDoneData, finalAssistantOutput);
		finalOutput = completionOutcome.finalOutput;
		if (completionOutcome.stderr) {
			state.stderr = appendCapped(state.stderr, completionOutcome.stderr, MAX_STDERR_BYTES);
		}
		return completionOutcome.exitCode;
	};

	try {
		const exitCode = await poll();
		manifest.state = normalizeFinalStatus({ aborted: state.aborted, stopReason: state.stopReason, exitCode }) === "completed"
			? "completed"
			: state.aborted
				? "aborted"
				: "failed";
		manifest.done = finalDoneData;
		manifest.exitCode = exitCode;
		manifest.updatedAt = new Date().toISOString();
		await writeManifest(manifestPath, manifest);
		const completionFailed = completionOutcome?.status === "failed";
		const finalStatus = completionFailed
			? state.aborted || state.stopReason === "aborted"
				? "aborted"
				: "failed"
			: normalizeFinalStatus({ aborted: state.aborted, stopReason: state.stopReason, exitCode });
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
			finalOutput: finalOutput || getFinalAssistantText(state.messages) || ((typeof finalDoneData?.summary === "string" ? finalDoneData.summary.trim() : "")) || "",
			thinkingChars: countThinkingChars(state.messages),
			completionSource: completionOutcome?.completionSource,
			completionWarning: completionOutcome?.warning,
			display: "pane",
			runId,
			surface: surfaceId,
			sessionFile,
			stderrFile,
			doneFile,
			activityFile,
			manifestFile: manifestPath,
			activityState: finalActivity?.phase,
		};
	} finally {
		await removeTempPrompt(tmpDir, tmpPromptPath);
		if (autoClose && !surfaceClosed && surfaceId) {
			closeCmuxSurface(surfaceId);
			surfaceClosed = true;
		}
		if (manifestPath) {
			manifest.updatedAt = new Date().toISOString();
			manifest.state = state.aborted ? "aborted" : manifest.state;
			await writeManifest(manifestPath, manifest);
		}
	}
}
