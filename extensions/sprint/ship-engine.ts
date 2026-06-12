#!/usr/bin/env node
// TASK-011 Phase A — pure AFK ship supervisor stage-transition engine.
import {
	defaultReviewerRequiredFor,
	debugNextLaneAllowsImplementation,
	isAutomationLane,
	isDebugNextLane,
	isReportOnlyDebugNextLane,
	type AutomationLane,
	type DebugNextLane,
	type HotfixKind,
	type LaneRiskCode,
} from "./lane-policy";
import type {
	ShipCheckRecord,
	ShipFinalizationStatus,
	ShipNextAction,
	ShipReviewerOutcome,
	ShipState,
	ShipStopCondition,
} from "./ship-state";

export type ShipStage =
	| "created"
	| "diagnosing"
	| "implementing"
	| "reviewing"
	| "fixing"
	| "finalizing"
	| "delivery_complete"
	| "blocked";

export type {
	ShipFinalizationStatus,
	ShipNextAction,
	ShipStopCondition,
};

export const ALL_SHIP_STAGES: readonly ShipStage[] = [
	"created", "diagnosing", "implementing", "reviewing",
	"fixing", "finalizing", "delivery_complete", "blocked",
];

const STOP_CONDITION_BY_KIND: Record<ShipStopCondition, string> = {
	"scope-expansion-detected": "Scope expansion detected; AFK stop and report.", "retry-budget-exhausted": "Retry budget exhausted; AFK stop and report.",
	"unresolved-reviewer-changes-requested": "Reviewer CHANGES_REQUESTED unresolved; AFK stop and report.", "checks-failed-after-retries": "Checks failed after retries; AFK stop and report.",
	"finalization-blocked": "Finalization gate blocked delivery; AFK stop and report.", "quality-audit-blocked": "Quality audit blocked delivery; AFK stop and report.",
	"debug-implementation-without-selected-lane": "Debug attempted implementation without a selected/promoted next lane.", "unauthorized-remote-action": "Remote action requested but not authorized; AFK stop and report.",
	"delivery-complete": "Delivery complete.", "report-only-stop": "Report-only debug stop: no implementation was authorized.",
	"full-sprint-gates-not-confirmed": "Full-sprint lane lacks durable PRD/architecture/implementation confirmations; AFK stop and report.", "text-evidence-readiness-missing": "Text-evidence-only path is missing concrete text evidence; AFK stop and report (or route to reviewer).",
	"reviewer-required-implementation-evidence-missing": "Reviewer-required lane lacks concrete implementation evidence (changedFiles/evidenceRefs/passed-checks); AFK stop and report.",
};

export type ShipTransitionStage = ShipStage | string;

export interface ShipTransition {
	state: ShipState;
	toStage: ShipTransitionStage;
	stopCondition?: ShipStopCondition;
	blocker?: string;
	notes?: string[];
}

export type SelectableNextLane = Exclude<AutomationLane, "debug">;

export type ShipEvent =
	| { kind: "diagnose"; diagnosis: string; rootCauseHypothesis?: string; recommendedNextLane: DebugNextLane; affectedFiles?: string[]; riskAssessment?: string }
	| { kind: "select_next_lane"; lane: string; hotfixKind?: HotfixKind }
	| { kind: "select_report_only" }
	| { kind: "implement_started"; note?: string }
	| { kind: "coder_completed"; changedFiles: string[]; evidenceRefs: string[]; checks: ShipCheckRecord[]; reviewerRequired?: boolean; evidenceOnly?: boolean }
	| { kind: "reviewer_changes_requested"; at: string; notes?: string; broaderRisk?: boolean }
	| { kind: "reviewer_approved"; at: string; notes?: string }
	| { kind: "evidence_collected"; refs: string[]; checks?: ShipCheckRecord[] }
	| { kind: "focused_fix_completed"; changedFiles?: string[]; evidenceRefs?: string[]; checks?: ShipCheckRecord[] }
	| { kind: "finalization_recorded"; finalizationSummary: string; finalizationResult?: string; qualityAuditSummary: string; qualityAuditArtifact: string }
	| { kind: "remote_action_requested"; action: "push" | "pr" | "deploy" | "destructive" | "credentialed" }
	| { kind: "mark_blocked"; reason: string };

function pushBlocker(state: ShipState, blocker: string): ShipState { return { ...state, blockers: [...state.blockers, blocker] }; }
function appendChecks(state: ShipState, checks: ShipCheckRecord[]): ShipState { return checks.length ? { ...state, checks: [...state.checks, ...checks] } : state; }
function appendUnique(state: ShipState, listKey: "evidenceRefs" | "changedFiles" | "affectedFiles", items: string[]): ShipState {
	if (!items.length) return state;
	const existing = new Set(state[listKey]);
	for (const item of items) { if (typeof item === "string" && item.trim()) existing.add(item); }
	return { ...state, [listKey]: Array.from(existing) };
}
function setStage(state: ShipState, stage: ShipStage): ShipState { return { ...state, stage }; }
function setNextAction(state: ShipState, action: ShipNextAction | undefined): ShipState { return { ...state, nextAction: action }; }
function setLastStopCondition(state: ShipState, condition: ShipStopCondition | undefined): ShipState { return { ...state, lastStopCondition: condition }; }

function transition(state: ShipState, toStage: ShipStage, options: Partial<ShipTransition> = {}): ShipTransition {
	return { state: setStage(state, toStage), toStage, ...options };
}

function stopTransition(state: ShipState, toStage: ShipStage, stopCondition: ShipStopCondition, blocker: string, nextAction: ShipNextAction = "stop"): ShipTransition {
	let next: ShipState = pushBlocker(setStage(state, toStage), blocker);
	next = setLastStopCondition(next, stopCondition);
	next = setNextAction(next, nextAction);
	return { state: next, toStage, stopCondition, blocker, notes: [STOP_CONDITION_BY_KIND[stopCondition]] };
}

function handleDiagnose(state: ShipState, event: Extract<ShipEvent, { kind: "diagnose" }>): ShipTransition {
	if (state.lane !== "debug") {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane", "diagnose event only applies to debug lane.");
	}
	if (!isDebugNextLane(event.recommendedNextLane)) {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane",
			`diagnose event recommendedNextLane "${String(event.recommendedNextLane)}" is invalid; must be exactly "hotfix", "full-sprint", or "no-code/report-only".`);
	}
	const diagnosis = event.diagnosis?.trim() ?? "";
	if (!diagnosis) {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane", "Debug diagnose event must include a non-empty diagnosis.");
	}
	let next: ShipState = {
		...state,
		diagnosis,
		rootCauseHypothesis: event.rootCauseHypothesis?.trim() || state.rootCauseHypothesis,
		recommendedNextLane: event.recommendedNextLane,
		riskAssessment: event.riskAssessment?.trim() || state.riskAssessment,
		stage: "diagnosing",
	};
	next = appendUnique(next, "affectedFiles", event.affectedFiles ?? []);
	next = appendUnique(next, "evidenceRefs", event.affectedFiles ?? []);
	if (state.selectedNextLane) {
		next = setNextAction(next, debugNextLaneAllowsImplementation(state.selectedNextLane) ? "implement" : "report-only");
	} else {
		next = setNextAction(next, "stop");
	}
	return transition(next, "diagnosing", { notes: [`Recommended next lane: ${event.recommendedNextLane}. Awaiting explicit select_next_lane for implementation.`] });
}

function handleSelectNextLane(state: ShipState, event: Extract<ShipEvent, { kind: "select_next_lane" }>): ShipTransition {
	if (state.lane !== "debug") {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane", "select_next_lane event only applies to debug lane.");
	}
	// Reviewer fix #7: debug state must have a durable diagnosis and valid recommendedNextLane before any lane promotion; a fresh debug state must not silently select hotfix/full-sprint without first producing a diagnosis (preserves debug diagnosis-first).
	if (!state.diagnosis || !state.diagnosis.trim()) {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane",
			"Debug lane requires a non-empty diagnosis on the durable state before select_next_lane can promote a hotfix/full-sprint lane; current value is empty or missing.");
	}
	if (!isDebugNextLane(state.recommendedNextLane)) {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane",
			`Debug lane requires a valid recommendedNextLane (hotfix, full-sprint, or no-code/report-only) on the durable state before select_next_lane; current value is "${String(state.recommendedNextLane)}".`);
	}
	if (event.lane !== "hotfix" && event.lane !== "full-sprint") {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane",
			`select_next_lane event lane "${String(event.lane)}" is invalid; must be exactly "hotfix" or "full-sprint".`);
	}
	const lane = event.lane as SelectableNextLane;
	const next: ShipState = {
		...state,
		selectedNextLane: lane,
		hotfixKind: lane === "hotfix" ? (event.hotfixKind ?? "code-changing") : undefined,
		lane,
		stage: "created",
		reviewerRequired: defaultReviewerRequiredFor(lane, lane === "hotfix" ? (event.hotfixKind ?? "code-changing") : undefined),
		nextAction: "implement",
	};
	return transition(next, "created", { notes: [`Debug lane promoted to ${lane} (hotfixKind=${event.hotfixKind ?? "n/a"}).`] });
}

function handleSelectReportOnly(state: ShipState, _event: Extract<ShipEvent, { kind: "select_report_only" }>): ShipTransition {
	if (state.lane !== "debug") {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane", "select_report_only event only applies to debug lane.");
	}
	// Reviewer fix #7: debug state must have a durable diagnosis and valid recommendedNextLane (here: "no-code/report-only") before report-only is selected; symmetric with select_next_lane: a fresh debug state cannot silently exit via report-only without first producing a diagnosis.
	if (!state.diagnosis || !state.diagnosis.trim()) {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane",
			"Debug lane requires a non-empty diagnosis on the durable state before select_report_only can record a report-only outcome; current value is empty or missing.");
	}
	if (!isDebugNextLane(state.recommendedNextLane)) {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane",
			`Debug lane requires a valid recommendedNextLane (hotfix, full-sprint, or no-code/report-only) on the durable state before select_report_only; current value is "${String(state.recommendedNextLane)}".`);
	}
	const next: ShipState = {
		...state,
		selectedNextLane: "no-code/report-only",
		lane: "debug",
		hotfixKind: undefined,
		reviewerRequired: false,
		nextAction: "report-only",
		stage: "diagnosing",
	};
	return stopTransition(next, "blocked", "report-only-stop", "Debug selected report-only outcome; no implementation will be performed.", "report-only");
}

function handleImplementStarted(state: ShipState, _event: Extract<ShipEvent, { kind: "implement_started" }>): ShipTransition {
	if (state.lane === "debug") {
		if (state.selectedNextLane !== undefined && !isDebugNextLane(state.selectedNextLane)) {
			return stopTransition(state, "blocked", "debug-implementation-without-selected-lane",
				`selectedNextLane "${String(state.selectedNextLane)}" on state is invalid; must be exactly "hotfix", "full-sprint", or "no-code/report-only".`);
		}
		if (!state.selectedNextLane) {
			return stopTransition(state, "blocked", "debug-implementation-without-selected-lane", "Debug lane cannot start implementation without a selected/promoted next lane.");
		}
		if (isReportOnlyDebugNextLane(state.selectedNextLane)) {
			return stopTransition(state, "blocked", "report-only-stop", "Debug selected no-code/report-only; implementation is not authorized.", "report-only");
		}
		if (!debugNextLaneAllowsImplementation(state.selectedNextLane)) {
			return stopTransition(state, "blocked", "debug-implementation-without-selected-lane", `Debug next lane "${state.selectedNextLane}" does not allow implementation.`);
		}
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane", "Debug lane still active; select_next_lane must promote the lane before implement_started.");
	}
	if (state.lane === "full-sprint" && state.fullSprintGatesConfirmed !== true) {
		return stopTransition(state, "blocked", "full-sprint-gates-not-confirmed",
			"Full-sprint lane requires fullSprintGatesConfirmed=true (PRD/sprint/architecture/implementation confirmations) on the durable state before implement_started; current value is undefined or false.",
			"stop");
	}
	const next: ShipState = setNextAction({ ...state, attempts: state.attempts + 1 }, "implement");
	if (next.attempts > next.retryBudget) {
		return stopTransition(next, "blocked", "retry-budget-exhausted", `Retry budget exhausted (${next.retryBudget}); cannot start another implementation attempt.`);
	}
	return transition(next, "implementing", { notes: [`Implementation attempt ${next.attempts} started.`] });
}

function deriveReviewerRequired(state: ShipState): boolean { return state.reviewerRequired; }
function deriveEvidenceOnly(state: ShipState): boolean { return state.lane === "hotfix" && state.hotfixKind === "text-evidence-only"; }

// Strip a `#line/section` suffix from a ref so the code-looking guard inspects only the file portion (e.g. "extensions/sprint/prompt.ts#x" → "extensions/sprint/prompt.ts"). Mirrors `stripRefLineSection` in lane-policy.
function stripRefForCodeCheck(ref: string): string {
	return typeof ref === "string" ? ref.replace(/#.*$/, "").trim() : "";
}

function textEvidenceReadinessSatisfied(state: ShipState): boolean {
	if (state.lane !== "hotfix" || state.hotfixKind !== "text-evidence-only") return true;
	const isNonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
	const changedNonEmpty = state.changedFiles.filter(isNonEmpty);
	const refsNonEmpty = state.evidenceRefs.filter(isNonEmpty);
	const passedCount = state.checks.filter((c) => c && c.outcome === "passed").length;
	if (changedNonEmpty.length === 0 || refsNonEmpty.length === 0 || passedCount === 0) return false;
	// Defensive backstop: code/control-flow-looking paths in `changedFiles` OR `evidenceRefs` (after stripping any `#...` line/section suffix) must NEVER be evidence-only reviewer-free, even on a manipulated/durable state. This aligns with lane-policy: `.ts`, `extensions/`, `src/`, `scripts/`, etc. are not text-evidence-only reviewer-free.
	if (changedNonEmpty.some((f) => isCodeLookingPathForText(f))) return false;
	const refPaths = refsNonEmpty.map(stripRefForCodeCheck).filter(isNonEmpty);
	if (refPaths.some((p) => isCodeLookingPathForText(p))) return false;
	return true;
}

function textEvidenceReadinessBlocker(state: ShipState, source: string, mode: "route-to-review" | "fail-closed"): string {
	const isNonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
	const changedNonEmpty = state.changedFiles.filter(isNonEmpty);
	const refsNonEmpty = state.evidenceRefs.filter(isNonEmpty);
	const passedCount = state.checks.filter((c) => c && c.outcome === "passed").length;
	const codeChanged = changedNonEmpty.filter((f) => isCodeLookingPathForText(f));
	const codeRefs = refsNonEmpty.map(stripRefForCodeCheck).filter(isNonEmpty).filter((p) => isCodeLookingPathForText(p));
	const verb = mode === "route-to-review" ? "routing to reviewer instead of skipping review" : "blocking finalization (defensive backstop)";
	const details = codeChanged.length > 0 || codeRefs.length > 0
		? ` (code-looking changedFiles=${codeChanged.join(",") || "(none)"}; code-looking evidenceRefs=${codeRefs.join(",") || "(none)"})`
		: "";
	return `Text-evidence-only ${source}: state lacks concrete text evidence (changedFiles=${changedNonEmpty.length}, evidenceRefs=${refsNonEmpty.length}, passedChecks=${passedCount})${details}; ${verb}.`;
}

// Reviewer fix (TASK-011 Phase B): reviewer-required lanes (full-sprint or code-changing hotfix) must have concrete implementation evidence on durable state before `reviewer_approved` or `finalization_recorded` can advance. A fabricated `reviewerOutcome: approved` MUST NOT reach delivery_complete without coder/focused-fix/evidence evidence. Precondition: non-empty `changedFiles` AND non-empty `evidenceRefs` AND >=1 passed check AND zero failed checks. Returns blocker text or undefined.
function reviewerRequiredEvidenceBlocker(state: ShipState): string | undefined {
	const isNonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
	const changed = state.changedFiles.filter(isNonEmpty);
	const refs = state.evidenceRefs.filter(isNonEmpty);
	const passed = state.checks.filter((c) => c && c.outcome === "passed");
	const failed = state.checks.filter((c) => c && c.outcome === "failed");
	if (changed.length === 0) return `Reviewer-required lane (${state.lane}${state.hotfixKind ? `/${state.hotfixKind}` : ""}) has no changedFiles on durable state.`;
	if (refs.length === 0) return "Reviewer-required lane has no evidenceRefs on durable state.";
	if (passed.length === 0) return "Reviewer-required lane has no passed check record on durable state.";
	if (failed.length > 0) return `Reviewer-required lane has failed checks on durable state: ${failed.map((c) => c.command).join(", ")}.`;
	return undefined;
}

function handleCoderCompleted(state: ShipState, event: Extract<ShipEvent, { kind: "coder_completed" }>): ShipTransition {
	// Reviewer fix #6: state still on `lane:"debug"` must NOT accept implementation-stage events; a real `select_next_lane` promotion changes `state.lane`, so a debug state has not been promoted and any `coder_completed` is treated as a debug-implementation-without-selected-lane attempt.
	if (state.lane === "debug") {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane",
			"Debug lane cannot accept coder_completed: a real select_next_lane must promote the lane to hotfix or full-sprint before implementation events are accepted.");
	}
	// Reviewer fix #8: full-sprint lane must enforce the same durable PRD/sprint/architecture/implementation-confirmation gate on completion events as on `implement_started` and finalization; without this, a fresh full-sprint state could skip the gate via `coder_completed`.
	if (state.lane === "full-sprint" && state.fullSprintGatesConfirmed !== true) {
		return stopTransition(state, "blocked", "full-sprint-gates-not-confirmed",
			"Full-sprint lane requires fullSprintGatesConfirmed=true (PRD/sprint/architecture/implementation confirmations) on the durable state before coder_completed; current value is undefined or false.",
			"stop");
	}
	let next: ShipState = appendUnique(state, "changedFiles", event.changedFiles ?? []);
	next = appendUnique(next, "evidenceRefs", event.evidenceRefs ?? []);
	next = appendChecks(next, event.checks ?? []);
	const failing = (event.checks ?? []).filter((check) => check.outcome === "failed");
	if (failing.length > 0) {
		return stopTransition(next, "blocked", "checks-failed-after-retries", `Coder completion included failed checks: ${failing.map((c) => c.command).join(", ")}`);
	}
	const reviewerRequired = deriveReviewerRequired(state);
	if (reviewerRequired) {
		return transition(setNextAction(next, "review"), "reviewing", { notes: ["Coder completed; durable contract says reviewer is required (lane/hotfixKind). Awaiting reviewer (CHANGES_REQUESTED|APPROVED)."] });
	}
	const evidenceOnly = deriveEvidenceOnly(state);
	if (evidenceOnly) {
		const codeLooking = (event.changedFiles ?? []).filter((f) => isCodeLookingPathForText(f));
		if (codeLooking.length > 0) {
			const forced: ShipState = { ...next, reviewerRequired: true };
			return transition(setNextAction(forced, "review"), "reviewing", {
				notes: [`Coder completed but text-evidence-only state reported code/control-flow files: ${codeLooking.join(", ")}. Routing to reviewer (delivery_complete now requires reviewer_approved).`],
			});
		}
		if (!textEvidenceReadinessSatisfied(next)) {
			const reason = textEvidenceReadinessBlocker(next, "coder_completed", "route-to-review");
			const forced: ShipState = { ...next, reviewerRequired: true, blockers: [...next.blockers, reason] };
			return transition(setNextAction(forced, "review"), "reviewing", { notes: [reason] });
		}
		return transition(setNextAction(next, "finalize"), "finalizing", { notes: ["Coder completed (text-evidence-only); skipping reviewer; proceeding to finalization."] });
	}
	return transition(setNextAction(next, "finalize"), "finalizing", { notes: ["Coder completed; durable contract does not require reviewer; proceeding to finalization."] });
}

function handleReviewerChangesRequested(state: ShipState, event: Extract<ShipEvent, { kind: "reviewer_changes_requested" }>): ShipTransition {
	const outcome: ShipReviewerOutcome = { kind: "changes-requested", at: event.at, notes: event.notes, broaderRisk: event.broaderRisk };
	const next: ShipState = { ...state, reviewerOutcome: outcome };
	if (event.broaderRisk) {
		// Reviewer fix #B2: append/dedupe `reviewer-broader-risk` to durable promotionReasonCodes BEFORE stopTransition so the report and persisted state surface the reviewer-driven promotion reason.
		const codes: LaneRiskCode[] = state.promotionReasonCodes.some((c) => c === "reviewer-broader-risk") ? state.promotionReasonCodes : [...state.promotionReasonCodes, "reviewer-broader-risk"];
		return stopTransition({ ...next, promotionReasonCodes: codes }, "blocked", "scope-expansion-detected", "Reviewer flagged the change as broader-risk; promoting out of hotfix/full-sprint lane.");
	}
	if (next.attempts >= next.retryBudget) {
		return stopTransition(next, "blocked", "retry-budget-exhausted", `Reviewer CHANGES_REQUESTED with no remaining retries (used ${next.attempts}/${next.retryBudget}).`);
	}
	return transition(setNextAction(next, "fix"), "fixing", { notes: ["Reviewer CHANGES_REQUESTED; entering focused-fix loop."] });
}

function handleReviewerApproved(state: ShipState, event: Extract<ShipEvent, { kind: "reviewer_approved" }>): ShipTransition {
	const outcome: ShipReviewerOutcome = { kind: "approved", at: event.at, notes: event.notes };
	const next: ShipState = { ...state, reviewerOutcome: outcome };
	// Reviewer fix (TASK-011 Phase B): reviewer-required lanes must have concrete implementation evidence on durable state before `reviewer_approved` can advance. Without this, a fabricated `reviewerOutcome: approved` (or `reviewer_approved` on a fresh state) could reach delivery_complete without coder/focused-fix/evidence.
	if (deriveReviewerRequired(state)) {
		const reason = reviewerRequiredEvidenceBlocker(state);
		if (reason) return stopTransition({ ...next, blockers: [...next.blockers, reason] }, "blocked", "reviewer-required-implementation-evidence-missing", reason);
	}
	return transition(setNextAction(next, "finalize"), "finalizing", { notes: ["Reviewer approved; proceeding to finalization."] });
}

function handleEvidenceCollected(state: ShipState, event: Extract<ShipEvent, { kind: "evidence_collected" }>): ShipTransition {
	// Reviewer fix #8: an empty `evidence_collected` event (`refs:[]`, no checks) must never silently advance any lane to finalizing. The text-evidence-only path keeps its own readiness backstop below; this guard closes the bypass for code-changing hotfix, full-sprint, and any other lane that previously had no concrete-evidence requirement here.
	const isNonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
	const refsNonEmpty = (event.refs ?? []).filter(isNonEmpty);
	const hasChecks = (event.checks ?? []).length > 0;
	if (refsNonEmpty.length === 0 && !hasChecks) {
		const reason = "evidence_collected provided no concrete refs and no checks; cannot advance to finalizing without evidence.";
		return stopTransition(pushBlocker(state, reason), "blocked", "text-evidence-readiness-missing", reason, "stop");
	}
	let next: ShipState = appendUnique(state, "evidenceRefs", event.refs ?? []);
	next = appendChecks(next, event.checks ?? []);
	if (state.lane === "hotfix" && state.hotfixKind === "text-evidence-only" && !textEvidenceReadinessSatisfied(next)) {
		const reason = textEvidenceReadinessBlocker(next, "evidence_collected", "route-to-review");
		const forced: ShipState = { ...next, reviewerRequired: true, blockers: [...next.blockers, reason] };
		return transition(setNextAction(forced, "review"), "reviewing", { notes: [reason] });
	}
	return transition(setNextAction(next, "finalize"), "finalizing", { notes: ["Evidence collected for evidence-only path; proceeding to finalization."] });
}

function handleFocusedFixCompleted(state: ShipState, event: Extract<ShipEvent, { kind: "focused_fix_completed" }>): ShipTransition {
	// Reviewer fix #6: state still on `lane:"debug"` must NOT accept focused-fix completion events; symmetric with `handleCoderCompleted`, both implementation-stage completion events share the same "promote the lane first" gate so debug cannot silently reach delivery.
	if (state.lane === "debug") {
		return stopTransition(state, "blocked", "debug-implementation-without-selected-lane",
			"Debug lane cannot accept focused_fix_completed: a real select_next_lane must promote the lane to hotfix or full-sprint before implementation events are accepted.");
	}
	// Reviewer fix #8: full-sprint lane must enforce the same durable PRD/sprint/architecture/implementation-confirmation gate on focused-fix completion events as on `implement_started` and finalization.
	if (state.lane === "full-sprint" && state.fullSprintGatesConfirmed !== true) {
		return stopTransition(state, "blocked", "full-sprint-gates-not-confirmed",
			"Full-sprint lane requires fullSprintGatesConfirmed=true (PRD/sprint/architecture/implementation confirmations) on the durable state before focused_fix_completed; current value is undefined or false.",
			"stop");
	}
	let next: ShipState = appendUnique(state, "changedFiles", event.changedFiles ?? []);
	next = appendUnique(next, "evidenceRefs", event.evidenceRefs ?? []);
	next = appendChecks(next, event.checks ?? []);
	const failing = (event.checks ?? []).filter((check) => check.outcome === "failed");
	if (failing.length > 0) {
		return stopTransition(next, "blocked", "checks-failed-after-retries", `Focused fix included failed checks: ${failing.map((c) => c.command).join(", ")}`);
	}
	const consumed: ShipState = setNextAction({ ...next, attempts: next.attempts + 1 }, "fix");
	if (consumed.attempts > consumed.retryBudget) {
		return stopTransition(consumed, "blocked", "retry-budget-exhausted", `Retry budget exhausted after focused fix (used ${consumed.attempts}/${consumed.retryBudget}).`);
	}
	const reviewerRequired = deriveReviewerRequired(state);
	if (reviewerRequired) {
		return transition(setNextAction(consumed, "review"), "reviewing", { notes: [`Focused fix completed (attempt ${consumed.attempts}); re-entering reviewer stage.`] });
	}
	return transition(setNextAction(consumed, "finalize"), "finalizing", { notes: [`Focused fix completed (attempt ${consumed.attempts}); proceeding to finalization.`] });
}

const FAILED_FINALIZATION_RE = /^(?:.*\b)?(fail|failed|blocked|error|denied)(?:\b.*)?$/i;
const PASSING_FINALIZATION_RESULTS: ReadonlySet<string> = new Set(["passed", "pass", "success", "succeeded", "allowed", "complete", "ok"]);
const TEXT_GUARD_CODE_FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|cts|mts|py|go|rs|java|c|cpp|cc|cxx|h|hpp|rb|php|swift|kt|scala|sh|bash|zsh|fish|ps1|psm1|sql|css|scss|sass|less|vue|svelte|astro|graphql|gql)$/i;
const TEXT_GUARD_CODE_DIR_RE = /(^|\/)(src|extensions|lib|libs|app|packages|bin|scripts|test|tests|spec|__tests__|dist|build|out|target|node_modules|vendor|internal|cmd|pkg|module|modules|core|server|client|api|routes|middleware|services|controllers|models|views|components|hooks|utils|helpers)\//i;
function isCodeLookingPathForText(p: string): boolean {
	return typeof p === "string" && p.trim().length > 0 && (TEXT_GUARD_CODE_FILE_EXT_RE.test(p) || TEXT_GUARD_CODE_DIR_RE.test(p));
}

function handleFinalizationRecorded(state: ShipState, event: Extract<ShipEvent, { kind: "finalization_recorded" }>): ShipTransition {
	const blockers: string[] = [];
	if (state.lane === "full-sprint" && state.fullSprintGatesConfirmed !== true) {
		blockers.push("Full-sprint lane requires fullSprintGatesConfirmed=true (PRD/sprint/architecture/implementation confirmations) on the durable state before delivery_complete; current value is undefined or false.");
	}
	if (state.lane === "debug") {
		if (!state.diagnosis || !state.diagnosis.trim()) {
			blockers.push("Debug lane requires a non-empty diagnosis on the durable state before delivery_complete; finalization_recorded is rejected.");
		}
		if (!state.recommendedNextLane || !isDebugNextLane(state.recommendedNextLane)) {
			blockers.push(`Debug lane requires recommendedNextLane to be exactly "hotfix", "full-sprint", or "no-code/report-only" before delivery_complete; current value is "${String(state.recommendedNextLane)}".`);
		}
	}
	if (state.lane === "hotfix" && state.hotfixKind === "text-evidence-only" && !textEvidenceReadinessSatisfied(state)) {
		blockers.push(textEvidenceReadinessBlocker(state, "finalization_recorded", "fail-closed"));
	}
	if (!event.finalizationSummary || !event.finalizationSummary.trim()) {
		blockers.push("Missing finalization summary; finalization gate is required for delivery_complete.");
	}
	const rawResult = typeof event.finalizationResult === "string" ? event.finalizationResult.trim() : "";
	if (!rawResult) {
		blockers.push("Missing finalization result; finalization_recorded requires a non-empty finalizationResult (e.g. 'passed').");
	} else if (FAILED_FINALIZATION_RE.test(rawResult)) {
		blockers.push(`Finalization result "${rawResult}" indicates a failed/blocked finalization; cannot mark delivery_complete.`);
	} else if (!PASSING_FINALIZATION_RESULTS.has(rawResult.toLowerCase())) {
		blockers.push(`Finalization result "${rawResult}" is not in the allow-list (passed, pass, success, succeeded, allowed, complete, ok); cannot mark delivery_complete.`);
	}
	if (!event.qualityAuditSummary || !event.qualityAuditSummary.trim()) {
		blockers.push("Missing quality-audit summary; workflow quality audit is required for delivery_complete.");
	}
	if (!event.qualityAuditArtifact || !event.qualityAuditArtifact.trim()) {
		blockers.push("Missing quality-audit artifact path; workflow quality audit artifact is required for delivery_complete.");
	}
	const reviewerRequired = deriveReviewerRequired(state);
	if (reviewerRequired) {
		const outcome = state.reviewerOutcome;
		if (!outcome) {
			blockers.push("Reviewer-required lane (full-sprint or code-changing hotfix) has no reviewer outcome; cannot mark delivery_complete.");
		} else if (outcome.kind === "changes-requested") {
			blockers.push("Reviewer CHANGES_REQUESTED is unresolved; cannot mark delivery_complete without reviewer_approved.");
		} else if (outcome.kind !== "approved") {
			blockers.push(`Reviewer outcome "${outcome.kind}" does not satisfy delivery_complete for a reviewer-required lane.`);
		}
		// Reviewer fix (TASK-011 Phase B): finalization_recorded must independently enforce the reviewer-required implementation-evidence precondition so a fabricated `reviewerOutcome: approved` (e.g. injected into state) cannot reach delivery_complete without coder/focused-fix/evidence.
		const reason = reviewerRequiredEvidenceBlocker(state);
		if (reason) blockers.push(reason);
	} else if (state.reviewerOutcome?.kind === "changes-requested") {
		blockers.push("Reviewer CHANGES_REQUESTED is unresolved; cannot mark delivery_complete.");
	}
	if (blockers.length > 0) {
		const next: ShipState = {
			...state,
			finalizationSummary: event.finalizationSummary,
			finalizationResult: event.finalizationResult ?? state.finalizationResult,
			qualityAuditSummary: event.qualityAuditSummary,
			qualityAuditArtifact: event.qualityAuditArtifact,
			finalizationStatus: "blocked" as ShipFinalizationStatus,
		};
		return stopTransition(next, "blocked", "finalization-blocked", blockers.join(" "), "stop");
	}
	const next: ShipState = {
		...state,
		finalizationSummary: event.finalizationSummary,
		finalizationResult: event.finalizationResult,
		qualityAuditSummary: event.qualityAuditSummary,
		qualityAuditArtifact: event.qualityAuditArtifact,
		finalizationStatus: "complete" as ShipFinalizationStatus,
		nextAction: "deliver",
	};
	return transition(next, "delivery_complete", { stopCondition: "delivery-complete", notes: ["Finalization + quality-audit linked; delivery complete."] });
}

function handleRemoteActionRequested(state: ShipState, event: Extract<ShipEvent, { kind: "remote_action_requested" }>): ShipTransition {
	if (state.permissions[event.action]) {
		return transition(state, state.stage as ShipStage, { notes: [`Remote action "${event.action}" is authorized; no-op for transition engine.`] });
	}
	return stopTransition(state, "blocked", "unauthorized-remote-action", `Remote action "${event.action}" is not authorized by default.`);
}

function handleMarkBlocked(state: ShipState, event: Extract<ShipEvent, { kind: "mark_blocked" }>): ShipTransition {
	return stopTransition(state, "blocked", "scope-expansion-detected", event.reason);
}

export function transitionShipState(state: ShipState, event: ShipEvent): ShipTransition {
	if (!state) throw new Error("transitionShipState requires a state.");
	if (!event) throw new Error("transitionShipState requires an event.");
	if (!isAutomationLane(state.lane)) {
		const blocker = `Invalid lane "${String(state.lane)}" on state; transition refused.`;
		return stopTransition(pushBlocker(state, blocker), "blocked", "debug-implementation-without-selected-lane", blocker, "stop");
	}
	switch (event.kind) {
		case "diagnose": return handleDiagnose(state, event);
		case "select_next_lane": return handleSelectNextLane(state, event);
		case "select_report_only": return handleSelectReportOnly(state, event);
		case "implement_started": return handleImplementStarted(state, event);
		case "coder_completed": return handleCoderCompleted(state, event);
		case "reviewer_changes_requested": return handleReviewerChangesRequested(state, event);
		case "reviewer_approved": return handleReviewerApproved(state, event);
		case "evidence_collected": return handleEvidenceCollected(state, event);
		case "focused_fix_completed": return handleFocusedFixCompleted(state, event);
		case "finalization_recorded": return handleFinalizationRecorded(state, event);
		case "remote_action_requested": return handleRemoteActionRequested(state, event);
		case "mark_blocked": return handleMarkBlocked(state, event);
	}
}
