import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createArchitecturePlanRecord,
	readArchitecturePlanWithIssueStatus,
	updatePlanPhase,
	updatePlanRecord,
	validatePlanId,
	getPlanStoragePath,
	buildArchitectureContext,
} from "./store";
import type { ArchitecturePlanPatch, WorkflowPhaseId, PhaseGateStatus } from "./types";

function trimString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const text = trimString(item);
		if (text) out.push(text);
	}
	return out;
}

function asPhase(value: unknown): WorkflowPhaseId | undefined {
	return value === "phaseA" || value === "phaseB" ? value : undefined;
}

function asStatus(value: unknown): "ready" | "draft" | undefined {
	return value === "ready" || value === "draft" ? value : undefined;
}

function asPhaseStatus(value: unknown): PhaseGateStatus | undefined {
	if (value === "not_started" || value === "changes_requested") {
		return value;
	}
	return undefined;
}

function okTool(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function errTool(text: string, details: Record<string, unknown> = {}) {
	return {
		isError: true,
		content: [{ type: "text" as const, text }],
		details,
	};
}

function planLookupToIssueReason(code?: string): string {
	if (code === "plan_not_found") return "plan_not_found";
	return "plan_storage_error";
}

export function registerArchitectureTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "workflow_record_architecture_plan",
		label: "Record Architecture Plan",
		description: "Persist architecture plan metadata required for Brain -> coder/reviewer phase gating.",
		promptSnippet: "Record architecture plan and enforce phase gates before delegation.",
		parameters: Type.Object({
			planId: Type.String({ description: "Stable plan id (lowercase alnum, _ or -)." }),
			taskId: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			status: Type.Optional(Type.Union([Type.Literal("ready"), Type.Literal("draft")])),
			businessPlan: Type.String(),
			technicalPlan: Type.String(),
			parallelAssessment: Type.String(),
			contractBlockPlan: Type.String(),
			acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			files: Type.Optional(Type.Array(Type.String())),
			openQuestions: Type.Optional(Type.Array(Type.String())),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const planId = trimString((params as any).planId);
			const businessPlan = trimString((params as any).businessPlan);
			const technicalPlan = trimString((params as any).technicalPlan);
			const parallelAssessment = trimString((params as any).parallelAssessment);
			const contractBlockPlan = trimString((params as any).contractBlockPlan);
			const acceptanceCriteria = normalizeArray((params as any).acceptanceCriteria);
			if (!validatePlanId(planId)) {
				return errTool("Invalid planId.", { reason: "invalid_plan_id", planId });
			}
			if (!businessPlan || !technicalPlan || !parallelAssessment || !contractBlockPlan || acceptanceCriteria.length === 0) {
				return errTool("Required fields missing: businessPlan, technicalPlan, parallelAssessment, contractBlockPlan, acceptanceCriteria.", {
					reason: "missing_required_fields",
					planId,
				});
			}

			try {
				const plan = createArchitecturePlanRecord({
					cwd: ctx.cwd,
					planId,
					taskId: trimString((params as any).taskId),
					title: trimString((params as any).title) || undefined,
					status: asStatus((params as any).status),
					businessPlan,
					technicalPlan,
					parallelAssessment,
					contractBlockPlan,
					acceptanceCriteria,
					files: normalizeArray((params as any).files),
					openQuestions: normalizeArray((params as any).openQuestions),
					sessionManager: (ctx as any).sessionManager,
				});
				const planPath = getPlanStoragePath(ctx.cwd, plan.planId, (ctx as any).sessionManager);
				return okTool(`Recorded architecture plan ${plan.planId} (${plan.status}).`, {
					planId: plan.planId,
					planStatus: plan.status,
					path: planPath.file,
					planSource: "recorded",
				});
			} catch (error) {
				return errTool(`Failed to record plan: ${error instanceof Error ? error.message : String(error)}`, {
					reason: "record_failed",
					planId,
				});
			}
		},
	});

	pi.registerTool({
		name: "workflow_read_architecture_plan",
		label: "Read Architecture Plan",
		description: "Read an existing architecture plan (and optional rendered phase context).",
		promptSnippet: "Fetch plan artifacts before delegating.",
		parameters: Type.Object({
			planId: Type.String(),
			phase: Type.Optional(Type.Union([Type.Literal("phaseA"), Type.Literal("phaseB")], { description: "Optional context phase to render from plan." })),
			includeContext: Type.Optional(Type.Boolean({ description: "Include rendered phase context text." })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const planId = trimString((params as any).planId);
			if (!validatePlanId(planId)) {
				return errTool("Invalid planId.", { reason: "invalid_plan_id", planId });
			}
			const lookup = readArchitecturePlanWithIssueStatus(ctx.cwd, planId, (ctx as any).sessionManager);
			if (!lookup.plan) {
				if (lookup.issue?.code === "plan_not_found") {
					return errTool(`No plan found: ${planId}`, { reason: "plan_not_found", planId });
				}
				if (lookup.issue) {
					return errTool(lookup.issue.message, { reason: "plan_storage_error", planId, issue: lookup.issue });
				}
				return errTool(`No plan found: ${planId}`, { reason: "plan_not_found", planId });
			}
			const plan = lookup.plan;
			const phase = asPhase((params as any).phase);
			const includeContext = Boolean((params as any).includeContext);
			const context = phase ? buildArchitectureContext(plan, { phase, forAgent: "coder" }) : undefined;
			const payload = includeContext && context ? `${context}\n\n${JSON.stringify(plan, null, 2)}` : JSON.stringify(plan, null, 2);
			const details: Record<string, unknown> = { ...plan, phase };
			if (context) details.context = context;
			return okTool(payload, details);
		},
	});

	pi.registerTool({
		name: "workflow_update_architecture_plan",
		label: "Update Architecture Plan",
		description: "Update an existing architecture plan, including phase or lifecycle status.",
		parameters: Type.Object({
			planId: Type.String(),
			status: Type.Optional(Type.Union([Type.Literal("ready"), Type.Literal("draft")], { description: "Plan lifecycle status." })),
			phase: Type.Optional(Type.Union([Type.Literal("phaseA"), Type.Literal("phaseB")], { description: "Phase to update." })),
			phaseStatus: Type.Optional(
				Type.Union([Type.Literal("not_started"), Type.Literal("changes_requested")], {
					description: "Phase state update.",
				}),
			),
			businessPlan: Type.Optional(Type.String()),
			technicalPlan: Type.Optional(Type.String()),
			parallelAssessment: Type.Optional(Type.String()),
			contractBlockPlan: Type.Optional(Type.String()),
			acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
			files: Type.Optional(Type.Array(Type.String())),
			openQuestions: Type.Optional(Type.Array(Type.String())),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const planId = trimString((params as any).planId);
			if (!validatePlanId(planId)) {
				return errTool("Invalid planId.", { reason: "invalid_plan_id", planId });
			}
			const lookup = readArchitecturePlanWithIssueStatus(ctx.cwd, planId, (ctx as any).sessionManager);
			if (!lookup.plan) {
				const reason = planLookupToIssueReason(lookup.issue?.code);
				if (reason === "plan_not_found") {
					return errTool(`No plan found: ${planId}`, { reason, planId });
				}
				if (lookup.issue) {
					return errTool(lookup.issue.message, { reason, planId, issue: lookup.issue });
				}
				return errTool(`No plan found: ${planId}`, { reason: "plan_not_found", planId });
			}

			const phase = asPhase((params as any).phase);
			const hasPhaseStatus = Object.prototype.hasOwnProperty.call(params as any, "phaseStatus");
			const hasPhase = Object.prototype.hasOwnProperty.call(params as any, "phase");
			if (hasPhaseStatus && !hasPhase) {
				return errTool("phaseStatus requires phase in the same call.", { reason: "missing_phase_for_phase_status", planId });
			}
			const phaseStatus = asPhaseStatus((params as any).phaseStatus);
			if (hasPhaseStatus && phaseStatus === undefined) {
				return errTool("phaseStatus supports only not_started or changes_requested from the public tool. Use delegation lifecycle updates for terminal states.", {
					reason: "unsupported_phase_status",
					planId,
					phaseStatus: (params as any).phaseStatus,
				});
			}
			if (phase && phaseStatus) {
				updatePlanPhase(ctx.cwd, planId, phase, phaseStatus, "Updated by architecture helper", (ctx as any).sessionManager);
			}

			const patch: ArchitecturePlanPatch = {};
			if (Object.prototype.hasOwnProperty.call(params as any, "status")) patch.status = asStatus((params as any).status);
			if (Object.prototype.hasOwnProperty.call(params as any, "businessPlan")) {
				const value = trimString((params as any).businessPlan);
				if (value) patch.businessPlan = value;
			}
			if (Object.prototype.hasOwnProperty.call(params as any, "technicalPlan")) {
				const value = trimString((params as any).technicalPlan);
				if (value) patch.technicalPlan = value;
			}
			if (Object.prototype.hasOwnProperty.call(params as any, "parallelAssessment")) {
				const value = trimString((params as any).parallelAssessment);
				if (value) patch.parallelAssessment = value;
			}
			if (Object.prototype.hasOwnProperty.call(params as any, "contractBlockPlan")) {
				const value = trimString((params as any).contractBlockPlan);
				if (value) patch.contractBlockPlan = value;
			}
			if (Object.prototype.hasOwnProperty.call(params as any, "acceptanceCriteria")) {
				patch.acceptanceCriteria = normalizeArray((params as any).acceptanceCriteria);
			}
			if (Object.prototype.hasOwnProperty.call(params as any, "files")) {
				patch.files = normalizeArray((params as any).files);
			}
			if (Object.prototype.hasOwnProperty.call(params as any, "openQuestions")) {
				patch.openQuestions = normalizeArray((params as any).openQuestions);
			}
			let hasPatch = false;
			for (const key of Object.keys(patch) as Array<keyof ArchitecturePlanPatch>) {
				if (patch[key] !== undefined) {
					hasPatch = true;
					break;
				}
			}
			if (hasPatch) {
				updatePlanRecord(ctx.cwd, planId, patch, (ctx as any).sessionManager);
			}

			const updated = readArchitecturePlanWithIssueStatus(ctx.cwd, planId, (ctx as any).sessionManager);
			const planPath = getPlanStoragePath(ctx.cwd, planId, (ctx as any).sessionManager);
			return okTool(`Updated architecture plan ${planId}.`, {
				planId,
				path: planPath.file,
				updatedStatus: updated.plan?.status,
			});
		},
	});
}
