/**
 * Deterministic integrity consultant for pi-ai-automation-memory.
 *
 * - Loads principles from config, project docs, and built-in defaults.
 * - Generates evidence-bound findings from indexed files + evidence queue.
 * - No network/LLM calls. All findings are deterministic and local.
 *
 * This file is the public entry point. It composes the helper modules:
 *   - ./types      — shared interfaces (Principle, Finding, ConsultantParams)
 *   - ./principles — principle loading, persistence, refresh check
 *   - ./smells     — code-smell scan and test-file detection
 *
 * All public symbols and the import surface (`../integrity/consultant`) are
 * preserved for downstream consumers (repo_health_report, validate-repo-memory).
 */

import * as path from "node:path";
import type { SqliteDb } from "../index/db";
import { parseJsonStringArray } from "../util/json";
import type { ConsultantParams, Finding, Principle } from "./types";
import { MAX_SCAN_FILES, TEST_FILE_PATTERNS, scanFileSmells, type SmellMatch } from "./smells";

export type { Principle, Finding, ConsultantParams } from "./types";
export type { SmellMatch } from "./smells";
export { scanFileSmells, TEST_FILE_PATTERNS, MAX_SCAN_FILES } from "./smells";
export {
	loadAllPrinciples,
	persistPrinciples,
	readPrinciplesFromDb,
	findingsNeedRefresh,
} from "./principles";

const SEVERITY_ORDER: Record<string, number> = {
	critical: 0,
	warning: 1,
	info: 2,
	ok: 3,
};

function severityValue(s: string): number {
	return SEVERITY_ORDER[s] ?? 99;
}

function isSeverityAtLeast(severity: string, min: string): boolean {
	return severityValue(severity) <= severityValue(min);
}

/**
 * Generate deterministic findings from DB state and bounded file scans.
 */
export function generateFindings(
	db: SqliteDb,
	repoKey: string,
	repoRoot: string,
	contextVersion: string,
	_principles: Principle[],
	params: ConsultantParams,
): Finding[] {
	const findings: Finding[] = [];
	const now = Date.now();

	// Helper to add a finding
	function add(
		severity: Finding["severity"],
		category: string,
		finding: string,
		fileRefs: string[],
		evidenceRefs: string[],
		confidence: number,
		principleSource: string,
		recommendation: string,
		trusted: boolean,
	) {
		findings.push({
			severity,
			category,
			finding,
			fileRefs,
			evidenceRefs,
			confidence,
			principleSource,
			recommendation,
			generatedAt: now,
			contextVersion,
			rank: 0,
			trusted,
			scope: "global",
			taskRelevance: 0,
		});
	}

	// 1. Stale cards (direct DB evidence)
	const staleCardRows = db.prepare(
		`SELECT relative_path, card_stale_reason FROM files
		 WHERE repo_key = ? AND card_freshness = 'stale' AND is_deleted = 0
		 ORDER BY relative_path`
	).all(repoKey) as Array<{ relative_path: string; card_stale_reason: string | null }>;
	for (const row of staleCardRows.slice(0, 20)) {
		add(
			"warning",
			"doc_freshness",
			`Stale card for ${row.relative_path}${row.card_stale_reason ? " — " + row.card_stale_reason : ""}`,
			[row.relative_path],
			[],
			0.9,
			"index_sync",
			"Regenerate the file card to reflect current content.",
			true,
		);
	}

	// 2. Missing cards (direct DB evidence)
	const missingCardRows = db.prepare(
		`SELECT relative_path FROM files
		 WHERE repo_key = ? AND (card_freshness = 'missing' OR card_freshness IS NULL) AND is_deleted = 0
		 ORDER BY relative_path`
	).all(repoKey) as Array<{ relative_path: string }>;
	if (missingCardRows.length > 0) {
		add(
			"info",
			"doc_freshness",
			`${missingCardRows.length} file(s) missing cards (e.g., ${missingCardRows.slice(0, 5).map((r) => r.relative_path).join(", ")})`,
			missingCardRows.slice(0, 5).map((r) => r.relative_path),
			[],
			0.8,
			"index_sync",
			"Generate file cards for key files to improve context quality.",
			true,
		);
	}

	// 3. Stale evidence (direct DB evidence)
	const staleEvidenceRows = db.prepare(
		`SELECT id, claim, stale_reason FROM evidence
		 WHERE repo_key = ? AND is_stale = 1
		 ORDER BY recorded_at DESC`
	).all(repoKey) as Array<{ id: number; claim: string; stale_reason: string | null }>;
	if (staleEvidenceRows.length > 0) {
		add(
			"warning",
			"architectural_drift",
			`${staleEvidenceRows.length} evidence item(s) are stale${staleEvidenceRows[0].stale_reason ? " — " + staleEvidenceRows[0].stale_reason : ""}`,
			[],
			staleEvidenceRows.slice(0, 5).map((r) => `evidence:${r.id}: ${r.claim.slice(0, 80)}`),
			0.85,
			"evidence_queue",
			"Review or re-record stale evidence against the current codebase.",
			true,
		);
	}

	// 4. Dirty / conflict state from repo_meta
	const metaRow = db.prepare(
		"SELECT is_dirty, has_conflicts FROM repo_meta WHERE repo_key = ?"
	).get(repoKey) as { is_dirty: number; has_conflicts: number } | undefined;
	if (metaRow) {
		if (metaRow.has_conflicts) {
			add(
				"critical",
				"architectural_drift",
				"Merge conflicts detected in working tree.",
				[],
				["git:conflicts"],
				0.95,
				"git_state",
				"Resolve conflicts before making further changes.",
				true,
			);
		}
		if (metaRow.is_dirty) {
			const dirtyFiles = db.prepare(
				`SELECT relative_path FROM files WHERE repo_key = ? AND is_dirty = 1 AND is_deleted = 0 LIMIT 10`
			).all(repoKey) as Array<{ relative_path: string }>;
			const dirtyFileRefs = dirtyFiles.map((r) => r.relative_path);
			add(
				"info",
				"architectural_drift",
				`Working tree has uncommitted changes (${dirtyFiles.length} file(s)).`,
				dirtyFileRefs,
				dirtyFileRefs.length === 0 ? ["git:dirty"] : [],
				0.9,
				"git_state",
				"Commit or stash changes to keep history clean.",
				true,
			);
		}
	}

	// 5. Secret files in index (critical)
	const secretRows = db.prepare(
		`SELECT relative_path FROM files WHERE repo_key = ? AND is_secret = 1 AND is_deleted = 0 LIMIT 10`
	).all(repoKey) as Array<{ relative_path: string }>;
	if (secretRows.length > 0) {
		add(
			"critical",
			"security",
			`Secret-like files detected in index: ${secretRows.map((r) => r.relative_path).join(", ")}`,
			secretRows.map((r) => r.relative_path),
			[],
			0.9,
			"index_scan",
			"Verify these are not real secrets committed to the repo.",
			true,
		);
	}

	// 6. Smell scan: bounded scan of indexed text files
	const scanCandidates = db.prepare(
		`SELECT relative_path, absolute_path, language, size_bytes FROM files
		 WHERE repo_key = ? AND is_deleted = 0 AND is_secret = 0 AND is_generated = 0
		   AND language IS NOT NULL
		 ORDER BY size_bytes ASC
		 LIMIT ?`
	).all(repoKey, MAX_SCAN_FILES) as Array<{ relative_path: string; absolute_path: string; language: string; size_bytes: number }>;

	const smellMap = new Map<string, Array<SmellMatch>>();
	for (const file of scanCandidates) {
		const smells = scanFileSmells(file.absolute_path, file.relative_path);
		if (smells.length > 0) {
			smellMap.set(file.relative_path, smells);
		}
	}

	for (const [relPath, smells] of smellMap) {
		const labels = [...new Set(smells.map((s) => s.label))];
		const lines = smells.slice(0, 3).map((s) => `L${s.line}`).join(", ");
		add(
			smells.some((s) => s.severity === "warning") ? "warning" : "info",
			"architectural_drift",
			`${relPath} contains ${labels.join("/")} markers (${lines})`,
			[relPath],
			[],
			0.7,
			"smell_scan",
			`Address ${labels.join("/")} items to reduce technical debt.`,
			true,
		);
	}

	// 7. Test coverage heuristic (inferred, low confidence)
	const allSourceRows = db.prepare(
		`SELECT relative_path, language FROM files WHERE repo_key = ? AND is_deleted = 0 AND is_generated = 0 AND is_secret = 0`
	).all(repoKey) as Array<{ relative_path: string; language: string | null }>;
	const testFiles = allSourceRows.filter((r) => TEST_FILE_PATTERNS.some((p) => p.test(r.relative_path)));
	const sourceFiles = allSourceRows.filter((r) => {
		if (!r.language) return false;
		return ["typescript", "javascript", "python", "rust", "go", "java", "kotlin", "ruby", "php", "csharp"].includes(r.language);
	});
	if (sourceFiles.length > 0 && testFiles.length === 0) {
		const noTestFileRefs = sourceFiles.slice(0, 10).map((r) => r.relative_path);
		add(
			"info",
			"test_coverage",
			`No test files found among ${sourceFiles.length} source file(s).`,
			noTestFileRefs,
			[],
			0.3,
			"builtin",
			"Consider adding tests for key modules.",
			noTestFileRefs.length > 0,
		);
	}

	// 8. Type safety heuristic (inferred, low confidence)
	const hasTsFiles = allSourceRows.some((r) => r.language === "typescript" || r.language === "tsx");
	const hasTsConfig = allSourceRows.some((r) => r.relative_path === "tsconfig.json" || r.relative_path.endsWith("/tsconfig.json"));
	if (hasTsFiles && !hasTsConfig) {
		const tsFileRefs = allSourceRows
			.filter((r) => r.language === "typescript" || r.language === "tsx")
			.slice(0, 10)
			.map((r) => r.relative_path);
		add(
			"info",
			"type_safety",
			"TypeScript source files found but no tsconfig.json detected.",
			tsFileRefs,
			[],
			0.3,
			"builtin",
			"Add a tsconfig.json to enable type-checking.",
			tsFileRefs.length > 0,
		);
	}

	// 9. Doc freshness heuristic
	const hasReadme = allSourceRows.some((r) => /^readme\.md$/i.test(path.basename(r.relative_path)));
	if (!hasReadme && allSourceRows.length > 5) {
		const readmeFileRefs = allSourceRows.slice(0, 10).map((r) => r.relative_path);
		add(
			"info",
			"doc_freshness",
			"No README.md found in the repo.",
			readmeFileRefs,
			[],
			0.3,
			"builtin",
			"Add a README.md to document the project.",
			readmeFileRefs.length > 0,
		);
	}

	// Task scoping: compute task relevance for each finding
	if (params.taskFiles && params.taskFiles.length > 0) {
		const taskSet = new Set(params.taskFiles.map((f) => f.replace(/\\/g, "/")));
		for (const f of findings) {
			let relevance = 0;
			for (const ref of f.fileRefs) {
				if (taskSet.has(ref)) relevance = 1;
				// Also match parent directories
				for (const taskFile of taskSet) {
					if (taskFile.startsWith(ref + "/") || ref.startsWith(taskFile + "/")) {
						relevance = Math.max(relevance, 0.5);
					}
				}
			}
			f.taskRelevance = relevance;
			f.scope = relevance > 0 ? "task" : "global";
		}
	}

	// Task query: boost relevance for path/category matches
	if (params.taskQuery) {
		const q = params.taskQuery.toLowerCase();
		for (const f of findings) {
			if (f.category.toLowerCase().includes(q)) f.taskRelevance = Math.max(f.taskRelevance, 0.4);
			if (f.finding.toLowerCase().includes(q)) f.taskRelevance = Math.max(f.taskRelevance, 0.4);
			for (const ref of f.fileRefs) {
				if (ref.toLowerCase().includes(q)) f.taskRelevance = Math.max(f.taskRelevance, 0.6);
			}
		}
	}

	return findings;
}

/**
 * Rank findings deterministically.
 * Order: severity asc, taskRelevance desc, confidence desc, support desc, recency desc.
 */
export function rankFindings(findings: Finding[], params: ConsultantParams): Finding[] {
	const filtered = findings.filter((f) => {
		if (!isSeverityAtLeast(f.severity, params.minSeverity)) return false;
		if (params.categories && params.categories.length > 0) {
			if (!params.categories.includes(f.category)) return false;
		}
		return true;
	});

	filtered.sort((a, b) => {
		const sevDiff = severityValue(a.severity) - severityValue(b.severity);
		if (sevDiff !== 0) return sevDiff;
		const relDiff = b.taskRelevance - a.taskRelevance;
		if (relDiff !== 0) return relDiff;
		const confDiff = b.confidence - a.confidence;
		if (confDiff !== 0) return confDiff;
		const supportDiff = (b.fileRefs.length + b.evidenceRefs.length) - (a.fileRefs.length + a.evidenceRefs.length);
		if (supportDiff !== 0) return supportDiff;
		return b.generatedAt - a.generatedAt;
	});

	// Assign rank
	for (let i = 0; i < filtered.length; i++) {
		filtered[i].rank = i + 1;
	}

	return filtered.slice(0, params.maxFindings);
}

/**
 * Persist findings to health_findings table.
 */
export function persistFindings(
	db: SqliteDb,
	repoKey: string,
	contextVersion: string,
	findings: Finding[],
): void {
	// Clear old findings for this repo_key to avoid accumulation
	try {
		db.prepare("DELETE FROM health_findings WHERE repo_key = ?").run(repoKey);
	} catch {
		// ignore
	}

	const insertStmt = db.prepare(
		`INSERT INTO health_findings
		 (repo_key, generated_at, context_version, severity, category, finding,
		  evidence_refs, file_refs, rank, confidence, recommendation, principle_source,
		  scope, task_relevance, trusted)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);

	for (const f of findings) {
		insertStmt.run(
			repoKey,
			f.generatedAt,
			contextVersion,
			f.severity,
			f.category,
			f.finding,
			JSON.stringify(f.evidenceRefs),
			JSON.stringify(f.fileRefs),
			f.rank,
			f.confidence,
			f.recommendation,
			f.principleSource,
			f.scope,
			f.taskRelevance,
			f.trusted ? 1 : 0,
		);
	}
}

/**
 * Read findings from DB, filtering by params.
 */
export function readFindingsFromDb(
	db: SqliteDb,
	repoKey: string,
	params: ConsultantParams,
): Finding[] {
	const rows = db.prepare(
		`SELECT id, generated_at, context_version, severity, category, finding,
			evidence_refs, file_refs, rank, confidence, recommendation, principle_source,
			scope, task_relevance, trusted
		 FROM health_findings
		 WHERE repo_key = ?
		 ORDER BY rank ASC, severity ASC, confidence DESC`
	).all(repoKey) as Array<{
		id: number;
		generated_at: number;
		context_version: string;
		severity: string;
		category: string;
		finding: string;
		evidence_refs: string;
		file_refs: string;
		rank: number;
		confidence: number;
		recommendation: string;
		principle_source: string;
		scope: string;
		task_relevance: number;
		trusted: number;
	}>;

	const findings: Finding[] = [];
	for (const r of rows) {
		const evidenceRefs = parseJsonStringArray(r.evidence_refs);
		const fileRefs = parseJsonStringArray(r.file_refs);
		const f: Finding = {
			id: r.id,
			severity: r.severity as Finding["severity"],
			category: r.category,
			finding: r.finding,
			evidenceRefs,
			fileRefs,
			confidence: r.confidence,
			principleSource: r.principle_source,
			recommendation: r.recommendation,
			generatedAt: r.generated_at,
			contextVersion: r.context_version,
			rank: r.rank,
			trusted: Boolean(r.trusted),
			scope: r.scope as "global" | "task",
			taskRelevance: r.task_relevance,
		};
		findings.push(f);
	}

	return rankFindings(findings, params);
}
