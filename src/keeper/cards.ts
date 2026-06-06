/**
 * Card/evidence helper logic for the keeper scheduler.
 *
 * Behavior-preserving extraction from src/keeper/scheduler.ts. Card content,
 * redaction, related evidence/ref bounding, file selection ordering, card
 * write SQL, evidence completion behavior, and lease refresh behavior are all
 * preserved. The scheduler orchestrates these helpers from runKeeperUnit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sqliteChanges, type SqliteDb } from "../index/db";
import { completeEvidenceBatch, type EvidenceBatchRow } from "../evidence/queue";
import { redactText } from "../security/redaction";
import { parseJsonStringArray } from "../util/json";
import { refreshLease } from "./leases";
import type { FileToCard, GeneratedCard, KeeperLease } from "./types";

// Rough token estimator: ~4 chars per token for code
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function parseRefsFromEvidence(row: EvidenceBatchRow): string[] {
	const paths: string[] = [];
	for (const r of parseJsonStringArray(row.evidence_refs)) {
		const m = r.match(/^([^:]+)/);
		if (m) paths.push(m[1]);
	}
	for (const c of parseJsonStringArray(row.changed_files)) {
		const m = c.match(/^([^:]+)/);
		if (m) paths.push(m[1]);
	}
	return [...new Set(paths)];
}

function parseOriginalRefsForFile(
	row: EvidenceBatchRow,
	targetFile: string,
): string[] {
	const refs: string[] = [];
	for (const r of parseJsonStringArray(row.evidence_refs)) {
		if (r === targetFile || r.startsWith(targetFile + ":")) {
			refs.push(r);
		}
	}
	for (const c of parseJsonStringArray(row.changed_files)) {
		if (c && !refs.includes(c)) refs.push(c);
	}
	return refs;
}

function readFileExcerpt(absPath: string, maxLines: number): string[] {
	try {
		const stats = fs.statSync(absPath);
		if (!stats.isFile() || stats.size > 256 * 1024) return [];
		const content = fs.readFileSync(absPath, "utf-8");
		const lines = content.split(/\r?\n/);
		return lines.slice(0, maxLines);
	} catch {
		return [];
	}
}

export function generateDeterministicCard(
	file: FileToCard,
	evidenceRows: EvidenceBatchRow[],
	repoRoot: string,
	contextVersion: string,
	workerId: string,
	modelPreset: string,
	tokenBudget: number,
): GeneratedCard {
	const absPath = path.join(repoRoot, file.relative_path);
	const excerptLines = readFileExcerpt(absPath, 12);
	const redactedExcerpt = excerptLines.map((l) => redactText(l).text);

	// Collect related evidence claims and original refs for this file
	const relatedClaims: string[] = [];
	const allRefs: string[] = [];
	for (const ev of evidenceRows) {
		const refs = parseRefsFromEvidence(ev);
		if (refs.includes(file.relative_path)) {
			relatedClaims.push(`- ${ev.agent_id}: ${ev.claim.slice(0, 120)}`);
			const originalRefs = parseOriginalRefsForFile(ev, file.relative_path);
			for (const r of originalRefs) {
				if (!allRefs.includes(r)) allRefs.push(r);
			}
		}
	}
	// Bound refs to avoid oversized cards
	const boundedRefs = allRefs.slice(0, 20);

	const lines: string[] = [];
	lines.push(`## File: ${file.relative_path}`);
	lines.push(`- language: ${file.language ?? "unknown"}`);
	lines.push(`- content_hash: ${file.content_hash.slice(0, 12)}`);
	if (file.imports_hash) {
		lines.push(`- imports_hash: ${file.imports_hash.slice(0, 12)}`);
	}
	if (relatedClaims.length > 0) {
		lines.push("- related_evidence:");
		for (const c of relatedClaims.slice(0, 5)) lines.push(`  ${c}`);
	}
	if (boundedRefs.length > 0) {
		lines.push("- related_refs:");
		for (const r of boundedRefs) lines.push(`  - ${r}`);
	}
	lines.push("- excerpt:");
	lines.push("  ```");
	for (const l of redactedExcerpt.slice(0, 10)) lines.push(`  ${l}`);
	if (redactedExcerpt.length > 10) lines.push("  …");
	lines.push("  ```");

	const content = lines.join("\n");

	return {
		fileId: file.id,
		relativePath: file.relative_path,
		content,
		sourceHash: file.content_hash,
		contextVersion,
		refs: boundedRefs.length > 0 ? boundedRefs : [],
		excerpts: redactedExcerpt.slice(0, 20),
		confidence: 0.75,
		workerId,
		modelPreset,
		tokenBudget: estimateTokens(content),
		staleReason: null,
	};
}

export function selectFilesToCard(
	db: SqliteDb,
	repoKey: string,
	evidenceRows: EvidenceBatchRow[],
	batchSize: number,
): FileToCard[] {
	// First: files referenced by evidence
	const evidencePaths = new Set<string>();
	for (const ev of evidenceRows) {
		for (const p of parseRefsFromEvidence(ev)) {
			evidencePaths.add(p);
		}
	}

	const files: FileToCard[] = [];
	const seen = new Set<number>();

	if (evidencePaths.size > 0) {
		const placeholders = Array.from(evidencePaths).map(() => "?").join(",");
		const rows = db.prepare(
			`SELECT id, relative_path, absolute_path, content_hash, card_freshness, language, imports_hash
			 FROM files
			 WHERE repo_key = ? AND relative_path IN (${placeholders})
				 AND is_deleted = 0 AND is_secret = 0 AND is_generated = 0
			 ORDER BY CASE card_freshness WHEN 'missing' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END`
		).all(repoKey, ...Array.from(evidencePaths)) as FileToCard[];
		for (const r of rows) {
			if (!seen.has(r.id)) {
				files.push(r);
				seen.add(r.id);
			}
		}
	}

	// Fill remaining budget with missing/stale cards
	const remaining = Math.max(0, batchSize - files.length);
	if (remaining > 0) {
		const extra = db.prepare(
			`SELECT id, relative_path, absolute_path, content_hash, card_freshness, language, imports_hash
			 FROM files
			 WHERE repo_key = ? AND is_deleted = 0 AND is_secret = 0 AND is_generated = 0
				 AND (card_freshness = 'missing' OR card_freshness = 'stale' OR card_freshness IS NULL)
				 AND id NOT IN (${seen.size > 0 ? Array.from(seen).map(() => "?").join(",") : "NULL"})
			 ORDER BY CASE card_freshness WHEN 'missing' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END,
				 last_indexed_at DESC
			 LIMIT ?`
		).all(repoKey, ...Array.from(seen), remaining) as FileToCard[];
		for (const r of extra) {
			if (!seen.has(r.id)) {
				files.push(r);
				seen.add(r.id);
			}
		}
	}

	return files;
}

export function writeCardsAndEvidence(
	db: SqliteDb,
	repoKey: string,
	cards: GeneratedCard[],
	evidenceIds: number[],
	lease: KeeperLease,
	leaseDurationMs: number,
	evidenceLeaseHolder?: string,
): { cardsWritten: number; evidenceProcessed: number } {
	let cardsWritten = 0;
	let evidenceProcessed = 0;

	for (const card of cards) {
		const stmt = db.prepare(
			`UPDATE files SET
				card_freshness = 'fresh',
				card_content = ?,
				card_generated_at = ?,
				card_model_preset = ?,
				card_token_budget = ?,
				card_source_hash = ?,
				card_context_version = ?,
				card_refs = ?,
				card_excerpts = ?,
				card_confidence = ?,
				card_worker_id = ?,
				card_metadata = ?,
				card_stale_reason = NULL
			 WHERE repo_key = ? AND id = ?`
		);
		const result = stmt.run(
			card.content,
			Date.now(),
			card.modelPreset,
			card.tokenBudget,
			card.sourceHash,
			card.contextVersion,
			JSON.stringify(card.refs),
			JSON.stringify(card.excerpts),
			card.confidence,
			card.workerId,
			JSON.stringify({ generatedBy: "keeper", version: "TASK-006" }),
			repoKey,
			card.fileId,
		);
		cardsWritten += sqliteChanges(result);
	}

	if (evidenceIds.length > 0) {
		const evResult = completeEvidenceBatch(db, repoKey, evidenceIds, true, undefined, evidenceLeaseHolder);
		evidenceProcessed = evResult.completed;
	}

	// Refresh lease after writes
	refreshLease(lease, leaseDurationMs);

	return { cardsWritten, evidenceProcessed };
}
