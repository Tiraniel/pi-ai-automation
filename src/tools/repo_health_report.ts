/**
 * repo_health_report tool — scaffold stub.
 * Future TASK-007 will implement ranked integrity findings and optional Gantt.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "../runtime";

export const repoHealthReportParameters = Type.Object({
	maxFindings: Type.Optional(Type.Integer({ default: 20, description: "Max findings to return" })),
	includeGantt: Type.Optional(Type.Boolean({ default: false, description: "Include simple Markdown/Mermaid Gantt" })),
	categories: Type.Optional(Type.Array(Type.String(), { description: "Filter by category" })),
	minSeverity: Type.Optional(Type.String({ default: "info", description: "Minimum severity to include" })),
	forceRefresh: Type.Optional(Type.Boolean({ default: false, description: "Bypass cache and regenerate findings" })),
});

export function registerRepoHealthReport(pi: ExtensionAPI) {
	pi.registerTool({
		name: "repo_health_report",
		label: "Repo: Health Report",
		description: "Return a ranked integrity/consultant report. (Scaffold — no findings generated yet.)",
		promptSnippet: "Get a ranked health report for the repo",
		promptGuidelines: [
			"Use repo_health_report to surface integrity findings such as test coverage gaps, type safety issues, or architectural drift.",
			"In the MVP scaffold, this returns an empty report with a status message.",
		],
		parameters: repoHealthReportParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const rt = buildRuntime(ctx);
			const p = params as any;
			const maxFindings = Number(p?.maxFindings ?? 20);
			const includeGantt = Boolean(p?.includeGantt ?? false);
			const forceRefresh = Boolean(p?.forceRefresh ?? false);

			const lines = [
				"# repo_health_report (MVP scaffold)",
				"",
				"> **Note:** This is a TASK-002 scaffold. The integrity consultant is not yet implemented (TASK-007).",
				"> No findings were generated and no LLM calls were made.",
				"",
				"## Parameters",
				`- maxFindings: ${maxFindings}`,
				`- includeGantt: ${includeGantt}`,
				`- categories: ${JSON.stringify(p?.categories ?? [])}`,
				`- minSeverity: ${p?.minSeverity ?? "info"}`,
				`- forceRefresh: ${forceRefresh}`,
				"",
				"## Runtime",
				`- cwd: ${rt.cwd}`,
				`- repoRoot: ${rt.repoRoot}`,
				"",
				"## Findings",
				"No findings available. The integrity consultant will analyze file cards + evidence",
				"and produce ranked findings once TASK-007 is implemented.",
			];

			if (includeGantt) {
				lines.push("", "## Gantt", "Gantt output is not available in the scaffold.");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					scaffold: true,
					findingsCount: 0,
					repoRoot: rt.repoRoot,
					maxFindings,
					includeGantt,
					forceRefresh,
					consultantAvailable: false,
				},
			};
		},
	});
}
