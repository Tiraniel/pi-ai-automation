/**
 * repo_context tool — bounded, structured repo summary.
 *
 * Lazy syncs the deterministic index, queries DB, ranks files,
 * reads excerpts from disk, and returns markdown + machine-readable details.
 */

import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "../runtime";
import { syncRepo } from "../index/sync";
import { openDb, closeDb } from "../index/db";
import { loadConfig } from "../config/loader";
import {
	clamp,
	estimateTokens,
	rankFiles,
	readExcerptsSmart,
	shortHash,
} from "./repo_context_helpers";
import type { EvidenceRow, FileRecord, ImportRow } from "./repo_context_helpers";

function sanitizeCardContent(cardContent: string): string {
	const lines = cardContent.split(/\r?\n/);
	const result: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const marker = line.match(/^(\s*)-\s*excerpt(?:s)?\s*:/i);
		if (!marker) {
			result.push(line);
			continue;
		}

		const markerIndent = marker[1]?.length ?? 0;
		i++;
		while (i < lines.length) {
			const nextLine = lines[i];
			const nextIndent = nextLine.match(/^\s*/)?.[0].length ?? 0;
			if (/^\s*-\s+/.test(nextLine) && nextIndent <= markerIndent) {
				i--;
				break;
			}
			i++;
		}
	}
	return result.join("\n").trimEnd();
}

export const repoContextParameters = Type.Object({
	query: Type.Optional(Type.String({ description: "Optional focus query to rank relevance" })),
	maxFiles: Type.Optional(Type.Integer({ default: 12, description: "Max files to include (navigation-first default)" })),
	maxTokens: Type.Optional(Type.Integer({ default: 3000, description: "Approximate token budget for response (navigation-first default)" })),
	includeCards: Type.Optional(Type.Boolean({ default: true, description: "Include file cards if fresh" })),
	includeExcerpts: Type.Optional(
		Type.Boolean({
			default: false,
			description: "Include file excerpts in output and details. Keep false for navigation-only use unless scope is narrowed.",
		}),
	),
	includeEvidence: Type.Optional(Type.Boolean({ default: false, description: "Include recent evidence items" })),
	contextVersion: Type.Optional(Type.String({ description: "Optional expected context version; warns if stale" })),
});

export function registerRepoContext(pi: ExtensionAPI) {
	pi.registerTool({
		name: "repo_context",
		label: "Repo: Context",
		description: "Return a bounded, structured summary of the repo for the current agent turn.",
		promptSnippet: "Use repo_context for navigation-first repository orientation",
		promptGuidelines: [
			"Use repo_context for quick navigation before calling additional tools.",
			"Request excerpts only after scope is narrowed with a focused query.",
			"Pass a query to rank files by relevance.",
		],
		parameters: repoContextParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const rt = buildRuntime(ctx);
			const cfg = loadConfig(rt.repoRoot);
			if (!cfg.enabled) {
				return {
					content: [{ type: "text", text: "repo_context is disabled for this repository." }],
					details: { enabled: false },
				};
			}
			const p = params as any;

			const maxFiles = clamp(Number(p?.maxFiles ?? cfg.tools.repo_context.maxFiles), 1, 100);
			const maxTokens = clamp(Number(p?.maxTokens ?? cfg.tools.repo_context.maxTokens), 100, 100000);
			const includeCards = Boolean(p?.includeCards ?? true);
			const includeExcerpts = Boolean(p?.includeExcerpts ?? cfg.tools.repo_context.includeExcerpts);
			const includeEvidence = Boolean(p?.includeEvidence ?? false);
			const query = typeof p?.query === "string" ? p.query : undefined;
			const requestedContextVersion = typeof p?.contextVersion === "string" ? p.contextVersion : undefined;

			const sync = syncRepo(rt.repoRoot, rt.repoKey, rt.cacheDbPath);
			const handle = openDb(rt.repoKey, rt.repoRoot);
			const db = handle.db;

			try {
				// Query files
				const fileRows = db.prepare(
					`SELECT relative_path, content_hash, git_blob_hash, size_bytes,
						language, package_root, card_freshness, card_content,
						card_source_hash, card_context_version, card_refs, card_excerpts,
						card_confidence, card_worker_id, card_metadata, card_stale_reason,
						is_dirty, is_untracked, imports_hash
					 FROM files
					 WHERE repo_key = ? AND is_deleted = 0
					 ORDER BY relative_path`
				).all(rt.repoKey) as FileRecord[];

				// Query imports
				const importRows = db.prepare(
					`SELECT f.relative_path, i.import_path
					 FROM imports i
					 JOIN files f ON i.from_file_id = f.id
					 WHERE f.repo_key = ?`
				).all(rt.repoKey) as ImportRow[];
				const importsMap = new Map<string, string[]>();
				for (const row of importRows) {
					const arr = importsMap.get(row.relative_path) ?? [];
					arr.push(row.import_path);
					importsMap.set(row.relative_path, arr);
				}

				// Query evidence
				let evidenceRows: EvidenceRow[] = [];
				if (includeEvidence) {
					evidenceRows = db.prepare(
						`SELECT claim, confidence, recorded_at, is_stale, context_version, stale_reason
						 FROM evidence
						 WHERE repo_key = ?
						 ORDER BY recorded_at DESC
						 LIMIT 20`
					).all(rt.repoKey) as EvidenceRow[];
				}

				// Rank and select
				const ranked = rankFiles(fileRows, importsMap, query);
				const selected = ranked.slice(0, maxFiles);

				// Build output with token budget
				const lines: string[] = [];
				let truncated = false;
				const truncationReasons = new Set<string>();
				lines.push(`# Repo Context: ${path.basename(rt.repoRoot)}`);
				lines.push("");
				lines.push(`- **context_version**: ${sync.contextVersion}`);
				lines.push(`- **last_sync_at**: ${new Date(sync.lastSyncAt).toISOString()}`);
				lines.push(`- **index_freshness_ms**: ${Date.now() - sync.lastSyncAt}`);
				lines.push(`- **files_total**: ${sync.totalFiles}`);
				lines.push(`- **files_selected**: ${selected.length}`);
				lines.push(`- **branch**: ${sync.branch ?? "(none)"}`);
				lines.push(`- **head**: ${sync.head ? sync.head.slice(0, 12) : "(none)"}`);
				lines.push(`- **dirty**: ${sync.isDirty}, **untracked**: ${sync.hasUntracked}`);
				lines.push("");

				// Principles
				const principles = cfg.integrity.principles;
				lines.push("## Principles");
				if (principles.length > 0) {
					for (const pr of principles) lines.push(`- ${pr}`);
				} else {
					lines.push("- No repo-memory principles configured.");
				}
				lines.push("");

				// Warnings
				const warnings: string[] = [...cfg.warnings];
				if (sync.staleCards > 0) warnings.push(`${sync.staleCards} stale cards — do not trust card content.`);
				if (sync.hasConflicts) warnings.push("Merge conflicts detected.");
				if (requestedContextVersion && requestedContextVersion !== sync.contextVersion) {
					warnings.push(`Context version mismatch: requested ${requestedContextVersion}, current ${sync.contextVersion}.`);
				}
				if (warnings.length > 0) {
					lines.push("## Warnings");
					for (const w of warnings) lines.push(`- ${w}`);
					lines.push("");
				}

				// Metadata
				lines.push("## Metadata");
				lines.push(`- languages: ${Object.entries(sync.languageCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(", ") || "(none)"}`);
				lines.push(`- package_roots: ${sync.topPackageRoots.join(", ") || "(none)"}`);
				lines.push(`- fresh_cards: ${sync.freshCards}, stale_cards: ${sync.staleCards}, missing_cards: ${sync.missingCards}`);
				lines.push("");

				// Risks
				const risks: string[] = [];
				if (sync.isDirty) risks.push("Working tree has uncommitted changes (dirty).");
				if (sync.hasUntracked) risks.push("Untracked files present.");
				if (sync.hasConflicts) risks.push("Merge conflicts detected.");
				if (sync.staleCards > 0) risks.push(`${sync.staleCards} stale file cards — do not trust card content.`);
				if (sync.missingCards > 0) risks.push(`${sync.missingCards} files without cards.`);
				if (cfg.warnings.length > 0) risks.push(...cfg.warnings.map((w) => `Config warning: ${w}`));
				if (risks.length === 0) risks.push("No immediate deterministic risks detected.");
				lines.push("## Risks");
				for (const r of risks) lines.push(`- ${r}`);
				lines.push("");

				// Tests
				const testLikeFiles = selected
					.filter((f) => {
						const lower = f.relative_path.toLowerCase();
						return (
							lower.includes("/test/") ||
							lower.includes("/tests/") ||
							lower.includes("/spec/") ||
							/\.(test|spec)\./.test(lower)
						);
					})
					.map((f) => f.relative_path)
					.slice(0, 10);
				lines.push("## Tests");
				if (testLikeFiles.length > 0) {
					for (const t of testLikeFiles) lines.push(`- ${t}`);
				} else {
					lines.push("- No test-like files detected in selection.");
				}
				lines.push("");

				// Unknowns
				const unknowns: string[] = [];
				if (sync.missingCards > 0) unknowns.push(`${sync.missingCards} files have no cards.`);
				if (sync.evidenceCount === 0) unknowns.push("No evidence recorded yet.");
				if (sync.healthFindingsCount === 0) unknowns.push("No health findings recorded yet.");
				if (sync.keeperLeasedBy) unknowns.push(`Keeper lease held by ${sync.keeperLeasedBy} (may be pending).`);
				if (unknowns.length === 0) unknowns.push("No obvious unknowns flagged from index counts.");
				lines.push("## Unknowns");
				for (const u of unknowns) lines.push(`- ${u}`);
				lines.push("");

				// Files
				lines.push("## Files");
				let tokenBudget = maxTokens - estimateTokens(lines.join("\n"));
				const fileDetails: any[] = [];
				const staleCardFiles: string[] = [];

				for (const f of selected) {
					const absPath = path.join(rt.repoRoot, f.relative_path);
					const imports = importsMap.get(f.relative_path) ?? [];
					const isStaleCard = f.card_freshness === "stale";
					if (isStaleCard) staleCardFiles.push(f.relative_path);

					const fileLines: string[] = [];
					fileLines.push(`### ${f.relative_path}`);
					fileLines.push(`- size: ${f.size_bytes} bytes, language: ${f.language ?? "unknown"}, package: ${f.package_root ?? "(none)"}`);
					fileLines.push(`- content_hash: \`${shortHash(f.content_hash)}\``);
					if (f.git_blob_hash) fileLines.push(`- git_blob_hash: \`${shortHash(f.git_blob_hash)}\``);
					if (f.is_dirty) fileLines.push("- **dirty**");
					if (f.is_untracked) fileLines.push("- **untracked**");
					if (imports.length > 0) fileLines.push(`- imports: ${imports.slice(0, 10).join(", ")}${imports.length > 10 ? " …" : ""}`);

					// Trust rule: card is trusted if freshness is fresh AND source hash matches current content
					const cardTrusted =
						f.card_freshness === "fresh" &&
						(f.card_source_hash ?? f.content_hash) === f.content_hash;

					if (includeCards && f.card_content && cardTrusted) {
						fileLines.push("- card (fresh, trusted):");
						fileLines.push("  ```");
						const renderedCard = includeExcerpts ? f.card_content : sanitizeCardContent(f.card_content);
						const cardLines = renderedCard.split(/\r?\n/);
						const previewLines = cardLines.slice(0, 10);
						for (const cl of previewLines) fileLines.push(`  ${cl}`);
						if (cardLines.length > 10) fileLines.push("  …");
						fileLines.push("  ```");
						if (f.card_confidence !== null) {
							fileLines.push(`  confidence: ${f.card_confidence}, worker: ${f.card_worker_id ?? "?"}`);
						}
					} else if (isStaleCard || (f.card_content && !cardTrusted)) {
						fileLines.push("- card: **DO NOT TRUST** (stale)");
						if (f.card_stale_reason) {
							fileLines.push(`  reason: ${f.card_stale_reason}`);
						}
					}

					// Excerpts
					let excerpts: { ref: string; lines: string[]; startLine: number }[] = [];
					if (includeExcerpts) {
						const excerptBudget = Math.max(
							500,
							Math.floor(tokenBudget / Math.max(1, selected.length - fileDetails.length)),
						);
						const foundExcerpts = readExcerptsSmart(
							absPath,
							f.relative_path,
							query,
							2,
							6,
							Math.min(4096, excerptBudget * 4),
						) ?? [];
						excerpts = foundExcerpts;
						if (foundExcerpts.length > 0) {
							for (const ex of foundExcerpts) {
								fileLines.push(`- excerpt: ${ex.ref}`);
								fileLines.push("  ```");
								for (const line of ex.lines) {
									fileLines.push(`  ${line}`);
								}
								fileLines.push("  ```");
							}
						}
					}

					const fileText = fileLines.join("\n");
					const fileTokens = estimateTokens(fileText);
					if (fileTokens > tokenBudget && fileDetails.length > 0) {
						lines.push("");
						lines.push("> _Truncated: token budget exhausted._");
						truncated = true;
						truncationReasons.add("token");
						break;
					}

					tokenBudget -= fileTokens;
					lines.push(...fileLines);
					lines.push("");

					fileDetails.push({
						relative_path: f.relative_path,
						content_hash: f.content_hash,
						git_blob_hash: f.git_blob_hash,
						size_bytes: f.size_bytes,
						language: f.language,
						package_root: f.package_root,
						card_freshness: f.card_freshness,
						is_dirty: !!f.is_dirty,
						is_untracked: !!f.is_untracked,
						imports,
						excerpts: excerpts.map((ex) => ({ ref: ex.ref, lines: ex.lines, start_line: ex.startLine })),
					});
				}

				// Evidence
				if (includeEvidence && evidenceRows.length > 0 && tokenBudget > 0) {
					lines.push("## Recent Evidence");
					for (const e of evidenceRows) {
						const isStaleEffective = !!e.is_stale || e.context_version !== sync.contextVersion;
						const staleTag = isStaleEffective ? " **STALE**" : "";
						const reasonSuffix = isStaleEffective && e.stale_reason ? ` — ${e.stale_reason.slice(0, 200)}` : "";
						const evLine = `- ${new Date(e.recorded_at).toISOString()} confidence=${e.confidence ?? "?"}${staleTag}: ${e.claim.slice(0, 200)}${reasonSuffix}`;
						lines.push(evLine);
					}
					lines.push("");
				}

				// Truncation footer
				const effectiveByteLimit = Math.min(cfg.output.defaultTruncationLimitBytes, maxTokens * 4);
				const lineLimit = cfg.output.defaultTruncationLimitLines;
				let text = lines.join("\n");
				if (Buffer.byteLength(text, "utf-8") > effectiveByteLimit) {
					let idx = text.length;
					while (idx > 0 && Buffer.byteLength(text.slice(0, idx), "utf-8") > effectiveByteLimit) idx--;
					text = text.slice(0, idx) + "\n\n> _Truncated by byte limit._";
					truncated = true;
					truncationReasons.add("byte");
				}
				const textLines = text.split(/\r?\n/);
				if (textLines.length > lineLimit) {
					text = textLines.slice(0, lineLimit).join("\n") + "\n\n> _Truncated by line limit._";
					truncated = true;
					truncationReasons.add("line");
				}

				return {
					content: [{ type: "text", text }],
					details: {
						context_version: sync.contextVersion,
						requested_context_version: requestedContextVersion ?? null,
						stale_context_warning: !!(requestedContextVersion && requestedContextVersion !== sync.contextVersion),
						last_sync_at: sync.lastSyncAt,
						index_freshness_ms: Date.now() - sync.lastSyncAt,
						repoRoot: rt.repoRoot,
						repoKey: rt.repoKey,
						files_total: sync.totalFiles,
						files_selected: fileDetails.length,
						truncated,
						truncation_reasons: Array.from(truncationReasons),
						byte_limit: effectiveByteLimit,
						line_limit: lineLimit,
						maxTokens,
						tokenBudgetRemaining: tokenBudget,
						include_excerpts: includeExcerpts,
						files: fileDetails,
						evidence: evidenceRows.map((e) => ({
							claim: e.claim,
							confidence: e.confidence,
							recorded_at: e.recorded_at,
							is_stale: !!e.is_stale,
							is_stale_effective: !!e.is_stale || e.context_version !== sync.contextVersion,
							context_version: e.context_version,
							stale_reason: e.stale_reason,
						})),
						principles: cfg.integrity.principles,
						warnings,
						stale_card_files: staleCardFiles,
						conflictCount: sync.conflictCount,
						conflictPaths: sync.conflictPaths,
					},
				};
			} finally {
				closeDb(handle);
			}
		},
	});
}
