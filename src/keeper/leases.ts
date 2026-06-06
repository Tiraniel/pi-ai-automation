/**
 * Keeper lease/process/time helpers.
 *
 * Behavior-preserving extraction from src/keeper/scheduler.ts. SQL, helper
 * semantics, and public surface (`isLeaseHeld`, `acquireLease`,
 * `releaseLease`) are preserved. `refreshLease` is exported as needed by the
 * cards helper module so it can extend the lease TTL after writes.
 */

import * as os from "node:os";
import { openDb, closeDb, sqliteChanges } from "../index/db";
import type { KeeperLease } from "./types";

export const PROCESS_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;

export function makeLeaseHolder(): string {
	return PROCESS_ID;
}

export function nowMs(): number {
	return Date.now();
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

		if (sqliteChanges(result) === 0) {
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
export function refreshLease(lease: KeeperLease, leaseDurationMs: number): KeeperLease {
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
