/**
 * Diagnostic slash command for pi-ai-automation-memory.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "./runtime";
import { syncRepo } from "./index/sync";
import { BUILT_IN_PRESETS } from "./models/presets";
import { loadConfig } from "./config/loader";

export function registerDiagnostics(pi: ExtensionAPI) {
	pi.registerCommand("repo-memory-status", {
		description: "Show pi-ai-automation-memory extension status and index info",
		handler: async (_rawArgs, ctx: ExtensionContext) => {
			const rt = buildRuntime(ctx);
			const presetNames = Object.keys(BUILT_IN_PRESETS);

			let indexLines: string[];
			try {
				const status = syncRepo(rt.repoRoot, rt.repoKey, rt.cacheDbPath);
				const ageMs = Date.now() - status.lastSyncAt;
				const ageSec = Math.round(ageMs / 1000);
				const ageText = ageSec < 60 ? `${ageSec}s ago` : ageSec < 3600 ? `${Math.round(ageSec / 60)}m ago` : `${Math.round(ageSec / 3600)}h ago`;

				indexLines = [
					"## Index Status",
					`- repo_root: ${status.repoRoot}`,
					`- git_root: ${status.gitRoot ?? "(none)"}`,
					`- branch: ${status.branch ?? "(none)"}`,
					`- head: ${status.head ?? "(none)"}`,
					`- dirty: ${status.isDirty ? "yes" : "no"}`,
					`- untracked: ${status.hasUntracked ? "yes" : "no"}`,
					`- conflicts: ${status.hasConflicts ? "yes" : "no"}`,
					`- context_version: ${status.contextVersion}`,
					`- last_sync: ${ageText}`,
					`- total_files: ${status.totalFiles}`,
					`- fresh_cards: ${status.freshCards}`,
					`- stale_cards: ${status.staleCards}`,
					`- missing_cards: ${status.missingCards}`,
					`- secret_excluded: ${status.secretExcludedCount}`,
					`- generated_excluded: ${status.generatedExcludedCount}`,
					`- cache_db: ${status.cacheDbPath}`,
				];
			} catch (err: any) {
				indexLines = [
					"## Index Status",
					`- error: ${err?.message ?? String(err)}`,
				];
			}

			const cfg = loadConfig(rt.repoRoot);
			const lines = [
				"# pi-ai-automation-memory",
				"",
				`cwd: ${rt.cwd}`,
				`repoRoot: ${rt.repoRoot}`,
				`repoKey: ${rt.repoKey}`,
				"",
				...indexLines,
				"",
				"## Registered Tools",
				"- repo_context",
				"- repo_checkpoint",
				"- repo_health_report",
				"- repo_index_status",
				"",
				"## Model Presets",
				...presetNames.map((n) => `  - ${n}: ${BUILT_IN_PRESETS[n]?.enabled ? "enabled" : "disabled"}`),
				"",
				"## Scouts",
				`- status: ${cfg.scouts.enabled ? "enabled" : "disabled"}`,
				`- runOnAgentEnd: ${cfg.scouts.runOnAgentEnd ? "yes" : "no"}`,
				`- presets: ${cfg.scouts.presets.join(", ") || "(none)"}`,
				"",
				"## No-Load-Scan Guarantee",
				"The extension does not scan the repo, open SQLite, or run git on load.",
				"All indexing work is deferred to lazy/on-demand tool calls.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
