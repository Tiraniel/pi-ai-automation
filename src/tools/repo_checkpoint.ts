/**
 * repo_checkpoint tool — scaffold stub.
 * Future TASK-005 will implement the append-only evidence queue.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "../runtime";

export const repoCheckpointParameters = Type.Object({
	contextVersion: Type.Optional(Type.String({ description: "Index context_version this evidence applies to" })),
	agentId: Type.Optional(Type.String({ description: "Agent identifier (e.g., 'brain', 'coder')" })),
	agentRole: Type.Optional(Type.String({ description: "Agent role in this turn" })),
	agentRunId: Type.Optional(Type.String({ description: "Unique run identifier (session + turn)" })),
	taskId: Type.Optional(Type.String({ description: "Active task identifier, if any" })),
	claim: Type.String({ description: "Short claim about what was done or learned" }),
	evidenceRefs: Type.Optional(Type.Array(Type.String(), { description: "File paths or line refs supporting claim" })),
	testRefs: Type.Optional(Type.Array(Type.String(), { description: "Tests that validate the claim" })),
	reviewRefs: Type.Optional(Type.Array(Type.String(), { description: "Reviews or PR refs" })),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.8 })),
	changedFiles: Type.Optional(Type.Array(Type.String(), { description: "Files modified in this turn" })),
	metadata: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Bounded agent metadata" })),
});

export function registerRepoCheckpoint(pi: ExtensionAPI) {
	pi.registerTool({
		name: "repo_checkpoint",
		label: "Repo: Checkpoint",
		description: "Append evidence about the current agent turn to the evidence queue. (Scaffold — storage pending TASK-005.)",
		promptSnippet: "Record evidence about a claim, test result, or decision",
		promptGuidelines: [
			"Use repo_checkpoint to record claims, evidence refs, test refs, and confidence after meaningful work.",
			"repo_checkpoint is append-only; it never overwrites or deletes prior evidence.",
			"In the MVP scaffold, the checkpoint is accepted but not persisted to SQLite.",
		],
		parameters: repoCheckpointParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const rt = buildRuntime(ctx);
			const p = params as any;
			const claim = String(p?.claim ?? "").trim();
			if (!claim) {
				return {
					isError: true,
					content: [{ type: "text", text: "Missing required parameter: claim" }],
				};
			}

			const agentId = String(p?.agentId ?? "unknown");
			const confidence = Number(p?.confidence ?? 0.8);
			const changedFiles = Array.isArray(p?.changedFiles) ? p.changedFiles : [];

			const lines = [
				"# repo_checkpoint (MVP scaffold)",
				"",
				"> **Note:** Deterministic index is available via `repo_index_status`. Evidence persistence is pending TASK-005.",
				"> The checkpoint was validated but not persisted to SQLite.",
				"",
				"## Accepted (not stored)",
				`- agentId: ${agentId}`,
				`- claim: ${claim}`,
				`- confidence: ${confidence}`,
				`- changedFiles: ${JSON.stringify(changedFiles)}`,
				`- contextVersion: ${p?.contextVersion ?? "(current, not resolved)"}`,
				`- repoKey: ${rt.repoKey}`,
				"",
				"## Result",
				"- recorded: false",
				"- storage: pending TASK-005",
				"- deduplicated: n/a",
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					scaffold: true,
					recorded: false,
					storage: "pending TASK-005",
					repoRoot: rt.repoRoot,
					claim,
					agentId,
					confidence,
					changedFiles,
				},
			};
		},
	});
}
