/**
 * Principle loading and persistence for the integrity consultant.
 *
 * - Loads principles from explicit config, inferred docs, and built-in defaults.
 * - Persists/reads them through the integrity_principles table.
 * - Decides whether cached findings need regeneration.
 *
 * Extracted from consultant.ts to keep each module under the project 500-LOC
 * budget. All behavior, fields, and ordering are preserved.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/loader";
import type { RepoMemoryConfig } from "../config/loader";
import type { SqliteDb } from "../index/db";
import type { Principle } from "./types";

const BUILTIN_PRINCIPLES: Principle[] = [
	{ category: "test_coverage", text: "Code should have automated tests", source: "builtin", confidence: 0.3, configRef: null },
	{ category: "type_safety", text: "Typed projects should have type-checking configuration", source: "builtin", confidence: 0.3, configRef: null },
	{ category: "doc_freshness", text: "README and key docs should exist and be current", source: "builtin", confidence: 0.3, configRef: null },
	{ category: "dependency_risk", text: "Lockfiles should be present and not stale", source: "builtin", confidence: 0.3, configRef: null },
	{ category: "architectural_drift", text: "Project structure should follow declared conventions", source: "builtin", confidence: 0.3, configRef: null },
	{ category: "security", text: "Secrets should not be committed", source: "builtin", confidence: 0.5, configRef: null },
];

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
	db: SqliteDb,
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
	db: SqliteDb,
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
	db: SqliteDb,
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
