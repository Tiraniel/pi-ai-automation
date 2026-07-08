// TASK-006 Phase B — PRD-first planning gate runtime helper.
// Thin orchestration layer over `extensions/workflow/planning-state.ts` that:
//   1. Resolves the planning room id from an explicit `planningRoomId` param,
//      the active planning-room fallback pointer (`.pi/workflow-runs/planning-current.json`),
//      or conservatively from `.pi/workflow-runs/current.json` when it points at a room
//      that already has planning state.
//   2. Reads the planning state from disk and runs the fail-closed gate
//      evaluators (`evaluateSprintPlanningGate` / `evaluateImplementationGate`).
//   3. Produces structured, actionable gate error shapes that delegate/sprint
//      tools/commands can return so the caller knows exactly which flags are
//      missing and which durable artifact paths the user must update.
//
// The helper reads from disk with one deliberate exception: when a planning
// room is resolved through the volatile `.pi/workflow-runs/current.json`
// fallback, the dedicated planning pointer is pinned (adopt-and-persist) so
// later resolutions no longer race against unrelated room activity. All
// transitions / scope changes / invalidations are still produced by the
// `workflow_planning_state` AI tool (in `planning-tools.ts`) which calls the
// pure Phase A writers.

import {
	PLANNING_STATE_NAMES,
	PlanningGateCode,
	PlanningGateResult,
	PlanningStateName,
	PlanningStateRecord,
	evaluateImplementationGate as evaluateImplementationGatePhaseA,
	evaluateSprintPlanningGate as evaluateSprintPlanningGatePhaseA,
	readPlanningState as readPlanningStatePhaseA,
	validatePlanningRoomId,
} from "./planning-state";
import {
	planningRoomHasStateFile,
	readPlanningCurrentRoomPointerResult,
	readWorkflowCurrentRoomPointer,
	planningCurrentRoomPointerPath,
	workflowCurrentRoomPointerPath,
	writePlanningCurrentRoomPointer,
} from "./planning-pointer";

// ----- room pointer resolution -------------------------------------------------

export interface PlanningRoomResolution {
	planningRoomId: string | null;
	source: "params" | "activePointer" | "missing";
	pointerPath: string;
	issue?: string;
}

export function resolvePlanningRoomId(cwd: string, explicitRoomId: unknown): PlanningRoomResolution {
	const fromParams = typeof explicitRoomId === "string" ? explicitRoomId.trim() : "";
	if (fromParams) {
		try {
			return { planningRoomId: validatePlanningRoomId(fromParams), source: "params", pointerPath: planningCurrentRoomPointerPath(cwd) };
		} catch (error) {
			const issue = error instanceof Error ? error.message : String(error);
			return { planningRoomId: null, source: "params", pointerPath: planningCurrentRoomPointerPath(cwd), issue };
		}
	}

	const planningPointer = readPlanningCurrentRoomPointerResult(cwd);
	let planningPointerRoomId: string | null = null;
	if (planningPointer.exists && planningPointer.roomId === null) {
		return {
			planningRoomId: null,
			source: "activePointer",
			pointerPath: planningCurrentRoomPointerPath(cwd),
			issue: `${planningPointer.issue || "planning room pointer is malformed"} (from dedicated planning-room pointer)`,
		};
	}
	if (planningPointer.exists && planningPointer.roomId) {
		try {
			planningPointerRoomId = validatePlanningRoomId(planningPointer.roomId);
			if (planningRoomHasStateFile(cwd, planningPointerRoomId)) {
				return { planningRoomId: planningPointerRoomId, source: "activePointer", pointerPath: planningCurrentRoomPointerPath(cwd) };
			}
		} catch (error) {
			const issue = error instanceof Error ? error.message : String(error);
			return {
				planningRoomId: null,
				source: "activePointer",
				pointerPath: planningCurrentRoomPointerPath(cwd),
				issue: `${issue} (from dedicated planning-room pointer ${planningPointer.roomId})`,
			};
		}
	}

	const workflowPointer = readWorkflowCurrentRoomPointer(cwd);
	if (!workflowPointer) {
		if (planningPointerRoomId) {
			return {
				planningRoomId: planningPointerRoomId,
				source: "activePointer",
				pointerPath: planningCurrentRoomPointerPath(cwd),
			};
		}
		return { planningRoomId: null, source: "missing", pointerPath: workflowCurrentRoomPointerPath(cwd) };
	}
	try {
		const workflowRoomId = validatePlanningRoomId(workflowPointer);
		if (planningRoomHasStateFile(cwd, workflowRoomId)) {
			// Adopt-and-persist: `.pi/workflow-runs/current.json` is a volatile
			// global pointer that any room_create rewrites; once a planning room
			// is resolved through it, pin the dedicated planning pointer so the
			// resolution stays stable for this cwd (legacy-room migration path).
			try {
				writePlanningCurrentRoomPointer(cwd, workflowRoomId);
			} catch {
				// best effort — resolution still succeeds without the pin
			}
			return { planningRoomId: workflowRoomId, source: "activePointer", pointerPath: workflowCurrentRoomPointerPath(cwd) };
		}
		return planningPointerRoomId
			? { planningRoomId: planningPointerRoomId, source: "activePointer", pointerPath: planningCurrentRoomPointerPath(cwd) }
			: { planningRoomId: null, source: "missing", pointerPath: workflowCurrentRoomPointerPath(cwd) };
	} catch (error) {
		const issue = error instanceof Error ? error.message : String(error);
		if (planningPointerRoomId) {
			return {
				planningRoomId: planningPointerRoomId,
				source: "activePointer",
				pointerPath: planningCurrentRoomPointerPath(cwd),
				issue,
			};
		}
		return { planningRoomId: null, source: "activePointer", pointerPath: workflowCurrentRoomPointerPath(cwd), issue: `${issue} (from active workflow-room pointer ${workflowPointer})` };
	}
}

// ----- state read with structured fallback ------------------------------------

export interface PlanningStateResolution {
	state: PlanningStateRecord | null;
	planningRoomId: string | null;
	roomSource: PlanningRoomResolution["source"];
	pointerPath: string;
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
		return { state: null, planningRoomId: null, roomSource: room.source, pointerPath: room.pointerPath, issue: room.issue, issueCode: "planning_room_id_invalid" };
	}
	if (!room.planningRoomId) {
		return { state: null, planningRoomId: null, roomSource: room.source, pointerPath: room.pointerPath };
	}
	const result = readPlanningStatePhaseA(cwd, room.planningRoomId);
	if (!result.state) {
		return {
			state: null,
			planningRoomId: room.planningRoomId,
			roomSource: room.source,
			pointerPath: room.pointerPath,
			issue: result.issue?.message,
			issueCode: result.issue?.code,
		};
	}
	return { state: result.state, planningRoomId: room.planningRoomId, roomSource: room.source, pointerPath: room.pointerPath };
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
		pointerPath: resolution.pointerPath,
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

// ----- single entry point for tool/command callers ------------------------------

export interface PlanningGateOutcome {
	allowed: boolean;
	details: PlanningGateErrorDetails;
	text: string;
}

/**
 * Evaluate a planning gate for a cwd: resolve the planning room, run the
 * fail-closed evaluator, and return the outcome together with the formatted
 * error text callers surface when `allowed` is false. This is the one
 * interface sprint tools/commands/hooks and delegate tools go through.
 */
export function evaluatePlanningGate(
	cwd: string,
	explicitRoomId: unknown,
	gate: "sprint" | "implementation",
	options: RuntimeGateOptions = {},
): PlanningGateOutcome {
	const details = buildGateErrorDetails(cwd, explicitRoomId, gate, options);
	return { allowed: details.allowed, details, text: formatGateErrorText(details) };
}

/** Standard error-shaped tool result for a denied planning gate. */
export function planningGateErrorResult(details: PlanningGateErrorDetails) {
	return {
		isError: true,
		content: [{ type: "text" as const, text: formatGateErrorText(details) }],
		details,
	};
}
