#!/usr/bin/env node
// TASK-005 Phase A — finalization gate synthetic behavior smoke checks.
// This file is source-string + fixture-only and validates the pure helper.

import type {
	AcceptanceEvidenceMatrixEntry,
	WorkflowArchitecturePlan,
} from "../extensions/workflow/architecture/types";
import type { ReviewerMemo } from "../extensions/workflow/delegate/reviewer-roles";
import type { CoderCompletionEvidence } from "../extensions/workflow/delegate/completion-evidence";
import { evaluateFinalizationGate } from "../extensions/workflow/finalization-gate";
import { evaluateDebugFinalization } from "../extensions/workflow/finalization-runtime";
import "./task-005-finalization-runtime-smokes";

let failures = 0;

function check(condition: boolean, message: string): void {
	if (condition) {
		console.log(`PASS: ${message}`);
		return;
	}
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function makeMatrixEntry(overrides: Partial<AcceptanceEvidenceMatrixEntry>): AcceptanceEvidenceMatrixEntry {
	return {
		criterion: "criterion",
		criterionKind: "runtime-behavior",
		businessRiskIfWrong: "production regression",
		enforcementLevel: ["behavior-test"],
		requiredEvidence: [{ kind: "behavior-test", description: "run behavior test" }],
		reviewerRoles: ["behavior"],
		blockingConditions: ["behavior test fails"],
		...overrides,
	};
}

function makePlan(overrides: Partial<WorkflowArchitecturePlan> = {}): WorkflowArchitecturePlan {
	const entries = overrides.acceptanceEvidenceMatrix ?? [
		makeMatrixEntry({
			criterion: "runtime-check",
			criterionKind: "runtime-behavior",
			requiredEvidence: [{ kind: "behavior-test", description: "runtime behavior test", command: "npx tsx test-runtime.ts" }],
			enforcementLevel: ["behavior-test"],
		}),
		makeMatrixEntry({
			criterion: "docs-check",
			criterionKind: "documentation",
			reviewerRoles: ["docs-config"],
			enforcementLevel: ["manual-validation"],
			requiredEvidence: [{ kind: "manual-validation", description: "docs reviewer signed off" }],
			blockingConditions: ["manual review missing"],
		}),
	];
	return {
		planId: "task-005",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "ready",
		businessPlan: "b",
		technicalPlan: "t",
		parallelAssessment: "serial",
		contractBlockPlan: "c",
		acceptanceCriteria: entries.map((entry) => entry.criterion),
		acceptanceEvidenceMatrix: entries,
		phases: {
			phaseA: { status: "review_approved", updatedAt: new Date().toISOString(), evidence: [] },
			phaseB: { status: "not_started", updatedAt: new Date().toISOString(), evidence: [] },
		},
		...overrides,
	};
}

function makeEvidence(overrides: Partial<CoderCompletionEvidence> = {}): CoderCompletionEvidence {
	return {
		filesChanged: ["src/thing.ts"],
		commandsRun: [
			{ command: "npx tsx test-runtime.ts", outcome: "passed", summary: "runtime behavior test passes", exitCode: 0 },
		],
		criterionCoverage: [
			{
				criterion: "runtime-check",
				evidenceKind: "behavior-test",
				strength: "sufficient",
				supportingFiles: ["src/thing.ts"],
				supportingCommands: ["npx tsx test-runtime.ts"],
				summary: "runtime behavior covered",
			},
			{
				criterion: "docs-check",
				evidenceKind: "manual-validation",
				strength: "manual-caveat",
				supportingFiles: ["docs/readme.md"],
				supportingCommands: [],
				summary: "manual docs validation",
				caveats: "manual reviewer noted risk points",
			},
		],
		knownGaps: [],
		caveats: ["none"],
		summary: "complete evidence packet",
		delegateHistory: {
			attempts: [
				{ attempt: 1, completionSource: "explicit", status: "completed", finalOutputPreview: "done" },
			],
			warnings: [],
			retries: 0,
			autoExitObserved: false,
			processExitObserved: false,
			missingSidecarObserved: false,
			freeFormOnlyObserved: false,
		},
		...overrides,
	};
}

function makeNoBehaviorEvidence(): CoderCompletionEvidence {
	return {
		...makeEvidence(),
		criterionCoverage: [
			{
				criterion: "runtime-check",
				evidenceKind: "prompt-only",
				strength: "weak",
				supportingFiles: ["README.md"],
				supportingCommands: ["npx tsx test-runtime.ts"],
				summary: "prompt-only runtime evidence",
			},
			...makeEvidence().criterionCoverage.slice(1),
		],
	};
}

function makeMemo(overrides: Partial<ReviewerMemo> = {}): ReviewerMemo {
	return {
		planId: "task-005",
		phase: "phaseB",
		approved: true,
		finalRecommendation: "APPROVED",
		approvals: [],
		changesRequested: [],
		weakEvidence: [],
		promptOnlyCaveats: [],
		unresolvedRisks: [],
		provisionalCaveats: [],
		unknownOrFailed: [],
		markdown: "# Memo\n\nAPPROVED",
		supplementalGoals: [],
		docsConfigInScope: false,
		rolesRequired: ["behavior", "docs-config"],
		missingRequiredRoles: [],
		...overrides,
	};
}

function makeHardMemo(blockedByChanges = false, promptOnly = false): ReviewerMemo {
	return makeMemo({
		approved: !blockedByChanges,
		changesRequested: blockedByChanges ? [{
			role: "behavior",
			target: "behavior-test",
			required: true,
			verdict: "CHANGES_REQUESTED",
			effectiveVerdict: "CHANGES_REQUESTED",
			provisional: false,
			blockingReasons: ["runtime behavior not covered"],
			weakEvidence: [],
			promptOnlyCaveats: [],
			unresolvedRisks: [],
			supplementalGoals: [],
			notes: ["Needs rerun"],
		}] : [],
		promptOnlyCaveats: promptOnly ? [
			{
				role: "behavior",
				target: "runtime behavior",
				required: true,
				verdict: "APPROVED",
				effectiveVerdict: "APPROVED",
				provisional: false,
				blockingReasons: [],
				weakEvidence: [],
				promptOnlyCaveats: ["Runtime behavior uses doc-only mitigation in final deployment."],
				unresolvedRisks: ["runtime behavior not fully verified"],
				supplementalGoals: [],
				notes: [],
			},
		] : [],
		finalRecommendation: blockedByChanges
			? "CHANGES_REQUESTED"
			: promptOnly
				? "APPROVED"
				: "APPROVED",
	});
}


function main(): void {
	// 1) Missing behavior-test / runnable coverage blocks strict finalization.
	{
		const plan = makePlan();
		const result = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "done",
			target: { kind: "sprint-task", taskId: "TASK-005-1", planId: plan.planId },
			plan,
			coderEvidence: makeNoBehaviorEvidence(),
			reviewerMemo: makeMemo(),
		});
		check(result.ok === false, "1: strict mode blocks incomplete runnable evidence");
		check(result.blockers.some((reason) => reason.toLowerCase().includes("coder completion evidence")), "1: blocker is coder evidence based");
	}

	// 2) Reviewer memo CHANGES_REQUESTED blocks strict finalization.
	{
		const plan = makePlan();
		const result = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "Done",
			target: { kind: "sprint-task", taskId: "TASK-005-2", planId: plan.planId },
			plan,
			coderEvidence: makeEvidence(),
			reviewerMemo: makeHardMemo(true, false),
		});
		check(result.ok === false, "2: reviewer CHANGES_REQUESTED blocks full done");
		check(result.blockers.some((reason) => reason.toLowerCase().includes("reviewer")), "2: blocker mentions reviewer approval");
	}

	// 3) Prompt-only caveat blocks full done and suggests downgrade.
	{
		const promptOnlyPlan = makePlan({
			acceptanceEvidenceMatrix: [
				makeMatrixEntry({
					criterion: "runtime-check",
					criterionKind: "runtime-behavior",
					enforcementLevel: ["prompt-only", "manual-validation"],
					promptOnlyCaveat: "No reliable command exists in environment.",
					requiredEvidence: [{ kind: "manual-validation", description: "ops-approved workaround" }],
				}),
				makeMatrixEntry({
					criterion: "docs-check",
					criterionKind: "documentation",
					enforcementLevel: ["manual-validation"],
					requiredEvidence: [{ kind: "manual-validation", description: "docs reviewer signed off" }],
				}),
			],
		});
		const manualEvidence: CoderCompletionEvidence = {
			...makeEvidence(),
			criterionCoverage: [
				{
					criterion: "runtime-check",
					evidenceKind: "manual-validation",
					strength: "manual-caveat",
					supportingFiles: ["plans/mitigation.md"],
					supportingCommands: [],
					summary: "manual workaround accepted",
					caveats: "manual process used due prompt-only",
				},
				{
					criterion: "docs-check",
					evidenceKind: "manual-validation",
					strength: "manual-caveat",
					supportingFiles: ["docs/readme.md"],
					supportingCommands: [],
					summary: "manual docs validation",
					caveats: "manual check",
				},
			],
		};
		const fullDoneResult = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "done",
			target: { kind: "sprint-task", taskId: "TASK-005-3", planId: promptOnlyPlan.planId },
			plan: promptOnlyPlan,
			coderEvidence: manualEvidence,
			reviewerMemo: makeHardMemo(false, true),
		});
		check(fullDoneResult.ok === false, "3a: full done is blocked for prompt-only caveated work");
		check(fullDoneResult.blockers.some((reason) => reason.toLowerCase().includes("prompt-only") || reason.toLowerCase().includes("downgraded")), "3a: blocker explains prompt-only downgrade requirement");
		check(fullDoneResult.recommendedStatus === "prompt_only_mitigation", "3a: blocked full done recommends downgraded status");

		const downgradedPromptOnlyResult = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "prompt_only_mitigation",
			target: { kind: "sprint-task", taskId: "TASK-005-3b", planId: promptOnlyPlan.planId },
			plan: promptOnlyPlan,
			coderEvidence: manualEvidence,
			reviewerMemo: makeHardMemo(false, true),
		});
		check(downgradedPromptOnlyResult.ok === true, "3b: downgraded prompt-only status is allowed with explicit prompt-only evidence");
		check(downgradedPromptOnlyResult.recommendedStatus === "prompt_only_mitigation", "3b: recommendation remains prompt-only mitigation");
		check(downgradedPromptOnlyResult.warnings.some((warning) => warning.toLowerCase().includes("prompt-only") || warning.toLowerCase().includes("provisional")), "3b: downgraded result keeps prompt-only warning");

		const downgradedProvisionalResult = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "provisional_done",
			target: { kind: "sprint-task", taskId: "TASK-005-3c", planId: promptOnlyPlan.planId },
			plan: promptOnlyPlan,
			coderEvidence: manualEvidence,
			reviewerMemo: makeHardMemo(false, true),
		});
		check(downgradedProvisionalResult.ok === true, "3c: downgraded provisional status is allowed with explicit prompt-only evidence");
		check(downgradedProvisionalResult.recommendedStatus === "provisional_done", "3c: provisional request stays provisional in recommendation");
	}

	// 3d) Prompt-only wording in coder summary/caveat/knownGap blocks full done.
	{
		const plan = makePlan();
		const result = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "done",
			target: { kind: "sprint-task", taskId: "TASK-005-3d", planId: plan.planId },
			plan,
			coderEvidence: {
				...makeEvidence(),
				summary: "Docs-only mitigation guidance was used in place of code changes.",
				caveats: ["No direct behavior changes, instructions-only workaround applied."],
				knownGaps: ["Prompt-only fallback was retained as runtime-mitigation text."],
			},
			reviewerMemo: makeMemo(),
		});
		check(result.ok === false, "3d: full done is blocked by prompt-only wording in coder evidence text fields");
		check(
			result.blockers.some((reason) => reason.toLowerCase().includes("prompt-only") || reason.toLowerCase().includes("downgraded")),
			"3d: full done blocker mentions prompt-only handling",
		);
		check(result.recommendedStatus === "prompt_only_mitigation", "3d: textual prompt-only coder evidence recommends downgraded status");
	}

	// 3e) Prompt-only wording in reviewer finalRecommendation/markdown blocks full done even without structured caveats.
	{
		const plan = makePlan();
		const result = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "done",
			target: { kind: "sprint-task", taskId: "TASK-005-3e", planId: plan.planId },
			plan,
			coderEvidence: makeEvidence(),
			reviewerMemo: makeMemo({
				promptOnlyCaveats: [],
				finalRecommendation: "APPROVED",
				markdown: "# Memo\n\nRuntime behavior uses docs-only guidance and instructions-only runtime mitigation.",
			}),
		});
		check(result.ok === false, "3e: full done is blocked by reviewer prompt-only wording");
		check(
			result.blockers.some((reason) => reason.toLowerCase().includes("prompt-only") || reason.toLowerCase().includes("downgraded")),
			"3e: full done blocker is attributed to reviewer prompt-only wording",
		);
		check(result.recommendedStatus === "prompt_only_mitigation", "3e: textual reviewer prompt-only language recommends downgraded status");
	}

	// 4) Failed/retried delegate history must be disclosed in final note.
	{
		const plan = makePlan();
		const history = {
			...makeEvidence().delegateHistory,
			retries: 2,
			attempts: [
				{ attempt: 1, completionSource: "explicit" as const, status: "failed", finalOutputPreview: "failed attempt during first pass" },
				{ attempt: 2, completionSource: "explicit" as const, status: "completed", finalOutputPreview: "final explicit completion" },
			],
		};
		const resultNoDisclosure = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "done",
			target: { kind: "sprint-task", taskId: "TASK-005-4a", planId: plan.planId },
			plan,
			coderEvidence: { ...makeEvidence(), delegateHistory: history },
			reviewerMemo: makeMemo(),
		});
		check(resultNoDisclosure.ok === false, "4a: missing failed/retry disclosure blocks full done");
		check(resultNoDisclosure.blockers.some((reason) => reason.toLowerCase().includes("disclosure")), "4a: blocker references disclosure requirement");

		const resultWithDisclosure = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "done",
			target: { kind: "sprint-task", taskId: "TASK-005-4b", planId: plan.planId },
			plan,
			coderEvidence: { ...makeEvidence(), delegateHistory: history },
			finalNote: "Failed attempt occurred, followed by 2 retries before final explicit completion.",
			reviewerMemo: makeMemo(),
		});
		check(resultWithDisclosure.blockers.every((reason) => !reason.toLowerCase().includes("disclosure")), "4b: disclosure-aware final note removes disclosure blocker");
		check(resultWithDisclosure.ok === true, "4b: with disclosure and otherwise valid evidence, strict finalization is allowed");
	}

	// 5) Repeated debug hotfix/escalation emits promotion/root-cause warning.
	{
		const result = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "done",
			target: { kind: "debug-item", itemId: "DBG-005-A", area: "auth" },
			debugChain: { repeatedInAreaCount: 3, priorFailureCount: 1 },
			finalNote: "Reapplied quick fix in auth module.",
		});
		check(result.blockers.length === 0, "5: repeated debug hotfix chain stays non-blocking in Phase A");
		check(result.warnings.some((warning) => warning.toLowerCase().includes("repeated debug") || warning.toLowerCase().includes("promotion")), "5: repeated chain yields explicit warning");
		check(result.recommendedStatus === "provisional_done", "5: repeated debug chain recommends provisional status");
	}

	// 6) Dry-run reports would-block diagnostics while remaining non-blocking.
	{
		const plan = makePlan();
		const result = evaluateFinalizationGate({
			mode: "dry-run",
			requestedStatus: "done",
			target: { kind: "sprint-task", taskId: "TASK-005-6", planId: plan.planId },
			plan,
			coderEvidence: makeNoBehaviorEvidence(),
			reviewerMemo: makeMemo(),
		});
		check(result.ok === true, "6: dry-run remains non-blocking");
		check(result.allowed === true, "6: dry-run result remains allowed");
		check(result.blockers.length > 0, "6: dry-run carries blocker diagnostics");
		check(result.strictBlocking === true, "6: dry-run preserves strict-blocking signal");
		check(/dry-run would block/i.test(result.summary), "6: summary indicates dry-run would block");
	}

	// 6b) Dry-run remains non-blocking on missing plan diagnostics.
	{
		const result = evaluateFinalizationGate({
			mode: "dry-run",
			requestedStatus: "done",
			target: { kind: "sprint-task", taskId: "TASK-005-6b", planId: "missing-plan" },
		});
		check(result.ok === true, "6b: missing plan dry-run remains non-blocking");
		check(result.allowed === true, "6b: missing plan dry-run is allowed");
		check(result.strictBlocking === true, "6b: missing plan dry-run preserves strict-blocking");
		check(result.blockers.length > 0, "6b: missing plan dry-run returns blockers");
		check(result.recommendedStatus === "done", "6b: missing plan recommendation can remain done when no downgraded status requested");
	}

	// 6d) Runtime debug helper emits repeated-chain warning and provisional recommendation.
	{
		const debugResult = evaluateDebugFinalization({
			itemId: "DBG-005-1",
			requestedStatus: "done",
			mode: "strict",
			debugChain: { repeatedInAreaCount: 3, priorFailureCount: 2 },
		});
		check(debugResult.ok === true, "6d: debug repeated chain remains non-blocking");
		check(debugResult.warnings.some((warning) => warning.toLowerCase().includes("repeated")), "6d: debug warning mentions repeated work");
		check(debugResult.recommendedStatus === "provisional_done", "6d: repeated debug chain recommends provisional done");
	}

	// 7) Fully evidenced pass emits concise summary and allowed.
	{
		const plan = makePlan();
		const result = evaluateFinalizationGate({
			mode: "strict",
			requestedStatus: "Done",
			target: { kind: "sprint-task", taskId: "TASK-005-7", planId: plan.planId },
			plan,
			coderEvidence: makeEvidence(),
			reviewerMemo: makeMemo(),
			finalEvidence: "All acceptance criteria passed with full evidence and clean memo.",
		});
		check(result.ok === true, "7: fully evidenced strict finalization passes");
		check(result.recommendedStatus === "done", "7: strict full done recommendation is done");
		check(result.summary.toLowerCase().includes("checks passed"), "7: summary is concise pass message");
	}

	if (failures > 0) {
		console.error(`task-005 smokes failed: ${failures}`);
		process.exitCode = 1;
		return;
	}
	console.log("task-005 finalization gate smokes passed");
}

main();
