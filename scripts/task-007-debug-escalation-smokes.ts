#!/usr/bin/env node
// TASK-007 Phase B — debug escalation wiring and behavior smoke checks.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	appendDebugNote,
	completeDebugItem,
	createDebugItem,
	evaluateDebugLaneEscalationFromDisk,
	promoteDebugItem,
} from "../extensions/sprint/debug";
import { createSprint } from "../extensions/sprint/store";
import { runSprintDebugDone } from "../extensions/sprint/debug-tooling";
import {
	countCompletedDebugFixesInArea,
	type DebugLaneHistoryItem,
	evaluateDebugLaneEscalation,
	inferDebugFeatureArea,
} from "../extensions/sprint/debug-escalation";

let failures = 0;

function check(condition: boolean, message: string): void {
	if (condition) {
		console.log(`PASS: ${message}`);
		return;
	}
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function withTempWorkspace<T>(name: string, fn: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `task-007-${name}-`));
	try {
		return fn(cwd);
	} finally {
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {
			// ignore cleanup failures in test fixture
		}
	}
}

function textFromTask(pathToTask: string): string {
	return fs.readFileSync(pathToTask, "utf8");
}

function checkTaskContainsSection(taskPath: string, expected: string): boolean {
	return textFromTask(taskPath).includes(expected);
}

function extractToolPayload(textResult: { content?: Array<{ text?: unknown }> }): Record<string, any> | undefined {
	for (const entry of textResult.content ?? []) {
		if (typeof entry.text !== "string") continue;
		const text = entry.text.trim();
		if (!text.startsWith("{") || !text.endsWith("}")) continue;
		try {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
		} catch {
			continue;
		}
	}
	return undefined;
}

function mkHistory(): DebugLaneHistoryItem[] {
	return [
		{
			id: "DBG-004-A",
			title: "Fix workflow_cfg profile config persistence",
			status: "done",
			body: "## Summary\nfirst profile fix\n",
		},
		{
			id: "DBG-005-B",
			title: "Fix workflow_cfg model picker state-machine path",
			status: "done",
			body: "## Summary\nsecond profile fix\n",
		},
		{
			id: "DBG-006-C",
			title: "Fix unrelated behavior in another area",
			status: "done",
			body: "## Summary\nunrelated fix\n",
		},
	];
}

function main(): void {
	// 1) One-line-like debug change stays tiny-allow by default.
	{
		const tiny = evaluateDebugLaneEscalation({
			itemId: "DBG-001",
			itemTitle: "Fix workflow_cfg model picker arrow key navigation",
			itemBody: "Directly route left/right key to the model picker list path.",
			filesChanged: 1,
			locChanged: 12,
			behaviorPaths: 1,
			stateMachineOrArchitectureChange: false,
			reviewerBehaviorEvidenceMissing: false,
		});
		check(tiny.suggestedAction === "allow-debug-completion", "1) DBG-001-like one-line item allows tiny debug completion");
		check(tiny.needsEscalation === false, "1) DBG-001-like item requires no escalation");
	}

	// 1b) Real tool path `runSprintDebugDone` keeps tiny arrow-key navigation strict-completable.
	withTempWorkspace("runSprintDebugDone-arrow-key", (cwd) => {
		createSprint(cwd, "task-007 runSprintDebugDone tiny arrow-key smoke");
		const tiny = createDebugItem(cwd, "Fix workflow_cfg model picker arrow key navigation");
		const done = runSprintDebugDone({
			cwd,
			itemId: tiny.id,
			evidence: "Fix one-line arrow key navigation for model picker focus movement.",
		});
		check(!done.isError, "1b) strict runSprintDebugDone for arrow-key navigation succeeds");
		const donePayload = extractToolPayload(done);
		check(donePayload?.item?.status === "done", "1b) strict runSprintDebugDone marks item status as done");
	});

	// 2b) Tool path strict done escalates schema/refactor-like changes.
	withTempWorkspace("runSprintDebugDone-schema-refactor", (cwd) => {
		createSprint(cwd, "task-007 runSprintDebugDone schema/refactor smoke");
		const schema = createDebugItem(cwd, "Refactor workflow_cfg model picker menu schema for apply-state transition");
		const blocked = runSprintDebugDone({
			cwd,
			itemId: schema.id,
			evidence: "menu schema and state-machine mapping changed to support flow rewrite",
		});
		check(Boolean(blocked.isError), "2b) strict runSprintDebugDone blocks schema/refactor-like navigation changes");
		const blockedPayload = extractToolPayload(blocked);
		check(
			blockedPayload?.escalation?.suggestedAction === "promote-debug-item",
			"2b) schema/refactor escalation still recommends promotion in done tool path",
		);
	});

	// 2c) Tool path strict done escalates repeated same-area chains for root-cause stabilization.
	withTempWorkspace("runSprintDebugDone-repeated", (cwd) => {
		createSprint(cwd, "task-007 runSprintDebugDone repeated-chain smoke");
		const first = createDebugItem(cwd, "Fix workflow_cfg profile config typo");
		const second = createDebugItem(cwd, "Fix workflow_cfg profile menu label alignment");
		const repeated = createDebugItem(cwd, "Fix workflow_cfg profile picker helper behavior");
		completeDebugItem(cwd, first.id, "done");
		completeDebugItem(cwd, second.id, "done");
		const blockedRepeated = runSprintDebugDone({
			cwd,
			itemId: repeated.id,
			evidence: "Follow-up profile picker behavior fix in same area.",
		});
		check(Boolean(blockedRepeated.isError), "2c) strict runSprintDebugDone blocks repeated same-area completion path");
		const repeatedPayload = extractToolPayload(blockedRepeated);
		check(
			repeatedPayload?.escalation?.suggestedAction === "promote-debug-item-with-root-cause",
			"2c) repeated same-area runSprintDebugDone still requires root-cause promotion path",
		);
	});

	// 2) Menu-schema/state-machine-like refactor requires promotion.
	{
		const menuRefactor = evaluateDebugLaneEscalation({
			itemId: "DBG-003",
			itemTitle: "Refactor workflow_cfg menu schema to per-block apply profile config",
			itemBody: "Refactor schema shape and persistence mapping for menu navigation and apply flows.",
			filesChanged: 3,
			locChanged: 96,
			behaviorPaths: 2,
			stateMachineOrArchitectureChange: true,
			reviewerBehaviorEvidenceMissing: false,
		});
		check(menuRefactor.suggestedAction === "promote-debug-item", "2) menu-schema refactor escalates to promotion");
		check(menuRefactor.ruleCodes.includes("DBG-001:core-file-threshold"), "2) menu-schema escalates on file threshold");
		check(menuRefactor.ruleCodes.includes("DBG-003:state-machine-or-architecture"), "2) menu-schema escalates on architecture/state-machine trigger");
	}

	// 3) Repeated same-area chain suggests root-cause stabilization.
	{
		const history = mkHistory();
		const inferred = inferDebugFeatureArea("Fix workflow_cfg profile config persistence");
		check(inferred === "workflow_cfg", "3) workflow_cfg area heuristic infers historic debug lane area");
		check(countCompletedDebugFixesInArea(history, "workflow_cfg") === 2, "3) same-area heuristic counting returns 2 prior fixes");
		const repeated = evaluateDebugLaneEscalation({
			itemId: "DBG-004",
			itemTitle: "Fix workflow_cfg profile selection persistence and Esc UX",
			itemBody: "Second wave follow-up on workflow profile persistence path.",
			filesChanged: 2,
			locChanged: 38,
			behaviorPaths: 1,
			featureArea: "workflow_cfg",
			repeatedSameAreaFixCount: countCompletedDebugFixesInArea(history, "workflow_cfg"),
		});
		check(repeated.suggestedAction === "promote-debug-item-with-root-cause", "3) repeated same-area chain now requires root-cause action");
		check(repeated.needsRootCauseTask === true, "3) repeated same-area chain marks root-cause requirement");
		check(
			repeated.ruleCodes.includes("DBG-006:repeated-same-area"),
			"3) repeated same-area rule code is included in escalation",
		);
	}

	// 4) Metadata-free DBG-003 signal escalates (no explicit metadata) while CI wording remains tiny-allowed.
	{
		const history = mkHistory();
		const unrelated = evaluateDebugLaneEscalation({
			itemId: "DBG-020",
			itemTitle: "Fix GitHub Actions workflow typo in CI file",
			itemBody: "Rename a workflow typo in the GitHub Actions file without touching runtime behavior.",
			filesChanged: 1,
			locChanged: 4,
			behaviorPaths: 1,
			history,
		});
		check(unrelated.featureArea === undefined, "4) workflow typo in CI does not infer workflow_cfg area");
		check(unrelated.suggestedAction === "allow-debug-completion", "4) unrelated workflow typo remains tiny-allowed despite workflow_cfg history");
	}

	withTempWorkspace("metadata-free-dbg-003", (cwd) => {
		createSprint(cwd, "task-007 metadata-free dbg-003 smoke");
		const created = createDebugItem(cwd, "Refactor workflow_cfg menu schema for model picker state-machine path");
		const metadataFree = evaluateDebugLaneEscalationFromDisk(cwd, {
			itemId: created.id,
			evidenceText: "menu schema state-machine behavior touched",
		});
		check(
			metadataFree.suggestedAction === "promote-debug-item",
			"4) metadata-free DBG-003 signal still escalates as promotion",
		);
		check(metadataFree.ruleCodes.includes("DBG-003:state-machine-or-architecture"), "4) metadata-free DBG-003 signal maps to expected rule code");
	});

	// 5) Current debug id in same-area history is excluded from prior count when derived.
	{
		const history: DebugLaneHistoryItem[] = [
			{
				id: "DBG-030",
				title: "Fix workflow_cfg schema persistence path",
				status: "done",
				body: "## Summary\nfirst fix\n",
			},
			{
				id: "DBG-031",
				title: "Fix workflow_cfg profile selection follow-up",
				status: "done",
				body: "## Summary\ncurrent work item recorded before completion\n",
			},
		];
		check(
			countCompletedDebugFixesInArea(history, "workflow_cfg", "DBG-031") === 1,
			"5) excluding current item id prevents same-area count inflation before repeat threshold",
		);
		const derivedHistoryCount = evaluateDebugLaneEscalation({
			itemId: "DBG-031",
			itemTitle: "Fix workflow_cfg follow-up profile menu behavior",
			itemBody: "Tiny follow-up fix in the same workflow_cfg area.",
			history,
			filesChanged: 2,
			locChanged: 9,
			behaviorPaths: 1,
		});
		check(
			derivedHistoryCount.suggestedAction === "allow-debug-completion",
			"5) one prior same-area fix + current-id-in-history does not trigger root-cause escalation",
		);
		check(
			derivedHistoryCount.needsRootCauseTask === false,
			"5) one prior same-area fix with current-id-in-history does not require root-cause task",
		);
	}

	// 6) from-disk evaluator keeps tiny DBG-001-like terse evidence allowed; explicit reviewer-missing is respected.
	withTempWorkspace("from-disk-evidence-missing", (cwd) => {
		createSprint(cwd, "task-007 from-disk evidence missing smoke");
		const tiny = createDebugItem(cwd, "Fix typo in docs helper copy");
		const tinyFromDisk = evaluateDebugLaneEscalationFromDisk(cwd, {
			itemId: tiny.id,
			evidenceText: "fixed typo",
		});
		check(
			tinyFromDisk.suggestedAction === "allow-debug-completion",
			"6a) from-disk DBG-001-like terse evidence does not block completion",
		);

		const explicitMissing = evaluateDebugLaneEscalationFromDisk(cwd, {
			itemId: tiny.id,
			reviewerBehaviorEvidenceMissing: true,
			evidenceText: "fixed typo",
		});
		check(
			explicitMissing.suggestedAction === "promote-debug-item",
			"6b) explicit reviewerBehaviorEvidenceMissing:true still requires promotion",
		);
		check(
			explicitMissing.ruleCodes.includes("DBG-005:reviewer-evidence-missing"),
			"6b) explicit reviewerBehaviorEvidenceMissing sets DBG-005",
		);

		const inferredMissing = evaluateDebugLaneEscalationFromDisk(cwd, {
			itemId: tiny.id,
			evidenceText: "missing behavior evidence for this user path",
		});
		check(
			inferredMissing.suggestedAction === "promote-debug-item",
			"6c) inferred negative evidence phrasing can still trigger escalation",
		);
		check(
			inferredMissing.ruleCodes.includes("DBG-005:reviewer-evidence-missing"),
			"6c) inferred evidence phrasing triggers DBG-005",
		);
	});

	// 7) from-disk escalation preserves repeated count, excludes current id, and infers signals.
	withTempWorkspace("from-disk-escalation", (cwd) => {
		createSprint(cwd, "task-007 from-disk escalation smoke");
		const first = createDebugItem(cwd, "Fix workflow_cfg profile config typo");
		const second = createDebugItem(cwd, "Fix workflow_cfg profile menu text");
		appendDebugNote(cwd, first.id, "Evidence: first fix done");
		appendDebugNote(cwd, second.id, "Fixes workflow_cfg profile menu text");
		completeDebugItem(cwd, first.id, "Done after local verification.");
		const fromDisk = evaluateDebugLaneEscalationFromDisk(cwd, {
			itemId: second.id,
			behaviorPaths: 1,
			evidenceText: "Manual repro validated on profile menu text edge case.",
		});
		check(
			fromDisk.suggestedAction === "allow-debug-completion",
			"7) from-disk evaluation with inferred metadata can stay tiny when thresholds are safe",
		);
		check(fromDisk.repeatedSameAreaFixCount === 1, "7) from-disk evaluator counts only prior completed same-area fixes");
	});

	// 8) from-disk repeated area escalation triggers root-cause path.
	withTempWorkspace("from-disk-root-cause", (cwd) => {
		createSprint(cwd, "task-007 from-disk root-cause smoke");
		const first = createDebugItem(cwd, "Fix workflow_cfg profile picker state-machine path");
		const second = createDebugItem(cwd, "Fix workflow_cfg profile persistence menu state machine");
		const third = createDebugItem(cwd, "Fix workflow_cfg profile persistence apply behavior");
		appendDebugNote(cwd, first.id, "Done");
		appendDebugNote(cwd, second.id, "Done");
		completeDebugItem(cwd, first.id, "done");
		completeDebugItem(cwd, second.id, "done");
		const fromDisk = evaluateDebugLaneEscalationFromDisk(cwd, {
			itemId: third.id,
			behaviorPaths: 1,
			evidenceText: "Follow-up fix in the same workflow_cfg behavior path.",
		});
		check(
			fromDisk.suggestedAction === "promote-debug-item-with-root-cause",
			"7) from-disk repeated same-area context escalates to root-cause path",
		);
		check(fromDisk.needsRootCauseTask === true, "7) from-disk evaluation marks needsRootCauseTask");
		check(fromDisk.ruleCodes.includes("DBG-006:repeated-same-area"), "7) from-disk evaluator reports repeated-area rule");
	});

	// 8) Promotion preserves debug context + generated acceptance criteria in task body.
	withTempWorkspace("promotion-context", (cwd) => {
		createSprint(cwd, "task-007 debug smoke");
		const created = createDebugItem(cwd, "Refactor workflow_cfg menu schema for runtime settings apply");
		const originalEvidence = "Evidence: this required menu schema migration from global apply to per-block apply";
		appendDebugNote(cwd, created.id, originalEvidence);
		const escalation = evaluateDebugLaneEscalation({
			itemId: created.id,
			itemTitle: created.title,
			itemBody: textFromTask(created.filePath),
			filesChanged: 4,
			locChanged: 140,
			behaviorPaths: 2,
			stateMachineOrArchitectureChange: true,
			reviewerBehaviorEvidenceMissing: false,
			repeatedSameAreaFixCount: 2,
		});
		const promoted = promoteDebugItem(cwd, created.id, {
			note: "Escalated from debug lane due to state-machine change and repeated workflow_cfg history.",
			escalation,
		});
		const taskText = textFromTask(promoted.task.filePath);
		check(checkTaskContainsSection(promoted.task.filePath, "## Debug Lane Context"), "8) promoted task retains Debug Lane Context section");
		check(checkTaskContainsSection(promoted.task.filePath, `Debug item id: ${created.id}`), "8) promoted task keeps original debug id");
		check(checkTaskContainsSection(promoted.task.filePath, originalEvidence), "8) promoted task keeps original debug evidence text");
		check(
			checkTaskContainsSection(promoted.task.filePath, "## Debug Lane Acceptance Criteria"),
			"8) promoted task adds generated acceptance criteria section",
		);
		check(taskText.includes("DBG-006:repeated-same-area") || taskText.includes("DBG-006"), "8) promoted context includes escalation rule code(s)");
		check(taskText.includes("root-cause analysis"), "8) promoted acceptance criteria includes root-cause guidance when relevant");
	});

	if (failures > 0) {
		console.error(`task-007 debug escalation smoke failed: ${failures}`);
		process.exitCode = 1;
		return;
	}
	console.log("task-007 debug escalation smoke checks passed");
}

main();
