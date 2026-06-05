/**
 * Minimal runtime helpers for pi-ai-automation-memory.
 *
 * Side-effect-free: no fs/git/db calls at extension load via imports alone.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { deriveRepoKey, dbPathForRepoKey } from "./cache/paths";

export interface MemoryRuntime {
	cwd: string;
	repoRoot: string;
	repoKey: string;
	cacheDbPath: string;
}

/**
 * Resolve repo root by walking up from cwd:
 * 1. Directory containing `.pi/repo-memory.json`
 * 2. Directory containing `.git`
 * 3. cwd itself
 */
export function resolveRepoRoot(cwd: string): string {
	let dir = path.resolve(cwd);
	const root = path.parse(dir).root;
	while (true) {
		if (fs.existsSync(path.join(dir, ".pi", "repo-memory.json"))) {
			return dir;
		}
		if (fs.existsSync(path.join(dir, ".git"))) {
			return dir;
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.resolve(cwd);
}

/**
 * Build a minimal runtime context from the Pi extension context.
 * Does NOT scan the repo, open SQLite, or run git commands.
 */
export function buildRuntime(ctx: { cwd: string }): MemoryRuntime {
	const repoRoot = resolveRepoRoot(ctx.cwd);
	const repoKey = deriveRepoKey(repoRoot);
	const cacheDbPath = dbPathForRepoKey(repoKey);
	return {
		cwd: ctx.cwd,
		repoRoot,
		repoKey,
		cacheDbPath,
	};
}
