// TASK-002 — focused canonical-evidence envelope parser.
//
// HARD-CUT (TASK-002 rerun): the only gate-authoritative evidence path
// is the canonical `done.evidence` envelope (or its in-memory equivalents
// `result.details.evidence` / `result.details.done.evidence`). Deprecated
// top-level `coderEvidence` / `reviewerEvidence` / `summary` /
// `delegateHistory` fields are diagnostic only. This module no longer
// routes inputs through the delivery legacy-import adapter. When an
// input is not a canonical envelope, the helper returns
// `provenance: "none"` and `freeFormOnly: true` so the receiving gates
// fail closed.
//
// Recognized canonical shapes (TASK-002 hardened contract):
//   - `{ evidence: { coderEvidence, reviewerEvidence, warnings?, event? } }`
//   - `{ done: { evidence: { coderEvidence, reviewerEvidence, ... } } }`
//   - Direct canonical envelope passed as `details.evidence` /
//     `done.evidence` (i.e. an object whose `coderEvidence` /
//     `reviewerEvidence` / `event` fields are typed and NOT mixed with
//     full-sidecar markers like `summary` / `from_exit` / `delegateHistory`).
//   - EvidenceEvent-shaped single event:
//     `{ kind: "coder_evidence" | "reviewer_evidence", provenance, payload, ... }`
//   - EvidenceLedger-shaped envelope: `{ events: [...] }`.
//
// Anything else (top-level `coderEvidence` / `reviewerEvidence` on a
// parsed done sidecar with `summary` / `from_exit` / `delegateHistory` /
// etc.) is recognized as a LEGACY field. The helper now returns
// `provenance: "none"` so the gate consumes the empty fallback packet
// and the matrix-gated plan fails closed. Free-form / unrecognized
// shapes are also `provenance: "none"`. The previous legacy-adapter
// bridge that mirrored structured content from `coderEvidence` /
// `reviewerEvidence` / summary JSON / nested delegateHistory reviewer
// payloads into the gate has been DELETED.

import type {
	EvidenceEvent,
	EvidenceProvenance,
} from "../delivery/types";

// ---------- Public types ----------

/** What a canonical extraction yielded, with provenance + warnings. */
export interface CanonicalExtraction {
	/** Structured `coderEvidence` payload (current-run typed object). */
	coderEvidence: unknown | undefined;
	/** Structured `reviewerEvidence` payload (current-run typed object). */
	reviewerEvidence: unknown | undefined;
	/** Provenance of the structured payload. `"canonical"` when the
	 *  canonical `done.evidence` envelope was used; `"none"` otherwise. */
	provenance: EvidenceProvenance | "none";
	/** Stable warning codes / messages. Always empty under the TASK-002
	 *  hard-cut: the legacy adapter no longer runs from the canonical
	 *  parser. The field is kept for forward compatibility and
	 *  diagnostic surface (operators can still see why an extraction
	 *  returned `provenance: "none"`). */
	warnings: string[];
	/** True when the input is free-form-only and no structured payload
	 *  could be extracted. The gate must refuse this on matrix-gated
	 *  plans. */
	freeFormOnly: boolean;
	/** True when the extraction would have routed through the legacy
	 *  adapter in the previous (deprecated) implementation. Always
	 *  false under the TASK-002 hard-cut. Kept as a diagnostic field
	 *  for callers that need to detect removed authority paths. */
	usedLegacyAdapter: boolean;
}

/** Minimal context stub retained for backward source compatibility. The
 *  legacy adapter no longer runs from this module, so the context is
 *  accepted but ignored. */
export interface CanonicalExtractionContext {
	runId?: string;
	deliveryContext?: unknown;
	now?: unknown;
}

// ---------- Helpers ----------

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim()) out.push(item.trim());
	}
	return out;
}

function isCoderEvidenceEventLike(value: unknown): value is EvidenceEvent & { kind: "coder_evidence" } {
	const record = asRecord(value);
	return !!record && record.kind === "coder_evidence";
}

function isReviewerEvidenceEventLike(value: unknown): value is EvidenceEvent & { kind: "reviewer_evidence" } {
	const record = asRecord(value);
	return !!record && record.kind === "reviewer_evidence";
}

function isLedgerShaped(value: unknown): value is { events: EvidenceEvent[] } {
	const record = asRecord(value);
	if (!record) return false;
	if (!Array.isArray(record.events)) return false;
	for (const ev of record.events) if (!asRecord(ev) || typeof (ev as { kind?: unknown }).kind !== "string") return false;
	return true;
}

/** Check whether a candidate event record carries the canonical
 *  `provenance === "canonical"` marker. Used by the
 *  EvidenceEvent-shaped and EvidenceLedger-shaped paths so a
 *  TASK-001 legacy-import event (provenance `"legacy"`,
 *  `"manual"`, `"projection"`, or any other non-canonical value,
 *  including the absent-provenance case) is NEVER accepted as
 *  gate authority. The gate must read structured payloads only from
 *  current-run canonical events; legacy-import events are diagnostic
 *  surface only and must fail closed when placed under
 *  `details.evidence.event` or `{ events: [...] }`. */
function isCanonicalEvidenceEvent(value: unknown): boolean {
	const record = asRecord(value);
	if (!record) return false;
	return record.provenance === "canonical";
}

/** Sidecar-shape markers. Presence of any of these on the input object
 *  means the input is a full done sidecar / result details, so any
 *  top-level `coderEvidence` / `reviewerEvidence` / `summary` /
 *  `delegateHistory` fields on it are LEGACY. The hard-cut contract
 *  refuses to read these as canonical authority. */
const SIDECAR_MARKER_KEYS: readonly string[] = [
	"done", "completion", "source", "from_exit", "from_auto_exit",
	"at", "tool", "exit_code", "stop_reason", "warning",
	"summary", "delegateHistory",
];

function looksLikeFullSidecar(record: Record<string, unknown>): boolean {
	for (const key of SIDECAR_MARKER_KEYS) {
		if (key in record) return true;
	}
	return false;
}

/** Extract the typed payload from a coder_evidence-like event. The
 *  legacy adapter / ledger normalizer strips unknown fields, so the
 *  helper just surfaces `payload` directly. */
function payloadFromEvent(event: EvidenceEvent): unknown {
	return (event as { payload?: unknown }).payload;
}

/** Pick the first CANONICAL coder_evidence event from a ledger-shaped
 *  value. TASK-001 legacy-import events (provenance `"legacy"`,
 *  `"manual"`, `"projection"`, or any non-canonical / missing value)
 *  are skipped so a legacy-import event placed in a ledger cannot
 *  become gate authority. */
function pickCoderEvidenceFromLedger(ledger: { events: EvidenceEvent[] }): EvidenceEvent | undefined {
	for (const ev of ledger.events) {
		if (ev.kind === "coder_evidence" && ev.provenance === "canonical") return ev;
	}
	return undefined;
}

/** Pick the first CANONICAL reviewer_evidence event from a
 *  ledger-shaped value. Same canonical-only rule as
 *  `pickCoderEvidenceFromLedger`; legacy-import / manual /
 *  projection / undefined-provenance events are skipped. */
function pickReviewerEvidenceFromLedger(ledger: { events: EvidenceEvent[] }): EvidenceEvent | undefined {
	for (const ev of ledger.events) {
		if (ev.kind === "reviewer_evidence" && ev.provenance === "canonical") return ev;
	}
	return undefined;
}

// ---------- Canonical payload extraction ----------

/** Walk the well-known canonical envelopes and return the typed
 *  coder/reviewer payloads plus provenance. Top-level
 *  `coderEvidence` / `reviewerEvidence` / `summary` on a parsed done
 *  sidecar / result details is no longer canonical: the helper returns
 *  `provenance: "none"` and `freeFormOnly: true` so the receiving
 *  gates refuse. The previous legacy-adapter fallback has been
 *  deleted. */
export function extractCanonicalEvidence(input: unknown, _context: CanonicalExtractionContext = {}): CanonicalExtraction {
	if (input === undefined || input === null) {
		return emptyExtraction();
	}
	if (typeof input === "string") {
		// String inputs are NEVER canonical envelopes under the hard-cut.
		// Previously the helper tried to parse JSON-encoded canonical
		// evidence from a string field; that legacy bridge is removed
		// so the gate fails closed.
		return emptyExtraction();
	}
	const record = asRecord(input);
	if (!record) return emptyExtraction();

	// 1) Canonical envelope: { evidence: { coderEvidence, reviewerEvidence } }
	const envelope = asRecord(record.evidence);
	if (envelope) {
		const coder = envelope.coderEvidence;
		const reviewer = envelope.reviewerEvidence;
		if (coder !== undefined || reviewer !== undefined) {
			return {
				coderEvidence: coder,
				reviewerEvidence: reviewer,
				provenance: "canonical",
				usedLegacyAdapter: false,
				warnings: asStringArray(envelope.warnings),
				freeFormOnly: false,
			};
		}
		// 1b) Canonical envelope with single `event` (EvidenceEvent-shaped).
		if (envelope.event !== undefined) {
			return extractCanonicalEvidence(envelope.event);
		}
	}

	// 2) Nested parsed result: { done: { evidence: { coderEvidence,
	//    reviewerEvidence } } } — i.e. a parsed done sidecar wrapped in
	//    `result.details.done`. Dispatch into the envelope helper
	//    recursively so the canonical precedence is preserved.
	const done = asRecord(record.done);
	const doneEnvelope = done ? asRecord(done.evidence) : undefined;
	if (doneEnvelope) {
		const coder = doneEnvelope.coderEvidence;
		const reviewer = doneEnvelope.reviewerEvidence;
		if (coder !== undefined || reviewer !== undefined) {
			return {
				coderEvidence: coder,
				reviewerEvidence: reviewer,
				provenance: "canonical",
				usedLegacyAdapter: false,
				warnings: asStringArray(doneEnvelope.warnings),
				freeFormOnly: false,
			};
		}
		if (doneEnvelope.event !== undefined) {
			return extractCanonicalEvidence(doneEnvelope.event);
		}
	}

	// 3) Direct canonical envelope: an object that is JUST the canonical
	//    envelope shape (top-level `coderEvidence` / `reviewerEvidence` /
	//    `warnings` / `event`) without any of the full-sidecar markers. This
	//    matches callers that pass `details.evidence` / `done.evidence`
	//    (i.e. the envelope already extracted from the sidecar) directly
	//    into the helper. Top-level `coderEvidence` / `reviewerEvidence`
	//    on a FULL sidecar (with `done` / `summary` / `from_exit` / etc.)
	//    is recognized as LEGACY and falls through to the empty
	//    extraction so the gate consumes the empty fallback packet.
	if (!looksLikeFullSidecar(record)) {
		const directCoder = record.coderEvidence;
		const directReviewer = record.reviewerEvidence;
		if (directCoder !== undefined || directReviewer !== undefined) {
			return {
				coderEvidence: directCoder,
				reviewerEvidence: directReviewer,
				provenance: "canonical",
				usedLegacyAdapter: false,
				warnings: asStringArray(record.warnings),
				freeFormOnly: false,
			};
		}
		// Direct envelope with a single EvidenceEvent-shaped `event`.
		if (record.event !== undefined) {
			return extractCanonicalEvidence(record.event);
		}
	}

	// 4) EvidenceEvent-shaped single event: dispatch on kind, but
	//    ONLY accept events whose own `provenance === "canonical"`.
	//    TASK-001 legacy-import events (provenance `"legacy"`,
	//    `"manual"`, `"projection"`, or any other non-canonical value
	//    including the absent-provenance case) are NEVER canonical
	//    authority under the TASK-002 hard-cut. The legacy adapter
	//    is no longer running from this module, so a legacy-import
	//    event placed under `details.evidence.event` (or anywhere
	//    the parser is asked to read) must fall through to the
	//    empty extraction so the gate fails closed.
	if (isCoderEvidenceEventLike(record)) {
		if (!isCanonicalEvidenceEvent(record)) {
			return emptyExtraction();
		}
		return {
			coderEvidence: payloadFromEvent(record),
			reviewerEvidence: undefined,
			provenance: "canonical",
			usedLegacyAdapter: false,
			warnings: asStringArray(record.warnings),
			freeFormOnly: false,
		};
	}
	if (isReviewerEvidenceEventLike(record)) {
		if (!isCanonicalEvidenceEvent(record)) {
			return emptyExtraction();
		}
		return {
			coderEvidence: undefined,
			reviewerEvidence: payloadFromEvent(record),
			provenance: "canonical",
			usedLegacyAdapter: false,
			warnings: asStringArray(record.warnings),
			freeFormOnly: false,
		};
	}

	// 5) EvidenceLedger-shaped envelope: { events: [...] }
	//    Only CANONICAL-provenance coder_evidence / reviewer_evidence
	//    events are accepted. Legacy-import / manual / projection /
	//    undefined-provenance events are ignored. If no canonical
	//    event of either kind is present, the helper returns the
	//    empty extraction so the gate consumes the empty fallback
	//    packet and the matrix-gated plan fails closed.
	if (isLedgerShaped(record)) {
		const coderEvent = pickCoderEvidenceFromLedger(record);
		const reviewerEvent = pickReviewerEvidenceFromLedger(record);
		const coder = coderEvent ? payloadFromEvent(coderEvent) : undefined;
		const reviewer = reviewerEvent ? payloadFromEvent(reviewerEvent) : undefined;
		if (coder !== undefined || reviewer !== undefined) {
			const warnings: string[] = [];
			for (const ev of record.events) warnings.push(...asStringArray((ev as { warnings?: unknown }).warnings));
			return {
				coderEvidence: coder,
				reviewerEvidence: reviewer,
				provenance: "canonical",
				usedLegacyAdapter: false,
				warnings: uniqueOrdered(warnings),
				freeFormOnly: false,
			};
		}
	}

	// 6) Anything else (top-level `coderEvidence` / `reviewerEvidence` /
	//    `summary` / `delegateHistory` / `from_exit` / parseable JSON
	//    strings / etc. on a full sidecar or unrecognized shape) is
	//    NOT canonical. The previous legacy-import adapter fallback
	//    that mirrored structured content from these fields into the
	//    gate has been deleted. The helper returns the empty
	//    extraction so the gate consumes the empty fallback packet
	//    and the matrix-gated plan fails closed.
	return emptyExtraction();
}

/** Convenience: extract from a parsed done sidecar. */
export function extractCanonicalFromDoneSidecar(
	sidecar: unknown,
	context: CanonicalExtractionContext = {},
): CanonicalExtraction {
	return extractCanonicalEvidence(sidecar, context);
}

/** Convenience: extract from a `result.details.done` object that mirrors
 *  the parsed done sidecar. */
export function extractCanonicalFromResultDetails(
	details: unknown,
	context: CanonicalExtractionContext = {},
): CanonicalExtraction {
	if (!details || typeof details !== "object") return emptyExtraction();
	return extractCanonicalEvidence(details, context);
}

// ---------- Local helpers ----------

function emptyExtraction(): CanonicalExtraction {
	return {
		coderEvidence: undefined,
		reviewerEvidence: undefined,
		provenance: "none",
		usedLegacyAdapter: false,
		warnings: [],
		freeFormOnly: true,
	};
}

function uniqueOrdered(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		if (typeof v !== "string") continue;
		const trimmed = v.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}
