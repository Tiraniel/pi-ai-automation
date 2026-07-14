#!/usr/bin/env node
// TASK-034 (WP4) — loop circuit breaker smokes.
// Pure ship-engine transitions + synthetic review results + the durable
// per-phase budget ledger. The breakers must:
//   - resolve loopBudget config (defaults: unbounded cost/wall-clock,
//     maxSameFindingRepeats=2);
//   - fingerprint blocking findings deterministically (role + first N chars,
//     lowercased, whitespace-collapsed);
//   - accumulate delegate cost durably per (plan, phase) and stop the normal
//     cycle with a blocking operator question when the budget is exceeded
//     ("continue?" resets the window when answered);
//   - escalate a blocking operator question when the same finding repeats
//     maxSameFindingRepeats times, instead of another silent re-delegate;
//   - stop the AFK ship engine with budget-exhausted at implementation-loop
//     re-entry points (implement_started / reviewer_changes_requested) on
//     cost or wall-clock overrun, accumulating event costUsd into the state.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createFakeContext, createFakePi } from "../tests/fake-pi";
import {
	DEFAULT_MAX_SAME_FINDING_REPEATS,
	accumulatePhaseCost,
	enforceLoopBudgetBeforeDelegation,
	evaluateLoopBudget,
	normalizeFindingFingerprint,
	phaseBudgetPathFor,
	readPhaseBudget,
	recordReviewFindings,
	resolveLoopBudgetConfig,
} from "../extensions/workflow/loop-budget";
import {
	answerOperatorQuestionInFile,
	listOpenBlockingQuestionsInFile,
	operatorQuestionsPathForRoom,
} from "../extensions/workflow/operator-questions";
import { DEFAULT_CONFIG } from "../extensions/workflow/defaults";
import { transitionShipState } from "../extensions/sprint/ship-engine";
import { createInitialShipState, type ShipState } from "../extensions/sprint/ship-state";
import { registerSprintShipTools } from "../extensions/sprint/ship-tools";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function makeHotfixState(overrides: Partial<ShipState> = {}): ShipState {
	const base = createInitialShipState({
		runId: "afk-task-034",
		lane: "hotfix",
		hotfixKind: "code-changing",
		allowedScope: "task-034 smoke",
		loopBudget: { maxCostUsd: 1 },
	});
	return { ...base, ...overrides };
}

async function main(): Promise<void> {
	const cleanups: string[] = [];
	const makeTempCwd = (prefix: string): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		cleanups.push(dir);
		return dir;
	};
	try {
		// (1) Config resolution.
		{
			const defaults = resolveLoopBudgetConfig(undefined);
			check(defaults.maxCostUsd === undefined && defaults.maxWallClockMs === undefined, "1: cost/wall-clock unbounded by default");
			check(defaults.maxSameFindingRepeats === DEFAULT_MAX_SAME_FINDING_REPEATS, "1: maxSameFindingRepeats defaults to 2");
			check(DEFAULT_CONFIG.loopBudget?.maxSameFindingRepeats === DEFAULT_MAX_SAME_FINDING_REPEATS, "1: DEFAULT_CONFIG carries the repeat default");
			const configured = resolveLoopBudgetConfig({ loopBudget: { maxCostUsd: 5, maxWallClockMs: 60000, maxSameFindingRepeats: 3 } });
			check(configured.maxCostUsd === 5 && configured.maxWallClockMs === 60000 && configured.maxSameFindingRepeats === 3, "1: configured values honored");
			const invalid = resolveLoopBudgetConfig({ loopBudget: { maxCostUsd: -1, maxSameFindingRepeats: 0 } });
			check(invalid.maxCostUsd === undefined && invalid.maxSameFindingRepeats === DEFAULT_MAX_SAME_FINDING_REPEATS, "1: non-positive values fall back");
		}

		// (2) Finding fingerprint normalization.
		{
			const a = normalizeFindingFingerprint("Behavior", "  The   Export skips FILTERS on retry  ");
			const b = normalizeFindingFingerprint("behavior", "the export skips filters on retry");
			check(a === b, "2: case/whitespace noise does not change the fingerprint");
			const long = normalizeFindingFingerprint("r", "x".repeat(500));
			check(long.length <= "r:".length + 80, "2: fingerprint truncates at N chars");
			check(normalizeFindingFingerprint("behavior", "finding A") !== normalizeFindingFingerprint("regression", "finding A"), "2: role is part of the fingerprint");
		}

		// (3) Pure budget evaluation.
		{
			const now = Date.parse("2026-07-09T12:00:00.000Z");
			const state = { costUsdSpent: 0.5, windowStartedAt: "2026-07-09T11:59:00.000Z" };
			check(evaluateLoopBudget(state, { maxCostUsd: 1, maxSameFindingRepeats: 2 }, now).exceeded === false, "3: under budget is not exceeded");
			check(evaluateLoopBudget({ ...state, costUsdSpent: 1.5 }, { maxCostUsd: 1, maxSameFindingRepeats: 2 }, now).kind === "cost", "3: cost overrun detected");
			check(evaluateLoopBudget(state, { maxWallClockMs: 30000, maxSameFindingRepeats: 2 }, now).kind === "wall-clock", "3: wall-clock overrun detected");
			check(evaluateLoopBudget(state, { maxSameFindingRepeats: 2 }, now).exceeded === false, "3: unbounded budget never trips");
		}

		// (4) Durable phase ledger round-trip.
		{
			const cwd = makeTempCwd("task-034-ledger-");
			accumulatePhaseCost(cwd, "task-034-plan", "phaseA", 0.25);
			const state = accumulatePhaseCost(cwd, "task-034-plan", "phaseA", 0.5);
			check(Math.abs(state.costUsdSpent - 0.75) < 1e-9, `4: cost accumulates durably (got: ${state.costUsdSpent})`);
			check(fs.existsSync(phaseBudgetPathFor(cwd, "task-034-plan", "phaseA")), "4: ledger lives at <planId>.<phase>.budget.json");
			check(readPhaseBudget(cwd, "task-034-plan", "phaseB").costUsdSpent === 0, "4: phases have independent ledgers");
			fs.writeFileSync(phaseBudgetPathFor(cwd, "task-034-plan", "phaseA"), "torn", "utf8");
			check(readPhaseBudget(cwd, "task-034-plan", "phaseA").costUsdSpent === 0, "4: torn ledger resets the spend window (fail-safe)");
		}

		// (5) Delegation gate: exceed -> blocking question; open -> pending;
		//     answered -> window reset and delegation allowed again.
		{
			const cwd = makeTempCwd("task-034-gate-");
			const questionsFile = operatorQuestionsPathForRoom(cwd, "wp4-room");
			const budget = resolveLoopBudgetConfig({ loopBudget: { maxCostUsd: 1 } });
			const ok = enforceLoopBudgetBeforeDelegation(cwd, "task-034-plan", "phaseA", budget, questionsFile);
			check(ok.allowed === true, "5: under budget delegation is allowed");
			accumulatePhaseCost(cwd, "task-034-plan", "phaseA", 1.5);
			const blocked = enforceLoopBudgetBeforeDelegation(cwd, "task-034-plan", "phaseA", budget, questionsFile);
			check(blocked.allowed === false && blocked.reason === "budget_exhausted", `5: exceeded budget blocks (got: ${blocked.reason})`);
			check(typeof blocked.questionId === "string" && listOpenBlockingQuestionsInFile(questionsFile).some((q) => q.id === blocked.questionId), "5: a blocking operator question is recorded");
			const pending = enforceLoopBudgetBeforeDelegation(cwd, "task-034-plan", "phaseA", budget, questionsFile);
			check(pending.allowed === false && pending.reason === "budget_escalation_pending", "5: open escalation keeps delegation blocked");
			check(listOpenBlockingQuestionsInFile(questionsFile).length === 1, "5: no duplicate escalation question is asked");
			answerOperatorQuestionInFile(questionsFile, blocked.questionId!, "continue (reset budget window)", "operator");
			const resumed = enforceLoopBudgetBeforeDelegation(cwd, "task-034-plan", "phaseA", budget, questionsFile);
			check(resumed.allowed === true, "5: answered escalation resets the window and unblocks");
			check(readPhaseBudget(cwd, "task-034-plan", "phaseA").costUsdSpent === 0, "5: cost window reset to zero after the operator answer");
		}

		// (6) Repeated-finding breaker.
		{
			const cwd = makeTempCwd("task-034-findings-");
			const questionsFile = operatorQuestionsPathForRoom(cwd, "wp4-room");
			const budget = resolveLoopBudgetConfig(undefined); // threshold 2
			const finding = { role: "behavior", text: "Export skips filters on retry" };
			const first = recordReviewFindings(cwd, "task-034-plan", "phaseA", [finding], budget, questionsFile);
			check(first.escalated.length === 0, "6: first occurrence does not escalate");
			// Two reviewers repeating the same finding in ONE round count once.
			const sameRound = recordReviewFindings(cwd, "task-034-plan", "phaseA", [finding, { role: "Behavior", text: "  export SKIPS filters on retry " }], budget, questionsFile);
			check(sameRound.escalated.length === 1 && sameRound.escalated[0]!.count === 2, "6: second round escalates at the threshold (deduped within the round)");
			check(listOpenBlockingQuestionsInFile(questionsFile).length === 1, "6: a blocking operator question is recorded for the repeat");
			const third = recordReviewFindings(cwd, "task-034-plan", "phaseA", [finding], budget, questionsFile);
			check(third.escalated.length === 0, "6: an already-escalated fingerprint is not re-asked");
			const other = recordReviewFindings(cwd, "task-034-plan", "phaseA", [{ role: "regression", text: "different finding" }], budget, questionsFile);
			check(other.escalated.length === 0 && other.state.findingCounts[normalizeFindingFingerprint("regression", "different finding")] === 1, "6: distinct findings have independent counters");
			// Delegation is blocked while the repeated-finding escalation is open;
			// answering clears the fingerprint and unblocks.
			const gate = enforceLoopBudgetBeforeDelegation(cwd, "task-034-plan", "phaseA", budget, questionsFile);
			check(gate.allowed === false && gate.reason === "budget_escalation_pending", "6: open repeated-finding escalation blocks the next delegation");
			answerOperatorQuestionInFile(questionsFile, sameRound.escalated[0]!.questionId, "revise the plan", "operator");
			const afterAnswer = enforceLoopBudgetBeforeDelegation(cwd, "task-034-plan", "phaseA", budget, questionsFile);
			check(afterAnswer.allowed === true, "6: answered repeated-finding escalation unblocks delegation");
			check((readPhaseBudget(cwd, "task-034-plan", "phaseA").findingCounts[normalizeFindingFingerprint(finding.role, finding.text)] ?? 0) === 0, "6: the escalated fingerprint counter is cleared by the answer");
		}

		// (7) Ship engine budget stops.
		{
			const overCost = makeHotfixState({ costUsdSpent: 1.5, stage: "created" });
			const stopped = transitionShipState(overCost, { kind: "implement_started" });
			check(stopped.toStage === "blocked" && stopped.stopCondition === "budget-exhausted", `7: implement_started stops on cost overrun (got: ${stopped.stopCondition})`);
			const underCost = makeHotfixState({ costUsdSpent: 0.2, stage: "created" });
			const running = transitionShipState(underCost, { kind: "implement_started" });
			check(running.toStage === "implementing", "7: under budget implementation starts");
			// coder_completed accumulates event cost onto the durable state.
			const accumulated = transitionShipState(
				makeHotfixState({ stage: "implementing", attempts: 1 }),
				{ kind: "coder_completed", changedFiles: ["src/x.ts"], evidenceRefs: ["ref"], checks: [{ command: "c", outcome: "passed" }], costUsd: 0.4 },
			);
			check(Math.abs((accumulated.state.costUsdSpent ?? 0) - 0.4) < 1e-9, "7: coder_completed accumulates costUsd");
			// reviewer_changes_requested with an exhausted budget stops instead of fixing.
			const fixLoop = makeHotfixState({ stage: "reviewing", attempts: 1, retryBudget: 3, costUsdSpent: 0.9 });
			const overOnReview = transitionShipState(fixLoop, { kind: "reviewer_changes_requested", at: new Date().toISOString(), costUsd: 0.5 });
			check(overOnReview.toStage === "blocked" && overOnReview.stopCondition === "budget-exhausted", `7: fix-loop re-entry stops when the review cost pushes over budget (got: ${overOnReview.stopCondition})`);
			// wall-clock overrun.
			const oldStart = makeHotfixState({ stage: "created", loopBudget: { maxWallClockMs: 1000 }, createdAt: new Date(Date.now() - 60000).toISOString() });
			const wallStop = transitionShipState(oldStart, { kind: "implement_started" });
			check(wallStop.stopCondition === "budget-exhausted", "7: wall-clock overrun stops at implement_started");
			// no budget -> unaffected.
			const unbounded = makeHotfixState({ stage: "created", loopBudget: undefined, costUsdSpent: 999 });
			check(transitionShipState(unbounded, { kind: "implement_started" }).toStage === "implementing", "7: without a budget the loop is unaffected");
		}

		// (8) sprint_ship start pins the configured budget onto durable state.
		{
			const cwd = makeTempCwd("task-034-ship-");
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".pi", "workflow.json"), JSON.stringify({ loopBudget: { maxCostUsd: 2.5, maxWallClockMs: 90000 } }, null, 2), "utf8");
			const fake = createFakePi();
			registerSprintShipTools(fake.pi);
			const shipTool = fake.tools.get("sprint_ship")!;
			const started = await shipTool.execute("t1", {
				action: "start", runId: "run-wp4", lane: "hotfix", hotfixKind: "code-changing", allowedScope: "task-034 smoke",
			}, undefined, undefined, createFakeContext(cwd));
			check(started.isError !== true, "8: AFK run starts with a project loopBudget config");
			const state = (started.details as any)?.state as ShipState;
			check(state.loopBudget?.maxCostUsd === 2.5 && state.loopBudget?.maxWallClockMs === 90000, `8: durable state carries the configured budget (got: ${JSON.stringify(state.loopBudget)})`);
			check(state.costUsdSpent === 0, "8: spend ledger starts at zero");
		}
	} finally {
		for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
	}
}

main().then(() => {
	if (failures > 0) { console.error(`\n${failures} loop budget smoke check(s) failed.`); process.exit(1); }
	console.log("\nAll TASK-034 loop budget smoke checks passed.");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
