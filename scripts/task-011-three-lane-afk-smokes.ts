#!/usr/bin/env node
// TASK-011 Phase A + Phase B smokes: lane-policy, ship-state, ship-engine, ship-report, default-deny remote actions, and the ship-tools wiring.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ALL_AUTOMATION_LANES,
	DEFAULT_LANE_THRESHOLDS,
	buildLaneSummary,
	debugNextLaneAllowsImplementation,
	evaluateLanePolicy,
	isReportOnlyDebugNextLane,
	requiresPromotion,
	requiresReviewer,
	type DebugNextLane,
	type HotfixKind,
	type LaneDecision,
	type LanePolicyInput,
} from "../extensions/sprint/lane-policy";
import {
	DEFAULT_SHIP_PERMISSIONS,
	createInitialShipState,
	defaultReviewerRequiredFor,
	readShipState,
	shipReportPath,
	shipReportPathRelative,
	shipStatePath,
	shipStatePathRelative,
	updateShipState,
	writeShipReport,
	writeShipState,
	type ShipState,
} from "../extensions/sprint/ship-state";
import { ALL_SHIP_STAGES, transitionShipState, type ShipTransition } from "../extensions/sprint/ship-engine";
import { renderShipReport } from "../extensions/sprint/ship-report";
import { _internal as shipToolsInternal, registerSprintShipTools } from "../extensions/sprint/ship-tools";
let failures = 0;
function check(cond: boolean, msg: string): void {
	if (cond) { console.log(`PASS: ${msg}`); return; }
	failures += 1;
	console.error(`FAIL: ${msg}`);
}
function withTemp<T>(name: string, fn: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `task-011-${name}-`));
	try { return fn(cwd); }
	finally { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ } }
}
const rid = (label: string): string => `task011-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const hasCode = (d: LaneDecision, code: string): boolean => d.riskCodes.includes(code as never);
function hasStop(t: ShipTransition, code: string): boolean { return t.stopCondition === code; }
const at = (): string => new Date().toISOString();
const pass = (cmd: string): ShipState["checks"][number] => ({ command: cmd, outcome: "passed", summary: "ok", exitCode: 0 });
const setupHotfixState = (cwd: string, runId: string, retryBudget = 2): ShipState => transitionShipState(transitionShipState(writeShipState(cwd, createInitialShipState({ runId, taskId: "TASK-011", lane: "hotfix", hotfixKind: "code-changing", retryBudget, allowedScope: "tighten a single guard" })), { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] }).state;
function main(): void {
	{
		check(ALL_AUTOMATION_LANES.length === 3 && ALL_AUTOMATION_LANES[0] === "full-sprint" && ALL_AUTOMATION_LANES[1] === "hotfix" && ALL_AUTOMATION_LANES[2] === "debug", "1a/b) ALL_AUTOMATION_LANES exposes exactly [full-sprint, hotfix, debug] in order");
		const dnl: DebugNextLane[] = ["hotfix", "full-sprint", "no-code/report-only"];
		check(dnl.length === 3 && dnl.includes("no-code/report-only"), "1c) DebugNextLane vocabulary includes hotfix/full-sprint/no-code/report-only");
		check(!dnl.includes("no-code-report" as never), "1d) old vocabulary 'no-code-report' is not present");
	}
	{
		const miss = evaluateLanePolicy({ lane: "full-sprint" });
		check(miss.status === "block" && miss.reviewerRequired, "2a) full-sprint without confirmations blocks and requires reviewer");
		check(miss.requiresPlanningGate && miss.requiresArchitectureGate && miss.requiresImplementationConfirmation, "2b) full-sprint requires all three confirmations");
		check(hasCode(miss, "full-sprint-confirmation-missing") && hasCode(miss, "full-sprint-architecture-missing") && hasCode(miss, "full-sprint-implementation-confirmation-missing"), "2c) full-sprint missing-confirmation blockers all flagged");
		const ready = evaluateLanePolicy({ lane: "full-sprint", confirmations: { prdReady: true, sprintAuthorized: true, architectureApproved: true, implementationConfirmed: true } });
		check(ready.status === "review-required" && ready.blockers.length === 0, "2d) full-sprint with all confirmations routes to review-required");
	}
	check(defaultReviewerRequiredFor("full-sprint") === true, "2e) defaultReviewerRequiredFor(full-sprint) === true");
	check(defaultReviewerRequiredFor("hotfix", "text-evidence-only") === false, "2f) defaultReviewerRequiredFor(hotfix,text-evidence-only) === false");
	check(defaultReviewerRequiredFor("hotfix", "code-changing") === true, "2g) defaultReviewerRequiredFor(hotfix,code-changing) === true");
	check(defaultReviewerRequiredFor("debug") === false, "2h) defaultReviewerRequiredFor(debug) === false");
	{
		const tiny = evaluateLanePolicy({ lane: "hotfix", hotfixKind: "code-changing", scopeStatement: "Fix typo in a single error message string", changedFiles: ["extensions/x.ts"], changedLOC: 2, behaviorPaths: 1 });
		check(tiny.status === "review-required" && tiny.reviewerRequired && !tiny.evidenceOnly, "3a) code-changing hotfix is review-required, never evidence-only");
		const dflt = evaluateLanePolicy({ lane: "hotfix", scopeStatement: "Tighten validation", changedFiles: ["src/a.ts"] });
		check(dflt.status === "review-required" && dflt.reviewerRequired, "3b) hotfix without explicit kind defaults to code-changing reviewer-required");
	}
	check(requiresReviewer(evaluateLanePolicy({ lane: "hotfix", hotfixKind: "code-changing", scopeStatement: "x", changedFiles: ["a.ts"] })), "3c) requiresReviewer() true for code-changing hotfix");
	check(!requiresReviewer(evaluateLanePolicy({ lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "x", textOnlyClass: "docs", textOnlyConcreteRefs: ["README.md#x"], textOnlyValidationEvidence: ["rg"] })), "3d) requiresReviewer() false for evidence-only hotfix");
	const textCases: Array<{ name: string; input: LanePolicyInput; expectEvidenceOnly: boolean; expectedCode?: string }> = [
		{ name: "docs-with-refs+evidence", input: { lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "Update README section", textOnlyClass: "docs", textOnlyConcreteRefs: ["README.md#lanes"], textOnlyValidationEvidence: ["npx tsx --conditions import scripts/task-011-three-lane-afk-smokes.ts"] }, expectEvidenceOnly: true },
		{ name: "prompt-template-with-md-artifact", input: { lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "Clarify prompt template phrasing in a markdown prompt pack", textOnlyClass: "prompt-template", textOnlyConcreteRefs: ["examples/prompt-packs/brain-orchestrator-core.md#BrainOrchestrator"], textOnlyValidationEvidence: ["rg -n 'Brain' examples/prompt-packs/brain-orchestrator-core.md"] }, expectEvidenceOnly: true },
		{ name: "prompt-template-with-ts-source-ref", input: { lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "Edit prompt string in a TS source file (NOT text-only)", textOnlyClass: "prompt-template", textOnlyConcreteRefs: ["extensions/sprint/prompt.ts#buildTaskSessionKickoff"], textOnlyValidationEvidence: ["node --experimental-strip-types --check extensions/sprint/prompt.ts"] }, expectEvidenceOnly: false, expectedCode: "text-classification-uncertain" },
		{ name: "typo-with-refs+evidence", input: { lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "Fix typo in README", textOnlyClass: "typo", textOnlyConcreteRefs: ["README.md#L42"], textOnlyValidationEvidence: ["rg -n 'typo' README.md"] }, expectEvidenceOnly: true },
		{ name: "missing-refs", input: { lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "Update README", textOnlyClass: "docs", textOnlyValidationEvidence: ["rg README.md"] }, expectEvidenceOnly: false, expectedCode: "missing-text-refs" },
		{ name: "missing-validation-evidence", input: { lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "Update README", textOnlyClass: "docs", textOnlyConcreteRefs: ["README.md#lanes"] }, expectEvidenceOnly: false, expectedCode: "missing-validation-evidence" },
		{ name: "uncertain-classification", input: { lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "Adjust wording", textOnlyClass: "uncertain", textOnlyConcreteRefs: ["README.md#lanes"], textOnlyValidationEvidence: ["rg"] }, expectEvidenceOnly: false, expectedCode: "text-classification-uncertain" },
		{ name: "other-classification", input: { lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "Tweak code comment", textOnlyClass: "other" }, expectEvidenceOnly: false },
		{ name: "docs-but-refs-are-code", input: { lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "Refactor doc snippet but ref points to code", textOnlyClass: "docs", textOnlyConcreteRefs: ["src/app.ts#L1"], textOnlyValidationEvidence: ["rg"] }, expectEvidenceOnly: false, expectedCode: "text-classification-uncertain" },
		{ name: "typo-but-refs-are-code", input: { lane: "hotfix", hotfixKind: "text-evidence-only", scopeStatement: "Fix typo in log string", textOnlyClass: "typo", textOnlyConcreteRefs: ["src/index.ts#L42"], textOnlyValidationEvidence: ["rg"] }, expectEvidenceOnly: false, expectedCode: "text-classification-uncertain" },
	];
	for (const tc of textCases) { const d = evaluateLanePolicy(tc.input); const ok = tc.expectEvidenceOnly ? (d.status === "evidence-only" && d.evidenceOnly) : (d.status === "block" || d.reviewerRequired); check(ok, `4/${tc.name} ${tc.expectEvidenceOnly ? "is evidence-only" : "is not reviewer-free"}`); if (tc.expectedCode) check(hasCode(d, tc.expectedCode), `4/${tc.name} flags ${tc.expectedCode}`); }
	const promotionTriggers: Array<{ key: string; input: LanePolicyInput; code: string }> = [
		{ key: "scope-expansion", input: { lane: "hotfix", scopeStatement: "", changedFiles: ["a.ts"] }, code: "scope-expansion" },
		{ key: "file-threshold", input: { lane: "hotfix", scopeStatement: "x", changedFiles: ["a.ts", "b.ts", "c.ts"] }, code: "file-threshold" },
		{ key: "loc-threshold", input: { lane: "hotfix", scopeStatement: "x", changedFiles: ["a.ts"], changedLOC: 51 }, code: "loc-threshold" },
		{ key: "multiple-behavior-paths", input: { lane: "hotfix", scopeStatement: "x", changedFiles: ["a.ts"], changedLOC: 5, behaviorPaths: 2 }, code: "multiple-behavior-paths" },
		{ key: "architecture-state-schema-refactor", input: { lane: "hotfix", scopeStatement: "x", changedFiles: ["a.ts"], changedLOC: 5, behaviorPaths: 1, architectureStateSchemaOrRefactor: true }, code: "architecture-state-schema-refactor" },
		{ key: "unclear-root-cause", input: { lane: "hotfix", scopeStatement: "x", changedFiles: ["a.ts"], changedLOC: 5, behaviorPaths: 1, rootCauseClear: false }, code: "unclear-root-cause" },
		{ key: "repeated-same-area", input: { lane: "hotfix", scopeStatement: "x", changedFiles: ["a.ts"], changedLOC: 5, behaviorPaths: 1, repeatedSameAreaFixCount: 2 }, code: "repeated-same-area" },
		{ key: "reviewer-broader-risk", input: { lane: "hotfix", scopeStatement: "x", changedFiles: ["a.ts"], changedLOC: 5, behaviorPaths: 1, reviewerBroaderRisk: true }, code: "reviewer-broader-risk" },
	];
	for (const t of promotionTriggers) { const d = evaluateLanePolicy(t.input); check(d.status === "promote" || d.status === "block", `5/${t.key} promote/block (got ${d.status})`); check(hasCode(d, t.code), `5/${t.key} flags ${t.code}`); check(requiresPromotion(d), `5/${t.key} requiresPromotion() true`); }
	check(!requiresPromotion(evaluateLanePolicy({ lane: "hotfix", hotfixKind: "code-changing", scopeStatement: "x", changedFiles: ["a.ts"] })), "5/no-trigger) requiresPromotion() false for tiny code-changing hotfix");
	{
		const und = evaluateLanePolicy({ lane: "debug" });
		check(und.status === "block", "6a) debug without diagnosis blocks");
		check(hasCode(und, "debug-diagnosis-missing") && hasCode(und, "debug-next-lane-missing"), "6a-codes) missing diagnosis + next lane codes flagged");
		const dHot = evaluateLanePolicy({ lane: "debug", diagnosis: "Single-line guard misfires for empty input", rootCauseHypothesis: "missing null check on config.inputs[0]", recommendedNextLane: "hotfix" });
		check(dHot.status === "allow" && dHot.recommendedNextLane === "hotfix", "6b) debug with diagnosis+recommendedNextLane=hotfix is allowed and surfaces the recommendation");
		const dFull = evaluateLanePolicy({ lane: "debug", diagnosis: "Multiple state machine transitions are racy", rootCauseHypothesis: "lack of transactional fence in apply()", recommendedNextLane: "full-sprint" });
		check(dFull.recommendedNextLane === "full-sprint", "6c) debug can recommend full-sprint");
		const dNo = evaluateLanePolicy({ lane: "debug", diagnosis: "Behavior is by design; need a docs clarification", rootCauseHypothesis: "config flag was intentionally disabled", recommendedNextLane: "no-code/report-only" });
		check(dNo.recommendedNextLane === "no-code/report-only", "6d) debug can recommend no-code/report-only (new vocabulary)");
		const dImpl = evaluateLanePolicy({ lane: "debug", diagnosis: "Need to fix a small race", rootCauseHypothesis: "single line bug in dispatcher", recommendedNextLane: "hotfix", debugImplementationAttempt: true });
		check(hasCode(dImpl, "debug-implementation-without-selected-lane"), "6e) debug implementation without selected lane is blocked");
		const dImplSel = evaluateLanePolicy({ lane: "debug", diagnosis: "Need to fix a small race", rootCauseHypothesis: "single line bug in dispatcher", recommendedNextLane: "hotfix", debugImplementationAttempt: true, selectedNextLane: "hotfix" });
		check(!hasCode(dImplSel, "debug-implementation-without-selected-lane"), "6f) debug implementation with selected lane is not blocked by selected-lane gate");
	}
	check(debugNextLaneAllowsImplementation("hotfix") && debugNextLaneAllowsImplementation("full-sprint") && !debugNextLaneAllowsImplementation("no-code/report-only"), "6b-helpers) debugNextLaneAllowsImplementation distinguishes hotfix/full-sprint from no-code/report-only");
	check(isReportOnlyDebugNextLane("no-code/report-only") && !isReportOnlyDebugNextLane("hotfix"), "6b-isReport) isReportOnlyDebugNextLane identifies report-only correctly");
	{
		const invalidLane = evaluateLanePolicy({ lane: "quick" as never });
		check(invalidLane.status === "block", "6c-a) invalid lane (e.g. 'quick') blocks (fail closed)");
		check(hasCode(invalidLane, "invalid-lane"), "6c-b) invalid lane flags invalid-lane risk code");
		check(invalidLane.blockers.some((b) => b.includes('Invalid lane "quick"')), "6c-c) invalid lane blocker text names the bad value");
		const emptyLane = evaluateLanePolicy({ lane: "" as never });
		check(emptyLane.status === "block" && hasCode(emptyLane, "invalid-lane"), "6c-d) empty lane blocks and flags invalid-lane");
		const wrongDebugRec = evaluateLanePolicy({ lane: "debug", diagnosis: "x", recommendedNextLane: "no-code-report" as never });
		check(wrongDebugRec.status === "block" && hasCode(wrongDebugRec, "invalid-debug-recommendation"), "6c-e) debug with recommendedNextLane='no-code-report' blocks with invalid-debug-recommendation");
		const wrongDebugRec2 = evaluateLanePolicy({ lane: "debug", diagnosis: "x", recommendedNextLane: "patch" as never });
		check(wrongDebugRec2.status === "block" && hasCode(wrongDebugRec2, "invalid-debug-recommendation"), "6c-f) debug with recommendedNextLane='patch' blocks with invalid-debug-recommendation");
		const wrongDebugSel = evaluateLanePolicy({ lane: "debug", diagnosis: "x", recommendedNextLane: "hotfix", selectedNextLane: "patch" as never, debugImplementationAttempt: true });
		check(wrongDebugSel.status === "block" && hasCode(wrongDebugSel, "invalid-debug-recommendation"), "6c-g) debug with selectedNextLane='patch' blocks with invalid-debug-recommendation");
		const validDebug = evaluateLanePolicy({ lane: "debug", diagnosis: "x", recommendedNextLane: "no-code/report-only" });
		check(validDebug.blockers.every((b) => !b.includes("no-code-report")), "6c-h) debug with valid no-code/report-only recommendation has no stale 'no-code-report' in blockers");
		const missingNext = evaluateLanePolicy({ lane: "debug", diagnosis: "x" });
		check(missingNext.blockers.every((b) => !b.includes("no-code-report")), "6c-i) debug missing-next-lane blocker does not use stale 'no-code-report'");
	}
	{
		const blocked = evaluateLanePolicy({ lane: "debug", diagnosis: "Race in apply", rootCauseHypothesis: "missing null guard", recommendedNextLane: "no-code/report-only", debugImplementationAttempt: true, selectedNextLane: "no-code/report-only" });
		check(blocked.status === "block", "6d-a) debug with selectedNextLane='no-code/report-only' + implementation attempt blocks");
		check(hasCode(blocked, "debug-implementation-with-report-only-selection"), "6d-b) debug implementation with report-only selection flags new report-only-selection code");
	}
	withTemp("state-roundtrip", (cwd) => {
		const id = rid("roundtrip");
		const initial = createInitialShipState({ runId: id, taskId: "TASK-011", lane: "hotfix", hotfixKind: "code-changing", retryBudget: 2, allowedScope: "tighten one guard" });
		const written = writeShipState(cwd, initial);
		const sRel = shipStatePathRelative(cwd, id);
		const rRel = shipReportPathRelative(cwd, id);
		check(sRel === `.pi/workflow-runs/afk-ship/${id}/state.json`, "7a) state path is repo-relative under .pi/workflow-runs/afk-ship");
		check(rRel === `.pi/workflow-runs/afk-ship/${id}/REPORT.md`, "7b) report path is repo-relative under .pi/workflow-runs/afk-ship");
		check(fs.existsSync(shipStatePath(cwd, id)), "7c) state file is written under .pi/workflow-runs/afk-ship/<runId>/state.json");
		check(written.finalReportPath === rRel, "7d) persisted state finalReportPath matches repo-relative REPORT.md path");
		check(written.reviewerRequired === true, "7e) durable state reviewerRequired=true for code-changing hotfix");
		check(written.finalizationStatus === "pending", "7f) durable state finalizationStatus=pending initially");
		check(written.promotionReasonCodes.length === 0, "7g) durable state promotionReasonCodes=[] initially");
		check(written.nextAction === undefined, "7h) durable state nextAction unset initially");
		check(written.allowedScope === "tighten one guard", "7i) durable state allowedScope is preserved");
		const back = readShipState(cwd, id);
		check(back.runId === id && back.lane === "hotfix" && back.hotfixKind === "code-changing", "7j) round-trip preserves runId/lane/hotfixKind");
		check(back.retryBudget === 2 && back.attempts === 0 && back.version === 2, "7k) round-trip preserves retryBudget/attempts/version");
		const updated = updateShipState(cwd, id, (s) => ({ ...s, attempts: 1, changedFiles: [...s.changedFiles, "extensions/sprint/lane-policy.ts"] }));
		check(updated.attempts === 1 && updated.changedFiles.includes("extensions/sprint/lane-policy.ts"), "7l) updateShipState applies updater function");
		check(readShipState(cwd, id).attempts === 1, "7m) updateShipState persists changes to disk");
	});
	withTemp("state-textonly-fields", (cwd) => {
		const init = createInitialShipState({ runId: rid("textonly"), lane: "hotfix", hotfixKind: "text-evidence-only" });
		check(init.reviewerRequired === false, "7n) text-evidence-only hotfix durable state reviewerRequired=false");
		check(init.finalizationStatus === "pending", "7o) text-evidence-only hotfix durable state finalizationStatus=pending");
		writeShipState(cwd, init);
	});
	withTemp("state-traversal", (cwd) => {
		const bad: Array<[string, string]> = [["../escape", "traversal .."], ["a/b", "slash"], ["a\\b", "backslash"], ["\0abc", "null byte"], ["", "empty"]];
		for (const [id, label] of bad) {
			try { createInitialShipState({ runId: id, lane: "debug" }); check(false, `7p) ship state rejects invalid runId (${label})`); } catch { check(true, `7p) ship state rejects invalid runId (${label})`); }
		}
	});
	{
		const cases: Array<Parameters<typeof createInitialShipState>[0]> = [
			{ runId: rid("t1"), lane: "quick" as never }, { runId: rid("t2"), lane: "" as never }, { runId: rid("t3"), lane: null as never },
			{ runId: rid("t4"), lane: "debug", recommendedNextLane: "no-code-report" as never },
			{ runId: rid("t5"), lane: "debug", recommendedNextLane: "patch" as never },
			{ runId: rid("t6"), lane: "debug", selectedNextLane: "hotfixx" as never },
			{ runId: rid("t7"), lane: "debug", selectedNextLane: "no-code-report" as never },
		];
		for (let i = 0; i < cases.length; i++) try { createInitialShipState(cases[i]); check(false, `7q/${i}) createInitialShipState throws`); } catch { check(true, `7q/${i}) createInitialShipState throws`); }
	}
	withTemp("engine-invalid-lane", (cwd) => {
		const valid = writeShipState(cwd, createInitialShipState({ runId: rid("invalid-lane-state"), lane: "hotfix", hotfixKind: "code-changing" }));
		const badState: ShipState = { ...valid, lane: "quick" as never };
		const t = transitionShipState(badState, { kind: "implement_started" });
		check(t.toStage === "blocked" && hasStop(t, "debug-implementation-without-selected-lane") && t.state.blockers.some((b) => b.includes('Invalid lane "quick"')), "7r) transitionShipState blocks implement_started for state with invalid lane and names the bad value");
		const allEvents: Array<Parameters<typeof transitionShipState>[1]> = [
			{ kind: "implement_started" },
			{ kind: "coder_completed", changedFiles: [], evidenceRefs: [], checks: [] },
			{ kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "passed", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" },
		];
		for (const ev of allEvents) {
			const r = transitionShipState(badState, ev);
			check(r.toStage === "blocked", `7r-all) invalid-lane state blocks any event kind=${ev.kind}`);
		}
	});
	withTemp("engine-diagnose-invalid-recommendation", (cwd) => {
		const init = writeShipState(cwd, createInitialShipState({ runId: rid("diag-bad-rec"), lane: "debug", diagnosis: "x", recommendedNextLane: "hotfix" }));
		const t = transitionShipState(init, { kind: "diagnose", diagnosis: "x", recommendedNextLane: "patch" as never });
		check(t.toStage === "blocked" && hasStop(t, "debug-implementation-without-selected-lane"), "7s) diagnose with invalid recommendedNextLane blocks (does not store invalid value)");
		check(t.state.recommendedNextLane === "hotfix", "7s-preserve) durable recommendedNextLane is preserved when diagnose event is invalid");
	});
	withTemp("engine-implement-started-debug-invalid-selected", (cwd) => {
		const base = createInitialShipState({ runId: rid("impl-bad-sel"), lane: "debug", diagnosis: "x", recommendedNextLane: "hotfix" });
		const bad: ShipState = { ...base, selectedNextLane: "patch" as never };
		const t = transitionShipState(bad, { kind: "implement_started" });
		check(t.toStage === "blocked" && hasStop(t, "debug-implementation-without-selected-lane"), "7t) implement_started for debug with invalid selectedNextLane blocks");
		const stale: ShipState = { ...base, selectedNextLane: "no-code-report" as never };
		const t2 = transitionShipState(stale, { kind: "implement_started" });
		check(t2.toStage === "blocked" && hasStop(t2, "debug-implementation-without-selected-lane"), "7t-stale) implement_started for debug with stale 'no-code-report' selectedNextLane blocks");
	});
	withTemp("engine-text-evidence-coder-with-code-files", (cwd) => {
		const s = transitionShipState(writeShipState(cwd, createInitialShipState({ runId: rid("text-ev-code-files"), lane: "hotfix", hotfixKind: "text-evidence-only" })), { kind: "implement_started" }).state;
		const coder = transitionShipState(s, { kind: "coder_completed", changedFiles: ["src/app.ts", "extensions/sprint/lane-policy.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] });
		check(coder.toStage === "reviewing" && coder.state.reviewerRequired === true, "7u) coder_completed with code-looking changedFiles for text-evidence-only routes to reviewing");
		const fin = transitionShipState(coder.state, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "passed", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(fin.toStage === "blocked" && hasStop(fin, "finalization-blocked"), "7u-final) cannot reach delivery_complete without reviewer_approved when code files leaked in");
		const empty = transitionShipState(s, { kind: "coder_completed", changedFiles: [], evidenceRefs: [], checks: [] });
		check(empty.toStage === "reviewing" && empty.state.reviewerRequired === true, "7v) text-evidence-only with empty coder_completed does NOT go to finalizing; routes to reviewing");
		const finEmpty = transitionShipState(empty.state, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "passed", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(hasStop(finEmpty, "finalization-blocked"), "7w) finalization_recorded before reviewer_approved (after empty-coder redirect) still blocks delivery");
		const m: ShipState = { ...s, changedFiles: ["extensions/sprint/prompt.ts"], evidenceRefs: ["extensions/sprint/prompt.ts#x"], checks: [pass("smoke")] };
		const finBack = transitionShipState(m, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "passed", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(hasStop(finBack, "finalization-blocked") && finBack.toStage === "blocked", "7x) text-evidence finalization backstop: code-looking changedFiles+evidenceRefs on durable state blocks delivery_complete reviewer-free");
		const m2: ShipState = { ...s, changedFiles: ["README.md"], evidenceRefs: ["src/app.ts#L1"], checks: [pass("smoke")] };
		const finBack2 = transitionShipState(m2, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "passed", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(hasStop(finBack2, "finalization-blocked") && finBack2.toStage === "blocked", "7y) text-evidence finalization backstop: code-looking evidenceRefs (strip #L1) on durable state also blocks");
	});
	withTemp("debug-no-auto-select", (cwd) => {
		const id = rid("debug-no-auto");
		const init = createInitialShipState({ runId: id, lane: "debug", diagnosis: "Race in apply", rootCauseHypothesis: "missing null guard", affectedFiles: ["src/dispatcher.ts"], riskAssessment: "narrow hotfix candidate", recommendedNextLane: "hotfix" });
		const written = writeShipState(cwd, init);
		check(written.selectedNextLane === undefined, "8a) createInitialShipState does NOT auto-copy recommendedNextLane into selectedNextLane");
		check(written.recommendedNextLane === "hotfix", "8b) recommendedNextLane is preserved on state");
		check(written.affectedFiles.includes("src/dispatcher.ts"), "8c) affectedFiles persisted on state");
		check(written.riskAssessment === "narrow hotfix candidate", "8d) riskAssessment persisted on state");
		check(written.reviewerRequired === false, "8e) debug durable state reviewerRequired=false");
		check(written.nextAction === undefined, "8f) nextAction is unset on createInitialShipState when no selectedNextLane");
		const diag = transitionShipState(written, { kind: "diagnose", diagnosis: "Race in apply", recommendedNextLane: "hotfix", affectedFiles: ["src/dispatcher.ts"], riskAssessment: "narrow hotfix" });
		const afterDiag = writeShipState(cwd, diag.state);
		check(afterDiag.diagnosis === "Race in apply", "8g) diagnose persists diagnosis on state");
		check(afterDiag.affectedFiles.includes("src/dispatcher.ts"), "8h) diagnose persists affectedFiles on state");
		check(afterDiag.riskAssessment === "narrow hotfix", "8i) diagnose persists riskAssessment on state");
		check(afterDiag.nextAction === "stop", "8i2) diagnose sets nextAction=stop (awaiting explicit select_next_lane)");
		const blocked = transitionShipState(afterDiag, { kind: "implement_started" });
		check(hasStop(blocked, "debug-implementation-without-selected-lane") && blocked.toStage === "blocked", "8j) implement_started without explicit select_next_lane blocks with debug-implementation-without-selected-lane");
		const promoted = transitionShipState(afterDiag, { kind: "select_next_lane", lane: "hotfix", hotfixKind: "code-changing" });
		const promotedWritten = writeShipState(cwd, promoted.state);
		check(promoted.toStage === "created" && promotedWritten.lane === "hotfix" && promotedWritten.hotfixKind === "code-changing", "8k) select_next_lane promotes debug to hotfix with hotfixKind");
		check(promotedWritten.selectedNextLane === "hotfix", "8l) select_next_lane records selectedNextLane=hotfix");
		check(promotedWritten.reviewerRequired === true, "8m) after promotion to code-changing hotfix, durable reviewerRequired=true");
		const impl = transitionShipState(promotedWritten, { kind: "implement_started" });
		check(impl.toStage === "implementing", "8n) implement_started allowed after explicit select_next_lane promotion");
	});
	withTemp("select-next-lane-debug-rejected", (cwd) => {
		const init = writeShipState(cwd, createInitialShipState({ runId: rid("select-debug"), lane: "debug", diagnosis: "x", recommendedNextLane: "hotfix" }));
		const t = transitionShipState(init, { kind: "select_next_lane", lane: "debug" as never });
		check(hasStop(t, "debug-implementation-without-selected-lane") && t.toStage === "blocked", "9a) select_next_lane with lane='debug' is rejected and blocks");
	});
	withTemp("no-code-report-only", (cwd) => {
		const init = writeShipState(cwd, createInitialShipState({ runId: rid("report-only"), lane: "debug", diagnosis: "by design", rootCauseHypothesis: "intentional behavior", affectedFiles: ["src/x.ts"], riskAssessment: "docs only", recommendedNextLane: "no-code/report-only" }));
		const sel = transitionShipState(init, { kind: "select_report_only" });
		const selWritten = writeShipState(cwd, sel.state);
		check(selWritten.selectedNextLane === "no-code/report-only", "10a) select_report_only records selectedNextLane=no-code/report-only");
		check(selWritten.lane === "debug", "10b) select_report_only does not change state.lane");
		check(selWritten.nextAction === "report-only", "10c) select_report_only sets nextAction=report-only");
		check(selWritten.reviewerRequired === false, "10d) report-only debug has reviewerRequired=false");
		check(hasStop(sel, "report-only-stop") && sel.toStage === "blocked", "10e) select_report_only emits report-only-stop stopCondition");
		const impl = transitionShipState(selWritten, { kind: "implement_started" });
		check(hasStop(impl, "report-only-stop"), "10f) implement_started after report-only selection is blocked with report-only-stop");
	});
	withTemp("reviewer-durable-wins", (cwd) => {
		const init = writeShipState(cwd, createInitialShipState({ runId: rid("reviewer-durable"), lane: "hotfix", hotfixKind: "code-changing" }));
		check(init.reviewerRequired === true, "11a) code-changing hotfix durable reviewerRequired=true");
		const coder = transitionShipState(transitionShipState(init, { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")], reviewerRequired: false, evidenceOnly: true });
		check(coder.toStage === "reviewing" && coder.state.reviewerOutcome === undefined, "11b) code-changing hotfix coder_completed is forced to reviewing even if event flag lies");
	});
	withTemp("finalization-needs-reviewer", (cwd) => {
		const init = writeShipState(cwd, createInitialShipState({ runId: rid("finalize-reviewer"), lane: "hotfix", hotfixKind: "code-changing" }));
		const s = transitionShipState(transitionShipState(init, { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] }).state;
		const fin = transitionShipState(s, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "passed", qualityAuditSummary: "ok", qualityAuditArtifact: ".pi/workflow-runs/quality-audit/x.json" });
		check(hasStop(fin, "finalization-blocked") && fin.toStage === "blocked", "11c) finalization_recorded blocks when reviewer-required lane has no reviewer_approved");
		check(fin.state.finalizationStatus === "blocked", "11d) finalizationStatus=blocked when reviewer gate fails");
	});
	withTemp("finalization-blocks-on-cr", (cwd) => {
		const s0 = writeShipState(cwd, createInitialShipState({ runId: rid("finalize-cr"), lane: "full-sprint" }));
		const s1 = transitionShipState(transitionShipState(s0, { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] }).state;
		const s2 = transitionShipState(s1, { kind: "reviewer_changes_requested", at: at(), notes: "fix" }).state;
		const fin = transitionShipState(s2, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "passed", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(hasStop(fin, "finalization-blocked") && fin.toStage === "blocked", "11e) finalization blocks when reviewer is in CHANGES_REQUESTED state");
	});
	withTemp("text-evidence-still-needs-finalization", (cwd) => {
		const s0 = writeShipState(cwd, createInitialShipState({ runId: rid("text-evidence-finalize"), lane: "hotfix", hotfixKind: "text-evidence-only" }));
		const s1 = transitionShipState(transitionShipState(s0, { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["README.md"], evidenceRefs: ["rg"], checks: [pass("rg")] }).state;
		const finMissing = transitionShipState(s1, { kind: "finalization_recorded", finalizationSummary: "", qualityAuditSummary: "", qualityAuditArtifact: "" });
		check(hasStop(finMissing, "finalization-blocked") && finMissing.toStage === "blocked", "11f) text-evidence-only hotfix still blocks delivery_complete without finalization+audit");
	});
	withTemp("text-evidence-passes-finalization", (cwd) => {
		const s0 = writeShipState(cwd, createInitialShipState({ runId: rid("text-evidence-pass"), lane: "hotfix", hotfixKind: "text-evidence-only" }));
		const s1 = transitionShipState(transitionShipState(s0, { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["README.md"], evidenceRefs: ["rg"], checks: [pass("rg")] }).state;
		const fin = transitionShipState(s1, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "passed", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(fin.toStage === "delivery_complete" && fin.state.finalizationStatus === "complete", "11g) text-evidence-only hotfix reaches delivery_complete with valid finalization+audit");
	});
	withTemp("finalization-missing-result", (cwd) => {
		const init = writeShipState(cwd, createInitialShipState({ runId: rid("finalize-missing-result"), lane: "hotfix", hotfixKind: "code-changing" }));
		const s = transitionShipState(transitionShipState(init, { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] }).state;
		const fin = transitionShipState(s, { kind: "finalization_recorded", finalizationSummary: "ok", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(hasStop(fin, "finalization-blocked") && fin.toStage === "blocked", "11h) finalization_recorded blocks when finalizationResult is missing");
		check(fin.state.finalizationStatus === "blocked", "11i) missing finalizationResult sets finalizationStatus=blocked");
	});
	withTemp("finalization-failed-result", (cwd) => {
		const init = writeShipState(cwd, createInitialShipState({ runId: rid("finalize-failed-result"), lane: "hotfix", hotfixKind: "code-changing" }));
		const s = transitionShipState(transitionShipState(init, { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] }).state;
		const fin = transitionShipState(s, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "failed: pre-flight checks", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(hasStop(fin, "finalization-blocked") && fin.toStage === "blocked", "11j) finalization_recorded blocks when finalizationResult contains 'failed'");
		const blocked = transitionShipState(s, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "blocked by ship gate", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(hasStop(blocked, "finalization-blocked"), "11k) finalization_recorded blocks when finalizationResult contains 'blocked'");
		const denied = transitionShipState(s, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "denied", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(hasStop(denied, "finalization-blocked"), "11l) finalization_recorded blocks when finalizationResult is 'denied'");
	});
	withTemp("retry-budget-bounded", (cwd) => {
		let s = writeShipState(cwd, createInitialShipState({ runId: rid("retry-budget"), lane: "hotfix", hotfixKind: "code-changing", retryBudget: 2 }));
		s = transitionShipState(s, { kind: "implement_started" }).state;
		s = transitionShipState(s, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] }).state;
		const chg1 = transitionShipState(s, { kind: "reviewer_changes_requested", at: at(), notes: "fix" });
		check(chg1.toStage === "fixing", "12a) 1st CR with attempts=1 < retryBudget=2 → fixing");
		const fix1 = transitionShipState(chg1.state, { kind: "focused_fix_completed", changedFiles: ["src/a.ts"], checks: [pass("smoke")] });
		check(fix1.toStage === "reviewing" && fix1.state.attempts === 2, "12b) focused_fix_completed consumes budget (attempts 1 → 2) and re-enters reviewing");
		const chg2 = transitionShipState(fix1.state, { kind: "reviewer_changes_requested", at: at(), notes: "again" });
		check(hasStop(chg2, "retry-budget-exhausted") && chg2.toStage === "blocked", "12c) 2nd CR after focused fix is blocked because attempts=2 >= retryBudget=2");
		const reimpl = transitionShipState(chg2.state, { kind: "implement_started" });
		check(reimpl.toStage === "blocked" || hasStop(reimpl, "retry-budget-exhausted"), "12d) further implement_started is blocked once budget is exhausted");
	});
	withTemp("retry-budget-with-budget-1", (cwd) => {
		let s = writeShipState(cwd, createInitialShipState({ runId: rid("retry-budget-1"), lane: "hotfix", hotfixKind: "code-changing", retryBudget: 1 }));
		s = transitionShipState(s, { kind: "implement_started" }).state;
		s = transitionShipState(s, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] }).state;
		const chg = transitionShipState(s, { kind: "reviewer_changes_requested", at: at(), notes: "fix" });
		check(chg.toStage === "blocked", "12e) retryBudget=1: 1st CR is blocked (attempts=1 >= budget=1)");
	});
	withTemp("happy-path-with-budget-3", (cwd) => {
		let s = writeShipState(cwd, createInitialShipState({ runId: rid("happy-3"), lane: "hotfix", hotfixKind: "code-changing", retryBudget: 3 }));
		s = transitionShipState(s, { kind: "implement_started" }).state;
		s = transitionShipState(s, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] }).state;
		s = transitionShipState(s, { kind: "reviewer_changes_requested", at: at() }).state;
		s = transitionShipState(s, { kind: "focused_fix_completed", checks: [pass("smoke")] }).state;
		s = transitionShipState(s, { kind: "reviewer_changes_requested", at: at() }).state;
		s = transitionShipState(s, { kind: "focused_fix_completed", checks: [pass("smoke")] }).state;
		const chg3 = transitionShipState(s, { kind: "reviewer_changes_requested", at: at() });
		check(hasStop(chg3, "retry-budget-exhausted"), "12f) retryBudget=3: 3rd CR is blocked (attempts=3 >= 3)");
	});
	withTemp("engine-success", (cwd) => {
		let s = transitionShipState(writeShipState(cwd, createInitialShipState({ runId: rid("engine-hotfix-success"), taskId: "TASK-011", lane: "hotfix", hotfixKind: "code-changing", retryBudget: 3 })), { kind: "implement_started" }).state;
		check(s.stage === "implementing" && s.nextAction === "implement", "13a) implement_started moves to implementing and nextAction=implement");
		s = transitionShipState(s, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] }).state;
		check(s.stage === "reviewing", "13b) coder_completed with reviewerRequired moves to reviewing");
		s = transitionShipState(s, { kind: "reviewer_approved", at: at(), notes: "lgtm" }).state;
		check(s.stage === "finalizing", "13c) reviewer_approved moves to finalizing");
		const fin = transitionShipState(s, { kind: "finalization_recorded", finalizationSummary: "All gates passed", finalizationResult: "passed", qualityAuditSummary: "0 critical / 0 high findings", qualityAuditArtifact: ".pi/workflow-runs/quality-audit/TASK-011-quality-audit-summary.json" });
		check(fin.toStage === "delivery_complete" && fin.state.finalizationStatus === "complete", "13d) finalization + audit recorded moves to delivery_complete with finalizationStatus=complete");
		check(hasStop(fin, "delivery-complete"), "13e) delivery-complete stop condition is set");
	});
	withTemp("engine-reviewer-broad-risk", (cwd) => {
		const s0 = setupHotfixState(cwd, rid("engine-broad"));
		const blocked = transitionShipState(s0, { kind: "reviewer_changes_requested", at: at(), notes: "scope creep", broaderRisk: true });
		check(blocked.toStage === "blocked" && hasStop(blocked, "scope-expansion-detected"), "13f) reviewer broader-risk flag blocks immediately");
		const broadReport = renderShipReport(blocked.state, { workspaceName: "test" });
		check(blocked.state.promotionReasonCodes.includes("reviewer-broader-risk") && broadReport.includes("reviewer-broader-risk"), "13f-codes) broader-risk durable state.promotionReasonCodes + rendered report both surface reviewer-broader-risk");
	});
	withTemp("engine-evidence-only", (cwd) => {
		const s0 = writeShipState(cwd, createInitialShipState({ runId: rid("engine-evidence-only"), lane: "hotfix", hotfixKind: "text-evidence-only" }));
		const s = transitionShipState(transitionShipState(s0, { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["README.md"], evidenceRefs: ["rg"], checks: [pass("rg")] }).state;
		check(s.stage === "finalizing", "13g) text-evidence-only hotfix skips reviewer and proceeds to finalizing");
	});
	withTemp("engine-remote", (cwd) => {
		const s0 = writeShipState(cwd, createInitialShipState({ runId: rid("engine-remote"), lane: "hotfix", hotfixKind: "text-evidence-only" }));
		const push = transitionShipState(s0, { kind: "remote_action_requested", action: "push" });
		check(hasStop(push, "unauthorized-remote-action") && push.toStage === "blocked", "13h) default-deny push blocks");
		const pr = transitionShipState(s0, { kind: "remote_action_requested", action: "pr" });
		check(pr.toStage === "blocked", "13i) default-deny pr blocks");
		const dep = transitionShipState(s0, { kind: "remote_action_requested", action: "deploy" });
		check(dep.toStage === "blocked", "13j) default-deny deploy blocks");
		const allowedPush = transitionShipState({ ...s0, permissions: { ...DEFAULT_SHIP_PERMISSIONS, push: true } }, { kind: "remote_action_requested", action: "push" });
		check(!hasStop(allowedPush, "unauthorized-remote-action"), "13k) explicitly authorized push does not block");
	});
	{
		const id = rid("report");
		const advanced: ShipState = {
			...createInitialShipState({ runId: id, taskId: "TASK-011", lane: "hotfix", hotfixKind: "code-changing", retryBudget: 3, allowedScope: "tighten guard" }),
			stage: "finalizing",
			attempts: 1,
			changedFiles: ["extensions/sprint/lane-policy.ts"],
			evidenceRefs: [`.pi/workflow-runs/afk-ship/${id}/state.json`],
			checks: [pass("smoke")],
			reviewerOutcome: { kind: "approved", at: at(), notes: "lgtm" },
			finalizationSummary: "Finalization gate allowed as done.",
			finalizationResult: "passed",
			finalizationStatus: "passed",
			qualityAuditSummary: "0 critical / 0 high",
			qualityAuditArtifact: ".pi/workflow-runs/quality-audit/TASK-011-quality-audit-summary.json",
			finalReportPath: `.pi/workflow-runs/afk-ship/${id}/REPORT.md`,
		};
		const report = renderShipReport(advanced, { workspaceName: "test" });
		for (const s of ["# AFK Ship Supervisor Report", "## Lane and scope", "## Changed files", "## Evidence refs", "## Checks", "## Reviewer outcome", "## Finalization + workflow quality audit", "## Blockers", "## Residual risks", "## Permissions / remote actions", "## Final status", "## Final report path", "## Promotion / reason codes"]) check(report.includes(s), `14a) report contains section: ${s}`);
		check(report.includes("Reviewer outcome: approved"), "14b) report shows reviewer approved when set");
		check(report.includes("Lane: hotfix (hotfixKind=code-changing)"), "14c) report shows hotfixKind in lane line");
		check(report.includes("Allowed scope: tighten guard"), "14d) report renders allowed scope");
		check(report.includes("Reviewer required: yes"), "14e) report renders reviewerRequired flag");
		check(report.includes("Finalization status: passed"), "14f) report renders finalizationStatus");
	}
	{
		const eos: ShipState = { ...createInitialShipState({ runId: rid("report-eo"), lane: "hotfix", hotfixKind: "text-evidence-only" }), stage: "finalizing", changedFiles: ["README.md"], evidenceRefs: ["README.md#lanes"], checks: [pass("rg")] };
		const eor = renderShipReport(eos, { workspaceName: "test" });
		check(eor.includes("Reviewer outcome: not applicable (text-evidence-only path)"), "14g) evidence-only report does NOT claim reviewer approval");
		check(!eor.includes("Reviewer outcome: approved"), "14h) evidence-only report does not fabricate reviewer approval");
		check(eor.includes("Reviewer required: no"), "14i) evidence-only report shows reviewerRequired=no");
	}
	{
		const dr = renderShipReport({ ...createInitialShipState({ runId: rid("report-debug"), lane: "debug", diagnosis: "Race in apply", rootCauseHypothesis: "missing null guard", affectedFiles: ["src/dispatcher.ts", "src/worker.ts"], riskAssessment: "narrow hotfix candidate", recommendedNextLane: "hotfix" }), stage: "diagnosing", diagnosis: "Race in apply", rootCauseHypothesis: "missing null guard", affectedFiles: ["src/dispatcher.ts", "src/worker.ts"], riskAssessment: "narrow hotfix candidate", recommendedNextLane: "hotfix" }, { workspaceName: "test" });
		check(dr.includes("## Debug diagnosis"), "14j) debug report contains diagnosis section");
		check(dr.includes("Recommended next lane: hotfix"), "14k) debug report surfaces recommended next lane");
		check(dr.includes("## Affected files") && dr.includes("src/dispatcher.ts") && dr.includes("src/worker.ts"), "14l) debug report renders affected files");
		check(dr.includes("Risk assessment: narrow hotfix candidate"), "14m) debug report renders risk assessment");
	}
	withTemp("write-ship-report", (cwd) => {
		const id = rid("write-report");
		const init = writeShipState(cwd, createInitialShipState({ runId: id, lane: "hotfix", hotfixKind: "text-evidence-only" }));
		const after = writeShipReport(cwd, init, { render: (s) => renderShipReport(s, { workspaceName: "test" }) });
		const reportAbs = shipReportPath(cwd, id);
		check(fs.existsSync(reportAbs), "15a) REPORT.md is written at shipReportPath(cwd, runId)");
		check(after.finalReportPath === shipReportPathRelative(cwd, id), "15b) state.finalReportPath pinned to repo-relative REPORT.md path");
		const body = fs.readFileSync(reportAbs, "utf8");
		check(body.includes("# AFK Ship Supervisor Report"), "15c) written REPORT.md contains the rendered report body");
	});
	{
		const init = createInitialShipState({ runId: rid("perms"), lane: "hotfix", hotfixKind: "text-evidence-only" });
		const report = renderShipReport(init);
		for (const action of Object.keys(DEFAULT_SHIP_PERMISSIONS) as Array<keyof typeof DEFAULT_SHIP_PERMISSIONS>) {
			check(DEFAULT_SHIP_PERMISSIONS[action] === false, `16a) default permission ${action} is denied`);
			check(report.includes(`${action}: denied (default)`), `16b) report renders default-deny for ${action}`);
		}
	}
	{
		const summary = buildLaneSummary(evaluateLanePolicy({ lane: "hotfix", hotfixKind: "code-changing", scopeStatement: "tighten guard", changedFiles: ["src/a.ts"] }));
		check(summary.startsWith("lane=hotfix status=review-required"), "17a) buildLaneSummary prefixes lane/status");
		check(requiresPromotion(evaluateLanePolicy({ lane: "hotfix", scopeStatement: "x", changedFiles: ["a.ts", "b.ts", "c.ts"] })), "17b) requiresPromotion true on file threshold");
	}
	{
		check(ALL_SHIP_STAGES.length === 8, "18) ALL_SHIP_STAGES exposes the 8-stage vocabulary");
	}
	{
		const nl: DebugNextLane[] = ["hotfix", "full-sprint", "no-code/report-only"];
		check((["code-changing", "text-evidence-only"] as HotfixKind[]).length === 2 && nl.length === 3 && DEFAULT_LANE_THRESHOLDS.filesChanged === 2 && DEFAULT_LANE_THRESHOLDS.locChanged === 50 && DEFAULT_LANE_THRESHOLDS.behaviorPaths === 1 && DEFAULT_LANE_THRESHOLDS.repeatAreaThreshold === 2, "19) hotfix kinds (2), debug next-lanes (3), and lane thresholds (2/50/1/2) are stable");
	}
	{
		const fresh = createInitialShipState({ runId: rid("dbg-fresh"), lane: "debug" });
		const r1 = transitionShipState(fresh, { kind: "coder_completed", changedFiles: ["src/x.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] });
		const r2 = transitionShipState(fresh, { kind: "focused_fix_completed", changedFiles: ["src/x.ts"], checks: [pass("smoke")] });
		const t1 = transitionShipState(fresh, { kind: "select_next_lane", lane: "hotfix" });
		const t2 = transitionShipState(fresh, { kind: "select_report_only" });
		check(hasStop(r1, "debug-implementation-without-selected-lane") && r1.toStage === "blocked", "20a) fresh debug + coder_completed blocks (debug-implementation-without-selected-lane)");
		check(hasStop(r2, "debug-implementation-without-selected-lane") && r2.toStage === "blocked", "20b) fresh debug + focused_fix_completed blocks (debug-implementation-without-selected-lane)");
		check(hasStop(t1, "debug-implementation-without-selected-lane") && t1.toStage === "blocked" && hasStop(t2, "debug-implementation-without-selected-lane") && t2.toStage === "blocked", "21) fresh debug + select_next_lane hotfix and select_report_only both block (no diagnosis)");
	}
	withTemp("engine-fullsprint-completion-gate", (cwd) => {
		const fresh = writeShipState(cwd, createInitialShipState({ runId: rid("fsg-fresh"), lane: "full-sprint" }));
		const coder = transitionShipState(fresh, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] });
		check(hasStop(coder, "full-sprint-gates-not-confirmed") && coder.toStage === "blocked", "22a) fresh full-sprint + coder_completed blocks (full-sprint-gates-not-confirmed)");
		const fix = transitionShipState(fresh, { kind: "focused_fix_completed", changedFiles: ["src/a.ts"], checks: [pass("smoke")] });
		check(hasStop(fix, "full-sprint-gates-not-confirmed") && fix.toStage === "blocked", "22b) fresh full-sprint + focused_fix_completed blocks (full-sprint-gates-not-confirmed)");
		const s = transitionShipState(transitionShipState(writeShipState(cwd, createInitialShipState({ runId: rid("fsg-ok"), lane: "full-sprint", fullSprintGatesConfirmed: true })), { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] });
		check(s.toStage === "reviewing" && s.state.changedFiles.includes("src/a.ts"), "22c) confirmed full-sprint + coder_completed routes to reviewing (gate not bypassed)");
	});
	withTemp("engine-evidence-empty-bypass", (cwd) => {
		const s1 = transitionShipState(transitionShipState(writeShipState(cwd, createInitialShipState({ runId: rid("ev-empty"), lane: "hotfix", hotfixKind: "code-changing" })), { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["src/a.ts"], evidenceRefs: ["smoke"], checks: [pass("smoke")] }).state;
		const empty = transitionShipState(s1, { kind: "evidence_collected", refs: [], checks: [] });
		check(empty.toStage === "blocked" && hasStop(empty, "text-evidence-readiness-missing"), "23a) code-changing hotfix + empty evidence_collected blocks (text-evidence-readiness-missing)");
		const blank = transitionShipState(s1, { kind: "evidence_collected", refs: ["  ", ""], checks: [] });
		check(blank.toStage === "blocked" && hasStop(blank, "text-evidence-readiness-missing"), "23b) blank-only refs (no checks) also blocks");
		const sEo2 = transitionShipState(transitionShipState(writeShipState(cwd, createInitialShipState({ runId: rid("ev-ok"), lane: "hotfix", hotfixKind: "text-evidence-only" })), { kind: "implement_started" }).state, { kind: "coder_completed", changedFiles: ["README.md"], evidenceRefs: ["rg"], checks: [pass("rg")] }).state;
		const ok = transitionShipState(sEo2, { kind: "evidence_collected", refs: ["README.md#lanes"], checks: [pass("rg")] });
		check(ok.toStage === "finalizing", "23c) non-empty evidence_collected on text-evidence-only still proceeds to finalizing");
	});
	if (failures > 0) {
		console.error(`task-011 three-lane + AFK smoke failed: ${failures}`);
		process.exitCode = 1;
		return;
	}
	console.log("task-011 three-lane + AFK smoke checks passed");
}
main();
