/**
 * Append-only evidence queue implementation.
 *
 * - Deterministic dedupe via INSERT OR IGNORE on (repo_key, dedupe_key).
 * - Stale marking for old context_version or file hash mismatches.
 * - Bounded claim/metadata lengths enforced before insert.
 * - All stored values are redacted before insertion.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import { redactText, redactStrings, redactMetadata } from "../security/redaction";
import { openDb, closeDb } from "../index/db";

type SqliteDb = { prepare(sql: string): any };

export interface EvidenceRecord {
	repoKey: string;
	repoRoot: string;
	contextVersion: string;
	agentId: string;
	agentRole: string;
	agentRunId: string;
	taskId: string | null;
	claim: string;
	evidenceRefs: string[];
	testRefs: string[];
	reviewRefs: string[];
	confidence: number;
	changedFiles: string[];
	metadata: Record<string, unknown> | null;
	isStale: number;
	staleReason: string | null;
}

export interface EvidenceInsertResult {
	recorded: boolean;
	deduplicated: boolean;
	id: number | null;
	contextVersion: string;
	recordedAt: number;
	staleWarning: boolean;
	staleReason: string | null;
	redacted: boolean;
	queueCounts: EvidenceQueueCounts;
}

export interface EvidenceQueueCounts {
	totalEvidence: number;
	staleEvidence: number;
	pendingEvidence: number;
}

function normalizeClaim(claim: string): string {
	return claim.trim().toLowerCase().replace(/\s+/g, " ");
}

function computeDedupeKey(
	repoKey: string,
	agentId: string,
	claim: string,
	recordedAt: number,
	dedupeWindowHours: number,
): string {
	const bucketMs = Math.max(1, dedupeWindowHours) * 60 * 60 * 1000;
	const bucket = Math.floor(recordedAt / bucketMs);
	const normalized = normalizeClaim(claim);
	const hash = crypto.createHash("sha256").update(`${repoKey}\0${agentId}\0${normalized}\0${bucket}`).digest("base64url").slice(0, 32);
	return hash;
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function toJsonArray(arr: string[]): string {
	return JSON.stringify(arr);
}

function toJsonObject(obj: Record<string, unknown> | null): string {
	return JSON.stringify(obj ?? {});
}

/**
 * Build a snapshot of file hashes for referenced/changed files.
 * Returns a JSON string mapping relative_path -> content_hash for files found in DB.
 */
function buildFileHashSnapshot(
	db: SqliteDb,
	repoKey: string,
	paths: string[],
): string {
	const snapshot: Record<string, string> = {};
	try {
		const stmt = db.prepare("SELECT relative_path, content_hash FROM files WHERE repo_key = ? AND relative_path = ? AND is_deleted = 0");
		for (const p of paths) {
			const row = stmt.get(repoKey, p) as { relative_path: string; content_hash: string } | undefined;
			if (row) {
				snapshot[row.relative_path] = row.content_hash;
			}
		}
	} catch {
		// ignore
	}
	return JSON.stringify(snapshot);
}

/**
 * Insert evidence into the queue. Returns result with dedupe/stale/redaction info.
 *
 * Opens and closes its own DB connection to keep the call self-contained.
 */
export function appendEvidence(
	record: EvidenceRecord,
	maxClaimLength: number,
	maxMetadataSizeBytes: number,
	dedupeWindowHours: number,
): EvidenceInsertResult {
	const recordedAt = Date.now();
	const handle = openDb(record.repoKey, record.repoRoot);
	const db = handle.db;

	try {
		// Redact all text fields
		const claimRedacted = redactText(record.claim.slice(0, maxClaimLength));
		const evidenceRefsRedacted = redactStrings(record.evidenceRefs);
		const testRefsRedacted = redactStrings(record.testRefs);
		const reviewRefsRedacted = redactStrings(record.reviewRefs);
		const changedFilesRedacted = redactStrings(record.changedFiles);
		const metadataRedacted = redactMetadata(record.metadata);

		const claim = claimRedacted.text;
		const evidenceRefs = toJsonArray(evidenceRefsRedacted.items);
		const testRefs = toJsonArray(testRefsRedacted.items);
		const reviewRefs = toJsonArray(reviewRefsRedacted.items);
		const changedFiles = toJsonArray(changedFilesRedacted.items);

		let metadataStr = toJsonObject(metadataRedacted.obj);
		if (Buffer.byteLength(metadataStr, "utf-8") > maxMetadataSizeBytes) {
			metadataStr = JSON.stringify({ _truncated: true, _reason: "metadata exceeded maxMetadataSizeBytes" });
		}

		const dedupeKey = computeDedupeKey(record.repoKey, record.agentId, claim, recordedAt, dedupeWindowHours);
		const fileHashes = buildFileHashSnapshot(db, record.repoKey, [
			...record.evidenceRefs,
			...record.changedFiles,
		]);

		const confidence = clamp(record.confidence, 0, 1);

		const insertStmt = db.prepare(
			`INSERT OR IGNORE INTO evidence (
				repo_key, context_version, agent_id, agent_role, agent_run_id, task_id,
				recorded_at, claim, evidence_refs, test_refs, review_refs,
				confidence, changed_files, metadata, is_stale, stale_reason,
				dedupe_key, file_hashes
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		const result = insertStmt.run(
			record.repoKey,
			record.contextVersion,
			record.agentId,
			record.agentRole,
			record.agentRunId,
			record.taskId,
			recordedAt,
			claim,
			evidenceRefs,
			testRefs,
			reviewRefs,
			confidence,
			changedFiles,
			metadataStr,
			record.isStale,
			record.staleReason,
			dedupeKey,
			fileHashes,
		);

		const changes = result.changes ?? 0;
		const recorded = changes > 0;
		const deduplicated = !recorded;

		let id: number | null = null;
		if (recorded) {
			const idRow = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number } | undefined;
			if (idRow) id = idRow.id;
		}

		const counts = getEvidenceQueueCounts(db, record.repoKey);

		return {
			recorded,
			deduplicated,
			id,
			contextVersion: record.contextVersion,
			recordedAt,
			staleWarning: !!record.isStale,
			staleReason: record.staleReason,
			redacted:
				claimRedacted.redacted ||
				evidenceRefsRedacted.redacted ||
				testRefsRedacted.redacted ||
				reviewRefsRedacted.redacted ||
				changedFilesRedacted.redacted ||
				metadataRedacted.redacted,
			queueCounts: counts,
		};
	} finally {
		closeDb(handle);
	}
}

export function getEvidenceQueueCounts(
	db: SqliteDb,
	repoKey: string,
): EvidenceQueueCounts {
	const totalEvidence = Number(
		(db.prepare("SELECT COUNT(*) as c FROM evidence WHERE repo_key = ?").get(repoKey) as { c: number }).c
	);
	const staleEvidence = Number(
		(db.prepare("SELECT COUNT(*) as c FROM evidence WHERE repo_key = ? AND is_stale = 1").get(repoKey) as { c: number }).c
	);
	const pendingEvidence = getPendingEvidenceCount(db, repoKey);
	return { totalEvidence, staleEvidence, pendingEvidence };
}

/**
 * Lazily mark evidence as stale if its stored file hash snapshot no longer matches
 * current indexed file hashes. This is called during sync/status/read.
 * Does not delete rows; only updates is_stale and stale_reason.
 */
export interface EvidenceBatchRow {
	id: number;
	repo_key: string;
	context_version: string;
	agent_id: string;
	agent_role: string;
	agent_run_id: string;
	claim: string;
	evidence_refs: string | null;
	changed_files: string | null;
	confidence: number | null;
	recorded_at: number;
}

export interface ClaimEvidenceBatchResult {
	claimed: EvidenceBatchRow[];
	leaseHolder: string;
	leaseExpiresAt: number;
}

const PROCESS_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;

function makeLeaseHolder(): string {
	return PROCESS_ID;
}

/**
 * Claim a batch of unprocessed evidence rows with a short-term lease.
 * Uses BEGIN IMMEDIATE to prevent concurrent claimers from overlapping.
 * Reclaims expired leases automatically.
 */
export function claimEvidenceBatch(
	db: SqliteDb,
	repoKey: string,
	batchSize: number,
	leaseDurationMs: number,
): ClaimEvidenceBatchResult {
	const now = Date.now();
	const leaseHolder = makeLeaseHolder();
	const leaseExpiresAt = now + leaseDurationMs;

	const beginStmt = db.prepare("BEGIN IMMEDIATE");
	const commitStmt = db.prepare("COMMIT");
	const rollbackStmt = db.prepare("ROLLBACK");

	beginStmt.run();

	try {
		// Reclaim expired leases first
		const expiredStmt = db.prepare(
			`UPDATE evidence SET keeper_state = 'pending', keeper_lease_holder = NULL,
			 keeper_leased_at = NULL, keeper_expires_at = NULL
			 WHERE repo_key = ? AND keeper_state = 'processing' AND keeper_expires_at < ?`
		);
		expiredStmt.run(repoKey, now);

		// Claim unprocessed rows (pending or null state)
		const claimStmt = db.prepare(
			`UPDATE evidence SET keeper_state = 'processing', keeper_lease_holder = ?,
			 keeper_leased_at = ?, keeper_expires_at = ?
			 WHERE id IN (
				 SELECT id FROM evidence
				 WHERE repo_key = ? AND is_stale = 0
					 AND (keeper_state IS NULL OR keeper_state = 'pending')
					 AND (keeper_processed_at IS NULL)
				 ORDER BY recorded_at ASC
				 LIMIT ?
			 )
			 RETURNING id, repo_key, context_version, agent_id, agent_role, agent_run_id,
			   claim, evidence_refs, changed_files, confidence, recorded_at`
		);

		const rows = claimStmt.all(leaseHolder, now, leaseExpiresAt, repoKey, batchSize) as EvidenceBatchRow[];

		commitStmt.run();
		return { claimed: rows ?? [], leaseHolder, leaseExpiresAt };
	} catch (err) {
		try {
			rollbackStmt.run();
		} catch {
			// ignore rollback errors
		}
		throw err;
	}
}

export interface CompleteEvidenceBatchResult {
	completed: number;
	errors: number;
}

/**
 * Mark evidence rows as processed (or error) and release their lease.
 */
export function completeEvidenceBatch(
	db: SqliteDb,
	repoKey: string,
	ids: number[],
	success: boolean,
	error?: string,
	leaseHolder?: string,
): CompleteEvidenceBatchResult {
	if (ids.length === 0) return { completed: 0, errors: 0 };

	const now = Date.now();
	const state = success ? 'processed' : 'error';
	const placeholders = ids.map(() => '?').join(',');

	const leaseClause = leaseHolder ? 'AND keeper_lease_holder = ?' : '';
	const stmt = db.prepare(
		`UPDATE evidence SET keeper_state = ?, keeper_processed_at = ?,
		 keeper_lease_holder = NULL, keeper_expires_at = NULL,
		 keeper_error = ?
		 WHERE repo_key = ? AND id IN (${placeholders}) ${leaseClause}`
	);

	const params = [state, now, error ?? null, repoKey, ...ids];
	if (leaseHolder) params.push(leaseHolder);
	const result = stmt.run(...params);
	const changes = result.changes ?? 0;
	return {
		completed: success ? changes : 0,
		errors: success ? 0 : changes,
	};
}

export function getPendingEvidenceCount(db: SqliteDb, repoKey: string): number {
	try {
		const row = db.prepare(
			`SELECT COUNT(*) as c FROM evidence
			 WHERE repo_key = ? AND is_stale = 0
				 AND (
					 (keeper_state IS NULL OR keeper_state = 'pending')
					 OR (keeper_state = 'processing' AND keeper_expires_at <= ?)
				 )
				 AND keeper_processed_at IS NULL`
		).get(repoKey, Date.now()) as { c: number } | undefined;
		return Number(row?.c ?? 0);
	} catch {
		return 0;
	}
}

export function getProcessingEvidenceCount(db: SqliteDb, repoKey: string): number {
	try {
		const row = db.prepare(
			`SELECT COUNT(*) as c FROM evidence
			 WHERE repo_key = ? AND keeper_state = 'processing' AND keeper_expires_at > ?`
		).get(repoKey, Date.now()) as { c: number } | undefined;
		return Number(row?.c ?? 0);
	} catch {
		return 0;
	}
}

export function markPossiblyStaleEvidence(
	db: SqliteDb,
	repoKey: string,
	currentContextVersion: string,
): { updated: number } {
	let updated = 0;
	try {
		// Mark stale for context_version mismatch
		const ctxResult = db.prepare(
			`UPDATE evidence SET is_stale = 1, stale_reason = COALESCE(stale_reason || '; ', '') || 'context_version mismatch: recorded ' || context_version || ' vs current ' || ?
			 WHERE repo_key = ? AND context_version != ? AND is_stale = 0`
		).run(currentContextVersion, repoKey, currentContextVersion);
		updated += ctxResult.changes ?? 0;

		// Check file hash snapshots for non-stale evidence
		const rows = db.prepare(
			`SELECT id, file_hashes, context_version FROM evidence WHERE repo_key = ? AND is_stale = 0`
		).all(repoKey) as Array<{ id: number; file_hashes: string | null; context_version: string }>;

		for (const row of rows) {
			if (!row.file_hashes || row.file_hashes === "{}") continue;
			let snapshot: Record<string, string>;
			try {
				snapshot = JSON.parse(row.file_hashes);
			} catch {
				continue;
			}
			const mismatches: string[] = [];
			for (const [relPath, storedHash] of Object.entries(snapshot)) {
				const currentRow = db.prepare(
					"SELECT content_hash FROM files WHERE repo_key = ? AND relative_path = ? AND is_deleted = 0"
				).get(repoKey, relPath) as { content_hash: string } | undefined;
				if (!currentRow) {
					mismatches.push(`${relPath}: missing`);
				} else if (currentRow.content_hash !== storedHash) {
					mismatches.push(`${relPath}: hash changed`);
				}
			}
			if (mismatches.length > 0) {
				const reason = `file hash mismatch: ${mismatches.join(", ")}`;
				db.prepare(
					`UPDATE evidence SET is_stale = 1, stale_reason = COALESCE(stale_reason || '; ', '') || ? WHERE id = ?`
				).run(reason, row.id);
				updated++;
			}
		}
	} catch {
		// ignore errors during lazy stale marking
	}
	return { updated };
}
