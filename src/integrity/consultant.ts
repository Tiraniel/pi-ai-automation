/**
 * Deterministic integrity consultant for pi-ai-automation-memory.
 *
 * - Loads principles from config, project docs, and built-in defaults.
 * - Generates evidence-bound findings from indexed files + evidence queue.
 * - No network/LLM calls. All findings are deterministic and local.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/loader";
import type { RepoMemoryConfig } from "../config/loader";

export interface Principle {
	category: string | null;
	text: string;
	source: string;
	confidence: number;
	configRef: string | null;
}

export interface Finding {
	id?: number;
	severity: "critical" | "warning" | "info" | "ok";
	category: string;
	finding: string;
	evidenceRefs: string[];
	fileRefs: string[];
	confidence: number;
	principleSource: string;
	recommendation: string;
	generatedAt: number;
	contextVersion: string;
	rank: number;
	trusted: boolean;
	scope: "global" | "task";
	taskRelevance: number;
}

export interface ConsultantParams {
	maxFindings: number;
	categories: string[] | null;
	minSeverity: "critical" | "warning" | "info" | "ok";
	forceRefresh: boolean;
	taskId: string | null;
	taskFiles: string[] | null;
	taskQuery: string | null;
	includeGantt: boolean;
}

const SEVERITY_ORDER: Record<string, number> = {
	critical: 0,
	warning: 1,
	info: 2,
	ok: 3,
};

const BUILTIN_PRINCIPLES: Principle[] = [
	{ category: "test_coverage", text: "Code should have automated tests", source: "builtin", confidence: 0.3, configRef: null },
	{ category: "type_safety", text: "Typed projects should have type-checking configuration", source: "builtin", confidence: 0.3, configRef: null },
	{ category: "doc_freshness", text: "README and key docs should exist and be current", source: "builtin", confidence: 0.3, configRef: null },
	{ category: "dependency_risk", text: "Lockfiles should be present and not stale", source: "builtin", confidence: 0.3, configRef: null },
	{ category: "architectural_drift", text: "Project structure should follow declared conventions", source: "builtin", confidence: 0.3, configRef: null },
	{ category: "security", text: "Secrets should not be committed", source: "builtin", confidence: 0.5, configRef: null },
];

const SMELL_PATTERNS = [
	{ regex: /\bTODO\b/gi, category: "architectural_drift", severity: "info" as const, label: "TODO" },
	{ regex: /\bFIXME\b/gi, category: "architectural_drift", severity: "warning" as const, label: "FIXME" },
	{ regex: /\bHACK\b/gi, category: "architectural_drift", severity: "warning" as const, label: "HACK" },
	{ regex: /\bXXX\b/gi, category: "architectural_drift", severity: "info" as const, label: "XXX" },
	{ regex: /\bBUG\b/gi, category: "architectural_drift", severity: "warning" as const, label: "BUG" },
	{ regex: /\bDEPRECATED\b/gi, category: "architectural_drift", severity: "warning" as const, label: "DEPRECATED" },
	{ regex: /\bLEGACY\b/gi, category: "architectural_drift", severity: "info" as const, label: "LEGACY" },
	{ regex: /\bSMELL\b/gi, category: "architectural_drift", severity: "warning" as const, label: "SMELL" },
];

const TEST_FILE_PATTERNS = [
	/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|cs)$/i,
	/__tests__/i,
	/test_/i,
];

const MAX_SCAN_BYTES = 100_000;
const MAX_SCAN_FILES = 200;
const MAX_MATCHES_PER_FILE = 20;

function severityValue(s: string): number {
	return SEVERITY_ORDER[s] ?? 99;
}

function isSeverityAtLeast(severity: string, min: string): boolean {
	return severityValue(severity) <= severityValue(min);
}

/**
 * Load explicit principles from .pi/repo-memory.json integrity.principles.
 */
function loadExplicitPrinciples(cfg: RepoMemoryConfig): Principle[] {
	const principles: Principle[] = [];
	for (const text of cfg.integrity.principles) {
		principles.push({
			category: null,
			text,
			source: "config",
			confidence: 1.0,
			configRef: ".pi/repo-memory.json",
		});
	}
	return principles;
}

/**
 * Infer principles from AGENTS.md / Agents.md / CLAUDE.md / README.md.
 * Cheap heuristic: look for principle-like bullet lines.
 */
function inferPrinciplesFromDocs(repoRoot: string): Principle[] {
	const candidates = ["AGENTS.md", "Agents.md", "CLAUDE.md", "README.md", "ARCHITECTURE.md", "architecture.md"];
	const principles: Principle[] = [];
	for (const name of candidates) {
		const absPath = path.join(repoRoot, name);
		if (!fs.existsSync(absPath)) continue;
		try {
			const content = fs.readFileSync(absPath, "utf-8");
			const lines = content.split(/\r?\n/);
			for (const line of lines) {
				const trimmed = line.trim();
				// Match bullet lines that look like principles
				if (/^[-*]\s*(principle|rule|convention|guideline|must|should|avoid|prefer)\b/i.test(trimmed)) {
					const text = trimmed.replace(/^[-*]\s*/, "").slice(0, 500);
					if (text.length > 10) {
						principles.push({
							category: null,
							text,
							source: `inferred:${name}`,
							confidence: 0.5,
							configRef: name,
						});
					}
				}
			}
		} catch {
			// ignore read errors
		}
	}
	return principles;
}

/**
 * Load all principles: explicit config + inferred docs + built-in defaults.
 */
export function loadAllPrinciples(repoRoot: string): Principle[] {
	const cfg = loadConfig(repoRoot);
	const explicit = loadExplicitPrinciples(cfg);
	const inferred = inferPrinciplesFromDocs(repoRoot);
	// Deduplicate by text (case-insensitive)
	const seen = new Set<string>();
	const out: Principle[] = [];
	for (const p of [...explicit, ...inferred, ...BUILTIN_PRINCIPLES]) {
		const key = p.text.toLowerCase().trim();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(p);
	}
	return out;
}

/**
 * Persist principles to the integrity_principles table.
 */
export function persistPrinciples(
	db: { prepare(sql: string): any },
	repoKey: string,
	principles: Principle[],
): void {
	const now = Date.now();
	const insertStmt = db.prepare(
		`INSERT OR REPLACE INTO integrity_principles
		 (repo_key, category, principle, source, confidence, config_ref, inferred, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	for (const p of principles) {
		insertStmt.run(repoKey, p.category, p.text, p.source, p.confidence, p.configRef, p.source.startsWith("inferred:") ? 1 : 0, now);
	}
}

/**
 * Read principles from DB.
 */
export function readPrinciplesFromDb(
	db: { prepare(sql: string): any },
	repoKey: string,
): Principle[] {
	try {
		const rows = db.prepare(
			"SELECT category, principle, source, confidence, config_ref FROM integrity_principles WHERE repo_key = ?"
		).all(repoKey) as Array<{ category: string | null; principle: string; source: string; confidence: number; config_ref: string | null }>;
		return rows.map((r) => ({
			category: r.category,
			text: r.principle,
			source: r.source,
			confidence: r.confidence,
			configRef: r.config_ref,
		}));
	} catch {
		return [];
	}
}

/**
 * Check whether findings need regeneration.
 */
export function findingsNeedRefresh(
	db: { prepare(sql: string): any },
	repoKey: string,
	contextVersion: string,
	maxAgeMs: number,
	forceRefresh: boolean,
): boolean {
	if (forceRefresh) return true;
	try {
		const row = db.prepare(
			"SELECT MAX(generated_at) as max_at, MAX(context_version) as max_cv FROM health_findings WHERE repo_key = ?"
		).get(repoKey) as { max_at: number | null; max_cv: string | null } | undefined;
		if (!row || row.max_at === null) return true;
		if (row.max_cv !== contextVersion) return true;
		if (Date.now() - row.max_at > maxAgeMs) return true;
		return false;
	} catch {
		return true;
	}
}

/**
 * Scan a single file for smell patterns. Bounded.
 */
function scanFileSmells(absPath: string, _relPath: string): Array<{
	line: number;
	label: string;
	category: string;
	severity: "warning" | "info";
	lineText: string;
}> {
	const results: ReturnType<typeof scanFileSmells> = [];
	let content: string;
	try {
		const stat = fs.statSync(absPath);
		if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return results;
		content = fs.readFileSync(absPath, "utf-8");
	} catch {
		return results;
	}
	const lines = content.split(/\r?\n/);
	let totalMatches = 0;
	for (let i = 0; i < lines.length; i++) {
		if (totalMatches >= MAX_MATCHES_PER_FILE) break;
		const lineText = lines[i];
		for (const pat of SMELL_PATTERNS) {
			pat.regex.lastIndex = 0;
			if (pat.regex.test(lineText)) {
				results.push({
					line: i + 1,
					label: pat.label,
					category: pat.category,
					severity: pat.severity,
					lineText: lineText.trim().slice(0, 200),
				});
				totalMatches++;
				break; // one match per line max
			}
		}
	}
	return results;
}

/**
 * Generate deterministic findings from DB state and bounded file scans.
 */
export function generateFindings(
	db: { prepare(sql: string): any },
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

	const smellMap = new Map<string, Array<{ line: number; label: string; lineText: string }>>();
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
	db: { prepare(sql: string): any },
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
	db: { prepare(sql: string): any },
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
		let evidenceRefs: string[] = [];
		let fileRefs: string[] = [];
		try {
			evidenceRefs = JSON.parse(r.evidence_refs) as string[];
		} catch {
			evidenceRefs = [];
		}
		try {
			fileRefs = JSON.parse(r.file_refs) as string[];
		} catch {
			fileRefs = [];
		}
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
