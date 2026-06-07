import * as fs from "node:fs";
import * as path from "node:path";

const SPRINT_BINDING_CUSTOM_TYPE = "sprintBinding";
const SPRINTS_CURRENT_FILE = path.join(".sprints", "current.json");
const BINDING_ERROR_CONTEXT = "session sprint binding";

export interface SprintBindingLookupError extends Error {
	code: "sprint_binding_invalid";
}

function sprintBindingLookupError(binding: string): SprintBindingLookupError {
	const error = new Error(`Invalid ${BINDING_ERROR_CONTEXT}: ${binding}`) as SprintBindingLookupError;
	error.code = "sprint_binding_invalid";
	return error;
}

function isWithinSprintRoot(base: string, candidate: string): boolean {
	const baseDir = path.resolve(base);
	const relative = path.relative(baseDir, candidate);
	if (!relative) return false;
	if (relative.startsWith("..") || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
	return true;
}

export function getSessionSprintBinding(sessionManager: any): string | null {
	const binding = sessionManager ? findSprintBinding(sessionManager) : null;
	return binding ? binding.sprintPath : null;
}

function findSprintBinding(sessionManager: any): { sprintPath: string } | null {
	try {
		if (!sessionManager) return null;
		const entries: any[] = typeof sessionManager.getBranch === "function"
			? (sessionManager.getBranch.call(sessionManager) as any[])
			: typeof sessionManager.getEntries === "function"
				? (sessionManager.getEntries.call(sessionManager) as any[])
				: [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (!entry || entry.type !== "custom" || entry.customType !== SPRINT_BINDING_CUSTOM_TYPE) {
				continue;
			}
			const data = entry.data as { sprintPath?: string };
			if (data && typeof data.sprintPath === "string" && data.sprintPath.trim()) {
				return { sprintPath: data.sprintPath.trim() };
			}
		}
	} catch {
		// ignore
	}
	return null;
}

function readActiveSprintPathFromCurrent(cwd: string): string | null {
	const currentPath = path.resolve(cwd, SPRINTS_CURRENT_FILE);
	if (!fs.existsSync(currentPath)) return null;
	let currentJson: { activeSprintPath?: unknown };
	try {
		currentJson = JSON.parse(fs.readFileSync(currentPath, "utf-8")) as { activeSprintPath?: unknown };
	} catch {
		return null;
	}
	const sprintPath = currentJson?.activeSprintPath;
	if (typeof sprintPath !== "string" || !sprintPath.trim()) return null;
	if (path.isAbsolute(sprintPath)) return null;
	const sprintRootBase = path.resolve(cwd, ".sprints", "sprints");
	const normalized = path.resolve(cwd, sprintPath);
	if (!isWithinSprintRoot(sprintRootBase, normalized)) return null;
	if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) return null;
	if (!fs.existsSync(path.join(normalized, "sprint.json"))) return null;
	return normalized;
}

export function resolveSprintPath(cwd: string, sprintPath: string): string | null {
	if (!sprintPath) return null;
	if (path.isAbsolute(sprintPath)) return null;
	const sprintRootBase = path.resolve(cwd, ".sprints", "sprints");
	const normalized = path.resolve(cwd, sprintPath);
	if (!isWithinSprintRoot(sprintRootBase, normalized)) return null;
	if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) return null;
	if (!fs.existsSync(path.join(normalized, "sprint.json"))) return null;
	return normalized;
}

export function resolveSprintPathForStore(cwd: string, sessionManager: any): string | null {
	const binding = sessionManager ? findSprintBinding(sessionManager) : null;
	if (binding) {
		const sprintRoot = resolveSprintPath(cwd, binding.sprintPath);
		if (sprintRoot) return sprintRoot;
		throw sprintBindingLookupError(binding.sprintPath);
	}
	return readActiveSprintPathFromCurrent(cwd);
}

export function assertValidSprintBindingIfPresent(cwd: string, sessionManager: any): string | undefined {
	const binding = getSessionSprintBinding(sessionManager);
	if (!binding) return undefined;
	const sprintRoot = resolveSprintPath(cwd, binding);
	if (sprintRoot) return sprintRoot;
	return `Invalid ${BINDING_ERROR_CONTEXT}: ${binding}`;
}
