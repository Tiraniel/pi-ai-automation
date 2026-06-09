#!/usr/bin/env node
// TASK-003 Phase A — coder completion evidence validator smoke checks.
// All cases use synthetic plan / matrix / packets; no real delegate launches.
// Covers: missing criterion, weak/static behavior evidence, pane auto_exit
// / process_exit / missing sidecar, headless free-form-only, failed/retry
// history visibility, successful complete evidence, tiny/admin exception.

import {
	canUseLightweightEvidenceCheck,
	evaluateCoderCompletionEvidence,
	isMatrixGated,
	normalizeCoderCompletionEvidence,
	type CoderCompletionEvidence,
	type CoderEvidenceEvaluation,
	type CoderEvidencePlanShape,
	type CoderDelegateAttempt,
	type CoderDelegateHistory,
} from "../extensions/workflow/delegate/completion-evidence";
import type { AcceptanceEvidenceMatrixEntry } from "../extensions/workflow/architecture/types";

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

function makeMatrix(): AcceptanceEvidenceMatrixEntry[] {
	return [
		makeEntry({ criterion: "alpha-behavior", criterionKind: "runtime-behavior", businessRiskIfWrong: "alpha path may regress",
			enforcementLevel: ["behavior-test"],
			requiredEvidence: [{ kind: "behavior-test", description: "alpha behavior test", command: "npx tsx scripts/smoke-alpha.ts" }],
			reviewerRoles: ["behavior"], blockingConditions: ["alpha behavior test fails"] }),
		makeEntry({ criterion: "beta-runtime", criterionKind: "runtime-behavior", businessRiskIfWrong: "beta path may regress",
			enforcementLevel: ["runtime-gate"],
			requiredEvidence: [{ kind: "runtime-gate-test", description: "beta runtime gate", command: "npx tsx scripts/smoke-beta.ts" }],
			reviewerRoles: ["behavior"], blockingConditions: ["beta runtime gate fails"] }),
		makeEntry({ criterion: "gamma-docs", criterionKind: "documentation", businessRiskIfWrong: "operators lack docs",
			enforcementLevel: ["manual-validation"],
			requiredEvidence: [{ kind: "manual-validation", description: "docs reviewer approval" }],
			reviewerRoles: ["docs-config"], blockingConditions: ["docs reviewer not signed off"] }),
	];
}

function makeMatrixGatedPlan(): CoderEvidencePlanShape {
	return {
		status: "ready",
		acceptanceCriteria: ["alpha-behavior", "beta-runtime", "gamma-docs"],
		acceptanceEvidenceMatrix: makeMatrix(),
	};
}

function makeEvidencePacket(overrides: Partial<CoderCompletionEvidence> = {}): CoderCompletionEvidence {
	return {
		filesChanged: ["extensions/workflow/delegate/completion-evidence.ts"],
		commandsRun: [{ command: "npx tsx scripts/smoke-alpha.ts", outcome: "passed" }],
		criterionCoverage: [{
			criterion: "alpha-behavior", evidenceKind: "behavior-test", strength: "sufficient",
			supportingFiles: ["extensions/workflow/delegate/completion-evidence.ts"],
			supportingCommands: ["npx tsx scripts/smoke-alpha.ts"],
			summary: "alpha behavior test passes per the synthetic smoke.",
		}],
		knownGaps: [], caveats: [],
		delegateHistory: { attempts: [], warnings: [], retries: 0, autoExitObserved: false, processExitObserved: false, missingSidecarObserved: false, freeFormOnlyObserved: false },
		...overrides,
	};
}

function evaluatePlan(plan: CoderEvidencePlanShape, packet: CoderCompletionEvidence | undefined, opts: Parameters<typeof evaluateCoderCompletionEvidence>[2] = {}): CoderEvidenceEvaluation {
	return evaluateCoderCompletionEvidence(plan, packet, opts);
}

function main(): void {
	const plan = makeMatrixGatedPlan();
	const completePacket = (() => {
		const p = makeEvidencePacket();
		p.criterionCoverage = [
			{ criterion: "alpha-behavior", evidenceKind: "behavior-test", strength: "sufficient",
				supportingFiles: ["extensions/workflow/delegate/completion-evidence.ts"],
				supportingCommands: ["npx tsx scripts/smoke-alpha.ts"],
				summary: "alpha behavior test passes per synthetic smoke." },
			{ criterion: "beta-runtime", evidenceKind: "runtime-gate", strength: "sufficient",
				supportingFiles: ["extensions/workflow/delegate/completion-evidence.ts"],
				supportingCommands: ["npx tsx scripts/smoke-beta.ts"],
				summary: "beta runtime gate passes per synthetic smoke." },
			{ criterion: "gamma-docs", evidenceKind: "manual-validation", strength: "manual-caveat",
				supportingFiles: ["docs/workflow-config-v2.md"], supportingCommands: [],
				summary: "docs reviewer signed off.", caveats: "reviewer must walk the diff." },
		];
		p.commandsRun = [
			{ command: "npx tsx scripts/smoke-alpha.ts", outcome: "passed" },
			{ command: "npx tsx scripts/smoke-beta.ts", outcome: "passed" },
		];
		return p;
	})();

	// (a) Missing one matrix criterion is blocked.
	{
		const packet = makeEvidencePacket();
		const result = evaluatePlan(plan, packet);
		check(result.ok === false, "a: missing matrix criterion blocks coder_completed");
		check(result.isMatrixGated === true, "a: plan classified as matrix-gated");
		check(result.rejectionCodes.includes("missing_criterion"), `a: rejectionCodes includes missing_criterion (got: ${result.rejectionCodes.join(",")})`);
		check(result.diagnostics.missingCriteria.includes("beta-runtime"), "a: missingCriteria reports beta-runtime");
		check(result.diagnostics.missingCriteria.includes("gamma-docs"), "a: missingCriteria reports gamma-docs");
	}

	// (b) Static/source-string-only evidence for behavior-test/runtime criterion
	//     is blocked or weak and ok === false.
	{
		const staticOnly: CoderCompletionEvidence = {
			...makeEvidencePacket(),
			criterionCoverage: [
				{ criterion: "alpha-behavior", evidenceKind: "static-only", strength: "sufficient",
					supportingFiles: ["extensions/workflow/delegate/completion-evidence.ts"],
					supportingCommands: [],
					summary: "static check on alpha path." },
				{ criterion: "beta-runtime", evidenceKind: "source-string", strength: "sufficient",
					supportingFiles: ["extensions/workflow/delegate/completion-evidence.ts"],
					supportingCommands: [],
					summary: "string check on beta path." },
				{ criterion: "gamma-docs", evidenceKind: "manual-validation", strength: "manual-caveat",
					supportingFiles: ["docs/workflow-config-v2.md"], supportingCommands: [],
					summary: "docs reviewer signed off.", caveats: "reviewer must walk the diff." },
			],
		};
		const result = evaluatePlan(plan, staticOnly);
		check(result.ok === false, "b: static/source-only evidence for behavior+runtime criteria blocks coder_completed");
		check(result.rejectionCodes.includes("static_only_behavior_criterion"), `b: static_only_behavior_criterion reported (got: ${result.rejectionCodes.join(",")})`);
		check(result.diagnostics.weakCriteria.includes("alpha-behavior"), "b: weakCriteria lists alpha-behavior (static-only against behavior-test)");
		check(result.diagnostics.weakCriteria.includes("beta-runtime"), "b: weakCriteria lists beta-runtime (source-string against runtime-gate)");
		// Prompt-only on a runtime criterion is also weak.
		const promptOnlyRuntime: CoderCompletionEvidence = {
			...makeEvidencePacket(),
			criterionCoverage: [
				{ criterion: "alpha-behavior", evidenceKind: "behavior-test", strength: "sufficient",
					supportingFiles: ["extensions/workflow/delegate/completion-evidence.ts"],
					supportingCommands: ["npx tsx scripts/smoke-alpha.ts"],
					summary: "alpha behavior test passes." },
				{ criterion: "beta-runtime", evidenceKind: "prompt-only", strength: "sufficient",
					supportingFiles: ["extensions/workflow/delegate/completion-evidence.ts"],
					supportingCommands: [],
					summary: "prompt-only on beta runtime path." },
				{ criterion: "gamma-docs", evidenceKind: "manual-validation", strength: "manual-caveat",
					supportingFiles: ["docs/workflow-config-v2.md"], supportingCommands: [],
					summary: "docs reviewer signed off.", caveats: "reviewer must walk the diff." },
			],
			commandsRun: [{ command: "npx tsx scripts/smoke-alpha.ts", outcome: "passed" }],
		};
		const promptResult = evaluatePlan(plan, promptOnlyRuntime);
		check(promptResult.ok === false, "b: prompt-only on runtime criterion blocks coder_completed");
		check(promptResult.rejectionCodes.includes("static_only_behavior_criterion") || promptResult.rejectionCodes.includes("insufficient_evidence"),
			`b: prompt-only on runtime yields weak/insufficient code (got: ${promptResult.rejectionCodes.join(",")})`);
	}

	// (c) Pane auto_exit / process_exit / missing-sidecar diagnostics do not
	//     advance non-trivial matrix-gated phases.
	{
		// auto_exit with no structured coverage
		const autoExitHistory: CoderDelegateHistory = {
			attempts: [{ attempt: 1, completionSource: "auto_exit", status: "completed" }],
			warnings: ["delegate exited without done sidecar"], retries: 0,
			autoExitObserved: true, processExitObserved: false,
			missingSidecarObserved: false, freeFormOnlyObserved: true,
		};
		const autoExitPacket: CoderCompletionEvidence = {
			filesChanged: [], commandsRun: [], criterionCoverage: [],
			knownGaps: [], caveats: [], delegateHistory: autoExitHistory,
		};
		const autoExitResult = evaluatePlan(plan, autoExitPacket);
		check(autoExitResult.ok === false, "c: auto_exit-only history blocks coder_completed");
		check(autoExitResult.rejectionCodes.includes("auto_exit_incomplete"), `c: auto_exit_incomplete reported (got: ${autoExitResult.rejectionCodes.join(",")})`);
		check(autoExitResult.rejectionCodes.includes("free_form_only"), `c: free_form_only reported for auto_exit (got: ${autoExitResult.rejectionCodes.join(",")})`);

		// process_exit with full coverage must still be blocked by process_exit_incomplete
		const processExitHistory: CoderDelegateHistory = {
			...completePacket.delegateHistory,
			attempts: [{ attempt: 1, completionSource: "process_exit", status: "failed" }],
			processExitObserved: true, freeFormOnlyObserved: true,
		};
		const processExitResult = evaluatePlan(plan, { ...completePacket, delegateHistory: processExitHistory });
		check(processExitResult.ok === false, "c: process_exit sidecar blocks coder_completed even with full coverage");
		check(processExitResult.rejectionCodes.includes("process_exit_incomplete"), `c: process_exit_incomplete reported (got: ${processExitResult.rejectionCodes.join(",")})`);

		// missing sidecar
		const missingHistory: CoderDelegateHistory = {
			attempts: [], warnings: ["no done sidecar found"], retries: 0,
			autoExitObserved: false, processExitObserved: false,
			missingSidecarObserved: true, freeFormOnlyObserved: true,
		};
		const missingResult = evaluatePlan(plan, { ...makeEvidencePacket(), delegateHistory: missingHistory });
		check(missingResult.ok === false, "c: missing-sidecar history blocks coder_completed");
		check(missingResult.rejectionCodes.includes("missing_sidecar_incomplete"), `c: missing_sidecar_incomplete reported (got: ${missingResult.rejectionCodes.join(",")})`);
	}

	// (d) Headless generic / free-form-only completion without structured
	//     evidence does not advance.
	{
		const headlessFreeFormHistory: CoderDelegateHistory = {
			attempts: [{ attempt: 1, completionSource: "legacy", status: "completed",
				finalOutputPreview: "Generic completion message; no structured evidence." }],
			warnings: ["no structured evidence found in result details"], retries: 0,
			autoExitObserved: false, processExitObserved: false,
			missingSidecarObserved: false, freeFormOnlyObserved: true,
		};
		const headlessResult = evaluatePlan(plan, { ...makeEvidencePacket(), delegateHistory: headlessFreeFormHistory });
		check(headlessResult.ok === false, "d: headless free-form-only completion blocks coder_completed");
		check(headlessResult.rejectionCodes.includes("free_form_only"), `d: free_form_only reported (got: ${headlessResult.rejectionCodes.join(",")})`);
		check(headlessResult.diagnostics.sourcePrecedence === "free-form-only", `d: sourcePrecedence is free-form-only (got: ${headlessResult.diagnostics.sourcePrecedence})`);
	}

	// (e) Failed / retried delegate history is present in evaluation diagnostics.
	{
		const failedAttempts: CoderDelegateAttempt[] = [
			{ attempt: 1, completionSource: "auto_exit", status: "completed",
				finalOutputPreview: "first attempt auto-exited", warning: "no sidecar" },
			{ attempt: 2, completionSource: "process_exit", status: "failed",
				finalOutputPreview: "second attempt process-exited", warning: "build failed" },
		];
		const failedHistory: CoderDelegateHistory = {
			attempts: failedAttempts,
			warnings: ["first delegate auto-exited", "second delegate process-exited", "delegate retry triggered"],
			retries: 1, autoExitObserved: true, processExitObserved: true,
			missingSidecarObserved: false, freeFormOnlyObserved: true,
		};
		const result = evaluatePlan(plan, { ...completePacket, delegateHistory: failedHistory });
		check(result.diagnostics.delegateHistory.attempts.length >= 2, "e: delegate history attempts preserved in diagnostics");
		const atts = result.diagnostics.delegateHistory.attempts.map((a) => a.completionSource);
		check(atts.includes("auto_exit"), "e: auto_exit attempt present in diagnostics");
		check(atts.includes("process_exit"), "e: process_exit attempt present in diagnostics");
		check(result.diagnostics.delegateHistory.retries === 1, "e: retries count visible in diagnostics (1)");
		check(result.diagnostics.delegateHistory.warnings.length >= 2, "e: warnings array visible in diagnostics");
		check(result.diagnostics.sourcePrecedence === "pane-structured", `e: sourcePrecedence is pane-structured (got: ${result.diagnostics.sourcePrecedence})`);
	}

	// (f) Successful structured completion with complete sufficient evidence
	//     returns ok === true.
	{
		const result = evaluatePlan(plan, completePacket);
		check(result.ok === true, `f: structured complete evidence returns ok=true (reason: ${result.reason ?? "n/a"})`);
		check(result.isMatrixGated === true, "f: isMatrixGated true on success path");
		check(result.rejectionCodes.length === 0, `f: no rejection codes on success (got: ${result.rejectionCodes.join(",")})`);
		check(result.diagnostics.commandOutcomes.passed === 2, `f: commandOutcomes.passed === 2 (got: ${result.diagnostics.commandOutcomes.passed})`);
		check(result.diagnostics.coverageRows === 3, `f: coverageRows === 3 (got: ${result.diagnostics.coverageRows})`);
		check(result.diagnostics.missingCriteria.length === 0, "f: missingCriteria empty on success");
		check(result.diagnostics.weakCriteria.length === 0, "f: weakCriteria empty on success");
		check(result.diagnostics.sourcePrecedence === "explicit-structured", `f: sourcePrecedence is explicit-structured (got: ${result.diagnostics.sourcePrecedence})`);
	}

	// (g) Tiny / admin / debug lightweight exception is allowed only when
	//     not matrix-gated and refused when matrix-gated.
	{
		// Non-matrix-gated: lightweight passes.
		const draftPlan: CoderEvidencePlanShape = { status: "draft", acceptanceCriteria: ["x"], acceptanceEvidenceMatrix: makeMatrix() };
		const result = evaluatePlan(draftPlan, undefined, { lightweight: true, lightweightScope: "tiny" });
		check(result.ok === true, `g: tiny lightweight on draft (non-gated) returns ok=true (reason: ${result.reason ?? "n/a"})`);
		check(result.isMatrixGated === false, "g: isMatrixGated false for draft with matrix but non-ready status");
		check(result.lightweight === true, "g: lightweight flag preserved on result");
		check(canUseLightweightEvidenceCheck(draftPlan, { lightweightScope: "tiny" }) === true, "g: canUseLightweightEvidenceCheck true for draft + tiny scope");

		// Matrix-gated: lightweight refused.
		const gatedResult = evaluatePlan(plan, completePacket, { lightweight: true, lightweightScope: "admin" });
		check(gatedResult.ok === false, "g: admin lightweight on matrix-gated plan is refused");
		check(gatedResult.rejectionCodes.includes("lightweight_bypass_refused"), `g: lightweight_bypass_refused reported (got: ${gatedResult.rejectionCodes.join(",")})`);
		check(canUseLightweightEvidenceCheck(plan, { lightweightScope: "admin" }) === false, "g: canUseLightweightEvidenceCheck false for matrix-gated plan");

		// Missing scope is refused on matrix-gated.
		const missingScopeResult = evaluatePlan(plan, completePacket, { lightweight: true });
		check(missingScopeResult.rejectionCodes.includes("lightweight_bypass_refused"), "g: lightweight without scope refused on matrix-gated plan");
	}

	// Extra coverage: non-matrix-gated plans short-circuit (lightweight honored).
	{
		const draftPlan: CoderEvidencePlanShape = { status: "draft", acceptanceCriteria: ["x"] };
		const r = evaluateCoderCompletionEvidence(draftPlan, undefined);
		check(r.ok === true, "non-matrix-gated draft plan without packet returns ok=true");
		check(r.isMatrixGated === false, "non-matrix-gated draft plan isMatrixGated=false");
		check(r.reason === "Plan is not matrix-gated; evidence check is a no-op.", `non-matrix-gated reason (got: ${r.reason})`);
	}

	// Extra coverage: missing packet on matrix-gated plan is blocked.
	{
		const r = evaluatePlan(plan, undefined);
		check(r.ok === false, "missing packet on matrix-gated plan blocks coder_completed");
		check(r.rejectionCodes.includes("evidence_packet_missing"), "missing packet on matrix-gated plan reports evidence_packet_missing");
	}

	// Extra coverage: requireFilesAndCommands is enforced on matrix-gated.
	{
		const r = evaluatePlan(plan, { ...completePacket, filesChanged: [], commandsRun: [] }, { requireFilesAndCommands: true });
		check(r.ok === false, "requireFilesAndCommands fails when both fields are empty");
		check(r.rejectionCodes.includes("missing_files_changed"), "requireFilesAndCommands reports missing_files_changed");
		check(r.rejectionCodes.includes("missing_commands_run"), "requireFilesAndCommands reports missing_commands_run");
	}

	// Extra coverage: isMatrixGated helper.
	{
		check(isMatrixGated(null, undefined) === false, "isMatrixGated(null) === false");
		check(isMatrixGated({ status: "draft", acceptanceCriteria: ["x"], acceptanceEvidenceMatrix: makeMatrix() }, undefined) === false, "isMatrixGated(draft) === false");
		check(isMatrixGated(plan, undefined) === true, "isMatrixGated(ready + matrix + criteria) === true");
		check(isMatrixGated({ status: "ready", acceptanceCriteria: ["x"] }, true) === true, "isMatrixGated forced override returns true");
		// Regression (TASK-003 Phase A CHANGES_REQUESTED): ready plan with matrix rows
		// but empty/missing acceptanceCriteria must still be matrix-gated so the
		// lightweight (tiny/admin/debug) exception cannot silently bypass it.
		check(isMatrixGated({ status: "ready", acceptanceEvidenceMatrix: makeMatrix() }, undefined) === true, "isMatrixGated(ready + matrix rows, no acceptanceCriteria) === true");
		check(isMatrixGated({ status: "ready", acceptanceCriteria: [], acceptanceEvidenceMatrix: makeMatrix() }, undefined) === true, "isMatrixGated(ready + empty acceptanceCriteria + matrix) === true");
		check(isMatrixGated({ status: "ready", acceptanceEvidenceMatrix: [] }, undefined) === false, "isMatrixGated(ready + no matrix rows) === false");
	}

	// Extra coverage: lightweight bypass refusal on a ready plan that has matrix
	// rows but empty/missing acceptanceCriteria. Regression for TASK-003
	// Phase A CHANGES_REQUESTED: a ready matrix-backed plan must not be
	// eligible for the tiny/admin/debug bypass.
	{
		const readyMatrixOnlyPlan: CoderEvidencePlanShape = { status: "ready", acceptanceEvidenceMatrix: makeMatrix() };
		check(isMatrixGated(readyMatrixOnlyPlan, undefined) === true, "regression: ready + matrix rows is matrix-gated even without acceptanceCriteria");
		check(canUseLightweightEvidenceCheck(readyMatrixOnlyPlan, { lightweightScope: "tiny" }) === false, "regression: canUseLightweightEvidenceCheck(ready + matrix, tiny) === false");
		const tinyResult = evaluateCoderCompletionEvidence(readyMatrixOnlyPlan, undefined, { lightweight: true, lightweightScope: "tiny" });
		check(tinyResult.ok === false, `regression: tiny lightweight on ready + matrix returns ok=false (reason: ${tinyResult.reason ?? "n/a"})`);
		check(tinyResult.rejectionCodes.includes("lightweight_bypass_refused"), `regression: tiny lightweight on ready + matrix reports lightweight_bypass_refused (got: ${tinyResult.rejectionCodes.join(",")})`);
		const adminResult = evaluateCoderCompletionEvidence(readyMatrixOnlyPlan, undefined, { lightweight: true, lightweightScope: "admin" });
		check(adminResult.rejectionCodes.includes("lightweight_bypass_refused"), `regression: admin lightweight on ready + matrix reports lightweight_bypass_refused (got: ${adminResult.rejectionCodes.join(",")})`);
		const debugResult = evaluateCoderCompletionEvidence(readyMatrixOnlyPlan, undefined, { lightweight: true, lightweightScope: "debug" });
		check(debugResult.rejectionCodes.includes("lightweight_bypass_refused"), `regression: debug lightweight on ready + matrix reports lightweight_bypass_refused (got: ${debugResult.rejectionCodes.join(",")})`);
	}

	// Extra coverage: normalize preserves a well-formed packet.
	{
		const result = normalizeCoderCompletionEvidence({ packet: completePacket });
		check(result.issues.length === 0, "normalize of a well-formed packet reports no issues");
		check(result.value !== undefined, "normalize of a well-formed packet returns a value");
		check(result.value?.commandsRun.length === 2, "normalize preserves 2 commandsRun");
		check(result.value?.criterionCoverage.length === 3, "normalize preserves 3 criterionCoverage rows");
	}

	// Extra coverage: normalize of a missing/unreadable packet is reported.
	{
		const r1 = normalizeCoderCompletionEvidence({ packet: null });
		check(r1.issues.some((i) => i.code === "evidence_packet_missing"), "normalize of null packet reports evidence_packet_missing");
		const r2 = normalizeCoderCompletionEvidence({ packet: "not-an-object" });
		check(r2.issues.some((i) => i.code === "evidence_packet_unreadable"), "normalize of non-object packet reports evidence_packet_unreadable");
	}
}

main();
if (failures > 0) { console.error(`\n${failures} smoke check(s) failed.`); process.exit(1); }
console.log("\nAll TASK-003 coder completion evidence smoke checks passed.");
