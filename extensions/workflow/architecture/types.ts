export type PlanLifecycleStatus = "ready" | "draft";

export type WorkflowPhaseId = "phaseA" | "phaseB";

export type PhaseGateStatus =
	| "not_started"
	| "coder_completed"
	| "review_approved"
	| "changes_requested";

export interface PhaseEvidence {
	at: string;
	note: string;
	source?: string;
}

export interface WorkflowPhaseRecord {
	status: PhaseGateStatus;
	updatedAt: string;
	evidence: PhaseEvidence[];
}

export interface ArchitecturePlanPhases {
	phaseA: WorkflowPhaseRecord;
	phaseB: WorkflowPhaseRecord;
}

export type CriterionKind =
	| "runtime-behavior"
	| "planning-artifact"
	| "documentation"
	| "configuration"
	| "test-infrastructure"
	| "manual-process";

export type EnforcementLevel =
	| "prompt-only"
	| "config-default"
	| "runtime-gate"
	| "behavior-test"
	| "manual-validation"
	| "regression-proof";

export type RequiredEvidenceKind =
	| "artifact"
	| "diff"
	| "static-check"
	| "unit-test"
	| "behavior-test"
	| "regression-test"
	| "runtime-gate-test"
	| "manual-validation"
	| "reviewer-approval";

export type ReviewerRole =
	| "implementation"
	| "evidence-test"
	| "behavior"
	| "regression"
	| "maintainability"
	| "docs-config";

export interface RequiredEvidenceItem {
	kind: RequiredEvidenceKind;
	description: string;
	command?: string;
}

export interface AcceptanceEvidenceMatrixEntry {
	criterion: string;
	criterionKind: CriterionKind;
	businessRiskIfWrong: string;
	enforcementLevel: EnforcementLevel[];
	requiredEvidence: RequiredEvidenceItem[];
	reviewerRoles: ReviewerRole[];
	blockingConditions: string[];
	promptOnlyCaveat?: string;
	manualValidationPlan?: string;
}

export type EvidenceMatrixValidationIssueCode =
	| "matrix_missing"
	| "criterion_missing"
	| "criterion_duplicate"
	| "criterion_extra"
	| "entry_missing_required_field"
	| "entry_invalid_value"
	| "prompt_only_missing_caveat"
	| "runtime_prompt_only_only";

export interface EvidenceMatrixValidationIssue {
	code: EvidenceMatrixValidationIssueCode;
	message: string;
	criterion?: string;
	index?: number;
}

export interface EvidenceMatrixValidationResult {
	ok: boolean;
	issues: EvidenceMatrixValidationIssue[];
}

export interface WorkflowArchitecturePlan {
	planId: string;
	taskId?: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	status: PlanLifecycleStatus;
	businessPlan: string;
	technicalPlan: string;
	parallelAssessment: string;
	contractBlockPlan: string;
	acceptanceCriteria: string[];
	acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[];
	files?: string[];
	openQuestions?: string[];
	phases: ArchitecturePlanPhases;
}

export interface PlanStoragePath {
	cwd: string;
	root: string;
	file: string;
}

export interface PlanGateRejection {
	code:
		| "plan_missing"
		| "plan_not_ready"
		| "plan_open_questions"
		| "missing_phase"
		| "phase_a_not_approved"
		| "invalid_phase_status"
		| "acceptance_matrix_missing"
		| "acceptance_matrix_incomplete"
		| "acceptance_matrix_invalid"
		| "acceptance_matrix_prompt_only_invalid";
	reason: string;
}

export interface PlanGateResult {
	ok: boolean;
	rejections: PlanGateRejection[];
}

export interface ArchitecturePlanReadIssue {
	code: "invalid_plan_id" | "sprint_binding_invalid" | "plan_not_found" | "plan_invalid";
	message: string;
}

export interface ArchitecturePlanReadResult {
	plan: WorkflowArchitecturePlan | null;
	issue?: ArchitecturePlanReadIssue;
}

export interface ArchitecturePlanPatch {
	status?: PlanLifecycleStatus;
	taskId?: string;
	title?: string;
	businessPlan?: string;
	technicalPlan?: string;
	parallelAssessment?: string;
	contractBlockPlan?: string;
	acceptanceCriteria?: string[];
	acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[];
	files?: string[];
	openQuestions?: string[];
}

export interface PlanContextOptions {
	phase: WorkflowPhaseId;
	forAgent?: "coder" | "reviewer";
}
