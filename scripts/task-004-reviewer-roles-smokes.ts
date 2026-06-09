#!/usr/bin/env node
// TASK-004 Phase A — role-based quality-review contract smoke checks.
// All cases use synthetic plan / matrix / reviewer-result-shaped objects; no
// real delegate launches or panes. The contract must:
//   1. derive required role targets from the matrix + default role policy,
//      with explicit Brain goals supplemental only;
//   2. add docs-config to the required role set when files / acceptance
//      criteria / matrix scope docs or config;
//   3. consolidate evaluations into a durable memo covering approvals,
//      changes requested, weak evidence, prompt-only caveats, unresolved
//      risks, provisional caveats, unknown/failed, and final recommendation;
//   4. downgrade / block behavior + evidence-test results that APPROVE with
//      source-string / static-only / read-the-source / skipped-running
//      evidence for TUI / runtime behavior;
//   5. downgrade / block behavior + evidence-test results that APPROVE a
//      prompt-only / instructions-only runtime mitigation;
//   6. block final approval when any required role blocks while another
//      approves;
//   7. mark auto_exit / process_exit / missing / legacy reviewer completion
//      as provisional (blocking required approval) unless explicit structured
//      reviewer evidence is present;
//   8. emit role task prompts that name criteria / required evidence /
//      blocking conditions / supplemental goals and never contain the
//      forbidden "code-only" framing.

import {
	buildReviewerMemoForResults,
	buildReviewerRoleTask,
	consolidateReviewerMemo,
	deriveReviewerRoleTargets,
	evaluateReviewerResult,
	isDocsConfigInScope,
	type ReviewerResultLike,
	type ReviewerRolePlanShape,
} from "../extensions/workflow/delegate/reviewer-roles";
import type {
	AcceptanceEvidenceMatrixEntry,
	ReviewerRole,
	WorkflowArchitecturePlan,
} from "../extensions/workflow/architecture/types";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function makeEntry(overrides: Partial<AcceptanceEvidenceMatrixEntry>): AcceptanceEvidenceMatrixEntry {
	return {
		criterion: "c1",
		criterionKind: "runtime-behavior",
		businessRiskIfWrong: "service unavailable",
		enforcementLevel: ["behavior-test"],
		requiredEvidence: [{ kind: "behavior-test", description: "covered by behavior test" }],
		reviewerRoles: ["behavior"],
		blockingConditions: ["behavior test fails"],
		...overrides,
	};
}

function makeFullMatrix(): AcceptanceEvidenceMatrixEntry[] {
	return [
		makeEntry({
			criterion: "Behavior reviewer validates TUI behavior",
			criterionKind: "runtime-behavior",
			businessRiskIfWrong: "TUI behavior may regress",
			enforcementLevel: ["behavior-test"],
			requiredEvidence: [
				{ kind: "behavior-test", description: "TUI behavior test", command: "npx tsx scripts/smoke-tui.ts" },
			],
			reviewerRoles: ["behavior"],
			blockingConditions: ["TUI behavior test fails"],
		}),
		makeEntry({
			criterion: "Evidence/test adequacy reviewer validates behavior evidence",
			criterionKind: "test-infrastructure",
			businessRiskIfWrong: "Insufficient evidence may pass",
			enforcementLevel: ["behavior-test"],
			requiredEvidence: [
				{ kind: "behavior-test", description: "behavior test evidence" },
			],
			reviewerRoles: ["evidence-test"],
			blockingConditions: ["evidence is static-only or source-string for runtime behavior"],
		}),
		makeEntry({
			criterion: "Implementation reviewer validates diff and contract",
			criterionKind: "test-infrastructure",
			businessRiskIfWrong: "Implementation may be incorrect",
			enforcementLevel: ["runtime-gate"],
			requiredEvidence: [
				{ kind: "diff", description: "implementation diff" },
			],
			reviewerRoles: ["implementation"],
			blockingConditions: ["diff breaks contract"],
		}),
		makeEntry({
			criterion: "Maintainability reviewer validates architecture and patterns",
			criterionKind: "test-infrastructure",
			businessRiskIfWrong: "Code may not be maintainable",
			enforcementLevel: ["manual-validation"],
			requiredEvidence: [
				{ kind: "artifact", description: "architecture notes" },
			],
			reviewerRoles: ["maintainability"],
			blockingConditions: ["architecture is not maintainable"],
		}),
		makeEntry({
			criterion: "Regression reviewer validates regression-proof",
			criterionKind: "test-infrastructure",
			businessRiskIfWrong: "May regress",
			enforcementLevel: ["regression-proof"],
			requiredEvidence: [
				{ kind: "regression-test", description: "regression test" },
			],
			reviewerRoles: ["regression"],
			blockingConditions: ["regression test fails"],
		}),
	];
}

function makeMatrixPlan(overrides: Partial<WorkflowArchitecturePlan> = {}): WorkflowArchitecturePlan {
	return {
		planId: "task-004-reviewer-role-quality",
		taskId: "TASK-004",
		title: "Redesign reviewer swarm into role-based quality review",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "ready",
		businessPlan: "Redesign reviewer review into fail-closed role-based quality review.",
		technicalPlan: "Phase A isolated helpers; Phase B wires swarm/tools.",
		parallelAssessment: "serial",
		contractBlockPlan: "Fail-closed role approval + durable memo.",
		acceptanceCriteria: [
			"Reviewer goals are derived from the acceptance/evidence matrix.",
			"Default role set exists for non-trivial work.",
			"Reviewer output is consolidated into a durable memo.",
			"Source-string tests for TUI behavior are rejected by behavior/evidence reviewer.",
			"Prompt-only fix for runtime behavior is rejected or downgraded.",
			"One reviewer approving while another blocks prevents final approval.",
			"auto_exit reviewer completion is provisional unless required evidence is explicit.",
		],
		acceptanceEvidenceMatrix: makeFullMatrix(),
		files: [
			"extensions/workflow/delegate/reviewer-roles.ts",
			"extensions/workflow/delegate/swarm.ts",
			"extensions/workflow/delegate/tools.ts",
			"extensions/workflow/types.ts",
			"extensions/workflow/prompts.ts",
			"scripts/task-004-reviewer-roles-smokes.ts",
		],
		phases: {
			phaseA: { status: "not_started", updatedAt: new Date().toISOString(), evidence: [] },
			phaseB: { status: "not_started", updatedAt: new Date().toISOString(), evidence: [] },
		},
		...overrides,
	};
}

function makeApprovedResult(role: ReviewerRole, output: string): ReviewerResultLike {
	return {
		verdict: "APPROVED",
		finalOutput: `APPROVED. ${output}`,
		completionSource: "explicit",
		status: "completed",
	};
}

function main(): void {
	// (1) Derivation: matrix + default role policy drive required targets;
	//     explicit narrow goals remain supplemental only and never replace
	//     the matrix-derived behavior/evidence/implementation/maintainability/regression roles.
	{
		const plan = makeMatrixPlan();
		const narrowGoals = [
			"narrow code goal: only review extensions/workflow/delegate/reviewer-roles.ts",
			"tightly scoped: only behavior-test diff for one file",
		];
		const derivation = deriveReviewerRoleTargets(plan, { goals: narrowGoals });
		const requiredRoles = new Set(derivation.rolesRequired);
		check(requiredRoles.has("behavior"), "1: behavior role required for matrix-gated plan");
		check(requiredRoles.has("evidence-test"), "1: evidence-test role required for matrix-gated plan");
		check(requiredRoles.has("implementation"), "1: implementation role required for matrix-gated plan");
		check(requiredRoles.has("maintainability"), "1: maintainability role required for matrix-gated plan");
		check(requiredRoles.has("regression"), "1: regression role required for matrix-gated plan");
		// Narrow goals must NOT replace required roles: each required role has
		// matrix criteria attached and the explicit goals are surfaced as
		// supplemental only.
		for (const target of derivation.targets) {
			check(target.supplementalGoals.length >= 1, `1: target ${target.role} carries supplemental goals (got: ${target.supplementalGoals.length})`);
			check(target.criteria.length >= 1, `1: target ${target.role} carries matrix criteria (got: ${target.criteria.length})`);
		}
		check(derivation.supplementalGoals.length === narrowGoals.length,
			`1: derivation preserves all supplemental goals (got: ${derivation.supplementalGoals.length}, expected ${narrowGoals.length})`);
		// Matrix row count for each required role matches the matrix input.
		const behavior = derivation.targets.find((t) => t.role === "behavior");
		check(behavior?.matrixEntryIndices.length === 1, `1: behavior role linked to 1 matrix entry (got: ${behavior?.matrixEntryIndices.length})`);
		const implementation = derivation.targets.find((t) => t.role === "implementation");
		check(implementation?.matrixEntryIndices.length === 1, `1: implementation role linked to 1 matrix entry (got: ${implementation?.matrixEntryIndices.length})`);
	}

	// (1b) When no matrix and no defaultRequiredRoles override is supplied,
	//      the helper is matrix-only and must NOT silently invent roles.
	{
		const noMatrix: ReviewerRolePlanShape = { planId: "no-matrix", status: "draft" };
		const derivation = deriveReviewerRoleTargets(noMatrix);
		check(derivation.targets.length === 0, "1b: no-matrix plan derives no required roles by default");
		// usedDefaults indicates that the default policy is the source in play;
		// usedMatrix is the more meaningful signal that the matrix was used.
		check(derivation.usedMatrix === false, "1b: usedMatrix false when no matrix");
		// Defaults are recorded in skippedRoles so callers can see why they were
		// not applied.
		check(derivation.skippedRoles.length === 5,
			`1b: all 5 default roles recorded as skipped when matrix is empty (got: ${derivation.skippedRoles.length})`);
	}

	// (2) Default docs-config role: included when files / acceptance criteria
	//     / matrix scope docs or config; absent otherwise.
	{
		// 2a: README.md in files => docs-config is in scope.
		const planWithReadme = makeMatrixPlan({ files: ["README.md", "docs/workflow-config-v2.md"] });
		const derivation = deriveReviewerRoleTargets(planWithReadme);
		check(derivation.docsConfigInScope === true, "2a: docsConfigInScope true when README.md in files");
		check(derivation.rolesRequired.includes("docs-config"), "2a: docs-config role required when docs files are scoped");
		// 2b: matrix row with criterionKind=documentation adds docs-config.
		const planWithDocMatrix = makeMatrixPlan({
			files: ["src/foo.ts"],
			acceptanceCriteria: ["a non-doc criterion"],
			acceptanceEvidenceMatrix: [
				...makeFullMatrix(),
				makeEntry({
					criterion: "Documentation criterion in matrix",
					criterionKind: "documentation",
					businessRiskIfWrong: "operators lack docs",
					enforcementLevel: ["manual-validation"],
					requiredEvidence: [{ kind: "manual-validation", description: "docs reviewer approval" }],
					reviewerRoles: ["docs-config"],
					blockingConditions: ["docs reviewer not signed off"],
				}),
			],
		});
		const derivationMatrixDoc = deriveReviewerRoleTargets(planWithDocMatrix);
		check(derivationMatrixDoc.docsConfigInScope === true, "2b: docsConfigInScope true when matrix row has criterionKind=documentation");
		check(derivationMatrixDoc.rolesRequired.includes("docs-config"), "2b: docs-config role required when matrix row scopes it");
		// 2c: pure-runtime plan must NOT include docs-config.
		const planRuntimeOnly = makeMatrixPlan({
			files: ["src/foo.ts"],
			acceptanceCriteria: ["a runtime-only criterion"],
		});
		const derivationRuntime = deriveReviewerRoleTargets(planRuntimeOnly);
		check(derivationRuntime.docsConfigInScope === false, "2c: docsConfigInScope false for runtime-only files/criteria");
		check(!derivationRuntime.rolesRequired.includes("docs-config"), "2c: docs-config role not required for runtime-only plan");
		// 2d: isDocsConfigInScope direct helper.
		const scopeFilesOnly = isDocsConfigInScope({ files: ["docs/notes.md"] });
		check(scopeFilesOnly.inScope === true, "2d: isDocsConfigInScope detects docs/ file path");
		const scopeAcceptanceOnly = isDocsConfigInScope({ acceptanceCriteria: ["review the documentation text"] });
		check(scopeAcceptanceOnly.inScope === true, "2d: isDocsConfigInScope detects 'documentation' in acceptance criteria");
		const scopeNone = isDocsConfigInScope({ files: ["src/impl.ts"], acceptanceCriteria: ["some runtime criterion"] });
		check(scopeNone.inScope === false, "2d: isDocsConfigInScope false for non-docs input");
	}

	// (3) Memo consolidator: markdown includes approvals, changes requested,
	//     weak evidence, prompt-only caveats, unresolved risks, provisional
	//     caveats, unknown/failed, and a final recommendation. The boolean
	//     `approved` flag must reflect the evaluations.
	{
		const plan = makeMatrixPlan();
		// Build one evaluation per required role so the memo has shape variety.
		const derivation = deriveReviewerRoleTargets(plan);
		const evaluations = derivation.targets.map((t, i) => {
			if (t.role === "behavior") {
				return {
					role: t.role,
					target: t.target,
					required: true,
					verdict: "APPROVED" as const,
					effectiveVerdict: "APPROVED" as const,
					provisional: false,
					blockingReasons: [] as string[],
					weakEvidence: ["partial coverage observed"] as string[],
					promptOnlyCaveats: [] as string[],
					unresolvedRisks: ["need more evidence"] as string[],
					supplementalGoals: t.supplementalGoals.slice(),
					notes: [] as string[],
				};
			}
			if (t.role === "regression") {
				return {
					role: t.role,
					target: t.target,
					required: true,
					verdict: "APPROVED" as const,
					effectiveVerdict: "APPROVED" as const,
					provisional: true,
					blockingReasons: [] as string[],
					weakEvidence: [] as string[],
					promptOnlyCaveats: [] as string[],
					unresolvedRisks: [] as string[],
					supplementalGoals: t.supplementalGoals.slice(),
					notes: ["auto_exit without structured evidence"] as string[],
				};
			}
			return {
				role: t.role,
				target: t.target,
				required: true,
				verdict: "APPROVED" as const,
				effectiveVerdict: "APPROVED" as const,
				provisional: false,
				blockingReasons: [] as string[],
				weakEvidence: [] as string[],
				promptOnlyCaveats: [] as string[],
				unresolvedRisks: [] as string[],
				supplementalGoals: t.supplementalGoals.slice(),
				notes: [] as string[],
			};
		});
		const memo = consolidateReviewerMemo({
			planId: plan.planId,
			phase: "phaseA",
			evaluations,
			supplementalGoals: derivation.supplementalGoals,
			docsConfigInScope: derivation.docsConfigInScope,
			rolesRequired: derivation.rolesRequired,
		});
		check(memo.markdown.includes("## Approvals"), "3: memo markdown has Approvals section");
		check(memo.markdown.includes("## Changes requested / blocked"), "3: memo markdown has Changes requested / blocked section");
		check(memo.markdown.includes("## Unknown / failed"), "3: memo markdown has Unknown / failed section");
		check(memo.markdown.includes("## Weak evidence"), "3: memo markdown has Weak evidence section");
		check(memo.markdown.includes("## Prompt-only caveats"), "3: memo markdown has Prompt-only caveats section");
		check(memo.markdown.includes("## Unresolved risks"), "3: memo markdown has Unresolved risks section");
		check(memo.markdown.includes("## Provisional caveats"), "3: memo markdown has Provisional caveats section");
		check(memo.markdown.includes("## Final recommendation"), "3: memo markdown has Final recommendation section");
		check(memo.approvals.length >= 4, `3: memo buckets behavior + others as approvals (got: ${memo.approvals.length})`);
		check(memo.provisionalCaveats.length === 1, `3: memo buckets regression (provisional) separately (got: ${memo.provisionalCaveats.length})`);
		check(memo.weakEvidence.length === 1, `3: memo buckets behavior weak-evidence entry (got: ${memo.weakEvidence.length})`);
		check(memo.unresolvedRisks.length === 1, `3: memo buckets behavior unresolved-risk entry (got: ${memo.unresolvedRisks.length})`);
		check(memo.approved === false, "3: memo approved=false because one required role is provisional");
		check(memo.finalRecommendation.toLowerCase().includes("blocked"),
			`3: final recommendation names the block (got: ${memo.finalRecommendation})`);
	}

	// (4) Source-string / static-only / read-the-source / skipped-running
	//     evidence for TUI/runtime behavior downgrades an APPROVED
	//     behavior or evidence-test result to CHANGES_REQUESTED.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		const evidenceTarget = derivation.targets.find((t) => t.role === "evidence-test");
		check(Boolean(behaviorTarget && evidenceTarget), "4: behavior + evidence-test targets present");

		const staticOnlyOutputs = [
			"Verified the TUI behavior by reading the source; the render path is correct.",
			"The TUI flow is fine per static analysis shows the helper covers the case.",
			"skipped running the smoke, covered by static check is sufficient.",
		];
		for (const output of staticOnlyOutputs) {
			const behaviorResult = makeApprovedResult("behavior", output);
			const behaviorEval = evaluateReviewerResult(behaviorTarget!, behaviorResult);
			check(behaviorEval.effectiveVerdict === "CHANGES_REQUESTED",
				`4: behavior static-only output downgraded (output: "${output.slice(0, 40)}...")`);
			check(behaviorEval.blockingReasons.length > 0,
				"4: behavior blockingReasons mention static-only / runtime-evidence gap");
			check(behaviorEval.weakEvidence.length > 0, "4: behavior evaluation surfaces weak evidence entry");

			const evidenceResult = makeApprovedResult("evidence-test", output);
			const evidenceEval = evaluateReviewerResult(evidenceTarget!, evidenceResult);
			check(evidenceEval.effectiveVerdict === "CHANGES_REQUESTED",
				`4: evidence-test static-only output downgraded (output: "${output.slice(0, 40)}...")`);
		}
	}

	// (4b) Code-walk / source-inspection only (no static-only phrase) is still
	//      downgraded for behavior / evidence-test on runtime scope. Reviewer
	//      preferred fail-closed: an APPROVED runtime-behavior result must
	//      cite a runnable behavior test, runtime gate, observed tool output,
	//      or explicit structured reviewer evidence.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		const evidenceTarget = derivation.targets.find((t) => t.role === "evidence-test");
		const baselineOutput = "The new TUI render path matches the spec; I walked the code and confirmed the tool result appears in the right pane.";
		const behaviorEval = evaluateReviewerResult(behaviorTarget!, makeApprovedResult("behavior", baselineOutput));
		check(behaviorEval.effectiveVerdict === "CHANGES_REQUESTED",
			"4b: behavior code-walk-only output is downgraded (fail-closed)");
		check(behaviorEval.blockingReasons.length > 0,
			`4b: behavior code-walk baseline has blocking reasons (got: ${behaviorEval.blockingReasons.join("; ")})`);
		const evidenceEval = evaluateReviewerResult(evidenceTarget!, makeApprovedResult("evidence-test", baselineOutput));
		check(evidenceEval.effectiveVerdict === "CHANGES_REQUESTED",
			"4b: evidence-test code-walk-only output is downgraded (fail-closed)");
	}

	// (4c) Positive baseline: a behavior / evidence-test APPROVED result that
	//      cites acceptable runtime evidence (runnable behavior test, runtime
	//      gate, observed tool output) is NOT downgraded.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		const evidenceTarget = derivation.targets.find((t) => t.role === "evidence-test");
		const positiveOutput = "APPROVED. behavior test passed: tsx scripts/smoke-tui.ts exited 0; runtime gate passed: tool result observed in pane.";
		const behaviorEval = evaluateReviewerResult(behaviorTarget!, makeApprovedResult("behavior", positiveOutput));
		check(behaviorEval.effectiveVerdict === "APPROVED",
			"4c: behavior approval citing runtime evidence is NOT downgraded");
		check(behaviorEval.blockingReasons.length === 0,
			`4c: behavior positive baseline has no blocking reasons (got: ${behaviorEval.blockingReasons.join("; ")})`);
		const evidenceEval = evaluateReviewerResult(evidenceTarget!, makeApprovedResult("evidence-test", positiveOutput));
		check(evidenceEval.effectiveVerdict === "APPROVED",
			"4c: evidence-test approval citing runtime evidence is NOT downgraded");

		// Acceptable: explicit structured reviewer evidence with content also
		// suppresses the fail-closed downgrade even when the output omits
		// a positive runtime phrase.
		const structuredResult = makeApprovedResult("behavior", "APPROVED. The render path is correct.");
		structuredResult.reviewerEvidence = {
			criterionCoverage: [{ criterion: "TUI behavior", evidenceKind: "behavior-test", summary: "behavior test passed" }],
		};
		const structuredEval = evaluateReviewerResult(behaviorTarget!, structuredResult);
		check(structuredEval.effectiveVerdict === "APPROVED",
			"4c: behavior approval with non-empty reviewerEvidence is NOT downgraded");
	}

	// (5) Prompt-only / instructions-only runtime mitigation: an APPROVED
	//     behavior or evidence-test result that relies on prompt-only
	//     phrasing for runtime behavior is downgraded / blocked.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		const evidenceTarget = derivation.targets.find((t) => t.role === "evidence-test");
		const promptOnlyOutputs = [
			"the prompt-only fix for the runtime issue is sufficient.",
			"added to the prompt; users will get clearer behavior.",
			"updated the system prompt so the tool returns the expected output.",
			"no code change is required; documentation only mitigation suffices.",
		];
		for (const output of promptOnlyOutputs) {
			const behaviorResult = makeApprovedResult("behavior", output);
			const behaviorEval = evaluateReviewerResult(behaviorTarget!, behaviorResult);
			check(behaviorEval.effectiveVerdict === "CHANGES_REQUESTED",
				`5: behavior prompt-only output downgraded (output: "${output.slice(0, 40)}...")`);
			check(behaviorEval.promptOnlyCaveats.length > 0,
				`5: behavior evaluation surfaces prompt-only caveat (output: "${output.slice(0, 40)}...")`);
			check(behaviorEval.blockingReasons.some((r) => r.toLowerCase().includes("prompt-only")),
				"5: behavior blockingReasons mention prompt-only");
			const evidenceEval = evaluateReviewerResult(evidenceTarget!, makeApprovedResult("evidence-test", output));
			check(evidenceEval.effectiveVerdict === "CHANGES_REQUESTED",
				`5: evidence-test prompt-only output downgraded (output: "${output.slice(0, 40)}...")`);
		}
	}

	// (6) Mixed role verdicts: one required role APPROVED + one required role
	//     CHANGES_REQUESTED => final approval is false and the memo lists
	//     the blocker.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const results: ReviewerResultLike[] = derivation.targets.map((t) => {
			if (t.role === "implementation") {
				return {
					verdict: "CHANGES_REQUESTED",
					finalOutput: "CHANGES_REQUESTED. Diff breaks the helper contract; please rework.",
					completionSource: "explicit",
					status: "completed",
				} satisfies ReviewerResultLike;
			}
			// Other roles approve with valid explicit evidence so they are
			// not provisional.
			return {
				verdict: "APPROVED",
				finalOutput: "APPROVED. The criterion is satisfied; diff matches the spec.",
				completionSource: "explicit",
				status: "completed",
				reviewerEvidence: {
					present: true,
					criterionCoverage: [{ criterion: t.criteria[0] ?? "criterion", evidenceKind: "diff", summary: "diff review" }],
				},
			} satisfies ReviewerResultLike;
		});
		const { memo, evaluations } = buildReviewerMemoForResults(plan, "phaseA", results);
		const approvedCount = evaluations.filter((e) => e.effectiveVerdict === "APPROVED" && !e.provisional).length;
		const blockedCount = evaluations.filter((e) => e.effectiveVerdict === "CHANGES_REQUESTED").length;
		check(approvedCount >= 1, `6: at least one required role approved (got: ${approvedCount})`);
		check(blockedCount >= 1, `6: at least one required role blocked (got: ${blockedCount})`);
		check(memo.approved === false, "6: memo approved=false with mixed verdicts");
		check(memo.changesRequested.some((e) => e.role === "implementation"),
			"6: changesRequested bucket lists implementation role");
		check(memo.finalRecommendation.toLowerCase().includes("blocked"),
			`6: final recommendation names the block (got: ${memo.finalRecommendation})`);
	}

	// (7) auto_exit reviewer completion without structured reviewer evidence
	//     is provisional and blocks required approval. Adding explicit
	//     structured reviewer evidence suppresses the provisional flag.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		const behaviorResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. The behavior looks correct.",
			completionSource: "auto_exit",
			status: "completed",
		};
		const autoExitEval = evaluateReviewerResult(behaviorTarget!, behaviorResult);
		check(autoExitEval.provisional === true,
			"7: auto_exit without structured evidence is provisional");
		check(autoExitEval.effectiveVerdict === "CHANGES_REQUESTED",
			"7: provisional required role is downgraded to CHANGES_REQUESTED");
		check(autoExitEval.blockingReasons.some((r) => r.toLowerCase().includes("provisional")),
			"7: blocking reasons mention provisional completion source");

		// With explicit structured reviewer evidence, the provisional flag is suppressed.
		const explicitEvidenceResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. evidence packet: criterion coverage rows attached.",
			completionSource: "auto_exit",
			status: "completed",
			reviewerEvidence: {
				present: true,
				explicitDeclaration: true,
				criterionCoverage: [{ criterion: "TUI behavior", evidenceKind: "behavior-test", summary: "TUI behavior test passed" }],
			},
		};
		const explicitEval = evaluateReviewerResult(behaviorTarget!, explicitEvidenceResult);
		check(explicitEval.provisional === false,
			"7: auto_exit with explicit structured evidence suppresses provisional flag");
		check(explicitEval.effectiveVerdict === "APPROVED",
			"7: auto_exit + explicit evidence does not block the required role");

		// process_exit + missing + legacy also count as provisional sources.
		for (const source of ["process_exit", "missing", "legacy"] as const) {
			const r: ReviewerResultLike = {
				verdict: "APPROVED",
				finalOutput: "APPROVED. Looks good.",
				completionSource: source,
				status: "completed",
			};
			const ev = evaluateReviewerResult(behaviorTarget!, r);
			check(ev.provisional === true, `7: completion source ${source} is provisional`);
		}

		// end-to-end: full plan with one auto_exit result blocks final approval.
		const allResults: ReviewerResultLike[] = derivation.targets.map((t, i) => {
			if (i === 0) {
				return {
					verdict: "APPROVED",
					finalOutput: "APPROVED. Looks good.",
					completionSource: "auto_exit",
					status: "completed",
				};
			}
			return {
				verdict: "APPROVED",
				finalOutput: "APPROVED. Diff matches the spec.",
				completionSource: "explicit",
				status: "completed",
				reviewerEvidence: { present: true, explicitDeclaration: true },
			};
		});
		const { memo } = buildReviewerMemoForResults(plan, "phaseA", allResults);
		check(memo.approved === false, "7: end-to-end memo approved=false when one role is auto_exit provisional");
		check(memo.provisionalCaveats.length === 1, `7: end-to-end memo provisionalCaveats length === 1 (got: ${memo.provisionalCaveats.length})`);
	}

	// (8) Role task prompt: contains role criteria, required evidence section,
	//     blocking conditions, supplemental goals, and never contains the
	//     forbidden "code-only" framing.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan, { goals: ["supplemental goal: validate architecture notes"] });
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		check(Boolean(behaviorTarget), "8: behavior target present");
		const prompt = buildReviewerRoleTask("Base delegated task: validate the implementation.", behaviorTarget!);
		check(!prompt.includes("code-only"),
			"8: role task prompt does not contain 'code-only'");
		check(prompt.includes("## Role criteria"),
			"8: role task prompt contains '## Role criteria' section header");
		check(prompt.includes("## Required evidence for this role"),
			"8: role task prompt contains '## Required evidence for this role' section header");
		check(prompt.includes("## Blocking conditions"),
			"8: role task prompt contains '## Blocking conditions' section header");
		check(prompt.includes("## Supplemental goals"),
			"8: role task prompt contains '## Supplemental goals' section header");
		// Content from the role target must be present.
		const behaviorCriterion = "Behavior reviewer validates TUI behavior";
		check(prompt.includes(behaviorCriterion),
			"8: role task prompt embeds the behavior matrix criterion text");
		const behaviorEvidence = "TUI behavior test";
		check(prompt.includes(behaviorEvidence),
			"8: role task prompt embeds required-evidence description");
		const supplementalGoal = "supplemental goal: validate architecture notes";
		check(prompt.includes(supplementalGoal),
			"8: role task prompt embeds the supplemental goal text");
		// Hard role rules must surface source-string and prompt-only rejection rules.
		check(prompt.includes("source-string") || prompt.includes("read-the-source") || prompt.includes("read the source") || prompt.includes("reading the source"),
			"8: behavior role task prompt surfaces source-string/read-the-source rejection rule");
		check(prompt.toLowerCase().includes("prompt-only"),
			"8: behavior role task prompt surfaces prompt-only rejection rule");
		// Response contract forces APPROVED/CHANGES_REQUESTED prefix.
		check(prompt.includes("APPROVED") && prompt.includes("CHANGES_REQUESTED"),
			"8: role task prompt requires APPROVED/CHANGES_REQUESTED response prefix");
	}

	// (9) Missing required role: consolidateReviewerMemo with
	//     `rolesRequired: ["behavior"]` and `evaluations: []` must NOT
	//     approve; the memo markdown + finalRecommendation must mention the
	//     missing required role.
	{
		const memo = consolidateReviewerMemo({ rolesRequired: ["behavior"], evaluations: [] });
		check(memo.approved === false, "9: empty evaluations with required role blocks approval");
		check(memo.missingRequiredRoles.length === 1 && memo.missingRequiredRoles[0] === "behavior",
			`9: missingRequiredRoles reports 'behavior' (got: ${memo.missingRequiredRoles.join(", ")})`);
		check(memo.markdown.includes("MISSING REQUIRED ROLES"),
			"9: memo markdown surfaces 'MISSING REQUIRED ROLES'");
		check(memo.markdown.includes("behavior"),
			"9: memo markdown names the missing 'behavior' role");
		check(memo.finalRecommendation.toLowerCase().includes("missing"),
			`9: final recommendation mentions missing (got: ${memo.finalRecommendation})`);
		check(memo.finalRecommendation.toLowerCase().includes("behavior"),
			`9: final recommendation names the missing role (got: ${memo.finalRecommendation})`);
	}

	// (9b) Multi-role missing gap: when 2 of 3 required roles have no
	//      evaluations, the memo must list both missing roles and block.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		// Build full evaluations, then drop most to simulate missing.
		const allResults: ReviewerResultLike[] = derivation.targets.map(() => ({
			verdict: "APPROVED",
			finalOutput: "APPROVED. Diff matches the spec.",
			completionSource: "explicit",
			status: "completed",
			reviewerEvidence: { present: true, explicitDeclaration: true },
		}));
		const allEvaluations = derivation.targets.map((t, i) => evaluateReviewerResult(t, allResults[i]));
		const kept = allEvaluations.filter((_, i) => i === 0);
		const memo = consolidateReviewerMemo({
			planId: plan.planId,
			phase: "phaseA",
			evaluations: kept,
			supplementalGoals: derivation.supplementalGoals,
			docsConfigInScope: derivation.docsConfigInScope,
			rolesRequired: derivation.rolesRequired,
		});
		check(memo.approved === false, "9b: memo approved=false when most required roles missing");
		check(memo.missingRequiredRoles.length >= 4,
			`9b: missingRequiredRoles reports the missing roles (got: ${memo.missingRequiredRoles.length})`);
		check(memo.markdown.includes("MISSING REQUIRED ROLES"),
			"9b: memo markdown surfaces 'MISSING REQUIRED ROLES' for multi-missing");
	}

	// (10) Partial matrix default-role fallback: when the matrix only lists
	//      a single role (e.g. behavior), default role policy must still
	//      add evidence-test, implementation, maintainability, and regression
	//      as required roles for the non-trivial matrix-gated plan.
	{
		const partialMatrixPlan: ReviewerRolePlanShape = {
			planId: "partial-matrix",
			status: "ready",
			acceptanceEvidenceMatrix: [
				makeEntry({ criterion: "Behavior criterion only", reviewerRoles: ["behavior"] }),
			],
		};
		const derivation = deriveReviewerRoleTargets(partialMatrixPlan);
		const required = new Set(derivation.rolesRequired);
		check(required.has("behavior"),
			"10: behavior required when matrix has only behavior entry");
		check(required.has("evidence-test"),
			"10: evidence-test defaulted in for partial matrix");
		check(required.has("implementation"),
			"10: implementation defaulted in for partial matrix");
		check(required.has("maintainability"),
			"10: maintainability defaulted in for partial matrix");
		check(required.has("regression"),
			"10: regression defaulted in for partial matrix");
		check(!required.has("docs-config"),
			"10: docs-config not defaulted in for partial matrix without docs scope");
	}

	// (11) Structured reviewer evidence: empty `details.reviewerEvidence = {}`
	//      and a bare label must NOT suppress auto_exit provisional blocking;
	//      non-empty coverage / command outcomes DO suppress it.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		check(Boolean(behaviorTarget), "11: behavior target present for structured evidence check");

		// 11a: empty `details.reviewerEvidence = {}` does NOT suppress.
		const emptyDetailsResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. Looks good.",
			completionSource: "auto_exit",
			status: "completed",
			details: { reviewerEvidence: {} },
		};
		const emptyDetailsEval = evaluateReviewerResult(behaviorTarget!, emptyDetailsResult);
		check(emptyDetailsEval.provisional === true,
			"11a: empty details.reviewerEvidence does NOT suppress auto_exit provisional");
		check(emptyDetailsEval.effectiveVerdict === "CHANGES_REQUESTED",
			"11a: empty details.reviewerEvidence still blocks required role");

		// 11b: bare `reviewerEvidence: { present: true }` does NOT suppress.
		const bareFlagResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. Looks good.",
			completionSource: "auto_exit",
			status: "completed",
			reviewerEvidence: { present: true },
		};
		const bareFlagEval = evaluateReviewerResult(behaviorTarget!, bareFlagResult);
		check(bareFlagEval.provisional === true,
			"11b: bare reviewerEvidence.present=true does NOT suppress auto_exit provisional");
		check(bareFlagEval.effectiveVerdict === "CHANGES_REQUESTED",
			"11b: bare flag still blocks required role");

		// 11c: bare label "evidence packet:" with no content does NOT suppress.
		const bareLabelResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. evidence packet:",
			completionSource: "auto_exit",
			status: "completed",
		};
		const bareLabelEval = evaluateReviewerResult(behaviorTarget!, bareLabelResult);
		check(bareLabelEval.provisional === true,
			"11c: bare 'evidence packet:' label does NOT suppress auto_exit provisional");

		// 11d: empty criterionCoverage array does NOT suppress.
		const emptyCoverageResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. Looks good.",
			completionSource: "auto_exit",
			status: "completed",
			reviewerEvidence: { criterionCoverage: [] },
		};
		const emptyCoverageEval = evaluateReviewerResult(behaviorTarget!, emptyCoverageResult);
		check(emptyCoverageEval.provisional === true,
			"11d: empty criterionCoverage array does NOT suppress auto_exit provisional");

		// 11e: non-empty criterion coverage DOES suppress.
		const contentResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. Looks good.",
			completionSource: "auto_exit",
			status: "completed",
			reviewerEvidence: { criterionCoverage: [{ criterion: "TUI behavior" }] },
		};
		const contentEval = evaluateReviewerResult(behaviorTarget!, contentResult);
		check(contentEval.provisional === false,
			"11e: non-empty criterionCoverage DOES suppress auto_exit provisional");
		check(contentEval.effectiveVerdict === "APPROVED",
			"11e: non-empty criterion coverage keeps required role approved");

		// 11f: non-empty commands run DOES suppress.
		const commandsResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. Looks good.",
			completionSource: "auto_exit",
			status: "completed",
			reviewerEvidence: { commandsRun: [{ command: "npx tsx scripts/smoke-tui.ts", outcome: "exit 0" }] },
		};
		const commandsEval = evaluateReviewerResult(behaviorTarget!, commandsResult);
		check(commandsEval.provisional === false,
			"11f: non-empty commandsRun DOES suppress auto_exit provisional");

		// 11g: explicitDeclaration paired with non-empty coverage DOES suppress.
		const declaredResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. Looks good.",
			completionSource: "auto_exit",
			status: "completed",
			reviewerEvidence: {
				explicitDeclaration: true,
				criterionCoverage: [{ criterion: "TUI behavior", summary: "behavior test passed" }],
			},
		};
		const declaredEval = evaluateReviewerResult(behaviorTarget!, declaredResult);
		check(declaredEval.provisional === false,
			"11g: explicitDeclaration + non-empty coverage DOES suppress auto_exit provisional");
	}

	// (12) Source-string / static-only / read-the-source / skipped-running /
	//      no-runtime-run evidence OVERRIDES broad positive runtime phrases.
	//      An APPROVED behavior or evidence-test result that mixes
	//      "test passed" with "no runtime run" is still downgraded to
	//      CHANGES_REQUESTED, unless explicit structured reviewer evidence
	//      is supplied on the typed object.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		const evidenceTarget = derivation.targets.find((t) => t.role === "evidence-test");
		check(Boolean(behaviorTarget && evidenceTarget), "12: behavior + evidence-test targets present");

		const overrideOutputs: string[] = [
			"source-string test passed by checking the source string for TUI output; no runtime run.",
			"APPROVED. source-string test passed by reading the source; no runtime run was performed.",
			"Test passed. I read the source and confirmed the render path is correct. No runtime run.",
			"Test passed. covered by static; skipped running the smoke; no runtime run needed.",
		];
		for (const output of overrideOutputs) {
			const behaviorResult = makeApprovedResult("behavior", output);
			const behaviorEval = evaluateReviewerResult(behaviorTarget!, behaviorResult);
			check(behaviorEval.effectiveVerdict === "CHANGES_REQUESTED",
				`12: behavior source-string + positive phrase output downgraded (output: "${output.slice(0, 50)}...")`);
			check(behaviorEval.blockingReasons.some((r) => /source-string|static-only|read-the-source|skipped-running|no-runtime-run/i.test(r)),
				`12: behavior blockingReasons mention static-only / no-runtime-run override (output: "${output.slice(0, 50)}...")`);
			const evidenceResult = makeApprovedResult("evidence-test", output);
			const evidenceEval = evaluateReviewerResult(evidenceTarget!, evidenceResult);
			check(evidenceEval.effectiveVerdict === "CHANGES_REQUESTED",
				`12: evidence-test source-string + positive phrase output downgraded (output: "${output.slice(0, 50)}...")`);
			check(evidenceEval.blockingReasons.some((r) => /source-string|static-only|read-the-source|skipped-running|no-runtime-run/i.test(r)),
				`12: evidence-test blockingReasons mention static-only / no-runtime-run override (output: "${output.slice(0, 50)}...")`);
		}

		// Counter-check: explicit structured reviewer evidence (typed
		// criterion coverage) suppresses the static-only override.
		const typedEvidenceResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. source-string test passed by checking the source string for TUI output; no runtime run.",
			completionSource: "explicit",
			status: "completed",
			reviewerEvidence: {
				present: true,
				explicitDeclaration: true,
				criterionCoverage: [{ criterion: "TUI behavior", evidenceKind: "behavior-test", summary: "TUI behavior test passed" }],
			},
		};
		const typedEval = evaluateReviewerResult(behaviorTarget!, typedEvidenceResult);
		check(typedEval.effectiveVerdict === "APPROVED",
			"12: behavior source-string output with typed reviewerEvidence is NOT downgraded");
	}

	// (13) Final-output structured-evidence labels are NOT meaningful
	//      structured reviewer evidence on their own. A vague
	//      "evidence packet: ok ok" with auto_exit must stay provisional
	//      and effective CHANGES_REQUESTED. Typed criterion coverage /
	//      commandsRun is the only path that suppresses provisional.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		const evidenceTarget = derivation.targets.find((t) => t.role === "evidence-test");
		check(Boolean(behaviorTarget && evidenceTarget), "13: behavior + evidence-test targets present");

		const vagueLabelOutputs: string[] = [
			"APPROVED. evidence packet: ok ok",
			"APPROVED. reviewer evidence: ok ok",
			"APPROVED. criterion coverage: ok ok",
			"APPROVED. behavior test passed: ok ok",
			"APPROVED. runtime gate passed: ok ok",
		];
		for (const output of vagueLabelOutputs) {
			const result: ReviewerResultLike = {
				verdict: "APPROVED",
				finalOutput: output,
				completionSource: "auto_exit",
				status: "completed",
			};
			const behaviorEval = evaluateReviewerResult(behaviorTarget!, result);
			check(behaviorEval.provisional === true,
				`13: behavior final-output label "${output}" with auto_exit stays provisional`);
			check(behaviorEval.effectiveVerdict === "CHANGES_REQUESTED",
				`13: behavior final-output label "${output}" with auto_exit stays CHANGES_REQUESTED`);
			const evidenceResult: ReviewerResultLike = { ...result };
			const evidenceEval = evaluateReviewerResult(evidenceTarget!, evidenceResult);
			check(evidenceEval.provisional === true,
				`13: evidence-test final-output label "${output}" with auto_exit stays provisional`);
			check(evidenceEval.effectiveVerdict === "CHANGES_REQUESTED",
				`13: evidence-test final-output label "${output}" with auto_exit stays CHANGES_REQUESTED`);
		}

		// Counter-check: typed criterion coverage (without vague label) on
		// the same auto_exit source DOES suppress provisional.
		const typedOkOk: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. evidence packet: ok ok",
			completionSource: "auto_exit",
			status: "completed",
			reviewerEvidence: { criterionCoverage: [{ criterion: "TUI behavior", summary: "behavior test passed" }] },
		};
		const typedOkOkEval = evaluateReviewerResult(behaviorTarget!, typedOkOk);
		check(typedOkOkEval.provisional === false,
			"13: typed criterionCoverage on the same auto_exit result DOES suppress provisional");
		check(typedOkOkEval.effectiveVerdict === "APPROVED",
			"13: typed criterionCoverage keeps required role approved");
	}

	// (14) Regression role is treated as runtime/evidence-sensitive for the
	//      evaluator's source-string / static-only / skipped-running / prompt-only
	//      downgrade paths. Regression is a regression-proof evidence role by
	//      definition, so an APPROVED result must cite a runnable regression
	//      test / runtime gate / observed tool output OR carry explicit
	//      structured reviewer evidence. Code-walk / source-inspection /
	//      skipped-running approvals are downgraded even when broad positive
	//      phrases ("test passed") are also present. This addresses the
	//      reviewer re-review blocker: the previous evaluator approved
	//      `APPROVED. Test passed. I read the source ... skipped running the
	//      regression smoke.` for the regression role.
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const regressionTarget = derivation.targets.find((t) => t.role === "regression");
		check(Boolean(regressionTarget), "14: regression target present");

		// 14a: exact reviewer re-review repro phrase downgrades regression.
		const exactRepro = "APPROVED. Test passed. I read the source ... skipped running the regression smoke.";
		const exactEval = evaluateReviewerResult(regressionTarget!, makeApprovedResult("regression", exactRepro));
		check(exactEval.effectiveVerdict === "CHANGES_REQUESTED",
			`14a: regression exact repro phrase is downgraded (effectiveVerdict=${exactEval.effectiveVerdict})`);
		check(exactEval.blockingReasons.some((r) =>
			/source-string|static-only|read-the-source|skipped-running|no-runtime-run/i.test(r)),
			`14a: regression blockingReasons mention static-only / skipped-running override (got: ${exactEval.blockingReasons.join("; ")})`);

		// 14b: regression source-string / read-source / skipped-running / no-runtime-run
		//      patterns are downgraded even when paired with "test passed".
		const regressionSourceOnlyOutputs = [
			"APPROVED. Test passed. I read the source and the regression path looks correct; skipped running the regression smoke.",
			"Test passed. I reviewed the source and confirmed no regression; no runtime run was needed.",
			"covered by static check is sufficient; skipped running the regression smoke; test passed.",
			"source-string verification: test passed by checking the source string for regression. No runtime run.",
		];
		for (const output of regressionSourceOnlyOutputs) {
			const evalResult = evaluateReviewerResult(regressionTarget!, makeApprovedResult("regression", output));
			check(evalResult.effectiveVerdict === "CHANGES_REQUESTED",
				`14b: regression source-only output downgraded (output: "${output.slice(0, 60)}...")`);
			check(evalResult.blockingReasons.some((r) =>
				/source-string|static-only|read-the-source|read-source|skipped-running|no-runtime-run/i.test(r)),
				`14b: regression blockingReasons mention override (output: "${output.slice(0, 60)}...")`);
		}

		// 14c: regression prompt-only / instructions-only mitigation is downgraded.
		const regressionPromptOnlyOutputs = [
			"APPROVED. added to the prompt; the regression scenario will be handled in instructions.",
			"updated the system prompt to clarify regression expectations; users will get correct behavior.",
			"no code change is required; documentation only mitigation suffices for regression.",
		];
		for (const output of regressionPromptOnlyOutputs) {
			const evalResult = evaluateReviewerResult(regressionTarget!, makeApprovedResult("regression", output));
			check(evalResult.effectiveVerdict === "CHANGES_REQUESTED",
				`14c: regression prompt-only output downgraded (output: "${output.slice(0, 60)}...")`);
			check(evalResult.promptOnlyCaveats.length > 0,
				`14c: regression prompt-only caveat surfaces (output: "${output.slice(0, 60)}...")`);
			check(evalResult.blockingReasons.some((r) => r.toLowerCase().includes("prompt-only")),
				`14c: regression blockingReasons mention prompt-only (output: "${output.slice(0, 60)}...")`);
		}

		// 14d: regression code-walk-only (no static-only phrase, no positive
		//      runtime phrase) is also downgraded.
		const codeWalkOutput = "I walked the code and confirmed the regression path is correct; no runnable regression test was executed.";
		const codeWalkEval = evaluateReviewerResult(regressionTarget!, makeApprovedResult("regression", codeWalkOutput));
		check(codeWalkEval.effectiveVerdict === "CHANGES_REQUESTED",
			"14d: regression code-walk-only output is downgraded (fail-closed)");

		// 14e: positive baseline — regression APPROVED with acceptable runtime
		//      evidence is NOT downgraded.
		const positiveOutput = "APPROVED. regression test passed: npx tsx scripts/regression-smoke.ts exited 0; runtime gate passed: regression observed in pane.";
		const positiveEval = evaluateReviewerResult(regressionTarget!, makeApprovedResult("regression", positiveOutput));
		check(positiveEval.effectiveVerdict === "APPROVED",
			"14e: regression approval citing runtime evidence is NOT downgraded");
		check(positiveEval.blockingReasons.length === 0,
			`14e: regression positive baseline has no blocking reasons (got: ${positiveEval.blockingReasons.join("; ")})`);

		// 14f: positive baseline — typed structured reviewer evidence (criterion
		//      coverage / commandsRun) suppresses the source-string override
		//      even when the output text also contains "test passed" /
		//      "skipped running" phrasing.
		const typedCoverageResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. Test passed. I read the source ... skipped running the regression smoke.",
			completionSource: "explicit",
			status: "completed",
			reviewerEvidence: {
				present: true,
				explicitDeclaration: true,
				criterionCoverage: [{ criterion: "Regression reviewer validates regression-proof", evidenceKind: "regression-test", summary: "regression test passed" }],
			},
		};
		const typedCoverageEval = evaluateReviewerResult(regressionTarget!, typedCoverageResult);
		check(typedCoverageEval.effectiveVerdict === "APPROVED",
			"14f: regression repro phrase with typed reviewerEvidence is NOT downgraded");
		check(typedCoverageEval.blockingReasons.length === 0,
			`14f: regression typed-evidence path has no blocking reasons (got: ${typedCoverageEval.blockingReasons.join("; ")})`);

		const typedCommandsResult: ReviewerResultLike = {
			verdict: "APPROVED",
			finalOutput: "APPROVED. Test passed. I read the source ... skipped running the regression smoke.",
			completionSource: "explicit",
			status: "completed",
			reviewerEvidence: {
				commandsRun: [{ command: "npx tsx scripts/regression-smoke.ts", outcome: "exit 0", summary: "regression test passed" }],
			},
		};
		const typedCommandsEval = evaluateReviewerResult(regressionTarget!, typedCommandsResult);
		check(typedCommandsEval.effectiveVerdict === "APPROVED",
			"14f: regression repro phrase with typed commandsRun is NOT downgraded");

		// 14g: regression role's hard role rules surface source-string / prompt-only
		//      rejection language so reviewers self-enforce at the prompt layer.
		const regressionHardRules = regressionTarget!.roleRules.join("\n");
		check(/source-string|read-the-source|read the source|reading the source/i.test(regressionHardRules),
			"14g: regression hard role rules surface source-string rejection language");
		check(regressionHardRules.toLowerCase().includes("prompt-only"),
			"14g: regression hard role rules surface prompt-only rejection language");
	}
}

main();
if (failures > 0) { console.error(`\n${failures} reviewer-roles smoke check(s) failed.`); process.exit(1); }
console.log("\nAll TASK-004 reviewer-roles smoke checks passed.");
