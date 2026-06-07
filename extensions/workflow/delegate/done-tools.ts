// Workflow delegate runtime — child-only `sub_agent_done` and
// `workflow_delegate_done` completion tools.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// These two tools are *only* registered when `PI_WORKFLOW_DELEGATE_DONE_FILE`
// is set in the child process env (the parent sets it before launching a
// pane delegate). They write the done sidecar JSON file that the pane
// runner is polling and then call `ctx.shutdown()` to terminate the child
// Pi session so the pane can be closed.
//
// `sub_agent_done` is the primary tool; `workflow_delegate_done` is a
// legacy alias kept for backward compatibility with older prompts.

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DELEGATE_ACTIVITY_ENV_VAR,
	DELEGATE_DONE_ENV_VAR,
	DELEGATE_DONE_TOOL_NAME,
	DELEGATE_RUN_ID_ENV_VAR,
	SUB_AGENT_DONE_TOOL_NAME,
} from "./constants";
import { makeActivityPayload, type ActivityPhase, writeActivitySidecar } from "./pane-status";

const NOISY_ACTIVITY_EVENT_THROTTLE_MS = 1500;

interface DelegateActivityHooksState {
	lastWrite: number;
}

function okTool(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function errTool(text: string, details: Record<string, unknown> = {}) {
	return {
		isError: true,
		content: [{ type: "text" as const, text }],
		details,
	};
}

function registerDelegateActivityHooks(pi: ExtensionAPI): void {
	const activityFile = process.env[DELEGATE_ACTIVITY_ENV_VAR];
	if (!activityFile) return;

	const runId = process.env[DELEGATE_RUN_ID_ENV_VAR] || "";
	const state: DelegateActivityHooksState = { lastWrite: 0 };

	const writeActivity = (eventName: string, phase: ActivityPhase): void => {
		const now = Date.now();
		if (eventName === "message_update" && now - state.lastWrite < NOISY_ACTIVITY_EVENT_THROTTLE_MS) {
			return;
		}
		state.lastWrite = now;
		void writeActivitySidecar(activityFile, makeActivityPayload(runId, phase, eventName, now));
	};

	pi.on("session_start", () => writeActivity("session_start", "starting"));
	pi.on("before_agent_start", () => writeActivity("before_agent_start", "starting"));
	pi.on("agent_start", () => writeActivity("agent_start", "active"));
	pi.on("turn_start", () => writeActivity("turn_start", "active"));
	pi.on("turn_end", () => writeActivity("turn_end", "active"));
	pi.on("before_provider_request", () => writeActivity("before_provider_request", "active"));
	pi.on("after_provider_response", () => writeActivity("after_provider_response", "active"));
	pi.on("message_update", () => writeActivity("message_update", "active"));
	pi.on("tool_execution_start", () => writeActivity("tool_execution_start", "active"));
	pi.on("tool_execution_end", () => writeActivity("tool_execution_end", "active"));
	pi.on("tool_result", () => writeActivity("tool_result", "active"));
	pi.on("session_shutdown", () => writeActivity("session_shutdown", "done"));
}

function makeDoneToolExecute(toolName: string) {
	return async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) => {
		const doneFile = process.env[DELEGATE_DONE_ENV_VAR];
		if (!doneFile) {
			return errTool("Done file path not set in env.", { reason: "missing_env" });
		}
		const summary = String(params?.summary ?? "").trim();
		const runId = process.env[DELEGATE_RUN_ID_ENV_VAR] || "";
		const now = new Date().toISOString();
		try {
			const data = { done: true, summary: summary || undefined, at: now, tool: toolName };
			fs.writeFileSync(doneFile, JSON.stringify(data) + "\n", "utf8");
			const activityFile = process.env[DELEGATE_ACTIVITY_ENV_VAR];
			if (activityFile) {
				void writeActivitySidecar(activityFile, makeActivityPayload(runId, "done", summary || "completed"));
			}
		} catch (error) {
			return errTool(`Failed to write done file: ${error}`, { reason: "write_failed" });
		}
		setTimeout(() => ctx.shutdown(), 500);
		return okTool("Delegate completion signaled. Shutting down.", { doneFile, tool: toolName });
	};
}

export function registerDelegateDoneTools(pi: ExtensionAPI): void {
	// Child-only completion tools for pane delegates. Only registered when the
	// env var is set (parent sets it before launching a pane delegate).
	if (!process.env[DELEGATE_DONE_ENV_VAR]) return;

	registerDelegateActivityHooks(pi);

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
