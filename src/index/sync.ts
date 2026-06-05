/**
 * Deterministic sync entry point for pi-ai-automation-memory.
 *
 * Resolves repoRoot, detects git state, opens DB lazily, scans files,
 * upserts rows incrementally, marks stale/missing, computes context_version.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { findGitRoot, collectGitState } from "../git/state";
import { openDb, closeDb } from "./db";
import { scanRepo, type ScannedFile, readAndHash } from "./scanner";
import { resolveRepoRoot } from "../runtime";
import { listGitIgnored, classifyExclusion } from "../security/exclusions";

export interface SyncResult {
	repoKey: string;
	repoRoot: string;
	gitRoot: string | null;
	branch: string | null;
	head: string | null;
	isDirty: boolean;
	hasUntracked: boolean;
	hasConflicts: boolean;
	contextVersion: string;
	lastSyncAt: number;
	configHash: string;
	dirtyFingerprint: string | null;
	untrackedFingerprint: string | null;
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
	newFiles: number;
	changedFiles: number;
	removedFiles: number;
	languageCounts: Record<string, number>;
	topPackageRoots: string[];
	evidenceCount: number;
	staleEvidenceCount: number;
	healthFindingsCount: number;
	keeperLeasedBy: string | null;
	leaseExpiresAt: number | null;
	cacheDbPath: string;
}

function computeConfigHash(repoRoot: string): string {
	const configPath = path.join(repoRoot, ".pi", "repo-memory.json");
	try {
		const content = fs.readFileSync(configPath, "utf-8");
		return crypto.createHash("sha256").update(content).digest("hex");
	} catch {
		return "";
	}
}

/**
 * Compute a disk-based fingerprint for dirty/untracked/conflict files.
 * Reads current disk content directly for each path. Falls back to fileHashes
 * only if direct read is not possible.
 * Format: sorted(status\0relPath\0contentHash-or-DELETED-or-UNREADABLE\n)
 */
function computeContentFingerprint(
	paths: string[],
	status: string,
	repoRoot: string,
	fileHashes?: Map<string, string>,
): string | null {
	if (paths.length === 0) return null;
	const entries = [...paths].sort().map((p) => {
		const absPath = path.join(repoRoot, p);
		let hash: string;
		try {
			const { contentHash } = readAndHash(absPath);
			hash = contentHash;
		} catch (err: any) {
			if (err?.code === "ENOENT") {
				hash = "DELETED";
			} else {
				hash = fileHashes?.get(p) ?? `UNREADABLE:${status}:${p}`;
			}
		}
		return `${status}\0${p}\0${hash}`;
	});
	return crypto.createHash("sha256").update(entries.join("\n")).digest("base64url").slice(0, 16);
}

function computeContextVersion(
	gitState: ReturnType<typeof collectGitState> | null,
	repoRoot: string,
	fileHashes: Map<string, string>,
): string {
	if (gitState && gitState.head) {
		let version = gitState.head;
		if (gitState.isDirty) version += "-dirty";
		if (gitState.hasUntracked) version += "-untracked";
		if (gitState.hasConflicts) version += "-conflicts";

		// Content-based fingerprints so version changes when dirty file content changes
		const dirtyFp = computeContentFingerprint(gitState.dirtyPaths, "dirty", repoRoot, fileHashes);
		const untrackedFp = computeContentFingerprint(gitState.untrackedPaths, "untracked", repoRoot, fileHashes);
		const conflictFp = computeContentFingerprint(gitState.conflictPaths, "conflict", repoRoot, fileHashes);
		if (dirtyFp) version += "-dfp" + dirtyFp.slice(0, 8);
		if (untrackedFp) version += "-ufp" + untrackedFp.slice(0, 8);
		if (conflictFp) version += "-cfp" + conflictFp.slice(0, 8);
		return version;
	}
	// Non-git: merkle-like hash of all tracked file hashes
	const sorted = Array.from(fileHashes.entries()).sort(([a], [b]) => a.localeCompare(b));
	const hash = crypto.createHash("sha256");
	for (const [rel, h] of sorted) {
		hash.update(rel + "\0" + h + "\n");
	}
	return "nogit-" + hash.digest("hex").slice(0, 32);
}

/**
 * Run a deterministic sync for the repo at the given cwd.
 *
 * Resolves repoRoot from cwd (looks for .pi/repo-memory.json, then .git, then cwd).
 * Syncs the resolved repoRoot, not the raw cwd.
 *
 * @param cwd Working directory (usually from Pi context)
 * @param repoKey Deterministic repo key (from cache/paths)
 * @param cacheDbPath Path to SQLite DB
 */
export function syncRepo(cwd: string, repoKey: string, cacheDbPath: string): SyncResult {
	const repoRoot = resolveRepoRoot(cwd);
	const gitRoot = findGitRoot(repoRoot);
	const gitState = gitRoot ? collectGitState(gitRoot, repoRoot) : null;

	const handle = openDb(repoKey, repoRoot);
	const db = handle.db;

	try {
		// Load known files from DB for hash reuse
		const knownFiles = new Map<string, { contentHash: string; sizeBytes: number; mtimeMs: number }>();
		const existingRows = db.prepare(
			"SELECT relative_path, content_hash, size_bytes, mtime_ms FROM files WHERE repo_key = ? AND is_deleted = 0"
		).all(repoKey) as Array<{ relative_path: string; content_hash: string; size_bytes: number; mtime_ms: number }>;
		for (const row of existingRows) {
			knownFiles.set(row.relative_path, {
				contentHash: row.content_hash,
				sizeBytes: row.size_bytes,
				mtimeMs: row.mtime_ms,
			});
		}

		// Scan files
		const scanResult = scanRepo(repoRoot, gitRoot, knownFiles);
		const scanned = scanResult.files;

		// Mark existing files as deleted if not in scan
		const scannedPaths = new Set(scanned.map((f) => f.relativePath));
		const removedPaths: string[] = [];
		for (const [relPath] of knownFiles) {
			if (!scannedPaths.has(relPath)) {
				removedPaths.push(relPath);
			}
		}

		// Apply git dirty/untracked flags with repoRoot-relative path matching
		if (gitState) {
			const dirtySet = new Set(gitState.dirtyPaths);
			const untrackedSet = new Set(gitState.untrackedPaths);
			const conflictSet = new Set(gitState.conflictPaths);
			for (const f of scanned) {
				if (dirtySet.has(f.relativePath)) f.isDirty = true;
				if (untrackedSet.has(f.relativePath)) f.isUntracked = true;
				if (conflictSet.has(f.relativePath)) f.isDirty = true;
			}
		}

		// Compute file hashes map for context version and fingerprints
		const fileHashes = new Map<string, string>();
		for (const f of scanned) {
			fileHashes.set(f.relativePath, f.contentHash);
		}

		const configHash = computeConfigHash(repoRoot);
		const contextVersion = computeContextVersion(gitState, repoRoot, fileHashes);
		const lastSyncAt = Date.now();

		// Content-based fingerprints
		const dirtyFp = gitState
			? computeContentFingerprint(gitState.dirtyPaths, "dirty", repoRoot, fileHashes)
			: null;
		const untrackedFp = gitState
			? computeContentFingerprint(gitState.untrackedPaths, "untracked", repoRoot, fileHashes)
			: null;

		// Upsert files
		const insertStmt = db.prepare(
			`INSERT INTO files (
				repo_key, relative_path, absolute_path, content_hash, git_blob_hash, size_bytes, mtime_ms,
				is_gitignored, is_generated, is_secret, is_untracked, is_dirty, is_deleted,
				language, package_root, last_indexed_at, card_freshness, imports_hash
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(repo_key, relative_path) DO UPDATE SET
				absolute_path = excluded.absolute_path,
				content_hash = excluded.content_hash,
				git_blob_hash = excluded.git_blob_hash,
				size_bytes = excluded.size_bytes,
				mtime_ms = excluded.mtime_ms,
				is_gitignored = excluded.is_gitignored,
				is_generated = excluded.is_generated,
				is_secret = excluded.is_secret,
				is_untracked = excluded.is_untracked,
				is_dirty = excluded.is_dirty,
				is_deleted = 0,
				language = excluded.language,
				package_root = excluded.package_root,
				last_indexed_at = excluded.last_indexed_at,
				card_freshness = excluded.card_freshness,
				imports_hash = excluded.imports_hash
			`
		);

		// Track existing imports to preserve on unchanged files
		const existingImports = new Map<string, string[]>();
		if (knownFiles.size > 0) {
			const importRows = db.prepare(
				"SELECT i.import_path, f.relative_path FROM imports i JOIN files f ON i.from_file_id = f.id WHERE f.repo_key = ?"
			).all(repoKey) as Array<{ import_path: string; relative_path: string }>;
			for (const row of importRows) {
				const arr = existingImports.get(row.relative_path) ?? [];
				arr.push(row.import_path);
				existingImports.set(row.relative_path, arr);
			}
		}

		let newFiles = 0;
		let changedFiles = 0;
		for (const f of scanned) {
			const known = knownFiles.get(f.relativePath);
			if (!known) {
				newFiles++;
			} else if (known.contentHash !== f.contentHash) {
				changedFiles++;
			}

			// Determine card_freshness: if card exists and content changed, mark stale
			let cardFreshness: string | null = "missing";
			if (known) {
				const existing = db.prepare(
					"SELECT card_freshness, card_content, content_hash FROM files WHERE repo_key = ? AND relative_path = ?"
				).get(repoKey, f.relativePath) as { card_freshness: string | null; card_content: string | null; content_hash: string } | undefined;
				if (existing) {
					if (existing.card_content && existing.content_hash !== f.contentHash) {
						cardFreshness = "stale";
					} else if (existing.card_content) {
						cardFreshness = existing.card_freshness ?? "fresh";
					} else {
						cardFreshness = "missing";
					}
				}
			}

			insertStmt.run(
				repoKey,
				f.relativePath,
				f.absolutePath,
				f.contentHash,
				f.gitBlobHash,
				f.sizeBytes,
				f.mtimeMs,
				f.isGitignored ? 1 : 0,
				f.isGenerated ? 1 : 0,
				f.isSecret ? 1 : 0,
				f.isUntracked ? 1 : 0,
				f.isDirty ? 1 : 0,
				0,
				f.language,
				f.packageRoot,
				lastSyncAt,
				cardFreshness,
				f.importsHash,
			);
		}

		// Populate imports table
		// Delete old imports for changed/removed files, insert new ones.
		// Preserve existing imports_hash on unchanged files.
		const deleteImportsStmt = db.prepare("DELETE FROM imports WHERE from_file_id = (SELECT id FROM files WHERE repo_key = ? AND relative_path = ?)");
		const insertImportStmt = db.prepare("INSERT INTO imports (from_file_id, to_file_id, import_path, import_type, repo_key) VALUES ((SELECT id FROM files WHERE repo_key = ? AND relative_path = ?), NULL, ?, ?, ?)");
		const updateImportsHashStmt = db.prepare("UPDATE files SET imports_hash = ? WHERE repo_key = ? AND relative_path = ?");

		for (const f of scanned) {
			const known = knownFiles.get(f.relativePath);
			let imports = f.importPaths;
			let importsHash = f.importsHash;
			if (known && known.contentHash === f.contentHash) {
				// Hash unchanged; reuse existing imports and imports_hash if available
				const existing = existingImports.get(f.relativePath);
				if (existing && existing.length > 0) {
					imports = existing;
					importsHash = crypto.createHash("sha256").update(imports.sort().join("\n")).digest("hex");
				}
			}
			if (imports.length > 0) {
				deleteImportsStmt.run(repoKey, f.relativePath);
				for (const imp of imports) {
					const importType = classifyImportType(imp);
					insertImportStmt.run(repoKey, f.relativePath, imp, importType, repoKey);
				}
				if (importsHash) {
					updateImportsHashStmt.run(importsHash, repoKey, f.relativePath);
				}
			} else if (known) {
				// File changed or unchanged with zero imports: clear any stale imports rows
				deleteImportsStmt.run(repoKey, f.relativePath);
				updateImportsHashStmt.run(null, repoKey, f.relativePath);
			}
		}

		// Mark removed files as deleted
		for (const relPath of removedPaths) {
			db.prepare(
				"UPDATE files SET is_deleted = 1 WHERE repo_key = ? AND relative_path = ?"
			).run(repoKey, relPath);
			deleteImportsStmt.run(repoKey, relPath);
		}

		// Update repo_meta
		db.prepare(
			`INSERT INTO repo_meta (
				repo_key, repo_root, git_root, current_branch, current_head,
				is_dirty, has_untracked, has_conflicts, last_sync_at,
				context_version, config_hash, dirty_fingerprint, untracked_fingerprint
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(repo_key) DO UPDATE SET
				repo_root = excluded.repo_root,
				git_root = excluded.git_root,
				current_branch = excluded.current_branch,
				current_head = excluded.current_head,
				is_dirty = excluded.is_dirty,
				has_untracked = excluded.has_untracked,
				has_conflicts = excluded.has_conflicts,
				last_sync_at = excluded.last_sync_at,
				context_version = excluded.context_version,
				config_hash = excluded.config_hash,
				dirty_fingerprint = excluded.dirty_fingerprint,
				untracked_fingerprint = excluded.untracked_fingerprint
			`
		).run(
			repoKey,
			repoRoot,
			gitRoot,
			gitState?.branch ?? null,
			gitState?.head ?? null,
			gitState?.isDirty ? 1 : 0,
			gitState?.hasUntracked ? 1 : 0,
			gitState?.hasConflicts ? 1 : 0,
			lastSyncAt,
			contextVersion,
			configHash,
			dirtyFp,
			untrackedFp,
		);

		// Counts
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
			gitignoredCount = scanResult.exclusions.gitignoredExcludedCount;
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

		// Language breakdown
		const langRows = db.prepare(
			"SELECT language, COUNT(*) as c FROM files WHERE repo_key = ? AND is_deleted = 0 GROUP BY language"
		).all(repoKey) as Array<{ language: string | null; c: number }>;
		const languageCounts: Record<string, number> = {};
		for (const row of langRows) {
			const key = row.language ?? "unknown";
			languageCounts[key] = (languageCounts[key] ?? 0) + Number(row.c);
		}

		// Top package roots
		const pkgRows = db.prepare(
			"SELECT package_root, COUNT(*) as c FROM files WHERE repo_key = ? AND package_root IS NOT NULL AND is_deleted = 0 GROUP BY package_root ORDER BY c DESC LIMIT 10"
		).all(repoKey) as Array<{ package_root: string; c: number }>;
		const topPackageRoots = pkgRows.map((r) => r.package_root);

		// Evidence counts
		const evidenceCount = Number(
			(db.prepare("SELECT COUNT(*) as c FROM evidence WHERE repo_key = ?").get(repoKey) as { c: number }).c
		);
		const staleEvidenceCount = Number(
			(db.prepare("SELECT COUNT(*) as c FROM evidence WHERE repo_key = ? AND is_stale = 1").get(repoKey) as { c: number }).c
		);

		// Health findings count
		const healthFindingsCount = Number(
			(db.prepare("SELECT COUNT(*) as c FROM health_findings WHERE repo_key = ?").get(repoKey) as { c: number }).c
		);

		// Keeper lease
		const leaseRow = db.prepare("SELECT lease_holder, expires_at FROM keeper_leases WHERE repo_key = ?").get(repoKey) as
			{ lease_holder: string | null; expires_at: number | null } | undefined;
		const keeperLeasedBy = leaseRow?.lease_holder ?? null;
		const leaseExpiresAt = leaseRow?.expires_at ?? null;

		return {
			repoKey,
			repoRoot,
			gitRoot,
			branch: gitState?.branch ?? null,
			head: gitState?.head ?? null,
			isDirty: gitState?.isDirty ?? false,
			hasUntracked: gitState?.hasUntracked ?? false,
			hasConflicts: gitState?.hasConflicts ?? false,
			contextVersion,
			lastSyncAt,
			configHash,
			dirtyFingerprint: dirtyFp,
			untrackedFingerprint: untrackedFp,
			totalFiles,
			freshCards,
			staleCards,
			missingCards,
			gitignoredCount,
			secretExcludedCount: scanResult.exclusions.secretExcludedCount + gitignoredSecret,
			generatedExcludedCount: scanResult.exclusions.generatedExcludedCount + gitignoredGenerated,
			binaryExcludedCount: scanResult.exclusions.binaryExcludedCount + gitignoredBinary,
			lockExcludedCount: scanResult.exclusions.lockExcludedCount + gitignoredLock,
			ideExcludedCount: scanResult.exclusions.ideExcludedCount + gitignoredIde,
			osExcludedCount: scanResult.exclusions.osExcludedCount + gitignoredOs,
			untrackedCount,
			dirtyCount,
			newFiles,
			changedFiles,
			removedFiles: removedPaths.length,
			languageCounts,
			topPackageRoots,
			evidenceCount,
			staleEvidenceCount,
			healthFindingsCount,
			keeperLeasedBy,
			leaseExpiresAt,
			cacheDbPath,
		};
	} finally {
		closeDb(handle);
	}
}

function classifyImportType(importPath: string): string {
	if (importPath.startsWith(".") || importPath.startsWith("/")) return "relative";
	// Scoped packages like @org/pkg are packages; everything else is package
	return "package";
}
