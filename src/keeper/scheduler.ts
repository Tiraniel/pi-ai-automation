/**
 * Hybrid keeper scheduler for pi-ai-automation-memory.
 *
 * Single-writer safety via keeper_leases table.
 * Evidence batches claimed with short-term leases; expired leases are reclaimable.
 * Card generation is deterministic (no LLM/provider yet — TASK-009).
 * Budgeted by maxRunTimeMs and maxTokensPerRun.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, closeDb } from "../index/db";
import {
	claimEvidenceBatch,
	completeEvidenceBatch,
	getPendingEvidenceCount,
	getProcessingEvidenceCount,
	type EvidenceBatchRow,
} from "../evidence/queue";
import { redactText } from "../security/redaction";

const PROCESS_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;

export interface KeeperLease {
	repoKey: string;
	leaseHolder: string;
	leasedAt: number;
	expiresAt: number;
}

export interface KeeperRunOptions {
	repoKey: string;
	repoRoot: string;
	maxRunTimeMs: number;
	maxTokensPerRun: number;
	batchSize: number;
	leaseDurationMs: number;
	contextVersion: string;
	activeAgentCount?: number;
}

export interface KeeperRunResult {
	didWork: boolean;
	message: string;
	cardsGenerated: number;
	evidenceProcessed: number;
	tokensUsed: number;
	elapsedMs: number;
}

function makeLeaseHolder(): string {
	return PROCESS_ID;
}

function nowMs(): number {
	return Date.now();
}

function getActiveAgentCount(options: KeeperRunOptions): number {
	if (typeof options.activeAgentCount === "number" && Number.isFinite(options.activeAgentCount)) {
		return Math.max(1, Math.min(10, Math.floor(options.activeAgentCount)));
	}
	const env = Number(
		process.env.PI_WORKFLOW_ACTIVE_AGENT_COUNT ?? process.env.PI_ACTIVE_AGENT_COUNT ?? 1,
	);
	return Math.max(1, Math.min(10, Number.isFinite(env) ? Math.floor(env) : 1));
}

export interface KeeperPlanInput {
	activeAgentCount: number;
	pendingEvidenceCount: number;
	processingEvidenceCount: number;
	cardBacklogCount: number;
	batchSize: number;
	maxRunTimeMs: number;
}

export interface KeeperPlan {
	run: boolean;
	pressure: "idle" | "normal" | "high";
	effectiveBatchSize: number;
	effectiveMaxRunTimeMs: number;
}

export function planKeeperRun(input: KeeperPlanInput): KeeperPlan {
	const backlog = input.pendingEvidenceCount + input.cardBacklogCount;
	if (backlog <= 0) {
		return {
			run: false,
			pressure: "idle",
			effectiveBatchSize: input.batchSize,
			effectiveMaxRunTimeMs: input.maxRunTimeMs,
		};
	}
	const high =
		input.activeAgentCount >= 4 ||
		backlog >= input.batchSize * 4 ||
		input.processingEvidenceCount >= input.batchSize;
	if (high) {
		return {
			run: true,
			pressure: "high",
			effectiveBatchSize: Math.min(Math.max(input.batchSize * 2, input.batchSize), 50),
			effectiveMaxRunTimeMs: Math.min(input.maxRunTimeMs, 15000),
		};
	}
	return {
		run: true,
		pressure: "normal",
		effectiveBatchSize: input.batchSize,
		effectiveMaxRunTimeMs: input.maxRunTimeMs,
	};
}

/**
 * Check if a keeper lease is currently held and not expired.
 */
export function isLeaseHeld(lease: KeeperLease | null | undefined): boolean {
	if (!lease) return false;
	return lease.expiresAt > nowMs();
}

/**
 * Acquire a keeper lease for a repo.
 * Returns null if another process holds a non-expired lease.
 */
export function acquireLease(
	repoKey: string,
	repoRoot: string,
	leaseDurationMs: number,
): KeeperLease | null {
	const handle = openDb(repoKey, repoRoot);
	const db = handle.db;
	try {
		const now = nowMs();
		const expiresAt = now + leaseDurationMs;
		const leaseHolder = makeLeaseHolder();

		// Upsert: if no row or expired, take it
		const upsert = db.prepare(
			`INSERT INTO keeper_leases (repo_key, lease_holder, leased_at, expires_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(repo_key) DO UPDATE SET
				 lease_holder = excluded.lease_holder,
				 leased_at = excluded.leased_at,
				 expires_at = excluded.expires_at
			 WHERE keeper_leases.expires_at < ? OR keeper_leases.lease_holder IS NULL`
		);
		const result = upsert.run(repoKey, leaseHolder, now, expiresAt, now);

		if ((result.changes ?? 0) === 0) {
			return null;
		}

		return { repoKey, leaseHolder, leasedAt: now, expiresAt };
	} finally {
		closeDb(handle);
	}
}

/**
 * Release a keeper lease.
 */
export function releaseLease(lease: KeeperLease): void {
	const handle = openDb(lease.repoKey, "");
	const db = handle.db;
	try {
		db.prepare(
			`UPDATE keeper_leases SET lease_holder = NULL, leased_at = NULL, expires_at = NULL
			 WHERE repo_key = ? AND lease_holder = ?`
		).run(lease.repoKey, lease.leaseHolder);
	} finally {
		closeDb(handle);
	}
}

/**
 * Refresh an existing lease to extend its TTL.
 */
function refreshLease(lease: KeeperLease, leaseDurationMs: number): KeeperLease {
	const handle = openDb(lease.repoKey, "");
	const db = handle.db;
	try {
		const now = nowMs();
		const expiresAt = now + leaseDurationMs;
		db.prepare(
			`UPDATE keeper_leases SET expires_at = ? WHERE repo_key = ? AND lease_holder = ?`
		).run(expiresAt, lease.repoKey, lease.leaseHolder);
		return { ...lease, expiresAt };
	} finally {
		closeDb(handle);
	}
}

// Rough token estimator: ~4 chars per token for code
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function parseRefsFromEvidence(row: EvidenceBatchRow): string[] {
	const paths: string[] = [];
	try {
		const refs: string[] = JSON.parse(row.evidence_refs ?? "[]");
		for (const r of refs) {
			// Strip line refs like path:Lx-Ly
			const m = r.match(/^([^:]+)/);
			if (m) paths.push(m[1]);
		}
	} catch { /* ignore */ }
	try {
		const changed: string[] = JSON.parse(row.changed_files ?? "[]");
		for (const c of changed) {
			const m = c.match(/^([^:]+)/);
			if (m) paths.push(m[1]);
		}
	} catch { /* ignore */ }
	return [...new Set(paths)];
}

function parseOriginalRefsForFile(
	row: EvidenceBatchRow,
	targetFile: string,
): string[] {
	const refs: string[] = [];
	try {
		const evidenceRefs: string[] = JSON.parse(row.evidence_refs ?? "[]");
		for (const r of evidenceRefs) {
			if (r === targetFile || r.startsWith(targetFile + ":")) {
				refs.push(r);
			}
		}
	} catch { /* ignore */ }
	try {
		const changed: string[] = JSON.parse(row.changed_files ?? "[]");
		for (const c of changed) {
			if (c && !refs.includes(c)) refs.push(c);
		}
	} catch { /* ignore */ }
	return refs;
}

interface FileToCard {
	id: number;
	relative_path: string;
	absolute_path: string;
	content_hash: string;
	card_freshness: string | null;
	language: string | null;
	imports_hash: string | null;
}

interface GeneratedCard {
	fileId: number;
	relativePath: string;
	content: string;
	sourceHash: string;
	contextVersion: string;
	refs: string[];
	excerpts: string[];
	confidence: number;
	workerId: string;
	modelPreset: string;
	tokenBudget: number;
	staleReason: string | null;
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

function generateDeterministicCard(
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

function selectFilesToCard(
	db: { prepare(sql: string): any },
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

function writeCardsAndEvidence(
	db: { prepare(sql: string): any },
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
		cardsWritten += result.changes ?? 0;
	}

	if (evidenceIds.length > 0) {
		const evResult = completeEvidenceBatch(db, repoKey, evidenceIds, true, undefined, evidenceLeaseHolder);
		evidenceProcessed = evResult.completed;
	}

	// Refresh lease after writes
	refreshLease(lease, leaseDurationMs);

	return { cardsWritten, evidenceProcessed };
}

/**
 * Run one unit of keeper work.
 *
 * Flow: acquire lease → claim evidence batch → read DB rows → close DB →
 * generate cards (deterministic, bounded) → reopen DB → write cards + mark evidence → release lease.
 */
export async function runKeeperUnit(options: KeeperRunOptions): Promise<KeeperRunResult> {
	const startTime = nowMs();
	let tokenBudgetRemaining = options.maxTokensPerRun;

	// 1. Acquire lease
	const lease = acquireLease(options.repoKey, options.repoRoot, options.leaseDurationMs);
	if (!lease) {
		return {
			didWork: false,
			message: "Keeper lease held by another process; skipped.",
			cardsGenerated: 0,
			evidenceProcessed: 0,
			tokensUsed: 0,
			elapsedMs: nowMs() - startTime,
		};
	}

	let handle = openDb(options.repoKey, options.repoRoot);
	const db = handle.db;

	try {
		// 2. Plan run based on pressure BEFORE claiming batch
		const activeAgentCount = getActiveAgentCount(options);
		const pendingCount = getPendingEvidenceCount(db, options.repoKey);
		const processingCount = getProcessingEvidenceCount(db, options.repoKey);
		const cardBacklogRow = db.prepare(
			`SELECT COUNT(*) as c FROM files
			 WHERE repo_key = ? AND is_deleted = 0 AND is_secret = 0 AND is_generated = 0
				 AND (card_freshness = 'missing' OR card_freshness = 'stale' OR card_freshness IS NULL)`
		).get(options.repoKey) as { c: number } | undefined;
		const cardBacklogCount = Number(cardBacklogRow?.c ?? 0);

		const plan = planKeeperRun({
			activeAgentCount,
			pendingEvidenceCount: pendingCount,
			processingEvidenceCount: processingCount,
			cardBacklogCount,
			batchSize: options.batchSize,
			maxRunTimeMs: options.maxRunTimeMs,
		});

		if (!plan.run) {
			return {
				didWork: false,
				message: `Keeper idle (pressure=${plan.pressure}, backlog=${pendingCount + cardBacklogCount}).`,
				cardsGenerated: 0,
				evidenceProcessed: 0,
				tokensUsed: 0,
				elapsedMs: nowMs() - startTime,
			};
		}

		const deadline = startTime + plan.effectiveMaxRunTimeMs;

		// 3. Claim evidence batch using effective size
		const batch = claimEvidenceBatch(db, options.repoKey, plan.effectiveBatchSize, options.leaseDurationMs);
		const evidenceRows = batch.claimed;

		// 4. Select files to card using effective size
		const filesToCard = selectFilesToCard(db, options.repoKey, evidenceRows, plan.effectiveBatchSize);

		// 5. Read file data we need before closing DB
		const fileDataForCards = filesToCard.map((f) => ({ ...f }));
		const evidenceDataForCards = evidenceRows.map((e) => ({ ...e }));

		// 6. Close DB before generation
		closeDb(handle);
		handle = null as any;

		// 7. Generate cards deterministically (no LLM / no DB lock)
		const cards: GeneratedCard[] = [];
		const workerId = makeLeaseHolder();
		const modelPreset = "index_keeper";

		for (const file of fileDataForCards) {
			if (nowMs() > deadline) break;
			const card = generateDeterministicCard(
				file,
				evidenceDataForCards,
				options.repoRoot,
				options.contextVersion,
				workerId,
				modelPreset,
				tokenBudgetRemaining,
			);
			if (card.tokenBudget > tokenBudgetRemaining) break;
			tokenBudgetRemaining -= card.tokenBudget;
			cards.push(card);
		}

		// 8. Reopen DB and write
		handle = openDb(options.repoKey, options.repoRoot);
		const db2 = handle.db;

		const { cardsWritten, evidenceProcessed } = writeCardsAndEvidence(
			db2,
			options.repoKey,
			cards,
			evidenceDataForCards.map((e) => e.id),
			lease,
			options.leaseDurationMs,
			batch.leaseHolder,
		);

		// 9. Update last_keeper_run_at
		db2.prepare(
			`UPDATE repo_meta SET last_keeper_run_at = ? WHERE repo_key = ?`
		).run(Date.now(), options.repoKey);

		const elapsed = nowMs() - startTime;

		return {
			didWork: cardsWritten > 0 || evidenceProcessed > 0,
			message: `Keeper processed ${evidenceProcessed} evidence, generated ${cardsWritten} cards (pressure=${plan.pressure}, effectiveBatch=${plan.effectiveBatchSize}).`,
			cardsGenerated: cardsWritten,
			evidenceProcessed,
			tokensUsed: options.maxTokensPerRun - tokenBudgetRemaining,
			elapsedMs: elapsed,
		};
	} catch (err: any) {
		return {
			didWork: false,
			message: `Keeper error: ${err?.message ?? String(err)}`,
			cardsGenerated: 0,
			evidenceProcessed: 0,
			tokensUsed: 0,
			elapsedMs: nowMs() - startTime,
		};
	} finally {
		if (handle) closeDb(handle);
		releaseLease(lease);
	}
}

/**
 * Adaptive schedule: decide whether to run keeper now based on queue pressure.
 * Returns suggested batch size and whether to run.
 */
export function shouldRunKeeper(
	pendingCount: number,
	processingCount: number,
	batchSize: number,
): { run: boolean; suggestedBatchSize: number } {
	const totalActive = pendingCount + processingCount;
	if (totalActive === 0) return { run: false, suggestedBatchSize: batchSize };

	// High pressure: larger batches, but still bounded
	if (totalActive > batchSize * 4) {
		return { run: true, suggestedBatchSize: Math.min(batchSize * 2, 50) };
	}
	// Normal: standard batch
	if (totalActive >= 1) {
		return { run: true, suggestedBatchSize: batchSize };
	}
	return { run: false, suggestedBatchSize: batchSize };
}
