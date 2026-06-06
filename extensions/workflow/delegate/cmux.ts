// Workflow delegate runtime — cmux pane/workspace helpers and display-mode resolver.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// This module owns the cmux subprocess transport (identify / new-surface /
// send / move-tab-to-new-workspace / close-surface), the workspace/tab
// grouping cache, the shell escape used when scripting the pane, and the
// display-mode resolver. Everything here is independent of the runner —
// the runner simply calls `createCmuxDelegateTab` and the close helpers.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { AgentName, WorkflowConfig } from "../types";
import {
	sanitizeAgentId,
	sanitizeRole,
	type ResolvedRoomContext,
} from "../rooms";
import { DELEGATE_DISPLAY_ENV } from "./constants";
import { isPlainObject } from "./messages";

export function resolveDelegateDisplayMode(config: WorkflowConfig): "headless" | "pane" {
	const fromEnv = process.env[DELEGATE_DISPLAY_ENV]?.trim().toLowerCase();
	if (fromEnv === "headless" || fromEnv === "pane") return fromEnv;
	const fromConfig = config.delegateDisplay?.trim().toLowerCase();
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

export interface CmuxSurfaceContext {
	workspace?: string;
	pane?: string;
	window?: string;
}

export function readStringField(source: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export function parseCmuxSurfaceContext(stdout: string): CmuxSurfaceContext | undefined {
	try {
		const parsed = JSON.parse(stdout);
		if (!isPlainObject(parsed)) return undefined;
		const source = isPlainObject(parsed.caller) ? parsed.caller : isPlainObject(parsed.focused) ? parsed.focused : parsed;
		const context = {
			workspace: readStringField(source, ["workspace_ref", "workspace"]),
			pane: readStringField(source, ["pane_ref", "pane"]),
			window: readStringField(source, ["window_ref", "window"]),
		};
		return context.workspace || context.pane || context.window ? context : undefined;
	} catch {
		return undefined;
	}
}

export const cmuxWorkspaceCache = new Map<string, string>();

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

export function buildTabTitle(groupTitle: string, roomContext: ResolvedRoomContext | undefined, agent: AgentName): string {
	const roleLabel = roomContext?.role
		? sanitizeRole(roomContext.role)
		: roomContext?.agentId
		? sanitizeAgentId(roomContext.agentId)
		: agent;
	const safeGroup = groupTitle.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
	const safeRole = roleLabel.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || agent;
	return `${safeGroup}-${safeRole}`;
}

export function createCmuxDelegateTab(title: string, workspace?: string): string | null {
	const args = ["new-surface", "--type", "terminal"];
	if (workspace) {
		args.push("--workspace", workspace);
	} else {
		// Gather caller context so the new surface opens in the same workspace/pane
		const context = parseCmuxSurfaceContext(sendCmuxCommand(["identify", "--json"]).stdout);
		if (context?.workspace) args.push("--workspace", context.workspace);
		if (context?.pane) args.push("--pane", context.pane);
		if (context?.window) args.push("--window", context.window);
	}
	const result = sendCmuxCommand(args);
	if (!result.ok) return null;
	const match = result.stdout.trim().match(/surface:(\d+)/);
	if (!match) return null;
	const surfaceId = match[0]; // preserve "surface:<n>" form
	if (title) {
		sendCmuxCommand(["rename-tab", "--surface", surfaceId, title]);
	}
	return surfaceId;
}

export function createCmuxWorkspaceForGroup(groupTitle: string, firstSurfaceId: string): string | undefined {
	const moveResult = sendCmuxCommand(["move-tab-to-new-workspace", "--surface", firstSurfaceId, "--title", groupTitle]);
	if (!moveResult.ok) return undefined;
	const identifyResult = sendCmuxCommand(["identify", "--json", "--no-caller", "--surface", firstSurfaceId]);
	const context = parseCmuxSurfaceContext(identifyResult.stdout);
	return context?.workspace;
}

export function closeCmuxSurface(surfaceId: string): void {
	sendCmuxCommand(["close-surface", "--surface", surfaceId]);
}

export function shellEscape(str: string): string {
	if (!/[^\w@%=+,./-]/.test(str)) return str;
	return "'" + str.replace(/'/g, "'\"'\"'") + "'";
}
