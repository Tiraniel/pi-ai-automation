import * as fs from "node:fs";
import * as path from "node:path";

import type { ArchitecturePlanReadIssue } from "./types";

export interface PlanStorageLookupError extends Error {
	code: ArchitecturePlanReadIssue["code"];
}

export function planStorageError(code: PlanStorageLookupError["code"], message: string): PlanStorageLookupError {
	const error = new Error(message) as PlanStorageLookupError;
	error.code = code;
	return error;
}

export function readJson<T>(filePath: string): T | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return null;
	}
}

export function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
