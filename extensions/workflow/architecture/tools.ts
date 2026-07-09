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
import { freezePlanForPhase, frozenPlanPathFor } from "./plan-freeze";
import { invalidatePlanningState, stateFileExists } from "../planning-state";
import { readPlanningCurrentRoomPointer } from "../planning-pointer";
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

const matrixEntryParameters = {
	criterion: Type.String({ minLength: 1, description: "Exact acceptance-criterion text this entry covers." }),
	criterionKind: Type.Union(
		[
			Type.Literal("runtime-behavior"),
			Type.Literal("planning-artifact"),
			Type.Literal("documentation"),
			Type.Literal("configuration"),
			Type.Literal("test-infrastructure"),
			Type.Literal("manual-process"),
		],
		{ description: "Kind of criterion this entry describes." },
	),
	businessRiskIfWrong: Type.String({ minLength: 1, description: "Why the criterion matters to the business." }),
	enforcementLevel: Type.Array(
		Type.Union([
			Type.Literal("prompt-only"),
			Type.Literal("config-default"),
			Type.Literal("runtime-gate"),
			Type.Literal("behavior-test"),
			Type.Literal("manual-validation"),
			Type.Literal("regression-proof"),
		]),
		{ minItems: 1, description: "How the criterion is enforced." },
	),
	requiredEvidence: Type.Array(
		Type.Object({
			kind: Type.Union([
				Type.Literal("artifact"),
				Type.Literal("diff"),
				Type.Literal("static-check"),
				Type.Literal("unit-test"),
				Type.Literal("behavior-test"),
				Type.Literal("regression-test"),
				Type.Literal("runtime-gate-test"),
				Type.Literal("manual-validation"),
				Type.Literal("reviewer-approval"),
			], { description: "Evidence kind for this row." }),
			description: Type.String({ minLength: 1, description: "What the evidence shows." }),
			command: Type.Optional(Type.String({ description: "Optional command that produces the evidence." })),
		}),
		{ minItems: 1, description: "Concrete evidence that proves the criterion." },
	),
	reviewerRoles: Type.Array(
		Type.Union([
			Type.Literal("implementation"),
			Type.Literal("evidence-test"),
			Type.Literal("behavior"),
			Type.Literal("regression"),
			Type.Literal("maintainability"),
			Type.Literal("docs-config"),
		]),
		{ minItems: 1, description: "Reviewer roles that must sign off on this criterion." },
	),
	blockingConditions: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		description: "Concrete failure modes that must block delegation/finalization.",
	}),
	promptOnlyCaveat: Type.Optional(Type.String({ description: "Required when any enforcementLevel is prompt-only." })),
	manualValidationPlan: Type.Optional(Type.String({ description: "Optional manual validation steps." })),
	// WP3 PRD-contract traceability (optional).
	criterionId: Type.Optional(Type.String({ description: "Stable criterion id (AC<N>)." })),
	covers: Type.Optional(Type.Array(Type.String(), { description: "PRD contract ids this row covers (B<N> expected / X<N> forbidden)." })),
	negative: Type.Optional(Type.Boolean({ description: "True for a negative-scenario row (proves a forbidden behavior does NOT happen). Every X* in the PRD contract needs at least one negative row." })),
} as const;

const acceptanceEvidenceMatrixParameters = Type.Optional(
	Type.Array(
		Type.Object(matrixEntryParameters, {
			description:
				"Acceptance/evidence matrix entry. Required when recording/updating a `ready` plan that has non-trivial acceptance criteria; optional for `draft` plans.",
		}),
		{
			description:
				"Per-criterion evidence matrix. Required for ready plans; draft plans may omit it. Must cover every acceptance criterion exactly once.",
		},
	),
);

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
			acceptanceEvidenceMatrix: acceptanceEvidenceMatrixParameters,
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
					acceptanceEvidenceMatrix: (params as any).acceptanceEvidenceMatrix,
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
			acceptanceEvidenceMatrix: acceptanceEvidenceMatrixParameters,
			files: Type.Optional(Type.Array(Type.String())),
			openQuestions: Type.Optional(Type.Array(Type.String())),
			rebaselinePhase: Type.Optional(Type.Boolean({ description: "WP5: explicitly re-confirm a plan that drifted from its frozen phase snapshot. Requires `phase`. Re-freezes the snapshot from the (patched) current plan and resets the phase to not_started; also invalidates planning-state implementation confirmation (architecture_or_evidence) when a planning room is active." })),
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

			const rebaselinePhase = (params as any).rebaselinePhase === true;
			const phase = asPhase((params as any).phase);
			if (rebaselinePhase && !phase) {
				return errTool("rebaselinePhase requires `phase` in the same call.", { reason: "missing_phase_for_rebaseline", planId });
			}
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
			if (Object.prototype.hasOwnProperty.call(params as any, "acceptanceEvidenceMatrix")) {
				patch.acceptanceEvidenceMatrix = (params as any).acceptanceEvidenceMatrix as any;
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
				try {
					// Apply the metadata patch (including acceptanceEvidenceMatrix) BEFORE
					// the phase status update. This lets a legacy ready plan be repaired
					// (matrix fixed) and then have its phase status updated in the same
					// call. updatePlanRecord validates the patch and rejects with the
					// matrix hard-lock; updatePlanPhase re-checks the ready matrix hard-lock
					// after every patch.
					updatePlanRecord(ctx.cwd, planId, patch, (ctx as any).sessionManager);
				} catch (error) {
					return errTool(`Failed to update plan: ${error instanceof Error ? error.message : String(error)}`, {
						reason: "patch_failed",
						planId,
					});
				}
			}

			if (phase && phaseStatus) {
				try {
					updatePlanPhase(ctx.cwd, planId, phase, phaseStatus, "Updated by architecture helper", (ctx as any).sessionManager);
				} catch (error) {
					return errTool(`Failed to update plan phase: ${error instanceof Error ? error.message : String(error)}`, {
						reason: "phase_update_failed",
						planId,
						phase,
						phaseStatus,
					});
				}
			}

			// WP5: explicit re-baseline of a drifted plan. Runs AFTER the patch
			// so the new snapshot freezes the plan the operator just confirmed;
			// resets the phase to not_started ("contract change resets
			// clearances") and, when a planning room is active, mirrors the same
			// semantics into planning-state via an architecture_or_evidence
			// invalidation.
			let rebaselined: Record<string, unknown> | undefined;
			if (rebaselinePhase && phase) {
				try {
					const current = readArchitecturePlanWithIssueStatus(ctx.cwd, planId, (ctx as any).sessionManager);
					if (!current.plan) {
						return errTool(`Cannot rebaseline: plan ${planId} is unreadable after patch.`, { reason: "rebaseline_failed", planId, phase });
					}
					const snapshot = freezePlanForPhase(ctx.cwd, current.plan, phase, (ctx as any).sessionManager);
					updatePlanPhase(ctx.cwd, planId, phase, "not_started", `Phase re-baselined against plan sha256 ${snapshot.sha256.slice(0, 12)}…`, (ctx as any).sessionManager);
					rebaselined = { phase, sha256: snapshot.sha256, frozenAt: snapshot.frozenAt, snapshotPath: frozenPlanPathFor(ctx.cwd, planId, phase, (ctx as any).sessionManager) };
					const planningRoomId = readPlanningCurrentRoomPointer(ctx.cwd);
					if (planningRoomId && stateFileExists(ctx.cwd, planningRoomId)) {
						invalidatePlanningState(ctx.cwd, planningRoomId, {
							kind: "architecture_or_evidence",
							reason: `architecture plan ${planId}/${phase} re-baselined (plan contract changed after phase start)`,
							actor: "brain",
							source: "workflow_update_architecture_plan",
							evidence: `rebaselinePhase sha256=${snapshot.sha256}`,
						});
						rebaselined.planningInvalidated = planningRoomId;
					}
				} catch (error) {
					return errTool(`Failed to rebaseline phase: ${error instanceof Error ? error.message : String(error)}`, {
						reason: "rebaseline_failed",
						planId,
						phase,
					});
				}
			}

			const updated = readArchitecturePlanWithIssueStatus(ctx.cwd, planId, (ctx as any).sessionManager);
			const planPath = getPlanStoragePath(ctx.cwd, planId, (ctx as any).sessionManager);
			return okTool(
				`Updated architecture plan ${planId}.${rebaselined ? ` Phase ${phase} re-baselined (snapshot re-frozen, phase reset to not_started${rebaselined.planningInvalidated ? `, planning room ${rebaselined.planningInvalidated} implementation confirmation invalidated` : ""}).` : ""}`,
				{
					planId,
					path: planPath.file,
					updatedStatus: updated.plan?.status,
					...(rebaselined ? { rebaselined } : {}),
				},
			);
		},
	});
}
