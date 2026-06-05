/**
 * repo_index_status tool — scaffold stub.
 * Future TASK-003 will implement deterministic index metadata and counts.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "../runtime";

export const repoIndexStatusParameters = Type.Object({});

export function registerRepoIndexStatus(pi: ExtensionAPI) {
	pi.registerTool({
		name: "repo_index_status",
		label: "Repo: Index Status",
		description: "Quick diagnostic of the deterministic index state. (Scaffold — no index built yet.)",
		promptSnippet: "Check whether the repo index is built and up to date",
		promptGuidelines: [
			"Use repo_index_status to quickly check index health, file counts, and keeper state.",
			"In the MVP scaffold, this returns metadata placeholders only.",
		],
		parameters: repoIndexStatusParameters,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			const rt = buildRuntime(ctx);

			const lines = [
				"# repo_index_status (MVP scaffold)",
				"",
				"> **Note:** This is a TASK-002 scaffold. The deterministic index is not yet built (TASK-003).",
				"> All counts are zero and metadata is placeholder only.",
				"",
				"## Repo Metadata",
				`| Key | Value |`,
				`| --- | --- |`,
				`| repo_root | ${rt.repoRoot} |`,
				`| git_root | (not detected) |`,
				`| current_branch | (not detected) |`,
				`| current_head | (not detected) |`,
				`| is_dirty | unknown |`,
				`| has_untracked | unknown |`,
				`| has_conflicts | unknown |`,
				`| context_version | (not built) |`,
				`| last_sync_at | (never) |`,
				`| last_keeper_run_at | (never) |`,
				"",
				"## File Counts",
				`| Metric | Count |`,
				`| --- | --- |`,
				`| total_files | 0 |`,
				`| fresh_cards | 0 |`,
				`| stale_cards | 0 |`,
				`| missing_cards | 0 |`,
				`| gitignored_files | 0 |`,
				`| secret_excluded_files | 0 |`,
				`| generated_excluded_files | 0 |`,
				"",
				"## Evidence Queue",
				`| Metric | Count |`,
				`| --- | --- |`,
				`| total_evidence | 0 |`,
				`| stale_evidence | 0 |`,
				"",
				"## Keeper Lease",
				`- leased_by: (none)`,
				`- lease_expires_at: (none)`,
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					scaffold: true,
					repoRoot: rt.repoRoot,
					indexBuilt: false,
					totalFiles: 0,
					freshCards: 0,
					staleCards: 0,
					missingCards: 0,
					totalEvidence: 0,
					staleEvidence: 0,
					keeperLeasedBy: null,
					leaseExpiresAt: null,
				},
			};
		},
	});
}
