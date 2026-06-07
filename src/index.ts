/**
 * pi-ai-automation-memory — Pi extension entry point.
 *
 * Default export factory: (pi: ExtensionAPI) => void
 * Registers four AI-facing tools, a diagnostic command, auto-brief, and context filter.
 * Does NOT scan the repo, open SQLite, or run git on load.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { registerDiagnostics } from "./diagnostics";
import { registerRepoContext } from "./tools/repo_context";
import { registerRepoCheckpoint } from "./tools/repo_checkpoint";
import { registerRepoHealthReport } from "./tools/repo_health_report";
import { registerRepoIndexStatus } from "./tools/repo_index_status";
import { syncRepo } from "./index/sync";
import { buildRuntime } from "./runtime";
import { loadConfig } from "./config/loader";
import { errorMessage } from "./util/errors";

// Future integration stubs — imported to ensure they compile and are discoverable,
// but not invoked during extension load.
import { resolvePreset } from "./models/presets";
import { runKeeperUnit } from "./keeper/scheduler";
import { runScoutUnit } from "./scout/runner";

// In-memory cooldown for auto-brief: one entry per repo key
const lastBriefTimestamps = new Map<string, number>();
const BRIEF_TRUNCATION_SUFFIX = "\n\n[Brief truncated: use repo_context for navigation details]";

function truncateBriefContent(content: string, maxBytes: number): { text: string; truncated: boolean } {
	const textByteLimit = Math.max(1, maxBytes);
	const fullSuffix = BRIEF_TRUNCATION_SUFFIX;
	const fullSuffixBytes = Buffer.byteLength(fullSuffix, "utf-8");

	if (Buffer.byteLength(content, "utf-8") <= textByteLimit) {
		return { text: content, truncated: false };
	}

	let suffix = fullSuffix;
	let suffixBytes = fullSuffixBytes;
	if (fullSuffixBytes >= textByteLimit) {
		suffix = "…";
		suffixBytes = Buffer.byteLength(suffix, "utf-8");
	}
	let truncated = content;
	while (
		truncated.length > 0 && Buffer.byteLength(truncated, "utf-8") + suffixBytes > textByteLimit
	) {
		truncated = truncated.slice(0, -1);
	}
	if (truncated.length === 0) {
		return suffixBytes <= textByteLimit ? { text: suffix, truncated: true } : { text: "", truncated: true };
	}
	return { text: `${truncated}${suffix}`, truncated: true };
}

export default function piAiAutomationMemory(pi: ExtensionAPI) {
	// Register the four AI-facing tools
	registerRepoContext(pi);
	registerRepoCheckpoint(pi);
	registerRepoHealthReport(pi);
	registerRepoIndexStatus(pi);

	// Register diagnostic slash command
	registerDiagnostics(pi);

	// Future integration stubs: ensure preset/keeper/scout modules are reachable at runtime
	const _presets = resolvePreset("index_keeper");
	const _keeperStub = runKeeperUnit;
	const _scoutStub = runScoutUnit;
	void _presets;
	void _keeperStub;
	void _scoutStub;

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

		const now = Date.now();
		const cooldownKey = rt.repoKey;
		const lastAt = lastBriefTimestamps.get(cooldownKey);
		if (lastAt !== undefined && now - lastAt < cfg.autoBrief.minIntervalMs) {
			return undefined;
		}

		// Record attempt before sync to prevent repeated expensive retries from blocking prompt flow
		lastBriefTimestamps.set(cooldownKey, now);

		let sync: ReturnType<typeof syncRepo>;
		let syncError: string | undefined;
		try {
			sync = syncRepo(rt.repoRoot, rt.repoKey, rt.cacheDbPath);
		} catch (err) {
			syncError = errorMessage(err);
		}

		if (syncError) {
			const { text, truncated } = truncateBriefContent(
				`## Repo Brief: ${rt.repoKey}\n- warning: auto-brief degraded — ${syncError}\n- generated: ${new Date(now).toISOString()}\n- Use \`repo_context\` with a focused query; set \`includeExcerpts=true\` only after narrowing scope.`,
				cfg.autoBrief.maxTokens * 4,
			);
			return {
				message: {
					customType: "repo-memory-brief",
					display: true,
					content: text,
					details: {
						repoKey: rt.repoKey,
						repoRoot: rt.repoRoot,
						degraded: true,
						error: syncError,
						generatedAt: now,
						truncated,
					},
				},
			};
		}

		const generatedAt = Date.now();
		const languageCounts = Object.entries(sync.languageCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([lang, count]) => `${lang}(${count})`)
			.join(", ");

		const lines: string[] = [];
		lines.push(`## Repo Brief: ${rt.repoKey}`);
		lines.push(`- branch: ${sync.branch ?? "(none)"}, head: ${sync.head ? sync.head.slice(0, 12) : "(none)"}`);
		lines.push(`- dirty: ${sync.isDirty}, untracked: ${sync.hasUntracked}, conflicts: ${sync.hasConflicts}`);
		lines.push(`- files: ${sync.totalFiles}`);
		lines.push(`- languages: ${languageCounts || "(none)"}`);
		lines.push(`- package_roots: ${sync.topPackageRoots.slice(0, 3).join(", ") || "(none)"}`);
		lines.push(`- cards: fresh=${sync.freshCards}, stale=${sync.staleCards}, missing=${sync.missingCards}`);
		lines.push(`- context_version: ${sync.contextVersion}`);
		lines.push(`- generated: ${new Date(generatedAt).toISOString()}`);
		lines.push("- Use `repo_context` with a focused query; set `includeExcerpts=true` only after narrowing scope.");

		const contentText = lines.join("\n");
		const byteLimit = Math.max(1, cfg.autoBrief.maxTokens * 4);
		const { text: content, truncated } = truncateBriefContent(contentText, byteLimit);

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
					freshCards: sync.freshCards,
					staleCards: sync.staleCards,
					missingCards: sync.missingCards,
					generatedAt,
					truncated,
					byteLimit: byteLimit,
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

	// tool_result hook: lazily sync after mutation tools to mark stale
	pi.on("tool_result", async (event, ctx) => {
		if (!isBashToolResult(event) && !isEditToolResult(event) && !isWriteToolResult(event)) {
			return;
		}
		try {
			const rt = buildRuntime(ctx);
			const cfg = loadConfig(rt.repoRoot);
			if (!cfg.enabled) return;
			// Lazy sync to mark status/hash/card/evidence stale after mutations
			const { syncRepo: syncFn } = await import("./index/sync");
			syncFn(rt.repoRoot, rt.repoKey, rt.cacheDbPath);
		} catch (err) {
			// Catch and log; never throw from hook
			if (typeof console !== "undefined" && console.error) {
				console.error("[pi-ai-automation-memory] tool_result sync error:", errorMessage(err));
			}
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		const rt = buildRuntime(ctx);
		const cfg = loadConfig(rt.repoRoot);
		if (!cfg.enabled) return;

		// Fire-and-forget keeper run; do not block agent_end
		const keeperPreset = cfg.keeper.enabled && cfg.keeper.runOnAgentEnd
			? resolvePreset("index_keeper", cfg.modelPresets)
			: undefined;
		if (keeperPreset && keeperPreset.enabled === true) {
			try {
				const { syncRepo: syncFn } = await import("./index/sync");
				const { runKeeperUnit } = await import("./keeper/scheduler");
				const sync = syncFn(rt.repoRoot, rt.repoKey, rt.cacheDbPath);
				await runKeeperUnit({
					repoKey: rt.repoKey,
					repoRoot: rt.repoRoot,
					maxRunTimeMs: Math.min(cfg.keeper.maxRunTimeMs, keeperPreset.budgetMs ?? cfg.keeper.maxRunTimeMs),
					maxTokensPerRun: Math.min(cfg.keeper.maxTokensPerRun, keeperPreset.budgetTokens ?? cfg.keeper.maxTokensPerRun),
					batchSize: cfg.keeper.batchSize,
					leaseDurationMs: cfg.keeper.leaseDurationMs,
					contextVersion: sync.contextVersion,
					modelPresetName: keeperPreset.name ?? "index_keeper",
					modelPresetOverrides: cfg.modelPresets,
				});
			} catch (err) {
				if (typeof console !== "undefined" && console.error) {
					console.error("[pi-ai-automation-memory] keeper agent_end error:", errorMessage(err));
				}
			}
		}

		// Fire-and-forget scout run; do not block agent_end
		if (cfg.scouts.enabled && cfg.scouts.runOnAgentEnd) {
			try {
				const { runScoutUnit } = await import("./scout/runner");
				for (const presetName of cfg.scouts.presets) {
					await runScoutUnit({
						repoKey: rt.repoKey,
						repoRoot: rt.repoRoot,
						presetName,
						maxFilesPerRun: cfg.scouts.maxFilesPerRun,
						maxFindingsPerRun: cfg.scouts.maxFindingsPerRun,
						maxTokensPerRun: cfg.scouts.maxTokensPerRun,
						appendEvidence: true,
					});
				}
			} catch (err) {
				if (typeof console !== "undefined" && console.error) {
					console.error("[pi-ai-automation-memory] scout agent_end error:", errorMessage(err));
				}
			}
		}
	});

	pi.on("session_shutdown", async () => {
		// Scaffold: no cleanup yet (TASK-006)
	});
}
