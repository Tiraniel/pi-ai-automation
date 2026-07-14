// TASK-001 Phase A — single pure legacy-import adapter.
// Converts existing done-sidecar / coderEvidence / reviewerEvidence /
// summary JSON / delegate-history shapes into ledger events with `legacy`
// provenance and explicit warnings. Free-form-only inputs (raw text or
// unrecognized shapes) are recorded as `legacy_import` events with
// `hasStructuredContent: false` and an explicit `free_form_only` warning;
// they are NEVER marked accepted.
//
// This module is the single provenance-marking adapter. The contract is:
//   1. At most one adapter exists (this file). Higher-level transports in
//      TASK-002..004 must NOT add their own free-form fallback parsers;
//      they call into this module instead.
//   2. Every imported event carries `provenance: "legacy"` and a non-empty
//      `warnings` array (or a `legacy_import` event that documents the
//      import).
//   3. Free-form-only inputs never produce accepted events.
//
// TASK-002 hard-cut reminder: this adapter may still produce ledger /
// migration events and may still surface mirrored `mirroredCoderEvidence`
// / `mirroredReviewerEvidence` payloads for diagnostic / projection
// consumers (queries, memos, dashboards). However, TASK-002 delegate
// coder / reviewer gates MUST NOT consume these mirrors as pass/fail
// authority: the only canonical evidence path for the strict delegate
// completion gate is `done.evidence` (or the equivalent
// `result.details.evidence` / `result.details.done.evidence`). Other
// callers (legacy ledger queries, project-history views, smoke
// fixtures) may still read the mirrors, but the matrix-gated delegate
// advancement path ignores them by design.

import {
	appendEvent,
	createEvidenceLedger,
	markRejected,
	snapshotLedger,
	type NowProvider,
} from "./ledger";
import type {
	DeliveryRunContext,
	EvidenceEvent,
	EvidenceLedger,
	LegacyImportSourceKind,
	LegacyImportWarning,
	LegacyImportWarningCode,
} from "./types";

// ---------- Internal helpers ----------

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function trimString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const trimmed = trimString(item);
		if (trimmed) out.push(trimmed);
	}
	return out;
}

function pushWarning(target: LegacyImportWarning[], code: LegacyImportWarningCode, message: string): void {
	target.push({ code, message });
}

/** Format a `LegacyImportWarning` array as the string form attached to
 *  ledger events. The code is preserved so downstream code, projections,
 *  and memos can match on it without parsing the human-readable message.
 *  Format: `code: message`. `ImportLegacyResult.warnings` is kept as the
 *  structured `{ code, message }[]` form; this helper only converts to
 *  the string form for the ledger event `warnings` array. */
function formatWarningStrings(warnings: LegacyImportWarning[]): string[] {
	const out: string[] = [];
	for (const w of warnings) out.push(`${w.code}: ${w.message}`);
	return out;
}

/** Stable, conservative detection of whether a value is "free-form only" —
 *  i.e. raw text or an object with no recognizable structured evidence
 *  fields. The legacy adapter must NEVER mark such an event accepted. */
export function isFreeFormOnly(input: unknown): boolean {
	if (input === null || input === undefined) return true;
	if (typeof input === "string") return true;
	if (typeof input === "number" || typeof input === "boolean") return true;
	if (Array.isArray(input)) return true; // arrays of strings are not structured evidence on their own
	const record = asRecord(input);
	if (!record) return true;
	// Recognized structured fields — if any is present, the input is not
	// free-form-only. We do NOT recurse into `details.done.coderEvidence` etc.
	// here; that classification is done by the higher-level adapters
	// (completion-evidence-gate, reviewer-roles) which call into us.
	const structuredKeys = [
		"coderEvidence", "reviewerEvidence", "commandsRun", "criterionCoverage",
		"filesChanged", "delegateHistory", "blockingReasons", "verdict",
		"recommendedStatus", "rejectionCodes", "evidenceRefs",
		"summary", "recommended", "outcomes", "results", "details",
	];
	for (const k of structuredKeys) if (k in record) return false;
	return true;
}

function tryParseJsonSummary(input: unknown): unknown {
	if (typeof input !== "string") return input;
	const trimmed = input.trim();
	if (!trimmed) return input;
	// Heuristic: a JSON object / array starts with { or [. Anything else is
	// free-form text. We never throw to the caller on parse errors.
	if (trimmed[0] !== "{" && trimmed[0] !== "[") return input;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return parsed === null || parsed === undefined ? input : parsed;
	} catch {
		return input;
	}
}

function detectAutoExitPhrases(text: string): { autoExit: boolean; processExit: boolean; missing: boolean } {
	const lower = text.toLowerCase();
	return {
		autoExit: lower.includes("auto_exit") || lower.includes("auto-exit") || lower.includes("auto exit"),
		processExit: lower.includes("process_exit") || lower.includes("process-exit") || lower.includes("process exit"),
		missing: lower.includes("missing sidecar") || lower.includes("no done sidecar") || lower.includes("missing-sidecar"),
	};
}

/** Safely stringify any input for the `rawSummary` field. `JSON.stringify`
 *  returns `undefined` for `undefined` and `function` inputs; calling
 *  `.slice` on that result would throw. Always returns a string. */
function safeRawText(source: unknown): string {
	if (source === undefined) return "(undefined input)";
	if (source === null) return "(null input)";
	if (typeof source === "string") return source;
	try {
		const out = JSON.stringify(source);
		return out === undefined ? "(unstringifiable input)" : out;
	} catch {
		return "(unstringifiable input)";
	}
}

function truncateForSummary(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) : text;
}

// ---------- Adapter result types ----------

export interface ImportLegacyInput {
	runId: string;
	context: DeliveryRunContext;
	/** The legacy artifact. May be a string, object, or anything else. */
	source: unknown;
	/** Human-readable label, e.g. "done-sidecar:./tmp/done.json". */
	sourceLabel?: string;
	now: NowProvider;
	/** Optional pre-existing ledger to append to. When omitted, a fresh
	 *  ledger is created. */
	ledger?: EvidenceLedger;
}

export interface ImportLegacyResult {
	ledger: EvidenceLedger;
	events: EvidenceEvent[];
	warnings: LegacyImportWarning[];
	detected: LegacyImportSourceKind | "none";
	freeFormOnly: boolean;
	/** When the adapter found structured `coderEvidence` content and
	 *  mirrored it, the ORIGINAL structured payload (not the
	 *  ledger-normalized event payload) is surfaced here. The
	 *  mirrored payload is INTENDED for diagnostic / projection
	 *  consumers (legacy ledger queries, project-history views,
	 *  smoke fixtures) that need the full original
	 *  `supportingFiles` / `supportingCommands` / etc. fields. The
	 *  ledger event is still appended for provenance / queries.
	 *
	 *  TASK-002 hard-cut: the strict delegate coder gate MUST NOT
	 *  consume `mirroredCoderEvidence` as pass/fail authority. The
	 *  coder gate reads only `done.evidence.coderEvidence` (or
	 *  `details.evidence.coderEvidence` / `details.done.evidence.coderEvidence`).
	 *  This mirror is kept for non-gate consumers only. */
	mirroredCoderEvidence: unknown | undefined;
	/** When the adapter found structured `reviewerEvidence` content
	 *  and mirrored it, the ORIGINAL structured payload is surfaced
	 *  here. Like `mirroredCoderEvidence`, this is for diagnostic /
	 *  projection consumers only.
	 *
	 *  TASK-002 hard-cut: the strict delegate reviewer-roles gate
	 *  MUST NOT consume `mirroredReviewerEvidence` as pass/fail
	 *  authority. The reviewer-roles gate reads only canonical
	 *  `done.evidence.reviewerEvidence` (or its in-memory
	 *  equivalents). */
	mirroredReviewerEvidence: unknown | undefined;
}

// ---------- Top-level entry point ----------

/** Detect the legacy artifact shape and append the appropriate events. */
export function importLegacyEvidence(input: ImportLegacyInput): ImportLegacyResult {
	const runId = trimString(input.runId);
	if (!runId) throw new Error("importLegacyEvidence: `runId` is required.");
	const ledger = input.ledger ?? createEvidenceLedger({ runId, now: input.now });
	const warnings: LegacyImportWarning[] = [];
	const freeFormOnly = isFreeFormOnly(input.source);

	if (freeFormOnly) {
		// Free-form-only inputs must NEVER be marked accepted. We append one
		// `legacy_import` event recording the raw text + explicit warnings
		// and immediately mark it rejected so downstream queries can never
		// promote it to accepted.
		const rawText = safeRawText(input.source);
		const truncated = truncateForSummary(rawText, 4000);
		const sourceLabel = input.sourceLabel ?? "free-form-only";

		// Detect auto_exit / process_exit / missing-sidecar phrases. These
		// are DBG-007-style hidden authority signals; matrix-gated work
		// cannot rely on them. We attach distinct warning codes/messages
		// so downstream gates can fail closed.
		const phraseFlags = detectAutoExitPhrases(rawText);
		pushWarning(warnings, "free_form_only", "Legacy input is free-form text with no structured evidence fields; not authoritative.");
		if (phraseFlags.autoExit) {
			pushWarning(warnings, "auto_exit_observed", "Free-form text mentions an auto_exit completion; matrix-gated work cannot rely on this for acceptance.");
		}
		if (phraseFlags.processExit) {
			pushWarning(warnings, "process_exit_observed", "Free-form text mentions a process_exit completion; matrix-gated work cannot rely on this for acceptance.");
		}
		if (phraseFlags.missing) {
			pushWarning(warnings, "missing_sidecar_observed", "Free-form text mentions a missing sidecar; matrix-gated work cannot rely on this for acceptance.");
		}
		const warningStrings = formatWarningStrings(warnings);

		let nextLedger = appendEvent(ledger, {
			runId,
			kind: "legacy_import",
			provenance: "legacy",
			status: "recorded",
			context: input.context,
			source: sourceLabel,
			warnings: warningStrings,
			payload: {
				importedFrom: "freeFormOnly",
				originalSource: sourceLabel,
				rawSummary: truncated,
				hasStructuredContent: false,
			},
		}, input.now);
		const appended = nextLedger.events[nextLedger.events.length - 1];
		if (appended) {
			nextLedger = markRejected(nextLedger, appended.eventId, input.now, warningStrings);
		}
		return { ledger: nextLedger, events: nextLedger.events.slice(ledger.events.length), warnings, detected: "freeFormOnly", freeFormOnly: true, mirroredCoderEvidence: undefined, mirroredReviewerEvidence: undefined };
	}

	const record = input.source as Record<string, unknown>;
	const coderEvidence = record.coderEvidence;
	const reviewerEvidence = record.reviewerEvidence;
	const summary = record.summary;
	const delegateHistory = record.delegateHistory;

	if (coderEvidence !== undefined) {
		return importCoderEvidence({ ledger, runId, context: input.context, sourceLabel: input.sourceLabel, now: input.now, payload: coderEvidence, parent: record });
	}
	if (reviewerEvidence !== undefined) {
		return importReviewerEvidence({ ledger, runId, context: input.context, sourceLabel: input.sourceLabel, now: input.now, payload: reviewerEvidence, parent: record });
	}
	if (delegateHistory !== undefined) {
		return importDelegateHistory({ ledger, runId, context: input.context, sourceLabel: input.sourceLabel, now: input.now, payload: delegateHistory, parent: record });
	}
	if (summary !== undefined) {
		return importSummary({ ledger, runId, context: input.context, sourceLabel: input.sourceLabel, now: input.now, payload: summary, parent: record });
	}

	// Object with at least one structured key, but no recognized adapter.
	// Fall back to a generic legacy_import event.
	return importGenericObject({ ledger, runId, context: input.context, sourceLabel: input.sourceLabel, now: input.now, payload: record });
}

// ---------- Specific adapters ----------

interface SubAdapterInput {
	ledger: EvidenceLedger;
	runId: string;
	context: DeliveryRunContext;
	sourceLabel: string | undefined;
	now: NowProvider;
	payload: unknown;
	parent?: Record<string, unknown>;
}

function importCoderEvidence(input: SubAdapterInput): ImportLegacyResult {
	const warnings: LegacyImportWarning[] = [];
	pushWarning(warnings, "deprecated_coder_evidence", "Imported a legacy `coderEvidence` artifact; new code should write `coder_evidence` ledger events directly.");

	const record = asRecord(input.payload);
	if (!record) {
		return importFreeFormFallback({ ...input, freeFormReason: "coderEvidence field was not a structured object" });
	}

	const labels = detectDelegateFlags(record);
	if (labels.autoExit) pushWarning(warnings, "auto_exit_observed", "Legacy `coderEvidence` reflects an auto_exit completion; matrix-gated work cannot rely on this for acceptance.");
	if (labels.processExit) pushWarning(warnings, "process_exit_observed", "Legacy `coderEvidence` reflects a process_exit completion; matrix-gated work cannot rely on this for acceptance.");
	if (labels.missing) pushWarning(warnings, "missing_sidecar_observed", "Legacy `coderEvidence` reflects a missing sidecar; matrix-gated work cannot rely on this for acceptance.");
	if (!hasStructuredCoderContent(record)) {
		pushWarning(warnings, "no_structured_content", "Legacy `coderEvidence` carries no commandsRun or criterionCoverage rows; not authoritative.");
	}
	const warningStrings = formatWarningStrings(warnings);

	const filesChanged = asStringArray(record.filesChanged);
	const commandsRunRaw = Array.isArray(record.commandsRun) ? record.commandsRun : [];
	const commandsRun: { command: string; outcome: "passed" | "failed" | "skipped"; summary?: string; exitCode?: number }[] = [];
	for (let i = 0; i < commandsRunRaw.length; i += 1) {
		const item = asRecord(commandsRunRaw[i]);
		if (!item) continue;
		const command = trimString(item.command);
		const outcome = trimString(item.outcome);
		if (!command) continue;
		if (outcome !== "passed" && outcome !== "failed" && outcome !== "skipped") continue;
		const entry: { command: string; outcome: "passed" | "failed" | "skipped"; summary?: string; exitCode?: number } = { command, outcome };
		const itemSummary = trimString(item.summary);
		if (itemSummary) entry.summary = itemSummary;
		if (typeof item.exitCode === "number" && Number.isFinite(item.exitCode)) entry.exitCode = item.exitCode;
		commandsRun.push(entry);
	}
	const criterionCoverage: { criterion: string; evidenceKind: string; strength: string; summary: string }[] = [];
	const cov = Array.isArray(record.criterionCoverage) ? record.criterionCoverage : [];
	for (let i = 0; i < cov.length; i += 1) {
		const item = asRecord(cov[i]);
		if (!item) continue;
		const criterion = trimString(item.criterion);
		const evidenceKind = trimString(item.evidenceKind);
		const strength = trimString(item.strength);
		const summary = trimString(item.summary);
		if (!criterion || !evidenceKind || !strength || !summary) continue;
		criterionCoverage.push({ criterion, evidenceKind, strength, summary });
	}
	const summary = trimString(record.summary) || undefined;

	let nextLedger = appendEvent(input.ledger, {
		runId: input.runId,
		kind: "legacy_import",
		provenance: "legacy",
		status: "recorded",
		context: input.context,
		source: input.sourceLabel ?? "done-sidecar",
		warnings: warningStrings,
		payload: {
			importedFrom: "coderEvidence",
			originalSource: input.sourceLabel ?? "coderEvidence",
			...(summary ? { rawSummary: summary } : {}),
			hasStructuredContent: hasStructuredCoderContent(record),
		},
	}, input.now);

	const hasStructured = hasStructuredCoderContent(record);
	if (hasStructured) {
		// Mirror the legacy payload as a typed coder_evidence event with
		// provenance === "legacy". Status stays "recorded" by default; the
		// caller may opt to mark it accepted only if it is not free-form-only.
		nextLedger = appendEvent(nextLedger, {
			runId: input.runId,
			kind: "coder_evidence",
			provenance: "legacy",
			status: "recorded",
			context: input.context,
			source: input.sourceLabel ?? "done-sidecar",
			warnings: warningStrings,
			payload: {
				filesChanged,
				commandsRun,
				criterionCoverage,
				...(summary ? { summary } : {}),
			},
		}, input.now);
	}

	// If no structured content, mark the legacy_import event rejected so it
	// can never be promoted to accepted. The legacy_import event is the
	// most recently appended event when no structured mirror was added.
	if (!hasStructured) {
		const imported = nextLedger.events[nextLedger.events.length - 1];
		if (imported && imported.kind === "legacy_import") {
			nextLedger = markRejected(nextLedger, imported.eventId, input.now, warningStrings);
		}
	}

	return { ledger: nextLedger, events: nextLedger.events.slice(input.ledger.events.length), warnings, detected: "coderEvidence", freeFormOnly: !hasStructured, mirroredCoderEvidence: hasStructured ? input.payload : undefined, mirroredReviewerEvidence: undefined };
}

function importReviewerEvidence(input: SubAdapterInput): ImportLegacyResult {
	const warnings: LegacyImportWarning[] = [];
	pushWarning(warnings, "deprecated_reviewer_evidence", "Imported a legacy `reviewerEvidence` artifact; new code should write `reviewer_evidence` ledger events directly.");

	const record = asRecord(input.payload);
	if (!record) return importFreeFormFallback({ ...input, freeFormReason: "reviewerEvidence field was not a structured object" });

	const role = trimString(record.role) || "unknown";
	const verdictRaw = trimString(record.verdict) || trimString(record.effectiveVerdict);
	const verdict = verdictRaw === "APPROVED" || verdictRaw === "CHANGES_REQUESTED" || verdictRaw === "UNKNOWN"
		? verdictRaw
		: "UNKNOWN";
	const effectiveVerdictRaw = trimString(record.effectiveVerdict) || verdict;
	const effectiveVerdict = effectiveVerdictRaw === "APPROVED" || effectiveVerdictRaw === "CHANGES_REQUESTED" || effectiveVerdictRaw === "UNKNOWN"
		? effectiveVerdictRaw
		: verdict;
	const blockingReasons = asStringArray(record.blockingReasons);
	const weakEvidence = asStringArray(record.weakEvidence);
	const promptOnlyCaveats = asStringArray(record.promptOnlyCaveats);
	const unresolvedRisks = asStringArray(record.unresolvedRisks);
	// TASK-002 hard-cut: a legacy `reviewerEvidence` artifact with
	// non-empty typed reviewer-evidence content (non-empty
	// `criterionCoverage` rows, non-empty `commandsRun` entries,
	// verdict tokens, blocking reasons, etc.) IS recognized as
	// structured and the adapter appends a `reviewer_evidence`
	// ledger event with `provenance: "legacy"` and surfaces the
	// ORIGINAL payload via `mirroredReviewerEvidence`. However,
	// the mirrored payload is for diagnostic / projection
	// consumers only — the TASK-002 strict delegate
	// reviewer-roles gate MUST NOT consume it as pass/fail
	// authority. Bare labels / final-text summaries without typed
	// content remain free-form-only and are NOT mirrored.
	const criterionCoverage = Array.isArray(record.criterionCoverage) ? record.criterionCoverage : [];
	const commandsRun = Array.isArray(record.commandsRun) ? record.commandsRun : [];
	const typedContent = criterionCoverage.length > 0 || commandsRun.length > 0;
	const finalOutput = typeof record.finalOutput === "string" && record.finalOutput.trim() ? record.finalOutput : undefined;
	const hasStructured = blockingReasons.length + weakEvidence.length + promptOnlyCaveats.length + unresolvedRisks.length > 0
		|| verdict !== "UNKNOWN"
		|| Boolean(finalOutput && finalOutput.trim())
		|| typedContent;

	if (!hasStructured) pushWarning(warnings, "no_structured_content", "Legacy `reviewerEvidence` carries no verdict, blocking reasons, weak evidence, prompt-only caveats, unresolved risks, criterionCoverage, or commandsRun; not authoritative.");
	const warningStrings = formatWarningStrings(warnings);

	let nextLedger = appendEvent(input.ledger, {
		runId: input.runId,
		kind: "legacy_import",
		provenance: "legacy",
		status: "recorded",
		context: input.context,
		source: input.sourceLabel ?? "done-sidecar",
		warnings: warningStrings,
		payload: {
			importedFrom: "reviewerEvidence",
			originalSource: input.sourceLabel ?? "reviewerEvidence",
			...(finalOutput ? { rawSummary: finalOutput.slice(0, 4000) } : {}),
			hasStructuredContent: hasStructured,
		},
	}, input.now);

	if (hasStructured) {
		nextLedger = appendEvent(nextLedger, {
			runId: input.runId,
			kind: "reviewer_evidence",
			provenance: "legacy",
			status: "recorded",
			context: input.context,
			source: input.sourceLabel ?? "done-sidecar",
			warnings: warningStrings,
			payload: {
				role,
				verdict,
				effectiveVerdict,
				blockingReasons,
				weakEvidence,
				promptOnlyCaveats,
				unresolvedRisks,
				...(finalOutput ? { finalOutput } : {}),
			},
		}, input.now);
	} else {
		const imported = nextLedger.events[nextLedger.events.length - 1];
		if (imported && imported.kind === "legacy_import") {
			nextLedger = markRejected(nextLedger, imported.eventId, input.now, warningStrings);
		}
	}

	return { ledger: nextLedger, events: nextLedger.events.slice(input.ledger.events.length), warnings, detected: "reviewerEvidence", freeFormOnly: !hasStructured, mirroredCoderEvidence: undefined, mirroredReviewerEvidence: hasStructured ? input.payload : undefined };
}

function importDelegateHistory(input: SubAdapterInput): ImportLegacyResult {
	const warnings: LegacyImportWarning[] = [];
	pushWarning(warnings, "deprecated_delegate_history", "Imported a legacy `delegateHistory` artifact; structured delegate attempts should be written as `coder_evidence` events directly.");

	const record = asRecord(input.payload);
	if (!record) return importFreeFormFallback({ ...input, freeFormReason: "delegateHistory field was not a structured object" });

	const labels = detectDelegateFlags(record);
	if (labels.autoExit) pushWarning(warnings, "auto_exit_observed", "Legacy `delegateHistory` reflects an auto_exit completion; matrix-gated work cannot rely on this for acceptance.");
	if (labels.processExit) pushWarning(warnings, "process_exit_observed", "Legacy `delegateHistory` reflects a process_exit completion; matrix-gated work cannot rely on this for acceptance.");
	if (labels.missing) pushWarning(warnings, "missing_sidecar_observed", "Legacy `delegateHistory` reflects a missing sidecar; matrix-gated work cannot rely on this for acceptance.");

	const attempts = Array.isArray(record.attempts) ? record.attempts : [];
	const warningsList = asStringArray(record.warnings);
	const retries = typeof record.retries === "number" && Number.isFinite(record.retries) ? Math.max(0, Math.floor(record.retries)) : 0;
	const hasStructured = attempts.length > 0 || warningsList.length > 0 || retries > 0
		|| record.autoExitObserved === true
		|| record.processExitObserved === true
		|| record.missingSidecarObserved === true
		|| record.freeFormOnlyObserved === true;
	if (!hasStructured) pushWarning(warnings, "no_structured_content", "Legacy `delegateHistory` carries no attempts, warnings, retries, or observed flags; not authoritative.");
	const warningStrings = formatWarningStrings(warnings);

	const summaryParts: string[] = [];
	summaryParts.push(`attempts=${attempts.length}`);
	summaryParts.push(`retries=${retries}`);
	if (warningsList.length > 0) summaryParts.push(`warnings=${warningsList.length}`);
	const rawSummary = summaryParts.join("; ");

	let nextLedger = appendEvent(input.ledger, {
		runId: input.runId,
		kind: "legacy_import",
		provenance: "legacy",
		status: "recorded",
		context: input.context,
		source: input.sourceLabel ?? "done-sidecar",
		warnings: warningStrings,
		payload: {
			importedFrom: "delegateHistory",
			originalSource: input.sourceLabel ?? "delegateHistory",
			rawSummary,
			hasStructuredContent: hasStructured,
		},
	}, input.now);

	if (hasStructured) {
		// Mirror as a `coder_evidence` event with the delegateHistory
		// available via the warnings list — we keep filesChanged/commandsRun
		// empty and put the attempt/warning summary in `summary`. Status
		// remains "recorded"; the caller must explicitly accept.
		nextLedger = appendEvent(nextLedger, {
			runId: input.runId,
			kind: "coder_evidence",
			provenance: "legacy",
			status: "recorded",
			context: input.context,
			source: input.sourceLabel ?? "done-sidecar",
			warnings: warningStrings,
			payload: {
				filesChanged: [],
				commandsRun: [],
				criterionCoverage: [],
				summary: rawSummary,
			},
		}, input.now);
	} else {
		const imported = nextLedger.events[nextLedger.events.length - 1];
		if (imported && imported.kind === "legacy_import") {
			nextLedger = markRejected(nextLedger, imported.eventId, input.now, warningStrings);
		}
	}

	return { ledger: nextLedger, events: nextLedger.events.slice(input.ledger.events.length), warnings, detected: "delegateHistory", freeFormOnly: !hasStructured, mirroredCoderEvidence: undefined, mirroredReviewerEvidence: undefined };
}

function importSummary(input: SubAdapterInput): ImportLegacyResult {
	const warnings: LegacyImportWarning[] = [];
	pushWarning(warnings, "deprecated_summary_json", "Imported a legacy `summary` JSON string; structured summary content should be written as `coder_evidence` events directly.");

	// `summary` is often a JSON-encoded string. Try to parse it; if it parses
	// to a non-string object with structured fields, mirror them. If it
	// remains a string, treat as free-form-only.
	const parsed = tryParseJsonSummary(input.payload);
	const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
	const labels = detectAutoExitPhrases(text);
	if (labels.autoExit) pushWarning(warnings, "auto_exit_observed", "Legacy `summary` mentions an auto_exit completion; matrix-gated work cannot rely on this for acceptance.");
	if (labels.processExit) pushWarning(warnings, "process_exit_observed", "Legacy `summary` mentions a process_exit completion; matrix-gated work cannot rely on this for acceptance.");
	if (labels.missing) pushWarning(warnings, "missing_sidecar_observed", "Legacy `summary` mentions a missing sidecar; matrix-gated work cannot rely on this for acceptance.");

	const parsedRecord = asRecord(parsed);
	const parsedCoderEvidence = asRecord(parsedRecord?.coderEvidence);
	const parsedReviewerEvidence = asRecord(parsedRecord?.reviewerEvidence);
	const parsedDelegateHistory = asRecord(parsedRecord?.delegateHistory);
	// TASK-002 hard-cut: surface typed reviewer evidence stored
	// under historical `coderEvidence.delegateHistory.reviewerEvidence`
	// and top-level `delegateHistory.reviewerEvidence` summary
	// shapes. These are the legacy-reviewer path that delegates used
	// before the canonical `done.evidence.reviewerEvidence` envelope.
	// The adapter surfaces the ORIGINAL structured payload via
	// `mirroredReviewerEvidence` for diagnostic / projection
	// consumers; the TASK-002 strict delegate reviewer-roles gate
	// MUST NOT consume this mirror as pass/fail authority. This is
	// the single central summary-JSON mirror that gates must NOT
	// duplicate.
	const nestedCoderDelegateHistoryReviewer = asRecord(parsedCoderEvidence?.delegateHistory)?.reviewerEvidence;
	const nestedDelegateHistoryReviewer = asRecord(parsedDelegateHistory)?.reviewerEvidence;
	const hasNestedReviewerEvidence = asRecord(nestedCoderDelegateHistoryReviewer) !== undefined
		|| asRecord(nestedDelegateHistoryReviewer) !== undefined;
	const hasStructured = parsedRecord !== undefined && (
		parsedCoderEvidence !== undefined
		|| parsedReviewerEvidence !== undefined
		|| parsedRecord.delegateHistory !== undefined
		|| parsedRecord.commandsRun !== undefined
		|| parsedRecord.criterionCoverage !== undefined
		|| parsedRecord.verdict !== undefined
		|| hasNestedReviewerEvidence
	);
	if (!hasStructured) pushWarning(warnings, "no_structured_content", "Legacy `summary` does not contain parseable structured evidence; not authoritative.");
	const warningStrings = formatWarningStrings(warnings);

	let nextLedger = appendEvent(input.ledger, {
		runId: input.runId,
		kind: "legacy_import",
		provenance: "legacy",
		status: "recorded",
		context: input.context,
		source: input.sourceLabel ?? "done-sidecar.summary",
		warnings: warningStrings,
		payload: {
			importedFrom: "summary",
			originalSource: input.sourceLabel ?? "summary",
			rawSummary: text.slice(0, 4000),
			hasStructuredContent: hasStructured,
		},
	}, input.now);

	if (!hasStructured) {
		const imported = nextLedger.events[nextLedger.events.length - 1];
		if (imported && imported.kind === "legacy_import") {
			nextLedger = markRejected(nextLedger, imported.eventId, input.now, warningStrings);
		}
		return { ledger: nextLedger, events: nextLedger.events.slice(input.ledger.events.length), warnings, detected: "summary", freeFormOnly: true, mirroredCoderEvidence: undefined, mirroredReviewerEvidence: undefined };
	}

	// Mirror structured content into typed events. The caller
	// (legacy ledger queries, project-history views, smoke
	// fixtures) inspects the ledger to surface legacy-mirrored
	// events with explicit provenance; this is the single central
	// summary-JSON mirror that gates must NOT duplicate.
	//
	// TASK-002 hard-cut: TASK-002 strict delegate coder / reviewer
	// gates MUST NOT read these mirrors as pass/fail authority —
	// the only canonical path is `done.evidence` (or its in-memory
	// equivalents on result details).
	if (parsedCoderEvidence !== undefined) {
		const commandsRaw = Array.isArray(parsedCoderEvidence.commandsRun) ? parsedCoderEvidence.commandsRun : [];
		const commandsRun: { command: string; outcome: "passed" | "failed" | "skipped"; summary?: string; exitCode?: number }[] = [];
		for (let i = 0; i < commandsRaw.length; i += 1) {
			const item = asRecord(commandsRaw[i]);
			if (!item) continue;
			const command = trimString(item.command);
			const outcome = trimString(item.outcome);
			if (!command) continue;
			if (outcome !== "passed" && outcome !== "failed" && outcome !== "skipped") continue;
			const entry: { command: string; outcome: "passed" | "failed" | "skipped"; summary?: string; exitCode?: number } = { command, outcome };
			const itemSummary = trimString(item.summary);
			if (itemSummary) entry.summary = itemSummary;
			if (typeof item.exitCode === "number" && Number.isFinite(item.exitCode)) entry.exitCode = item.exitCode;
			commandsRun.push(entry);
		}
		const criterionCoverage: { criterion: string; evidenceKind: string; strength: string; summary: string }[] = [];
		const cov = Array.isArray(parsedCoderEvidence.criterionCoverage) ? parsedCoderEvidence.criterionCoverage : [];
		for (let i = 0; i < cov.length; i += 1) {
			const item = asRecord(cov[i]);
			if (!item) continue;
			const criterion = trimString(item.criterion);
			const evidenceKind = trimString(item.evidenceKind);
			const strength = trimString(item.strength);
			const summary = trimString(item.summary);
			if (!criterion || !evidenceKind || !strength || !summary) continue;
			criterionCoverage.push({ criterion, evidenceKind, strength, summary });
		}
		const coderSummary = trimString(parsedCoderEvidence.summary) || undefined;
		const filesChanged = asStringArray(parsedCoderEvidence.filesChanged);
		nextLedger = appendEvent(nextLedger, {
			runId: input.runId,
			kind: "coder_evidence",
			provenance: "legacy",
			status: "recorded",
			context: input.context,
			source: input.sourceLabel ?? "done-sidecar.summary",
			warnings: warningStrings,
			payload: {
				filesChanged,
				commandsRun,
				criterionCoverage,
				...(coderSummary ? { summary: coderSummary } : {}),
			},
		}, input.now);
	}
	if (parsedReviewerEvidence !== undefined) {
		const role = trimString(parsedReviewerEvidence.role) || "unknown";
		const verdictRaw = trimString(parsedReviewerEvidence.verdict) || trimString(parsedReviewerEvidence.effectiveVerdict);
		const verdict = verdictRaw === "APPROVED" || verdictRaw === "CHANGES_REQUESTED" || verdictRaw === "UNKNOWN" ? verdictRaw : "UNKNOWN";
		const effectiveVerdictRaw = trimString(parsedReviewerEvidence.effectiveVerdict) || verdict;
		const effectiveVerdict = effectiveVerdictRaw === "APPROVED" || effectiveVerdictRaw === "CHANGES_REQUESTED" || effectiveVerdictRaw === "UNKNOWN" ? effectiveVerdictRaw : verdict;
		const blockingReasons = asStringArray(parsedReviewerEvidence.blockingReasons);
		const weakEvidence = asStringArray(parsedReviewerEvidence.weakEvidence);
		const promptOnlyCaveats = asStringArray(parsedReviewerEvidence.promptOnlyCaveats);
		const unresolvedRisks = asStringArray(parsedReviewerEvidence.unresolvedRisks);
		const finalOutput = typeof parsedReviewerEvidence.finalOutput === "string" && parsedReviewerEvidence.finalOutput.trim() ? parsedReviewerEvidence.finalOutput : undefined;
		nextLedger = appendEvent(nextLedger, {
			runId: input.runId,
			kind: "reviewer_evidence",
			provenance: "legacy",
			status: "recorded",
			context: input.context,
			source: input.sourceLabel ?? "done-sidecar.summary",
			warnings: warningStrings,
			payload: {
				role,
				verdict,
				effectiveVerdict,
				blockingReasons,
				weakEvidence,
				promptOnlyCaveats,
				unresolvedRisks,
				...(finalOutput ? { finalOutput } : {}),
			},
		}, input.now);
	}
	// TASK-002 hard-cut: mirror the nested
	// `coderEvidence.delegateHistory.reviewerEvidence` and
	// `delegateHistory.reviewerEvidence` payloads as a typed
	// `reviewer_evidence` event with `provenance: "legacy"`. The
	// original structured payload is also surfaced via
	// `mirroredReviewerEvidence` (preferring the top-level
	// `reviewerEvidence` when present) for diagnostic / projection
	// consumers. The TASK-002 strict delegate reviewer-roles gate
	// MUST NOT consume this mirror as pass/fail authority — the
	// only canonical path is `done.evidence.reviewerEvidence` (or
	// its in-memory equivalents on result details).
	let mirrorReviewerSource: Record<string, unknown> | undefined;
	if (parsedReviewerEvidence !== undefined) mirrorReviewerSource = parsedReviewerEvidence;
	else if (asRecord(nestedCoderDelegateHistoryReviewer) !== undefined) mirrorReviewerSource = asRecord(nestedCoderDelegateHistoryReviewer);
	else if (asRecord(nestedDelegateHistoryReviewer) !== undefined) mirrorReviewerSource = asRecord(nestedDelegateHistoryReviewer);
	if (mirrorReviewerSource !== undefined && parsedReviewerEvidence === undefined) {
		const role = trimString(mirrorReviewerSource.role) || "unknown";
		const verdictRaw = trimString(mirrorReviewerSource.verdict) || trimString(mirrorReviewerSource.effectiveVerdict);
		const verdict = verdictRaw === "APPROVED" || verdictRaw === "CHANGES_REQUESTED" || verdictRaw === "UNKNOWN" ? verdictRaw : "UNKNOWN";
		const effectiveVerdictRaw = trimString(mirrorReviewerSource.effectiveVerdict) || verdict;
		const effectiveVerdict = effectiveVerdictRaw === "APPROVED" || effectiveVerdictRaw === "CHANGES_REQUESTED" || effectiveVerdictRaw === "UNKNOWN" ? effectiveVerdictRaw : verdict;
		const blockingReasons = asStringArray(mirrorReviewerSource.blockingReasons);
		const weakEvidence = asStringArray(mirrorReviewerSource.weakEvidence);
		const promptOnlyCaveats = asStringArray(mirrorReviewerSource.promptOnlyCaveats);
		const unresolvedRisks = asStringArray(mirrorReviewerSource.unresolvedRisks);
		const finalOutput = typeof mirrorReviewerSource.finalOutput === "string" && mirrorReviewerSource.finalOutput.trim() ? mirrorReviewerSource.finalOutput : undefined;
		nextLedger = appendEvent(nextLedger, {
			runId: input.runId,
			kind: "reviewer_evidence",
			provenance: "legacy",
			status: "recorded",
			context: input.context,
			source: input.sourceLabel ?? "done-sidecar.summary",
			warnings: warningStrings,
			payload: {
				role,
				verdict,
				effectiveVerdict,
				blockingReasons,
				weakEvidence,
				promptOnlyCaveats,
				unresolvedRisks,
				...(finalOutput ? { finalOutput } : {}),
			},
		}, input.now);
	}

	return {
		ledger: nextLedger,
		events: nextLedger.events.slice(input.ledger.events.length),
		warnings,
		detected: "summary",
		freeFormOnly: !hasStructured,
		mirroredCoderEvidence: parsedCoderEvidence,
		mirroredReviewerEvidence: mirrorReviewerSource,
	};
}

function importGenericObject(input: SubAdapterInput): ImportLegacyResult {
	const warnings: LegacyImportWarning[] = [];
	pushWarning(warnings, "unreadable_input", "Legacy object had no recognized structured field; imported as opaque legacy_import with no structured content.");
	const rawSummary = truncateForSummary(safeRawText(input.payload), 4000);
	const warningStrings = formatWarningStrings(warnings);
	const nextLedger = appendEvent(input.ledger, {
		runId: input.runId,
		kind: "legacy_import",
		provenance: "legacy",
		status: "recorded",
		context: input.context,
		source: input.sourceLabel ?? "legacy-object",
		warnings: warningStrings,
		payload: {
			importedFrom: "freeFormOnly",
			originalSource: input.sourceLabel ?? "legacy-object",
			rawSummary,
			hasStructuredContent: false,
		},
	}, input.now);
	const imported = nextLedger.events[nextLedger.events.length - 1];
	const finalLedger = imported && imported.kind === "legacy_import"
		? markRejected(nextLedger, imported.eventId, input.now, warningStrings)
		: nextLedger;
	return { ledger: finalLedger, events: finalLedger.events.slice(input.ledger.events.length), warnings, detected: "freeFormOnly", freeFormOnly: true, mirroredCoderEvidence: undefined, mirroredReviewerEvidence: undefined };
}

interface FreeFormFallbackInput extends SubAdapterInput {
	freeFormReason: string;
}

function importFreeFormFallback(input: FreeFormFallbackInput): ImportLegacyResult {
	const warnings: LegacyImportWarning[] = [];
	pushWarning(warnings, "no_structured_content", input.freeFormReason);
	pushWarning(warnings, "free_form_only", "Legacy input lacked structured evidence fields; not authoritative.");
	const rawSummary = truncateForSummary(safeRawText(input.payload), 4000);
	const warningStrings = formatWarningStrings(warnings);
	const nextLedger = appendEvent(input.ledger, {
		runId: input.runId,
		kind: "legacy_import",
		provenance: "legacy",
		status: "recorded",
		context: input.context,
		source: input.sourceLabel ?? "free-form-only",
		warnings: warningStrings,
		payload: {
			importedFrom: "freeFormOnly",
			originalSource: input.sourceLabel ?? "free-form-only",
			rawSummary,
			hasStructuredContent: false,
		},
	}, input.now);
	const imported = nextLedger.events[nextLedger.events.length - 1];
	const finalLedger = imported && imported.kind === "legacy_import"
		? markRejected(nextLedger, imported.eventId, input.now, warningStrings)
		: nextLedger;
	return { ledger: finalLedger, events: finalLedger.events.slice(input.ledger.events.length), warnings, detected: "freeFormOnly", freeFormOnly: true, mirroredCoderEvidence: undefined, mirroredReviewerEvidence: undefined };
}

// ---------- Detection helpers ----------

function detectDelegateFlags(record: Record<string, unknown>): { autoExit: boolean; processExit: boolean; missing: boolean } {
	const out = { autoExit: false, processExit: false, missing: false };
	if (record.autoExitObserved === true) out.autoExit = true;
	if (record.processExitObserved === true) out.processExit = true;
	if (record.missingSidecarObserved === true) out.missing = true;
	const text = JSON.stringify(record).toLowerCase();
	if (text.includes("auto_exit") || text.includes("auto-exit") || text.includes("auto exit")) out.autoExit = true;
	if (text.includes("process_exit") || text.includes("process-exit") || text.includes("process exit")) out.processExit = true;
	if (text.includes("missing sidecar") || text.includes("no done sidecar") || text.includes("missing-sidecar")) out.missing = true;
	return out;
}

function hasStructuredCoderContent(record: Record<string, unknown>): boolean {
	const commands = Array.isArray(record.commandsRun) ? record.commandsRun : [];
	const coverage = Array.isArray(record.criterionCoverage) ? record.criterionCoverage : [];
	const files = Array.isArray(record.filesChanged) ? record.filesChanged : [];
	const summary = typeof record.summary === "string" && record.summary.trim().length > 0;
	const hasCommand = commands.some((c) => {
		const r = asRecord(c);
		return r !== undefined && trimString(r.command).length > 0;
	});
	const hasCoverage = coverage.some((c) => {
		const r = asRecord(c);
		return r !== undefined && trimString(r.criterion).length > 0;
	});
	return files.length > 0 || hasCommand || hasCoverage || summary;
}

// ---------- Convenience: legacy import for canonical DELIVERY DONE sidecars ----------

/** Convenience helper that runs `importLegacyEvidence` on a (possibly
 *  string-encoded JSON) done sidecar value. When the sidecar is a JSON
 *  string we parse it first so the structured adapter dispatchers can see
 *  the `coderEvidence` / `reviewerEvidence` / `summary` fields. */
export function importLegacyDoneSidecar(input: {
	runId: string;
	context: DeliveryRunContext;
	sidecar: unknown;
	sourceLabel?: string;
	now: NowProvider;
	ledger?: EvidenceLedger;
}): ImportLegacyResult {
	return importLegacyEvidence({
		runId: input.runId,
		context: input.context,
		source: tryParseJsonSummary(input.sidecar),
		sourceLabel: input.sourceLabel ?? "done-sidecar",
		now: input.now,
		...(input.ledger ? { ledger: input.ledger } : {}),
	});
}

/** Re-export snapshotLedger for callers that want to read the updated
 *  ledger state without mutating it. */
export { snapshotLedger };

// ---------- Typed payload projection from a legacy import result ----------

/** Pick the typed `coder_evidence` payload mirrored by the legacy
 *  import adapter. Returns the ORIGINAL structured payload (not the
 *  ledger-normalized event payload) so the caller can consume the
 *  full set of fields (including `supportingFiles` /
 *  `supportingCommands` on criterionCoverage rows, which the ledger
 *  type strips). Returns `undefined` when the legacy adapter did not
 *  produce a structured coder_evidence mirror (i.e. the input was
 *  free-form only or no coder-shaped fields were found).
 *
 *  TASK-002 hard-cut: this helper is retained for non-gate
 *  consumers (legacy ledger queries, project-history views, smoke
 *  fixtures) that may still want the original payload. The TASK-002
 *  strict delegate coder gate MUST NOT consume this mirror as
 *  pass/fail authority; the gate reads only `done.evidence.coderEvidence`
 *  (or its in-memory equivalents on result details). */
export function pickLegacyCoderEvidence(result: ImportLegacyResult): unknown | undefined {
	return result.mirroredCoderEvidence;
}

/** Pick the typed `reviewer_evidence` payload mirrored by the legacy
 *  import adapter. Returns the ORIGINAL structured payload (not the
 *  ledger-normalized event payload). Returns `undefined` when the
 *  legacy adapter did not produce a structured reviewer_evidence
 *  mirror.
 *
 *  TASK-002 hard-cut: this helper is retained for non-gate
 *  consumers. The TASK-002 strict delegate reviewer-roles gate
 *  MUST NOT consume this mirror as pass/fail authority; the
 *  reviewer-roles gate reads only canonical
 *  `done.evidence.reviewerEvidence` (or its in-memory
 *  equivalents). */
export function pickLegacyReviewerEvidence(result: ImportLegacyResult): unknown | undefined {
	return result.mirroredReviewerEvidence;
}
