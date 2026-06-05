/**
 * Git state detection for pi-ai-automation-memory.
 *
 * Detects git root by walking up; collects branch/HEAD/status via git CLI;
 * parses dirty/untracked/conflict paths.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GitState {
	gitRoot: string | null;
	branch: string | null;
	head: string | null;
	isDirty: boolean;
	hasUntracked: boolean;
	hasConflicts: boolean;
	dirtyPaths: string[];
	untrackedPaths: string[];
	conflictPaths: string[];
}

function execGit(cwd: string, args: string[]): string | null {
	try {
		const result = child_process.execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
			timeout: 10000,
		});
		return result; // raw output; do NOT trim here
	} catch {
		return null;
	}
}

/**
 * Walk upward from startDir looking for a `.git` directory.
 * Returns the directory containing `.git`, or null if not found.
 */
export function findGitRoot(startDir: string): string | null {
	let dir = path.resolve(startDir);
	const root = path.parse(dir).root;
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) {
			return dir;
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

const CONFLICT_CODES = new Set([
	"UU", "AA", "DD", "AU", "UA", "DU", "UD",
]);

/**
 * Convert a git-root-relative path to a repo-root-relative path.
 * Returns null if the path lies outside repoRoot.
 */
function gitRelToRepoRel(gitRel: string, gitRoot: string, repoRoot: string): string | null {
	const gitRootResolved = path.resolve(gitRoot);
	const repoRootResolved = path.resolve(repoRoot);
	if (gitRootResolved === repoRootResolved) {
		return gitRel;
	}
	const abs = path.join(gitRootResolved, gitRel);
	const rel = path.relative(repoRootResolved, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return null;
	}
	return rel.replace(/\\/g, "/");
}

/**
 * Collect git state from a git root directory.
 * Returns null if git is not available or the directory is not a git repo.
 *
 * @param gitRoot The git root directory
 * @param repoRoot The repo root directory (may be a subdirectory of gitRoot)
 */
export function collectGitState(gitRoot: string, repoRoot: string): GitState | null {
	const branchRaw = execGit(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const headRaw = execGit(gitRoot, ["rev-parse", "HEAD"]);
	// Only report status for paths inside repoRoot
	// Use NUL-delimited output to avoid shell/quote ambiguity with spaces
	const statusRaw = execGit(gitRoot, ["status", "--porcelain=v1", "-z", "-uall", "--", "."]);

	const branch = branchRaw?.trim() ?? null;
	const head = headRaw?.trim() ?? null;

	if (branch === null && head === null && statusRaw === null) {
		return null;
	}

	const dirtyPaths: string[] = [];
	const untrackedPaths: string[] = [];
	const conflictPaths: string[] = [];

	if (statusRaw !== null && statusRaw.length > 0) {
		// Parse NUL-delimited records.
		// Normal:  XY <path>\0
		// Rename:  XY <orig_path>\0<new_path>\0
		let i = 0;
		while (i < statusRaw.length) {
			if (i + 3 >= statusRaw.length) break;
			const xy = statusRaw.slice(i, i + 2);
			if (statusRaw.charAt(i + 2) !== " ") {
				// malformed: skip to next NUL
				const nextNul = statusRaw.indexOf("\0", i);
				i = nextNul === -1 ? statusRaw.length : nextNul + 1;
				continue;
			}
			i += 3; // skip "XY "

			const firstNul = statusRaw.indexOf("\0", i);
			if (firstNul === -1) break;
			const firstPath = statusRaw.slice(i, firstNul);
			i = firstNul + 1;

			let filePath = firstPath;
			// Rename: consume second path
			if (xy.startsWith("R") || xy.endsWith("R")) {
				const secondNul = statusRaw.indexOf("\0", i);
				if (secondNul === -1) break;
				filePath = statusRaw.slice(i, secondNul);
				i = secondNul + 1;
			}

			const repoRel = gitRelToRepoRel(filePath, gitRoot, repoRoot);
			if (repoRel === null) continue;

			if (xy === "??") {
				untrackedPaths.push(repoRel);
			} else if (CONFLICT_CODES.has(xy)) {
				conflictPaths.push(repoRel);
			} else {
				dirtyPaths.push(repoRel);
			}
		}
	}

	return {
		gitRoot,
		branch,
		head,
		isDirty: dirtyPaths.length > 0 || conflictPaths.length > 0,
		hasUntracked: untrackedPaths.length > 0,
		hasConflicts: conflictPaths.length > 0,
		dirtyPaths,
		untrackedPaths,
		conflictPaths,
	};
}
