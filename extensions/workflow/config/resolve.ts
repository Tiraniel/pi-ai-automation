/**
 * Pure v2 resolver.
 *
 * Composes a normalized `V2Workflow` with the in-memory `V2CatalogBundle`
 * into `V2ResolvedWorkflow`: one resolved identity per role binding, a
 * derived reviewer-swarm goal projection, and a list of diagnostics for
 * any missing or out-of-policy references.
 *
 * The resolver is side-effect free and never throws on bad input. It does
 * throw on programmer misuse (e.g. a non-record workflow) because that
 * indicates a broken pipeline rather than a runtime config problem.
 *
 * Resolution rules (per role binding):
 *   1. Look up the agent by id in the agent catalog. If missing, emit
 *      `agent-missing` and return a placeholder identity with the
 *      fallback source.
 *   2. Resolve the model: build from `agent.modelPreset` and overlay any
 *      `agent.overrides.{provider,model,thinkingLevel}` fields on top.
 *      A missing preset emits `model-preset-missing`. A partial provider/
 *      model override with no preset to fill the gap emits
 *      `model-override-incomplete` and leaves the missing field absent.
 *      If nothing is set the resolver emits `model-unresolved` and
 *      returns `{source: "fallback"}`. Each override field is honored
 *      independently: e.g. `overrides.thinkingLevel` overlays the
 *      preset's thinking level even when `provider`/`model` are not
 *      overridden.
 *   3. Resolve tools: build from `agent.toolProfile` and overlay any
 *      `agent.overrides.{tools,includeKarpathyGuidelines}` fields on top.
 *      A missing profile emits `tool-profile-missing`. `overrides.tools`,
 *      when present, replaces the profile's tool list;
 *      `overrides.includeKarpathyGuidelines` overlays the profile's flag
 *      independently.
 *   4. Resolve prompts: walk `agent.promptPacks` and look up each id in
 *      the prompt-packs catalog. Missing pack ids emit `prompt-pack-missing`
 *      and become `V2ResolvedPrompt` entries with `source: "missing"`.
 *   5. Resolve quality gates: walk `agent.qualityGates` and look up each
 *      id in the quality-gates catalog. Missing ids emit
 *      `quality-gate-missing`.
 *
 * The reviewer-swarm identity is a derived projection of the resolved
 * reviewer role identity: every resolved quality gate whose catalog gate
 * has `kind === "review-goal"` becomes a reviewer-swarm goal. The
 * resolved `reviewerSwarm` carries no `enabled`, `maxConcurrency`, or
 * other runtime settings — those remain v1-only.
 *
 * Precedence (high to low): `agent.overrides` > catalog refs. The active
 * flow is filtered by `meta.activeAgents`.
 */

import {
	AGENT_ROLES,
	type AgentRole,
	type V2AgentCatalog,
	type V2AgentCatalogEntry,
	type V2CatalogBundle,
	type V2Diagnostic,
	type V2FlowStep,
	type V2ModelPreset,
	type V2PromptPackRefEntry,
	type V2QualityGate,
	type V2ResolvedModel,
	type V2ResolvedPrompt,
	type V2ResolvedQualityGate,
	type V2ResolvedRoleIdentity,
	type V2ResolvedTools,
	type V2ResolvedWorkflow,
	type V2ReviewerSwarmResolved,
	type V2ToolProfile,
	type V2Workflow,
} from "../types.js";

function indexById<T extends { id: string }>(items: readonly T[] | undefined): Map<string, T> {
	const map = new Map<string, T>();
	if (!items) return map;
	for (const item of items) {
		if (!map.has(item.id)) map.set(item.id, item);
	}
	return map;
}

function pushDiag(
	out: V2Diagnostic[],
	diag: Omit<V2Diagnostic, "ref"> & { ref?: V2Diagnostic["ref"] },
): void {
	out.push({
		severity: diag.severity,
		code: diag.code,
		message: diag.message,
		...(diag.ref ? { ref: diag.ref } : {}),
	});
}

function resolveModelForAgent(
	agent: V2AgentCatalogEntry,
	presets: Map<string, V2ModelPreset>,
	diagnostics: V2Diagnostic[],
): V2ResolvedModel {
	const ov = agent.overrides;
	const preset = agent.modelPreset ? presets.get(agent.modelPreset) : undefined;
	if (agent.modelPreset && !preset) {
		pushDiag(diagnostics, {
			severity: "error",
			code: "model-preset-missing",
			message: `Agent "${agent.id}" references model preset "${agent.modelPreset}" which is not in the model-presets catalog.`,
			ref: { type: "model-preset", id: agent.modelPreset, role: agent.role },
		});
	}

	const hasProviderOv = ov?.provider !== undefined;
	const hasModelOv = ov?.model !== undefined;
	const hasThinkingOv = ov?.thinkingLevel !== undefined;
	const presetHasProvider = preset?.provider !== undefined;
	const presetHasModel = preset?.model !== undefined;

	// An override is "incomplete" when only one of provider/model is set
	// AND the preset does not supply the other. In that case the missing
	// field stays absent and a `model-override-incomplete` diagnostic is
	// emitted. When a preset supplies the missing field, the override
	// simply overlays on top of the preset and no diagnostic is raised.
	const overrideProviderOnly = hasProviderOv && !hasModelOv && !presetHasModel;
	const overrideModelOnly = hasModelOv && !hasProviderOv && !presetHasProvider;
	if (overrideProviderOnly || overrideModelOnly) {
		pushDiag(diagnostics, {
			severity: "error",
			code: "model-override-incomplete",
			message: `Agent "${agent.id}" overrides provider/model but only one of them is set and no preset fills the gap.`,
			ref: { type: "agent", id: agent.id, role: agent.role },
		});
	}

	if (!preset && !hasProviderOv && !hasModelOv && !hasThinkingOv) {
		pushDiag(diagnostics, {
			severity: "warning",
			code: "model-unresolved",
			message: `Agent "${agent.id}" has no modelPreset and no override; downstream code will fall back to its own defaults.`,
			ref: { type: "agent", id: agent.id, role: agent.role },
		});
		return { source: "fallback" };
	}

	// Overlay rule: the resolved identity is built bottom-up from the
	// preset (lowest) with each present override field replacing the
	// underlying value. A field with no preset and no override stays
	// absent. `thinkingLevel` overlays independently of provider/model.
	const resolved: V2ResolvedModel = { source: "preset" };
	if (preset) resolved.preset = preset;
	if (hasProviderOv) {
		resolved.provider = ov!.provider;
	} else if (presetHasProvider) {
		resolved.provider = preset!.provider;
	}
	if (hasModelOv) {
		resolved.model = ov!.model;
	} else if (presetHasModel) {
		resolved.model = preset!.model;
	}
	if (hasThinkingOv) {
		resolved.thinkingLevel = ov!.thinkingLevel;
	} else if (preset?.thinkingLevel !== undefined) {
		resolved.thinkingLevel = preset.thinkingLevel;
	}
	if (hasProviderOv || hasModelOv || hasThinkingOv) resolved.source = "override";
	if (
		resolved.provider === undefined &&
		resolved.model === undefined &&
		resolved.thinkingLevel === undefined
	) {
		return { source: "missing" };
	}
	return resolved;
}

function resolveToolsForAgent(
	agent: V2AgentCatalogEntry,
	profiles: Map<string, V2ToolProfile>,
	diagnostics: V2Diagnostic[],
): V2ResolvedTools {
	const ov = agent.overrides;
	const profile = agent.toolProfile ? profiles.get(agent.toolProfile) : undefined;
	if (agent.toolProfile && !profile) {
		pushDiag(diagnostics, {
			severity: "error",
			code: "tool-profile-missing",
			message: `Agent "${agent.id}" references tool profile "${agent.toolProfile}" which is not in the tool-profiles catalog.`,
			ref: { type: "tool-profile", id: agent.toolProfile, role: agent.role },
		});
	}

	const hasToolsOv = ov?.tools !== undefined;
	const hasKarpathyOv = ov?.includeKarpathyGuidelines !== undefined;

	if (!hasToolsOv && !profile && !hasKarpathyOv) {
		return { tools: [], source: "fallback" };
	}

	// Overlay rule: tools come from the override when present, otherwise
	// from the profile (or `[]` when neither is available).
	// `includeKarpathyGuidelines` overlays independently so a partial
	// override (e.g. only the guidelines flag) is honored.
	const resolved: V2ResolvedTools = { tools: [], source: "profile" };
	if (profile) resolved.profile = profile;
	if (hasToolsOv) {
		resolved.tools = [...ov!.tools!];
	} else if (profile) {
		resolved.tools = [...profile.tools];
	}
	const karpathyFromProfile = profile?.includeKarpathyGuidelines;
	if (hasKarpathyOv) {
		resolved.includeKarpathyGuidelines = ov!.includeKarpathyGuidelines;
	} else if (karpathyFromProfile !== undefined) {
		resolved.includeKarpathyGuidelines = karpathyFromProfile;
	}
	if (hasToolsOv) resolved.source = "override";
	else if (hasKarpathyOv) resolved.source = "override";
	return resolved;
}

function resolvePromptsForAgent(
	agent: V2AgentCatalogEntry,
	packs: Map<string, V2PromptPackRefEntry>,
	diagnostics: V2Diagnostic[],
): V2ResolvedPrompt[] {
	if (!agent.promptPacks) return [];
	const out: V2ResolvedPrompt[] = [];
	for (const packId of agent.promptPacks) {
		const pack = packs.get(packId);
		if (!pack) {
			pushDiag(diagnostics, {
				severity: "error",
				code: "prompt-pack-missing",
				message: `Agent "${agent.id}" references prompt pack "${packId}" which is not in the prompt-packs catalog.`,
				ref: { type: "prompt-pack", id: packId, role: agent.role },
			});
			out.push({ source: "missing" });
			continue;
		}
		const resolved: V2ResolvedPrompt = { pack, source: "pack" };
		if (pack.inline !== undefined) resolved.text = pack.inline;
		out.push(resolved);
	}
	return out;
}

function resolveQualityGatesForAgent(
	agent: V2AgentCatalogEntry,
	gates: Map<string, V2QualityGate>,
	diagnostics: V2Diagnostic[],
): V2ResolvedQualityGate[] {
	if (!agent.qualityGates) return [];
	const out: V2ResolvedQualityGate[] = [];
	for (const gateId of agent.qualityGates) {
		const gate = gates.get(gateId);
		if (!gate) {
			pushDiag(diagnostics, {
				severity: "error",
				code: "quality-gate-missing",
				message: `Agent "${agent.id}" references quality gate "${gateId}" which is not in the quality-gates catalog.`,
				ref: { type: "quality-gate", id: gateId, role: agent.role },
			});
			out.push({ source: "missing" });
			continue;
		}
		out.push({ gate, source: "catalog" });
	}
	return out;
}

/**
 * Derive the reviewer-swarm identity from the resolved reviewer role
 * identity. The v2 workflow has no `reviewerSwarm` field; the swarm
 * goals are owned by the quality-gate catalog and attached to the
 * reviewer agent through `agentCatalog.agents[].qualityGates`. Goals
 * are the resolved quality gates whose catalog gate has
 * `kind === "review-goal"`.
 *
 * This is a derived, read-only view: there are no `enabled`,
 * `maxConcurrency`, or other runtime settings on the v2 resolved
 * identity. Runtime swarm settings remain v1-only and are honored by
 * the untouched v1 loader in `extensions/brain-workflow.ts`.
 */
function deriveReviewerSwarm(
	reviewer: V2ResolvedRoleIdentity | undefined,
): V2ReviewerSwarmResolved {
	if (!reviewer) return { goals: [], goalIds: [] };
	const goals = reviewer.qualityGates.filter(
		(g) => g.gate?.kind === "review-goal",
	);
	const goalIds: string[] = [];
	for (const g of goals) {
		if (g.gate?.id !== undefined) goalIds.push(g.gate.id);
	}
	return { goals, goalIds };
}

function defaultActiveAgents(meta: V2Workflow["meta"]): AgentRole[] {
	if (meta?.activeAgents && meta.activeAgents.length > 0) {
		return [...meta.activeAgents];
	}
	return [...AGENT_ROLES];
}

function buildAgentIndex(
	catalog: V2AgentCatalog | undefined,
	diagnostics: V2Diagnostic[],
): Map<string, V2AgentCatalogEntry> {
	const map = new Map<string, V2AgentCatalogEntry>();
	if (!catalog) return map;
	for (const entry of catalog.agents) {
		if (map.has(entry.id)) {
			pushDiag(diagnostics, {
				severity: "warning",
				code: "agent-duplicate-id",
				message: `Duplicate agent id "${entry.id}" in agent catalog; first entry wins.`,
				ref: { type: "agent", id: entry.id, role: entry.role },
			});
			continue;
		}
		map.set(entry.id, entry);
	}
	return map;
}

/**
 * Resolve a normalized v2 workflow against an in-memory catalog bundle.
 *
 * Throws only on programmer misuse (workflow is not a `V2Workflow`). Any
 * shape problem in the catalogs is reported as a diagnostic.
 */
export function resolveWorkflow(
	workflow: V2Workflow,
	catalogs: V2CatalogBundle = {},
): V2ResolvedWorkflow {
	if (!workflow || typeof workflow !== "object" || workflow.version !== 2) {
		throw new TypeError("resolveWorkflow: workflow must be a normalized V2Workflow");
	}
	const diagnostics: V2Diagnostic[] = [];

	const agents = buildAgentIndex(catalogs.agentCatalog, diagnostics);
	const presets = indexById(catalogs.modelPresets?.presets);
	const profiles = indexById(catalogs.toolProfiles?.profiles);
	const packs = indexById(catalogs.promptPacks?.packs);
	const gates = indexById(catalogs.qualityGates?.gates);

	const activeAgents = defaultActiveAgents(workflow.meta);
	const activeSet = new Set<AgentRole>(activeAgents);

	const flow: V2FlowStep[] = [];
	for (const step of workflow.flow) {
		if (!activeSet.has(step.role)) {
			pushDiag(diagnostics, {
				severity: "error",
				code: "flow-step-out-of-active-agents",
				message: `Flow step references role "${step.role}" which is not in meta.activeAgents.`,
				ref: { type: "flow-step", role: step.role },
			});
		}
		flow.push(step);
	}

	const resolvedRoles: V2ResolvedRoleIdentity[] = [];
	for (const binding of workflow.roles) {
		if (!activeSet.has(binding.role)) {
			pushDiag(diagnostics, {
				severity: "error",
				code: "role-binding-out-of-active-agents",
				message: `Role binding for "${binding.role}" is not in meta.activeAgents.`,
				ref: { type: "role-binding", id: binding.agent, role: binding.role },
			});
		}
		const agent = agents.get(binding.agent);
		if (!agent) {
			pushDiag(diagnostics, {
				severity: "error",
				code: "agent-missing",
				message: `Role binding for "${binding.role}" references agent "${binding.agent}" which is not in the agent catalog.`,
				ref: { type: "agent", id: binding.agent, role: binding.role },
			});
			resolvedRoles.push({
				role: binding.role,
				binding,
				agent: {
					id: binding.agent,
					role: binding.role,
				},
				model: { source: "missing" },
				tools: { tools: [], source: "missing" },
				prompts: [],
				qualityGates: [],
			});
			continue;
		}
		if (agent.role !== binding.role) {
			pushDiag(diagnostics, {
				severity: "error",
				code: "agent-role-mismatch",
				message: `Agent "${agent.id}" has role "${agent.role}" but is bound to role "${binding.role}".`,
				ref: { type: "agent", id: agent.id, role: binding.role },
			});
		}
		resolvedRoles.push({
			role: binding.role,
			binding,
			agent,
			model: resolveModelForAgent(agent, presets, diagnostics),
			tools: resolveToolsForAgent(agent, profiles, diagnostics),
			prompts: resolvePromptsForAgent(agent, packs, diagnostics),
			qualityGates: resolveQualityGatesForAgent(agent, gates, diagnostics),
		});
	}

	const reviewer = resolvedRoles.find((r) => r.role === "reviewer");
	return {
		workflow,
		activeAgents,
		direction: workflow.direction ?? "sequential",
		flow,
		roles: resolvedRoles,
		reviewerSwarm: deriveReviewerSwarm(reviewer),
		diagnostics,
	};
}

/**
 * Compose the prompt text a role receives at delegation time. The output
 * order is deterministic: override instructions (if any), inline prompt
 * packs in catalog order, then a final Karpathy-guidelines block when
 * either the tool profile or the agent override opts in. Markdown is the
 * expected format for inline text. This helper is a pure view over the
 * resolved identity; it does not load files.
 */
export function composeRolePrompt(
	identity: V2ResolvedRoleIdentity,
	karpathyGuidelines: string,
): string {
	const blocks: string[] = [];
	const override = identity.agent.overrides;
	if (override?.instructions && override.instructions.trim()) {
		blocks.push(override.instructions.trim());
	}
	for (const prompt of identity.prompts) {
		if (prompt.text && prompt.text.trim()) blocks.push(prompt.text.trim());
	}
	if (identity.tools.includeKarpathyGuidelines === true) {
		blocks.push(karpathyGuidelines.trim());
	}
	return blocks.join("\n\n");
}
