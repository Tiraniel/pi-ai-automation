// TASK-006 Phase B — PRD-first planning gate runtime helper.
// Thin orchestration layer over `extensions/workflow/planning-state.ts` that:
//   1. Resolves the planning room id from an explicit `planningRoomId` param
//      or the active workflow room pointer at `.pi/workflow-runs/current.json`.
//   2. Reads the planning state from disk and runs the fail-closed gate
//      evaluators (`evaluateSprintPlanningGate` / `evaluateImplementationGate`).
//   3. Produces structured, actionable gate error shapes that delegate/sprint
//      tools/commands can return so the caller knows exactly which flags are
//      missing and which durable artifact paths the user must update.
//
// The helper is intentionally side-effect free: it only reads from disk. All
// transitions / scope changes / invalidations are still produced by the
// `workflow_planning_state` AI tool (in `planning-tools.ts`) which calls the
// pure Phase A writers.

import {
	PLANNING_STATE_NAMES,
	PlanningGateCode,
	PlanningGateResult,
	PlanningStateName,
	PlanningStateRecord,
	readCurrentRoomPointer as readCurrentRoomPointerFromState,
	evaluateImplementationGate as evaluateImplementationGatePhaseA,
	evaluateSprintPlanningGate as evaluateSprintPlanningGatePhaseA,
	readPlanningState as readPlanningStatePhaseA,
	validatePlanningRoomId,
} from "./planning-state";

// ----- room pointer resolution -------------------------------------------------

export interface PlanningRoomResolution {
	planningRoomId: string | null;
	source: "params" | "activePointer" | "missing";
	pointerPath: string;
	issue?: string;
}

export function resolvePlanningRoomId(cwd: string, explicitRoomId: unknown): PlanningRoomResolution {
	const pointerPath = `.pi/workflow-runs/current.json`;
	const fromParams = typeof explicitRoomId === "string" ? explicitRoomId.trim() : "";
	if (fromParams) {
		try {
			return { planningRoomId: validatePlanningRoomId(fromParams), source: "params", pointerPath };
		} catch (error) {
			const issue = error instanceof Error ? error.message : String(error);
			return { planningRoomId: null, source: "params", pointerPath, issue };
		}
	}
	const fromPointer = readCurrentRoomPointerFromState(cwd);
	if (fromPointer) {
		try {
			return { planningRoomId: validatePlanningRoomId(fromPointer), source: "activePointer", pointerPath };
		} catch (error) {
			const issue = error instanceof Error ? error.message : String(error);
			return { planningRoomId: null, source: "activePointer", pointerPath, issue: `${issue} (from active planning room pointer ${fromPointer})` };
		}
	}
	return { planningRoomId: null, source: "missing", pointerPath };
}

// ----- state read with structured fallback ------------------------------------

export interface PlanningStateResolution {
	state: PlanningStateRecord | null;
	planningRoomId: string | null;
	roomSource: PlanningRoomResolution["source"];
	issue?: string;
	issueCode?: string;
	artifactPath?: string;
}

export function resolvePlanningStateForCwd(
	cwd: string,
	explicitRoomId: unknown,
): PlanningStateResolution {
	const room = resolvePlanningRoomId(cwd, explicitRoomId);
	if (room.issue) {
		return { state: null, planningRoomId: null, roomSource: room.source, issue: room.issue, issueCode: "planning_room_id_invalid" };
	}
	if (!room.planningRoomId) {
		return { state: null, planningRoomId: null, roomSource: room.source };
	}
	const result = readPlanningStatePhaseA(cwd, room.planningRoomId);
	if (!result.state) {
		return {
			state: null,
			planningRoomId: room.planningRoomId,
			roomSource: room.source,
			issue: result.issue?.message,
			issueCode: result.issue?.code,
		};
	}
	return { state: result.state, planningRoomId: room.planningRoomId, roomSource: room.source };
}

// ----- gate evaluators wired to runtime resolution ----------------------------

export interface RuntimeGateOptions {
	allowTinyDebugBypass?: boolean;
}

function invalidPlanningRoomGateResult(gate: "sprint" | "implementation", issue: string): PlanningGateResult {
	return {
		ok: false,
		allowed: false,
		gate,
		codes: ["planning_room_id_invalid"],
		summary: issue,
		missing: [...PLANNING_STATE_NAMES],
		artifactPath: undefined,
		details: {
			statePresent: false,
			scopeClassification: null,
			flags: {
				prd_started: false,
				prd_ready_for_sprint: false,
				sprint_confirmed: false,
				implementation_confirmed: false,
			},
			invalidatedBy: null,
		},
	};
}

export function evaluateSprintGateForCwd(
	cwd: string,
	explicitRoomId: unknown,
	options: RuntimeGateOptions = {},
): PlanningGateResult {
	const resolution = resolvePlanningStateForCwd(cwd, explicitRoomId);
	if (resolution.issueCode === "planning_room_id_invalid" && resolution.issue) {
		return invalidPlanningRoomGateResult("sprint", resolution.issue);
	}
	return evaluateSprintPlanningGatePhaseA(resolution.state, options);
}

export function evaluateImplementationGateForCwd(
	cwd: string,
	explicitRoomId: unknown,
	options: RuntimeGateOptions = {},
): PlanningGateResult {
	const resolution = resolvePlanningStateForCwd(cwd, explicitRoomId);
	if (resolution.issueCode === "planning_room_id_invalid" && resolution.issue) {
		return invalidPlanningRoomGateResult("implementation", resolution.issue);
	}
	return evaluateImplementationGatePhaseA(resolution.state, options);
}

// ----- error formatting --------------------------------------------------------

export interface PlanningGateErrorDetails {
	gate: "sprint" | "implementation";
	allowed: boolean;
	codes: PlanningGateCode[];
	missing: PlanningStateName[];
	planningRoomId: string | null;
	artifactPath?: string;
	statePresent: boolean;
	scopeClassification: PlanningStateRecord["scopeClassification"] | null;
	flags: Record<PlanningStateName, boolean>;
	invalidatedBy: PlanningStateRecord["invalidatedBy"] | null;
	summary: string;
	pointerPath: string;
	roomSource: PlanningRoomResolution["source"];
	stateIssue?: string;
	stateIssueCode?: string;
}

export function buildGateErrorDetails(
	cwd: string,
	explicitRoomId: unknown,
	gate: "sprint" | "implementation",
	options: RuntimeGateOptions = {},
): PlanningGateErrorDetails {
	const resolution = resolvePlanningStateForCwd(cwd, explicitRoomId);
	const result =
		resolution.issueCode === "planning_room_id_invalid" && resolution.issue
			? invalidPlanningRoomGateResult(gate, resolution.issue)
			: gate === "sprint"
				? evaluateSprintPlanningGatePhaseA(resolution.state, options)
				: evaluateImplementationGatePhaseA(resolution.state, options);
	return {
		gate,
		allowed: result.allowed,
		codes: result.codes,
		missing: result.missing,
		planningRoomId: resolution.planningRoomId,
		artifactPath: result.artifactPath ?? resolution.state?.artifactPaths.prd,
		statePresent: result.details.statePresent,
		scopeClassification: result.details.scopeClassification,
		flags: result.details.flags,
		invalidatedBy: result.details.invalidatedBy,
		summary: result.summary,
		pointerPath: `.pi/workflow-runs/current.json`,
		roomSource: resolution.roomSource,
		stateIssue: resolution.issue,
		stateIssueCode: resolution.issueCode,
	};
}

export function formatGateErrorText(details: PlanningGateErrorDetails): string {
	const lines = [details.summary];
	if (details.planningRoomId) {
		lines.push(`planningRoomId=${details.planningRoomId} (source=${details.roomSource})`);
	} else {
		lines.push(
			`No planning room resolved. Pass planningRoomId or call workflow_planning_state to create a planning room under .pi/workflow-runs/<room>/`,
		);
	}
	if (details.artifactPath) lines.push(`artifactPath=${details.artifactPath}`);
	if (details.stateIssue) lines.push(`stateIssue=${details.stateIssue}`);
	if (details.missing.length) lines.push(`missingFlags=${details.missing.join(", ")}`);
	if (details.codes.length) lines.push(`codes=${details.codes.join(", ")}`);
	if (details.invalidatedBy) {
		lines.push(
			`invalidatedBy=${details.invalidatedBy.kind} reason=${details.invalidatedBy.reason || "(none)"} cleared=${details.invalidatedBy.clearedFlags.join(", ")}`,
		);
	}
	lines.push(
		"Use the workflow_planning_state tool to record prd_started, prd_ready_for_sprint, sprint_confirmed, and (for delegate_to_coder) implementation_confirmed; gate approvals must be explicit stage text (e.g. 'confirm sprint creation' / 'confirm implementation'). Generic 'approved/yes/ok' is planning-only.",
	);
	return lines.join("\n");
}

// ----- helper for callers -----------------------------------------------------

export const ALL_PLANNING_STATE_NAMES: readonly PlanningStateName[] = PLANNING_STATE_NAMES;
