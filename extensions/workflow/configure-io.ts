// Atomic read/write helpers for `.pi/workflow.local.json` shared by the
// v1 `showWorkflowConfigure` command and the new overlay configurator.
// Kept in its own tiny module so neither `configure.ts` nor the overlay
// modules need to import each other (avoids a circular import: the
// preview module previously imported `writeWorkflowLocalOverride` from
// `configure.ts` while the overlay imported the preview from
// `configure-overlay-preview.ts`).

import * as fs from "node:fs";
import * as path from "node:path";

import type { WorkflowConfig } from "./types";

export const WORKFLOW_LOCAL_CONFIG_PATH = ".pi/workflow.local.json";

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

/** Reads the existing `.pi/workflow.local.json` as a plain object. Never
 *  throws. Returns `{}` when the file is missing, empty, or unparseable. */
export function readExistingWorkflowLocal(cwd: string): Record<string, unknown> {
	const filePath = path.join(cwd, WORKFLOW_LOCAL_CONFIG_PATH);
	try {
		if (!fs.existsSync(filePath)) return {};
		const text = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(text);
		return asPlainObject(parsed) ?? {};
	} catch {
		return {};
	}
}

/** Atomically writes the payload to `.pi/workflow.local.json` via
 *  temp+rename. Returns the absolute path of the written file. */
export function writeWorkflowLocalOverride(cwd: string, payload: WorkflowConfig): string {
	const absolutePath = path.join(cwd, WORKFLOW_LOCAL_CONFIG_PATH);
	const directory = path.dirname(absolutePath);
	fs.mkdirSync(directory, { recursive: true });

	const tempPath = `${absolutePath}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;
	const text = JSON.stringify(payload, null, 2);
	fs.writeFileSync(tempPath, text, "utf8");
	fs.renameSync(tempPath, absolutePath);
	return absolutePath;
}

/** Returns a friendly path for notify messages (relative to cwd when
 *  possible, absolute otherwise). */
export function displayWorkflowLocalPath(cwd: string): string {
	const absolute = path.join(cwd, WORKFLOW_LOCAL_CONFIG_PATH);
	return path.relative(process.cwd(), absolute) || absolute;
}
