import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileAtomicSync } from "../fs-atomic";
import type { ArchitecturePlanReadIssue } from "./types";

export interface PlanStorageLookupError extends Error {
	code: ArchitecturePlanReadIssue["code"];
}

export function planStorageError(code: PlanStorageLookupError["code"], message: string): PlanStorageLookupError {
	const error = new Error(message) as PlanStorageLookupError;
	error.code = code;
	return error;
}

/**
 * Read a plan JSON file. `null` means the file does not exist. A file that
 * exists but cannot be read/parsed throws a `plan_invalid` storage error —
 * corrupt is NOT the same as missing: reporting "not found" for a corrupt
 * plan invites the caller to recreate it and destroy prior phase state.
 */
export function readJson<T>(filePath: string): T | null {
	if (!fs.existsSync(filePath)) return null;
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		throw planStorageError("plan_invalid", `Plan file exists but could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw planStorageError("plan_invalid", `Plan file exists but contains corrupt JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function writeJson(filePath: string, value: unknown): void {
	writeFileAtomicSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
