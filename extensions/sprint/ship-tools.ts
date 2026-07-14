#!/usr/bin/env node
// TASK-011 Phase B — three-lane / AFK ship supervisor AI tool wiring.
// Pure thin TypeBox/ExtensionAPI registration around the Phase A contracts
// in `./lane-policy`, `./ship-state`, `./ship-engine`, and `./ship-report`.
// No fs/LLM work happens here; this module is the AI-facing surface that
// exposes `sprint_classify_lane` and `sprint_ship` and bridges their inputs
// to the durable state/report substrate under `.pi/workflow-runs/afk-ship/`.

import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ALL_AUTOMATION_LANES,
	ALL_DEBUG_NEXT_LANES,
	ALL_HOTFIX_KINDS,
	buildLaneSummary,
	evaluateLanePolicy,
	isAutomationLane,
	isDebugNextLane,
	isHotfixKind,
	requiresPromotion,
	requiresReviewer,
	type DebugNextLane,
	type LanePolicyInput,
} from "./lane-policy";
import {
	createInitialShipState,
	readShipState,
	shipReportPath,
	shipReportPathRelative,
	shipRunDir,
	shipStatePath,
	shipStatePathRelative,
	shipStateExists,
	writeShipReport,
	writeShipState,
	type CreateInitialShipStateInput,
	type ShipState,
} from "./ship-state";
import { renderShipReport } from "./ship-report";
import { transitionShipState, type ShipEvent, type ShipTransition } from "./ship-engine";
import { evaluatePlanningGate, planningGateErrorResult } from "../workflow/planning-gate-runtime";
import { listOpenBlockingQuestionsInFile, OPERATOR_QUESTIONS_FILE_NAME } from "../workflow/operator-questions";
import { loadWorkflowConfig } from "../workflow/runtime/config";
import { resolveLoopBudgetConfig } from "../workflow/loop-budget";

/** WP1: pin the run dir's unanswered blocking operator questions onto the
 *  state before the pure engine / report renderer consume it. */
function withOpenOperatorQuestions(cwd: string, state: ShipState): ShipState {
	const file = path.join(shipRunDir(cwd, state.runId), OPERATOR_QUESTIONS_FILE_NAME);
	const open = listOpenBlockingQuestionsInFile(file).map((q) => ({ id: q.id, question: q.question, from: q.from }));
	return { ...state, openOperatorQuestions: open };
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function asInt(value: unknown, fallback = 0): number {
	const n = Number(value);
	return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : Math.max(0, Math.floor(fallback));
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function okText(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function errText(text: string, details: Record<string, unknown> = {}) {
	return { isError: true, content: [{ type: "text" as const, text }], details };
}

function isShipEvent(value: unknown): value is ShipEvent {
	if (!value || typeof value !== "object") return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === "string" && [
		"diagnose",
		"select_next_lane",
		"select_report_only",
		"implement_started",
		"coder_completed",
		"reviewer_changes_requested",
		"reviewer_approved",
		"evidence_collected",
		"focused_fix_completed",
		"finalization_recorded",
		"remote_action_requested",
		"mark_blocked",
	].includes(kind);
}

function buildLanePolicyInput(params: Record<string, unknown>): LanePolicyInput {
	const input: LanePolicyInput = {
		lane: (params.lane as AutomationLane) ?? "hotfix",
		hotfixKind: isHotfixKind(params.hotfixKind) ? params.hotfixKind : undefined,
		scopeStatement: asString(params.scopeStatement) || undefined,
		changedFiles: asStringArray(params.changedFiles),
		changedLOC: asInt(params.changedLOC, 0),
		behaviorPaths: asInt(params.behaviorPaths, 0),
		architectureStateSchemaOrRefactor: params.architectureStateSchemaOrRefactor === true,
		rootCauseClear: params.rootCauseClear === false ? false : params.rootCauseClear === true ? true : undefined,
		repeatedSameAreaFixCount: asInt(params.repeatedSameAreaFixCount, 0),
		reviewerBroaderRisk: params.reviewerBroaderRisk === true,
		textOnlyClass: (params.textOnlyClass as LanePolicyInput["textOnlyClass"]) ?? "uncertain",
		textOnlyConcreteRefs: asStringArray(params.textOnlyConcreteRefs),
		textOnlyValidationEvidence: asStringArray(params.textOnlyValidationEvidence),
		diagnosis: asString(params.diagnosis) || undefined,
		rootCauseHypothesis: asString(params.rootCauseHypothesis) || undefined,
		affectedFiles: asStringArray(params.affectedFiles),
		riskAssessment: asString(params.riskAssessment) || undefined,
		recommendedNextLane: isDebugNextLane(params.recommendedNextLane) ? params.recommendedNextLane : undefined,
		selectedNextLane: isDebugNextLane(params.selectedNextLane) ? params.selectedNextLane : undefined,
		debugImplementationAttempt: params.debugImplementationAttempt === true,
		requestedRemoteAction: (params.requestedRemoteAction as LanePolicyInput["requestedRemoteAction"]) ?? undefined,
		remoteActionAuthorized: params.remoteActionAuthorized === true,
	};
	return input;
}

function generateRunId(taskId?: string): string {
	const seed = taskId ? taskId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32) : "ship";
	const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 8);
	return `afk-${seed || "ship"}-${stamp}-${rand}`;
}

function renderTransitionReply(transition: ShipTransition, runId: string, reportPath: string): string {
	const stopLine = transition.stopCondition ? ` stopCondition=${transition.stopCondition}` : "";
	const next = transition.state.nextAction ? ` nextAction=${transition.state.nextAction}` : "";
	const notes = transition.notes && transition.notes.length ? ` notes=${JSON.stringify(transition.notes)}` : "";
	return `runId=${runId} toStage=${transition.toStage}${stopLine}${next} reportPath=${reportPath}${notes}`;
}

export function registerSprintShipTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sprint_classify_lane",
		label: "Sprint: Classify Lane",
		description:
			"Classify an automation request into the three-lane policy: full-sprint, hotfix, or debug. " +
			"Hotfix kind can be code-changing (default) or text-evidence-only. " +
			"Debug recommendations must be exactly hotfix, full-sprint, or no-code/report-only.",
		promptSnippet: "Classify a request into the three-lane automation policy before deciding on planning depth.",
		promptGuidelines: [
			"Use sprint_classify_lane before deciding on planning depth, sprint task vs hotfix vs debug lane, or AFK supervisor scope.",
			"Lane vocabulary is exactly: full-sprint | hotfix | debug.",
			"Debug next-lane vocabulary is exactly: hotfix | full-sprint | no-code/report-only.",
			"Hotfix kind vocabulary is exactly: code-changing | text-evidence-only.",
			"Default reviewer rule: full-sprint and code-changing hotfix are reviewer-required; text-evidence-only hotfix can be evidence-only only when concrete refs and validation evidence are provided; debug is diagnostic-only.",
		],
		parameters: Type.Object({
			lane: Type.String({ description: "Lane vocabulary: full-sprint | hotfix | debug." }),
			hotfixKind: Type.Optional(Type.String({ description: "Hotfix kind vocabulary: code-changing | text-evidence-only. Only meaningful when lane=hotfix." })),
			scopeStatement: Type.Optional(Type.String({ description: "Short scope statement. Required for hotfix lane." })),
			changedFiles: Type.Optional(Type.Array(Type.String({ description: "Repo-relative file path." }))),
			changedLOC: Type.Optional(Type.Number({ description: "Total lines of code changed (rough estimate)." })),
			behaviorPaths: Type.Optional(Type.Number({ description: "Number of behavior paths touched." })),
			architectureStateSchemaOrRefactor: Type.Optional(Type.Boolean({ description: "True when the change touches architecture, state machines, schemas, persistence, or refactors." })),
			rootCauseClear: Type.Optional(Type.Boolean({ description: "Whether the root cause is well understood; false promotes." })),
			repeatedSameAreaFixCount: Type.Optional(Type.Number({ description: "Prior fixes in the same area; threshold is 2 by default." })),
			reviewerBroaderRisk: Type.Optional(Type.Boolean({ description: "True when reviewer flagged the change as broader/riskier than expected." })),
			textOnlyClass: Type.Optional(Type.String({ description: "Text-only classification: docs | prompt-template | typo | other | uncertain." })),
			textOnlyConcreteRefs: Type.Optional(Type.Array(Type.String({ description: "Concrete file/section refs (e.g. 'README.md#lanes')." }))),
			textOnlyValidationEvidence: Type.Optional(Type.Array(Type.String({ description: "Concrete validation evidence commands or smoke results." }))),
			diagnosis: Type.Optional(Type.String({ description: "Debug diagnosis text (required for debug lane)." })),
			rootCauseHypothesis: Type.Optional(Type.String({ description: "Debug root-cause hypothesis." })),
			affectedFiles: Type.Optional(Type.Array(Type.String({ description: "Repo-relative affected file paths (debug lane)." }))),
			riskAssessment: Type.Optional(Type.String({ description: "Risk assessment (debug lane)." })),
			recommendedNextLane: Type.Optional(Type.String({ description: "Debug next lane: hotfix | full-sprint | no-code/report-only." })),
			selectedNextLane: Type.Optional(Type.String({ description: "Selected next lane (debug): hotfix | full-sprint | no-code/report-only." })),
			debugImplementationAttempt: Type.Optional(Type.Boolean({ description: "True if debug session wants to perform implementation." })),
			requestedRemoteAction: Type.Optional(Type.String({ description: "Requested remote action: push | pr | deploy | destructive | credentialed." })),
			remoteActionAuthorized: Type.Optional(Type.Boolean({ description: "True if the user has explicitly authorized the remote action." })),
		}),
		execute: async (_id, params) => {
			const laneRaw = asString((params as any).lane, "");
			if (!isAutomationLane(laneRaw)) {
				return errText(
					`Invalid lane "${laneRaw}"; must be one of: ${ALL_AUTOMATION_LANES.join(", ")}.`,
					{ allowed: ALL_AUTOMATION_LANES, hotfixKinds: ALL_HOTFIX_KINDS, debugNextLanes: ALL_DEBUG_NEXT_LANES },
				);
			}
			const input = buildLanePolicyInput({ ...(params as Record<string, unknown>), lane: laneRaw });
			const decision = evaluateLanePolicy(input);
			const summary = buildLaneSummary(decision);
			return okText(summary, {
				decision,
				summary,
				requiresReviewer: requiresReviewer(decision),
				requiresPromotion: requiresPromotion(decision),
				allowed: ALL_AUTOMATION_LANES,
				hotfixKinds: ALL_HOTFIX_KINDS,
				debugNextLanes: ALL_DEBUG_NEXT_LANES,
			});
		},
	});

	pi.registerTool({
		name: "sprint_ship",
		label: "Sprint: AFK Ship Supervisor",
		description:
			"Local AFK ship supervisor for a single lane (full-sprint | hotfix | debug). " +
			"Persists durable state under .pi/workflow-runs/afk-ship/<runId>/state.json plus REPORT.md. " +
			"Default permissions deny push, PR, deploy, destructive, and credentialed actions. " +
			"Use action=start to create a run, action=read to inspect, action=transition to apply a ShipEvent, " +
			"and action=report to re-render REPORT.md. Full-sprint starts are gated by the PRD-first implementation gate; " +
			"hotfix/debug starts are lightweight and not PRD-gated. Code-changing hotfix reviewer requirement is enforced by Phase A contracts.",
		promptSnippet: "Drive the AFK ship supervisor for an authorized lane.",
		promptGuidelines: [
			"Call sprint_ship to create, read, transition, or re-render the AFK ship state for a run.",
			"Lane vocabulary: full-sprint | hotfix | debug. Hotfix kind: code-changing | text-evidence-only. Debug next lanes: hotfix | full-sprint | no-code/report-only.",
			"Default permissions deny push, PR, deploy, destructive, and credentialed actions; requests for these produce a stop condition unless explicitly authorized.",
			"Full-sprint start runs evaluatePlanningGate(...,'implementation'); if denied, the call returns a structured gate error and does NOT create state. There is no silent bypass.",
			"Hotfix and debug starts are lightweight and not PRD-gated; code-changing hotfixes still require reviewer by Phase A contract (the supervisor's durable state has reviewerRequired=true).",
			"This is a local-only MVP. The tool never shells out to git push, gh pr, deploy, publish, or any credentialed action. Remote actions are recorded in state and the engine emits a stop condition when unauthorized.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("start"),
				Type.Literal("read"),
				Type.Literal("transition"),
				Type.Literal("report"),
			], { description: "AFK ship supervisor action." }),
			runId: Type.Optional(Type.String({ description: "Existing run id; required for read/transition/report. Optional for start (auto-generated when omitted)." })),
			taskId: Type.Optional(Type.String({ description: "Optional TASK-ID the run is bound to." })),
			itemId: Type.Optional(Type.String({ description: "Optional DBG-ID for debug runs." })),
			lane: Type.Optional(Type.String({ description: "Lane: full-sprint | hotfix | debug. Default: full-sprint." })),
			hotfixKind: Type.Optional(Type.String({ description: "Hotfix kind: code-changing | text-evidence-only. Only when lane=hotfix." })),
			allowedScope: Type.Optional(Type.String({ description: "Short scope statement. Required for hotfix lane starts." })),
			retryBudget: Type.Optional(Type.Number({ description: "Maximum focused-fix retry budget. Default 3." })),
			diagnosis: Type.Optional(Type.String({ description: "Debug diagnosis. Used when lane=debug and action=start." })),
			rootCauseHypothesis: Type.Optional(Type.String({ description: "Debug root-cause hypothesis (lane=debug)." })),
			affectedFiles: Type.Optional(Type.Array(Type.String())),
			riskAssessment: Type.Optional(Type.String()),
			recommendedNextLane: Type.Optional(Type.String({ description: "Debug next lane: hotfix | full-sprint | no-code/report-only." })),
			selectedNextLane: Type.Optional(Type.String({ description: "Debug selected next lane: hotfix | full-sprint | no-code/report-only." })),
			planningRoomId: Type.Optional(Type.String({ description: "Optional planning room id for the full-sprint implementation gate. Falls back to .pi/workflow-runs/planning-current.json, then .pi/workflow-runs/current.json." })),
			event: Type.Optional(Type.Any({ description: "ShipEvent payload for action=transition. Required only for action=transition; ignored for start/read/report. See extensions/sprint/ship-engine.ts for the event shape." })),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const cwd = ctx.cwd;
			const action = asString((params as any).action, "").toLowerCase();
			if (!new Set(["start", "read", "transition", "report"]).has(action)) {
				return errText(`Unsupported action "${action}"; expected start|read|transition|report.`);
			}
			if (action === "start") {
				const laneRaw = asString((params as any).lane, "full-sprint");
				if (!isAutomationLane(laneRaw)) {
					return errText(`Invalid lane "${laneRaw}"; must be one of: ${ALL_AUTOMATION_LANES.join(", ")}.`);
				}
				const hotfixKindRaw = asString((params as any).hotfixKind, "");
				if (laneRaw === "hotfix" && hotfixKindRaw && !isHotfixKind(hotfixKindRaw)) {
					return errText(`Invalid hotfixKind "${hotfixKindRaw}"; must be code-changing|text-evidence-only.`);
				}
				if (laneRaw === "hotfix" && !isHotfixKind(hotfixKindRaw)) {
					return errText("hotfix lane requires hotfixKind (code-changing | text-evidence-only).");
				}
				if (laneRaw === "hotfix" && !asString((params as any).allowedScope)) {
					return errText("hotfix lane requires an explicit allowedScope statement.");
				}
				if (laneRaw === "debug") {
					const rec = asString((params as any).recommendedNextLane, "");
					if (rec && !isDebugNextLane(rec)) {
						return errText(`Invalid recommendedNextLane "${rec}"; must be hotfix|full-sprint|no-code/report-only.`);
					}
				}
				if (laneRaw === "full-sprint") {
					const gate = evaluatePlanningGate(cwd, (params as any).planningRoomId, "implementation");
					if (!gate.allowed) {
						return planningGateErrorResult(gate.details);
					}
				}
				const runId = asString((params as any).runId, "") || generateRunId(asString((params as any).taskId, "") || undefined);
				if (shipStateExists(cwd, runId)) {
					return errText(`AFK run already exists at ${shipStatePathRelative(cwd, runId)}; choose a different runId or use action=read/transition/report.`);
				}
				const initial: CreateInitialShipStateInput = {
					runId,
					taskId: asString((params as any).taskId, "") || undefined,
					itemId: asString((params as any).itemId, "") || undefined,
					lane: laneRaw,
					hotfixKind: laneRaw === "hotfix" ? (hotfixKindRaw as HotfixKind) : undefined,
					retryBudget: asInt((params as any).retryBudget, 3),
					allowedScope: asString((params as any).allowedScope, "") || undefined,
					diagnosis: asString((params as any).diagnosis, "") || undefined,
					rootCauseHypothesis: asString((params as any).rootCauseHypothesis, "") || undefined,
					affectedFiles: asStringArray((params as any).affectedFiles),
					riskAssessment: asString((params as any).riskAssessment, "") || undefined,
					recommendedNextLane: isDebugNextLane((params as any).recommendedNextLane) ? ((params as any).recommendedNextLane as DebugNextLane) : undefined,
					selectedNextLane: isDebugNextLane((params as any).selectedNextLane) ? ((params as any).selectedNextLane as DebugNextLane) : undefined,
					fullSprintGatesConfirmed: laneRaw === "full-sprint",
				};
				// WP4: pin the configured loop budget onto the durable state so
				// the pure engine can stop with budget-exhausted.
				const loopBudget = resolveLoopBudgetConfig(loadWorkflowConfig(cwd).config);
				if (loopBudget.maxCostUsd !== undefined || loopBudget.maxWallClockMs !== undefined) {
					initial.loopBudget = { maxCostUsd: loopBudget.maxCostUsd, maxWallClockMs: loopBudget.maxWallClockMs };
				}
				let state: ShipState;
				try {
					state = createInitialShipState(initial);
				} catch (error) {
					return errText(error instanceof Error ? error.message : String(error));
				}
				state = writeShipState(cwd, state);
				state = writeShipReport(cwd, state, { render: (s) => renderShipReport(s, { workspaceName: path.basename(cwd) }) });
				return okText(
					`AFK run created runId=${state.runId} lane=${state.lane}${state.hotfixKind ? ` hotfixKind=${state.hotfixKind}` : ""} statePath=${shipStatePathRelative(cwd, state.runId)} reportPath=${shipReportPathRelative(cwd, state.runId)}`,
					{
						runId: state.runId,
						lane: state.lane,
						hotfixKind: state.hotfixKind,
						statePath: shipStatePathRelative(cwd, state.runId),
						reportPath: shipReportPathRelative(cwd, state.runId),
						state,
						nextAction: state.nextAction ?? null,
						stopCondition: state.lastStopCondition ?? null,
					},
				);
			}
			const runId = asString((params as any).runId, "");
			if (!runId) return errText("runId is required for read/transition/report.");
			if (!shipStateExists(cwd, runId)) {
				return errText(`AFK run not found: ${shipStatePathRelative(cwd, runId)}. Use action=start to create one.`);
			}
			if (action === "read") {
				const state = withOpenOperatorQuestions(cwd, readShipState(cwd, runId));
				const report = renderShipReport(state, { workspaceName: path.basename(cwd) });
				return okText(`runId=${state.runId} stage=${state.stage} nextAction=${state.nextAction ?? "(unset)"} reportPath=${state.finalReportPath ?? ""}`, {
					runId: state.runId,
					state,
					renderedReport: report,
					reportPath: state.finalReportPath ?? shipReportPathRelative(cwd, state.runId),
				});
			}
			if (action === "report") {
				const current = withOpenOperatorQuestions(cwd, readShipState(cwd, runId));
				const after = writeShipReport(cwd, current, { render: (s) => renderShipReport(s, { workspaceName: path.basename(cwd) }) });
				return okText(`REPORT.md re-rendered at ${after.finalReportPath}`, {
					runId: after.runId,
					reportPath: after.finalReportPath,
					state: after,
				});
			}
			// action === "transition"
			const event = (params as any).event;
			if (!isShipEvent(event)) {
				return errText(
					"action=transition requires a valid event with a recognized `kind`. See extensions/sprint/ship-engine.ts for the ShipEvent union.",
				);
			}
			try {
				// Read state, compute the transition, persist the new state, then re-render the report
				// so the durable REPORT.md stays in sync with the durable state.
				// WP1: the open operator-question snapshot is refreshed from the run
				// dir first so finalization_recorded fail-closes on awaiting-operator.
				const current = withOpenOperatorQuestions(cwd, readShipState(cwd, runId));
				const transition: ShipTransition = transitionShipState(current, event);
				const persisted = writeShipState(cwd, transition.state);
				const withReport = writeShipReport(cwd, persisted, { render: (s) => renderShipReport(s, { workspaceName: path.basename(cwd) }) });
				const replyTransition: ShipTransition = {
					state: withReport,
					toStage: withReport.stage,
					stopCondition: transition.stopCondition,
					blocker: transition.blocker,
					notes: transition.notes,
				};
				return okText(
					renderTransitionReply(replyTransition, withReport.runId, withReport.finalReportPath ?? shipReportPathRelative(cwd, withReport.runId)),
					{
						runId: withReport.runId,
						toStage: replyTransition.toStage,
						stopCondition: replyTransition.stopCondition ?? null,
						blocker: replyTransition.blocker ?? null,
						nextAction: withReport.nextAction ?? null,
						reportPath: withReport.finalReportPath ?? shipReportPathRelative(cwd, withReport.runId),
						state: withReport,
					},
				);
			} catch (error) {
				return errText(error instanceof Error ? error.message : String(error), { runId });
			}
		},
	});
}

// Tiny path helpers exposed for smoke tests; the AFK state path is always
// repo-relative under `.pi/workflow-runs/afk-ship/<runId>/` so the durable
// path is reachable from a state file without any absolute resolution.
export const _internal = {
	buildLanePolicyInput,
	isShipEvent,
	generateRunId,
	shipStatePath,
	shipReportPath,
};
