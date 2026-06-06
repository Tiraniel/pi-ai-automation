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
import { DELEGATE_DONE_ENV_VAR, DELEGATE_DONE_TOOL_NAME, SUB_AGENT_DONE_TOOL_NAME } from "./constants";

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

export function registerDelegateDoneTools(pi: ExtensionAPI): void {
	// Child-only completion tools for pane delegates. Only registered when the
	// env var is set (parent sets it before launching a pane delegate).
	if (!process.env[DELEGATE_DONE_ENV_VAR]) return;

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
