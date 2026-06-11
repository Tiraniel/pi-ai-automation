// TASK-009 Phase A — workflow quality audit scan helpers (file I/O, parsing, emit).

import * as fs from "node:fs";
import * as path from "node:path";
import {
	asString,
	ParsedArtifact,
	WorkflowQualityAuditFinding,
	WorkflowQualityAuditOptions,
} from "./quality-audit-types";

export function uniqueList(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const normalized = asString(value).trim();
		if (!normalized) continue;
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

export function normalizeOptions(input: WorkflowQualityAuditOptions = {}): Required<WorkflowQualityAuditOptions> {
	return {
		maxDelegateManifests: input.maxDelegateManifests ?? 250,
		maxTaskFiles: input.maxTaskFiles ?? 250,
		maxProgressFiles: input.maxProgressFiles ?? 150,
		maxDebugItems: input.maxDebugItems ?? 250,
		maxMetricFiles: input.maxMetricFiles ?? 250,
		maxMetricLines: input.maxMetricLines ?? 700,
		metricFileDirs: input.metricFileDirs && input.metricFileDirs.length ? [...input.metricFileDirs] : ["extensions", "scripts"],
		metricExtensions: input.metricExtensions && input.metricExtensions.length ? [...input.metricExtensions] : [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md"],
		maxAgeDays: input.maxAgeDays ?? 3650,
	};
}

export function parseFrontmatter(text: string): ParsedArtifact {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { frontmatter: {}, body: text };
	}
	const frontmatter: Record<string, string> = {};
	let index = 1;
	while (index < lines.length) {
		const line = lines[index];
		if (line === "---") {
			index += 1;
			break;
		}
		const colon = line.indexOf(":");
		if (colon > 0) {
			const key = line.slice(0, colon).trim();
			const value = line
				.slice(colon + 1)
				.trim()
				.replace(/^['"]/, "")
				.replace(/['"]$/, "");
			if (key) frontmatter[key] = value;
		}
		index += 1;
	}
	return { frontmatter, body: lines.slice(index).join("\n") };
}

export function safeStat(filePath: string): fs.Stats | undefined {
	try {
		return fs.statSync(filePath);
	} catch {
		return undefined;
	}
}

export function parseJson<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function readText(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

export function inAgeWindow(filePath: string, maxAgeDays: number): boolean {
	if (maxAgeDays <= 0) return true;
	const stat = safeStat(filePath);
	if (!stat) return false;
	return Date.now() - stat.mtimeMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

export function relativeFrom(cwd: string, target: string): string {
	try {
		return path.relative(cwd, target);
	} catch {
		return target;
	}
}

export function isInsideCwd(cwd: string, target: string): boolean {
	if (!target) return false;
	const targetAbs = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
	const cwdAbs = path.resolve(cwd);
	const rel = path.relative(cwdAbs, targetAbs);
	if (!rel) return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}

export interface CollectFilesOptions {
	recursive?: boolean;
	maxFiles?: number;
	include: (absPath: string, relativePath: string) => boolean;
}

export function collectFiles(root: string, options: CollectFilesOptions): string[] {
	if (!fs.existsSync(root)) return [];
	const recursive = options.recursive ?? false;
	const out: string[] = [];
	const skipDirs = new Set([".git", "node_modules", "dist", "out", ".next", "coverage", ".turbo"]);
	const walk = (dir: string, rel = ""): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (skipDirs.has(entry.name)) continue;
			if (options.maxFiles && out.length >= options.maxFiles) return;
			const abs = path.join(dir, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!recursive) continue;
				walk(abs, relPath);
				continue;
			}
			if (entry.isFile() && options.include(abs, relPath)) out.push(abs);
		}
	};
	walk(root, "");
	return out;
}

export function emitFinding(
	bucket: Map<string, WorkflowQualityAuditFinding>,
	finding: WorkflowQualityAuditFinding,
): void {
	finding.evidenceRefs = uniqueList(finding.evidenceRefs);
	finding.taskIds = uniqueList(finding.taskIds);
	finding.runIds = uniqueList(finding.runIds);
	if (!finding.code || !finding.category || !finding.severity || !finding.message) return;
	if (!finding.evidenceRefs.length) return;
	const signature = `${finding.code}|${finding.category}|${finding.severity}|${finding.message}|${finding.evidenceRefs.join("|")}`;
	if (bucket.has(signature)) return;
	bucket.set(signature, finding);
}

export function parseTaskId(value: string): string {
	const match = asString(value).match(/TASK-\d{3,}/);
	return match ? match[0] : "";
}

export function parseDebugId(value: string): string {
	const match = asString(value).match(/DBG-\d{3,}/);
	return match ? match[0] : "";
}

export function detectPattern(value: string, patterns: RegExp[]): boolean {
	const normalized = asString(value).toLowerCase();
	return patterns.some((pattern) => pattern.test(normalized));
}

export function inferDebugArea(value: string): string {
	const normalized = asString(value).toLowerCase();
	if (/workflow[_-]?cfg|workflow cfg|workflowcfg/.test(normalized)) return "workflow_cfg";
	if (/reviewer/.test(normalized)) return "reviewer";
	if (/delegate/.test(normalized)) return "delegate";
	if (/planning/.test(normalized)) return "planning";
	return "general";
}

export function fileOversizedCode(fileRel: string): string {
	if (/configure-overlay\.ts|workflow[_-]?cfg|task-028-workflow-cfg-smokes\.ts/.test(fileRel)) return "workflow_cfg_large_file";
	return "oversized_file";
}

// Delegate manifest candidate filter.
//
// A `.pi/workflow-runs/delegates/<runId>.json` file is the actual delegate
// manifest, while `<runId>.done.json` is the sidecar (completion record). The
// sidecar mtime is often newer than its parent manifest because it is written
// after the manifest, so a bounded mtime-sorted slice can otherwise pick a
// sidecar, parse it as a non-manifest, and silently drop the real risky
// manifest. Excluding `*.done.json` basenames here keeps the candidate set
// to actual delegate manifests before mtime ordering and the bounded slice.
export function isDelegateManifestPath(absPath: string): boolean {
	if (!absPath) return false;
	if (!absPath.endsWith(".json")) return false;
	const base = path.basename(absPath);
	if (base.endsWith(".done.json")) return false;
	return true;
}

// Defense-in-depth shape check for delegate manifests. Even after the
// basename filter above, a malformed or legacy file with the right extension
// could still slip through; require at least one of runId/agent/task/
// manifestVersion so it does not consume a bounded slot.
export function isDelegateManifestShape(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.runId === "string" && obj.runId.length > 0) return true;
	if (typeof obj.agent === "string" && obj.agent.length > 0) return true;
	if (typeof obj.task === "string" && obj.task.length > 0) return true;
	if (typeof obj.manifestVersion === "string" && obj.manifestVersion.length > 0) return true;
	return false;
}
