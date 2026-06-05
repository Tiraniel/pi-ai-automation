/**
 * Hybrid keeper scheduler stubs.
 * Future TASK-006 will implement async keeper scheduling,
 * lease management, and batch card generation.
 */

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
}

/**
 * Stub: check if a keeper lease is currently held.
 * Always returns false in the scaffold — no keeper runs yet.
 */
export function isLeaseHeld(_lease: KeeperLease | null | undefined): boolean {
	return false;
}

/**
 * Stub: attempt to acquire a keeper lease.
 * Always returns null in the scaffold.
 */
export function acquireLease(_options: KeeperRunOptions): KeeperLease | null {
	return null;
}

/**
 * Stub: release a keeper lease.
 * No-op in the scaffold.
 */
export function releaseLease(_lease: KeeperLease): void {
	// no-op
}

/**
 * Stub: run one unit of keeper work (e.g. one batch of file cards).
 * Returns a diagnostic message in the scaffold.
 */
export async function runKeeperUnit(_options: KeeperRunOptions): Promise<{ didWork: boolean; message: string }> {
	return {
		didWork: false,
		message: "Keeper is a scaffold stub (TASK-006). No async work was performed.",
	};
}
