import * as path from "node:path";
import { resolveSprintPathForStore } from "./sprint-path";

import type {
	WorkflowArchitecturePlan,
	WorkflowPhaseId,
	PlanLifecycleStatus,
	PhaseEvidence,
	PhaseGateStatus,
	PlanGateResult,
	ArchitecturePlanPatch,
	ArchitecturePlanReadResult,
	ArchitecturePlanReadIssue,
	ArchitecturePlanPhases,
	PlanStoragePath,
	PlanGateRejection,
} from "./types";
import type { PlanStorageLookupError } from "./storage";
import { planStorageError, readJson, writeJson } from "./storage";

const PLAN_ID_SAFE_RE = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
const DEFAULT_PLAN_ROOT = path.join(".pi", "workflow-architecture", "plans");

function toIsoDate(): string {
	return new Date().toISOString();
}

function normalizeString(value: unknown): string {
	if (typeof value === "string") return value.trim();
	return "";
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		const v = normalizeString(entry);
		if (!v) continue;
		out.push(v);
	}
	return out;
}


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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanIdSafe(planId: string): boolean {
	return PLAN_ID_SAFE_RE.test(planId);
}


function normalizePhase(value: unknown): ReturnType<typeof defaultPhase> | undefined {
	if (!isPlainObject(value)) return undefined;
	const statusValue = normalizeString(value.status);
	if (
		statusValue !== "not_started" &&
		statusValue !== "coder_completed" &&
		statusValue !== "review_approved" &&
		statusValue !== "changes_requested"
	) return undefined;

	const updatedAt = normalizeString(value.updatedAt);
	if (!updatedAt) return undefined;

	const evidence: PhaseEvidence[] = [];
	if (Array.isArray((value as { evidence?: unknown }).evidence)) {
		for (const item of (value as { evidence?: unknown }).evidence as unknown[]) {
			if (!isPlainObject(item)) continue;
			const note = normalizeString(item.note);
			const at = normalizeString(item.at);
			if (!note || !at) continue;
			evidence.push({ at, note, source: normalizeString(item.source) || undefined });
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

	const planId = normalizeString(input.planId).toLowerCase();
	if (!isPlanIdSafe(planId)) return null;

	const status = normalizeString(input.status) as PlanLifecycleStatus;
	if (status !== "ready" && status !== "draft") return null;

	const createdAt = normalizeString(input.createdAt);
	const updatedAt = normalizeString(input.updatedAt);
	if (!createdAt || !updatedAt) return null;

	const businessPlan = normalizeString(input.businessPlan);
	const technicalPlan = normalizeString(input.technicalPlan);
	const parallelAssessment = normalizeString(input.parallelAssessment);
	const contractBlockPlan = normalizeString(input.contractBlockPlan);
	if (!businessPlan || !technicalPlan || !parallelAssessment || !contractBlockPlan) return null;

	const acceptanceCriteria = normalizeStringArray(input.acceptanceCriteria);
	if (!acceptanceCriteria.length) return null;

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
		taskId: normalizeString(input.taskId) || undefined,
		title: normalizeString(input.title) || undefined,
		files: normalizeStringArray(input.files),
		openQuestions: normalizeStringArray(input.openQuestions),
	};

	if (plan.files?.length === 0) delete (plan as { files?: string[] }).files;
	if (plan.openQuestions?.length === 0) delete (plan as { openQuestions?: string[] }).openQuestions;
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
		taskId: normalizeString(input.taskId) || undefined,
		title: normalizeString(input.title) || undefined,
		createdAt: now,
		updatedAt: now,
		status: input.status ?? "draft",
		businessPlan: normalizeString(input.businessPlan),
		technicalPlan: normalizeString(input.technicalPlan),
		parallelAssessment: normalizeString(input.parallelAssessment),
		contractBlockPlan: normalizeString(input.contractBlockPlan),
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
	if (plan.files?.length === 0) delete (plan as { files?: string[] }).files;
	if (plan.openQuestions?.length === 0) delete (plan as { openQuestions?: string[] }).openQuestions;

	writeArchitecturePlan(input.cwd, plan, input.sessionManager);
	return plan;
}

export function writeArchitecturePlan(cwd: string, plan: WorkflowArchitecturePlan, sessionManager?: any): void {
	if (!isPlanIdSafe(plan.planId)) {
		throw new Error(`Invalid planId: ${plan.planId}`);
	}
	const { file } = getPlanStoragePath(cwd, plan.planId, sessionManager);
	plan.updatedAt = toIsoDate();
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

	const safeNote = normalizeString(note);
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
	const normalized: WorkflowArchitecturePlan = {
		...plan,
		status: patch.status ?? plan.status,
		businessPlan: patch.businessPlan !== undefined ? normalizeString(patch.businessPlan) : plan.businessPlan,
		technicalPlan: patch.technicalPlan !== undefined ? normalizeString(patch.technicalPlan) : plan.technicalPlan,
		parallelAssessment: patch.parallelAssessment !== undefined ? normalizeString(patch.parallelAssessment) : plan.parallelAssessment,
		contractBlockPlan: patch.contractBlockPlan !== undefined ? normalizeString(patch.contractBlockPlan) : plan.contractBlockPlan,
		acceptanceCriteria: patch.acceptanceCriteria !== undefined ? normalizeStringArray(patch.acceptanceCriteria) : plan.acceptanceCriteria,
		files: patch.files !== undefined ? normalizeStringArray(patch.files) : (plan.files ?? []),
		taskId: normalizeString(patch.taskId) || plan.taskId,
		title: normalizeString(patch.title) || plan.title,
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

	writeArchitecturePlan(cwd, normalized, sessionManager);
	return normalized;
}

function addGate(
	rejections: PlanGateRejection[],
	code: PlanGateRejection["code"],
	reason: string,
): void {
	rejections.push({ code, reason });
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
	return { ok: rejections.length === 0, rejections };
}

export function buildArchitectureContext(plan: WorkflowArchitecturePlan, options: { phase: WorkflowPhaseId; forAgent?: "coder" | "reviewer" }): string {
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

	return lines.join("\n");
}

export function buildContextForPhase(plan: WorkflowArchitecturePlan, phase: WorkflowPhaseId): string {
	return buildArchitectureContext(plan, { phase });
}
