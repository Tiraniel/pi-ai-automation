// TASK-003 Phase B — integration helper that wires the coder completion
// evidence validator (extensions/workflow/delegate/completion-evidence.ts)
// into the shared `delegate_to_coder` phase-advancement boundary.
//
// `runCompletionEvidenceGate(plan, result, options)` reads pane `doneFile`
// sidecars and supported structured result details, normalizes them via
// `normalizeCoderCompletionEvidence`, then runs the matrix-gated evaluator.
// It is the single gate used by both pane and headless transports so the
// strict evidence contract applies uniformly to ready architecture plans.
//
// This module also exposes the formatter helpers used by `tools.ts` to
// surface the rejection codes in the tool result text/details. Tiny / admin
// / debug lightweight behavior is preserved: the strict gate only fires
// on `isMatrixGated === true` plans; otherwise the call is a no-op.
//
// TASK-002 HARD-CUT: `done.evidence` is the SOLE gate-authoritative
// evidence path. The gate reads only the canonical
// `done.evidence.coderEvidence` (or `result.details.evidence.coderEvidence`
// or `result.details.done.evidence.coderEvidence`) envelope. Deprecated
// top-level `coderEvidence` / summary JSON / `reviewerEvidence` /
// nested delegateHistory shapes are NOT a fallback authority: they are
// diagnostic only. When canonical evidence is absent, the gate consumes
// the EMPTY fallback packet and `evidenceProvenance` is reported as
// `"none"`; the matrix-gated plan fails closed. The previous
// `importLegacyEvidence` / `pickLegacyCoderEvidence` adapter fallback
// has been DELETED from this module — the gate no longer runs the
// legacy adapter to surface warnings or to mirror a payload.

import * as fs from "node:fs";
import type { DelegateCompletionSource, DelegateRunResult } from "../types";
import type { WorkflowArchitecturePlan } from "../architecture/types";
import {
	canUseLightweightEvidenceCheck,
	evaluateCoderCompletionEvidence,
	isMatrixGated,
	normalizeCoderCompletionEvidence,
	type CoderCompletionEvidence,
	type CoderEvidenceEvaluation,
	type CoderEvidencePlanShape,
} from "./completion-evidence";
import { extractCanonicalEvidence, type CanonicalExtraction } from "./canonical-evidence";

export type CoderEvidenceStructuredSource =
	| "explicit-structured"
	| "headless-structured"
	| "pane-structured"
	| "free-form-only"
	| "none";

export interface CoderEvidenceGateResult {
	ok: boolean;
	evaluation: CoderEvidenceEvaluation;
	packet: CoderCompletionEvidence | undefined;
	normalizeIssues: ReturnType<typeof normalizeCoderCompletionEvidence>["issues"];
	structuredSource: CoderEvidenceStructuredSource;
	reason: string | undefined;
	// TASK-002 HARD-CUT: provenance of the coder evidence the gate
	// actually consumed as authority. `"canonical"` when the canonical
	// `done.evidence.coderEvidence` envelope was used; `"none"` when
	// no structured payload was found. The previous `"legacy"`
	// value (legacy-adapter mirror) has been DELETED: the gate no
	// longer runs the legacy adapter to mirror a payload, so the
	// provenance is now strictly binary (canonical / none).
	evidenceProvenance: "canonical" | "none";
	// TASK-002 HARD-CUT: warnings surfaced by the canonical helper and
	// the absent-canonical diagnostic. The matrix-gated evaluator
	// surfaces these on the diagnostic `delegateHistory.warnings` path;
	// the gate details expose them as `evidenceWarnings` so callers can
	// show the canonical-evidence-missing reason on tool details / logs.
	// The previous legacy-adapter warnings are no longer produced by
	// this gate.
	evidenceWarnings: string[];
	// Convenience flags surfaced to tool details / logs.
	autoExitObserved: boolean;
	processExitObserved: boolean;
	missingSidecarObserved: boolean;
	freeFormOnlyObserved: boolean;
}

export interface RunCompletionEvidenceGateOptions {
	/** When true, the gate also requires filesChanged and commandsRun in the
	 *  packet before it can pass. The default is true so the strict contract
	 *  applies to every ready matrix-gated coder phase. */
	requireFilesAndCommands?: boolean;
	/** Optional explicit lightweight scope (tiny/admin/debug). The gate
	 *  refuses lightweight on matrix-gated plans. */
	lightweightScope?: "tiny" | "admin" | "debug";
}

function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
	return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function pickDoneSidecar(result: DelegateRunResult): unknown {
	const file = typeof result.doneFile === "string" ? result.doneFile.trim() : "";
	if (!file) return undefined;
	try {
		const raw = fs.readFileSync(file, "utf8");
		if (!raw.trim()) return undefined;
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

function pickStructuredResultDetails(result: DelegateRunResult): unknown {
	// Future-proof: if a runner surfaces structured coderEvidence on the
	// result (e.g. through a headless structured output channel), the gate
	// must accept it. Free-form finalOutput text is intentionally NOT used.
	const record = asRecord(result as unknown);
	if (!record) return undefined;
	const details = asRecord(record.details);
	if (!details) return undefined;
	// TASK-002 HARD-CUT: only the canonical envelope is recognized. The
	// gate consumes either `result.details.evidence` (runner-attached
	// envelope) or `result.details.done.evidence` (parsed sidecar mirrored
	// on details). Top-level `details.coderEvidence` is NOT canonical
	// and is intentionally NOT picked up here so the canonical
	// extractor cannot accidentally promote it.
	const envelope = asRecord(details.evidence);
	if (envelope && ("coderEvidence" in envelope || "reviewerEvidence" in envelope || "event" in envelope)) {
		return details.evidence;
	}
	const done = asRecord(details.done);
	const doneEnvelope = done ? asRecord(done.evidence) : undefined;
	if (doneEnvelope && ("coderEvidence" in doneEnvelope || "reviewerEvidence" in doneEnvelope || "event" in doneEnvelope)) {
		return doneEnvelope;
	}
	return undefined;
}

/** Run the canonical envelope parser against the sidecar or the
 *  recognized canonical envelope on result details. Returns the typed
 *  extraction so the caller can inspect `coderEvidence`, `provenance`,
 *  `warnings`, etc. Under the TASK-002 hard-cut, the helper no longer
 *  routes through the legacy-import adapter: any non-canonical input
 *  returns `provenance: "none"` and the gate fails closed.
 *
 *  Sidecar-handling contract (TASK-002 hard-cut fix #2): when the
 *  runner hands us a parsed done sidecar, the gate only accepts
 *  `sidecar.evidence` (or, if a writer ever nests the envelope
 *  that way, `sidecar.done.evidence`) as canonical authority. The
 *  gate MUST NOT pass the whole sidecar object to
 *  `extractCanonicalEvidence`, because a bare sidecar whose JSON body
 *  is e.g. `{ "coderEvidence": { ... } }` (no `done`, no `summary`,
 *  no marker keys, no `evidence`) has no sidecar markers and the
 *  canonical parser's direct-envelope branch would otherwise promote
 *  the top-level `coderEvidence` to canonical authority — i.e. a
 *  legacy field would silently satisfy the gate. The whole `sidecar`
 *  is therefore extracted by canonical envelope location only. If
 *  neither `sidecar.evidence` nor `sidecar.done.evidence` is
 *  present, the helper returns the empty extraction. The direct-
 *  envelope support in `extractCanonicalEvidence` itself is
 *  preserved for callers that pass an already-extracted
 *  `details.evidence` / `done.evidence` object (the second branch
 *  below). */
function runCanonicalExtraction(result: DelegateRunResult, sidecar: unknown): CanonicalExtraction {
	if (sidecar !== undefined) {
		const sidecarRecord = asRecord(sidecar);
		if (sidecarRecord) {
			const envelope = asRecord(sidecarRecord.evidence);
			if (envelope) {
				return extractCanonicalEvidence(envelope);
			}
			const done = asRecord(sidecarRecord.done);
			const doneEnvelope = done ? asRecord(done.evidence) : undefined;
			if (doneEnvelope) {
				return extractCanonicalEvidence(doneEnvelope);
			}
		}
		// No canonical envelope location on the sidecar (e.g. a bare
		// sidecar like `{ "coderEvidence": {...} }` with no marker
		// keys and no `evidence` envelope). The whole sidecar is
		// NOT passed to `extractCanonicalEvidence`; the helper
		// returns the empty extraction so the matrix-gated gate
		// fails closed.
		return {
			coderEvidence: undefined,
			reviewerEvidence: undefined,
			provenance: "none",
			usedLegacyAdapter: false,
			warnings: [],
			freeFormOnly: true,
		};
	}
	const structuredEnvelope = pickStructuredResultDetails(result);
	if (structuredEnvelope !== undefined) {
		return extractCanonicalEvidence(structuredEnvelope);
	}
	// No sidecar and no canonical envelope on result details. The whole
	// `result.details` object is NOT passed to `extractCanonicalEvidence`
	// (TASK-002 hard-cut: never pass the whole details to the canonical
	// extractor because top-level `details.coderEvidence` is a legacy
	// field and would otherwise be promoted to canonical authority).
	return {
		coderEvidence: undefined,
		reviewerEvidence: undefined,
		provenance: "none",
		usedLegacyAdapter: false,
		warnings: [],
		freeFormOnly: true,
	};
}

function buildPlanShape(plan: WorkflowArchitecturePlan | null | undefined): CoderEvidencePlanShape {
	if (!plan) return {};
	return {
		status: plan.status,
		acceptanceCriteria: plan.acceptanceCriteria ?? [],
		acceptanceEvidenceMatrix: plan.acceptanceEvidenceMatrix ?? [],
	};
}

function isPaneTransport(result: DelegateRunResult): boolean {
	if (result.display === "pane") return true;
	if (result.display === "headless") return false;
	if (typeof result.doneFile === "string" && result.doneFile.trim()) return true;
	if (typeof result.surface === "string" && result.surface.trim()) return true;
	const src = result.completionSource;
	if (src === "process_exit" || src === "missing" || src === "auto_exit") return true;
	return false;
}

function buildStructuredSource(
	normalized: CoderCompletionEvidence | undefined,
	canonical: CanonicalExtraction,
	result: DelegateRunResult,
): CoderEvidenceStructuredSource {
	const paneTransport = isPaneTransport(result);
	const source: DelegateCompletionSource | undefined = result.completionSource;
	const hasStructured = normalized
		? normalized.criterionCoverage.length > 0 || normalized.commandsRun.length > 0
		: false;
	const canonicalStructured = canonical.provenance === "canonical" && (canonical.coderEvidence !== undefined || canonical.reviewerEvidence !== undefined);
	// 1) Pane transport with recognized structured evidence. Under the
	//    TASK-002 hard-cut, `hasStructured` can only come from the
	//    canonical coder packet or the empty fallback packet; legacy
	//    top-level fields are not normalized as gate authority. process_exit
	//    / missing sidecars are pane-only conditions and classify as
	//    pane-structured even when the runner attached structured details
	//    to the result.
	if (paneTransport && (hasStructured || canonicalStructured)) return "pane-structured";
	// 2) Pane transport without structured coder evidence.
	if (paneTransport) {
		// auto_exit fallback without structured sidecar evidence is the
		// canonical free-form-only case: the child never called the done
		// tool and the sidecar carries only the auto-exit warning.
		if (source === "auto_exit") return "free-form-only";
		// process_exit / missing sidecars and any other pane-transport
		// fallback classify as pane-structured (pane diagnostic).
		return "pane-structured";
	}
	// 3) Headless transport with recognized canonical structured evidence.
	if (hasStructured || canonicalStructured) return "headless-structured";
	// 4) Headless transport without structured evidence: headless generic
	//    / legacy / free-form-only fallbacks classify as free-form-only so
	//    the evaluator can surface free_form_only diagnostics.
	if (source === "auto_exit" || source === "legacy" || source === "process_exit") return "free-form-only";
	return "none";
}

export function runCompletionEvidenceGate(
	plan: WorkflowArchitecturePlan | null | undefined,
	result: DelegateRunResult,
	options: RunCompletionEvidenceGateOptions = {},
): CoderEvidenceGateResult {
	const planShape = buildPlanShape(plan);
	const sidecar = pickDoneSidecar(result);
	const sidecarRecord = asRecord(sidecar);
	const canonical = runCanonicalExtraction(result, sidecar);
	// TASK-002 HARD-CUT: `done.evidence` is the SOLE gate-authoritative
	// path. The gate consumes the canonical `coderEvidence` envelope only
	// when `canonical.provenance === "canonical"` AND
	// `canonical.coderEvidence !== undefined`. When canonical evidence is
	// absent, the gate consumes the empty fallback packet and the matrix-
	// gated plan fails closed. The previous legacy-adapter bridge that
	// mirrored structured content from top-level `coderEvidence` / summary
	// JSON has been DELETED.
	let packetInput: unknown;
	const evidenceWarnings: string[] = [];
	let evidenceProvenance: "canonical" | "legacy" | "none" = "none";
	if (canonical.provenance === "canonical" && canonical.coderEvidence !== undefined) {
		packetInput = canonical.coderEvidence;
		evidenceProvenance = "canonical";
		// Surface canonical helper warnings so the diagnostic path keeps them.
		for (const w of canonical.warnings) evidenceWarnings.push(w);
	} else {
		// Canonical envelope is absent or contains no `coderEvidence`
		// payload. Consume the empty fallback packet so matrix-gated plans
		// fail closed. The runner's `completionWarning` is preserved on
		// the delegate history so the matrix-gated evaluator can show it.
		packetInput = {
			filesChanged: [],
			commandsRun: [],
			criterionCoverage: [],
			knownGaps: ["canonical coder evidence absent; gate failed closed under TASK-002 hard-cut"],
			caveats: [],
			summary: undefined,
		};
	}
	// Always preserve the `completionWarning` from the runner as a
	// delegate-history warning so the matrix-gated evaluator can see it.
	const delegateHistoryWarnings: string[] = [];
	if (typeof result.completionWarning === "string" && result.completionWarning) delegateHistoryWarnings.push(result.completionWarning);
	if (canonical.warnings.length > 0) delegateHistoryWarnings.push(...canonical.warnings);
	if (evidenceProvenance !== "canonical") {
		// Surface the absent-canonical diagnostic on the delegate history
		// so the matrix-gated evaluator can show the canonical-evidence-
		// missing reason.
		delegateHistoryWarnings.push("canonical_coder_evidence_absent: done.evidence.coderEvidence envelope is required; the gate failed closed under TASK-002 hard-cut.");
	}

	const normalizeResult = normalizeCoderCompletionEvidence({
		packet: packetInput,
		delegateHistory: {
			attempts: [],
			warnings: delegateHistoryWarnings,
			retries: 0,
		},
		completionSource: result.completionSource,
		finalOutput: typeof result.finalOutput === "string" ? result.finalOutput : undefined,
		summary: typeof sidecarRecord?.summary === "string" ? (sidecarRecord.summary as string) : undefined,
	});

	const packet = normalizeResult.value;
	const evaluation = evaluateCoderCompletionEvidence(planShape, packet, {
		isMatrixGated: isMatrixGated(planShape, undefined),
		lightweight: options.lightweightScope !== undefined,
		lightweightScope: options.lightweightScope,
		requireFilesAndCommands: options.requireFilesAndCommands !== false,
	});

	// isMatrixGated is part of the evaluation; if the plan is not matrix-gated,
	// the strict gate is a no-op (ok === true means "no evidence required").
	const ok = evaluation.ok;
	const structuredSource = buildStructuredSource(packet, canonical, result);
	const reason = evaluation.reason;
	return {
		ok,
		evaluation,
		packet,
		normalizeIssues: normalizeResult.issues,
		structuredSource,
		reason,
		evidenceProvenance,
		evidenceWarnings,
		autoExitObserved: evaluation.diagnostics.delegateHistory.autoExitObserved,
		processExitObserved: evaluation.diagnostics.delegateHistory.processExitObserved,
		missingSidecarObserved: evaluation.diagnostics.delegateHistory.missingSidecarObserved,
		freeFormOnlyObserved: evaluation.diagnostics.delegateHistory.freeFormOnlyObserved,
	};
}

export function canUseLightweightCoderEvidenceGate(
	plan: WorkflowArchitecturePlan | null | undefined,
	scope: "tiny" | "admin" | "debug" | undefined,
): boolean {
	return canUseLightweightEvidenceCheck(buildPlanShape(plan), { lightweightScope: scope });
}

// Helper: when callers want to await a possible promise (e.g. async done
// sidecar in tests), this returns a thenable that resolves to the gate
// result. Today the gate is fully synchronous; this wrapper exists so
// future async loaders (e.g. streaming pane manifest tails) can be slotted
// in without changing the caller surface in tools.ts.
export function runCompletionEvidenceGateAsync(
	plan: WorkflowArchitecturePlan | null | undefined,
	result: DelegateRunResult,
	options: RunCompletionEvidenceGateOptions = {},
): Promise<CoderEvidenceGateResult> {
	const value = runCompletionEvidenceGate(plan, result, options);
	if (isPromiseLike<CoderEvidenceGateResult>(value)) return Promise.resolve(value);
	return Promise.resolve(value);
}

export function formatCoderEvidenceRejectionText(gate: CoderEvidenceGateResult): string {
	if (gate.ok) return "Coder completion evidence accepted by strict matrix-gated gate.";
	const parts: string[] = [];
	parts.push("Coder completion evidence rejected by matrix-gated gate.");
	if (gate.reason) parts.push(`Reason: ${gate.reason}`);
	if (gate.evaluation.rejectionCodes.length > 0) {
		parts.push(`Rejection codes: ${gate.evaluation.rejectionCodes.join(", ")}.`);
	}
	if (gate.evaluation.diagnostics.sourcePrecedence) {
		parts.push(`Evidence source precedence: ${gate.evaluation.diagnostics.sourcePrecedence}.`);
	}
	if (gate.evaluation.diagnostics.missingCriteria.length > 0) {
		parts.push(`Missing criteria: ${gate.evaluation.diagnostics.missingCriteria.join(", ")}.`);
	}
	if (gate.evaluation.diagnostics.weakCriteria.length > 0) {
		parts.push(`Weak criteria: ${gate.evaluation.diagnostics.weakCriteria.join(", ")}.`);
	}
	return parts.join("\n");
}

export interface CoderEvidenceGateDetails {
	ok: boolean;
	rejectionCodes: string[];
	reason?: string;
	diagnostics: CoderEvidenceEvaluation["diagnostics"];
	structuredSource: CoderEvidenceStructuredSource;
	lightweight: boolean;
	isMatrixGated: boolean;
	plan: { planId: string; status: "ready" | "draft" };
	delegateHistory: CoderEvidenceEvaluation["diagnostics"]["delegateHistory"];
	/** TASK-002: provenance of the coder evidence the gate consumed. */
	evidenceProvenance: "canonical" | "none";
	/** TASK-002: warnings carried by the canonical helper / absent-
	 *  canonical diagnostic. */
	evidenceWarnings: string[];
}

export function coderEvidenceGateDetails(
	plan: WorkflowArchitecturePlan | null | undefined,
	gate: CoderEvidenceGateResult,
): CoderEvidenceGateDetails {
	// TASK-002 HARD-CUT: use the explicit provenance and warnings
	// tracked by the gate (not a guess from packet presence /
	// structured source). The gate's `evidenceProvenance` is the
	// actual authority the gate consumed: `"canonical"` for
	// `done.evidence.coderEvidence`, `"none"` when no canonical
	// payload was found. The previous `"legacy"` value (legacy
	// adapter mirror) is no longer produced by this gate.
	const delegateHistory = gate.evaluation.diagnostics.delegateHistory;
	return {
		ok: gate.ok,
		rejectionCodes: gate.evaluation.rejectionCodes,
		reason: gate.reason,
		diagnostics: gate.evaluation.diagnostics,
		structuredSource: gate.structuredSource,
		lightweight: gate.evaluation.lightweight,
		isMatrixGated: gate.evaluation.isMatrixGated,
		plan: { planId: plan?.planId ?? "", status: plan?.status === "ready" ? "ready" : "draft" },
		delegateHistory,
		evidenceProvenance: gate.evidenceProvenance,
		evidenceWarnings: gate.evidenceWarnings.slice(),
	};
}

// ---------- Phase-advancement integration helper ----------
//
// `evaluateCoderPhaseAdvancement` is the single entry point used by the
// `delegate_to_coder` tool at the shared phase-advancement boundary. It
// runs the matrix-gated gate against the delegate result, classifies the
// structured source, and returns a discriminated union the tool can use to
// either advance to `coder_completed` or short-circuit with an
// `isError: true` result that carries rejection codes/diagnostics and the
// full `coderEvidenceGate` evaluation in `details`. Keeping the wiring in
// one place keeps `tools.ts` surgical.

export interface CoderEvidencePhaseAdvancementAdvance {
	kind: "advance";
	evaluation: CoderEvidenceEvaluation;
	structuredSource: CoderEvidenceStructuredSource;
}
export interface CoderEvidencePhaseAdvancementBlock {
	kind: "block";
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: true;
	evaluation: CoderEvidenceEvaluation;
	structuredSource: CoderEvidenceStructuredSource;
	rejectionCodes: CoderEvidenceEvaluation["rejectionCodes"];
	reason: string | undefined;
}
export type CoderEvidencePhaseAdvancement =
	| CoderEvidencePhaseAdvancementAdvance
	| CoderEvidencePhaseAdvancementBlock;

export function evaluateCoderPhaseAdvancement(
	plan: WorkflowArchitecturePlan | null | undefined,
	result: DelegateRunResult,
	baseDetails: Record<string, unknown> = {},
	options: RunCompletionEvidenceGateOptions = {},
): CoderEvidencePhaseAdvancement {
	const gate = runCompletionEvidenceGate(plan, result, options);
	if (gate.ok) {
		return {
			kind: "advance",
			evaluation: gate.evaluation,
			structuredSource: gate.structuredSource,
		};
	}
	return {
		kind: "block",
		content: [{ type: "text", text: formatCoderEvidenceRejectionText(gate) }],
		details: { ...baseDetails, coderEvidenceGate: coderEvidenceGateDetails(plan, gate) },
		isError: true,
		evaluation: gate.evaluation,
		structuredSource: gate.structuredSource,
		rejectionCodes: gate.evaluation.rejectionCodes,
		reason: gate.reason,
	};
}
