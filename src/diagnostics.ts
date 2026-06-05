/**
 * Diagnostic slash command for pi-ai-automation-memory.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "./runtime";
import { BUILT_IN_PRESETS } from "./models/presets";

export function registerDiagnostics(pi: ExtensionAPI) {
	pi.registerCommand("repo-memory-status", {
		description: "Show pi-ai-automation-memory extension status and scaffold info",
		handler: async (_rawArgs, ctx: ExtensionContext) => {
			const rt = buildRuntime(ctx);
			const presetNames = Object.keys(BUILT_IN_PRESETS);
			const lines = [
				"# pi-ai-automation-memory (scaffold)",
				"",
				`cwd: ${rt.cwd}`,
				`repoRoot: ${rt.repoRoot}`,
				"",
				"## Status",
				"- deterministic index: not built (TASK-003)",
				"- evidence queue: not initialized (TASK-005)",
				"- keeper scheduler: stub only (TASK-006)",
				"- integrity consultant: stub only (TASK-007)",
				"- auto-brief: stub only (TASK-004)",
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
				"## No-Load-Scan Guarantee",
				"The extension does not scan the repo, open SQLite, or run git on load.",
				"All indexing work is deferred to lazy/on-demand tool calls.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
