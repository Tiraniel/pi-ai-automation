// Workflow configuration pure helpers — side-effect free (no disk I/O,
// no ExtensionContext mutation). Persistence stays in configure.ts.
// Groups: 1) model DTOs, 2) staged draft + safe payload builder, 3) preview text.

import { THINKING_LEVELS, type ThinkingLevel, type AgentName, AGENT_ROLES, type DelegateAgentName, type WorkflowConfig } from "./types";

// ============================================================================
// Model metadata DTOs
// ============================================================================

/** Mirrors the v1 agent preset + a few model-registry fields we need to
 *  reason about reasoning support and constrained thinking levels. */
export interface WorkflowModelChoice {
	/** Provider id, e.g. "openai-codex" or "gonka". */
	provider: string;
	/** Model id within the provider. */
	id: string;
	/** Canonical `"provider/id"` form for stable comparison/rendering. */
	fullId: string;
	/** Optional human-friendly name from the registry. */
	name?: string;
	/** True when the model advertises reasoning/thinking support. */
	reasoning?: boolean;
	/** Optional per-level map; partial (only the levels the registry
	 *  actually advertised), `null` entries mean "unsupported" (matches
	 *  pi-subagents semantics for skipping unsupported levels). */
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface WorkflowModelCollection {
	choices: WorkflowModelChoice[];
	/** True when `ctx.modelRegistry.getAvailable()` threw or returned no
	 *  usable entries. Callers should surface this in the UI. */
	degraded: boolean;
	/** Human-readable warning when collection degraded. */
	warning?: string;
}

/** Minimal shape of the model registry surface the helper actually uses.
 *  Tests can pass a stub matching this shape. */
export interface WorkflowModelRegistryLike {
	getAvailable(): unknown[];
}

// ============================================================================
// Model collection / Gonka availability / thinking-level helpers
// ============================================================================

function normalizeThinkingLevelMap(value: unknown): WorkflowModelChoice["thinkingLevelMap"] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Partial<Record<ThinkingLevel, string | null>> = {};
	for (const level of THINKING_LEVELS) {
		const candidate = (value as Record<string, unknown>)[level];
		if (candidate === null) {
			out[level] = null;
		} else if (typeof candidate === "string") {
			out[level] = candidate;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function coerceModelEntry(entry: unknown): WorkflowModelChoice | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const candidate = entry as Record<string, unknown>;
	const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
	const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
	if (!provider || !id) return undefined;
	const name = typeof candidate.name === "string" ? candidate.name.trim() || undefined : undefined;
	const reasoning = typeof candidate.reasoning === "boolean" ? candidate.reasoning : undefined;
	const thinkingLevelMap = normalizeThinkingLevelMap(candidate.thinkingLevelMap);
	return {
		provider,
		id,
		fullId: `${provider}/${id}`,
		name,
		reasoning,
		thinkingLevelMap,
	};
}

/** Collects available model choices from a model-registry-like surface.
 *  Safe against throws and empty registries; never crashes. */
export function collectWorkflowModelChoices(registry: WorkflowModelRegistryLike | undefined | null): WorkflowModelCollection {
	if (!registry || typeof registry.getAvailable !== "function") {
		return { choices: [], degraded: true, warning: "model registry unavailable" };
	}
	let raw: unknown[];
	try {
		raw = registry.getAvailable();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { choices: [], degraded: true, warning: `model registry threw: ${message}` };
	}
	if (!Array.isArray(raw) || raw.length === 0) {
		return { choices: [], degraded: true, warning: "no models with configured auth" };
	}
	const seen = new Set<string>();
	const out: WorkflowModelChoice[] = [];
	for (const entry of raw) {
		const choice = coerceModelEntry(entry);
		if (!choice) continue;
		if (seen.has(choice.fullId)) continue;
		seen.add(choice.fullId);
		out.push(choice);
	}
	out.sort((a, b) => a.fullId.localeCompare(b.fullId));
	if (out.length === 0) {
		return { choices: [], degraded: true, warning: "no usable models in registry" };
	}
	return { choices: out, degraded: false };
}

/** True when at least one available choice advertises the `gonka` provider. */
export function isGonkaAvailable(choices: WorkflowModelChoice[]): boolean {
	for (const choice of choices) {
		if (choice.provider.trim().toLowerCase() === "gonka") return true;
	}
	return false;
}

/** Returns the thinking levels a given model choice supports. Matches
 *  pi-subagents semantics exactly: non-reasoning models return `["off"]`;
 *  missing choice / missing map / unknown reasoning return the full
 *  THINKING_LEVELS; for `reasoning: true` + a `thinkingLevelMap`, levels
 *  whose map value is `null` are excluded and `xhigh` is excluded when
 *  the map value is `undefined`. When the filtered list is empty we
 *  return it as-is (no implicit full-list fallback) so the UI can
 *  surface that the registry reported nothing usable for that level. */
export function getSupportedWorkflowThinkingLevels(choice: WorkflowModelChoice | undefined): ThinkingLevel[] {
	if (!choice) return [...THINKING_LEVELS];
	if (choice.reasoning === false) return ["off"];
	if (choice.reasoning === true) {
		if (choice.thinkingLevelMap) {
			const supported: ThinkingLevel[] = [];
			for (const level of THINKING_LEVELS) {
				const value = choice.thinkingLevelMap[level];
				if (value === null) continue;
				if (level === "xhigh" && value === undefined) continue;
				supported.push(level);
			}
			return supported;
		}
		return [...THINKING_LEVELS];
	}
	return [...THINKING_LEVELS];
}

// ============================================================================
// Staged draft + safe local-config payload
// ============================================================================

/** Profile choice for the staged draft. `custom` is implicit: when at least
 *  one role has a non-empty `customEdits` entry. */
export type WorkflowDraftProfile = "default" | "gonka" | "custom";

export interface WorkflowRuntimeDraft {
	delegateDisplay?: "headless" | "pane" | "auto";
	delegatePaneAutoClose?: boolean;
	reviewerSwarmEnabled?: boolean;
	reviewerSwarmMaxConcurrency?: number;
	deepPlanningEnabled?: boolean;
	deepPlanningPlannerCount?: number;
	deepPlanningRounds?: number;
	deepPlanningMaxConcurrency?: number;
}

/** Per-role explicit edit. `cleared: true` removes the role from the
 *  local override entirely. Otherwise the helper writes the supplied
 *  fields. Absence of an entry = role untouched (preserve existing). */
export interface WorkflowRoleEdit {
	cleared?: true;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export type WorkflowCustomEdits = Partial<Record<AgentName, WorkflowRoleEdit>>;

const DELEGATE_AGENT_ROLES: readonly DelegateAgentName[] = ["coder", "reviewer"] as const;

export type WorkflowFallbackEdits = Partial<Record<DelegateAgentName, WorkflowRoleEdit>>;

export interface WorkflowConfigDraft {
	profile: WorkflowDraftProfile;
	runtime: WorkflowRuntimeDraft;
	customEdits: WorkflowCustomEdits;
	fallbackEdits?: WorkflowFallbackEdits;
}

/** True when the draft has any staged change that would write to disk. */
export function isWorkflowDraftEmpty(draft: WorkflowConfigDraft): boolean {
	const runtimeEmpty =
		draft.runtime.delegateDisplay === undefined
		&& draft.runtime.delegatePaneAutoClose === undefined
		&& draft.runtime.reviewerSwarmEnabled === undefined
		&& draft.runtime.reviewerSwarmMaxConcurrency === undefined
		&& draft.runtime.deepPlanningEnabled === undefined
		&& draft.runtime.deepPlanningPlannerCount === undefined
		&& draft.runtime.deepPlanningRounds === undefined
		&& draft.runtime.deepPlanningMaxConcurrency === undefined;
	const customEmpty = Object.keys(draft.customEdits).length === 0;
	const fallbackEmpty = Object.keys(draft.fallbackEdits ?? {}).length === 0;
	return runtimeEmpty && customEmpty && fallbackEmpty && draft.profile === "default";
}

/** Inspect helpers — used by the preview to call out preserved role
 *  overrides and the explicit custom edits the user is staging. */
export interface WorkflowPayloadSummary {
	profile: WorkflowDraftProfile;
	writesAgents: boolean;
	/** Roles the user explicitly cleared (will be removed from local). */
	clearedRoles: AgentName[];
	/** Roles the user explicitly edited (will be written/overwritten). */
	editedRoles: AgentName[];
	/** Roles whose existing local override will be preserved untouched. */
	preservedRoles: AgentName[];
	runtimeChanges: string[];
	fallbackClearedRoles: DelegateAgentName[];
	fallbackEditedRoles: DelegateAgentName[];
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isDelegateDisplayMode(value: unknown): value is "headless" | "pane" | "auto" {
	return value === "headless" || value === "pane" || value === "auto";
}

/** Clones the existing local JSON so we never mutate caller's data. */
function cloneExistingLocal(existingLocal: unknown): Record<string, unknown> {
	return asPlainObject(existingLocal) ? { ...asPlainObject(existingLocal)! } : {};
}

/** Builds the next `.pi/workflow.local.json` v1-compatible payload.
 *  Preservation: unknown top-level fields kept; `agents` preserved unless
 *  explicitly edited/cleared; `cleared: true` drops a role; absent roles
 *  stay untouched. */
export function buildWorkflowLocalPayload(existingLocal: unknown, draft: WorkflowConfigDraft): WorkflowConfig {
	const base = cloneExistingLocal(existingLocal);
	const existingAgents = (asPlainObject(base.agents) ?? {}) as Record<string, unknown>;

	// ---- profile ----
	if (draft.profile === "default") {
		base.profile = "default";
	} else if (draft.profile === "gonka") {
		base.profile = "gonka-hybrid";
	} else {
		// `custom` does not write a `profile` field; the explicit role edits
		// below are the source of truth. Drop any stale `profile` from the
		// existing local (e.g. leftover "gonka-hybrid" or "default") so the
		// saved file reflects that the user is no longer on a built-in
		// profile.
		delete base.profile;
	}

	// ---- runtime fields ----
	if (draft.runtime.delegateDisplay !== undefined) {
		if (isDelegateDisplayMode(draft.runtime.delegateDisplay)) {
			base.delegateDisplay = draft.runtime.delegateDisplay;
		}
	}
	if (draft.runtime.delegatePaneAutoClose !== undefined) {
		base.delegatePaneAutoClose = Boolean(draft.runtime.delegatePaneAutoClose);
	}

	// Clone nested runtime objects before mutating; never reuse references
	// from the caller-provided `existingLocal` (pure helper contract).
	const existingReviewerSwarm = { ...(asPlainObject(base.reviewerSwarm) ?? {}) };
	if (draft.runtime.reviewerSwarmEnabled !== undefined) {
		existingReviewerSwarm.enabled = Boolean(draft.runtime.reviewerSwarmEnabled);
	}
	if (draft.runtime.reviewerSwarmMaxConcurrency !== undefined) {
		const value = Number(draft.runtime.reviewerSwarmMaxConcurrency);
		if (Number.isFinite(value)) existingReviewerSwarm.maxConcurrency = value;
	}
	if (Object.keys(existingReviewerSwarm).length > 0) {
		base.reviewerSwarm = existingReviewerSwarm;
	}

	const existingDeepPlanning = { ...(asPlainObject(base.deepPlanning) ?? {}) };
	if (draft.runtime.deepPlanningEnabled !== undefined) {
		existingDeepPlanning.enabled = Boolean(draft.runtime.deepPlanningEnabled);
	}
	if (draft.runtime.deepPlanningPlannerCount !== undefined) {
		const value = Number(draft.runtime.deepPlanningPlannerCount);
		if (Number.isFinite(value)) existingDeepPlanning.plannerCount = value;
	}
	if (draft.runtime.deepPlanningRounds !== undefined) {
		const value = Number(draft.runtime.deepPlanningRounds);
		if (Number.isFinite(value)) existingDeepPlanning.rounds = value;
	}
	if (draft.runtime.deepPlanningMaxConcurrency !== undefined) {
		const value = Number(draft.runtime.deepPlanningMaxConcurrency);
		if (Number.isFinite(value)) existingDeepPlanning.maxConcurrency = value;
	}
	if (Object.keys(existingDeepPlanning).length > 0) {
		base.deepPlanning = existingDeepPlanning;
	}

	// ---- agents: preserve existing unless explicit edit/clear ----
	// Built-in (default/gonka) and custom profile paths share the same
	// preservation rules: roles absent from `customEdits` keep their
	// existing local entry verbatim, `cleared: true` drops the role, and
	// explicit field edits merge into the role entry. This is what
	// protects the "Default profile does not clobber custom agents" and
	// "Gonka does not clobber Brain" invariants.
	// Clone every existing role record up-front so untouched roles keep
	// their identity but no longer share a reference with `existingLocal`;
	// edits below also work from a fresh per-role clone.
	const nextAgents: Record<string, unknown> = {};
	for (const [role, value] of Object.entries(existingAgents)) {
		nextAgents[role] = asPlainObject(value) ? { ...asPlainObject(value)! } : value;
	}
	for (const role of AGENT_ROLES) {
		const edit = draft.customEdits[role];
		if (!edit) continue;
		if (edit.cleared) {
			delete nextAgents[role];
			continue;
		}
		const current = { ...(asPlainObject(nextAgents[role]) ?? {}) };
		if (edit.provider !== undefined) current.provider = edit.provider;
		if (edit.model !== undefined) current.model = edit.model;
		if (edit.thinkingLevel !== undefined && isThinkingLevel(edit.thinkingLevel)) {
			current.thinkingLevel = edit.thinkingLevel;
		}
		nextAgents[role] = current;
	}

	if (Object.keys(nextAgents).length > 0) {
		base.agents = nextAgents;
	} else {
		delete base.agents;
	}

	// ---- delegateFallbacks: preserve existing unless explicit edit/clear ----
	const nextFallbacks: Record<string, unknown> = { ...(asPlainObject(base.delegateFallbacks) ?? {}) };
	for (const role of DELEGATE_AGENT_ROLES) {
		const edit = draft.fallbackEdits?.[role];
		if (!edit) continue;
		if (edit.cleared) {
			delete nextFallbacks[role];
			continue;
		}
		const current = { ...(asPlainObject(nextFallbacks[role]) ?? {}) };
		if (edit.provider !== undefined) current.provider = edit.provider;
		if (edit.model !== undefined) current.model = edit.model;
		if (edit.thinkingLevel !== undefined && isThinkingLevel(edit.thinkingLevel)) {
			current.thinkingLevel = edit.thinkingLevel;
		}
		nextFallbacks[role] = current;
	}
	if (Object.keys(nextFallbacks).length > 0) {
		base.delegateFallbacks = nextFallbacks;
	} else {
		delete base.delegateFallbacks;
	}

	return base as WorkflowConfig;
}

/** Structured summary of staged changes for preview/confirmation. */
export function summarizeWorkflowDraft(existingLocal: unknown, draft: WorkflowConfigDraft): WorkflowPayloadSummary {
	const existing = asPlainObject(existingLocal);
	const existingAgents = (asPlainObject(existing?.agents) ?? {}) as Record<string, unknown>;

	const clearedRoles: AgentName[] = [];
	const editedRoles: AgentName[] = [];
	const preservedRoles: AgentName[] = [];
	for (const role of AGENT_ROLES) {
		const edit = draft.customEdits[role];
		if (edit?.cleared) {
			clearedRoles.push(role);
			continue;
		}
		const touched = Boolean(
			edit && (edit.provider !== undefined || edit.model !== undefined || edit.thinkingLevel !== undefined),
		);
		if (touched) {
			editedRoles.push(role);
			continue;
		}
		if (existingAgents[role] !== undefined) preservedRoles.push(role);
	}

	const runtimeChanges: string[] = [];
	if (draft.runtime.delegateDisplay !== undefined) runtimeChanges.push(`delegateDisplay=${draft.runtime.delegateDisplay}`);
	if (draft.runtime.delegatePaneAutoClose !== undefined) runtimeChanges.push(`delegatePaneAutoClose=${draft.runtime.delegatePaneAutoClose}`);
	if (draft.runtime.reviewerSwarmEnabled !== undefined) runtimeChanges.push(`reviewerSwarm.enabled=${draft.runtime.reviewerSwarmEnabled}`);
	if (draft.runtime.reviewerSwarmMaxConcurrency !== undefined) runtimeChanges.push(`reviewerSwarm.maxConcurrency=${draft.runtime.reviewerSwarmMaxConcurrency}`);
	if (draft.runtime.deepPlanningEnabled !== undefined) runtimeChanges.push(`deepPlanning.enabled=${draft.runtime.deepPlanningEnabled}`);
	if (draft.runtime.deepPlanningPlannerCount !== undefined) runtimeChanges.push(`deepPlanning.plannerCount=${draft.runtime.deepPlanningPlannerCount}`);
	if (draft.runtime.deepPlanningRounds !== undefined) runtimeChanges.push(`deepPlanning.rounds=${draft.runtime.deepPlanningRounds}`);
	if (draft.runtime.deepPlanningMaxConcurrency !== undefined) runtimeChanges.push(`deepPlanning.maxConcurrency=${draft.runtime.deepPlanningMaxConcurrency}`);

	const writesAgents = clearedRoles.length > 0 || editedRoles.length > 0;

	const fallbackClearedRoles: DelegateAgentName[] = [];
	const fallbackEditedRoles: DelegateAgentName[] = [];
	for (const role of DELEGATE_AGENT_ROLES) {
		const edit = draft.fallbackEdits?.[role];
		if (edit?.cleared) {
			fallbackClearedRoles.push(role);
		} else if (edit && (edit.provider !== undefined || edit.model !== undefined || edit.thinkingLevel !== undefined)) {
			fallbackEditedRoles.push(role);
		}
	}

	return {
		profile: draft.profile,
		writesAgents,
		clearedRoles,
		editedRoles,
		preservedRoles,
		runtimeChanges,
		fallbackClearedRoles,
		fallbackEditedRoles,
	};
}

// ============================================================================
// Preview text helper
// ============================================================================

function asProfileLabel(profile: WorkflowDraftProfile): string {
	if (profile === "default") return "Default";
	if (profile === "gonka") return "Gonka";
	return "Custom per-role";
}

export interface WorkflowPreviewOptions {
	/** Optional pretty-print indent for the JSON body. */
	indent?: number;
	/** Optional extra warning lines to surface above the JSON. */
	extraWarnings?: string[];
}

/** Multi-line preview string for the confirm step. */
export function buildWorkflowLocalPreviewText(
	existingLocal: unknown,
	draft: WorkflowConfigDraft,
	options: WorkflowPreviewOptions = {},
): string {
	const summary = summarizeWorkflowDraft(existingLocal, draft);
	const payload = buildWorkflowLocalPayload(existingLocal, draft);
	const lines: string[] = [];
	lines.push(`Profile: ${asProfileLabel(summary.profile)}`);
	if (summary.runtimeChanges.length === 0) {
		lines.push("Runtime settings: (no changes)");
	} else {
		lines.push("Runtime settings:");
		for (const change of summary.runtimeChanges) lines.push(`  - ${change}`);
	}

	if (summary.clearedRoles.length > 0) {
		lines.push(`Cleared custom roles: ${summary.clearedRoles.join(", ")}`);
	}
	if (summary.editedRoles.length > 0) {
		lines.push(`Edited custom roles: ${summary.editedRoles.join(", ")}`);
	}
	if (summary.preservedRoles.length > 0) {
		lines.push(
			`Preserved custom role overrides: ${summary.preservedRoles.join(", ")}. `
				+ "These take precedence until edited/cleared under Custom per-role.",
		);
	}
	if (summary.fallbackClearedRoles.length > 0) {
		lines.push(`Cleared delegate fallbacks: ${summary.fallbackClearedRoles.join(", ")}`);
	}
	if (summary.fallbackEditedRoles.length > 0) {
		lines.push(`Edited delegate fallbacks: ${summary.fallbackEditedRoles.join(", ")}`);
	}

	if (options.extraWarnings && options.extraWarnings.length > 0) {
		for (const warning of options.extraWarnings) lines.push(`Warning: ${warning}`);
	}

	lines.push("");
	lines.push("--- .pi/workflow.local.json preview ---");
	lines.push(JSON.stringify(payload, null, options.indent ?? 2));
	return lines.join("\n");
}
