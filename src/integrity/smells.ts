/**
 * Smell/test-pattern scanning helpers for the integrity consultant.
 *
 * - Constants for code-smell regexes, test file detection, and scan bounds.
 * - `scanFileSmells` reads a single bounded file and returns detected matches.
 * - The test-file patterns and the per-run file cap are exported because
 *   `consultant.ts` (finding generation) needs them; everything else stays
 *   module-private.
 *
 * Extracted from consultant.ts to keep each module under the project 500-LOC
 * budget. All behavior, scan bounds, and ordering are preserved.
 */

import * as fs from "node:fs";

/**
 * A single smell match from scanFileSmells.
 */
export type SmellMatch = {
	line: number;
	label: string;
	category: string;
	severity: "warning" | "info";
	lineText: string;
};

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

export const TEST_FILE_PATTERNS = [
	/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|cs)$/i,
	/__tests__/i,
	/test_/i,
];

const MAX_SCAN_BYTES = 100_000;
export const MAX_SCAN_FILES = 200;
const MAX_MATCHES_PER_FILE = 20;

/**
 * Scan a single file for smell patterns. Bounded.
 */
export function scanFileSmells(absPath: string, _relPath: string): Array<SmellMatch> {
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
