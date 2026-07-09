// WP5 — OSOT plan freeze per phase (port of the agent-harness sha256 freeze
// into the main workflow). On the first `delegate_to_coder` of a phase the
// plan CONTRACT is snapshotted to
// `.pi/workflow-architecture/plans/<planId>.<phase>.frozen.json` with its
// sha256; the coder phase-advancement gate and the reviewer path then verify
// the CURRENT on-disk plan against the snapshot. Any divergence (the plan
// changed after the phase started) blocks with `plan_drift_detected` until
// the operator/Brain explicitly re-baselines via
// `workflow_update_architecture_plan { rebaselinePhase: true }`, which
// re-freezes the snapshot and resets the phase to `not_started` — the same
// "contract change resets clearances" semantics as planning-state
// invalidation.
//
// The frozen contract deliberately EXCLUDES volatile fields (createdAt /
// updatedAt / phases): phase progress is supposed to change during a phase;
// the business/technical contract is not.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../fs-atomic";
import { getPlanStoragePath, readArchitecturePlan } from "./store";
import type { WorkflowArchitecturePlan, WorkflowPhaseId, AcceptanceEvidenceMatrixEntry, PlanLifecycleStatus } from "./types";

export const PLAN_FREEZE_VERSION = 1;

/** The frozen, drift-checked half of a plan: everything a coder/reviewer is
 *  graded against. Volatile lifecycle fields (createdAt/updatedAt/phases)
 *  are excluded by construction. */
export interface PlanContractShape {
	planId: string;
	taskId?: string;
	title?: string;
	status: PlanLifecycleStatus;
	businessPlan: string;
	technicalPlan: string;
	parallelAssessment: string;
	contractBlockPlan: string;
	acceptanceCriteria: string[];
	acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[];
	files?: string[];
	openQuestions?: string[];
}

export interface FrozenPlanSnapshot {
	version: typeof PLAN_FREEZE_VERSION;
	planId: string;
	phase: WorkflowPhaseId;
	frozenAt: string;
	sha256: string;
	contract: PlanContractShape;
}

export type PlanDriftStatus = "no_snapshot" | "match" | "drift" | "snapshot_unreadable" | "plan_unreadable";

export interface PlanDriftCheck {
	status: PlanDriftStatus;
	planId: string;
	phase: WorkflowPhaseId;
	/** sha256 recorded in the frozen snapshot (absent when no snapshot). */
	expectedSha256?: string;
	/** sha256 of the current on-disk plan contract (absent when unreadable). */
	currentSha256?: string;
	frozenAt?: string;
	file: string;
	reason?: string;
}

export function planContractShape(plan: WorkflowArchitecturePlan): PlanContractShape {
	const contract: PlanContractShape = {
		planId: plan.planId,
		status: plan.status,
		businessPlan: plan.businessPlan,
		technicalPlan: plan.technicalPlan,
		parallelAssessment: plan.parallelAssessment,
		contractBlockPlan: plan.contractBlockPlan,
		acceptanceCriteria: [...plan.acceptanceCriteria],
	};
	if (plan.taskId) contract.taskId = plan.taskId;
	if (plan.title) contract.title = plan.title;
	if (plan.acceptanceEvidenceMatrix?.length) contract.acceptanceEvidenceMatrix = plan.acceptanceEvidenceMatrix;
	if (plan.files?.length) contract.files = [...plan.files];
	if (plan.openQuestions?.length) contract.openQuestions = [...plan.openQuestions];
	return contract;
}

/** Deterministic JSON: object keys sorted recursively so the hash is stable
 *  across property-insertion order. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function computePlanContractSha256(plan: WorkflowArchitecturePlan): string {
	return crypto.createHash("sha256").update(canonicalJson(planContractShape(plan))).digest("hex");
}

export function frozenPlanPathFor(cwd: string, planId: string, phase: WorkflowPhaseId, sessionManager?: any): string {
	const { root } = getPlanStoragePath(cwd, planId, sessionManager);
	return path.join(root, `${planId}.${phase}.frozen.json`);
}

export function readFrozenPlanSnapshot(cwd: string, planId: string, phase: WorkflowPhaseId, sessionManager?: any): { snapshot: FrozenPlanSnapshot | undefined; exists: boolean; reason?: string; file: string } {
	const file = frozenPlanPathFor(cwd, planId, phase, sessionManager);
	if (!fs.existsSync(file)) return { snapshot: undefined, exists: false, file };
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		return { snapshot: undefined, exists: true, file, reason: `frozen snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (typeof raw !== "object" || raw === null) return { snapshot: undefined, exists: true, file, reason: "frozen snapshot root must be an object" };
	const record = raw as Record<string, unknown>;
	if (record.version !== PLAN_FREEZE_VERSION || typeof record.sha256 !== "string" || record.planId !== planId || record.phase !== phase) {
		return { snapshot: undefined, exists: true, file, reason: "frozen snapshot has a mismatched version/planId/phase or missing sha256" };
	}
	return { snapshot: raw as FrozenPlanSnapshot, exists: true, file };
}

export function freezePlanForPhase(cwd: string, plan: WorkflowArchitecturePlan, phase: WorkflowPhaseId, sessionManager?: any): FrozenPlanSnapshot {
	const snapshot: FrozenPlanSnapshot = {
		version: PLAN_FREEZE_VERSION,
		planId: plan.planId,
		phase,
		frozenAt: new Date().toISOString(),
		sha256: computePlanContractSha256(plan),
		contract: planContractShape(plan),
	};
	writeFileAtomicSync(frozenPlanPathFor(cwd, plan.planId, phase, sessionManager), `${JSON.stringify(snapshot, null, 2)}\n`);
	return snapshot;
}

/** Compare the CURRENT on-disk plan against the frozen phase snapshot.
 *  Fail-closed: an unreadable snapshot or plan is reported as its own
 *  status, never as a silent match. */
export function checkPlanDrift(cwd: string, planId: string, phase: WorkflowPhaseId, sessionManager?: any): PlanDriftCheck {
	const frozen = readFrozenPlanSnapshot(cwd, planId, phase, sessionManager);
	const plan = readArchitecturePlan(cwd, planId, sessionManager);
	const currentSha256 = plan ? computePlanContractSha256(plan) : undefined;
	if (!frozen.exists) {
		return { status: "no_snapshot", planId, phase, currentSha256, file: frozen.file };
	}
	if (!frozen.snapshot) {
		return { status: "snapshot_unreadable", planId, phase, currentSha256, file: frozen.file, reason: frozen.reason };
	}
	if (!plan || !currentSha256) {
		return { status: "plan_unreadable", planId, phase, expectedSha256: frozen.snapshot.sha256, frozenAt: frozen.snapshot.frozenAt, file: frozen.file, reason: "current plan is missing or unreadable" };
	}
	if (currentSha256 === frozen.snapshot.sha256) {
		return { status: "match", planId, phase, expectedSha256: frozen.snapshot.sha256, currentSha256, frozenAt: frozen.snapshot.frozenAt, file: frozen.file };
	}
	return {
		status: "drift",
		planId,
		phase,
		expectedSha256: frozen.snapshot.sha256,
		currentSha256,
		frozenAt: frozen.snapshot.frozenAt,
		file: frozen.file,
		reason: `plan contract changed after the ${phase} snapshot was frozen at ${frozen.snapshot.frozenAt}`,
	};
}

/** First-delegation hook: create the snapshot when none exists, otherwise
 *  return the drift check as-is. */
export function ensurePlanFrozenForPhase(cwd: string, plan: WorkflowArchitecturePlan, phase: WorkflowPhaseId, sessionManager?: any): { drift: PlanDriftCheck; created: boolean } {
	const drift = checkPlanDrift(cwd, plan.planId, phase, sessionManager);
	if (drift.status !== "no_snapshot") return { drift, created: false };
	const snapshot = freezePlanForPhase(cwd, plan, phase, sessionManager);
	return {
		drift: {
			status: "match",
			planId: plan.planId,
			phase,
			expectedSha256: snapshot.sha256,
			currentSha256: snapshot.sha256,
			frozenAt: snapshot.frozenAt,
			file: frozenPlanPathFor(cwd, plan.planId, phase, sessionManager),
		},
		created: true,
	};
}

export function formatPlanDriftText(drift: PlanDriftCheck): string {
	const base = `Plan freeze check for ${drift.planId}/${drift.phase}: ${drift.status}.`;
	if (drift.status === "match") return base;
	const parts = [base];
	if (drift.reason) parts.push(drift.reason);
	if (drift.expectedSha256) parts.push(`frozen sha256=${drift.expectedSha256.slice(0, 12)}…`);
	if (drift.currentSha256) parts.push(`current sha256=${drift.currentSha256.slice(0, 12)}…`);
	parts.push(`To accept the changed plan, re-baseline explicitly: workflow_update_architecture_plan { planId: "${drift.planId}", phase: "${drift.phase}", rebaselinePhase: true } — this re-freezes the snapshot and resets the phase to not_started.`);
	return parts.join(" ");
}
