// Workflow delegate runtime — cmux pane helpers and display-mode resolver.
//
// This module owns cmux transport primitives: surface detection/parsing, split
// + pane surface creation, command dispatch, and small shell helpers.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	DELEGATE_DISPLAY_ENV,
	DELEGATE_PANE_SHELL_READY_DELAY_ENV,
	DELEGATE_PANE_SHELL_READY_DELAY_MS,
} from "./constants";
import type { ResolvedRoomContext } from "../rooms";
import { isPlainObject } from "./messages";

export function resolveDelegateDisplayMode(config: any): "headless" | "pane" {
	const fromEnv = process.env[DELEGATE_DISPLAY_ENV]?.trim().toLowerCase();
	if (fromEnv === "headless" || fromEnv === "pane") return fromEnv;
	const fromConfig = config?.delegateDisplay?.trim().toLowerCase();
	if (fromConfig === "headless" || fromConfig === "pane") return fromConfig;
	if (fromEnv === "auto" || fromConfig === "auto") {
		return isCmuxAvailable() ? "pane" : "headless";
	}
	return "headless";
}

export function isCmuxAvailable(): boolean {
	if (!process.env.CMUX_SOCKET_PATH) return false;
	try {
		const result = spawnSync("cmux", ["identify", "--json"], { encoding: "utf8", timeout: 3000 });
		return result.status === 0;
	} catch {
		try {
			const result = spawnSync("cmux", ["--version"], { encoding: "utf8", timeout: 3000 });
			return result.status === 0;
		} catch {
			return false;
		}
	}
}

export function sendCmuxCommand(args: string[]): { stdout: string; stderr: string; ok: boolean } {
	try {
		const result = spawnSync("cmux", args, { encoding: "utf8", timeout: 10000 });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", ok: result.status === 0 };
	} catch (error) {
		return { stdout: "", stderr: String(error), ok: false };
	}
}

export function sendCmuxShellCommand(surfaceId: string, command: string): { stdout: string; stderr: string; ok: boolean } {
	return sendCmuxCommand(["send", "--surface", surfaceId, `${command}\\n`]);
}

export interface CmuxSurfaceContext {
	workspace?: string;
	pane?: string;
	surface?: string;
}

export interface CmuxCreatedSurface {
	surface: string;
	pane?: string;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function readStringField(source: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function readCmuxFieldFromSource(source: unknown): { workspace?: string; pane?: string; surface?: string } | undefined {
	if (!isPlainObject(source)) return undefined;
	const workspace = readStringField(source as Record<string, unknown>, ["workspace_ref", "workspace"]);
	const pane = readStringField(source as Record<string, unknown>, ["pane_ref", "pane"]);
	const surface = readStringField(source as Record<string, unknown>, ["surface_ref", "surface"]);
	if (!workspace && !pane && !surface) return undefined;
	return { workspace, pane, surface };
}

export function parseCmuxSurfaceContext(stdout: string): CmuxSurfaceContext | undefined {
	const parsed = parseJson(stdout);
	if (!parsed) return undefined;
	if (!isPlainObject(parsed)) return undefined;
	const context =
		readCmuxFieldFromSource((parsed as Record<string, unknown>).caller) ||
		readCmuxFieldFromSource((parsed as Record<string, unknown>).focused) ||
		readCmuxFieldFromSource(parsed);
	if (!context) return undefined;
	return {
		workspace: context.workspace,
		pane: context.pane,
		surface: context.surface,
	};
}

export function parseCmuxCreatedSurface(stdout: string): CmuxCreatedSurface | undefined {
	const surfaceMatch = stdout.match(/surface:\S+/i);
	if (!surfaceMatch) return undefined;
	const paneMatch = stdout.match(/pane:\S+/i);
	return {
		surface: surfaceMatch[0],
		pane: paneMatch?.[0],
	};
}

function readPaneForSurface(surface: string): string | undefined {
	const result = sendCmuxCommand(["identify", "--json", "--surface", surface]);
	if (!result.ok) return undefined;
	const context = parseCmuxSurfaceContext(result.stdout);
	return context?.pane;
}

export const cmuxGroupPaneCache = new Map<string, string>();

export function getPaneShellReadyDelayMs(): number {
	const raw = process.env[DELEGATE_PANE_SHELL_READY_DELAY_ENV];
	if (!raw) return DELEGATE_PANE_SHELL_READY_DELAY_MS;
	const parsed = Number.parseInt(raw.trim(), 10);
	if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	return DELEGATE_PANE_SHELL_READY_DELAY_MS;
}

export function deriveGroupKeyAndTitle(roomContext: ResolvedRoomContext | undefined, task: string): { groupKey: string; groupTitle: string } {
	if (roomContext?.roomId) {
		return { groupKey: roomContext.roomId, groupTitle: roomContext.roomId };
	}
	const taskIdMatch = task.match(/\b([A-Z]+-\d+)\b/);
	if (taskIdMatch) {
		return { groupKey: taskIdMatch[1], groupTitle: taskIdMatch[1] };
	}
	const hash = createHash("sha256").update(task).digest("hex").slice(0, 8);
	const preview = task.slice(0, 20).replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
	const title = `${preview || "task"}-${hash}`;
	return { groupKey: title, groupTitle: title };
}

export function buildTabTitle(groupTitle: string, roomContext: ResolvedRoomContext | undefined, agent: string): string {
	const roleLabel = roomContext?.role
		? roomContext.role
		: roomContext?.agentId
		? roomContext.agentId
		: agent;
	const safeGroup = groupTitle.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
	const safeRole = String(roleLabel).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || agent;
	return `${safeGroup}-${safeRole}`;
}

function sanitizeShellArg(value: string): string {
	return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function sanitizeTabLabel(value: string): string {
	return value
		.replace(/[^\w.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

export function createCmuxSplitSurface(tabTitle: string, fromSurface?: string): CmuxCreatedSurface | null {
	const args = ["new-split", "right"];
	if (fromSurface) args.push("--surface", fromSurface);
	const result = sendCmuxCommand(args);
	if (!result.ok) return null;
	const created = parseCmuxCreatedSurface(result.stdout);
	if (!created) return null;
	if (tabTitle) {
		sendCmuxCommand(["rename-tab", "--surface", created.surface, sanitizeTabLabel(tabTitle)]);
	}
	if (!created.pane) {
		created.pane = readPaneForSurface(created.surface);
	}
	return created;
}

export function createCmuxSurfaceInPane(tabTitle: string, pane: string): string | null {
	const result = sendCmuxCommand(["new-surface", "--pane", pane]);
	if (!result.ok) return null;
	const created = parseCmuxCreatedSurface(result.stdout);
	if (!created?.surface) return null;
	if (tabTitle) {
		sendCmuxCommand(["rename-tab", "--surface", created.surface, sanitizeTabLabel(tabTitle)]);
	}
	return created.surface;
}

export function createCmuxDelegateTab(tabTitle: string, groupKey: string): string | null {
	const cachedPane = cmuxGroupPaneCache.get(groupKey);
	if (cachedPane) {
		const existingSurface = createCmuxSurfaceInPane(tabTitle, cachedPane);
		if (existingSurface) return existingSurface;
		cmuxGroupPaneCache.delete(groupKey);
	}

	const sourceSurface = process.env.CMUX_SURFACE_ID;
	const created = createCmuxSplitSurface(tabTitle, sourceSurface);
	if (!created) return null;
	if (created.pane) cmuxGroupPaneCache.set(groupKey, created.pane);
	return created.surface;
}

export function closeCmuxSurface(surfaceId: string): void {
	sendCmuxCommand(["close-surface", "--surface", surfaceId]);
}

export function shellEscape(str: string): string {
	if (/^[A-Za-z0-9@%_\-+=:,./]+$/.test(str)) return str;
	return sanitizeShellArg(str);
}
