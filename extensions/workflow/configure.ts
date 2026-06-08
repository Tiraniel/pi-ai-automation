// `/workflow configure` entry point. v1 legacy helpers (status label,
// model-reference formatting, project-override detection) live here;
// the actual configurator UI has moved to the new overlay module
// (`./configure-overlay`). `showWorkflowConfigure` is a thin shim that
// calls `showWorkflowConfigureOverlay` so the existing command keeps
// working while all staging/persistence flows through the Phase A
// helpers (`buildWorkflowLocalPayload` etc.) and the
// `extensions/workflow/configure-io` atomic write.
//
// This module intentionally avoids duplicating the v1 per-role settings
// UI; see `extensions/workflow/configure-overlay.ts` for the new
// configurator.

import * as fs from "node:fs";

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AGENT_ROLES, type AgentName, type LoadedWorkflowConfig, type WorkflowConfig } from "./types";
import { getAgentPreset, loadWorkflowConfig } from "./runtime/config";
import { showWorkflowConfigureOverlay } from "./configure-overlay";

// Re-export the IO helpers so v1 callers (and the `configure-overlay-*`
// modules that import them through this entry) keep working.
export { WORKFLOW_LOCAL_CONFIG_PATH, readExistingWorkflowLocal, writeWorkflowLocalOverride, displayWorkflowLocalPath } from "./configure-io";

export function getFriendlyProfileLabel(profileId: string): string {
	const normalized = profileId.trim().toLowerCase();
	if (normalized === "default" || normalized === "") return "default";
	if (normalized === "gonka-hybrid" || normalized === "premium-brain-gonka-workers") return "gonka";
	return normalized;
}

function readJsonFile<T = unknown>(filePath: string): T | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function hasObjectProperty(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProjectRoleOverrideFile(pathName: string | null | undefined): boolean {
	if (!pathName) return false;
	const raw = readJsonFile<Record<string, unknown>>(pathName);
	if (!hasObjectProperty(raw)) return false;
	const agents = (raw as { agents?: unknown }).agents;
	if (!hasObjectProperty(agents)) return false;
	const roleKeys = Object.keys(agents);
	const targetRoles = new Set<string>(AGENT_ROLES);
	for (const role of roleKeys) {
		if (targetRoles.has(role)) return true;
	}
	return false;
}

/** True when the loaded project override file has at least one
 *  per-role agent entry (i.e. the user has hand-curated role overrides
 *  rather than only flipping the built-in profile or runtime flags). */
export function hasProjectRoleOverride(loaded: LoadedWorkflowConfig): boolean {
	return Boolean(
		loaded.projectOverridePath
			&& hasProjectRoleOverrideFile(loaded.projectOverridePath),
	);
}

export function getWorkflowStatusLabel(loaded: LoadedWorkflowConfig): string {
	const profileLabel = getFriendlyProfileLabel(loaded.profileId);
	const warning = loaded.configDiagnostics.some((diagnostic) => diagnostic.severity === "warning" || diagnostic.severity === "error");

	if (loaded.profileSource === "cli") {
		return `wf: cli:${profileLabel}${warning ? " ⚠" : ""}`;
	}

	if (hasProjectRoleOverride(loaded)) {
		return `wf: custom/project${warning ? " ⚠" : ""}`;
	}

	return `wf: ${profileLabel}${warning ? " ⚠" : ""}`;
}

export function setWorkflowStatusFromConfig(ctx: ExtensionContext, loaded: LoadedWorkflowConfig): void {
	const warning = loaded.configDiagnostics.some((diagnostic) => diagnostic.severity === "warning" || diagnostic.severity === "error");
	const color = warning ? "warning" : "accent";
	ctx.ui.setStatus("workflow", ctx.ui.theme.fg(color, getWorkflowStatusLabel(loaded)));
}

/** `/workflow configure` entry point — thin shim to the new overlay so
 *  the legacy command shares the safe-persistence semantics. */
export async function showWorkflowConfigure(ctx: ExtensionContext): Promise<void> {
	await showWorkflowConfigureOverlay(ctx);
}

/** Re-read the on-disk workflow config so the status line reflects any
 *  change made by the configurator. */
export function refreshWorkflowStatusAfterConfigure(ctx: ExtensionContext): void {
	const loaded = loadWorkflowConfig(ctx.cwd);
	setWorkflowStatusFromConfig(ctx, loaded);
}

/** Helper used by the overlay (and tests) to compute the currently
 *  effective per-role preset (from project/global/profile/defaults) so
 *  the dashboard can show "(default)" when the role matches the
 *  effective config and the local override is empty. */
export function getEffectiveAgentPreset(loaded: LoadedWorkflowConfig, role: AgentName) {
	return getAgentPreset(loaded.config, role);
}

/** Compatibility helper for callers that still need the raw
 *  `WorkflowConfig` shape; the overlay modules build the staged
 *  payload via `buildWorkflowLocalPayload` from `configure-helpers`. */
export type { WorkflowConfig };
