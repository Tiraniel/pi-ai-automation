/**
 * Default secret/generated/lock/binary exclusions and glob matching
 * for pi-ai-automation-memory.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_SECRET_PATTERNS = [
	".env*",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"id_rsa*",
	"id_ed25519*",
	".aws/",
	".ssh/",
	"credentials*",
	"secrets*",
	"*.secret",
	"*.token",
	"*.passwd",
];

export const DEFAULT_GENERATED_PATTERNS = [
	"node_modules/",
	"dist/",
	"build/",
	".next/",
	"coverage/",
	"*.min.js",
	"*.min.css",
	"*.map",
];

export const DEFAULT_BINARY_PATTERNS = [
	"*.zip",
	"*.tar.gz",
	"*.png",
	"*.jpg",
	"*.gif",
	"*.mp4",
	"*.pdf",
	"*.woff*",
	"*.ttf",
];

export const DEFAULT_LOCK_PATTERNS = [
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"Cargo.lock",
	"poetry.lock",
];

export const DEFAULT_IDE_PATTERNS = [
	".vscode/",
	".idea/",
	"*.iml",
];

export const DEFAULT_OS_PATTERNS = [
	".DS_Store",
	"Thumbs.db",
];

export const DEFAULT_EXCLUSIONS: string[] = [
	...DEFAULT_SECRET_PATTERNS,
	...DEFAULT_GENERATED_PATTERNS,
	...DEFAULT_BINARY_PATTERNS,
	...DEFAULT_LOCK_PATTERNS,
	...DEFAULT_IDE_PATTERNS,
	...DEFAULT_OS_PATTERNS,
];

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a path matches a glob pattern.
 *
 * Supports:
 *   - * (any sequence)
 *   - ? (single char)
 *   - trailing / for directory match (matches the dir and any children)
 *   - leading / for root-anchored match
 *   - ** (treated as *)
 *
 * Does NOT handle ! negation; use isGitignoredPath for ordered negation.
 */
export function matchGlob(filePath: string, pattern: string): boolean {
	// Strip leading ! for raw matching; caller handles negation semantics
	let pat = pattern.startsWith("!") ? pattern.slice(1) : pattern;
	const isDir = pat.endsWith("/");
	if (isDir) {
		pat = pat.slice(0, -1);
	}
	const anchoredToRoot = pat.startsWith("/");
	if (anchoredToRoot) {
		pat = pat.slice(1);
	}

	// Replace ** with * for simplicity
	pat = pat.replace(/\*\*/g, "*");

	// Build regex from glob parts
	let regexStr = "";
	const parts = pat.split("*");
	for (let i = 0; i < parts.length; i++) {
		if (i > 0) regexStr += ".*";
		regexStr += escapeRegex(parts[i]).replace(/\?/g, ".");
	}

	if (isDir) {
		if (anchoredToRoot) {
			return new RegExp("^(?:" + regexStr + ")(?:/|$)").test(filePath);
		}
		return new RegExp("(?:^|/)(?:" + regexStr + ")(?:/|$)").test(filePath);
	}

	if (anchoredToRoot) {
		return new RegExp("^(?:" + regexStr + ")$").test(filePath);
	}

	// Unanchored file pattern: match anywhere in path or as basename
	const anywhere = new RegExp("(?:^|/)(?:" + regexStr + ")$");
	const basename = new RegExp("^(?:" + regexStr + ")$");
	return anywhere.test(filePath) || basename.test(path.basename(filePath));
}

/**
 * Check if a path is gitignored according to an ordered list of patterns.
 * Patterns are processed in order; a leading ! unignores a previously ignored path.
 */
export function isGitignoredPath(relPath: string, patterns: string[]): boolean {
	let ignored = false;
	for (const pat of patterns) {
		if (pat.startsWith("!")) {
			if (matchGlob(relPath, pat)) {
				ignored = false;
			}
		} else {
			if (matchGlob(relPath, pat)) {
				ignored = true;
			}
		}
	}
	return ignored;
}

/**
 * Check if a file path matches any of the exclusion patterns.
 * Returns the matched pattern, or null if not excluded.
 */
export function isExcluded(filePath: string, patterns: string[] = DEFAULT_EXCLUSIONS): string | null {
	for (const pat of patterns) {
		if (matchGlob(filePath, pat)) {
			return pat;
		}
	}
	return null;
}

/**
 * Check which exclusion category a path matches.
 */
export function classifyExclusion(filePath: string): { excluded: boolean; pattern: string | null; category: "secret" | "generated" | "binary" | "lock" | "ide" | "os" | "gitignore" | null } {
	const categories: { patterns: string[]; category: "secret" | "generated" | "binary" | "lock" | "ide" | "os" }[] = [
		{ patterns: DEFAULT_SECRET_PATTERNS, category: "secret" },
		{ patterns: DEFAULT_GENERATED_PATTERNS, category: "generated" },
		{ patterns: DEFAULT_BINARY_PATTERNS, category: "binary" },
		{ patterns: DEFAULT_LOCK_PATTERNS, category: "lock" },
		{ patterns: DEFAULT_IDE_PATTERNS, category: "ide" },
		{ patterns: DEFAULT_OS_PATTERNS, category: "os" },
	];
	for (const { patterns, category } of categories) {
		const pat = isExcluded(filePath, patterns);
		if (pat) {
			return { excluded: true, pattern: pat, category };
		}
	}
	return { excluded: false, pattern: null, category: null };
}

/**
 * Parse a .gitignore file into an array of patterns.
 * Very lightweight: skips comments and blank lines; handles negation (!).
 */
export function parseGitignore(content: string): string[] {
	const patterns: string[] = [];
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		patterns.push(trimmed);
	}
	return patterns;
}

/**
 * Read .gitignore files along a path and return combined patterns.
 */
export function collectGitignorePatterns(fromDir: string, rootDir: string): string[] {
	const patterns: string[] = [];
	let dir = path.resolve(fromDir);
	const root = path.resolve(rootDir);
	while (true) {
		const giPath = path.join(dir, ".gitignore");
		if (fs.existsSync(giPath)) {
			try {
				const content = fs.readFileSync(giPath, "utf-8");
				patterns.push(...parseGitignore(content));
			} catch {
				// ignore read errors
			}
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return patterns;
}

/**
 * Get the list of files from git ls-files, respecting .gitignore and exclude-standard.
 * Returns an array of relative paths from the git root.
 * Uses NUL-delimited output for paths with spaces.
 */
export function gitLsFiles(gitRoot: string): string[] | null {
	try {
		const result = require("node:child_process").execFileSync(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{
				cwd: gitRoot,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"],
				timeout: 30000,
			},
		);
		// Parse NUL-delimited paths
		const paths: string[] = [];
		let i = 0;
		while (i < result.length) {
			const nul = result.indexOf("\0", i);
			if (nul === -1) break;
			const p = result.slice(i, nul);
			if (p.length > 0) paths.push(p);
			i = nul + 1;
		}
		return paths;
	} catch {
		return null;
	}
}

/**
 * Result of listing ignored untracked files in a git repo.
 */
export interface GitIgnoredResult {
	count: number;
	repoRelPaths: string[];
}

/**
 * List ignored untracked files in a git repo, optionally scoped to repoRoot.
 * Returns repoRoot-relative paths. If repoRoot is not provided or equals gitRoot,
 * paths are git-root-relative.
 * Uses NUL-delimited output for paths with spaces.
 */
export function listGitIgnored(gitRoot: string, repoRoot?: string): GitIgnoredResult {
	try {
		const result = require("node:child_process").execFileSync(
			"git",
			["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
			{
				cwd: gitRoot,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"],
				timeout: 30000,
			},
		);
		const gitRootResolved = path.resolve(gitRoot);
		const repoRootResolved = repoRoot ? path.resolve(repoRoot) : gitRootResolved;
		const repoRelFromGit = path.relative(gitRootResolved, repoRootResolved).replace(/\\/g, "/");
		const prefix = repoRelFromGit ? repoRelFromGit + "/" : "";

		const repoRelPaths: string[] = [];
		let i = 0;
		while (i < result.length) {
			const nul = result.indexOf("\0", i);
			if (nul === -1) break;
			const p = result.slice(i, nul);
			if (p.length > 0) {
				if (repoRootResolved !== gitRootResolved) {
					if (prefix && p.startsWith(prefix)) {
						repoRelPaths.push(p.slice(prefix.length));
					} else if (!prefix) {
						repoRelPaths.push(p);
					}
					// else: ignored file outside repoRoot, skip
				} else {
					repoRelPaths.push(p);
				}
			}
			i = nul + 1;
		}
		return { count: repoRelPaths.length, repoRelPaths };
	} catch {
		return { count: 0, repoRelPaths: [] };
	}
}

/**
 * Count ignored untracked files in a git repo.
 * Returns the count, or 0 if git is unavailable.
 * Uses NUL-delimited output for paths with spaces.
 * @deprecated Use listGitIgnored for scoped counts.
 */
export function countGitIgnored(gitRoot: string): number {
	return listGitIgnored(gitRoot).count;
}

/**
 * Get git blob hashes for tracked files.
 * Returns a Map of repo-root-relative path -> blob hash (hex).
 * Uses NUL-delimited output: <mode> <object> <stage>\t<path>\0
 */
export function gitBlobHashes(gitRoot: string): Map<string, string> | null {
	try {
		const result = require("node:child_process").execFileSync(
			"git",
			["ls-files", "-s", "-z"],
			{
				cwd: gitRoot,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"],
				timeout: 30000,
			},
		);
		const map = new Map<string, string>();
		let i = 0;
		while (i < result.length) {
			const tabIdx = result.indexOf("\t", i);
			if (tabIdx === -1) break;
			const nulIdx = result.indexOf("\0", tabIdx);
			if (nulIdx === -1) break;
			const meta = result.slice(i, tabIdx);
			const filePath = result.slice(tabIdx + 1, nulIdx);
			const parts = meta.split(" ");
			if (parts.length >= 2) {
				map.set(filePath, parts[1]);
			}
			i = nulIdx + 1;
		}
		return map;
	} catch {
		return null;
	}
}
