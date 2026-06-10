// TASK-006 Phase B — sprint subsystem planning-gate wrapper.
// Pure helper that wraps the workflow-runtime gate evaluator for the
// non-trivial sprint entry points (sprint_create, sprint_create_task,
// sprint_create_epic, sprint_start_task_session, and sprint_debug
// action=promote). Returns either { allowed: true } or a structured
// error payload the tool/command handler can return to Brain.

import {
	PlanningGateResult,
	PlanningStateRecord,
} from "../workflow/planning-state";
import {
	PlanningGateErrorDetails,
	buildGateErrorDetails,
	formatGateErrorText,
} from "../workflow/planning-gate-runtime";

export interface SprintPlanningGateOutcome {
	allowed: boolean;
	details: PlanningGateErrorDetails;
	text: string;
}

export interface SprintPlanningGateOptions {
	allowTinyDebugBypass?: boolean;
}

export function gateSprintEntryPoint(
	cwd: string,
	explicitRoomId: unknown,
	gate: "sprint" | "implementation",
	options: SprintPlanningGateOptions = {},
): SprintPlanningGateOutcome {
	const details = buildGateErrorDetails(cwd, explicitRoomId, gate, {
		allowTinyDebugBypass: options.allowTinyDebugBypass ?? false,
	});
	return {
		allowed: details.allowed,
		details,
		text: formatGateErrorText(details),
	};
}

export function sprintGateErrorResult(details: PlanningGateErrorDetails) {
	return {
		isError: true,
		content: [{ type: "text" as const, text: formatGateErrorText(details) }],
		details,
	};
}

export type { PlanningGateResult, PlanningStateRecord, PlanningGateErrorDetails };
