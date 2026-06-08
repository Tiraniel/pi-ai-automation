/**
 * Pure v1 / v2 normalizers and the lossless v1 -> v2 conversion helper.
 *
 * All functions here are side-effect free. They take `unknown` JSON input
 * (typically the result of `JSON.parse`) and return a typed v1 or v2 shape
 * with invalid fields dropped. They never throw on bad input; they only
 * return a `Record<string, unknown> | undefined` for non-object inputs so
 * the caller can decide how to report the failure.
 *
 * v1 normalize is a pass-through: it preserves the existing field set and
 * semantics of `extensions/brain-workflow.ts`'s `WorkflowConfig` so v1 files
 * keep working unchanged. v2 normalize applies the v2 shape, including
 * defaults for the active-agents list.
 */

import {
	asAgentRole,
	asArray,
	asBoolean,
	asDelegateDisplayMode,
	asFlowDirection,
	asInteger,
	asOptionalStringArray,
	asQualityGateKind,
	asRecord,
	asString,
	asStringArray,
	asThinkingLevel,
} from "./guards.js";
import { readDeepPlanningConfig } from "./deep-planning.js";
import {
	AGENT_ROLES,
	type AgentRole,
	type FlowDirection,
	type V1AgentPreset,
	type V1ReviewerSwarmConfig,
	type V1WorkflowConfig,
	type V2AgentCatalog,
	type V2AgentCatalogEntry,
	type V2FlowStep,
	type V2ModelPreset,
	type V2ModelPresetsCatalog,
	type V2PromptPackRefEntry,
	type V2PromptPacksCatalog,
	type V2QualityGate,
	type V2QualityGatesCatalog,
	type V2RoleBinding,
	type V2ToolProfile,
	type V2ToolProfilesCatalog,
	type V2Workflow,
	type V2WorkflowMeta,
	type V2WorkflowReferences,
	WORKFLOW_CONFIG_VERSION,
} from "../types.js";

// ---------- v1 normalizer ----------

function normalizeV1AgentPreset(value: unknown): V1AgentPreset | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const preset: V1AgentPreset = {};
	const provider = asString(record.provider);
	if (provider !== undefined) preset.provider = provider;
	const model = asString(record.model);
	if (model !== undefined) preset.model = model;
	const thinkingLevel = asThinkingLevel(record.thinkingLevel);
	if (thinkingLevel !== undefined) preset.thinkingLevel = thinkingLevel;
	const tools = asStringArray(record.tools);
	if (tools !== undefined) preset.tools = tools;
	const instructions = asString(record.instructions);
	if (instructions !== undefined) preset.instructions = instructions;
	const includeKarpathy = asBoolean(record.includeKarpathyGuidelines);
	if (includeKarpathy !== undefined) preset.includeKarpathyGuidelines = includeKarpathy;
	return preset;
}

function normalizeV1ReviewerSwarm(value: unknown): V1ReviewerSwarmConfig | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const out: V1ReviewerSwarmConfig = {};
	const enabled = asBoolean(record.enabled);
	if (enabled !== undefined) out.enabled = enabled;
	const max = asInteger(record.maxConcurrency);
	if (max !== undefined) out.maxConcurrency = max;
	const targets = asStringArray(record.targets);
	if (targets !== undefined) out.targets = targets;
	return out;
}

function normalizeV1DelegateFallbacks(value: unknown): V1WorkflowConfig["delegateFallbacks"] | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const out: NonNullable<V1WorkflowConfig["delegateFallbacks"]> = {};
	const coder = normalizeV1AgentPreset(record.coder);
	if (coder) out.coder = coder;
	const reviewer = normalizeV1AgentPreset(record.reviewer);
	if (reviewer) out.reviewer = reviewer;
	return out.coder || out.reviewer ? out : undefined;
}

/**
 * Normalize a v1 workflow config. Pass-through: every preserved field keeps
 * its v1 meaning so the resolved effective config is identical to what
 * `extensions/brain-workflow.ts` would produce after its own JSON parse and
 * deep-merge with the built-in default.
 */
export function normalizeV1Config(input: unknown): V1WorkflowConfig | undefined {
	const record = asRecord(input);
	if (!record) return undefined;
	const out: V1WorkflowConfig = {};
	const autoApplyBrain = asBoolean(record.autoApplyBrain);
	if (autoApplyBrain !== undefined) out.autoApplyBrain = autoApplyBrain;
	const profile = asString(record.profile);
	if (profile !== undefined) out.profile = profile;
	const agents = asRecord(record.agents);
	if (agents) {
		const normalized: Record<string, V1AgentPreset> = {};
		for (const [name, preset] of Object.entries(agents)) {
			const p = normalizeV1AgentPreset(preset);
			if (p) normalized[name] = p;
		}
		out.agents = normalized;
	}
	const reviewer = normalizeV1ReviewerSwarm(record.reviewerSwarm);
	if (reviewer) out.reviewerSwarm = reviewer;
	const delegateFallbacks = normalizeV1DelegateFallbacks(record.delegateFallbacks);
	if (delegateFallbacks) out.delegateFallbacks = delegateFallbacks;
	const deepPlanning = readDeepPlanningConfig(record);
	if (deepPlanning) out.deepPlanning = deepPlanning;
	const display = asDelegateDisplayMode(record.delegateDisplay);
	if (display !== undefined) out.delegateDisplay = display;
	const paneAutoClose = asBoolean(record.delegatePaneAutoClose);
	if (paneAutoClose !== undefined) out.delegatePaneAutoClose = paneAutoClose;
	return out;
}

// ---------- v2 catalog normalizers ----------

function normalizeModelPreset(value: unknown): V2ModelPreset | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const id = asString(record.id);
	const provider = asString(record.provider);
	const model = asString(record.model);
	if (!id || !provider || !model) return undefined;
	const preset: V2ModelPreset = { id, provider, model };
	const thinkingLevel = asThinkingLevel(record.thinkingLevel);
	if (thinkingLevel !== undefined) preset.thinkingLevel = thinkingLevel;
	return preset;
}

export function normalizeModelPresetsCatalog(input: unknown): V2ModelPresetsCatalog | undefined {
	const record = asRecord(input);
	if (!record) return undefined;
	const version = record.version;
	if (version !== WORKFLOW_CONFIG_VERSION) return undefined;
	const list = asArray(record.presets);
	if (!list) return undefined;
	const presets: V2ModelPreset[] = [];
	for (const entry of list) {
		const p = normalizeModelPreset(entry);
		if (p) presets.push(p);
	}
	return { version: WORKFLOW_CONFIG_VERSION, presets };
}

function normalizeToolProfile(value: unknown): V2ToolProfile | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const id = asString(record.id);
	const tools = asStringArray(record.tools);
	if (!id || !tools) return undefined;
	const profile: V2ToolProfile = { id, tools };
	const includeKarpathy = asBoolean(record.includeKarpathyGuidelines);
	if (includeKarpathy !== undefined) profile.includeKarpathyGuidelines = includeKarpathy;
	return profile;
}

export function normalizeToolProfilesCatalog(input: unknown): V2ToolProfilesCatalog | undefined {
	const record = asRecord(input);
	if (!record) return undefined;
	if (record.version !== WORKFLOW_CONFIG_VERSION) return undefined;
	const list = asArray(record.profiles);
	if (!list) return undefined;
	const profiles: V2ToolProfile[] = [];
	for (const entry of list) {
		const p = normalizeToolProfile(entry);
		if (p) profiles.push(p);
	}
	return { version: WORKFLOW_CONFIG_VERSION, profiles };
}

function normalizePromptPack(value: unknown): V2PromptPackRefEntry | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const id = asString(record.id);
	if (!id) return undefined;
	const pack: V2PromptPackRefEntry = { id };
	const path = asString(record.path);
	if (path !== undefined) pack.path = path;
	const inline = asString(record.inline);
	if (inline !== undefined) pack.inline = inline;
	const description = asString(record.description);
	if (description !== undefined) pack.description = description;
	return pack;
}

export function normalizePromptPacksCatalog(input: unknown): V2PromptPacksCatalog | undefined {
	const record = asRecord(input);
	if (!record) return undefined;
	if (record.version !== WORKFLOW_CONFIG_VERSION) return undefined;
	const list = asArray(record.packs);
	if (!list) return undefined;
	const packs: V2PromptPackRefEntry[] = [];
	for (const entry of list) {
		const p = normalizePromptPack(entry);
		if (p) packs.push(p);
	}
	return { version: WORKFLOW_CONFIG_VERSION, packs };
}

function normalizeQualityGate(value: unknown): V2QualityGate | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const id = asString(record.id);
	if (!id) return undefined;
	const gate: V2QualityGate = { id };
	const description = asString(record.description);
	if (description !== undefined) gate.description = description;
	const kind = asQualityGateKind(record.kind);
	if (kind !== undefined) gate.kind = kind;
	const command = asString(record.command);
	if (command !== undefined) gate.command = command;
	return gate;
}

export function normalizeQualityGatesCatalog(input: unknown): V2QualityGatesCatalog | undefined {
	const record = asRecord(input);
	if (!record) return undefined;
	if (record.version !== WORKFLOW_CONFIG_VERSION) return undefined;
	const list = asArray(record.gates);
	if (!list) return undefined;
	const gates: V2QualityGate[] = [];
	for (const entry of list) {
		const g = normalizeQualityGate(entry);
		if (g) gates.push(g);
	}
	return { version: WORKFLOW_CONFIG_VERSION, gates };
}

function normalizeAgentCatalogEntry(value: unknown): V2AgentCatalogEntry | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const id = asString(record.id);
	const role = asAgentRole(record.role);
	if (!id || !role) return undefined;
	const entry: V2AgentCatalogEntry = { id, role };
	const modelPreset = asString(record.modelPreset);
	if (modelPreset !== undefined) entry.modelPreset = modelPreset;
	const toolProfile = asString(record.toolProfile);
	if (toolProfile !== undefined) entry.toolProfile = toolProfile;
	const promptPacks = asOptionalStringArray(record.promptPacks);
	if (promptPacks !== undefined) entry.promptPacks = promptPacks;
	const qualityGates = asOptionalStringArray(record.qualityGates);
	if (qualityGates !== undefined) entry.qualityGates = qualityGates;
	const overrides = asRecord(record.overrides);
	if (overrides) {
		const ov: V2AgentCatalogEntry["overrides"] = {};
		const provider = asString(overrides.provider);
		if (provider !== undefined) ov.provider = provider;
		const model = asString(overrides.model);
		if (model !== undefined) ov.model = model;
		const thinkingLevel = asThinkingLevel(overrides.thinkingLevel);
		if (thinkingLevel !== undefined) ov.thinkingLevel = thinkingLevel;
		const tools = asStringArray(overrides.tools);
		if (tools !== undefined) ov.tools = tools;
		const instructions = asString(overrides.instructions);
		if (instructions !== undefined) ov.instructions = instructions;
		const includeKarpathy = asBoolean(overrides.includeKarpathyGuidelines);
		if (includeKarpathy !== undefined) ov.includeKarpathyGuidelines = includeKarpathy;
		if (Object.keys(ov).length > 0) entry.overrides = ov;
	}
	return entry;
}

export function normalizeAgentCatalog(input: unknown): V2AgentCatalog | undefined {
	const record = asRecord(input);
	if (!record) return undefined;
	if (record.version !== WORKFLOW_CONFIG_VERSION) return undefined;
	const list = asArray(record.agents);
	if (!list) return undefined;
	const agents: V2AgentCatalogEntry[] = [];
	for (const entry of list) {
		const a = normalizeAgentCatalogEntry(entry);
		if (a) agents.push(a);
	}
	return { version: WORKFLOW_CONFIG_VERSION, agents };
}

// ---------- v2 workflow normalizer ----------

function normalizeFlowStep(value: unknown): V2FlowStep | undefined {
	const record = asRecord(value);
	if (!record) {
		// Allow a shorthand string entry like "coder" -> { role: "coder" }.
		const role = asAgentRole(value);
		if (role) return { role };
		return undefined;
	}
	const role = asAgentRole(record.role);
	if (!role) return undefined;
	const step: V2FlowStep = { role };
	const id = asString(record.id);
	if (id !== undefined) step.id = id;
	return step;
}

function normalizeRoleBinding(value: unknown): V2RoleBinding | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const role = asAgentRole(record.role);
	const agent = asString(record.agent);
	if (!role || !agent) return undefined;
	return { role, agent };
}

function normalizeWorkflowMeta(value: unknown): V2WorkflowMeta | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const out: V2WorkflowMeta = {};
	const name = asString(record.name);
	if (name !== undefined) out.name = name;
	const description = asString(record.description);
	if (description !== undefined) out.description = description;
	const active = asArray(record.activeAgents);
	if (active) {
		const roles: AgentRole[] = [];
		for (const entry of active) {
			const r = asAgentRole(entry);
			if (r) roles.push(r);
		}
		if (roles.length > 0) out.activeAgents = roles;
	}
	return out;
}

function normalizeWorkflowReferences(value: unknown): V2WorkflowReferences | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const out: V2WorkflowReferences = {};
	const fields: (keyof V2WorkflowReferences)[] = [
		"agentCatalog",
		"modelPresets",
		"toolProfiles",
		"promptPacks",
		"qualityGates",
	];
	for (const key of fields) {
		const v = asString(record[key]);
		if (v !== undefined) out[key] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalize a v2 workflow file.
 *
 * Required: `flow` and `roles` arrays. Normalization fails (returns
 * `undefined`) when either is absent, empty, or contains any malformed
 * entry — silent dropping of malformed entries is intentionally rejected
 * so misconfigured workflows surface at load time rather than as silent
 * no-op runs.
 *
 * Defaults: `meta.activeAgents` is filled with the standard three roles
 * when the field is omitted. `direction` defaults to `"sequential"`.
 */
export function normalizeV2Workflow(input: unknown): V2Workflow | undefined {
	const record = asRecord(input);
	if (!record) return undefined;
	if (record.version !== WORKFLOW_CONFIG_VERSION) return undefined;
	const flowRaw = asArray(record.flow);
	if (!flowRaw || flowRaw.length === 0) return undefined;
	const flow: V2FlowStep[] = [];
	for (const entry of flowRaw) {
		const step = normalizeFlowStep(entry);
		if (!step) return undefined;
		flow.push(step);
	}
	const rolesRaw = asArray(record.roles);
	if (!rolesRaw || rolesRaw.length === 0) return undefined;
	const roles: V2RoleBinding[] = [];
	for (const entry of rolesRaw) {
		const binding = normalizeRoleBinding(entry);
		if (!binding) return undefined;
		roles.push(binding);
	}
	const meta = normalizeWorkflowMeta(record.meta);
	if (meta && !meta.activeAgents) {
		meta.activeAgents = [...AGENT_ROLES];
	}
	const direction: FlowDirection = asFlowDirection(record.direction) ?? "sequential";
	const references = normalizeWorkflowReferences(record.references);
	const deepPlanning = readDeepPlanningConfig(record);
	return {
		version: WORKFLOW_CONFIG_VERSION,
		...(meta ? { meta } : {}),
		direction,
		flow,
		roles,
		...(references ? { references } : {}),
		...(deepPlanning ? { deepPlanning } : {}),
	};
}

// ---------- v1 -> v2 conversion (lossless) ----------

/**
 * Convert a v1 `AgentPreset` into a v2 `V2AgentCatalogEntry` whose
 * `overrides` block carries the v1 fields verbatim. The v2 id is the role
 * name (or `v1-<name>` if the role is not a known v1 role), so identity is
 * preserved across the migration.
 */
export function v1PresetToV2Agent(
	name: string,
	preset: V1AgentPreset,
): V2AgentCatalogEntry {
	const overrides: NonNullable<V2AgentCatalogEntry["overrides"]> = {};
	if (preset.provider !== undefined) overrides.provider = preset.provider;
	if (preset.model !== undefined) overrides.model = preset.model;
	if (preset.thinkingLevel !== undefined) overrides.thinkingLevel = preset.thinkingLevel;
	if (preset.tools !== undefined) overrides.tools = [...preset.tools];
	if (preset.instructions !== undefined) overrides.instructions = preset.instructions;
	if (preset.includeKarpathyGuidelines !== undefined) {
		overrides.includeKarpathyGuidelines = preset.includeKarpathyGuidelines;
	}
	const role: AgentRole = (AGENT_ROLES as readonly string[]).includes(name)
		? (name as AgentRole)
		: "coder";
	const entry: V2AgentCatalogEntry = {
		id: name,
		role,
	};
	if (Object.keys(overrides).length > 0) entry.overrides = overrides;
	return entry;
}

/**
 * Convert a v1 `WorkflowConfig` into a v2 `V2Workflow` plus the matching
 * agent catalog. The conversion is lossless for the agent-catalog
 * surface: every v1 `agents.<role>` field is preserved in the
 * resulting catalog entry's `overrides` block. V1 runtime/delegate
 * settings (`autoApplyBrain`, `delegateDisplay`, `delegatePaneAutoClose`)
 * and the v1 `reviewerSwarm` block are intentionally NOT carried into
 * the v2 workflow — they remain v1-only for Slice 1 and continue to be
 * honored by the untouched v1 loader in `extensions/brain-workflow.ts`.
 * Reviewer-swarm configuration in v2 is owned by the quality-gate
 * catalog and the reviewer agent identity's `qualityGates`; a future
 * quality-gate migration is the right home for v1 reviewerSwarm.
 */
export function v1ConfigToV2Workflow(v1: V1WorkflowConfig): {
	workflow: V2Workflow;
	catalog: V2AgentCatalog;
} {
	const agents: V2AgentCatalogEntry[] = [];
	const roleBindings: V2RoleBinding[] = [];
	if (v1.agents) {
		for (const [name, preset] of Object.entries(v1.agents)) {
			const entry = v1PresetToV2Agent(name, preset);
			agents.push(entry);
			roleBindings.push({ role: entry.role, agent: entry.id });
		}
	}
	const flow: V2FlowStep[] = roleBindings.length > 0
		? roleBindings.map((b) => ({ role: b.role }))
		: [];

	const workflow: V2Workflow = {
		version: WORKFLOW_CONFIG_VERSION,
		meta: {
			name: v1.profile ? `v1-profile:${v1.profile}` : "v1-migrated",
			description: "Migrated from a v1 workflow.json (preserved verbatim by the v1 -> v2 shim).",
			activeAgents: [...AGENT_ROLES],
		},
		direction: "sequential",
		flow,
		roles: roleBindings,
	};

	const catalog: V2AgentCatalog = {
		version: WORKFLOW_CONFIG_VERSION,
		agents,
	};

	return { workflow, catalog };
}
