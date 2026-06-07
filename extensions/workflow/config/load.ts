/**
 * Side-effect boundary: v2 workflow file loader (Slice 2).
 *
 * This is the ONLY module in `extensions/workflow/config/` that imports
 * `node:fs` or `node:path`. All other modules (`guards.ts`, `normalize.ts`,
 * `resolve.ts`) remain side-effect free.
 *
 * Responsibilities:
 * - Read a v2 workflow JSON file from disk.
 * - Parse JSON with explicit error diagnostics.
 * - Normalize the workflow via `normalizeV2Workflow`.
 * - Resolve `workflow.references` relative to the workflow file directory.
 * - Reject absolute or escaping catalog reference paths.
 * - Load referenced catalog JSON files and normalize with existing catalog
 *   normalizers.
 * - Call `resolveWorkflow` with whatever loaded successfully.
 * - Return an explicit result shape `{ workflow, catalogs, resolved, diagnostics }`
 *   that surfaces every failure as a diagnostic rather than throwing.
 *
 * Design notes:
 * - Throws only on programmer misuse (e.g. non-string path). All user/config
 *   failures are surfaced as diagnostics.
 * - Missing or malformed catalogs produce diagnostics but do NOT prevent
 *   `resolveWorkflow` from running; downstream resolver diagnostics are
 *   therefore still visible.
 * - Prompt-pack markdown content is NOT loaded here; `path` values remain
 *   references.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	normalizeAgentCatalog,
	normalizeModelPresetsCatalog,
	normalizePromptPacksCatalog,
	normalizeQualityGatesCatalog,
	normalizeToolProfilesCatalog,
	normalizeV2Workflow,
} from "./normalize.js";
import { resolveWorkflow } from "./resolve.js";
import type {
	V2CatalogBundle,
	V2Diagnostic,
	V2ResolvedWorkflow,
	V2Workflow,
} from "../types.js";

export interface V2WorkflowLoadDiagnostic extends V2Diagnostic {}

interface V2WorkflowSourceMeta {
	managedBy?: string;
	managedVersion?: string;
}

export interface V2WorkflowLoadResult {
	/** Normalized v2 workflow when the file parsed and normalized successfully. */
	workflow?: V2Workflow;
	/** Raw workflow source metadata for diagnostics and provenance tracking. */
	sourceMeta?: V2WorkflowSourceMeta;
	/** Loaded and normalized catalogs. Missing or malformed catalogs are omitted. */
	catalogs?: V2CatalogBundle;
	/** Resolved workflow when the workflow normalized successfully. */
	resolved?: V2ResolvedWorkflow;
	/** Load-time and resolve-time diagnostics. Errors here mean the file was
	 *  unreadable, unparseable, malformed, or a referenced catalog could not be
	 *  loaded. */
	diagnostics: V2WorkflowLoadDiagnostic[];
}

function pushDiag(
	diagnostics: V2WorkflowLoadDiagnostic[],
	severity: V2WorkflowLoadDiagnostic["severity"],
	code: string,
	message: string,
): void {
	diagnostics.push({ severity, code, message });
}

/**
 * Returns `true` when `refPath` is a relative path that resolves to a
 * location inside `workflowDir`. Rejects absolute paths and paths whose
 * resolved location escapes the workflow directory (e.g. `../../../etc/passwd`).
 */
function isPathSafe(workflowDir: string, refPath: string): boolean {
	if (path.isAbsolute(refPath)) return false;
	const resolved = path.resolve(workflowDir, refPath);
	const dirPrefix = path.normalize(workflowDir + path.sep);
	const resolvedPrefix = path.normalize(resolved + path.sep);
	return resolvedPrefix.startsWith(dirPrefix);
}

function readJsonFile(filePath: string): unknown {
	const text = fs.readFileSync(filePath, "utf-8");
	return JSON.parse(text);
}

interface CatalogRefSpec {
	key: keyof V2CatalogBundle;
	loader: (input: unknown) => unknown;
	name: string;
}

const CATALOG_REFS: CatalogRefSpec[] = [
	{ key: "agentCatalog", loader: normalizeAgentCatalog, name: "agent catalog" },
	{ key: "modelPresets", loader: normalizeModelPresetsCatalog, name: "model presets" },
	{ key: "toolProfiles", loader: normalizeToolProfilesCatalog, name: "tool profiles" },
	{ key: "promptPacks", loader: normalizePromptPacksCatalog, name: "prompt packs" },
	{ key: "qualityGates", loader: normalizeQualityGatesCatalog, name: "quality gates" },
];

/**
 * Load a v2 workflow file and its referenced catalogs from disk.
 *
 * The function never throws for user/config errors; all failures are collected
 * into `diagnostics`. It throws only for programmer misuse (e.g. a non-string
 * `workflowFilePath`).
 */
export function loadV2Workflow(workflowFilePath: string): V2WorkflowLoadResult {
	const diagnostics: V2WorkflowLoadDiagnostic[] = [];

	let rawWorkflow: unknown;
	try {
		rawWorkflow = readJsonFile(workflowFilePath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		pushDiag(diagnostics, "error", "workflow-read-failed", `Failed to read workflow file: ${message}`);
		return { diagnostics };
	}

	const sourceMeta: V2WorkflowSourceMeta = {};
	if (rawWorkflow !== null && typeof rawWorkflow === "object") {
		const raw = rawWorkflow as Record<string, unknown>;
		sourceMeta.managedBy = typeof raw._managedBy === "string" ? raw._managedBy : undefined;
		sourceMeta.managedVersion = typeof raw._managedVersion === "string" ? raw._managedVersion : undefined;
	}

	const workflow = normalizeV2Workflow(rawWorkflow);
	if (!workflow) {
		pushDiag(diagnostics, "error", "workflow-malformed", "Workflow file is not a valid v2 workflow.");
		return { diagnostics, sourceMeta };
	}

	const workflowDir = path.dirname(path.resolve(workflowFilePath));
	const catalogs: V2CatalogBundle = {};
	const references = workflow.references ?? {};

	for (const { key, loader, name } of CATALOG_REFS) {
		const refPath = (references as Record<string, string | undefined>)[key];
		if (!refPath) continue;

		if (!isPathSafe(workflowDir, refPath)) {
			pushDiag(
				diagnostics,
				"error",
				"catalog-reference-unsafe",
				`Catalog reference for ${name} ("${refPath}") is absolute or escapes the workflow directory.`,
			);
			continue;
		}

		const catalogPath = path.resolve(workflowDir, refPath);
		let rawCatalog: unknown;
		try {
			rawCatalog = readJsonFile(catalogPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			pushDiag(
				diagnostics,
				"error",
				"catalog-read-failed",
				`Failed to read ${name} at "${refPath}": ${message}`,
			);
			continue;
		}

		const catalog = loader(rawCatalog);
		if (!catalog) {
			pushDiag(
				diagnostics,
				"error",
				"catalog-malformed",
				`${name} at "${refPath}" is not a valid v2 catalog.`,
			);
			continue;
		}

		(catalogs as Record<string, unknown>)[key] = catalog;
	}

	const resolved = resolveWorkflow(workflow, catalogs);

	return {
		sourceMeta,
		workflow,
		catalogs,
		resolved,
		diagnostics: [...diagnostics, ...resolved.diagnostics],
	};
}
