/**
 * pi-ai-automation-memory — Pi extension entry point.
 *
 * Default export factory: (pi: ExtensionAPI) => void
 * Registers four AI-facing tools, a diagnostic command, auto-brief, and context filter.
 * Does NOT scan the repo, open SQLite, or run git on load.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDiagnostics } from "./diagnostics";
import { registerRepoContext } from "./tools/repo_context";
import { registerRepoCheckpoint } from "./tools/repo_checkpoint";
import { registerRepoHealthReport } from "./tools/repo_health_report";
import { registerRepoIndexStatus } from "./tools/repo_index_status";
import { syncRepo } from "./index/sync";
import { openDb, closeDb } from "./index/db";
import { buildRuntime } from "./runtime";
import { loadConfig } from "./config/loader";

// Future integration stubs — imported to ensure they compile and are discoverable,
// but not invoked during extension load.
import { resolvePreset } from "./models/presets";
import { runKeeperUnit } from "./keeper/scheduler";

// In-memory cooldown for auto-brief: repoKey + contextVersion -> lastBriefAt
const lastBriefTimestamps = new Map<string, number>();

export default function piAiAutomationMemory(pi: ExtensionAPI) {
	// Register the four AI-facing tools
	registerRepoContext(pi);
	registerRepoCheckpoint(pi);
	registerRepoHealthReport(pi);
	registerRepoIndexStatus(pi);

	// Register diagnostic slash command
	registerDiagnostics(pi);

	// Future integration stubs: ensure preset/keeper modules are reachable at runtime
	const _presets = resolvePreset("index_keeper");
	const _keeperStub = runKeeperUnit;
	void _presets;
	void _keeperStub;

	// Auto-brief injection before agent starts
	pi.on("before_agent_start", async (_event, ctx) => {
		// Skip child workflows
		if (process.env.PI_WORKFLOW_CHILD === "1") {
			return undefined;
		}

		// Skip if workflow-agent flag is "none" when available
		try {
			const flag = pi.getFlag?.("workflow-agent");
			if (flag === "none") {
				return undefined;
			}
		} catch {
			// getFlag not available, continue
		}

		const rt = buildRuntime(ctx);
		const cfg = loadConfig(rt.repoRoot);

		if (!cfg.enabled || !cfg.autoBrief.enabled) {
			return undefined;
		}

		// Sync and get context version with graceful degradation
		let sync: ReturnType<typeof syncRepo>;
		let staleCardFiles: string[] = [];
		let syncError: string | undefined;
		try {
			sync = syncRepo(rt.repoRoot, rt.repoKey, rt.cacheDbPath);
			const handle = openDb(rt.repoKey, rt.repoRoot);
			try {
				const rows = handle.db.prepare(
					`SELECT relative_path FROM files
					 WHERE repo_key = ? AND card_freshness = 'stale' AND is_deleted = 0
					 ORDER BY relative_path`
				).all(rt.repoKey) as Array<{ relative_path: string }>;
				staleCardFiles = rows.map((r) => r.relative_path);
			} finally {
				closeDb(handle);
			}
		} catch (err: any) {
			syncError = err?.message ?? String(err);
			// Return degraded brief with error info
			return {
				message: {
					customType: "repo-memory-brief",
					display: true,
					content: `## Repo Brief: ${rt.repoKey}\n- **warning**: auto-brief degraded — ${syncError}\n- Use \`repo_context\` for details.`,
					details: {
						repoKey: rt.repoKey,
						repoRoot: rt.repoRoot,
						error: syncError,
						degraded: true,
					},
				},
			};
		}

		const now = Date.now();
		const cooldownKey = `${rt.repoKey}:${sync.contextVersion}`;
		const lastAt = lastBriefTimestamps.get(cooldownKey);
		if (lastAt !== undefined && now - lastAt < cfg.autoBrief.minIntervalMs) {
			return undefined;
		}
		lastBriefTimestamps.set(cooldownKey, now);

		// Build compact brief
		const lines: string[] = [];
		lines.push(`## Repo Brief: ${rt.repoKey}`);
		lines.push(`- branch: ${sync.branch ?? "(none)"}, head: ${sync.head ? sync.head.slice(0, 12) : "(none)"}`);
		lines.push(`- dirty: ${sync.isDirty}, untracked: ${sync.hasUntracked}, conflicts: ${sync.hasConflicts}`);
		lines.push(`- files: ${sync.totalFiles}`);
		lines.push(`- languages: ${Object.entries(sync.languageCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v})`).join(", ") || "(none)"}`);
		lines.push(`- package_roots: ${sync.topPackageRoots.slice(0, 5).join(", ") || "(none)"}`);
		if (staleCardFiles.length > 0) {
			lines.push(`- stale_cards: ${staleCardFiles.slice(0, 10).join(", ")}${staleCardFiles.length > 10 ? " …" : ""}`);
		}
		lines.push(`- context_version: ${sync.contextVersion}`);
		lines.push(`- generated: ${new Date(now).toISOString()}`);
		lines.push("- Use `repo_context` for detailed file listings and excerpts.");

		let content = lines.join("\n");
		let truncated = false;
		const effectiveByteLimit = Math.min(cfg.output.defaultTruncationLimitBytes, cfg.autoBrief.maxTokens * 4);
		const byteLen = Buffer.byteLength(content, "utf-8");
		if (byteLen > effectiveByteLimit) {
			let idx = content.length;
			while (idx > 0 && Buffer.byteLength(content.slice(0, idx), "utf-8") > effectiveByteLimit) idx--;
			content = content.slice(0, idx) + "\n\n[Brief truncated: use repo_context tool for full details]";
			truncated = true;
		}

		return {
			message: {
				customType: "repo-memory-brief",
				display: true,
				content,
				details: {
					repoKey: rt.repoKey,
					repoRoot: rt.repoRoot,
					contextVersion: sync.contextVersion,
					lastSyncAt: sync.lastSyncAt,
					branch: sync.branch,
					head: sync.head,
					isDirty: sync.isDirty,
					hasUntracked: sync.hasUntracked,
					hasConflicts: sync.hasConflicts,
					filesTotal: sync.totalFiles,
					languageCounts: sync.languageCounts,
					topPackageRoots: sync.topPackageRoots,
					staleCardFiles,
					generatedAt: now,
					truncated,
					byteLimit: effectiveByteLimit,
				},
			},
		};
	});

	// Context filter: keep only the newest repo-memory-brief in LLM context
	pi.on("context", (event: any) => {
		const messages = event?.messages;
		if (!Array.isArray(messages)) return { messages };
		let lastIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if ((m.role === "custom" || m.customType) && m.customType === "repo-memory-brief") {
				lastIndex = i;
				break;
			}
		}
		if (lastIndex >= 0) {
			const filtered = messages.filter((m: any, i: number) => !((m.role === "custom" || m.customType) && m.customType === "repo-memory-brief") || i === lastIndex);
			return { messages: filtered };
		}
		return { messages };
	});

	pi.on("agent_end", async (_event, ctx) => {
		const rt = buildRuntime(ctx);
		const cfg = loadConfig(rt.repoRoot);
		if (!cfg.enabled || !cfg.keeper.enabled || !cfg.keeper.runOnAgentEnd) {
			return;
		}
		// Fire-and-forget keeper run; do not block agent_end
		try {
			const { syncRepo: syncFn } = await import("./index/sync");
			const { runKeeperUnit } = await import("./keeper/scheduler");
			const sync = syncFn(rt.repoRoot, rt.repoKey, rt.cacheDbPath);
			await runKeeperUnit({
				repoKey: rt.repoKey,
				repoRoot: rt.repoRoot,
				maxRunTimeMs: cfg.keeper.maxRunTimeMs,
				maxTokensPerRun: cfg.keeper.maxTokensPerRun,
				batchSize: cfg.keeper.batchSize,
				leaseDurationMs: cfg.keeper.leaseDurationMs,
				contextVersion: sync.contextVersion,
			});
		} catch (err: any) {
			// Silently catch; keeper failures must not break agent flow
			// eslint-disable-next-line no-console
			if (typeof console !== "undefined" && console.error) {
				console.error("[pi-ai-automation-memory] keeper agent_end error:", err?.message ?? String(err));
			}
		}
	});

	pi.on("session_shutdown", async () => {
		// Scaffold: no cleanup yet (TASK-006)
	});
}
