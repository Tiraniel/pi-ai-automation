/**
 * repo_index_status tool — deterministic index status.
 *
 * Lazily syncs and reads index status on demand. Does not scan/open DB on extension load.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "../runtime";
import { syncRepo } from "../index/sync";

export const repoIndexStatusParameters = Type.Object({});

export function registerRepoIndexStatus(pi: ExtensionAPI) {
	pi.registerTool({
		name: "repo_index_status",
		label: "Repo: Index Status",
		description: "Quick diagnostic of the deterministic index state. Syncs lazily on first call.",
		promptSnippet: "Check whether the repo index is built and up to date",
		promptGuidelines: [
			"Use repo_index_status to quickly check index health, file counts, and keeper state.",
			"The index is synced on demand; this may take a few seconds on first call for large repos.",
		],
		parameters: repoIndexStatusParameters,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			const rt = buildRuntime(ctx);
			const status = syncRepo(rt.repoRoot, rt.repoKey, rt.cacheDbPath);

			const ageMs = Date.now() - status.lastSyncAt;
			const ageSec = Math.round(ageMs / 1000);
			const ageText = ageSec < 60 ? `${ageSec}s ago` : ageSec < 3600 ? `${Math.round(ageSec / 60)}m ago` : `${Math.round(ageSec / 3600)}h ago`;

			const langLines = Object.entries(status.languageCounts)
				.sort(([, a], [, b]) => b - a)
				.slice(0, 8)
				.map(([lang, count]) => `- ${lang}: ${count}`);

			const lines = [
				"# repo_index_status",
				"",
				"> Index synced on demand. First call may take a few seconds for large repos.",
				"",
				"## Repo Metadata",
				"| Key | Value |",
				"| --- | --- |",
				`| repo_root | ${status.repoRoot} |`,
				`| git_root | ${status.gitRoot ?? "(none)"} |`,
				`| current_branch | ${status.branch ?? "(none)"} |`,
				`| current_head | ${status.head ?? "(none)"} |`,
				`| is_dirty | ${status.isDirty ? "yes" : "no"} |`,
				`| has_untracked | ${status.hasUntracked ? "yes" : "no"} |`,
				`| has_conflicts | ${status.hasConflicts ? "yes" : "no"} |`,
				`| context_version | ${status.contextVersion} |`,
				`| last_sync_at | ${new Date(status.lastSyncAt).toISOString()} (${ageText}) |`,
				`| cache_db_path | ${status.cacheDbPath} |`,
				"",
				"## File Counts",
				"| Metric | Count |",
				"| --- | --- |",
				`| total_files | ${status.totalFiles} |`,
				`| fresh_cards | ${status.freshCards} |`,
				`| stale_cards | ${status.staleCards} |`,
				`| missing_cards | ${status.missingCards} |`,
				`| dirty_files | ${status.dirtyCount} |`,
				`| untracked_files | ${status.untrackedCount} |`,
				`| gitignored_files | ${status.gitignoredCount} |`,
				`| secret_excluded | ${status.secretExcludedCount} |`,
				`| generated_excluded | ${status.generatedExcludedCount} |`,
				`| binary_excluded | ${status.binaryExcludedCount} |`,
				`| lock_excluded | ${status.lockExcludedCount} |`,
				`| new_this_sync | ${status.newFiles} |`,
				`| changed_this_sync | ${status.changedFiles} |`,
				`| removed_this_sync | ${status.removedFiles} |`,
				"",
				"## Languages (top)",
				...langLines,
				"",
				"## Package Roots (top)",
				...status.topPackageRoots.map((r) => `- ${r}`),
				"",
				"## Evidence Queue",
				"| Metric | Count |",
				"| --- | --- |",
				`| total_evidence | ${status.evidenceCount} |`,
				`| stale_evidence | ${status.staleEvidenceCount} |`,
				"",
				"## Keeper Lease",
				`- leased_by: ${status.keeperLeasedBy ?? "(none)"}`,
				`- lease_expires_at: ${status.leaseExpiresAt ? new Date(status.leaseExpiresAt).toISOString() : "(none)"}`,
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					repoRoot: status.repoRoot,
					gitRoot: status.gitRoot,
					branch: status.branch,
					head: status.head,
					isDirty: status.isDirty,
					hasUntracked: status.hasUntracked,
					hasConflicts: status.hasConflicts,
					contextVersion: status.contextVersion,
					lastSyncAt: status.lastSyncAt,
					cacheDbPath: status.cacheDbPath,
					totalFiles: status.totalFiles,
					freshCards: status.freshCards,
					staleCards: status.staleCards,
					missingCards: status.missingCards,
					dirtyCount: status.dirtyCount,
					untrackedCount: status.untrackedCount,
					gitignoredCount: status.gitignoredCount,
					secretExcludedCount: status.secretExcludedCount,
					generatedExcludedCount: status.generatedExcludedCount,
					binaryExcludedCount: status.binaryExcludedCount,
					lockExcludedCount: status.lockExcludedCount,
					newFiles: status.newFiles,
					changedFiles: status.changedFiles,
					removedFiles: status.removedFiles,
					languageCounts: status.languageCounts,
					topPackageRoots: status.topPackageRoots,
					evidenceCount: status.evidenceCount,
					staleEvidenceCount: status.staleEvidenceCount,
					healthFindingsCount: status.healthFindingsCount,
					keeperLeasedBy: status.keeperLeasedBy,
					leaseExpiresAt: status.leaseExpiresAt,
				},
			};
		},
	});
}
