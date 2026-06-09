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
	const direct = record.coderEvidence;
	if (direct !== undefined) return direct;
	const details = asRecord(record.details);
	if (!details) return undefined;
	const fromDetails = details.coderEvidence;
	if (fromDetails !== undefined) return fromDetails;
	return undefined;
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
	sidecarRead: boolean,
	result: DelegateRunResult,
): CoderEvidenceStructuredSource {
	const paneTransport = isPaneTransport(result);
	const source: DelegateCompletionSource | undefined = result.completionSource;
	const hasStructured = normalized
		? normalized.criterionCoverage.length > 0 || normalized.commandsRun.length > 0
		: false;
	// 1) Pane transport with structured coderEvidence (sidecar.coderEvidence
	//    or result.details.coderEvidence) → pane-structured. process_exit
	//    / missing sidecars are pane-only conditions and classify as
	//    pane-structured even when the runner attached structured details
	//    to the result.
	if (paneTransport && hasStructured) return "pane-structured";
	// 2) Pane transport without structured coderEvidence.
	if (paneTransport) {
		// auto_exit fallback without structured sidecar evidence is the
		// canonical free-form-only case: the child never called the done
		// tool and the sidecar carries only the auto-exit warning.
		if (source === "auto_exit" && !sidecarRead) return "free-form-only";
		// process_exit / missing sidecars and any other pane-transport
		// fallback classify as pane-structured (pane diagnostic).
		return "pane-structured";
	}
	// 3) Headless transport with structured result details.
	if (hasStructured) return "headless-structured";
	// 4) Headless transport without structured evidence: headless generic
	//    / legacy / free-form-only fallbacks classify as free-form-only so
	//    the evaluator can surface free_form_only diagnostics.
	if (source === "auto_exit" || source === "legacy") return "free-form-only";
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
	const coderEvidenceFromSidecar = sidecarRecord ? sidecarRecord.coderEvidence : undefined;
	const structuredDetails = pickStructuredResultDetails(result);
	const packetInput = coderEvidenceFromSidecar !== undefined ? coderEvidenceFromSidecar : structuredDetails;
	const sidecarRead = coderEvidenceFromSidecar !== undefined;

	const normalizeResult = normalizeCoderCompletionEvidence({
		packet: packetInput,
		delegateHistory: {
			attempts: [],
			warnings: typeof result.completionWarning === "string" ? [result.completionWarning] : [],
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
	const structuredSource = buildStructuredSource(packet, sidecarRead, result);
	const reason = evaluation.reason;
	return {
		ok,
		evaluation,
		packet,
		normalizeIssues: normalizeResult.issues,
		structuredSource,
		reason,
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
}

export function coderEvidenceGateDetails(
	plan: WorkflowArchitecturePlan | null | undefined,
	gate: CoderEvidenceGateResult,
): CoderEvidenceGateDetails {
	return {
		ok: gate.ok,
		rejectionCodes: gate.evaluation.rejectionCodes,
		reason: gate.reason,
		diagnostics: gate.evaluation.diagnostics,
		structuredSource: gate.structuredSource,
		lightweight: gate.evaluation.lightweight,
		isMatrixGated: gate.evaluation.isMatrixGated,
		plan: { planId: plan?.planId ?? "", status: plan?.status === "ready" ? "ready" : "draft" },
		delegateHistory: gate.evaluation.diagnostics.delegateHistory,
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
