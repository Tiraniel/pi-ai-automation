// Phase gate validation and architecture-context rendering.
// Kept out of store.ts so the store module can stay focused on plan CRUD.

import { getMatrixReadIssues } from "./plan-helpers";
import {
	validateEvidenceMatrix,
} from "./evidence-matrix";
import type {
	AcceptanceEvidenceMatrixEntry,
	EvidenceMatrixValidationIssue,
	PlanGateRejection,
	PlanGateResult,
	WorkflowArchitecturePlan,
	WorkflowPhaseId,
} from "./types";

function addGate(
	rejections: PlanGateRejection[],
	code: PlanGateRejection["code"],
	reason: string,
): void {
	rejections.push({ code, reason });
}

function matrixIssueToGateCode(issue: EvidenceMatrixValidationIssue): PlanGateRejection["code"] {
	switch (issue.code) {
		case "matrix_missing":
			return "acceptance_matrix_missing";
		case "criterion_missing":
		case "criterion_duplicate":
		case "criterion_extra":
			return "acceptance_matrix_incomplete";
		case "entry_missing_required_field":
		case "entry_invalid_value":
			return "acceptance_matrix_invalid";
		case "prompt_only_missing_caveat":
		case "runtime_prompt_only_only":
			return "acceptance_matrix_prompt_only_invalid";
	}
}

export function validatePhaseGate(
	plan: WorkflowArchitecturePlan | null,
	phase: WorkflowPhaseId,
	options?: { forAgent?: "coder" | "reviewer" },
): PlanGateResult {
	const rejections: PlanGateRejection[] = [];
	if (!plan) {
		addGate(rejections, "plan_missing", "No architecture plan is recorded.");
		return { ok: false, rejections };
	}
	if (plan.status !== "ready") {
		addGate(rejections, "plan_not_ready", "Plan status must be ready before delegation.");
	}
	const openQuestions = (plan.openQuestions ?? []).filter(Boolean);
	if (openQuestions.length > 0) {
		addGate(rejections, "plan_open_questions", "Plan has open questions and cannot be used for delegation.");
	}
	if (!plan.phases || !plan.phases.phaseA || !plan.phases.phaseB) {
		addGate(rejections, "missing_phase", "Plan is missing phase A/B records.");
		return { ok: false, rejections };
	}
	if (!plan.phases[phase]) {
		addGate(rejections, "missing_phase", `Phase ${phase} is missing.`);
		return { ok: false, rejections };
	}
	if (phase === "phaseB" && plan.phases.phaseA.status !== "review_approved") {
		addGate(
			rejections,
			"phase_a_not_approved",
			"Phase B cannot start before Phase A has review_approved status.",
		);
	}
	if (options?.forAgent === "reviewer" && plan.phases[phase].status !== "coder_completed") {
		addGate(
			rejections,
			"invalid_phase_status",
			`Reviewer delegation for ${phase} requires phase status coder_completed; current status is ${plan.phases[phase].status}.`,
		);
	}
	if (options?.forAgent === "coder" && plan.phases[phase].status === "review_approved") {
		addGate(
			rejections,
			"invalid_phase_status",
			`Coder delegation for ${phase} is blocked because phase already has review_approved status.`,
		);
	}
	// Ready-plan hard-lock on the acceptance/evidence matrix. Legacy plans that were
	// persisted before the matrix existed are caught here so delegation fails with a
	// matrix-specific rejection code instead of silently passing a missing-matrix plan.
	if (plan.status === "ready") {
		// Read-time issues (attached by normalizePlan when the on-disk matrix had
		// malformed rows) must be reported as acceptance_matrix_invalid even when the
		// surviving valid rows still cover all criteria. This stops a corrupt on-disk
		// matrix from being silently normalized down to a "passing" plan.
		const readIssues = getMatrixReadIssues(plan);
		for (const issue of readIssues) {
			const where = issue.criterion
				? `criterion=${JSON.stringify(issue.criterion)}`
				: issue.index !== undefined
					? `index=${issue.index}`
					: "matrix";
			addGate(
				rejections,
				"acceptance_matrix_invalid",
				`acceptanceEvidenceMatrix ${issue.code}: ${issue.message} (${where})`,
			);
		}
		const matrixResult = validateEvidenceMatrix(plan, { isReadyPlan: true });
		for (const issue of matrixResult.issues) {
			const code = matrixIssueToGateCode(issue);
			const where = issue.criterion
				? `criterion=${JSON.stringify(issue.criterion)}`
				: issue.index !== undefined
					? `index=${issue.index}`
					: "matrix";
			addGate(
				rejections,
				code,
				`acceptanceEvidenceMatrix ${issue.code}: ${issue.message} (${where})`,
			);
		}
	}
	return { ok: rejections.length === 0, rejections };
}

export function buildArchitectureContext(
	plan: WorkflowArchitecturePlan,
	options: { phase: WorkflowPhaseId; forAgent?: "coder" | "reviewer" },
): string {
	const gate = validatePhaseGate(plan, options.phase, { forAgent: options.forAgent });
	const lines: string[] = [];
	lines.push(`# Architecture plan ${plan.planId}`);
	if (plan.title) lines.push(`Title: ${plan.title}`);
	if (plan.taskId) lines.push(`Task: ${plan.taskId}`);
	lines.push(`Status: ${plan.status}`);
	lines.push(`Current phase statuses: A=${plan.phases.phaseA.status}, B=${plan.phases.phaseB.status}`);
	if (options.forAgent === "reviewer") {
		lines.push("Reviewer context:");
		lines.push("- Architecture plans are context for intended behavior and implementation scope only, not approval criteria.");
		lines.push("- Review changed code, validation evidence, and behavior against this scope context.");
		lines.push("- `review_approved` means implementation review passed for this phase, not that the Brain plan text was approved.");
		lines.push("- Review implementation and validation evidence against the acceptance/evidence matrix; do not approve if required evidence or required reviewer-role coverage is missing.");
		lines.push("");
	}
	lines.push("");

	if (!gate.ok) {
		lines.push("Blocking checks:");
		for (const issue of gate.rejections) {
			lines.push(`- ${issue.code}: ${issue.reason}`);
		}
		lines.push("");
	}

	if (options.phase === "phaseA") {
		lines.push("Phase A scope:");
		lines.push("- Implement isolated architecture-contract blocks only.");
		lines.push("- No runtime wiring in `extensions/brain-workflow.ts` or delegate transport.");
		lines.push("- Do not alter runtime bootstrap, loader integration, or command wiring.");
	} else {
		lines.push("Phase B scope:");
		lines.push("- Apply integration/composition updates after Phase A approval.");
		lines.push("- Keep artifacts from Phase A unchanged except for approved updates.");
		if (plan.phases.phaseA.status !== "review_approved") {
			lines.push("- Blocked until Phase A is review_approved.");
		}
	}
	lines.push("");

	lines.push("Plan artifacts:");
	lines.push(`- Business: ${plan.businessPlan}`);
	lines.push(`- Technical: ${plan.technicalPlan}`);
	lines.push(`- Parallel: ${plan.parallelAssessment}`);
	lines.push(`- Contract/Block: ${plan.contractBlockPlan}`);
	if (plan.files?.length) {
		lines.push("- Files:");
		for (const file of plan.files) lines.push(`  - ${file}`);
	}
	if (plan.openQuestions?.length) {
		lines.push("- Open questions: ");
		for (const q of plan.openQuestions) lines.push(`  - ${q}`);
	}

	lines.push("- Acceptance criteria:");
	for (const criterion of plan.acceptanceCriteria) {
		lines.push(`  - ${criterion}`);
	}

	const matrix = plan.acceptanceEvidenceMatrix ?? [];
	if (matrix.length > 0) {
		lines.push("");
		lines.push("Acceptance/evidence matrix:");
		for (const entry of matrix) {
			lines.push(`- Criterion: ${entry.criterion}`);
			lines.push(`  Kind: ${entry.criterionKind}`);
			lines.push(`  Business risk: ${entry.businessRiskIfWrong}`);
			lines.push(`  Enforcement: ${entry.enforcementLevel.join(", ")}`);
			lines.push(`  Required evidence:`);
			for (const item of entry.requiredEvidence) {
				const command = item.command ? ` (command: ${item.command})` : "";
				lines.push(`    - ${item.kind}: ${item.description}${command}`);
			}
			lines.push(`  Reviewer roles: ${entry.reviewerRoles.join(", ")}`);
			lines.push(`  Blocking conditions:`);
			for (const cond of entry.blockingConditions) lines.push(`    - ${cond}`);
			if (entry.promptOnlyCaveat) {
				lines.push(`  promptOnlyCaveat: ${entry.promptOnlyCaveat}`);
			}
			if (entry.manualValidationPlan) {
				lines.push(`  manualValidationPlan: ${entry.manualValidationPlan}`);
			}
		}
		if (options.forAgent === "coder") {
			lines.push("Coder completion evidence must map changed files and commands back to these matrix entries.");
		} else if (options.forAgent === "reviewer") {
			lines.push("Reviewer must verify each required-evidence item and reviewer-role coverage listed above; do not approve the phase if any entry lacks evidence or role coverage.");
		}
	} else if (plan.status === "ready") {
		// Should never reach here when validatePhaseGate is wired, but render
		// explicitly so legacy/missing-matrix plans surface in delegated context.
		lines.push("- Acceptance/evidence matrix: (missing — ready plan is blocking)");
	}

	return lines.join("\n");
}

export function buildContextForPhase(plan: WorkflowArchitecturePlan, phase: WorkflowPhaseId): string {
	return buildArchitectureContext(plan, { phase });
}
