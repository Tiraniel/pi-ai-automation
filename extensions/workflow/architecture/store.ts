import * as path from "node:path";
import { resolveSprintPathForStore } from "./sprint-path";

import {
	formatMatrixValidationIssues,
	normalizeMatrix,
	validateEvidenceMatrix,
} from "./evidence-matrix";
import {
	attachMatrixReadIssues,
	getMatrixReadIssues,
	isPlainObject,
	normalizeStringArray,
	stripMatrixReadIssues,
	toIsoDate,
	trimString,
} from "./plan-helpers";
import {
	buildArchitectureContext,
	buildContextForPhase,
	validatePhaseGate,
} from "./gate";
import type {
	WorkflowArchitecturePlan,
	WorkflowPhaseId,
	PlanLifecycleStatus,
	PhaseEvidence,
	PhaseGateStatus,
	ArchitecturePlanPatch,
	ArchitecturePlanReadResult,
	ArchitecturePlanPhases,
	PlanStoragePath,
	AcceptanceEvidenceMatrixEntry,
} from "./types";
import type { PlanStorageLookupError } from "./storage";
import { planStorageError, readJson, writeJson } from "./storage";

const PLAN_ID_SAFE_RE = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
const DEFAULT_PLAN_ROOT = path.join(".pi", "workflow-architecture", "plans");

function defaultPhase(status: PhaseGateStatus = "not_started"): {
	status: PhaseGateStatus;
	updatedAt: string;
	evidence: PhaseEvidence[];
} {
	return {
		status,
		updatedAt: toIsoDate(),
		evidence: [],
	};
}

function assertReadyMatrix(plan: {
	status: PlanLifecycleStatus;
	acceptanceCriteria: string[];
	acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[];
}): void {
	if (plan.status !== "ready") return;
	const matrix = plan.acceptanceEvidenceMatrix ?? [];
	if (matrix.length === 0) {
		throw new Error(
			"acceptanceEvidenceMatrix is invalid: ready plans require a non-empty acceptanceEvidenceMatrix.",
		);
	}
	const validation = validateEvidenceMatrix(
		{ acceptanceCriteria: plan.acceptanceCriteria, acceptanceEvidenceMatrix: matrix },
		{ isReadyPlan: true },
	);
	if (!validation.ok) {
		throw new Error(`acceptanceEvidenceMatrix is invalid: ${formatMatrixValidationIssues(validation.issues)}`);
	}
	// Read-time issues from the on-disk file (e.g. malformed rows that normalizePlan
	// attached via attachMatrixReadIssues) must also fail the ready hard-lock so a
	// ready plan that lost rows during normalization cannot slip through.
	const readIssues = getMatrixReadIssues(plan);
	if (readIssues.length > 0) {
		throw new Error(`acceptanceEvidenceMatrix is invalid: ${formatMatrixValidationIssues(readIssues)}`);
	}
}

function isPlanIdSafe(planId: string): boolean {
	return PLAN_ID_SAFE_RE.test(planId);
}

function normalizePhase(value: unknown): ReturnType<typeof defaultPhase> | undefined {
	if (!isPlainObject(value)) return undefined;
	const statusValue = trimString(value.status);
	if (
		statusValue !== "not_started" &&
		statusValue !== "coder_completed" &&
		statusValue !== "review_approved" &&
		statusValue !== "changes_requested"
	) return undefined;

	const updatedAt = trimString(value.updatedAt);
	if (!updatedAt) return undefined;

	const evidence: PhaseEvidence[] = [];
	if (Array.isArray((value as { evidence?: unknown }).evidence)) {
		for (const item of (value as { evidence?: unknown }).evidence as unknown[]) {
			if (!isPlainObject(item)) continue;
			const note = trimString(item.note);
			const at = trimString(item.at);
			if (!note || !at) continue;
			evidence.push({ at, note, source: trimString(item.source) || undefined });
		}
	}

	return {
		status: statusValue as PhaseGateStatus,
		updatedAt,
		evidence,
	};
}

function normalizePlan(input: unknown): WorkflowArchitecturePlan | null {
	if (!isPlainObject(input)) return null;

	const planId = trimString(input.planId).toLowerCase();
	if (!isPlanIdSafe(planId)) return null;

	const status = trimString(input.status) as PlanLifecycleStatus;
	if (status !== "ready" && status !== "draft") return null;

	const createdAt = trimString(input.createdAt);
	const updatedAt = trimString(input.updatedAt);
	if (!createdAt || !updatedAt) return null;

	const businessPlan = trimString(input.businessPlan);
	const technicalPlan = trimString(input.technicalPlan);
	const parallelAssessment = trimString(input.parallelAssessment);
	const contractBlockPlan = trimString(input.contractBlockPlan);
	if (!businessPlan || !technicalPlan || !parallelAssessment || !contractBlockPlan) return null;

	const acceptanceCriteria = normalizeStringArray(input.acceptanceCriteria);
	if (!acceptanceCriteria.length) return null;

	const matrixResult = normalizeMatrix((input as { acceptanceEvidenceMatrix?: unknown }).acceptanceEvidenceMatrix);
	// Lenient read: drop structurally invalid matrix entries from disk so historical
	// plans remain readable. Validation for create/update lives in those code paths.
	// Read issues are attached to the returned plan (Symbol-keyed) so assertReadyMatrix
	// and validatePhaseGate can still reject the plan with acceptance_matrix_invalid.

	const phasesValue = input.phases;
	if (!isPlainObject(phasesValue)) return null;
	const phaseA = normalizePhase((phasesValue as { phaseA?: unknown }).phaseA);
	const phaseB = normalizePhase((phasesValue as { phaseB?: unknown }).phaseB);
	if (!phaseA || !phaseB) return null;

	const plan: WorkflowArchitecturePlan = {
		planId,
		createdAt,
		updatedAt,
		status,
		businessPlan,
		technicalPlan,
		parallelAssessment,
		contractBlockPlan,
		acceptanceCriteria,
		phases: {
			phaseA,
			phaseB,
		},
		taskId: trimString(input.taskId) || undefined,
		title: trimString(input.title) || undefined,
		files: normalizeStringArray(input.files),
		openQuestions: normalizeStringArray(input.openQuestions),
	};

	if (matrixResult.value !== undefined && matrixResult.value.length > 0) {
		plan.acceptanceEvidenceMatrix = matrixResult.value;
	}
	if (plan.files?.length === 0) delete (plan as { files?: string[] }).files;
	if (plan.openQuestions?.length === 0) delete (plan as { openQuestions?: string[] }).openQuestions;
	// Surface read-time matrix issues so assertReadyMatrix / validatePhaseGate can
	// reject this plan even though we kept it readable for legacy/malformed cases.
	attachMatrixReadIssues(plan, matrixResult.issues);
	return plan;
}


function resolvePlanRoot(cwd: string, sessionManager?: any): string {
	const sprintRoot = resolveSprintPathForStore(cwd, sessionManager);
	if (sprintRoot) return path.join(sprintRoot, "artifacts", "workflow-architecture");
	return path.resolve(cwd, DEFAULT_PLAN_ROOT);
}

export function getPlanStoragePath(cwd: string, planId: string, sessionManager?: any): PlanStoragePath {
	if (!isPlanIdSafe(planId)) {
		throw planStorageError("invalid_plan_id", `Invalid planId: ${planId}`);
	}
	const root = resolvePlanRoot(cwd, sessionManager);
	return {
		cwd,
		root,
		file: path.join(root, `${planId}.json`),
	};
}

function readArchitecturePlanWithIssue(
	cwd: string,
	planId: string,
	sessionManager?: any,
): ArchitecturePlanReadResult {
	let filePath: string | undefined;
	try {
		const storagePath = getPlanStoragePath(cwd, planId, sessionManager);
		filePath = storagePath.file;
	} catch (error) {
		const maybeIssue = error as PlanStorageLookupError;
		if (maybeIssue?.code && typeof maybeIssue.code === "string") {
			return { plan: null, issue: { code: maybeIssue.code, message: maybeIssue.message } };
		}
		throw error;
	}

	const parsed = filePath ? readJson<unknown>(filePath) : null;
	if (!parsed) {
		return { plan: null, issue: { code: "plan_not_found", message: `No architecture plan found: ${planId}` } };
	}
	const plan = normalizePlan(parsed);
	if (!plan) {
		return { plan: null, issue: { code: "plan_invalid", message: `Stored architecture plan ${planId} is invalid.` } };
	}
	return { plan };
}

export function readArchitecturePlan(
	cwd: string,
	planId: string,
	sessionManager?: any,
): WorkflowArchitecturePlan | null {
	return readArchitecturePlanWithIssue(cwd, planId, sessionManager).plan;
}

export function readArchitecturePlanWithIssueStatus(
	cwd: string,
	planId: string,
	sessionManager?: any,
): ArchitecturePlanReadResult {
	return readArchitecturePlanWithIssue(cwd, planId, sessionManager);
}

export function validatePlanId(planId: string): boolean {
	return isPlanIdSafe(planId);
}

export function newArchitecturePhase(status: PhaseGateStatus = "not_started"): {
	status: PhaseGateStatus;
	updatedAt: string;
	evidence: PhaseEvidence[];
} {
	return defaultPhase(status);
}

export function initPhaseRecord(status: PhaseGateStatus = "not_started"): {
	status: PhaseGateStatus;
	updatedAt: string;
	evidence: PhaseEvidence[];
} {
	return defaultPhase(status);
}

export function createArchitecturePlanRecord(input: {
	cwd: string;
	planId: string;
	taskId?: string;
	title?: string;
	status?: PlanLifecycleStatus;
	businessPlan: string;
	technicalPlan: string;
	parallelAssessment: string;
	contractBlockPlan: string;
	acceptanceCriteria: string[];
	acceptanceEvidenceMatrix?: unknown;
	files?: string[];
	openQuestions?: string[];
	sessionManager?: any;
}): WorkflowArchitecturePlan {
	if (!isPlanIdSafe(input.planId)) {
		throw new Error(`Invalid planId: ${input.planId}`);
	}

	const now = toIsoDate();
	const plan: WorkflowArchitecturePlan = {
		planId: input.planId,
		taskId: trimString(input.taskId) || undefined,
		title: trimString(input.title) || undefined,
		createdAt: now,
		updatedAt: now,
		status: input.status ?? "draft",
		businessPlan: trimString(input.businessPlan),
		technicalPlan: trimString(input.technicalPlan),
		parallelAssessment: trimString(input.parallelAssessment),
		contractBlockPlan: trimString(input.contractBlockPlan),
		acceptanceCriteria: normalizeStringArray(input.acceptanceCriteria),
		files: normalizeStringArray(input.files),
		openQuestions: normalizeStringArray(input.openQuestions),
		phases: {
			phaseA: defaultPhase(),
			phaseB: defaultPhase(),
		},
	};

	if (!plan.businessPlan || !plan.technicalPlan || !plan.parallelAssessment || !plan.contractBlockPlan) {
		throw new Error("Business/technical/parallel/contract plan fields are required.");
	}
	if (plan.acceptanceCriteria.length === 0) {
		throw new Error("At least one acceptance criterion is required.");
	}
	const createMatrix = normalizeMatrix(input.acceptanceEvidenceMatrix);
	if (createMatrix.issues.length > 0) {
		throw new Error(`acceptanceEvidenceMatrix is invalid: ${formatMatrixValidationIssues(createMatrix.issues)}`);
	}
	if (createMatrix.value !== undefined && createMatrix.value.length > 0) {
		plan.acceptanceEvidenceMatrix = createMatrix.value;
	}
	if (plan.files?.length === 0) delete (plan as { files?: string[] }).files;
	if (plan.openQuestions?.length === 0) delete (plan as { openQuestions?: string[] }).openQuestions;

	// Ready-plan hard-lock: status=ready must come with a structurally valid,
	// fully covered acceptanceEvidenceMatrix. Draft plans are still allowed
	// to omit the matrix so simple/admin/planning flows stay lightweight.
	assertReadyMatrix(plan);

	writeArchitecturePlan(input.cwd, plan, input.sessionManager);
	return plan;
}

export function writeArchitecturePlan(cwd: string, plan: WorkflowArchitecturePlan, sessionManager?: any): void {
	if (!isPlanIdSafe(plan.planId)) {
		throw new Error(`Invalid planId: ${plan.planId}`);
	}
	const { file } = getPlanStoragePath(cwd, plan.planId, sessionManager);
	plan.updatedAt = toIsoDate();
	// Strip the symbol-keyed read-issue marker so the on-disk file never carries
	// internal validation metadata (also forces JSON.stringify to behave the same).
	stripMatrixReadIssues(plan);
	writeJson(file, plan);
}

export function updatePlanPhase(
	cwd: string,
	planId: string,
	phase: WorkflowPhaseId,
	nextStatus: PhaseGateStatus,
	note: string | null,
	sessionManager?: any,
): WorkflowArchitecturePlan {
	const plan = readArchitecturePlan(cwd, planId, sessionManager);
	if (!plan) throw new Error(`Plan not found: ${planId}`);

	const safeNote = trimString(note);
	const evidence: PhaseEvidence | null = safeNote
		? { at: toIsoDate(), note: safeNote }
		: null;
	const current = plan.phases[phase];
	const next: ArchitecturePlanPhases = {
		...plan.phases,
		[phase]: {
			status: nextStatus,
			updatedAt: toIsoDate(),
			evidence: evidence ? [...current.evidence, evidence] : [...current.evidence],
		},
	};

	const updated = { ...plan, phases: next };
	// Ready-plan hard-lock: legacy/no-matrix or malformed-matrix plans must not be
	// phase-mutated (the matrix on disk is invalid; the plan is still readable so
	// Brain/coder can update the matrix via updatePlanRecord first).
	assertReadyMatrix(updated);
	writeArchitecturePlan(cwd, updated, sessionManager);
	return updated;
}

export function updatePlanRecord(
	cwd: string,
	planId: string,
	patch: ArchitecturePlanPatch,
	sessionManager?: any,
): WorkflowArchitecturePlan {
	const plan = readArchitecturePlan(cwd, planId, sessionManager);
	if (!plan) throw new Error(`Plan not found: ${planId}`);
	const nextStatus = patch.status ?? plan.status;
	const normalized: WorkflowArchitecturePlan = {
		...plan,
		status: nextStatus,
		businessPlan: patch.businessPlan !== undefined ? trimString(patch.businessPlan) : plan.businessPlan,
		technicalPlan: patch.technicalPlan !== undefined ? trimString(patch.technicalPlan) : plan.technicalPlan,
		parallelAssessment: patch.parallelAssessment !== undefined ? trimString(patch.parallelAssessment) : plan.parallelAssessment,
		contractBlockPlan: patch.contractBlockPlan !== undefined ? trimString(patch.contractBlockPlan) : plan.contractBlockPlan,
		acceptanceCriteria: patch.acceptanceCriteria !== undefined ? normalizeStringArray(patch.acceptanceCriteria) : plan.acceptanceCriteria,
		files: patch.files !== undefined ? normalizeStringArray(patch.files) : (plan.files ?? []),
		taskId: trimString(patch.taskId) || plan.taskId,
		title: trimString(patch.title) || plan.title,
		openQuestions: patch.openQuestions !== undefined
			? normalizeStringArray(patch.openQuestions)
			: (plan.openQuestions ?? []),
		updatedAt: toIsoDate(),
	};
	if (!normalized.acceptanceCriteria.length) {
		throw new Error("acceptanceCriteria cannot be empty.");
	}
	if (normalized.businessPlan === "") throw new Error("businessPlan cannot be empty.");
	if (normalized.technicalPlan === "") throw new Error("technicalPlan cannot be empty.");
	if (normalized.parallelAssessment === "") throw new Error("parallelAssessment cannot be empty.");
	if (normalized.contractBlockPlan === "") throw new Error("contractBlockPlan cannot be empty.");

	if (normalized.files?.length === 0) delete (normalized as { files?: string[] }).files;
	if (normalized.openQuestions?.length === 0) delete (normalized as { openQuestions?: string[] }).openQuestions;

	if (Object.prototype.hasOwnProperty.call(patch, "acceptanceEvidenceMatrix")) {
		const updateMatrix = normalizeMatrix(patch.acceptanceEvidenceMatrix);
		if (updateMatrix.issues.length > 0) {
			throw new Error(`acceptanceEvidenceMatrix is invalid: ${formatMatrixValidationIssues(updateMatrix.issues)}`);
		}
		if (updateMatrix.value !== undefined && updateMatrix.value.length > 0) {
			normalized.acceptanceEvidenceMatrix = updateMatrix.value;
		} else {
			delete (normalized as { acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[] }).acceptanceEvidenceMatrix;
		}
		// Successful matrix replacement: clear any Symbol-keyed read issues inherited
		// from the malformed on-disk plan so assertReadyMatrix can pass on the
		// repaired plan. If no replacement matrix is supplied, read issues are left
		// intact so they continue to block ready plan updates/delegation.
		stripMatrixReadIssues(normalized);
	}

	// Ready-plan hard-lock after all patches are applied: catches draft -> ready
	// transitions that did not supply a matrix in the same patch, as well as
	// updates that drop matrix entries from a plan that was already ready.
	assertReadyMatrix(normalized);

	writeArchitecturePlan(cwd, normalized, sessionManager);
	return normalized;
}

// Re-export gate/context helpers so existing callers can keep importing from store.
export { validatePhaseGate, buildArchitectureContext, buildContextForPhase };
