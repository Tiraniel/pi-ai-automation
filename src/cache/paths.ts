/**
 * Cache path resolution for pi-ai-automation-memory.
 *
 * Deterministic safe repo key from normalized absolute repo root.
 * Cache lives outside the repo by default under ~/.pi/agent/repo-memory/<repo-key>/index.sqlite
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

const SAFE_CHARS_RE = /[^a-zA-Z0-9_-]/g;

/**
 * Expand a leading `~` to the user's home directory.
 */
export function expandHome(input: string): string {
	if (input.startsWith("~/") || input === "~") {
		return path.join(os.homedir(), input.slice(1));
	}
	return input;
}

/**
 * Derive a deterministic, filesystem-safe repo key from an absolute path.
 *
 * Uses SHA-256 of the normalized absolute path, encoded as base64url (22 chars),
 * with an optional basename suffix for human readability.
 */
export function deriveRepoKey(absPath: string): string {
	const normalized = path.resolve(absPath).toLowerCase();
	const hash = crypto.createHash("sha256").update(normalized).digest("base64url").slice(0, 22);
	const base = path.basename(absPath).replace(SAFE_CHARS_RE, "_").slice(0, 32);
	return `${hash}_${base}`;
}

/**
 * Compute the global cache directory for a repo key.
 */
export function cacheDirForRepoKey(repoKey: string, basePath?: string): string {
	const base = expandHome(basePath ?? "~/.pi/agent/repo-memory");
	return path.join(base, repoKey);
}

/**
 * Compute the SQLite DB path for a repo key.
 */
export function dbPathForRepoKey(repoKey: string, basePath?: string): string {
	return path.join(cacheDirForRepoKey(repoKey, basePath), "index.sqlite");
}

/**
 * Ensure a repo's cache directory exists.
 * Returns the cache directory path.
 */
export function ensureCacheDir(repoKey: string, basePath?: string): string {
	const fs = require("node:fs");
	const dir = cacheDirForRepoKey(repoKey, basePath);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}
