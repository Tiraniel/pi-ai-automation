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
		description: "Return a bounded, structured summary of the repo for the current agent turn. (Scaffold — no index built yet.)",
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
				"# repo_context (MVP scaffold)",
				"",
				"> **Note:** This is a TASK-002 scaffold. No deterministic index, file cards, or evidence queue exists yet.",
				"> Indexing will be implemented in TASK-003; cards/brief in TASK-004; evidence in TASK-005.",
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
				"",
				"## Result",
				"No repository scan was performed. This tool will return ranked file summaries, key imports/exports,",
				"and optional evidence once the deterministic index is built (TASK-003/004).",
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					scaffold: true,
					repoRoot: rt.repoRoot,
					maxFiles,
					maxTokens,
					query: p?.query,
					indexBuilt: false,
					cardsAvailable: false,
					evidenceAvailable: false,
				},
			};
		},
	});
}
