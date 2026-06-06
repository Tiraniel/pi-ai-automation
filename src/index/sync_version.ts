/**
 * Context-version and fingerprint helpers for sync.
 *
 * Behavior-preserving extraction from src/index/sync.ts; see sync.ts for the
 * orchestration that consumes these helpers.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readAndHash } from "./scanner";
import { errorCode } from "../util/errors";
import type { GitState } from "../git/state";

export function computeConfigHash(repoRoot: string): string {
	const configPath = path.join(repoRoot, ".pi", "repo-memory.json");
	try {
		const content = fs.readFileSync(configPath, "utf-8");
		return crypto.createHash("sha256").update(content).digest("hex");
	} catch {
		return "";
	}
}

export function computeContentFingerprint(
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
		} catch (err) {
			if (errorCode(err) === "ENOENT") {
				hash = "DELETED";
			} else {
				hash = fileHashes?.get(p) ?? `UNREADABLE:${status}:${p}`;
			}
		}
		return `${status}\0${p}\0${hash}`;
	});
	return crypto.createHash("sha256").update(entries.join("\n")).digest("base64url").slice(0, 16);
}

export function computeContextVersion(
	gitState: GitState | null,
	repoRoot: string,
	fileHashes: Map<string, string>,
): string {
	if (gitState && gitState.head) {
		let version = gitState.head;
		if (gitState.isDirty) version += "-dirty";
		if (gitState.hasUntracked) version += "-untracked";
		if (gitState.hasConflicts) version += "-conflicts";

		const dirtyFp = computeContentFingerprint(gitState.dirtyPaths, "dirty", repoRoot, fileHashes);
		const untrackedFp = computeContentFingerprint(gitState.untrackedPaths, "untracked", repoRoot, fileHashes);
		const conflictFp = computeContentFingerprint(gitState.conflictPaths, "conflict", repoRoot, fileHashes);
		if (dirtyFp) version += "-dfp" + dirtyFp.slice(0, 8);
		if (untrackedFp) version += "-ufp" + untrackedFp.slice(0, 8);
		if (conflictFp) version += "-cfp" + conflictFp.slice(0, 8);
		return version;
	}
	const sorted = Array.from(fileHashes.entries()).sort(([a], [b]) => a.localeCompare(b));
	const hash = crypto.createHash("sha256");
	for (const [rel, h] of sorted) {
		hash.update(rel + "\0" + h + "\n");
	}
	return "nogit-" + hash.digest("hex").slice(0, 32);
}
