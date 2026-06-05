/**
 * Minimal runtime helpers for pi-ai-automation-memory.
 */

import * as path from "node:path";

export interface MemoryRuntime {
	cwd: string;
	repoRoot: string;
}

/**
 * Build a minimal runtime context from the Pi extension context.
 * Does NOT scan the repo, open SQLite, or run git commands.
 */
export function buildRuntime(ctx: { cwd: string }): MemoryRuntime {
	return {
		cwd: ctx.cwd,
		repoRoot: ctx.cwd,
	};
}

/**
 * Derive a deterministic repo key from an absolute path.
 * Simple slug; future TASK-003 may use base64url hashing.
 */
export function deriveRepoKey(absPath: string): string {
	return path.basename(absPath) || "unknown";
}
