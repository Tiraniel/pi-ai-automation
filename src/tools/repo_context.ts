/**
 * repo_context tool — scaffold stub.
 * Future TASK-004 will implement bounded repo summary with file cards.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "../runtime";

export const repoContextParameters = Type.Object({
	query: Type.Optional(Type.String({ description: "Optional focus query to rank relevance" })),
	maxFiles: Type.Optional(Type.Integer({ default: 30, description: "Max files to include" })),
	maxTokens: Type.Optional(Type.Integer({ default: 8000, description: "Approximate token budget for response" })),
	includeCards: Type.Optional(Type.Boolean({ default: true, description: "Include file cards if fresh" })),
	includeEvidence: Type.Optional(Type.Boolean({ default: false, description: "Include recent evidence items" })),
});

export function registerRepoContext(pi: ExtensionAPI) {
	pi.registerTool({
		name: "repo_context",
		label: "Repo: Context",
		description: "Return a bounded, structured summary of the repo for the current agent turn. Deterministic index is available via repo_index_status; bounded context/evidence storage remain future tasks.",
		promptSnippet: "Get bounded repo context before planning or coding",
		promptGuidelines: [
			"Use repo_context when you need a quick overview of the repo structure, key files, or current state.",
			"repo_context does not perform deep analysis in the MVP; it returns metadata and a file list.",
		],
		parameters: repoContextParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const rt = buildRuntime(ctx);
			const p = params as any;
			const maxFiles = Number(p?.maxFiles ?? 30);
			const maxTokens = Number(p?.maxTokens ?? 8000);

			const lines = [
				"# repo_context (scaffold)",
				"",
				"> **Note:** Deterministic index is available via `repo_index_status`. Bounded context and evidence storage remain future tasks (TASK-004/005).",
				"",
				"## Parameters",
				`- maxFiles: ${maxFiles}`,
				`- maxTokens: ${maxTokens}`,
				`- query: ${p?.query ?? "(none)"}`,
				`- includeCards: ${p?.includeCards ?? true}`,
				`- includeEvidence: ${p?.includeEvidence ?? false}`,
				"",
				"## Runtime",
				`- cwd: ${rt.cwd}`,
				`- repoRoot: ${rt.repoRoot}`,
				`- repoKey: ${rt.repoKey}`,
				`- cacheDbPath: ${rt.cacheDbPath}`,
				"",
				"## Result",
				"No ranked file summary was generated. This tool will return ranked file summaries, key imports/exports,",
				"and optional evidence once bounded context is implemented (TASK-004).",
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					scaffold: true,
					repoRoot: rt.repoRoot,
					repoKey: rt.repoKey,
					cacheDbPath: rt.cacheDbPath,
					maxFiles,
					maxTokens,
					query: p?.query,
					indexBuilt: true,
					cardsAvailable: false,
					evidenceAvailable: false,
				},
			};
		},
	});
}
