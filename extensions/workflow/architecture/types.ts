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
		| "invalid_phase_status";
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
	files?: string[];
	openQuestions?: string[];
}

export interface PlanContextOptions {
	phase: WorkflowPhaseId;
	forAgent?: "coder" | "reviewer";
}
