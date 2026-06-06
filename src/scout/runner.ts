/**
 * Scout runner for pi-ai-automation-memory.
 *
 * Read-only bounded scanning with strict structured-output validation.
 * No LLM provider calls — deterministic local scanning only.
 */

import * as fs from "node:fs";
import { appendEvidence, type EvidenceRecord } from "../evidence/queue";
import { syncRepo } from "../index/sync";
import { openDb, closeDb } from "../index/db";
import { loadConfig } from "../config/loader";
import { resolvePreset } from "../models/presets";

export interface ScoutFinding {
	claim: string;
	evidenceRefs: string[]; // e.g. ["path/to/file.ts:L12", "path/to/file.ts:L14-L18"]
	confidence: number;
	unknowns: string[];
	category?: string;
	severity?: "info" | "warning" | "error";
}

export interface ScoutRunOptions {
	repoKey: string;
	repoRoot: string;
	presetName?: string;
	maxFilesPerRun?: number;
	maxFindingsPerRun?: number;
	maxTokensPerRun?: number;
	budgetMs?: number;
	appendEvidence?: boolean;
	scanPatterns?: RegExp[];
}

export interface ScoutRunResult {
	didWork: boolean;
	status: "skipped" | "ran" | "error";
	trusted: ScoutFinding[];
	rejected: { finding: unknown; reason: string }[];
	tokensUsed: number;
	elapsedMs: number;
	filesScanned: number;
	message: string;
}

// Simple token estimator: ~4 chars per token for code
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function isLineRef(ref: string): boolean {
	return /^.+:L\d+/.test(ref);
}

function isValidFinding(candidate: unknown): candidate is ScoutFinding {
	if (!candidate || typeof candidate !== "object") return false;
	const f = candidate as Record<string, unknown>;
	if (typeof f.claim !== "string" || f.claim.trim().length === 0) return false;
	if (!Array.isArray(f.evidenceRefs) || f.evidenceRefs.length === 0) return false;
	if (!f.evidenceRefs.every((r) => typeof r === "string" && isLineRef(r))) return false;
	if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) return false;
	if (!Array.isArray(f.unknowns)) return false;
	if (!f.unknowns.every((u) => typeof u === "string")) return false;
	return true;
}

/**
 * Validate raw scout output.
 * Accepts only strict structured JSON/object findings.
 * Rejects strings/prose-heavy output and over-budget output.
 */
export function validateScoutOutput(
	output: unknown,
	options?: { maxFindingsPerRun?: number; maxTokensPerRun?: number },
): {
	trusted: ScoutFinding[];
	rejected: { finding: unknown; reason: string }[];
	tokensUsed: number;
} {
	const trusted: ScoutFinding[] = [];
	const rejected: { finding: unknown; reason: string }[] = [];
	let tokensUsed = 0;

	if (typeof output === "string") {
		rejected.push({ finding: output, reason: "Prose/string output rejected; strict structured JSON required." });
		tokensUsed += estimateTokens(output);
		return { trusted, rejected, tokensUsed };
	}

	let candidates: unknown[] = [];
	if (Array.isArray(output)) {
		candidates = output;
	} else if (output && typeof output === "object") {
		const obj = output as Record<string, unknown>;
		if (Array.isArray(obj.findings)) {
			candidates = obj.findings;
		} else {
			// single object finding
			candidates = [output];
		}
	} else {
		rejected.push({ finding: output, reason: "Output is neither array nor object." });
		return { trusted, rejected, tokensUsed };
	}

	const maxFindings = options?.maxFindingsPerRun ?? 20;
	const maxTokens = options?.maxTokensPerRun ?? 32000;

	for (const cand of candidates.slice(0, maxFindings * 2)) {
		const candTokens = estimateTokens(JSON.stringify(cand));
		if (tokensUsed + candTokens > maxTokens) {
			rejected.push({ finding: cand, reason: `Over token budget (would exceed ${maxTokens}).` });
			continue;
		}
		if (!isValidFinding(cand)) {
			rejected.push({ finding: cand, reason: "Missing required fields: non-empty claim, line evidence refs, confidence in [0,1], unknowns array." });
			continue;
		}
		if (trusted.length >= maxFindings) {
			rejected.push({ finding: cand, reason: `Over max findings limit (${maxFindings}).` });
			continue;
		}
		trusted.push(cand);
		tokensUsed += candTokens;
	}

	return { trusted, rejected, tokensUsed };
}

// Deterministic local scanner: TODO/FIXME/deprecated markers, large stale card markers
const DEFAULT_SCAN_PATTERNS = [
	/TODO[\s:]/i,
	/FIXME[\s:]/i,
	/DEPRECATED[\s:]/i,
	/XXX[\s:]/i,
	/HACK[\s:]/i,
];

function getIndexedFilesFromDb(
	repoKey: string,
	repoRoot: string,
	maxFiles: number,
): Array<{ relativePath: string; absolutePath: string; content: string }> {
	const handle = openDb(repoKey, repoRoot);
	try {
		const rows = handle.db.prepare(
			`SELECT relative_path, absolute_path FROM files
			 WHERE repo_key = ? AND is_deleted = 0 AND is_secret = 0 AND is_generated = 0
			 ORDER BY CASE WHEN language IS NOT NULL AND language != '' THEN 0 ELSE 1 END, relative_path
			 LIMIT ?`
		).all(repoKey, maxFiles) as Array<{ relative_path: string; absolute_path: string }>;

		const result: Array<{ relativePath: string; absolutePath: string; content: string }> = [];
		for (const row of rows) {
			try {
				const stat = fs.statSync(row.absolute_path);
				if (!stat.isFile() || stat.size > 256 * 1024) continue;
				const content = fs.readFileSync(row.absolute_path, "utf-8");
				result.push({
					relativePath: row.relative_path,
					absolutePath: row.absolute_path,
					content,
				});
			} catch {
				// skip unreadable/missing files
			}
		}
		return result;
	} finally {
		closeDb(handle);
	}
}

function deterministicScan(
	files: Array<{ relativePath: string; absolutePath: string; content: string }>,
	patterns: RegExp[],
	maxFindings: number,
	maxTokens: number,
	deadline: number,
): { findings: ScoutFinding[]; filesScanned: number; tokensUsed: number } {
	let tokensUsed = 0;
	const findings: ScoutFinding[] = [];
	let filesScanned = 0;

	for (const file of files) {
		if (Date.now() > deadline) {
			return { findings, filesScanned, tokensUsed };
		}
		filesScanned++;
		const lines = file.content.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			for (const pat of patterns) {
				if (pat.test(line)) {
					const lineNo = i + 1;
					const evidenceRef = `${file.relativePath}:L${lineNo}`;
					const finding: ScoutFinding = {
						claim: `Marker '${line.trim().slice(0, 60)}' found in ${file.relativePath}`,
						evidenceRefs: [evidenceRef],
						confidence: 0.9,
						unknowns: ["severity not assessed", "no fix plan yet"],
						category: "marker_scan",
						severity: "warning",
					};
					const ft = estimateTokens(JSON.stringify(finding));
					if (tokensUsed + ft > maxTokens) {
						return { findings, filesScanned, tokensUsed };
					}
					if (findings.length >= maxFindings) {
						return { findings, filesScanned, tokensUsed };
					}
					findings.push(finding);
					tokensUsed += ft;
					break; // one finding per line max
				}
			}
		}
	}

	return { findings, filesScanned, tokensUsed };
}

/**
 * Run one scout unit.
 *
 * Read-only against repo files/DB except optional evidence queue append.
 * If scouts/preset disabled or model unavailable, returns skipped gracefully.
 * No external LLM provider calls.
 */
export async function runScoutUnit(options: ScoutRunOptions): Promise<ScoutRunResult> {
	const startTime = Date.now();
	const presetName = options.presetName ?? "scout_broad";
	const cfg = loadConfig(options.repoRoot);
	const preset = resolvePreset(presetName, cfg.modelPresets);
	if (preset && !preset.enabled) {
		return {
			didWork: false,
			status: "skipped",
			trusted: [],
			rejected: [],
			tokensUsed: 0,
			elapsedMs: Date.now() - startTime,
			filesScanned: 0,
			message: `Scout preset '${presetName}' is disabled; skipped.`,
		};
	}
	if (!cfg.scouts.enabled) {
		return {
			didWork: false,
			status: "skipped",
			trusted: [],
			rejected: [],
			tokensUsed: 0,
			elapsedMs: Date.now() - startTime,
			filesScanned: 0,
			message: "Scouts are disabled in config; skipped.",
		};
	}

	// Effective budgets: explicit min of options, cfg.scouts, and preset, then clamp
	const effectiveMaxFiles = Math.max(1, Math.min(
		options.maxFilesPerRun ?? Infinity,
		cfg.scouts.maxFilesPerRun,
	));
	const effectiveMaxFindings = Math.max(1, Math.min(
		options.maxFindingsPerRun ?? Infinity,
		cfg.scouts.maxFindingsPerRun,
	));
	const effectiveMaxTokens = Math.max(1000, Math.min(
		options.maxTokensPerRun ?? Infinity,
		cfg.scouts.maxTokensPerRun,
		preset?.budgetTokens ?? Infinity,
	));
	const rawBudgetMs = Math.min(options.budgetMs ?? Infinity, preset?.budgetMs ?? Infinity);
	const effectiveBudgetMs = Math.max(1000, Number.isFinite(rawBudgetMs) ? rawBudgetMs : 60000);
	const deadline = startTime + effectiveBudgetMs;

	// Sync repo to ensure index is current
	let contextVersion = "";
	try {
		const sync = syncRepo(options.repoRoot, options.repoKey, "");
		contextVersion = sync.contextVersion;
	} catch {
		// sync failure is non-fatal; DB may still have usable data
	}

	// Read bounded file list from index (never raw filesystem walk)
	let files: Array<{ relativePath: string; absolutePath: string; content: string }>;
	try {
		files = getIndexedFilesFromDb(options.repoKey, options.repoRoot, effectiveMaxFiles);
	} catch (dbErr: any) {
		return {
			didWork: false,
			status: "error",
			trusted: [],
			rejected: [],
			tokensUsed: 0,
			elapsedMs: Date.now() - startTime,
			filesScanned: 0,
			message: `Scout DB error: ${dbErr?.message ?? String(dbErr)}`,
		};
	}

	if (files.length === 0) {
		return {
			didWork: false,
			status: "skipped",
			trusted: [],
			rejected: [],
			tokensUsed: 0,
			elapsedMs: Date.now() - startTime,
			filesScanned: 0,
			message: "Scout skipped: no indexed non-secret/non-generated files available.",
		};
	}

	try {
		const patterns = options.scanPatterns?.length ? options.scanPatterns : DEFAULT_SCAN_PATTERNS;
		const { findings, filesScanned, tokensUsed: scanTokens } = deterministicScan(
			files,
			patterns,
			effectiveMaxFindings,
			effectiveMaxTokens,
			deadline,
		);

		if (Date.now() > deadline) {
			return {
				didWork: false,
				status: "ran",
				trusted: [],
				rejected: findings.map((f) => ({ finding: f, reason: "Time budget exceeded before validation." })),
				tokensUsed: scanTokens,
				elapsedMs: Date.now() - startTime,
				filesScanned,
				message: `Scout exceeded time budget (${effectiveBudgetMs}ms); no findings trusted.`,
			};
		}

		const validation = validateScoutOutput(findings, {
			maxFindingsPerRun: effectiveMaxFindings,
			maxTokensPerRun: effectiveMaxTokens,
		});

		const elapsedMs = Date.now() - startTime;

		// Optional evidence append
		if (options.appendEvidence && validation.trusted.length > 0) {
			try {
				for (const finding of validation.trusted) {
					const record: EvidenceRecord = {
						repoKey: options.repoKey,
						repoRoot: options.repoRoot,
						contextVersion,
						agentId: presetName,
						agentRole: "scout",
						agentRunId: `scout-${startTime}`,
						taskId: null,
						claim: finding.claim,
						evidenceRefs: finding.evidenceRefs,
						testRefs: [],
						reviewRefs: [],
						confidence: finding.confidence,
						changedFiles: [],
						metadata: {
							category: finding.category,
							severity: finding.severity,
							unknowns: finding.unknowns,
							preset: presetName,
						},
						isStale: 0,
						staleReason: null,
					};
					appendEvidence(
						record,
						cfg.evidenceQueue.maxClaimLength,
						cfg.evidenceQueue.maxMetadataSizeBytes,
						cfg.evidenceQueue.dedupeWindowHours,
					);
				}
			} catch (evErr: any) {
				// Evidence append failure is non-fatal for scout
				if (typeof console !== "undefined" && console.error) {
					console.error("[pi-ai-automation-memory] scout evidence append error:", evErr?.message ?? String(evErr));
				}
			}
		}

		return {
			didWork: validation.trusted.length > 0,
			status: "ran",
			trusted: validation.trusted,
			rejected: validation.rejected,
			tokensUsed: validation.tokensUsed,
			elapsedMs,
			filesScanned,
			message: `Scout ran: ${validation.trusted.length} trusted, ${validation.rejected.length} rejected, ${filesScanned} files scanned.`,
		};
	} catch (err: any) {
		return {
			didWork: false,
			status: "error",
			trusted: [],
			rejected: [],
			tokensUsed: 0,
			elapsedMs: Date.now() - startTime,
			filesScanned: 0,
			message: `Scout error: ${err?.message ?? String(err)}`,
		};
	}
}
