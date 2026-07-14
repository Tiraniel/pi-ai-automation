#!/usr/bin/env node
// TASK-002 — canonical delegate-evidence wiring smoke checks.
// Focused, deterministic cases that exercise the canonical-only
// authority contract. Under the tightened TASK-002 contract, canonical
// `done.evidence` is the SOLE gate-authoritative path; deprecated
// top-level / summary JSON / nested delegateHistory reviewer-evidence
// paths are diagnostic only and must NOT satisfy coder / reviewer
// advancement. No real delegate launches or panes.
//
// Coverage matrix (all required scenarios in the task description):
//   1. Canonical `done.evidence.coderEvidence` passes the coder gate
//      for pane and headless synthetic results.
//   2. Weak canonical coder evidence does NOT silently fall through to
//      a stronger legacy top-level `coderEvidence` (canonical
//      precedence).
//   3. Legacy top-level `coderEvidence` does NOT satisfy the coder
//      gate (diagnostic only). The hard-cut helper does NOT emit any
//      `deprecated_*` warnings and the gate fails closed with
//      `evidenceProvenance: "none"`.
//   4. `auto_exit` without evidence fails; `process_exit` / missing
//      sidecar fail.
//   5. Canonical `done.evidence.reviewerEvidence` with typed
//      criterionCoverage suppresses provisional `auto_exit` and keeps
//      the required role approved. Also: canonical envelope under
//      `details.done.evidence.reviewerEvidence` is recognized.
//   6. Final text-only APPROVED remains provisional / blocked on a
//      matrix-gated required reviewer role.
//   7. Non-English free-form final output does NOT satisfy reviewer
//      approval (language-independent schema).
//   8. Non-English free-form auto_exit result has no canonical
//      reviewer evidence → resolver returns `found=false`.
//   9. Canonical extraction helper recognizes the canonical envelope
//      shape and surfaces typed payloads with `provenance: "canonical"`
//      and zero legacy-adapter calls.
//  10. Completion tool schema/writer coverage: register the done tools
//      against a fake ExtensionAPI with a temp done file env; assert
//      `sub_agent_done` / `workflow_delegate_done` parameter schema
//      does NOT contain top-level `coderEvidence` or `reviewerEvidence`;
//      execute the tool with canonical `evidence.coderEvidence` and
//      prove sidecar writes `evidence.coderEvidence` and no top-level
//      evidence fields; execute the tool with legacy-only params and
//      prove no top-level fields are written and no `deprecated_*`
//      warning is surfaced (hard-cut).
//  11. Headless completion context: `buildHeadlessChildEnv` clears
//      ALL inherited `PI_WORKFLOW_DELEGATE_*` env vars and overlays
//      the explicit per-spawn context. Two explicit contexts with
//      isolated values do not contaminate each other under a hostile
//      parent `process.env`.
//  12. Headless completion context: `buildChildArgs` enables the
//      `sub_agent_done` tool when an explicit completion context is
//      supplied (no `process.env` handoff).
//  13. Reviewer verdict authority: canonical reviewerEvidence
//      verdict / effectiveVerdict drives the evaluation, NOT
//      parsed final text. Top-level `reviewerEvidence` is NOT
//      canonical and must NOT approve.
//  14. Coder gate rejects legacy-provenance `coder_evidence`
//      EvidenceEvent under `details.evidence.event`; rejects the
//      equivalent EvidenceLedger under `details.evidence.events`;
//      rejects top-level legacy events; accepts canonical events
//      (positive control); and picks the canonical event from a
//      mixed legacy + canonical ledger.
//  15. Reviewer resolver / evaluator rejects legacy-provenance
//      `reviewer_evidence` EvidenceEvent under
//      `details.evidence.event`; rejects the equivalent
//      EvidenceLedger; rejects top-level legacy events; accepts
//      canonical events (positive control).
//  16. Top-level `details.coderEvidence` (no `details.evidence`
//      envelope wrapper) cannot satisfy the coder gate.
//  17. `details.done.summary` JSON with `coderEvidence` cannot
//      satisfy the coder gate.
//  18. Markdown-only reviewer approval (e.g. `finalOutput` contains
//      `# APPROVED` but no canonical reviewerEvidence) does NOT
//      approve.
//  19. Bare sidecar (`{ coderEvidence: {...} }` only, no `done` /
//      `summary` / marker keys / `evidence` envelope) does NOT
//      satisfy the coder gate. The gate's sidecar extraction is
//      narrowed to `sidecar.evidence` / `sidecar.done.evidence` so a
//      bare sidecar cannot accidentally satisfy the gate via the
//      canonical parser's direct-envelope branch.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildChildArgs,
	buildHeadlessChildEnv,
	type DelegateCompletionContext,
} from "../extensions/workflow/delegate/child";
import {
	runCompletionEvidenceGate,
} from "../extensions/workflow/delegate/completion-evidence-gate";
import {
	buildReviewerMemoForResults,
	deriveReviewerRoleTargets,
	evaluateReviewerResult,
	resolveReviewerExplicitEvidence,
} from "../extensions/workflow/delegate/reviewer-roles";
import { extractCanonicalEvidence } from "../extensions/workflow/delegate/canonical-evidence";
import {
	DELEGATE_ACTIVITY_ENV_VAR,
	DELEGATE_DONE_ENV_VAR,
	DELEGATE_RUN_ID_ENV_VAR,
	SUB_AGENT_DONE_TOOL_NAME,
	DELEGATE_DONE_TOOL_NAME,
} from "../extensions/workflow/delegate/constants";
import { registerDelegateDoneTools } from "../extensions/workflow/delegate/done-tools";
import type { AcceptanceEvidenceMatrixEntry, WorkflowArchitecturePlan } from "../extensions/workflow/architecture/types";
import type { DelegateRunResult, UsageStats } from "../extensions/workflow/types";
import type { ReviewerResultLike } from "../extensions/workflow/delegate/reviewer-roles";

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
		requiredEvidence: [{ kind: "behavior-test", description: "covered by behavior test", command: "npx tsx scripts/smoke.ts" }],
		reviewerRoles: ["behavior"],
		blockingConditions: ["behavior test fails"],
		...overrides,
	};
}

function makeMatrixPlan(): WorkflowArchitecturePlan {
	return {
		planId: "task-002-canonical-delegate-evidence",
		taskId: "TASK-002",
		title: "Wire canonical evidence into delegate completion and review gates",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "ready",
		businessPlan: "b",
		technicalPlan: "t",
		parallelAssessment: "serial",
		contractBlockPlan: "c",
		acceptanceCriteria: ["alpha-behavior", "beta-runtime"],
		acceptanceEvidenceMatrix: [
			makeMatrixEntry({
				criterion: "alpha-behavior",
				criterionKind: "runtime-behavior",
				businessRiskIfWrong: "alpha path may regress",
				enforcementLevel: ["behavior-test"],
				requiredEvidence: [{ kind: "behavior-test", description: "alpha behavior test", command: "npx tsx scripts/smoke-alpha.ts" }],
				reviewerRoles: ["behavior"],
				blockingConditions: ["alpha behavior test fails"],
			}),
			makeMatrixEntry({
				criterion: "beta-runtime",
				criterionKind: "runtime-behavior",
				businessRiskIfWrong: "beta path may regress",
				enforcementLevel: ["runtime-gate-test"],
				requiredEvidence: [{ kind: "runtime-gate-test", description: "beta runtime gate", command: "npx tsx scripts/smoke-beta.ts" }],
				reviewerRoles: ["regression"],
				blockingConditions: ["beta runtime gate fails"],
			}),
		],
		phases: {
			phaseA: { status: "review_approved", updatedAt: new Date().toISOString(), evidence: [] },
			phaseB: { status: "not_started", updatedAt: new Date().toISOString(), evidence: [] },
		},
	};
}

type SyntheticDelegateOverrides = Partial<DelegateRunResult> & {
	doneFile?: string;
	details?: Record<string, unknown>;
};

function makeDelegateResult(overrides: SyntheticDelegateOverrides = {}): DelegateRunResult {
	const { doneFile, details, ...rest } = overrides;
	const base: DelegateRunResult = {
		agent: "coder",
		task: "TASK-002 canonical delegate evidence",
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

function makeCompleteCoderEvidence(): Record<string, unknown> {
	return {
		filesChanged: [
			"extensions/workflow/delegate/completion-evidence-gate.ts",
			"extensions/workflow/delegate/reviewer-roles.ts",
		],
		commandsRun: [
			{ command: "npx tsx scripts/smoke-alpha.ts", outcome: "passed", exitCode: 0, summary: "alpha behavior test passes" },
			{ command: "npx tsx scripts/smoke-beta.ts", outcome: "passed", exitCode: 0, summary: "beta runtime gate passes" },
		],
		criterionCoverage: [
			{
				criterion: "alpha-behavior",
				evidenceKind: "behavior-test",
				strength: "sufficient",
				supportingFiles: ["extensions/workflow/delegate/completion-evidence-gate.ts"],
				supportingCommands: ["npx tsx scripts/smoke-alpha.ts"],
				summary: "alpha behavior test passes per synthetic smoke.",
			},
			{
				criterion: "beta-runtime",
				evidenceKind: "runtime-gate",
				strength: "sufficient",
				supportingFiles: ["extensions/workflow/delegate/reviewer-roles.ts"],
				supportingCommands: ["npx tsx scripts/smoke-beta.ts"],
				summary: "beta runtime gate passes per synthetic smoke.",
			},
		],
		knownGaps: [],
		caveats: [],
		summary: "canonical evidence packet",
	};
}

function makeWeakCoderEvidence(): Record<string, unknown> {
	return {
		filesChanged: [],
		commandsRun: [],
		criterionCoverage: [
			{
				criterion: "alpha-behavior",
				evidenceKind: "static-only",
				strength: "weak",
				supportingFiles: [],
				supportingCommands: [],
				summary: "weak static-only evidence for alpha-behavior.",
			},
		],
		knownGaps: ["weak evidence for alpha-behavior"],
		caveats: ["no runtime test executed for alpha-behavior"],
		summary: "weak canonical evidence packet",
	};
}

// ---------- Fake ExtensionAPI for done-tool schema/writer coverage ----------
//
// The done-tool registration reads `process.env[DELEGATE_DONE_ENV_VAR]`
// and calls `pi.registerTool(...)` / `pi.on(...)`. The smoke here
// installs a temp env value before the registration, captures the
// registered tool specs in an in-memory array, and then drives the
// `execute` callback directly so the sidecar writer can be exercised
// without a real Pi runtime.

interface CapturedTool {
	name: string;
	parameters: unknown;
	execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

function captureRegisteredTools(): { tools: CapturedTool[]; fakeApi: any } {
	const tools: CapturedTool[] = [];
	const handlers: Array<{ event: string; handler: (...args: any[]) => any }> = [];
	const fakeApi: any = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.push({ event, handler });
		},
		registerTool(tool: any) {
			tools.push({
				name: tool.name,
				parameters: tool.parameters,
				execute: async (toolCallId: string, params: unknown) => {
					const fakeCtx = { shutdown: () => undefined };
					return await tool.execute(toolCallId, params, undefined, undefined, fakeCtx);
				},
			});
		},
		registerCommand() { /* no-op */ },
		registerShortcut() { /* no-op */ },
		registerFlag() { /* no-op */ },
		getFlag() { return undefined; },
		registerMessageRenderer() { /* no-op */ },
		sendMessage() { /* no-op */ },
		sendUserMessage() { /* no-op */ },
		hasFlag() { return false; },
		appendEntry() { /* no-op */ },
	};
	return { tools, fakeApi };
}

/** Read the property names declared on a TypeBox `Type.Object({...})`
 *  instance. TypeBox stores object property keys under
 *  `schema.properties` and the underlying shape mirrors standard
 *  JSON Schema (with the TypeBox `~kind` discriminator on each
 *  property's value). */
function propertyKeysOfObjectSchema(schema: unknown): string[] {
	if (!schema || typeof schema !== "object") return [];
	const record = schema as Record<string, unknown>;
	const properties = record.properties;
	if (!properties || typeof properties !== "object") return [];
	return Object.keys(properties as Record<string, unknown>);
}

/** Recursively walk a TypeBox schema and return all property names
 *  declared on any `Type.Object` it contains. Lets the smoke assert
 *  that no nested legacy top-level `coderEvidence` / `reviewerEvidence`
 *  fields appear on the registered tool's `parameters` schema. */
function nestedPropertyNames(schema: unknown, seen: Set<object> = new Set()): Set<string> {
	const out = new Set<string>();
	if (!schema || typeof schema !== "object") return out;
	if (seen.has(schema as object)) return out;
	seen.add(schema as object);
	const record = schema as Record<string, unknown>;
	const properties = record.properties;
	if (properties && typeof properties === "object") {
		for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
			out.add(key);
			for (const inner of nestedPropertyNames(value, seen)) out.add(inner);
		}
	}
	// TypeBox Object schemas also expose `~optional`; for `Type.Object`,
	// the `required` array is on the top-level. The walker above already
	// covers property names; nothing else to traverse.
	return out;
}

async function main(): Promise<void> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-002-canonical-evidence-"));
	const previousEnv = {
		[DELEGATE_DONE_ENV_VAR]: process.env[DELEGATE_DONE_ENV_VAR],
		[DELEGATE_ACTIVITY_ENV_VAR]: process.env[DELEGATE_ACTIVITY_ENV_VAR],
		[DELEGATE_RUN_ID_ENV_VAR]: process.env[DELEGATE_RUN_ID_ENV_VAR],
		PI_WORKFLOW_DELEGATE_DISPLAY: process.env.PI_WORKFLOW_DELEGATE_DISPLAY,
	};
	try {
		const plan = makeMatrixPlan();

		// (1) Canonical `done.evidence.coderEvidence` passes the coder
		//     gate for both pane and headless synthetic results. The
		//     sidecar must be a real on-disk file so the gate's
		//     `pickDoneSidecar` reads it, and `result.details.evidence`
		//     is the second transport parity path.
		{
			const completeEvidence = makeCompleteCoderEvidence();
			// 1a: pane transport with canonical envelope in sidecar.
			const doneFileP = writeSidecar(tmpDir, "pane-canonical.json", {
				done: true, completion: "explicit", source: "tool", tool: "sub_agent_done",
				summary: "explicit completion", at: new Date().toISOString(), exit_code: 0,
				evidence: { coderEvidence: completeEvidence },
			});
			const paneResult = makeDelegateResult({ display: "pane", completionSource: "explicit", doneFile: doneFileP });
			const paneGate = runCompletionEvidenceGate(plan, paneResult);
			check(paneGate.ok === true, "1a: pane canonical done.evidence.coderEvidence passes the coder gate");
			check(paneGate.evaluation.rejectionCodes.length === 0,
				`1a: pane canonical has no rejection codes (got: ${paneGate.evaluation.rejectionCodes.join(",")})`);
			check(paneGate.evidenceProvenance === "canonical",
				`1a: evidenceProvenance === "canonical" for pane canonical (got: ${paneGate.evidenceProvenance})`);
			// 1b: headless transport with canonical envelope in details.
			const headlessResult = makeDelegateResult({
				display: "headless", completionSource: "explicit",
				details: { evidence: { coderEvidence: completeEvidence } },
			});
			const headlessGate = runCompletionEvidenceGate(plan, headlessResult);
			check(headlessGate.ok === true, "1b: headless canonical details.evidence.coderEvidence passes the coder gate");
			check(headlessGate.evaluation.rejectionCodes.length === 0,
				`1b: headless canonical has no rejection codes (got: ${headlessGate.evaluation.rejectionCodes.join(",")})`);
			check(headlessGate.evidenceProvenance === "canonical",
				`1b: evidenceProvenance === "canonical" for headless canonical (got: ${headlessGate.evidenceProvenance})`);
		}

		// (2) Weak canonical coder evidence does NOT silently fall
		//     through to a stronger legacy top-level `coderEvidence`
		//     (canonical precedence). The matrix-gated gate must
		//     reject the weak canonical packet even when a sidecar
		//     carries a strong legacy top-level `coderEvidence` for
		//     the same run.
		{
			const strongLegacy = makeCompleteCoderEvidence();
			const weakCanonical = makeWeakCoderEvidence();
			const doneFile = writeSidecar(tmpDir, "weak-canonical-strong-legacy.json", {
				done: true, completion: "explicit", source: "tool", tool: "sub_agent_done",
				summary: "explicit completion", at: new Date().toISOString(), exit_code: 0,
				evidence: { coderEvidence: weakCanonical },
				coderEvidence: strongLegacy, // legacy top-level — should be IGNORED when canonical is present
			});
			const result = makeDelegateResult({ display: "pane", completionSource: "explicit", doneFile });
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false,
				"2: weak canonical coder evidence + strong legacy top-level coderEvidence still fails (canonical precedence)");
			check(gate.evaluation.rejectionCodes.length > 0,
				`2: weak canonical precedence has at least one rejection code (got: ${gate.evaluation.rejectionCodes.join(",")})`);
		}

		// (3) Legacy top-level `coderEvidence` (no canonical envelope)
		//     is NOT a fallback authority under the TASK-002 HARD-CUT
		//     contract. The gate's canonical helper refuses to read
		//     top-level fields on a parsed sidecar, returns
		//     `provenance: "none"`, and the matrix-gated gate consumes
		//     the empty fallback packet — failing closed with the
		//     hard-cut `canonical_coder_evidence_absent` diagnostic on
		//     the delegate history. The previous legacy-adapter
		//     bridge (which used to surface a deprecation marker
		//     and mirror the payload into the gate) has been
		//     DELETED, so the resolver / canonical helper no longer
		//     emits a `deprecated_*` warning.
		{
			const strongLegacy = makeCompleteCoderEvidence();
			const doneFile = writeSidecar(tmpDir, "legacy-only.json", {
				done: true, completion: "explicit", source: "tool", tool: "sub_agent_done",
				summary: "explicit completion", at: new Date().toISOString(), exit_code: 0,
				coderEvidence: strongLegacy, // legacy only — no canonical envelope
			});
			const result = makeDelegateResult({ display: "pane", completionSource: "explicit", doneFile });
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false,
				"3: legacy top-level coderEvidence does NOT satisfy the coder gate (TASK-002 hard-cut)");
			check(gate.evidenceProvenance === "none",
				`3: evidenceProvenance === "none" under hard-cut (got: ${gate.evidenceProvenance})`);
			// Hard-cut diagnostic: the canonical helper refuses legacy
			// fields, the gate consumes the empty fallback packet, and
			// the `canonical_coder_evidence_absent` reason is surfaced
			// on the delegate history so operators see why the gate
			// failed closed. Rejection codes cover the missing-criterion
			// / missing-files / free-form-only set.
			const history = gate.evaluation.diagnostics.delegateHistory;
			const hardCutWarningText = history.warnings.join(" | ");
			check(/canonical_coder_evidence_absent/.test(hardCutWarningText),
				`3: hard-cut diagnostic carries canonical_coder_evidence_absent marker (got: ${hardCutWarningText.slice(0, 200)})`);
			check(gate.evidenceProvenance === "none" && gate.evaluation.rejectionCodes.includes("free_form_only"),
				`3: gate fails closed with free_form_only rejection (got provenance=${gate.evidenceProvenance}, codes=${gate.evaluation.rejectionCodes.join(",")})`);
			check(gate.evidenceWarnings.length === 0,
				`3: evidenceWarnings is empty under hard-cut (legacy adapter bridge deleted) (got: ${gate.evidenceWarnings.join(" | ").slice(0, 200)})`);
		}

		// (4) auto_exit without evidence fails; process_exit / missing
		//     sidecar also fail. Bare free-form / free-form-only
		//     results are not authoritative on a matrix-gated plan.
		{
			// 4a: auto_exit without evidence → fails (auto_exit_incomplete + free_form_only).
			const autoExitResult = makeDelegateResult({
				display: "pane", completionSource: "auto_exit",
				finalOutput: "I think the diff is fine, see attached. evidence packet: ok ok",
			});
			const autoExitGate = runCompletionEvidenceGate(plan, autoExitResult);
			check(autoExitGate.ok === false, "4a: auto_exit without evidence fails the coder gate");
			check(autoExitGate.evaluation.rejectionCodes.includes("auto_exit_incomplete"),
				`4a: auto_exit_incomplete in rejection codes (got: ${autoExitGate.evaluation.rejectionCodes.join(",")})`);
			check(autoExitGate.evaluation.rejectionCodes.includes("free_form_only"),
				`4a: free_form_only in rejection codes (got: ${autoExitGate.evaluation.rejectionCodes.join(",")})`);

			// 4b: process_exit → fails (process_exit_incomplete + free_form_only).
			const processExitResult = makeDelegateResult({
				display: "pane", completionSource: "process_exit",
				finalOutput: "Process exited; no structured evidence attached.",
			});
			const processExitGate = runCompletionEvidenceGate(plan, processExitResult);
			check(processExitGate.ok === false, "4b: process_exit fails the coder gate");
			check(processExitGate.evaluation.rejectionCodes.includes("process_exit_incomplete"),
				`4b: process_exit_incomplete in rejection codes (got: ${processExitGate.evaluation.rejectionCodes.join(",")})`);

			// 4c: missing sidecar → fails (missing_sidecar_incomplete + free_form_only).
			const missingResult = makeDelegateResult({
				display: "pane", completionSource: "missing",
				finalOutput: "No sidecar was written; the runner reported a missing-sidecar state.",
			});
			const missingGate = runCompletionEvidenceGate(plan, missingResult);
			check(missingGate.ok === false, "4c: missing sidecar fails the coder gate");
			check(missingGate.evaluation.rejectionCodes.includes("missing_sidecar_incomplete"),
				`4c: missing_sidecar_incomplete in rejection codes (got: ${missingGate.evaluation.rejectionCodes.join(",")})`);
		}

		// (5) Canonical `done.evidence.reviewerEvidence` with typed
		//     `criterionCoverage` AND an explicit canonical verdict
		//     token suppresses provisional `auto_exit` and keeps the
		//     required role approved. Under the TASK-002 hard-cut,
		//     the canonical verdict authority on the envelope is the
		//     ONLY path that satisfies role-gated approval — typed
		//     `criterionCoverage` alone is necessary but NOT
		//     sufficient; the canonical envelope must also carry an
		//     explicit `effectiveVerdict` / `verdict` token. Free-form
		//     / non-English / Markdown prose is diagnostic only.
		{
			const typedReviewer: ReviewerResultLike = {
				verdict: "APPROVED",
				finalOutput: "APPROVED. Looks good.",
				completionSource: "auto_exit",
				status: "completed",
				details: {
					evidence: {
						reviewerEvidence: {
							effectiveVerdict: "APPROVED",
							verdict: "APPROVED",
							criterionCoverage: [{ criterion: "alpha-behavior", evidenceKind: "behavior-test", summary: "behavior test passed" }],
						},
					},
				},
			};
			const resolved = resolveReviewerExplicitEvidence(typedReviewer);
			check(resolved.found === true,
				"5: resolveReviewerExplicitEvidence found typed canonical reviewer evidence");
			check(resolved.provenance === "canonical",
				`5: provenance === "canonical" (got: ${resolved.provenance})`);
			check(resolved.legacyAdaptersUsed === 0,
				`5: zero legacy adapter calls for canonical envelope (got: ${resolved.legacyAdaptersUsed})`);

			const derivation = buildReviewerMemoForResults(plan, "phaseA", [
				typedReviewer,
				{
					verdict: "APPROVED",
					finalOutput: "APPROVED. The implementation matches the matrix.",
					completionSource: "explicit",
					status: "completed",
					details: {
						evidence: {
							reviewerEvidence: {
								effectiveVerdict: "APPROVED",
								verdict: "APPROVED",
								criterionCoverage: [{ criterion: "beta-runtime", evidenceKind: "runtime-gate", summary: "runtime gate passed" }],
							},
						},
					},
				},
			]);
			const behaviorEval = derivation.evaluations.find((e) => e.role === "behavior");
			check(behaviorEval?.provisional === false,
				`5: behavior role is NOT provisional with typed canonical reviewerEvidence (got: ${behaviorEval?.provisional})`);
			check(behaviorEval?.effectiveVerdict === "APPROVED",
				`5: behavior role stays APPROVED with typed canonical reviewerEvidence (got: ${behaviorEval?.effectiveVerdict})`);
		}

		// (6) Final text-only APPROVED (no structured evidence
		//     anywhere) remains provisional / blocked on a matrix-gated
		//     required reviewer role. The evaluator must NOT infer
		//     approval from prose alone.
		{
			const textOnlyResult: ReviewerResultLike = {
				verdict: "APPROVED",
				finalOutput: "APPROVED. The behavior looks correct. I walked the code and confirmed the render path.",
				completionSource: "auto_exit",
				status: "completed",
			};
			const resolved = resolveReviewerExplicitEvidence(textOnlyResult);
			check(resolved.found === false,
				"6: final text-only APPROVED with auto_exit has no resolved typed reviewer evidence");
			check(resolved.provenance !== "canonical",
				`6: final text-only provenance is NOT canonical (got: ${resolved.provenance})`);

			const derivation = buildReviewerMemoForResults(plan, "phaseA", [textOnlyResult]);
			const behaviorEval = derivation.evaluations.find((e) => e.role === "behavior");
			check(behaviorEval?.provisional === true,
				`6: behavior role with auto_exit + text-only is provisional (got: ${behaviorEval?.provisional})`);
			check(behaviorEval?.effectiveVerdict === "CHANGES_REQUESTED",
				`6: behavior role with auto_exit + text-only is downgraded to CHANGES_REQUESTED (got: ${behaviorEval?.effectiveVerdict})`);
			check(behaviorEval?.blockingReasons.some((r) => /provisional/i.test(r)) === true,
				"6: blocking reasons mention provisional completion source");
		}

		// (7) Non-English free-form APPROVED is NOT sufficient. The
		//     matrix-gated reviewer gate must ignore localized prose
		//     (Spanish, French, German, etc.) and treat the role as
		//     provisional / CHANGES_REQUESTED. The schema is language-
		//     independent: only typed enum/code/array fields satisfy
		//     approval.
		{
			const localizedResults: ReviewerResultLike[] = [
				{ verdict: "APPROVED", finalOutput: "APROBADO. Todo se ve correcto. Las pruebas pasan.",
					completionSource: "auto_exit", status: "completed" },
				{ verdict: "APPROVED", finalOutput: "APPROUVÉ. Tout est correct. Les tests passent.",
					completionSource: "auto_exit", status: "completed" },
				{ verdict: "APPROVED", finalOutput: "GENEHMIGT. Alles ist korrekt. Tests bestanden.",
					completionSource: "auto_exit", status: "completed" },
				{ verdict: "APPROVED", finalOutput: "承認。すべて正しい。テストが合格。",
					completionSource: "auto_exit", status: "completed" },
			];
			for (let i = 0; i < localizedResults.length; i += 1) {
				const result = localizedResults[i];
				const resolved = resolveReviewerExplicitEvidence(result);
				check(resolved.found === false,
					`7.${i + 1}: non-English free-form APPROVED has no canonical reviewer evidence`);
				check(resolved.provenance === "none",
					`7.${i + 1}: non-English provenance is "none" (got: ${resolved.provenance})`);

				const derivation = buildReviewerMemoForResults(plan, "phaseA", [result]);
				const behaviorEval = derivation.evaluations.find((e) => e.role === "behavior");
				check(behaviorEval?.provisional === true,
					`7.${i + 1}: non-English text-only role is provisional (got: ${behaviorEval?.provisional})`);
				check(behaviorEval?.effectiveVerdict === "CHANGES_REQUESTED",
					`7.${i + 1}: non-English text-only role is downgraded to CHANGES_REQUESTED (got: ${behaviorEval?.effectiveVerdict})`);
			}
		}

		// (8) Non-English free-form auto_exit end-to-end against the
		//     canonical gate. The coder gate fails closed on a
		//     matrix-gated plan because there is no canonical
		//     `evidence.coderEvidence` envelope.
		{
			const localized: DelegateRunResult = makeDelegateResult({
				display: "headless", completionSource: "auto_exit",
				finalOutput: "TODO HECHO. La implementación es correcta. prueba pasó.",
			});
			const gate = runCompletionEvidenceGate(plan, localized);
			check(gate.ok === false,
				"8: non-English free-form auto_exit fails the matrix-gated coder gate");
			check(gate.evidenceProvenance === "none",
				`8: non-English free-form provenance is "none" (got: ${gate.evidenceProvenance})`);
		}

		// (9) Canonical extraction helper recognizes the canonical
		//     envelope shape and surfaces typed payloads with
		//     `provenance: "canonical"` and zero legacy-adapter calls.
		{
			const envelope = {
				evidence: {
					coderEvidence: makeCompleteCoderEvidence(),
					reviewerEvidence: { criterionCoverage: [{ criterion: "alpha-behavior" }] },
				},
			};
			const extracted = extractCanonicalEvidence(envelope, {});
			check(extracted.provenance === "canonical",
				`9: canonical envelope extraction has provenance === "canonical" (got: ${extracted.provenance})`);
			check(extracted.usedLegacyAdapter === false,
				"9: canonical envelope extraction does NOT route through the legacy adapter");
			check(extracted.freeFormOnly === false,
				"9: canonical envelope extraction is NOT free-form-only");
		}

		// (10) Done-tool schema / writer coverage. Register the done
		//      tools against a fake ExtensionAPI and assert:
		//        - `sub_agent_done` / `workflow_delegate_done` parameter
		//          schema does NOT declare top-level `coderEvidence` or
		//          `reviewerEvidence` fields. Only `summary` and
		//          `evidence` are accepted on the strict flow.
		//        - Executing with canonical `evidence.coderEvidence`
		//          writes the sidecar with `evidence.coderEvidence`
		//          and no top-level `coderEvidence` / `reviewerEvidence`
		//          fields.
		//        - Executing with legacy top-level `coderEvidence` /
		//          `reviewerEvidence` params does NOT write those
		//          fields to the sidecar (the schema does not declare
		//          them, the writer ignores them, and no
		//          `deprecated_*` warning is surfaced under the
		//          hard-cut contract).
		{
			const doneFile = path.join(tmpDir, "done-tool-sidecar.json");
			process.env[DELEGATE_DONE_ENV_VAR] = doneFile;
			process.env[DELEGATE_ACTIVITY_ENV_VAR] = "";
			process.env[DELEGATE_RUN_ID_ENV_VAR] = "task-002-done-tool-smoke";
			const { tools, fakeApi } = captureRegisteredTools();
			registerDelegateDoneTools(fakeApi);
			const subAgentTool = tools.find((t) => t.name === SUB_AGENT_DONE_TOOL_NAME);
			const delegateDoneTool = tools.find((t) => t.name === DELEGATE_DONE_TOOL_NAME);
			check(Boolean(subAgentTool), "10: sub_agent_done tool registered");
			check(Boolean(delegateDoneTool), "10: workflow_delegate_done tool registered");

			// 10a: top-level parameter schema MUST NOT include
			//       `coderEvidence` or `reviewerEvidence` on either
			//       tool. Only `summary` and `evidence` are accepted.
			for (const tool of [subAgentTool, delegateDoneTool]) {
				if (!tool) continue;
				const topKeys = propertyKeysOfObjectSchema(tool.parameters).sort();
				check(topKeys.length > 0,
					`10a: ${tool.name} parameter schema has declared properties (got: ${JSON.stringify(topKeys)})`);
				check(!topKeys.includes("coderEvidence"),
					`10a: ${tool.name} parameter schema does NOT declare top-level coderEvidence (got keys: ${topKeys.join(",")})`);
				check(!topKeys.includes("reviewerEvidence"),
					`10a: ${tool.name} parameter schema does NOT declare top-level reviewerEvidence (got keys: ${topKeys.join(",")})`);
				check(topKeys.includes("evidence"),
					`10a: ${tool.name} parameter schema declares canonical evidence envelope (got keys: ${topKeys.join(",")})`);
				check(topKeys.includes("summary"),
					`10a: ${tool.name} parameter schema declares summary (got keys: ${topKeys.join(",")})`);
				// Walk nested property names too — `coderEvidence` /
				// `reviewerEvidence` may only appear INSIDE the
				// canonical `evidence` envelope, not on the top-level
				// or any other top-level sub-object.
				const all = nestedPropertyNames(tool.parameters);
				check(all.has("coderEvidence"),
					`10a: ${tool.name} schema references coderEvidence inside the canonical envelope (got all: ${Array.from(all).sort().join(",")})`);
				check(all.has("reviewerEvidence"),
					`10a: ${tool.name} schema references reviewerEvidence inside the canonical envelope (got all: ${Array.from(all).sort().join(",")})`);
			}

			// 10b: executing with canonical `evidence.coderEvidence`
			//       writes the sidecar with `evidence.coderEvidence`
			//       and NO top-level `coderEvidence` /
			//       `reviewerEvidence` fields.
			if (subAgentTool) {
				const completeEvidence = makeCompleteCoderEvidence();
				// Run the tool with canonical params only.
				await subAgentTool.execute("call-1", {
					summary: "task-002 done-tool smoke",
					evidence: { coderEvidence: completeEvidence },
				});
				const sidecarRaw = fs.readFileSync(doneFile, "utf8");
				const sidecar = JSON.parse(sidecarRaw) as Record<string, unknown>;
				check(sidecar.done === true,
					`10b: canonical sub_agent_done sidecar.done === true (got: ${String(sidecar.done)})`);
				check(sidecar.completion === "explicit",
					`10b: canonical sub_agent_done sidecar.completion === "explicit" (got: ${String(sidecar.completion)})`);
				const envelope = (sidecar.evidence ?? {}) as Record<string, unknown>;
				check(envelope.coderEvidence !== undefined,
					"10b: canonical sub_agent_done sidecar writes evidence.coderEvidence");
				check(!("coderEvidence" in sidecar),
					"10b: canonical sub_agent_done sidecar does NOT write top-level coderEvidence");
				check(!("reviewerEvidence" in sidecar),
					"10b: canonical sub_agent_done sidecar does NOT write top-level reviewerEvidence");
				// details emitted by the writer should also omit the
				// legacy-* flags under the hard-cut contract.
				// (The smoke cannot directly inspect details from the
				// tool result because the writer calls ctx.shutdown()
				// via setTimeout; we only need the sidecar shape here.)

				// 10c: legacy top-level `coderEvidence` / `reviewerEvidence`
				//      params are NOT accepted by the schema. The tool
				//      writer does NOT surface any `deprecated_*`
				//      warning, and the sidecar does NOT contain those
				//      fields. The schema does not declare them, so the
				//      writer never sees them as a documented input;
				//      in our smoke we pass them as a "raw params"
				//      object literal to verify the writer still
				//      ignores them.
				const legacySidecarFile = path.join(tmpDir, "done-tool-legacy-sidecar.json");
				fs.writeFileSync(legacySidecarFile, "", "utf8");
				process.env[DELEGATE_DONE_ENV_VAR] = legacySidecarFile;
				await subAgentTool.execute("call-2", {
					summary: "task-002 done-tool legacy smoke",
					coderEvidence: completeEvidence, // legacy top-level
					reviewerEvidence: { criterionCoverage: [{ criterion: "alpha-behavior" }] },
				});
				const legacyRaw = fs.readFileSync(legacySidecarFile, "utf8");
				const legacy = JSON.parse(legacyRaw) as Record<string, unknown>;
				check(!("coderEvidence" in legacy),
					"10c: legacy top-level coderEvidence param does NOT write to sidecar");
				check(!("reviewerEvidence" in legacy),
					"10c: legacy top-level reviewerEvidence param does NOT write to sidecar");
				const legacyEnvelope = (legacy.evidence ?? {}) as Record<string, unknown>;
				check(!("coderEvidence" in legacyEnvelope),
					"10c: legacy top-level coderEvidence param does NOT leak into evidence envelope");
				check(!("reviewerEvidence" in legacyEnvelope),
					"10c: legacy top-level reviewerEvidence param does NOT leak into evidence envelope");
				const legacyWarnings = Array.isArray(legacy.warnings) ? (legacy.warnings as string[]) : [];
				const hasDeprecatedWarning = legacyWarnings.some((w) => /deprecated_(coder|reviewer)_evidence/.test(w));
				check(!hasDeprecatedWarning,
					`10c: hard-cut contract does NOT emit deprecated_* warnings (got warnings: ${legacyWarnings.join(" | ")})`);
			}
		}

		// (11) Headless completion context: `buildHeadlessChildEnv`
		//      clears ALL inherited `PI_WORKFLOW_DELEGATE_*` env vars
		//      and overlays the explicit per-spawn context. Two
		//      explicit contexts with isolated values do not
		//      contaminate each other under a hostile parent
		//      `process.env`.
		{
			const hostDoneFileA = path.join(tmpDir, "hostile-A-done.json");
			const hostActivityA = path.join(tmpDir, "hostile-A-activity.json");
			const hostRunIdA = "hostile-run-A";
			const hostDisplayA = "pane";
			const hostDoneFileB = path.join(tmpDir, "hostile-B-done.json");
			const hostActivityB = path.join(tmpDir, "hostile-B-activity.json");
			const hostRunIdB = "hostile-run-B";
			const hostDisplayB = "headless";

			// Seed hostile parent env with stale / cross-run
			// completion vars BEFORE calling buildHeadlessChildEnv.
			process.env[DELEGATE_DONE_ENV_VAR] = "/stale/parent/done.json";
			process.env[DELEGATE_ACTIVITY_ENV_VAR] = "/stale/parent/activity.json";
			process.env[DELEGATE_RUN_ID_ENV_VAR] = "stale-parent-run";
			process.env.PI_WORKFLOW_DELEGATE_DISPLAY = "stale-parent-display";

			const ctxA: DelegateCompletionContext = {
				enabled: true,
				doneFile: hostDoneFileA,
				activityFile: hostActivityA,
				runId: hostRunIdA,
				display: hostDisplayA,
			};
			const envA = buildHeadlessChildEnv("/tmp/cwd", undefined, ctxA);
			// A receives ONLY its explicit values, with no stale
			// parent pollution.
			check(envA[DELEGATE_DONE_ENV_VAR] === hostDoneFileA,
				`11: hostile context A doneFile is isolated (got: ${String(envA[DELEGATE_DONE_ENV_VAR])})`);
			check(envA[DELEGATE_ACTIVITY_ENV_VAR] === hostActivityA,
				`11: hostile context A activityFile is isolated (got: ${String(envA[DELEGATE_ACTIVITY_ENV_VAR])})`);
			check(envA[DELEGATE_RUN_ID_ENV_VAR] === hostRunIdA,
				`11: hostile context A runId is isolated (got: ${String(envA[DELEGATE_RUN_ID_ENV_VAR])})`);
			check(envA.PI_WORKFLOW_DELEGATE_DISPLAY === hostDisplayA,
				`11: hostile context A display is isolated (got: ${String(envA.PI_WORKFLOW_DELEGATE_DISPLAY)})`);

			const ctxB: DelegateCompletionContext = {
				enabled: true,
				doneFile: hostDoneFileB,
				activityFile: hostActivityB,
				runId: hostRunIdB,
				display: hostDisplayB,
			};
			const envB = buildHeadlessChildEnv("/tmp/cwd", undefined, ctxB);
			// B receives ONLY its own explicit values, with no A
			// cross-contamination.
			check(envB[DELEGATE_DONE_ENV_VAR] === hostDoneFileB,
				`11: hostile context B doneFile is isolated from A (got: ${String(envB[DELEGATE_DONE_ENV_VAR])})`);
			check(envB[DELEGATE_ACTIVITY_ENV_VAR] === hostActivityB,
				`11: hostile context B activityFile is isolated from A (got: ${String(envB[DELEGATE_ACTIVITY_ENV_VAR])})`);
			check(envB[DELEGATE_RUN_ID_ENV_VAR] === hostRunIdB,
				`11: hostile context B runId is isolated from A (got: ${String(envB[DELEGATE_RUN_ID_ENV_VAR])})`);
			check(envB.PI_WORKFLOW_DELEGATE_DISPLAY === hostDisplayB,
				`11: hostile context B display is isolated from A (got: ${String(envB.PI_WORKFLOW_DELEGATE_DISPLAY)})`);

			// And A's env is unchanged after B is computed.
			check(envA[DELEGATE_DONE_ENV_VAR] === hostDoneFileA,
				`11: hostile context A unchanged after B is computed (got: ${String(envA[DELEGATE_DONE_ENV_VAR])})`);
			check(envA[DELEGATE_RUN_ID_ENV_VAR] === hostRunIdA,
				`11: hostile context A runId unchanged after B is computed (got: ${String(envA[DELEGATE_RUN_ID_ENV_VAR])})`);

			// Neither env retains the stale parent values.
			for (const envObj of [envA, envB]) {
				check(envObj[DELEGATE_DONE_ENV_VAR] !== "/stale/parent/done.json",
					"11: stale parent doneFile env var is NOT inherited");
				check(envObj[DELEGATE_ACTIVITY_ENV_VAR] !== "/stale/parent/activity.json",
					"11: stale parent activityFile env var is NOT inherited");
				check(envObj[DELEGATE_RUN_ID_ENV_VAR] !== "stale-parent-run",
					"11: stale parent runId env var is NOT inherited");
				check(envObj.PI_WORKFLOW_DELEGATE_DISPLAY !== "stale-parent-display",
					"11: stale parent display env var is NOT inherited");
			}
		}

		// (12) Headless completion context: `buildChildArgs` enables
		//      the `sub_agent_done` tool when an explicit completion
		//      context is supplied (no `process.env` handoff). The
		//      legacy alias `workflow_delegate_done` is still wired
		//      through the tool registration for older prompts that
		//      reference the old name; the canonical name is what
		//      current runs MUST use.
		{
			const ctx: DelegateCompletionContext = {
				enabled: true,
				doneFile: "/tmp/sidecar.json",
				runId: "task-002-args-smoke",
			};
			// Suppress all preset / room tool allocations to keep
			// this test focused on completion context → tool list.
			const preset = { tools: ["bash"] } as any;
			const args = buildChildArgs("/tmp/cwd", "coder", preset, "task text", null, undefined, false, undefined, ctx);
			const toolsIdx = args.indexOf("--tools");
			check(toolsIdx >= 0 && toolsIdx + 1 < args.length,
				"12: buildChildArgs produces --tools flag with explicit completion context");
			const toolList = toolsIdx >= 0 ? String(args[toolsIdx + 1] ?? "").split(",") : [];
			check(toolList.includes(SUB_AGENT_DONE_TOOL_NAME),
				`12: buildChildArgs tool list includes sub_agent_done (got: ${toolList.join(",")})`);
		}

		// (13) Reviewer verdict authority: canonical reviewerEvidence
		//      verdict / effectiveVerdict drives the evaluation, NOT
		//      parsed final text. The TASK-002 hard-cut makes the
		//      canonical envelope the only approval-authority path.
		//      Top-level `reviewerEvidence` (not under
		//      `details.evidence`) is NOT canonical and must NOT
		//      approve.
		{
			const reviewerPlan = makeMatrixPlan();
			const behaviorTarget = deriveReviewerRoleTargets(reviewerPlan).targets.find((t) => t.role === "behavior");
			check(Boolean(behaviorTarget), "13: behavior role target derived for reviewer verdict authority cases");

			// (a) canonical reviewerEvidence effectiveVerdict CHANGES_REQUESTED
			//     with blockingReasons wins over final-text APPROVED. The
			//     role is downgraded to CHANGES_REQUESTED and the canonical
			//     blocker is included on the evaluation.
			{
				const canonicalChangesRequested: ReviewerResultLike = {
					verdict: "APPROVED",
					finalOutput: "APPROVED. The behavior is correct.",
					completionSource: "explicit",
					status: "completed",
					details: {
						done: {
							evidence: {
								reviewerEvidence: {
									effectiveVerdict: "CHANGES_REQUESTED",
									verdict: "CHANGES_REQUESTED",
									blockingReasons: ["canonical blocker"],
									criterionCoverage: [{ criterion: "alpha-behavior", evidenceKind: "behavior-test", summary: "covered" }],
								},
							},
						},
					},
				};
				const resolvedA = resolveReviewerExplicitEvidence(canonicalChangesRequested);
				check(resolvedA.found === true,
					"13a: canonical reviewerEvidence with effectiveVerdict CHANGES_REQUESTED + blockingReasons is found");
				check(resolvedA.provenance === "canonical",
					`13a: canonical envelope provenance === "canonical" (got: ${resolvedA.provenance})`);
				const evalA = evaluateReviewerResult(behaviorTarget!, canonicalChangesRequested);
				check(evalA.effectiveVerdict === "CHANGES_REQUESTED",
					`13a: canonical CHANGES_REQUESTED wins over final-text APPROVED (got: ${evalA.effectiveVerdict})`);
				check(evalA.verdict === "CHANGES_REQUESTED",
					`13a: evaluation verdict reflects canonical authority (got: ${evalA.verdict})`);
				check(evalA.blockingReasons.includes("canonical blocker"),
					`13a: canonical blockingReasons folded into evaluation (got: ${JSON.stringify(evalA.blockingReasons)})`);
			}

			// (b) canonical reviewerEvidence effectiveVerdict APPROVED with
			//     criterionCoverage wins over final-text CHANGES_REQUESTED.
			//     The role is approved because the canonical verdict is
			//     the only approval authority under the hard-cut.
			{
				const canonicalApproved: ReviewerResultLike = {
					verdict: "CHANGES_REQUESTED",
					finalOutput: "CHANGES_REQUESTED. I do not think this is correct.",
					completionSource: "explicit",
					status: "completed",
					details: {
						done: {
							evidence: {
								reviewerEvidence: {
									effectiveVerdict: "APPROVED",
									verdict: "APPROVED",
									criterionCoverage: [{ criterion: "alpha-behavior", evidenceKind: "behavior-test", summary: "behavior test passed" }],
								},
							},
						},
					},
				};
				const resolvedB = resolveReviewerExplicitEvidence(canonicalApproved);
				check(resolvedB.found === true,
					"13b: canonical reviewerEvidence with effectiveVerdict APPROVED + criterionCoverage is found");
				const evalB = evaluateReviewerResult(behaviorTarget!, canonicalApproved);
				check(evalB.effectiveVerdict === "APPROVED",
					`13b: canonical APPROVED wins over final-text CHANGES_REQUESTED (got: ${evalB.effectiveVerdict})`);
				check(evalB.verdict === "APPROVED",
					`13b: evaluation verdict reflects canonical APPROVED (got: ${evalB.verdict})`);
			}

			// (c) top-level `reviewerEvidence` (NOT under details.evidence)
			//     with effectiveVerdict APPROVED and criterionCoverage
			//     must NOT approve. The resolver refuses non-canonical
			//     locations, so `found === false`, the canonical verdict
			//     authority is absent, and final-text APPROVED alone
			//     cannot satisfy role-gated approval.
			{
				const topLevelEvidence: ReviewerResultLike = {
					verdict: "APPROVED",
					finalOutput: "APPROVED. The behavior is correct.",
					completionSource: "explicit",
					status: "completed",
					reviewerEvidence: {
						effectiveVerdict: "APPROVED",
						verdict: "APPROVED",
						criterionCoverage: [{ criterion: "alpha-behavior", evidenceKind: "behavior-test", summary: "covered" }],
					},
				};
				const resolvedC = resolveReviewerExplicitEvidence(topLevelEvidence);
				check(resolvedC.found === false,
					`13c: top-level reviewerEvidence (no details.evidence) is NOT canonical (got: ${resolvedC.found})`);
				check(resolvedC.provenance === "none",
					`13c: top-level reviewerEvidence provenance === "none" (got: ${resolvedC.provenance})`);
				const evalC = evaluateReviewerResult(behaviorTarget!, topLevelEvidence);
				check(evalC.effectiveVerdict !== "APPROVED",
					`13c: top-level reviewerEvidence does NOT approve (got: ${evalC.effectiveVerdict})`);
				check(evalC.blockingReasons.some((r) => /canonical reviewerEvidence verdict|UNKNOWN/i.test(r)) === true,
					`13c: blocking reasons mention missing canonical reviewerEvidence verdict (got: ${evalC.blockingReasons.join("; ")})`);
			}
		}

		// (14) Coder gate rejects legacy-provenance coder_evidence
		//      events placed under `details.evidence.event` or
		//      `details.evidence.events` (EvidenceLedger-shaped). The
		//      canonical helper MUST filter on `provenance ===
		//      "canonical"`; a TASK-001 legacy-import event with a
		//      complete payload (or a ledger whose only coder event
		//      is legacy) cannot become gate authority. The
		//      resulting extraction is empty, the gate's
		//      `evidenceProvenance` is `"none"`, and the matrix-
		//      gated plan fails closed.
		{
			const completeEvidence = makeCompleteCoderEvidence();
			const legacyCoderEvent = {
				eventId: "ev-legacy-coder-1",
				runId: "task-002-legacy-coder-event",
				kind: "coder_evidence",
				provenance: "legacy",
				status: "accepted",
				recordedAt: new Date().toISOString(),
				context: { runId: "task-002-legacy-coder-event" },
				warnings: [],
				payload: completeEvidence,
			};

			// 14a: legacy coder_evidence event under
			//      `details.evidence.event`. The pickStructuredResultDetails
			//      helper picks up the envelope (it has `event`), the
			//      canonical extractor recurses into the event, the
			//      provenance check fires, and the gate fails closed.
			{
				const result = makeDelegateResult({
					display: "headless", completionSource: "explicit",
					details: { evidence: { event: legacyCoderEvent } },
				});
				const gate = runCompletionEvidenceGate(plan, result);
				check(gate.ok === false,
					"14a: legacy coder event under details.evidence.event does NOT satisfy coder gate");
				check(gate.evidenceProvenance === "none",
					`14a: evidenceProvenance === "none" for legacy coder event (got: ${gate.evidenceProvenance})`);
				check(gate.evidenceProvenance === "none" && gate.evaluation.rejectionCodes.includes("free_form_only"),
					`14a: gate fails closed with free_form_only rejection (got provenance=${gate.evidenceProvenance}, codes=${gate.evaluation.rejectionCodes.join(",")})`);
			}

			// 14b: legacy coder_evidence event in an EvidenceLedger
			//      under `details.evidence.events`. Test the canonical
			//      helper directly (the pickStructuredResultDetails
			//      helper does not yet recognize the `events` key, so
			//      the gate layer is the second line of defense). The
			//      ledger is the canonical path the reviewer required
			//      to cover.
			{
				const directExtraction = extractCanonicalEvidence(
					{ evidence: { events: [legacyCoderEvent] } },
					{},
				);
				check(directExtraction.provenance === "none",
					`14b: extractCanonicalEvidence rejects legacy coder ledger (got: ${directExtraction.provenance})`);
				check(directExtraction.coderEvidence === undefined,
					"14b: extractCanonicalEvidence coderEvidence is undefined for legacy coder ledger");
				check(directExtraction.freeFormOnly === true,
					"14b: extractCanonicalEvidence freeFormOnly === true for legacy coder ledger");

				// Also drive the result through the gate: even when the
				// structured-result picker does not surface the ledger
				// (no recognized envelope key), the gate must fail
				// closed because there is no canonical envelope.
				const result = makeDelegateResult({
					display: "headless", completionSource: "explicit",
					details: { evidence: { events: [legacyCoderEvent] } },
				});
				const gate = runCompletionEvidenceGate(plan, result);
				check(gate.ok === false,
					"14b: legacy coder ledger under details.evidence.events does NOT satisfy coder gate");
				check(gate.evidenceProvenance === "none",
					`14b: gate evidenceProvenance === "none" for legacy ledger (got: ${gate.evidenceProvenance})`);
			}

			// 14c: top-level legacy coder_evidence event passed
			//      directly into the canonical extractor (no envelope
			//      wrapper). The provenance check must reject it.
			{
				const directExtraction = extractCanonicalEvidence(legacyCoderEvent, {});
				check(directExtraction.provenance === "none",
					`14c: extractCanonicalEvidence rejects top-level legacy coder event (got: ${directExtraction.provenance})`);
				check(directExtraction.coderEvidence === undefined,
					"14c: extractCanonicalEvidence coderEvidence is undefined for top-level legacy coder event");
			}

			// 14d: positive control — the same event shape with
			//      `provenance === "canonical"` IS accepted by the
			//      canonical extractor (no regression on the canonical
			//      path).
			{
				const canonicalCoderEvent = { ...legacyCoderEvent, provenance: "canonical" };
				const directExtraction = extractCanonicalEvidence(canonicalCoderEvent, {});
				check(directExtraction.provenance === "canonical",
					`14d: extractCanonicalEvidence accepts canonical coder event (got: ${directExtraction.provenance})`);
				check(Boolean(directExtraction.coderEvidence),
					"14d: extractCanonicalEvidence coderEvidence is the payload for canonical coder event");
			}

			// 14e: ledger with a mix of legacy and canonical events.
			//      The ledger must pick the canonical event and ignore
			//      the legacy one.
			{
				const canonicalCoderEvent = { ...legacyCoderEvent, provenance: "canonical" };
				const directExtraction = extractCanonicalEvidence(
					{ events: [legacyCoderEvent, canonicalCoderEvent] },
					{},
				);
				check(directExtraction.provenance === "canonical",
					`14e: extractCanonicalEvidence accepts mixed ledger (got: ${directExtraction.provenance})`);
				check(directExtraction.coderEvidence === canonicalCoderEvent.payload,
					"14e: extractCanonicalEvidence surfaces the canonical event's payload from a mixed ledger");
			}
		}

		// (15) Reviewer resolver / evaluator rejects legacy-provenance
		//      reviewer_evidence events placed under
		//      `details.evidence.event` (and the equivalent
		//      EvidenceLedger shape). The resolver must return
		//      `found === false` and `provenance === "none"`; the
		//      role evaluator must not approve, and must surface the
		//      canonical-evidence-missing blocker.
		{
			const completeReviewerEvidence = {
				role: "behavior",
				verdict: "APPROVED",
				effectiveVerdict: "APPROVED",
				blockingReasons: [],
				weakEvidence: [],
				promptOnlyCaveats: [],
				unresolvedRisks: [],
				criterionCoverage: [
					{ criterion: "alpha-behavior", evidenceKind: "behavior-test", summary: "behavior test passed" },
				],
			};
			const legacyReviewerEvent = {
				eventId: "ev-legacy-reviewer-1",
				runId: "task-002-legacy-reviewer-event",
				kind: "reviewer_evidence",
				provenance: "legacy",
				status: "accepted",
				recordedAt: new Date().toISOString(),
				context: { runId: "task-002-legacy-reviewer-event" },
				warnings: [],
				payload: completeReviewerEvidence,
			};

			const reviewerPlan = makeMatrixPlan();
			const derivation = deriveReviewerRoleTargets(reviewerPlan);
			const behaviorTarget = derivation.targets.find((t) => t.role === "behavior")!;

			// 15a: legacy reviewer event under details.evidence.event.
			{
				const resultLike: ReviewerResultLike = {
					verdict: "APPROVED",
					finalOutput: "APPROVED. Looks good.",
					completionSource: "auto_exit",
					status: "completed",
					details: { evidence: { event: legacyReviewerEvent } },
				};
				const resolved = resolveReviewerExplicitEvidence(resultLike);
				check(resolved.found === false,
					"15a: legacy reviewer event is NOT found by resolveReviewerExplicitEvidence");
				check(resolved.provenance === "none",
					`15a: resolveReviewerExplicitEvidence provenance === "none" (got: ${resolved.provenance})`);
				const evalResult = evaluateReviewerResult(behaviorTarget, resultLike);
				check(evalResult.effectiveVerdict !== "APPROVED",
					`15a: legacy reviewer event does NOT approve (got: ${evalResult.effectiveVerdict})`);
				check(evalResult.provisional === true,
					`15a: legacy reviewer event with auto_exit stays provisional (got: ${evalResult.provisional})`);
				check(evalResult.blockingReasons.length > 0,
					"15a: legacy reviewer event surfaces canonical-missing blocker");
			}

			// 15b: legacy reviewer event ledger under details.evidence.events.
			{
				const directExtraction = extractCanonicalEvidence(
					{ evidence: { events: [legacyReviewerEvent] } },
					{},
				);
				check(directExtraction.provenance === "none",
					`15b: extractCanonicalEvidence rejects legacy reviewer ledger (got: ${directExtraction.provenance})`);
				check(directExtraction.reviewerEvidence === undefined,
					"15b: extractCanonicalEvidence reviewerEvidence is undefined for legacy reviewer ledger");
				const resultLike: ReviewerResultLike = {
					verdict: "APPROVED",
					finalOutput: "APPROVED. Looks good.",
					completionSource: "auto_exit",
					status: "completed",
					details: { evidence: { events: [legacyReviewerEvent] } },
				};
				const resolved = resolveReviewerExplicitEvidence(resultLike);
				check(resolved.found === false,
					"15b: legacy reviewer ledger is NOT found by resolveReviewerExplicitEvidence");
				const evalResult = evaluateReviewerResult(behaviorTarget, resultLike);
				check(evalResult.effectiveVerdict !== "APPROVED",
					`15b: legacy reviewer ledger does NOT approve (got: ${evalResult.effectiveVerdict})`);
			}

			// 15c: top-level legacy reviewer event.
			{
				const directExtraction = extractCanonicalEvidence(legacyReviewerEvent, {});
				check(directExtraction.provenance === "none",
					`15c: extractCanonicalEvidence rejects top-level legacy reviewer event (got: ${directExtraction.provenance})`);
				check(directExtraction.reviewerEvidence === undefined,
					"15c: extractCanonicalEvidence reviewerEvidence is undefined for top-level legacy reviewer event");
			}

			// 15d: positive control — canonical-provenance reviewer
			//      event is accepted (no regression on the canonical
			//      path).
			{
				const canonicalReviewerEvent = { ...legacyReviewerEvent, provenance: "canonical" };
				const resultLike: ReviewerResultLike = {
					verdict: "APPROVED",
					finalOutput: "APPROVED. Looks good.",
					completionSource: "auto_exit",
					status: "completed",
					details: { evidence: { event: canonicalReviewerEvent } },
				};
				const resolved = resolveReviewerExplicitEvidence(resultLike);
				check(resolved.found === true,
					"15d: canonical reviewer event IS found by resolveReviewerExplicitEvidence");
				check(resolved.provenance === "canonical",
					`15d: resolveReviewerExplicitEvidence provenance === "canonical" (got: ${resolved.provenance})`);
			}
		}

		// (16) Top-level `details.coderEvidence` (no `details.evidence`
		//      envelope wrapper) cannot satisfy the coder gate. The
		//      gate's pickStructuredResultDetails helper does NOT
		//      recognize top-level `details.coderEvidence`; the
		//      canonical extractor therefore sees no canonical
		//      envelope and returns the empty extraction. The
		//      matrix-gated gate fails closed.
		{
			const completeEvidence = makeCompleteCoderEvidence();
			const result = makeDelegateResult({
				display: "headless", completionSource: "explicit",
				details: { coderEvidence: completeEvidence },
			});
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false,
				"16: top-level details.coderEvidence (no canonical envelope) does NOT satisfy coder gate");
			check(gate.evidenceProvenance === "none",
				`16: evidenceProvenance === "none" for top-level details.coderEvidence (got: ${gate.evidenceProvenance})`);
			check(gate.evaluation.rejectionCodes.includes("free_form_only"),
				`16: free_form_only in rejection codes (got: ${gate.evaluation.rejectionCodes.join(",")})`);
		}

		// (17) `details.done.summary` JSON with `coderEvidence` cannot
		//      satisfy the coder gate. The structured result picker
		//      looks for `details.evidence` / `details.done.evidence`,
		//      not `summary`; the canonical extractor sees no
		//      canonical envelope and returns the empty extraction.
		{
			const completeEvidence = makeCompleteCoderEvidence();
			const summaryJson = JSON.stringify({ coderEvidence: completeEvidence });
			const result = makeDelegateResult({
				display: "headless", completionSource: "explicit",
				details: { done: { summary: summaryJson } },
			});
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false,
				"17: details.done.summary JSON with coderEvidence does NOT satisfy coder gate");
			check(gate.evidenceProvenance === "none",
				`17: evidenceProvenance === "none" for summary JSON (got: ${gate.evidenceProvenance})`);
			check(gate.evaluation.rejectionCodes.includes("free_form_only"),
				`17: free_form_only in rejection codes (got: ${gate.evaluation.rejectionCodes.join(",")})`);
			// And the canonical helper must also refuse to parse the
			// summary JSON as authoritative.
			const directExtraction = extractCanonicalEvidence({ done: { summary: summaryJson } }, {});
			check(directExtraction.provenance === "none",
				`17: extractCanonicalEvidence rejects summary JSON (got: ${directExtraction.provenance})`);
			check(directExtraction.coderEvidence === undefined,
				"17: extractCanonicalEvidence coderEvidence is undefined for summary JSON");
		}

		// (18) Markdown-only reviewer approval does NOT approve. A
		//      finalOutput that starts with `# APPROVED` (Markdown
		//      heading) is parsed by `parseReviewerVerdict` as
		//      APPROVED, but the role evaluator must derive the
		//      verdict from canonical reviewerEvidence, not from the
		//      final text. With no canonical envelope, the resolver
		//      returns `found === false` and the evaluator must
		//      downgrade the role to CHANGES_REQUESTED and surface
		//      the canonical-missing blocker.
		{
			const reviewerPlan = makeMatrixPlan();
			const derivation = deriveReviewerRoleTargets(reviewerPlan);
			const behaviorTarget = derivation.targets.find((t) => t.role === "behavior")!;

			// 18a: Markdown-style APPROVED with no canonical envelope
			//      and the swarm's parsed verdict set to APPROVED.
			{
				const markdownOnly: ReviewerResultLike = {
					verdict: "APPROVED", // simulate parseReviewerVerdict on "# APPROVED"
					finalOutput: "# APPROVED\n- criterionCoverage: alpha-behavior tested\n- commandsRun: smoke passed",
					completionSource: "explicit",
					status: "completed",
				};
				const resolved = resolveReviewerExplicitEvidence(markdownOnly);
				check(resolved.found === false,
					"18a: markdown-only finalOutput has no canonical reviewer evidence");
				check(resolved.provenance === "none",
					`18a: resolveReviewerExplicitEvidence provenance === "none" (got: ${resolved.provenance})`);
				const evalResult = evaluateReviewerResult(behaviorTarget, markdownOnly);
				check(evalResult.effectiveVerdict !== "APPROVED",
					`18a: markdown-only finalOutput does NOT approve (got: ${evalResult.effectiveVerdict})`);
				check(evalResult.effectiveVerdict === "CHANGES_REQUESTED",
					`18a: markdown-only finalOutput is downgraded to CHANGES_REQUESTED (got: ${evalResult.effectiveVerdict})`);
				check(evalResult.blockingReasons.length > 0,
					"18a: markdown-only finalOutput surfaces canonical-missing blocker");
			}

			// 18b: same Markdown payload but completion source
			//      `auto_exit` — must remain provisional and block.
			{
				const markdownAutoExit: ReviewerResultLike = {
					verdict: "APPROVED",
					finalOutput: "# APPROVED\n- criterionCoverage: alpha-behavior tested",
					completionSource: "auto_exit",
					status: "completed",
				};
				const evalResult = evaluateReviewerResult(behaviorTarget, markdownAutoExit);
				check(evalResult.effectiveVerdict !== "APPROVED",
					`18b: markdown auto_exit does NOT approve (got: ${evalResult.effectiveVerdict})`);
				check(evalResult.provisional === true,
					`18b: markdown auto_exit stays provisional (got: ${evalResult.provisional})`);
			}

			// 18c: positive control — same Markdown finalOutput
			//      shape with a canonical envelope IS approved
			//      (proves the Markdown format itself is not the
			//      reason for the rejection above).
			{
				const markdownWithCanonical: ReviewerResultLike = {
					verdict: "APPROVED",
					finalOutput: "# APPROVED\n- criterionCoverage: alpha-behavior tested",
					completionSource: "explicit",
					status: "completed",
					details: {
						evidence: {
							reviewerEvidence: {
								verdict: "APPROVED",
								effectiveVerdict: "APPROVED",
								criterionCoverage: [
									{ criterion: "alpha-behavior", evidenceKind: "behavior-test", summary: "behavior test passed" },
								],
							},
						},
					},
				};
				const evalResult = evaluateReviewerResult(behaviorTarget, markdownWithCanonical);
				check(evalResult.effectiveVerdict === "APPROVED",
					`18c: markdown with canonical envelope stays APPROVED (got: ${evalResult.effectiveVerdict})`);
				check(evalResult.provisional === false,
					`18c: markdown with canonical envelope is NOT provisional (got: ${evalResult.provisional})`);
			}
		}

		// (19) Bare sidecar (no `done`, no `summary`, no marker keys,
		//      no `evidence` envelope) carrying only top-level
		//      `coderEvidence` does NOT satisfy the coder gate.
		//
		//      TASK-002 hard-cut fix #2: a parsed done sidecar whose
		//      entire JSON body is `{ coderEvidence: {...} }` has no
		//      canonical envelope location AND no sidecar markers.
		//      Previously, `runCanonicalExtraction` passed the whole
		//      sidecar into `extractCanonicalEvidence`, whose direct-
		//      envelope branch promoted the top-level `coderEvidence`
		//      to canonical authority and the gate passed. The fix
		//      narrows the gate's sidecar extraction to
		//      `sidecar.evidence` (or `sidecar.done.evidence`) only;
		//      bare sidecars therefore fail closed. This sub-section
		//      keeps the existing top-level sidecar-with-markers case
		//      (3) intact and adds the bare sidecar coverage here.
		{
			const completeEvidence = makeCompleteCoderEvidence();
			// Write a doneFile whose entire JSON body is
			// `{ coderEvidence: completeEvidence }`. No `done`, no
			// `summary`, no `at` / `tool` / `completion` / `exit_code`
			// marker keys, no `evidence` envelope.
			const doneFile = writeSidecar(tmpDir, "bare-sidecar.json", {
				coderEvidence: completeEvidence,
			});
			const result = makeDelegateResult({
				display: "pane",
				completionSource: "explicit",
				doneFile,
			});
			const gate = runCompletionEvidenceGate(plan, result);
			check(gate.ok === false,
				"19: bare sidecar ({ coderEvidence } only) does NOT satisfy the coder gate");
			check(gate.evidenceProvenance === "none",
				`19: evidenceProvenance === "none" for bare sidecar (got: ${gate.evidenceProvenance})`);
			// The rejection code set must include `free_form_only`
			// (no canonical envelope was extracted) or the missing-
			// criteria set. Either is acceptable per the hard-cut
			// contract; the gate fails closed either way.
			const codes = gate.evaluation.rejectionCodes;
			const hasFreeFormOrMissing =
				codes.includes("free_form_only")
				|| codes.includes("missing_criterion_coverage")
				|| codes.includes("missing_criteria")
				|| gate.evaluation.diagnostics.missingCriteria.length > 0;
			check(hasFreeFormOrMissing,
				`19: gate fails closed with free_form_only or missing-criteria codes (got: ${codes.join(",")})`);
		}
	} finally {
		// Restore the parent process.env to the values we observed
		// on entry. The smoke must not leak hostile env values into
		// other test fixtures.
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

main().then(() => {
	if (failures > 0) {
		console.error(`\n${failures} task-002 canonical delegate-evidence smoke check(s) failed.`);
		process.exit(1);
	}
	console.log("\nAll TASK-002 canonical delegate-evidence smoke checks passed.");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
