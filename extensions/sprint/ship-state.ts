#!/usr/bin/env node
// TASK-011 Phase A — durable AFK ship supervisor state and report path contracts.
// Owns the on-disk substrate under `.pi/workflow-runs/afk-ship/<runId>/`
// for both `state.json` and `REPORT.md`. No LLM/tool calls; only fs helpers
// and pure reducers. The companion modules `ship-engine.ts` and
// `ship-report.ts` consume `ShipState` and never touch fs.

import * as fs from "node:fs";
import * as path from "node:path";

import {
	AUTOMATION_LANE_LIST_TEXT,
	DEBUG_NEXT_LANE_LIST_TEXT,
	debugNextLaneAllowsImplementation,
	defaultReviewerRequiredFor as _defaultReviewerRequiredFor,
	isAutomationLane,
	isDebugNextLane,
	isReportOnlyDebugNextLane,
	type AutomationLane,
	type DebugNextLane,
	type HotfixKind,
	type LaneRiskCode,
} from "./lane-policy";

// Re-export for convenience; the canonical definition lives in lane-policy.
export const defaultReviewerRequiredFor = _defaultReviewerRequiredFor;

export const SHIP_RUNS_DIR_NAME = "afk-ship";
export const SHIP_STATE_FILENAME = "state.json";
export const SHIP_REPORT_FILENAME = "REPORT.md";
export const SHIP_STATE_VERSION = 2;

export const DEFAULT_SHIP_PERMISSIONS: ShipPermissions = {
	push: false,
	pr: false,
	deploy: false,
	destructive: false,
	credentialed: false,
};

export interface ShipPermissions {
	push: boolean;
	pr: boolean;
	deploy: boolean;
	destructive: boolean;
	credentialed: boolean;
}

export type ShipReviewerOutcome =
	| { kind: "not-required" }
	| { kind: "approved"; at: string; notes?: string }
	| { kind: "changes-requested"; at: string; notes?: string; broaderRisk?: boolean };

export interface ShipCheckRecord {
	command: string;
	outcome: "passed" | "failed" | "skipped";
	summary?: string;
	at?: string;
	exitCode?: number;
}

export type ShipFinalizationStatus = "pending" | "blocked" | "passed" | "complete";

export type ShipNextAction =
	| "implement"
	| "review"
	| "fix"
	| "finalize"
	| "deliver"
	| "report-only"
	| "stop";

export type ShipStopCondition =
	| "scope-expansion-detected"
	| "retry-budget-exhausted"
	| "unresolved-reviewer-changes-requested"
	| "checks-failed-after-retries"
	| "finalization-blocked"
	| "quality-audit-blocked"
	| "debug-implementation-without-selected-lane"
	| "unauthorized-remote-action"
	| "delivery-complete"
	| "report-only-stop"
	| "full-sprint-gates-not-confirmed"
	| "text-evidence-readiness-missing"
	| "reviewer-required-implementation-evidence-missing"
	| "awaiting-operator";

/** WP1: open blocking operator question snapshot carried on durable state.
 *  `sprint_ship` refreshes it from the run dir's questions.jsonl before every
 *  read/transition/report so the pure engine and the report renderer see the
 *  current queue without touching fs. */
export interface ShipOpenOperatorQuestion {
	id: string;
	question: string;
	from: string;
}

export interface ShipState {
	version: number;
	runId: string;
	taskId?: string;
	itemId?: string;
	lane: AutomationLane;
	hotfixKind?: HotfixKind;
	stage: string;
	attempts: number;
	retryBudget: number;
	blockers: string[];
	evidenceRefs: string[];
	changedFiles: string[];
	checks: ShipCheckRecord[];
	reviewerOutcome?: ShipReviewerOutcome;
	qualityAuditSummary?: string;
	qualityAuditArtifact?: string;
	finalizationSummary?: string;
	finalizationResult?: string;
	finalizationStatus: ShipFinalizationStatus;
	finalReportPath?: string;
	permissions: ShipPermissions;
	// durable contracts required by AFK spec
	allowedScope?: string;
	reviewerRequired: boolean;
	promotionReasonCodes: LaneRiskCode[];
	lastStopCondition?: ShipStopCondition;
	nextAction?: ShipNextAction;
	/** WP1: unanswered blocking operator questions for this run (refreshed
	 *  from questions.jsonl by sprint_ship; absent = none known). */
	openOperatorQuestions?: ShipOpenOperatorQuestion[];
	// debug-only diagnostics
	diagnosis?: string;
	rootCauseHypothesis?: string;
	affectedFiles: string[];
	riskAssessment?: string;
	recommendedNextLane?: DebugNextLane;
	selectedNextLane?: DebugNextLane;
	// Phase A full-sprint durable gate. Represents that Brain/Phase B has already
	// satisfied PRD/sprint/architecture/implementation confirmations for a
	// full-sprint lane. Default false (absent on disk unless explicitly set).
	fullSprintGatesConfirmed?: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface CreateInitialShipStateInput {
	runId: string;
	taskId?: string;
	itemId?: string;
	lane: AutomationLane;
	hotfixKind?: HotfixKind;
	retryBudget?: number;
	permissions?: Partial<ShipPermissions>;
	allowedScope?: string;
	diagnosis?: string;
	rootCauseHypothesis?: string;
	affectedFiles?: string[];
	riskAssessment?: string;
	recommendedNextLane?: DebugNextLane;
	selectedNextLane?: DebugNextLane;
	// When true, indicates Brain/Phase B has already satisfied PRD/sprint/architecture/implementation confirmations for a full-sprint lane. Defaults to false.
	fullSprintGatesConfirmed?: boolean;
}

export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeRunIdOrThrow(runId: string): string {
	if (typeof runId !== "string") throw new Error("ship runId must be a string.");
	const trimmed = runId.trim();
	if (!trimmed) throw new Error("ship runId must not be empty.");
	if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
		throw new Error(`ship runId contains path-traversal characters: ${runId}`);
	}
	if (!SAFE_RUN_ID.test(trimmed)) {
		throw new Error(`ship runId contains invalid characters: ${runId}`);
	}
	return trimmed;
}

function nowIso(): string {
	return new Date().toISOString();
}

function workflowRunsRoot(cwd: string): string {
	return path.join(cwd, ".pi", "workflow-runs");
}

export function shipRunDir(cwd: string, runId: string): string {
	const safe = safeRunIdOrThrow(runId);
	return path.join(workflowRunsRoot(cwd), SHIP_RUNS_DIR_NAME, safe);
}

export function shipStatePath(cwd: string, runId: string): string {
	return path.join(shipRunDir(cwd, runId), SHIP_STATE_FILENAME);
}

export function shipReportPath(cwd: string, runId: string): string {
	return path.join(shipRunDir(cwd, runId), SHIP_REPORT_FILENAME);
}

export function shipStatePathRelative(cwd: string, runId: string): string {
	return path.relative(cwd, shipStatePath(cwd, runId)).split(path.sep).join("/");
}

export function shipReportPathRelative(cwd: string, runId: string): string {
	return path.relative(cwd, shipReportPath(cwd, runId)).split(path.sep).join("/");
}

export function createInitialShipState(input: CreateInitialShipStateInput): ShipState {
	const runId = safeRunIdOrThrow(input.runId);
	// Fail closed: an unknown lane string or debug next-lane enum value must not be
	// silently accepted into the durable state. Throwing is preferred over blocking
	// here because the supervisor is the only caller and a typo would otherwise
	// propagate as an "invalid" durable state that later transitions cannot trust.
	if (!isAutomationLane(input.lane)) {
		throw new Error(
			`createInitialShipState: invalid lane "${String(input.lane)}"; must be exactly ${AUTOMATION_LANE_LIST_TEXT}.`,
		);
	}
	if (input.recommendedNextLane !== undefined && !isDebugNextLane(input.recommendedNextLane)) {
		throw new Error(
			`createInitialShipState: invalid recommendedNextLane "${String(input.recommendedNextLane)}"; must be exactly ${DEBUG_NEXT_LANE_LIST_TEXT}.`,
		);
	}
	if (input.selectedNextLane !== undefined && !isDebugNextLane(input.selectedNextLane)) {
		throw new Error(
			`createInitialShipState: invalid selectedNextLane "${String(input.selectedNextLane)}"; must be exactly ${DEBUG_NEXT_LANE_LIST_TEXT}.`,
		);
	}
	const permissions: ShipPermissions = { ...DEFAULT_SHIP_PERMISSIONS, ...(input.permissions ?? {}) };
	const retryBudget = Number.isFinite(Number(input.retryBudget)) ? Math.max(0, Math.floor(Number(input.retryBudget))) : 3;
	const lane = input.lane;
	const now = nowIso();
	const state: ShipState = {
		version: SHIP_STATE_VERSION,
		runId,
		taskId: input.taskId,
		itemId: input.itemId,
		lane,
		hotfixKind: input.hotfixKind,
		stage: lane === "debug" ? "diagnosing" : "created",
		attempts: 0,
		retryBudget,
		blockers: [],
		evidenceRefs: [],
		changedFiles: [],
		checks: [],
		permissions,
		allowedScope: input.allowedScope,
		reviewerRequired: defaultReviewerRequiredFor(lane, input.hotfixKind),
		promotionReasonCodes: [],
		finalizationStatus: "pending",
		diagnosis: input.diagnosis,
		rootCauseHypothesis: input.rootCauseHypothesis,
		affectedFiles: Array.isArray(input.affectedFiles) ? [...input.affectedFiles] : [],
		riskAssessment: input.riskAssessment,
		recommendedNextLane: input.recommendedNextLane,
		// INTENTIONALLY do not auto-copy `recommendedNextLane` into `selectedNextLane`.
		// `selectedNextLane` is only set via an explicit `select_next_lane` event
		// (or explicit `selectedNextLane` input to createInitialShipState).
		selectedNextLane: input.selectedNextLane,
		// Full-sprint confirmation gate. Always written as a concrete boolean so
		// the engine's `=== true` check is the only authorization signal and
		// undefined-on-disk states cannot be silently treated as authorized.
		fullSprintGatesConfirmed: input.fullSprintGatesConfirmed === true,
		createdAt: now,
		updatedAt: now,
	};
	// Guard: an explicit `no-code/report-only` selection is report-only and must
	// never be treated as an implementation lane. We keep `state.lane === "debug"`
	// in that case so the supervisor never advances into implementing stages.
	if (isReportOnlyDebugNextLane(state.selectedNextLane)) {
		state.nextAction = "report-only";
	} else if (state.selectedNextLane && debugNextLaneAllowsImplementation(state.selectedNextLane)) {
		state.nextAction = "implement";
	}
	return state;
}

function ensureRunDir(cwd: string, runId: string): string {
	const dir = shipRunDir(cwd, runId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function writeShipState(cwd: string, state: ShipState): ShipState {
	if (!state || state.runId !== safeRunIdOrThrow(state.runId)) {
		throw new Error("writeShipState received state with mismatched or invalid runId.");
	}
	const dir = ensureRunDir(cwd, state.runId);
	const target = path.join(dir, SHIP_STATE_FILENAME);
	// Always pin `finalReportPath` to the canonical repo-relative path
	// (`.pi/workflow-runs/afk-ship/<runId>/REPORT.md`) before persisting. This
	// overwrites any injected absolute or arbitrary path so the durable state
	// never points at a report outside the canonical location.
	const canonicalReport = path.relative(cwd, shipReportPath(cwd, state.runId)).split(path.sep).join("/");
	const next: ShipState = { ...state, finalReportPath: canonicalReport, updatedAt: nowIso() };
	const json = JSON.stringify(next, null, 2);
	fs.writeFileSync(target, `${json}\n`, "utf8");
	return next;
}

export function readShipState(cwd: string, runId: string): ShipState {
	const target = shipStatePath(cwd, runId);
	if (!fs.existsSync(target)) {
		throw new Error(`AFK ship state not found: ${target}`);
	}
	const raw = fs.readFileSync(target, "utf8");
	const parsed = JSON.parse(raw) as ShipState;
	if (!parsed || typeof parsed !== "object" || parsed.runId !== runId) {
		throw new Error(`AFK ship state at ${target} has mismatched runId.`);
	}
	return parsed;
}

export function shipStateExists(cwd: string, runId: string): boolean {
	return fs.existsSync(shipStatePath(cwd, runId));
}

export function updateShipState(cwd: string, runId: string, updater: (state: ShipState) => ShipState): ShipState {
	const current = readShipState(cwd, runId);
	const next = updater(current);
	if (!next || next.runId !== runId) {
		throw new Error("updateShipState updater must preserve runId.");
	}
	return writeShipState(cwd, next);
}

// Helper to write the rendered REPORT.md to disk and pin the repo-relative path
// on the durable state. Kept thin so `renderShipReport` stays pure. There is
// NO `reportPath` override on purpose: the report must always live at the
// canonical `<cwd>/.pi/workflow-runs/afk-ship/<runId>/REPORT.md` so the path
// is stable across sessions and is always reachable from the durable state.
export interface WriteShipReportInput {
	render: (state: ShipState) => string;
}

export function writeShipReport(cwd: string, state: ShipState, input: WriteShipReportInput): ShipState {
	if (!state || state.runId !== safeRunIdOrThrow(state.runId)) {
		throw new Error("writeShipReport received state with mismatched or invalid runId.");
	}
	const dir = ensureRunDir(cwd, state.runId);
	const canonical = path.join(dir, SHIP_REPORT_FILENAME);
	const repoRel = path.relative(cwd, canonical).split(path.sep).join("/");
	const body = input.render(state);
	fs.writeFileSync(canonical, body.endsWith("\n") ? body : `${body}\n`, "utf8");
	const next: ShipState = { ...state, finalReportPath: repoRel, updatedAt: nowIso() };
	// Re-persist state so the pinned path survives restarts.
	return writeShipState(cwd, next);
}
