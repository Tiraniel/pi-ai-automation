// Diff collector. For fixtures the "before" and "after" states are directories
// (base/ vs changed/); in a live repo the same interface would wrap `git diff`.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import type { DiffResult } from "./types.ts";

function walk(dir: string, prefix = ""): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out.sort();
}

export function collectDirDiff(baseDir: string, changedDir: string): DiffResult {
	const baseFiles = new Set(walk(baseDir));
	const changedFiles = new Set(walk(changedDir));
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];
	const changedContents: Record<string, string> = {};

	for (const f of changedFiles) {
		const content = fs.readFileSync(path.join(changedDir, f), "utf8");
		if (!baseFiles.has(f)) {
			added.push(f);
			changedContents[f] = content;
		} else if (fs.readFileSync(path.join(baseDir, f), "utf8") !== content) {
			changed.push(f);
			changedContents[f] = content;
		}
	}
	for (const f of baseFiles) {
		if (!changedFiles.has(f)) removed.push(f);
	}

	// Human-readable unified diff for reports; harness logic never parses this.
	const diffProc = spawnSync("diff", ["-ruN", baseDir, changedDir], { encoding: "utf8" });
	const unifiedText = diffProc.error ? "(diff tool unavailable)" : diffProc.stdout;

	return { added, removed, changed, changedContents, unifiedText };
}
