import { buildArchitectureContext, readArchitecturePlanWithIssueStatus, updatePlanPhase, validatePhaseGate, validatePlanId } from "../architecture";
import type { WorkflowPhaseId } from "../architecture/types";

export type ArchitecturePhaseStatus = "coder_completed" | "review_approved" | "changes_requested";

export interface ArchitectureRequirement {
	planId: string;
	phase: WorkflowPhaseId;
}

export type ArchitectureRequirementResult =
	| {
		ok: true;
		requirement: ArchitectureRequirement;
		delegatedTask: string;
	}
	| {
		ok: false;
		reason:
			| "architecture_plan_required"
			| "architecture_plan_invalid"
			| "architecture_plan_not_found"
			| "architecture_plan_storage_error"
			| "architecture_gate_rejected";
		text: string;
		details: Record<string, unknown>;
	};

export function formatArchitectureRequirement(planId: unknown, phase: unknown): string {
	const safePlanId = typeof planId === "string" ? planId.trim() : "";
	const safePhase = phase === "phaseA" || phase === "phaseB" ? phase : "";
	if (!safePlanId || !safePhase) {
		return "Architecture plan is required. Call workflow_record_architecture_plan first and pass { planId, phase }.";
	}
	return `Architecture plan ${safePlanId} phase ${safePhase} required.`;
}

function resolveRequirement(input: unknown): ArchitectureRequirement | undefined {
	if (!input || typeof input !== "object") return undefined;
	const planId = String((input as { planId?: unknown }).planId ?? "").trim();
	const phase = (input as { phase?: unknown }).phase;
	if (!planId || (phase !== "phaseA" && phase !== "phaseB")) {
		return undefined;
	}
	return { planId, phase };
}

export function resolveArchitectureContext(
	cwd: string,
	task: string,
	input: unknown,
	agent: "coder" | "reviewer",
	sessionManager: unknown,
): ArchitectureRequirementResult {
	const requirement = resolveRequirement(input);
	if (!requirement) {
		return {
			ok: false,
			reason: "architecture_plan_required",
			text: `${formatArchitectureRequirement((input as any)?.planId, (input as any)?.phase)} Call workflow_record_architecture_plan first and pass { planId, phase }.`,
			details: {
				reason: "architecture_plan_required",
				planId: (input as any)?.planId,
				phase: (input as any)?.phase,
				suggestedTool: "workflow_record_architecture_plan",
			},
		};
	}
	if (!validatePlanId(requirement.planId)) {
		return {
			ok: false,
			reason: "architecture_plan_invalid",
			text: `Invalid architecture plan id: ${requirement.planId}`,
			details: {
				reason: "architecture_plan_invalid",
				planId: requirement.planId,
				phase: requirement.phase,
			},
		};
	}

	const lookup = readArchitecturePlanWithIssueStatus(cwd, requirement.planId, sessionManager as any);
	if (lookup.issue) {
		return {
			ok: false,
			reason: lookup.issue.code === "plan_not_found" ? "architecture_plan_not_found" : "architecture_plan_storage_error",
			text: lookup.issue.message,
			details: {
				reason: lookup.issue.code === "plan_not_found" ? "architecture_plan_not_found" : "architecture_plan_storage_error",
				planId: requirement.planId,
				phase: requirement.phase,
				issue: lookup.issue,
			},
		};
	}
	const plan = lookup.plan;
	if (!plan) {
		return {
			ok: false,
			reason: "architecture_plan_not_found",
			text: `No architecture plan found: ${requirement.planId}`,
			details: {
				reason: "architecture_plan_not_found",
				planId: requirement.planId,
				phase: requirement.phase,
			},
		};
	}

	const gate = validatePhaseGate(plan, requirement.phase, { forAgent: agent });
	if (!gate.ok) {
		return {
			ok: false,
			reason: "architecture_gate_rejected",
			text: `Architecture gate rejected phase ${requirement.phase}: ${gate.rejections.map((item) => item.code).join(", ")}.`,
			details: {
				reason: "architecture_gate_rejected",
				planId: requirement.planId,
				phase: requirement.phase,
				rejections: gate.rejections,
			},
		};
	}

	return {
		ok: true,
		requirement,
		delegatedTask: `${buildArchitectureContext(plan, { phase: requirement.phase, forAgent: agent })}\n\n${task}`,
	};
}

export function markArchitecturePhaseUpdate(
	cwd: string,
	requirement: ArchitectureRequirement,
	status: ArchitecturePhaseStatus,
	note: string,
	sessionManager: unknown,
): string | undefined {
	try {
		updatePlanPhase(cwd, requirement.planId, requirement.phase, status, note, sessionManager as any);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
