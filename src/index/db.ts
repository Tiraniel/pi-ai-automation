/**
 * SQLite database management for pi-ai-automation-memory.
 *
 * Lazily opened; WAL mode; migrations; side-effect-free on import.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureCacheDir } from "../cache/paths";

let sqliteModule: typeof import("node:sqlite") | null = null;

function getSqlite(): typeof import("node:sqlite") {
	if (!sqliteModule) {
		sqliteModule = require("node:sqlite");
	}
	return sqliteModule;
}

export interface DatabaseHandle {
	db: InstanceType<ReturnType<typeof getSqlite>["DatabaseSync"]>;
	close(): void;
}

function ensureColumn(
	db: InstanceType<ReturnType<typeof getSqlite>["DatabaseSync"]>,
	table: string,
	column: string,
	def: string,
) {
	const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	const exists = info.some((row) => row.name === column);
	if (!exists) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def};`);
	}
}

const MIGRATIONS = [
	`CREATE TABLE IF NOT EXISTS repo_meta (
		repo_key TEXT PRIMARY KEY,
		repo_root TEXT NOT NULL,
		git_root TEXT,
		current_branch TEXT,
		current_head TEXT,
		is_dirty INTEGER DEFAULT 0,
		has_untracked INTEGER DEFAULT 0,
		has_conflicts INTEGER DEFAULT 0,
		last_sync_at INTEGER,
		last_keeper_run_at INTEGER,
		context_version TEXT NOT NULL DEFAULT '',
		config_hash TEXT NOT NULL DEFAULT '',
		dirty_fingerprint TEXT,
		untracked_fingerprint TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS files (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		repo_key TEXT NOT NULL,
		relative_path TEXT NOT NULL,
		absolute_path TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		git_blob_hash TEXT,
		size_bytes INTEGER,
		mtime_ms INTEGER,
		is_gitignored INTEGER DEFAULT 0,
		is_generated INTEGER DEFAULT 0,
		is_secret INTEGER DEFAULT 0,
		is_untracked INTEGER DEFAULT 0,
		is_dirty INTEGER DEFAULT 0,
		is_deleted INTEGER DEFAULT 0,
		language TEXT,
		package_root TEXT,
		last_indexed_at INTEGER,
		card_freshness TEXT,
		card_content TEXT,
		card_generated_at INTEGER,
		card_model_preset TEXT,
		card_token_budget INTEGER,
		imports_hash TEXT,
		UNIQUE(repo_key, relative_path)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo_key)`,
	`CREATE INDEX IF NOT EXISTS idx_files_repo_path ON files(repo_key, relative_path)`,
	`CREATE INDEX IF NOT EXISTS idx_files_freshness ON files(repo_key, card_freshness)`,
	`CREATE TABLE IF NOT EXISTS imports (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		from_file_id INTEGER NOT NULL,
		to_file_id INTEGER,
		import_path TEXT NOT NULL,
		import_type TEXT,
		repo_key TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_file_id)`,
	`CREATE INDEX IF NOT EXISTS idx_imports_to ON imports(to_file_id)`,
	`CREATE TABLE IF NOT EXISTS evidence (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		repo_key TEXT NOT NULL,
		context_version TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		agent_role TEXT NOT NULL DEFAULT '',
		agent_run_id TEXT NOT NULL,
		task_id TEXT,
		recorded_at INTEGER,
		claim TEXT NOT NULL,
		evidence_refs TEXT,
		test_refs TEXT,
		review_refs TEXT,
		confidence REAL,
		changed_files TEXT,
		metadata TEXT,
		is_stale INTEGER DEFAULT 0,
		stale_reason TEXT,
		dedupe_key TEXT NOT NULL,
		file_hashes TEXT,
		UNIQUE(repo_key, dedupe_key)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_evidence_repo ON evidence(repo_key)`,
	`CREATE INDEX IF NOT EXISTS idx_evidence_stale ON evidence(repo_key, is_stale)`,
	`CREATE INDEX IF NOT EXISTS idx_evidence_version ON evidence(repo_key, context_version)`,
	`CREATE TABLE IF NOT EXISTS health_findings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		repo_key TEXT NOT NULL,
		generated_at INTEGER,
		context_version TEXT NOT NULL,
		severity TEXT,
		category TEXT,
		finding TEXT NOT NULL,
		evidence_refs TEXT,
		file_refs TEXT,
		rank INTEGER,
		model_preset TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_health_repo ON health_findings(repo_key, severity, rank)`,
	`CREATE TABLE IF NOT EXISTS keeper_leases (
		repo_key TEXT PRIMARY KEY,
		lease_holder TEXT,
		leased_at INTEGER,
		expires_at INTEGER
	)`,
];

function isRetryableOpenError(err: unknown): boolean {
	if (!err) return false;
	const msg = String((err as any)?.message ?? err);
	const code = String((err as any)?.code ?? "");
	return (
		msg.includes("SQLITE_BUSY") ||
		msg.includes("locked") ||
		msg.includes("busy") ||
		code.includes("SQLITE_BUSY") ||
		code.includes("EBUSY")
	);
}

function sleepMs(ms: number): void {
	const sab = new SharedArrayBuffer(4);
	const ia = new Int32Array(sab);
	Atomics.wait(ia, 0, 0, Math.max(1, Math.floor(ms)));
}

/**
 * Open the SQLite database lazily, create cache dir, run migrations,
 * and set WAL/parallel-read-safe pragmas.
 */
export function openDb(repoKey: string, repoRoot: string): DatabaseHandle {
	const { DatabaseSync } = getSqlite();
	const cacheDir = ensureCacheDir(repoKey);
	const dbPath = path.join(cacheDir, "index.sqlite");

	const delays = [10, 25, 50];
	let lastErr: unknown;
	for (let attempt = 0; attempt <= delays.length; attempt++) {
		try {
			const db = new DatabaseSync(dbPath);
			db.exec("PRAGMA journal_mode = WAL;");
			db.exec("PRAGMA synchronous = NORMAL;");
			db.exec("PRAGMA busy_timeout = 5000;");
			db.exec("PRAGMA foreign_keys = ON;");

			for (const migration of MIGRATIONS) {
				db.exec(migration);
			}

			// Backward-compatible ALTER TABLE for evidence columns added after TASK-003
			ensureColumn(db, "evidence", "agent_role", "TEXT NOT NULL DEFAULT ''");
			ensureColumn(db, "evidence", "task_id", "TEXT");
			ensureColumn(db, "evidence", "file_hashes", "TEXT");

			// TASK-006: evidence processing lease columns
			ensureColumn(db, "evidence", "keeper_state", "TEXT");
			ensureColumn(db, "evidence", "keeper_lease_holder", "TEXT");
			ensureColumn(db, "evidence", "keeper_leased_at", "INTEGER");
			ensureColumn(db, "evidence", "keeper_expires_at", "INTEGER");
			ensureColumn(db, "evidence", "keeper_processed_at", "INTEGER");
			ensureColumn(db, "evidence", "keeper_error", "TEXT");

			// TASK-006: file card metadata columns
			ensureColumn(db, "files", "card_source_hash", "TEXT");
			ensureColumn(db, "files", "card_context_version", "TEXT");
			ensureColumn(db, "files", "card_refs", "TEXT");
			ensureColumn(db, "files", "card_excerpts", "TEXT");
			ensureColumn(db, "files", "card_confidence", "REAL");
			ensureColumn(db, "files", "card_worker_id", "TEXT");
			ensureColumn(db, "files", "card_metadata", "TEXT");
			ensureColumn(db, "files", "card_stale_reason", "TEXT");

			return {
				db,
				close() {
					try { db.close(); } catch { /* ignore */ }
				},
			};
		} catch (err) {
			lastErr = err;
			if (attempt < delays.length && isRetryableOpenError(err)) {
				sleepMs(delays[attempt]);
				continue;
			}
			throw err;
		}
	}
	throw lastErr;
}

export function closeDb(handle: DatabaseHandle | null) {
	if (handle) {
		handle.close();
	}
}
