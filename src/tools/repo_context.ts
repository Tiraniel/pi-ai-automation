/**
 * repo_context tool — bounded, structured repo summary.
 *
 * Lazy syncs the deterministic index, queries DB, ranks files,
 * reads excerpts from disk, and returns markdown + machine-readable details.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "../runtime";
import { syncRepo } from "../index/sync";
import { openDb, closeDb } from "../index/db";
import { loadConfig } from "../config/loader";

export const repoContextParameters = Type.Object({
	query: Type.Optional(Type.String({ description: "Optional focus query to rank relevance" })),
	maxFiles: Type.Optional(Type.Integer({ default: 30, description: "Max files to include" })),
	maxTokens: Type.Optional(Type.Integer({ default: 8000, description: "Approximate token budget for response" })),
	includeCards: Type.Optional(Type.Boolean({ default: true, description: "Include file cards if fresh" })),
	includeEvidence: Type.Optional(Type.Boolean({ default: false, description: "Include recent evidence items" })),
	contextVersion: Type.Optional(Type.String({ description: "Optional expected context version; warns if stale" })),
});

interface FileRecord {
	relative_path: string;
	content_hash: string;
	git_blob_hash: string | null;
	size_bytes: number;
	language: string | null;
	package_root: string | null;
	card_freshness: string | null;
	card_content: string | null;
	card_source_hash: string | null;
	card_context_version: string | null;
	card_refs: string | null;
	card_excerpts: string | null;
	card_confidence: number | null;
	card_worker_id: string | null;
	card_metadata: string | null;
	card_stale_reason: string | null;
	is_dirty: number;
	is_untracked: number;
	imports_hash: string | null;
}

interface ImportRow {
	relative_path: string;
	import_path: string;
}

interface EvidenceRow {
	claim: string;
	confidence: number | null;
	recorded_at: number;
	is_stale: number;
	context_version: string;
	stale_reason: string | null;
}

const IMPORTANT_PREFIXES = [
	"readme", "package.json", "docs/", "src/", "config/", "test", "spec",
];

function isImportantPath(rel: string): boolean {
	const lower = rel.toLowerCase();
	return IMPORTANT_PREFIXES.some((p) => lower.startsWith(p) || lower.includes("/" + p));
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_\/\.]+/)
		.filter((t) => t.length > 1);
}

function queryScore(rel: string, queryTokens: string[], imports: string[], cardContent: string | null): number {
	if (queryTokens.length === 0) return 0;
	const text = [rel, ...imports, cardContent ?? ""].join(" ");
	const textTokens = new Set(tokenize(text));
	let matches = 0;
	for (const qt of queryTokens) {
		for (const tt of textTokens) {
			if (tt.includes(qt) || qt.includes(tt)) matches++;
		}
	}
	return matches;
}

function rankFiles(
	files: FileRecord[],
	importsMap: Map<string, string[]>,
	query: string | undefined,
): FileRecord[] {
	const queryTokens = query ? tokenize(query) : [];
	const scored = files.map((f) => {
		let score = 0;
		if (isImportantPath(f.relative_path)) score += 3;
		if (f.is_dirty) score += 2;
		if (f.is_untracked) score += 2;
		if (f.card_freshness === "stale" || f.card_freshness === "missing") score += 1;
		const imports = importsMap.get(f.relative_path) ?? [];
		if (queryTokens.length > 0) {
			score += queryScore(f.relative_path, queryTokens, imports, f.card_content);
		}
		return { file: f, score };
	});
	scored.sort((a, b) => b.score - a.score || a.file.relative_path.localeCompare(b.file.relative_path));
	return scored.map((s) => s.file);
}

function shortHash(hash: string): string {
	return hash.slice(0, 12);
}

interface Excerpt {
	ref: string;
	lines: string[];
	startLine: number;
}

function readExcerptsSmart(
	absPath: string,
	relPath: string,
	query: string | undefined,
	maxExcerpts: number,
	maxLinesPerExcerpt: number,
	maxBytes: number,
): Excerpt[] | null {
	try {
		const stats = fs.statSync(absPath);
		if (!stats.isFile() || stats.size > 256 * 1024) return null;
		const content = fs.readFileSync(absPath, "utf-8");
		if (Buffer.byteLength(content, "utf-8") > maxBytes) {
			// Still read but we'll be bounded by line processing
		}
		const allLines = content.split(/\r?\n/);
		if (allLines.length === 0) return null;

		const excerpts: Excerpt[] = [];

		if (query && query.trim().length > 0) {
			const queryTokens = tokenize(query);
			// Find lines matching query tokens
			const matchLines = new Set<number>();
			for (let i = 0; i < allLines.length; i++) {
				const lineLower = allLines[i].toLowerCase();
				for (const qt of queryTokens) {
					if (lineLower.includes(qt)) {
						matchLines.add(i);
						break;
					}
				}
			}
			// Build non-overlapping windows around matches
			const used = new Set<number>();
			for (const lineIdx of Array.from(matchLines).sort((a, b) => a - b)) {
				if (excerpts.length >= maxExcerpts) break;
				if (used.has(lineIdx)) continue;
				const half = Math.floor(maxLinesPerExcerpt / 2);
				const start = Math.max(0, lineIdx - half);
				const end = Math.min(allLines.length, start + maxLinesPerExcerpt);
				const slice = allLines.slice(start, end);
				for (let i = start; i < end; i++) used.add(i);
				excerpts.push({
					ref: `${relPath}:L${start + 1}-L${end}`,
					lines: slice,
					startLine: start + 1,
				});
			}
		}

		// Fallback to first-lines excerpt if no query or no matches
		if (excerpts.length === 0) {
			const end = Math.min(allLines.length, maxLinesPerExcerpt);
			excerpts.push({
				ref: `${relPath}:L1-L${end}`,
				lines: allLines.slice(0, end),
				startLine: 1,
			});
		}

		return excerpts;
	} catch {
		return null;
	}
}

function estimateTokens(text: string): number {
	// Very rough: ~4 chars per token on average for code
	return Math.ceil(text.length / 4);
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

export function registerRepoContext(pi: ExtensionAPI) {
	pi.registerTool({
		name: "repo_context",
		label: "Repo: Context",
		description: "Return a bounded, structured summary of the repo for the current agent turn.",
		promptSnippet: "Get bounded repo context before planning or coding",
		promptGuidelines: [
			"Use repo_context when you need a quick overview of the repo structure, key files, or current state.",
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
						const cardLines = f.card_content.split(/\r?\n/).slice(0, 10);
						for (const cl of cardLines) fileLines.push(`  ${cl}`);
						if (f.card_content.split(/\r?\n/).length > 10) fileLines.push("  …");
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
					const excerptBudget = Math.max(500, Math.floor(tokenBudget / Math.max(1, selected.length - fileDetails.length)));
					const excerpts = readExcerptsSmart(
						absPath,
						f.relative_path,
						query,
						2,
						6,
						Math.min(4096, excerptBudget * 4),
					);
					if (excerpts && excerpts.length > 0) {
						for (const ex of excerpts) {
							fileLines.push(`- excerpt: ${ex.ref}`);
							fileLines.push("  ```");
							for (const line of ex.lines) {
								fileLines.push(`  ${line}`);
							}
							fileLines.push("  ```");
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
						excerpts: excerpts?.map((ex) => ({ ref: ex.ref, lines: ex.lines, start_line: ex.startLine })) ?? [],
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
