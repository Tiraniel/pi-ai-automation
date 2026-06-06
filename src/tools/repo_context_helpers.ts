/**
 * repo_context tool — pure ranking, excerpt, and token helpers.
 *
 * Extracted from repo_context.ts to keep that file under the 500 LOC budget.
 * All helpers are deterministic and free of DB / extension state, so they
 * can be unit-tested and reused by other repo tools if needed.
 */

import * as fs from "node:fs";

export interface FileRecord {
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

export interface ImportRow {
	relative_path: string;
	import_path: string;
}

export interface EvidenceRow {
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

export function rankFiles(
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

export function shortHash(hash: string): string {
	return hash.slice(0, 12);
}

interface Excerpt {
	ref: string;
	lines: string[];
	startLine: number;
}

export function readExcerptsSmart(
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

export function estimateTokens(text: string): number {
	// Very rough: ~4 chars per token on average for code
	return Math.ceil(text.length / 4);
}

export function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}
