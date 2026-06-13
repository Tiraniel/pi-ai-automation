#!/usr/bin/env node
// TASK-003 Phase B — coder completion evidence gate integration smokes.
// All cases use synthetic plans / matrix / DelegateRunResult-shaped objects
// and temporary done sidecars; no real delegate launches or panes. The
// gate must:
//   - accept pane explicit sidecars with complete structured evidence;
//   - reject pane auto_exit / process_exit / missing sidecar with diagnostic codes;
//   - reject headless generic / free-form completed results without structured evidence;
//   - keep behavior-test / static-only / source-string coverage blocking matrix advancement;
//   - keep failed / retry delegate history visible in diagnostics / reasons;
//   - preserve the tiny / admin / debug lightweight exception outside matrix-gated plans;
//   - never allow a ready matrix-gated plan to be silently bypassed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	evaluateCoderPhaseAdvancement,
	formatCoderEvidenceRejectionText,
	runCompletionEvidenceGate,
} from "../extensions/workflow/delegate/completion-evidence-gate";
import type { CoderCompletionEvidence } from "../extensions/workflow/delegate/completion-evidence";
import type { AcceptanceEvidenceMatrixEntry } from "../extensions/workflow/architecture/types";
import type {
	DelegateCompletionSource,
	DelegateRunResult,
	UsageStats,
} from "../extensions/workflow/types";
import type { WorkflowArchitecturePlan } from "../extensions/workflow/architecture/types";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

const ZERO_USAGE: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function makeMatrixEntry(overrides: Partial<AcceptanceEvidenceMatrixEntry>): AcceptanceEvidenceMatrixEntry {
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
		makeMatrixEntry({ criterion: "alpha-behavior", criterionKind: "runtime-behavior",
			businessRiskIfWrong: "alpha path may regress",
			enforcementLevel: ["behavior-test"],
			requiredEvidence: [{ kind: "behavior-test", description: "alpha behavior test", command: "npx tsx scripts/smoke-alpha.ts" }],
			reviewerRoles: ["behavior"], blockingConditions: ["alpha behavior test fails"] }),
		makeMatrixEntry({ criterion: "beta-runtime", criterionKind: "runtime-behavior",
			businessRiskIfWrong: "beta path may regress",
			enforcementLevel: ["runtime-gate"],
			requiredEvidence: [{ kind: "runtime-gate-test", description: "beta runtime gate", command: "npx tsx scripts/smoke-beta.ts" }],
			reviewerRoles: ["behavior"], blockingConditions: ["beta runtime gate fails"] }),
		makeMatrixEntry({ criterion: "gamma-docs", criterionKind: "documentation",
			businessRiskIfWrong: "operators lack docs",
			enforcementLevel: ["manual-validation"],
			requiredEvidence: [{ kind: "manual-validation", description: "docs reviewer approval" }],
			reviewerRoles: ["docs-config"], blockingConditions: ["docs reviewer not signed off"] }),
	];
}

function makeMatrixGatedPlan(overrides: Partial<WorkflowArchitecturePlan> = {}): WorkflowArchitecturePlan {
	return {
		planId: "task-003-coder-evidence-handoff",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "ready",
		businessPlan: "b",
		technicalPlan: "t",
		parallelAssessment: "serial",
		contractBlockPlan: "c",
		acceptanceCriteria: ["alpha-behavior", "beta-runtime", "gamma-docs"],
		acceptanceEvidenceMatrix: makeMatrix(),
		phases: {
			phaseA: { status: "review_approved", updatedAt: new Date().toISOString(), evidence: [] },
			phaseB: { status: "not_started", updatedAt: new Date().toISOString(), evidence: [] },
		},
		...overrides,
	};
}

function makeCompleteEvidencePacket(): CoderCompletionEvidence {
	return {
		filesChanged: [
			"extensions/workflow/delegate/completion-evidence.ts",
			"extensions/workflow/delegate/completion-evidence-gate.ts",
		],
		commandsRun: [
			{ command: "npx tsx scripts/smoke-alpha.ts", outcome: "passed", exitCode: 0, summary: "alpha behavior test passes" },
			{ command: "npx tsx scripts/smoke-beta.ts", outcome: "passed", exitCode: 0, summary: "beta runtime gate passes" },
		],
		criterionCoverage: [
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
		],
		knownGaps: [],
		caveats: ["gamma-docs requires manual review"],
		summary: "Coder phase B evidence packet",
		delegateHistory: {
			attempts: [{ attempt: 1, completionSource: "explicit", status: "completed",
				finalOutputPreview: "explicit completion via sub_agent_done" }],
			warnings: [],
			retries: 0,
			autoExitObserved: false, processExitObserved: false,
			missingSidecarObserved: false, freeFormOnlyObserved: false,
		},
	};
}

// Local type augmentation for synthetic test fixtures only. The shared
// `DelegateRunResult` intentionally does not expose `details`; the gate
// reads it via a runtime duck-type check (`asRecord(result).details`).
// The smoke augments the parameter type locally so the synthetic cases
// can attach structured coder evidence without modifying the shared type.
type SyntheticDelegateOverrides = Partial<DelegateRunResult> & {
	doneFile?: string;
	details?: Record<string, unknown>;
};

function makeDelegateResult(overrides: SyntheticDelegateOverrides = {}): DelegateRunResult {
	const { doneFile, details, ...rest } = overrides;
	const base: DelegateRunResult = {
		agent: "coder",
		task: "TASK-003 phase B coder work",
		cwd: "/tmp",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { ...ZERO_USAGE },
		stopReason: "end_turn",
		status: "completed",
		finalOutput: "Generic completion message; no structured evidence.",
		display: "pane",
		completionSource: "explicit",
	};
	const result: DelegateRunResult = { ...base, ...rest };
	if (doneFile !== undefined) (result as { doneFile?: string }).doneFile = doneFile;
	if (details !== undefined) (result as unknown as { details?: Record<string, unknown> }).details = details;
	return result;
}

function writeSidecar(tmpDir: string, name: string, payload: unknown): string {
	const file = path.join(tmpDir, name);
	fs.writeFileSync(file, JSON.stringify(payload) + "\n", "utf8");
	return file;
}

function expectSource(actual: string, expected: string, label: string): void {
	check(actual === expected, `${label}: structuredSource === ${expected} (got: ${actual})`);
}

function main(): void {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-003-coder-evidence-gate-"));
	try {
		const plan = makeMatrixGatedPlan();
		const completeEvidence = makeCompleteEvidencePacket();

		// (1) Pane explicit sidecar with complete structured evidence PASSES.
		//     TASK-002 tightened: sidecar carries canonical `evidence:
		//     { coderEvidence: ... }` envelope; legacy top-level
		//     `coderEvidence` is diagnostic only and is NOT authority.
		{
			const doneFile = writeSidecar(tmpDir, "explicit-complete.json", {
				done: true, completion: "explicit", source: "tool", tool: "sub_agent_done",
				summary: "explicit completion", at: new Date().toISOString(), exit_code: 0,
				evidence: { coderEvidence: completeEvidence },
			});
			const result = makeDelegateResult({ completionSource: "explicit" as DelegateCompletionSource, doneFile });
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === true, "1: pane explicit sidecar with complete evidence passes");
			check(gate.evaluation.rejectionCodes.length === 0, `1: no rejection codes on success (got: ${gate.evaluation.rejectionCodes.join(",")})`);
			expectSource(gate.structuredSource, "pane-structured", "1");
			check(gate.evaluation.diagnostics.coverageRows === 3, `1: coverageRows === 3 (got: ${gate.evaluation.diagnostics.coverageRows})`);
			check(gate.evaluation.diagnostics.commandOutcomes.passed === 2, `1: commandOutcomes.passed === 2 (got: ${gate.evaluation.diagnostics.commandOutcomes.passed})`);

			// evaluateCoderPhaseAdvancement must return kind=advance.
			const baseDetails = { ...result, task: plan.planId, planId: plan.planId, phase: "phaseB" as const };
			const adv = evaluateCoderPhaseAdvancement(plan, result, baseDetails);
			check(adv.kind === "advance", "1: evaluateCoderPhaseAdvancement returns kind=advance on success");
		}

		// (2) Pane auto_exit sidecar REJECTS with auto_exit_incomplete + free_form_only.
		{
			const doneFile = writeSidecar(tmpDir, "auto-exit.json", {
				done: true, completion: "auto_exit", source: "agent_end",
				from_auto_exit: true, at: new Date().toISOString(), exit_code: 0,
				warning: "Pane delegate did not call sub_agent_done/workflow_delegate_done; auto-completing on normal agent_end.",
			});
			const result = makeDelegateResult({
				completionSource: "auto_exit" as DelegateCompletionSource,
				doneFile,
				completionWarning: "Pane delegate did not call sub_agent_done/workflow_delegate_done; auto-completing on normal agent_end.",
			});
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false, "2: pane auto_exit sidecar blocks coder_completed");
			check(gate.evaluation.rejectionCodes.includes("auto_exit_incomplete"), `2: auto_exit_incomplete reported (got: ${gate.evaluation.rejectionCodes.join(",")})`);
			check(gate.evaluation.rejectionCodes.includes("free_form_only"), `2: free_form_only reported (got: ${gate.evaluation.rejectionCodes.join(",")})`);
			expectSource(gate.structuredSource, "free-form-only", "2");
			const adv = evaluateCoderPhaseAdvancement(plan, result, { ...result });
			check(adv.kind === "block", "2: evaluateCoderPhaseAdvancement returns kind=block on auto_exit");
			if (adv.kind === "block") {
				const text = adv.content[0]?.text ?? "";
				check(text.includes("auto_exit_incomplete"), "2: rejection text mentions auto_exit_incomplete");
				check(text.includes("free_form_only") || text.includes("Free-form"), "2: rejection text mentions free-form diagnostic");
				const details = adv.details as { coderEvidenceGate?: { delegateHistory?: { autoExitObserved?: boolean; attempts?: Array<{ completionSource?: string }> } } };
				check(details.coderEvidenceGate?.delegateHistory?.autoExitObserved === true, "2: delegateHistory.autoExitObserved true in details");
				const sources = details.coderEvidenceGate?.delegateHistory?.attempts?.map((a) => a.completionSource) ?? [];
				check(sources.includes("auto_exit"), "2: delegateHistory.attempts preserves auto_exit source");
			}
		}

		// (3) Pane process_exit sidecar REJECTS with process_exit_incomplete even when structured
		//     coderEvidence is present in the result details (free-form is still never sufficient).
		//     TASK-002 tightened: details carry canonical `evidence: { coderEvidence }` envelope.
		{
			const doneFile = writeSidecar(tmpDir, "process-exit.json", {
				done: true, from_exit: true, completion: "process_exit", source: "shell_exit",
				at: new Date().toISOString(), exit_code: 1, stop_reason: "interrupted",
				warning: "Pane delegate exited without calling sub_agent_done",
			});
			const result = makeDelegateResult({
				completionSource: "process_exit" as DelegateCompletionSource,
				doneFile,
				stopReason: "interrupted",
				exitCode: 1,
				// even if the runner has structured details, process_exit must still be rejected.
				details: { evidence: { coderEvidence: completeEvidence } },
			});
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false, "3: pane process_exit sidecar blocks coder_completed");
			check(gate.evaluation.rejectionCodes.includes("process_exit_incomplete"), `3: process_exit_incomplete reported (got: ${gate.evaluation.rejectionCodes.join(",")})`);
			expectSource(gate.structuredSource, "pane-structured", "3");
		}

		// (4) Pane missing sidecar REJECTS with missing_sidecar_incomplete.
		{
			// No doneFile set on the result.
			const result = makeDelegateResult({ completionSource: "missing" as DelegateCompletionSource });
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false, "4: missing pane sidecar blocks coder_completed");
			check(gate.evaluation.rejectionCodes.includes("missing_sidecar_incomplete"), `4: missing_sidecar_incomplete reported (got: ${gate.evaluation.rejectionCodes.join(",")})`);
			expectSource(gate.structuredSource, "pane-structured", "4");
		}

		// (5) Headless generic completed / free-form-only result REJECTS without structured evidence.
		{
			const result = makeDelegateResult({
				completionSource: "legacy" as DelegateCompletionSource,
				display: "headless",
				finalOutput: "Generic completion message; no structured evidence.",
			});
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false, "5: headless generic/free-form completed result blocks coder_completed");
			check(gate.evaluation.rejectionCodes.includes("free_form_only"), `5: free_form_only reported (got: ${gate.evaluation.rejectionCodes.join(",")})`);
			expectSource(gate.structuredSource, "free-form-only", "5");

			// Intentionally supported structured result details (e.g. via runner.details.evidence)
			// must be parsed and accepted. Re-run with structured details to confirm precedence.
			// TASK-002 tightened: details carry canonical `evidence: { coderEvidence }` envelope.
			const structuredResult = makeDelegateResult({
				completionSource: "explicit" as DelegateCompletionSource,
				display: "headless",
				finalOutput: "Generic completion message; no structured evidence.",
				details: { evidence: { coderEvidence: completeEvidence } },
			});
			const structuredGate = runCompletionEvidenceGate(plan, structuredResult);
			check(structuredGate.ok === true, "5: headless structured result details with complete evidence advance");
			expectSource(structuredGate.structuredSource, "headless-structured", "5 (structured headless)");
		}

		// (6) Static-only / source-string evidence for behavior-test and runtime-gate criteria
		//     still blocks matrix advancement even with a passing explicit sidecar.
		//     TASK-002 tightened: sidecar carries canonical `evidence: { coderEvidence }` envelope.
		{
			const staticOnlyPacket = {
				...completeEvidence,
				filesChanged: ["extensions/workflow/delegate/completion-evidence.ts"],
				commandsRun: [],
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
			const doneFile = writeSidecar(tmpDir, "static-only.json", {
				done: true, completion: "explicit", source: "tool", tool: "sub_agent_done",
				at: new Date().toISOString(), exit_code: 0,
				evidence: { coderEvidence: staticOnlyPacket },
			});
			const result = makeDelegateResult({ completionSource: "explicit" as DelegateCompletionSource, doneFile });
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false, "6: static-only/source-string behavior+runtime evidence still blocks");
			check(gate.evaluation.rejectionCodes.includes("static_only_behavior_criterion"), `6: static_only_behavior_criterion reported (got: ${gate.evaluation.rejectionCodes.join(",")})`);
			check(gate.evaluation.diagnostics.weakCriteria.includes("alpha-behavior"), "6: weakCriteria lists alpha-behavior (static-only against behavior-test)");
			check(gate.evaluation.diagnostics.weakCriteria.includes("beta-runtime"), "6: weakCriteria lists beta-runtime (source-string against runtime-gate)");
		}

		// (7) Missing matrix criterion still blocks even with passing commands and explicit sidecar.
		//     TASK-002 tightened: sidecar carries canonical `evidence: { coderEvidence }` envelope.
		{
			const incomplete = { ...completeEvidence };
			incomplete.criterionCoverage = [completeEvidence.criterionCoverage[0]!]; // only alpha
			incomplete.commandsRun = [completeEvidence.commandsRun[0]!];
			const doneFile = writeSidecar(tmpDir, "missing-criterion.json", {
				done: true, completion: "explicit", source: "tool", tool: "sub_agent_done",
				at: new Date().toISOString(), exit_code: 0,
				evidence: { coderEvidence: incomplete },
			});
			const result = makeDelegateResult({ completionSource: "explicit" as DelegateCompletionSource, doneFile });
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false, "7: missing matrix criterion blocks coder_completed");
			check(gate.evaluation.rejectionCodes.includes("missing_criterion"), `7: missing_criterion reported (got: ${gate.evaluation.rejectionCodes.join(",")})`);
			check(gate.evaluation.diagnostics.missingCriteria.includes("beta-runtime"), "7: missingCriteria reports beta-runtime");
			check(gate.evaluation.diagnostics.missingCriteria.includes("gamma-docs"), "7: missingCriteria reports gamma-docs");
		}

		// (8) Failed / retried delegate history is visible in diagnostics and rejection reasons.
		//     TASK-002 tightened: sidecar carries canonical `evidence: { coderEvidence }` envelope.
		{
			const failedPacket = {
				...completeEvidence,
				delegateHistory: {
					attempts: [
						{ attempt: 1, completionSource: "auto_exit", status: "completed",
							finalOutputPreview: "first attempt auto-exited", warning: "no sidecar" },
						{ attempt: 2, completionSource: "process_exit", status: "failed",
							finalOutputPreview: "second attempt process-exited", warning: "build failed" },
						{ attempt: 3, completionSource: "explicit", status: "completed",
							finalOutputPreview: "third attempt explicit", warning: "previous failure" },
					],
					warnings: ["first delegate auto-exited", "second delegate process-exited", "delegate retry triggered"],
					retries: 2,
				},
			};
			const doneFile = writeSidecar(tmpDir, "retry-history.json", {
				done: true, completion: "explicit", source: "tool", tool: "sub_agent_done",
				at: new Date().toISOString(), exit_code: 0,
				evidence: { coderEvidence: failedPacket },
			});
			const result = makeDelegateResult({
				completionSource: "explicit" as DelegateCompletionSource,
				doneFile,
				completionWarning: "delegate retry triggered",
			});
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === true, `8: complete evidence with retry history still advances (reason: ${gate.reason ?? "n/a"})`);
			const history = gate.evaluation.diagnostics.delegateHistory;
			check(history.attempts.length >= 3, `8: delegate history attempts preserved (got: ${history.attempts.length})`);
			const sources = history.attempts.map((a) => a.completionSource);
			check(sources.includes("auto_exit") && sources.includes("process_exit") && sources.includes("explicit"),
				"8: auto_exit + process_exit + explicit attempts visible in diagnostics");
			check(history.retries === 2, `8: retries count visible (got: ${history.retries})`);
			check(history.warnings.length >= 2, "8: warnings array visible in diagnostics");
			// Phase-advancement decision must still be advance, but details surface the history.
			const adv = evaluateCoderPhaseAdvancement(plan, result, { ...result });
			check(adv.kind === "advance", "8: advancement decision advance despite retry history");
			if (adv.kind === "advance") {
				const histAdv = adv.evaluation.diagnostics.delegateHistory;
				check(histAdv.attempts.length === history.attempts.length, "8: advancement helper preserves retry history");
			}
			// Format the rejection text for the missing-criterion case so the runtime text path is covered too.
			const text = formatCoderEvidenceRejectionText({ ...gate, ok: false, reason: "Matrix-gated coder phase requires a structured evidence packet." });
			check(typeof text === "string" && text.length > 0, "8: formatCoderEvidenceRejectionText returns non-empty string");
		}

		// (9) Tiny / admin / debug lightweight exception remains available OUTSIDE matrix-gated plans.
		{
			const draftPlan = makeMatrixGatedPlan({ status: "draft" });
			const result = makeDelegateResult({ completionSource: "legacy" as DelegateCompletionSource });
			const adv = evaluateCoderPhaseAdvancement(draftPlan, result, { ...result }, { lightweightScope: "tiny" });
			check(adv.kind === "advance", "9: tiny lightweight on non-matrix-gated draft plan advances");
			const adminAdv = evaluateCoderPhaseAdvancement(draftPlan, result, { ...result }, { lightweightScope: "admin" });
			check(adminAdv.kind === "advance", "9: admin lightweight on non-matrix-gated draft plan advances");
			const debugAdv = evaluateCoderPhaseAdvancement(draftPlan, result, { ...result }, { lightweightScope: "debug" });
			check(debugAdv.kind === "advance", "9: debug lightweight on non-matrix-gated draft plan advances");
		}

		// (10) Ready matrix-gated plan CANNOT be silently bypassed by the lightweight exception.
		{
			const result = makeDelegateResult({ completionSource: "auto_exit" as DelegateCompletionSource });
			const adv = evaluateCoderPhaseAdvancement(plan, result, { ...result }, { lightweightScope: "tiny" });
			check(adv.kind === "block", "10: tiny lightweight on ready matrix-gated plan is refused (block)");
			if (adv.kind === "block") {
				check(adv.rejectionCodes.includes("lightweight_bypass_refused"), `10: lightweight_bypass_refused reported (got: ${adv.rejectionCodes.join(",")})`);
				check(adv.rejectionCodes.includes("auto_exit_incomplete") || adv.rejectionCodes.includes("free_form_only"),
					"10: ready plan also retains auto_exit/free_form rejection");
			}
		}

		// (11) eval-only matrix plan (ready + matrix rows + no acceptanceCriteria) cannot be
		//      silently bypassed by the lightweight exception either. Regression for
		//      Phase A CHANGES_REQUESTED.
		{
			const evalOnlyPlan = makeMatrixGatedPlan({
				planId: "task-003-eval-only",
				acceptanceCriteria: [],
			});
			const result = makeDelegateResult({ completionSource: "legacy" as DelegateCompletionSource });
			const adv = evaluateCoderPhaseAdvancement(evalOnlyPlan, result, { ...result }, { lightweightScope: "admin" });
			check(adv.kind === "block", "11: admin lightweight on ready + matrix-only plan is refused");
			if (adv.kind === "block") {
				check(adv.rejectionCodes.includes("lightweight_bypass_refused"),
					`11: lightweight_bypass_refused reported (got: ${adv.rejectionCodes.join(",")})`);
			}
		}

		// (12) Sidecar file with malformed JSON is treated as missing (no crash, no false pass).
		{
			const doneFile = path.join(tmpDir, "malformed.json");
			fs.writeFileSync(doneFile, "not-json", "utf8");
			const result = makeDelegateResult({ completionSource: "missing" as DelegateCompletionSource, doneFile });
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false, "12: malformed done sidecar JSON is treated as missing");
			check(gate.evaluation.rejectionCodes.includes("missing_sidecar_incomplete"),
				`12: missing_sidecar_incomplete reported (got: ${gate.evaluation.rejectionCodes.join(",")})`);
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

main();
if (failures > 0) { console.error(`\n${failures} coder evidence gate smoke check(s) failed.`); process.exit(1); }
console.log("\nAll TASK-003 coder completion evidence gate integration smoke checks passed.");
