/**
 * Post-transaction count aggregation for syncRepo.
 *
 * Behavior-preserving extraction from src/index/sync.ts. Runs the same SQL
 * aggregates, the same gitignored classification branch, and calls
 * markPossiblyStaleEvidence at the same point as the original inline block.
 */

import { listGitIgnored, classifyExclusion } from "../security/exclusions";
import { markPossiblyStaleEvidence } from "../evidence/queue";
import type { ExclusionCounts } from "./scanner";
import type { SqliteDb } from "./db";

export interface SyncCounts {
	totalFiles: number;
	freshCards: number;
	staleCards: number;
	missingCards: number;
	gitignoredCount: number;
	secretExcludedCount: number;
	generatedExcludedCount: number;
	binaryExcludedCount: number;
	lockExcludedCount: number;
	ideExcludedCount: number;
	osExcludedCount: number;
	untrackedCount: number;
	dirtyCount: number;
	languageCounts: Record<string, number>;
	topPackageRoots: string[];
	evidenceCount: number;
	staleEvidenceCount: number;
	pendingEvidenceCount: number;
	processingEvidenceCount: number;
	healthFindingsCount: number;
	keeperLeasedBy: string | null;
	leaseExpiresAt: number | null;
}

export function collectSyncCounts(
	db: SqliteDb,
	repoKey: string,
	gitRoot: string | null,
	repoRoot: string,
	scanExclusions: ExclusionCounts,
	contextVersion: string,
): SyncCounts {
	const totalFiles = Number(
		(db.prepare("SELECT COUNT(*) as c FROM files WHERE repo_key = ? AND is_deleted = 0").get(repoKey) as { c: number }).c
	);
	const freshCards = Number(
		(db.prepare("SELECT COUNT(*) as c FROM files WHERE repo_key = ? AND card_freshness = 'fresh' AND is_deleted = 0").get(repoKey) as { c: number }).c
	);
	const staleCards = Number(
		(db.prepare("SELECT COUNT(*) as c FROM files WHERE repo_key = ? AND card_freshness = 'stale' AND is_deleted = 0").get(repoKey) as { c: number }).c
	);
	const missingCards = Number(
		(db.prepare("SELECT COUNT(*) as c FROM files WHERE repo_key = ? AND (card_freshness = 'missing' OR card_freshness IS NULL) AND is_deleted = 0").get(repoKey) as { c: number }).c
	);
	let gitignoredCount = 0;
	let gitignoredGenerated = 0;
	let gitignoredSecret = 0;
	let gitignoredBinary = 0;
	let gitignoredLock = 0;
	let gitignoredIde = 0;
	let gitignoredOs = 0;

	if (gitRoot) {
		const gitIgnoredResult = listGitIgnored(gitRoot, repoRoot);
		gitignoredCount = gitIgnoredResult.count;
		for (const p of gitIgnoredResult.repoRelPaths) {
			const cls = classifyExclusion(p);
			if (cls.category === "generated") gitignoredGenerated++;
			else if (cls.category === "secret") gitignoredSecret++;
			else if (cls.category === "binary") gitignoredBinary++;
			else if (cls.category === "lock") gitignoredLock++;
			else if (cls.category === "ide") gitignoredIde++;
			else if (cls.category === "os") gitignoredOs++;
		}
	} else {
		gitignoredCount = scanExclusions.gitignoredExcludedCount;
	}

	const secretExcludedCount = Number(
		(db.prepare("SELECT COUNT(*) as c FROM files WHERE repo_key = ? AND is_secret = 1 AND is_deleted = 0").get(repoKey) as { c: number }).c
	);
	const generatedExcludedCount = Number(
		(db.prepare("SELECT COUNT(*) as c FROM files WHERE repo_key = ? AND is_generated = 1 AND is_deleted = 0").get(repoKey) as { c: number }).c
	);
	const untrackedCount = Number(
		(db.prepare("SELECT COUNT(*) as c FROM files WHERE repo_key = ? AND is_untracked = 1 AND is_deleted = 0").get(repoKey) as { c: number }).c
	);
	const dirtyCount = Number(
		(db.prepare("SELECT COUNT(*) as c FROM files WHERE repo_key = ? AND is_dirty = 1 AND is_deleted = 0").get(repoKey) as { c: number }).c
	);

	const langRows = db.prepare(
		"SELECT language, COUNT(*) as c FROM files WHERE repo_key = ? AND is_deleted = 0 GROUP BY language"
	).all(repoKey) as Array<{ language: string | null; c: number }>;
	const languageCounts: Record<string, number> = {};
	for (const row of langRows) {
		const key = row.language ?? "unknown";
		languageCounts[key] = (languageCounts[key] ?? 0) + Number(row.c);
	}

	const pkgRows = db.prepare(
		"SELECT package_root, COUNT(*) as c FROM files WHERE repo_key = ? AND package_root IS NOT NULL AND is_deleted = 0 GROUP BY package_root ORDER BY c DESC LIMIT 10"
	).all(repoKey) as Array<{ package_root: string; c: number }>;
	const topPackageRoots = pkgRows.map((r) => r.package_root);

	markPossiblyStaleEvidence(db, repoKey, contextVersion);

	const evidenceCount = Number(
		(db.prepare("SELECT COUNT(*) as c FROM evidence WHERE repo_key = ?").get(repoKey) as { c: number }).c
	);
	const staleEvidenceCount = Number(
		(db.prepare("SELECT COUNT(*) as c FROM evidence WHERE repo_key = ? AND is_stale = 1").get(repoKey) as { c: number }).c
	);
	const now = Date.now();
	const pendingEvidenceCount = Number(
		(db.prepare(
			`SELECT COUNT(*) as c FROM evidence WHERE repo_key = ? AND is_stale = 0
			 AND (
				 (keeper_state IS NULL OR keeper_state = 'pending')
				 OR (keeper_state = 'processing' AND keeper_expires_at <= ?)
			 )
			 AND keeper_processed_at IS NULL`
		).get(repoKey, now) as { c: number }).c
	);
	const processingEvidenceCount = Number(
		(db.prepare(
			"SELECT COUNT(*) as c FROM evidence WHERE repo_key = ? AND keeper_state = 'processing' AND keeper_expires_at > ?"
		).get(repoKey, now) as { c: number }).c
	);

	const healthFindingsCount = Number(
		(db.prepare("SELECT COUNT(*) as c FROM health_findings WHERE repo_key = ?").get(repoKey) as { c: number }).c
	);

	const leaseRow = db.prepare("SELECT lease_holder, expires_at FROM keeper_leases WHERE repo_key = ?").get(repoKey) as
		{ lease_holder: string | null; expires_at: number | null } | undefined;
	const keeperLeasedBy = leaseRow?.lease_holder ?? null;
	const leaseExpiresAt = leaseRow?.expires_at ?? null;

	return {
		totalFiles,
		freshCards,
		staleCards,
		missingCards,
		gitignoredCount,
		secretExcludedCount: scanExclusions.secretExcludedCount + gitignoredSecret,
		generatedExcludedCount: scanExclusions.generatedExcludedCount + gitignoredGenerated,
		binaryExcludedCount: scanExclusions.binaryExcludedCount + gitignoredBinary,
		lockExcludedCount: scanExclusions.lockExcludedCount + gitignoredLock,
		ideExcludedCount: scanExclusions.ideExcludedCount + gitignoredIde,
		osExcludedCount: scanExclusions.osExcludedCount + gitignoredOs,
		untrackedCount,
		dirtyCount,
		languageCounts,
		topPackageRoots,
		evidenceCount,
		staleEvidenceCount,
		pendingEvidenceCount,
		processingEvidenceCount,
		healthFindingsCount,
		keeperLeasedBy,
		leaseExpiresAt,
	};
}
