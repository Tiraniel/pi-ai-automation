import type {
	AgentPreset,
	ReviewerSwarmConfig,
	V2Diagnostic,
	V2ResolvedWorkflow,
	WorkflowConfig,
} from "../types";
import { isPlainObject } from "../config/guards";

const PLAN_METADATA_VERSION = 2;

export interface V2WorkflowAdapterSource {
	source: string;
	path: string;
	version: number;
	managedBy?: string;
	managedVersion?: string;
}

export interface V2WorkflowAdapterDiagnostic {
	severity: V2Diagnostic["severity"];
	code: string;
	message: string;
	ref?: V2Diagnostic["ref"];
}

export interface V2WorkflowAdapterResult {
	config: WorkflowConfig;
	source: V2WorkflowAdapterSource;
	diagnostics: V2WorkflowAdapterDiagnostic[];
}

function normalizeTextList(values: string[] | undefined): string[] {
	if (!Array.isArray(values)) return [];
	return values
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.filter(Boolean);
}

function toReviewSwarmTargets(resolved: V2ResolvedWorkflow): string[] {
	const out: string[] = [];
	for (const goal of resolved.reviewerSwarm.goals) {
		if (goal.gate?.description?.trim()) out.push(goal.gate.description.trim());
		else if (goal.gate?.id) out.push(goal.gate.id);
	}
	if (out.length > 0) return out;
	for (const goal of resolved.reviewerSwarm.goals) {
		if (goal.gate?.id) out.push(goal.gate.id);
	}
	return out;
}

function toAgentPreset(resolved: V2ResolvedWorkflow["roles"][number], includePromptMetadata = false): AgentPreset {
	const hasTools = resolved.tools.source === "profile" || resolved.tools.source === "override";
	const tools = hasTools && Array.isArray(resolved.tools?.tools) ? [...resolved.tools.tools] : undefined;
	const hasInstructionsOverride = resolved.agent.overrides ? Object.prototype.hasOwnProperty.call(resolved.agent.overrides, "instructions") : false;
	const preset: AgentPreset = {
		provider: resolved.model.provider,
		model: resolved.model.model,
		thinkingLevel: resolved.model.thinkingLevel,
		...(tools !== undefined ? { tools } : {}),
		...(resolved.tools.includeKarpathyGuidelines !== undefined ? { includeKarpathyGuidelines: resolved.tools.includeKarpathyGuidelines } : {}),
	};

	if (hasInstructionsOverride) {
		preset.instructions = typeof resolved.agent.overrides?.instructions === "string" ? resolved.agent.overrides.instructions : "";
	}

	const promptText = resolved.prompts
		.map((p) => normalizeTextList([p.text ?? ""]))
		.flat()
		.filter(Boolean);
	if (promptText.length) {
		preset.instructions = `${preset.instructions ? `${preset.instructions}\n\n` : ""}${promptText.join("\n\n")}`;
	}

	if (includePromptMetadata && resolved.tools.includeKarpathyGuidelines === undefined) {
		delete preset.includeKarpathyGuidelines;
	}
	if (preset.instructions === undefined || preset.instructions.trim() === "") {
		if (!hasInstructionsOverride) {
			delete preset.instructions;
		}
	}
	if (!preset.thinkingLevel) delete preset.thinkingLevel;
	if (!preset.provider) delete preset.provider;
	if (!preset.model) delete preset.model;

	return preset;
}

export function adaptV2ResolvedWorkflow(
	resolved: V2ResolvedWorkflow,
	source: { scope: string; path: string },
	loadDiagnostics?: V2Diagnostic[],
	sourceMeta?: { managedBy?: string; managedVersion?: string },
): V2WorkflowAdapterResult {
	const agents: Record<string, AgentPreset> = {};
	for (const identity of resolved.roles) {
		agents[identity.role] = toAgentPreset(identity, true);
	}

	const reviewerTargets = toReviewSwarmTargets(resolved);
	const reviewerSwarm: ReviewerSwarmConfig | undefined = reviewerTargets.length
		? {
			enabled: true,
			targets: reviewerTargets,
		}
		: undefined;

	const out: WorkflowConfig = {
		agents,
	};
	if (reviewerSwarm) {
		out.reviewerSwarm = reviewerSwarm;
	}

	const diagnostics: V2WorkflowAdapterDiagnostic[] = [];
	const seen = new Set<string>();
	const addDiagnostic = (diag: V2Diagnostic | V2WorkflowAdapterDiagnostic) => {
		const key = `${diag.severity}|${diag.code}|${diag.message}|${diag.ref?.id ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		diagnostics.push({ severity: diag.severity, code: diag.code, message: diag.message, ref: diag.ref });
	};
	if (loadDiagnostics?.length) {
		for (const diag of loadDiagnostics) {
			addDiagnostic(diag);
		}
	}
	for (const diag of resolved.diagnostics) {
		addDiagnostic(diag);
	}

	const workflow = isPlainObject(resolved.workflow)
		? (resolved.workflow as Record<string, unknown>)
		: null;
	const managedBy = sourceMeta?.managedBy ?? (workflow && typeof workflow._managedBy === "string" ? workflow._managedBy : undefined);
	const managedVersion = sourceMeta?.managedVersion ?? (workflow && typeof workflow._managedVersion === "string" ? workflow._managedVersion : undefined);

	return {
		config: out,
		source: {
			source: source.scope,
			path: source.path,
			version: typeof (resolved.workflow.version) === "number" ? resolved.workflow.version : PLAN_METADATA_VERSION,
			managedBy,
			managedVersion,
		},
		diagnostics,
	};
}
