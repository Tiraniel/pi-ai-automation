/**
 * Deterministic sync entry point for pi-ai-automation-memory.
 *
 * Resolves repoRoot, detects git state, opens DB lazily, scans files,
 * upserts rows incrementally, marks stale/missing, computes context_version.
 *
 * Context-version/fingerprint helpers live in ./sync_version.ts and the
 * post-transaction count aggregation lives in ./sync_counts.ts.
 */

import * as crypto from "node:crypto";
import { findGitRoot, collectGitState } from "../git/state";
import { openDb, closeDb } from "./db";
import { scanRepo } from "./scanner";
import { resolveRepoRoot } from "../runtime";
import {
	computeConfigHash,
	computeContentFingerprint,
	computeContextVersion,
} from "./sync_version";
import { collectSyncCounts } from "./sync_counts";

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
	conflictCount: number;
	conflictPaths: string[];
	newFiles: number;
	changedFiles: number;
	removedFiles: number;
	languageCounts: Record<string, number>;
	topPackageRoots: string[];
	evidenceCount: number;
	staleEvidenceCount: number;
	pendingEvidenceCount: number;
	processingEvidenceCount: number;
	healthFindingsCount: number;
	keeperLeasedBy: string | null;
	leaseExpiresAt: number | null;
	cacheDbPath: string;
}

interface CardReuseRow {
	content_hash: string;
	card_content: string | null;
	card_source_hash: string | null;
	card_context_version: string | null;
	card_refs: string | null;
	card_excerpts: string | null;
	card_confidence: number | null;
	card_worker_id: string | null;
	card_metadata: string | null;
	card_model_preset: string | null;
	card_token_budget: number | null;
	card_generated_at: number | null;
}

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

		// Scan files (outside transaction)
		const scanResult = scanRepo(repoRoot, gitRoot, knownFiles);
		const scanned = scanResult.files;

		const scannedPaths = new Set(scanned.map((f) => f.relativePath));
		const removedPaths: string[] = [];
		for (const [relPath] of knownFiles) {
			if (!scannedPaths.has(relPath)) {
				removedPaths.push(relPath);
			}
		}

		// Apply git dirty/untracked/conflict flags
		if (gitState) {
			const dirtySet = new Set(gitState.dirtyPaths);
			const untrackedSet = new Set(gitState.untrackedPaths);
			const conflictSet = new Set(gitState.conflictPaths);
			for (const f of scanned) {
				if (dirtySet.has(f.relativePath)) f.isDirty = true;
				if (untrackedSet.has(f.relativePath)) f.isUntracked = true;
				if (conflictSet.has(f.relativePath)) {
					f.isConflicted = true;
					f.isDirty = true;
				}
			}
		}

		// Prefer gitState.conflictPaths; still report excluded/missing ones
		const conflictPaths = gitState?.conflictPaths ?? [];
		const conflictCount = conflictPaths.length;

		// Compute file hashes map for context version and fingerprints
		const fileHashes = new Map<string, string>();
		for (const f of scanned) {
			fileHashes.set(f.relativePath, f.contentHash);
		}

		const configHash = computeConfigHash(repoRoot);
		const contextVersion = computeContextVersion(gitState, repoRoot, fileHashes);
		const lastSyncAt = Date.now();

		const dirtyFp = gitState
			? computeContentFingerprint(gitState.dirtyPaths, "dirty", repoRoot, fileHashes)
			: null;
		const untrackedFp = gitState
			? computeContentFingerprint(gitState.untrackedPaths, "untracked", repoRoot, fileHashes)
			: null;

		// Build card reuse map by content hash from existing DB rows (including deleted)
		const cardReuseMap = new Map<string, CardReuseRow>();
		const allCardRows = db.prepare(
			`SELECT content_hash, card_content, card_source_hash, card_context_version,
				card_refs, card_excerpts, card_confidence, card_worker_id, card_metadata,
				card_model_preset, card_token_budget, card_generated_at
			 FROM files WHERE repo_key = ? AND card_freshness = 'fresh' AND card_content IS NOT NULL`
		).all(repoKey) as CardReuseRow[];
		for (const row of allCardRows) {
			if (!cardReuseMap.has(row.content_hash)) {
				cardReuseMap.set(row.content_hash, row);
			}
		}

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

		// --- BEGIN TRANSACTION ---
		let newFiles = 0;
		let changedFiles = 0;
		db.exec("BEGIN IMMEDIATE;");
		let txCommitted = false;

		try {
			const insertStmt = db.prepare(
				`INSERT INTO files (
					repo_key, relative_path, absolute_path, content_hash, git_blob_hash, size_bytes, mtime_ms,
					is_gitignored, is_generated, is_secret, is_untracked, is_dirty, is_deleted,
					language, package_root, last_indexed_at, card_freshness, imports_hash,
					card_content, card_source_hash, card_context_version, card_refs, card_excerpts,
					card_confidence, card_worker_id, card_metadata, card_model_preset, card_token_budget,
					card_generated_at, card_stale_reason
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
					imports_hash = excluded.imports_hash,
					card_content = excluded.card_content,
					card_source_hash = excluded.card_source_hash,
					card_context_version = excluded.card_context_version,
					card_refs = excluded.card_refs,
					card_excerpts = excluded.card_excerpts,
					card_confidence = excluded.card_confidence,
					card_worker_id = excluded.card_worker_id,
					card_metadata = excluded.card_metadata,
					card_model_preset = excluded.card_model_preset,
					card_token_budget = excluded.card_token_budget,
					card_generated_at = excluded.card_generated_at,
					card_stale_reason = excluded.card_stale_reason
				`
			);

			for (const f of scanned) {
				const known = knownFiles.get(f.relativePath);
				if (!known) {
					newFiles++;
				} else if (known.contentHash !== f.contentHash) {
					changedFiles++;
				}

				let cardFreshness: string | null = "missing";
				let cardStaleReason: string | null = null;
				let cardContent: string | null = null;
				let cardSourceHash: string | null = null;
				let cardContextVersion: string | null = null;
				let cardRefs: string | null = null;
				let cardExcerpts: string | null = null;
				let cardConfidence: number | null = null;
				let cardWorkerId: string | null = null;
				let cardMetadata: string | null = null;
				let cardModelPreset: string | null = null;
				let cardTokenBudget: number | null = null;
				let cardGeneratedAt: number | null = null;

				if (f.isConflicted) {
					cardFreshness = "stale";
					cardStaleReason = "merge conflict detected";
					const existing = db.prepare(
						`SELECT card_content, card_source_hash, card_context_version, card_refs,
							card_excerpts, card_confidence, card_worker_id, card_metadata,
							card_model_preset, card_token_budget, card_generated_at
						 FROM files WHERE repo_key = ? AND relative_path = ?`
					).get(repoKey, f.relativePath) as CardReuseRow | undefined;
					if (existing) {
						cardContent = existing.card_content;
						cardSourceHash = existing.card_source_hash;
						cardContextVersion = existing.card_context_version;
						cardRefs = existing.card_refs;
						cardExcerpts = existing.card_excerpts;
						cardConfidence = existing.card_confidence;
						cardWorkerId = existing.card_worker_id;
						cardMetadata = existing.card_metadata;
						cardModelPreset = existing.card_model_preset;
						cardTokenBudget = existing.card_token_budget;
						cardGeneratedAt = existing.card_generated_at;
					}
				} else if (known) {
					const existing = db.prepare(
						`SELECT card_freshness, card_content, content_hash, card_source_hash, card_context_version,
							card_refs, card_excerpts, card_confidence, card_worker_id, card_metadata,
							card_model_preset, card_token_budget, card_generated_at
						 FROM files WHERE repo_key = ? AND relative_path = ?`
					).get(repoKey, f.relativePath) as {
						card_freshness: string | null;
						card_content: string | null;
						content_hash: string;
						card_source_hash: string | null;
						card_context_version: string | null;
						card_refs: string | null;
						card_excerpts: string | null;
						card_confidence: number | null;
						card_worker_id: string | null;
						card_metadata: string | null;
						card_model_preset: string | null;
						card_token_budget: number | null;
						card_generated_at: number | null;
					} | undefined;
					if (existing) {
						if (existing.card_content) {
							const sourceHash = existing.card_source_hash ?? existing.content_hash;
							if (sourceHash !== f.contentHash) {
								cardFreshness = "stale";
								cardStaleReason = "content_hash changed since card generation";
							} else {
								cardFreshness = "fresh";
								cardStaleReason = null;
								cardContent = existing.card_content;
								cardSourceHash = existing.card_source_hash ?? f.contentHash;
								cardContextVersion = existing.card_context_version;
								cardRefs = existing.card_refs;
								cardExcerpts = existing.card_excerpts;
								cardConfidence = existing.card_confidence;
								cardWorkerId = existing.card_worker_id;
								cardMetadata = existing.card_metadata;
								cardModelPreset = existing.card_model_preset;
								cardTokenBudget = existing.card_token_budget;
								cardGeneratedAt = existing.card_generated_at;
							}
						} else {
							cardFreshness = "missing";
						}
					}
				} else {
					// New file: try to reuse a fresh card by content hash
					const reused = cardReuseMap.get(f.contentHash);
					if (reused) {
						cardFreshness = "fresh";
						cardContent = reused.card_content;
						cardSourceHash = reused.card_source_hash ?? f.contentHash;
						cardContextVersion = reused.card_context_version;
						cardRefs = reused.card_refs;
						cardExcerpts = reused.card_excerpts;
						cardConfidence = reused.card_confidence;
						cardWorkerId = reused.card_worker_id;
						cardMetadata = reused.card_metadata;
						cardModelPreset = reused.card_model_preset;
						cardTokenBudget = reused.card_token_budget;
						cardGeneratedAt = reused.card_generated_at;
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
					cardContent,
					cardSourceHash,
					cardContextVersion,
					cardRefs,
					cardExcerpts,
					cardConfidence,
					cardWorkerId,
					cardMetadata,
					cardModelPreset,
					cardTokenBudget,
					cardGeneratedAt,
					cardStaleReason,
				);
			}

			const deleteImportsStmt = db.prepare("DELETE FROM imports WHERE from_file_id = (SELECT id FROM files WHERE repo_key = ? AND relative_path = ?)");
			const insertImportStmt = db.prepare("INSERT INTO imports (from_file_id, to_file_id, import_path, import_type, repo_key) VALUES ((SELECT id FROM files WHERE repo_key = ? AND relative_path = ?), NULL, ?, ?, ?)");
			const updateImportsHashStmt = db.prepare("UPDATE files SET imports_hash = ? WHERE repo_key = ? AND relative_path = ?");

			for (const f of scanned) {
				const known = knownFiles.get(f.relativePath);
				let imports = f.importPaths;
				let importsHash = f.importsHash;
				if (known && known.contentHash === f.contentHash) {
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
					deleteImportsStmt.run(repoKey, f.relativePath);
					updateImportsHashStmt.run(null, repoKey, f.relativePath);
				}
			}

			for (const relPath of removedPaths) {
				db.prepare(
					"UPDATE files SET is_deleted = 1 WHERE repo_key = ? AND relative_path = ?"
				).run(repoKey, relPath);
				deleteImportsStmt.run(repoKey, relPath);
			}

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

			db.exec("COMMIT;");
			txCommitted = true;
		} catch (err) {
			if (!txCommitted) {
				try { db.exec("ROLLBACK;"); } catch { /* ignore */ }
			}
			throw err;
		}

		// Counts (after transaction)
		const counts = collectSyncCounts(
			db,
			repoKey,
			gitRoot,
			repoRoot,
			scanResult.exclusions,
			contextVersion,
		);

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
			...counts,
			conflictCount,
			conflictPaths,
			newFiles,
			changedFiles,
			removedFiles: removedPaths.length,
			cacheDbPath,
		};
	} finally {
		closeDb(handle);
	}
}

function classifyImportType(importPath: string): string {
	if (importPath.startsWith(".") || importPath.startsWith("/")) return "relative";
	return "package";
}
