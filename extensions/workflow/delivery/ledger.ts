// TASK-001 Phase A — pure in-memory EvidenceLedger / DeliveryRun helpers.
// All helpers are pure: they never read or write disk, never call Date.now()
// (callers must pass `now`), and never import Pi runtime modules. This keeps
// the foundation unit-testable and reusable by later runtime integration
// (TASK-002..004) without depending on transport-specific state.

import {
	EVIDENCE_EVENT_KINDS,
	EVIDENCE_PROVENANCES,
	EVIDENCE_STATUSES,
	type DeliveryRun,
	type DeliveryRunContext,
	type EvidenceEvent,
	type EvidenceEventBase,
	type EvidenceEventKind,
	type EvidenceLedger,
	type EvidenceProvenance,
	type EvidenceStatus,
} from "./types";

// ---------- Determinism helpers ----------

/** Allowed `now` providers. A fixed ISO string, a Date, or a millisecond
 *  number all work; the helper never reads the wall clock itself. */
export type NowProvider = string | Date | number;

function normalizeNow(now: NowProvider | undefined, fallback?: string): string {
	if (now === undefined) {
		if (fallback !== undefined) return fallback;
		throw new Error("`now` is required: the ledger helpers are deterministic and never read the wall clock.");
	}
	if (typeof now === "string") {
		const trimmed = now.trim();
		if (!trimmed) throw new Error("`now` must be a non-empty ISO-8601 string.");
		return trimmed;
	}
	if (now instanceof Date) {
		if (Number.isNaN(now.getTime())) throw new Error("`now` Date is invalid.");
		return now.toISOString();
	}
	if (typeof now === "number" && Number.isFinite(now)) {
		return new Date(now).toISOString();
	}
	throw new Error("`now` must be a non-empty ISO string, Date, or finite number.");
}

function isEvidenceEventKind(value: string): value is EvidenceEventKind {
	return (EVIDENCE_EVENT_KINDS as readonly string[]).includes(value);
}

function isEvidenceProvenance(value: string): value is EvidenceProvenance {
	return (EVIDENCE_PROVENANCES as readonly string[]).includes(value);
}

function isEvidenceStatus(value: string): value is EvidenceStatus {
	return (EVIDENCE_STATUSES as readonly string[]).includes(value);
}

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

function pickProvenance(value: unknown): EvidenceProvenance {
	if (typeof value === "string" && isEvidenceProvenance(value)) return value;
	return "canonical";
}

function pickStatus(value: unknown): EvidenceStatus {
	if (typeof value === "string" && isEvidenceStatus(value)) return value;
	return "recorded";
}

function pickKind(value: unknown): EvidenceEventKind | undefined {
	if (typeof value === "string" && isEvidenceEventKind(value)) return value;
	return undefined;
}

// ---------- Defensive classification helpers ----------

/** True iff the event is a `legacy_import` event that carries no
 *  structured content. Such events must NEVER be promoted to `accepted`
 *  status — both the append-side guards and the accepted-current-run
 *  query filter rely on this predicate. Exported so smoke tests and
 *  later transports (TASK-002..004) can use the same definition. */
export function isFreeFormLegacyImport(event: EvidenceEvent): boolean {
	if (event.kind !== "legacy_import") return false;
	return event.payload.hasStructuredContent === false || event.payload.importedFrom === "freeFormOnly";
}

// ---------- ID generation ----------

/** Deterministic event id generator. Mirrors the existing TASK-003 / TASK-004
 *  pattern of `<kind>:<runId>:<seq>` and falls back to a counter when no
 *  per-kind sequence is supplied. */
export interface NextEventIdOptions {
	kind: EvidenceEventKind;
	runId: string;
	seq?: number;
	/** When a caller supplies a custom id it must be non-empty. */
	custom?: string;
	ledger?: EvidenceLedger;
}

export function nextEventId(options: NextEventIdOptions): string {
	const custom = typeof options.custom === "string" ? options.custom.trim() : "";
	if (custom) return custom;
	const seq = typeof options.seq === "number" && Number.isFinite(options.seq) && options.seq >= 0
		? Math.floor(options.seq)
		: (options.ledger ? countEventsByKind(options.ledger, options.kind) : 0);
	return `${options.kind}:${options.runId}:${seq + 1}`;
}

function countEventsByKind(ledger: EvidenceLedger, kind: EvidenceEventKind): number {
	let n = 0;
	for (const e of ledger.events) if (e.kind === kind) n += 1;
	return n;
}

// ---------- Builders ----------

export interface CreateDeliveryRunInput {
	runId: string;
	taskId?: string;
	planId?: string;
	phaseId?: string;
	laneId?: string;
	now: NowProvider;
}

export function createDeliveryRun(input: CreateDeliveryRunInput): DeliveryRun {
	const runId = trimString(input.runId);
	if (!runId) throw new Error("createDeliveryRun: `runId` is required.");
	const at = normalizeNow(input.now);
	const context: DeliveryRunContext = { runId };
	if (input.taskId) context.taskId = input.taskId;
	if (input.planId) context.planId = input.planId;
	if (input.phaseId) context.phaseId = input.phaseId;
	if (input.laneId) context.laneId = input.laneId;
	return {
		runId,
		...(input.taskId ? { taskId: input.taskId } : {}),
		...(input.planId ? { planId: input.planId } : {}),
		...(input.phaseId ? { currentPhaseId: input.phaseId } : {}),
		...(input.laneId ? { currentLaneId: input.laneId } : {}),
		createdAt: at,
		updatedAt: at,
		ledger: { ledgerId: `ledger:${runId}`, runId, createdAt: at, updatedAt: at, events: [] },
	};
}

export interface CreateEvidenceLedgerInput {
	runId: string;
	ledgerId?: string;
	now: NowProvider;
}

export function createEvidenceLedger(input: CreateEvidenceLedgerInput): EvidenceLedger {
	const runId = trimString(input.runId);
	if (!runId) throw new Error("createEvidenceLedger: `runId` is required.");
	const at = normalizeNow(input.now);
	return {
		ledgerId: trimString(input.ledgerId) || `ledger:${runId}`,
		runId,
		createdAt: at,
		updatedAt: at,
		events: [],
	};
}

// ---------- Append ----------

/** Base fields that every event must provide. Per-kind helpers or callers
 *  extend this with their kind-specific payload. */
export interface AppendEventInput {
	runId: string;
	kind: EvidenceEventKind;
	provenance?: EvidenceProvenance;
	status?: EvidenceStatus;
	recordedAt?: NowProvider;
	context: DeliveryRunContext;
	warnings?: string[];
	source?: string;
	eventId?: string;
	seq?: number;
	supersededBy?: string;
	supersedes?: string;
	payload: unknown;
}

function normalizeBase(input: AppendEventInput, ledger: EvidenceLedger, now: string): EvidenceEventBase {
	if (!input.context || input.context.runId !== input.runId) {
		throw new Error(`appendEvent: context.runId (${input.context?.runId}) does not match runId (${input.runId}).`);
	}
	const provenance = pickProvenance(input.provenance);
	const status = pickStatus(input.status);
	const recordedAt = input.recordedAt !== undefined ? normalizeNow(input.recordedAt, now) : now;
	const warnings = Array.isArray(input.warnings) ? asStringArray(input.warnings) : [];
	const base: EvidenceEventBase = {
		eventId: nextEventId({
			kind: input.kind,
			runId: input.runId,
			...(input.eventId !== undefined ? { custom: input.eventId } : {}),
			...(input.seq !== undefined ? { seq: input.seq } : {}),
			ledger,
		}),
		runId: input.runId,
		kind: input.kind,
		provenance,
		status,
		recordedAt,
		context: input.context,
		warnings,
	};
	if (input.source !== undefined) base.source = trimString(input.source) || undefined;
	if (input.supersededBy !== undefined) base.supersededBy = trimString(input.supersededBy) || undefined;
	if (input.supersedes !== undefined) base.supersedes = trimString(input.supersedes) || undefined;
	return base;
}

/** Append a typed event. The discriminator (`input.kind`) is enforced; an
 *  unknown kind or a mismatched payload is rejected with an Error.
 *
 *  Invariants:
 *   - `input.runId` must equal `ledger.runId` (rejects cross-run leaks).
 *   - `input.context.runId` must equal `input.runId` (rejects mismatched
 *     run context).
 *   - `event.eventId` must not already exist in the ledger (rejects
 *     duplicate IDs). */
export function appendEvent(ledger: EvidenceLedger, input: AppendEventInput, now: NowProvider): EvidenceLedger {
	if (input.runId !== ledger.runId) {
		throw new Error(`appendEvent: input.runId (${input.runId}) does not match ledger.runId (${ledger.runId}).`);
	}
	const at = normalizeNow(now);
	const base = normalizeBase(input, ledger, at);
	const event = buildEvent(base, input.payload);
	// Defensive guard: a free-form `legacy_import` event is never
	// authoritative, so it must NEVER be created with `status === "accepted"`.
	// This is the append-side counterpart to the
	// `markEventStatus` accepted-rejection guard and the
	// `findAcceptedCurrentRun` defensive filter. Without this guard a caller
	// could bypass the status-transition check by passing `status: "accepted"`
	// directly in the append input. Reuses the exported
	// `isFreeFormLegacyImport` classifier so all three guards stay in lockstep.
	if (event.status === "accepted" && isFreeFormLegacyImport(event)) {
		throw new Error(`appendEvent: cannot append free-form legacy_import event ${event.eventId} with status "accepted"; legacy free-form evidence is never authoritative.`);
	}
	for (const existing of ledger.events) {
		if (existing.eventId === event.eventId) {
			throw new Error(`appendEvent: duplicate eventId ${event.eventId} for kind ${event.kind}.`);
		}
	}
	const next: EvidenceLedger = { ...ledger, events: ledger.events.concat(event), updatedAt: at };
	return next;
}

function buildEvent(base: EvidenceEventBase, payload: unknown): EvidenceEvent {
	switch (base.kind) {
		case "coder_evidence": return { ...base, kind: "coder_evidence", payload: buildCoderPayload(payload) };
		case "reviewer_evidence": return { ...base, kind: "reviewer_evidence", payload: buildReviewerPayload(payload) };
		case "gate_decision": return { ...base, kind: "gate_decision", payload: buildGatePayload(payload) };
		case "finalization_decision": return { ...base, kind: "finalization_decision", payload: buildFinalizationPayload(payload) };
		case "quality_audit_blocker": return { ...base, kind: "quality_audit_blocker", payload: buildQualityAuditPayload(payload) };
		case "afk_reference": return { ...base, kind: "afk_reference", payload: buildAfkPayload(payload) };
		case "legacy_import": return { ...base, kind: "legacy_import", payload: buildLegacyImportPayload(payload) };
	}
}

function buildCoderPayload(payload: unknown): EvidenceEvent & { kind: "coder_evidence" } extends infer _ ? import("./types").CoderEvidencePayload : never {
	const record = asRecord(payload) ?? {};
	const commandsRun: import("./types").CoderEvidenceCommand[] = [];
	const cmds = Array.isArray(record.commandsRun) ? record.commandsRun : [];
	for (let i = 0; i < cmds.length; i += 1) {
		const item = asRecord(cmds[i]);
		if (!item) continue;
		const command = trimString(item.command);
		if (!command) continue;
		const outcome = trimString(item.outcome);
		if (outcome !== "passed" && outcome !== "failed" && outcome !== "skipped") continue;
		const entry: import("./types").CoderEvidenceCommand = { command, outcome };
		const itemSummary = trimString(item.summary);
		if (itemSummary) entry.summary = itemSummary;
		if (typeof item.exitCode === "number" && Number.isFinite(item.exitCode)) entry.exitCode = item.exitCode;
		commandsRun.push(entry);
	}
	const criterionCoverage: import("./types").CoderEvidenceCriterion[] = [];
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
	return {
		filesChanged: asStringArray(record.filesChanged),
		commandsRun,
		criterionCoverage,
		...(summary ? { summary } : {}),
	};
}

function buildReviewerPayload(payload: unknown): import("./types").ReviewerEvidencePayload {
	const record = asRecord(payload) ?? {};
	const role = trimString(record.role) || "unknown";
	const verdict = pickReviewerVerdict(record.verdict);
	const effectiveVerdict = pickReviewerVerdict(record.effectiveVerdict);
	return {
		role,
		verdict,
		effectiveVerdict,
		blockingReasons: asStringArray(record.blockingReasons),
		weakEvidence: asStringArray(record.weakEvidence),
		promptOnlyCaveats: asStringArray(record.promptOnlyCaveats),
		unresolvedRisks: asStringArray(record.unresolvedRisks),
		...(typeof record.finalOutput === "string" && record.finalOutput.trim() ? { finalOutput: record.finalOutput } : {}),
	};
}

function pickReviewerVerdict(value: unknown): "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN" {
	if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "UNKNOWN") return value;
	return "UNKNOWN";
}

function buildGatePayload(payload: unknown): import("./types").GateDecisionPayload {
	const record = asRecord(payload) ?? {};
	const gateId = trimString(record.gateId);
	const outcome = record.outcome === "advance" || record.outcome === "block" ? record.outcome : "block";
	const reason = trimString(record.reason) || undefined;
	return {
		gateId,
		outcome,
		...(reason ? { reason } : {}),
		rejectionCodes: asStringArray(record.rejectionCodes),
	};
}

function buildFinalizationPayload(payload: unknown): import("./types").FinalizationDecisionPayload {
	const record = asRecord(payload) ?? {};
	const recommended = record.recommendedStatus === "provisional_done"
		|| record.recommendedStatus === "prompt_only_mitigation"
		|| record.recommendedStatus === "done"
		? record.recommendedStatus
		: "done";
	return {
		requestedStatus: trimString(record.requestedStatus) || "done",
		recommendedStatus: recommended,
		blockers: asStringArray(record.blockers),
		warnings: asStringArray(record.warnings),
		allowed: record.allowed === true,
	};
}

function buildQualityAuditPayload(payload: unknown): import("./types").QualityAuditBlockerPayload {
	const record = asRecord(payload) ?? {};
	const severity = record.severity === "critical" || record.severity === "high" || record.severity === "medium"
		|| record.severity === "low" || record.severity === "warning" || record.severity === "info"
		? record.severity
		: "warning";
	return {
		severity,
		code: trimString(record.code) || "unspecified",
		message: trimString(record.message) || "(no message)",
		evidenceRefs: asStringArray(record.evidenceRefs),
	};
}

function buildAfkPayload(payload: unknown): import("./types").AfkReferencePayload {
	const record = asRecord(payload) ?? {};
	const laneId = trimString(record.laneId);
	const summary = trimString(record.summary) || "(no summary)";
	const escalation = trimString(record.escalation) || undefined;
	return {
		laneId,
		referencedEventIds: asStringArray(record.referencedEventIds),
		summary,
		...(escalation ? { escalation } : {}),
	};
}

function buildLegacyImportPayload(payload: unknown): import("./types").LegacyImportPayload {
	const record = asRecord(payload) ?? {};
	const importedFrom = pickLegacyImportSource(record.importedFrom);
	const originalSource = trimString(record.originalSource) || importedFrom;
	const rawSummary = trimString(record.rawSummary) || undefined;
	const hasStructuredContent = record.hasStructuredContent === true;
	return {
		importedFrom,
		originalSource,
		...(rawSummary ? { rawSummary } : {}),
		hasStructuredContent,
	};
}

function pickLegacyImportSource(value: unknown): import("./types").LegacyImportSourceKind {
	if (value === "coderEvidence" || value === "reviewerEvidence" || value === "summary"
		|| value === "delegateHistory" || value === "doneSidecar" || value === "freeFormOnly") {
		return value;
	}
	return "freeFormOnly";
}

// ---------- Status transitions ----------

export interface MarkStatusOptions {
	status: EvidenceStatus;
	now: NowProvider;
	supersededBy?: string;
	addWarnings?: string[];
}

/** Apply a status transition to a single event by id. Throws when the event
 *  is missing; returns an unchanged ledger when no transition is needed.
 *  When status === "superseded", the caller MUST supply `supersededBy`.
 *  Status transitions only ever mutate the targeted event; no other events
 *  are modified.
 *
 *  Invariants:
 *   - Exactly one event in the ledger must match `eventId`; zero or more
 *     than one is a hard error (defense in depth against duplicate IDs).
 *   - Status transitions to `accepted` are REJECTED for free-form
 *     `legacy_import` events (no structured content / importedFrom
 *     "freeFormOnly"). The defensive `findAcceptedCurrentRun` filter is
 *     the second line of defense. */
export function markEventStatus(ledger: EvidenceLedger, eventId: string, options: MarkStatusOptions): EvidenceLedger {
	const trimmedId = trimString(eventId);
	if (!trimmedId) throw new Error("markEventStatus: `eventId` is required.");
	const at = normalizeNow(options.now);
	const addWarnings = Array.isArray(options.addWarnings) ? asStringArray(options.addWarnings) : [];
	const nextEvents: EvidenceEvent[] = [];
	let matchCount = 0;
	for (const e of ledger.events) {
		if (e.eventId !== trimmedId) { nextEvents.push(e); continue; }
		matchCount += 1;
		if (matchCount > 1) break; // short-circuit; assertion below surfaces the error.
		if (options.status === "superseded" && !trimString(options.supersededBy)) {
			throw new Error("markEventStatus: `supersededBy` is required when status === \"superseded\".");
		}
		if (options.status === "accepted" && isFreeFormLegacyImport(e)) {
			throw new Error(`markEventStatus: cannot transition free-form legacy_import event ${trimmedId} to status \"accepted\"; legacy free-form evidence is never authoritative.`);
		}
		const warnings = e.warnings.slice();
		if (addWarnings.length > 0) warnings.push(...addWarnings);
		const nextEvent: EvidenceEvent = options.status === "superseded"
			? { ...e, status: "superseded", supersededBy: trimString(options.supersededBy), warnings, recordedAt: at }
			: { ...e, status: options.status, warnings, recordedAt: at };
		nextEvents.push(nextEvent);
	}
	if (matchCount !== 1) {
		throw new Error(`markEventStatus: expected exactly 1 event with id ${trimmedId}, found ${matchCount}.`);
	}
	return { ...ledger, events: nextEvents, updatedAt: at };
}

/** Mark the targeted event as accepted, optionally adding warnings. */
export function markAccepted(ledger: EvidenceLedger, eventId: string, now: NowProvider, addWarnings?: string[]): EvidenceLedger {
	return markEventStatus(ledger, eventId, { status: "accepted", now, ...(addWarnings ? { addWarnings } : {}) });
}

/** Mark the targeted event as rejected, optionally adding reasons/warnings. */
export function markRejected(ledger: EvidenceLedger, eventId: string, now: NowProvider, addWarnings?: string[]): EvidenceLedger {
	return markEventStatus(ledger, eventId, { status: "rejected", now, ...(addWarnings ? { addWarnings } : {}) });
}

/** Mark the targeted event as superseded by `supersededBy`. */
export function markSuperseded(ledger: EvidenceLedger, eventId: string, supersededBy: string, now: NowProvider): EvidenceLedger {
	return markEventStatus(ledger, eventId, { status: "superseded", now, supersededBy });
}

// ---------- Query helpers ----------

/** Generic predicate-based query. */
export function queryEvents(ledger: EvidenceLedger, predicate: (event: EvidenceEvent) => boolean): EvidenceEvent[] {
	const out: EvidenceEvent[] = [];
	for (const e of ledger.events) if (predicate(e)) out.push(e);
	return out;
}

/** All events of a given kind. */
export function queryByKind(ledger: EvidenceLedger, kind: EvidenceEventKind): EvidenceEvent[] {
	return queryEvents(ledger, (e) => e.kind === kind);
}

/** All events of a given status. */
export function queryByStatus(ledger: EvidenceLedger, status: EvidenceStatus): EvidenceEvent[] {
	return queryEvents(ledger, (e) => e.status === status);
}

/** All events recorded against a given run id. */
export function queryByRun(ledger: EvidenceLedger, runId: string): EvidenceEvent[] {
	const trimmed = trimString(runId);
	if (!trimmed) return [];
	return queryEvents(ledger, (e) => e.runId === trimmed);
}

/** Most recent event of a given kind for the current run, ignoring
 *  superseded/rejected events. Used by higher-level "current" queries that
 *  need the latest authoritative evidence for a run.
 *
 *  The query is current-run scoped: events whose `runId` does not match
 *  `ledger.runId` are excluded. */
export function findCurrentEvent(ledger: EvidenceLedger, kind: EvidenceEventKind): EvidenceEvent | undefined {
	let best: EvidenceEvent | undefined;
	for (const e of ledger.events) {
		if (e.kind !== kind) continue;
		if (e.runId !== ledger.runId) continue;
		if (e.status === "superseded" || e.status === "rejected") continue;
		if (!best || best.recordedAt < e.recordedAt) best = e;
	}
	return best;
}

/** All non-superseded / non-rejected events of a given kind for the current
 *  run, ordered by recordedAt ascending.
 *
 *  The query is current-run scoped: events whose `runId` does not match
 *  `ledger.runId` are excluded. */
export function findCurrentEvents(ledger: EvidenceLedger, kind: EvidenceEventKind): EvidenceEvent[] {
	const out: EvidenceEvent[] = [];
	for (const e of ledger.events) {
		if (e.kind !== kind) continue;
		if (e.runId !== ledger.runId) continue;
		if (e.status === "superseded" || e.status === "rejected") continue;
		out.push(e);
	}
	out.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
	return out;
}

/** Convenience: all currently-accepted current-run events of a given kind.
 *
 *  In addition to the current-run + non-superseded/non-rejected filters
 *  applied by `findCurrentEvents`, this query defensively excludes free-form
 *  `legacy_import` events even if they somehow end up with `status ===
 *  "accepted"` (the `markEventStatus` guard already rejects that transition,
 *  but the predicate provides a second line of defense for queries that
 *  consume externally-imported ledgers). */
export function findAcceptedCurrentRun(ledger: EvidenceLedger, kind: EvidenceEventKind): EvidenceEvent[] {
	return findCurrentEvents(ledger, kind).filter((e) => e.status === "accepted" && !isFreeFormLegacyImport(e));
}

/** Most recently recorded accepted event of a given kind for the current run. */
export function findLatestAccepted(ledger: EvidenceLedger, kind: EvidenceEventKind): EvidenceEvent | undefined {
	let best: EvidenceEvent | undefined;
	for (const e of findAcceptedCurrentRun(ledger, kind)) {
		if (!best || best.recordedAt < e.recordedAt) best = e;
	}
	return best;
}

// ---------- Blocker / warning aggregation ----------

/** A flattened, structured blocker record suitable for downstream gates. */
export interface LedgerBlocker {
	eventId: string;
	runId: string;
	kind: EvidenceEventKind;
	severity: "block";
	code: string;
	message: string;
}

/** Collect every event whose kind is a known blocker kind, ignoring
 *  superseded/rejected events. Quality-audit blockers are flattened into
 *  structured LedgerBlocker rows. */
export function collectBlockers(ledger: EvidenceLedger): LedgerBlocker[] {
	const out: LedgerBlocker[] = [];
	for (const e of findCurrentEvents(ledger, "quality_audit_blocker")) {
		const blocker: LedgerBlocker = {
			eventId: e.eventId,
			runId: e.runId,
			kind: "quality_audit_blocker",
			severity: "block",
			code: e.payload.code,
			message: e.payload.message,
		};
		out.push(blocker);
	}
	return out;
}

/** Collect all current-run events whose status is rejected or whose payload
 *  contains blocking reasons. Used by finalization / AFK gates to surface
 *  hard blockers consistently. */
export function collectHardBlockers(ledger: EvidenceLedger): EvidenceEvent[] {
	return findCurrentEvents(ledger, "reviewer_evidence").filter((e) => {
		if (e.kind !== "reviewer_evidence") return false;
		return e.payload.blockingReasons.length > 0 || e.payload.effectiveVerdict === "CHANGES_REQUESTED";
	});
}

/** Collect all warnings from current-run events (excluding superseded). */
export function collectWarnings(ledger: EvidenceLedger): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const e of ledger.events) {
		if (e.status === "superseded" || e.status === "rejected") continue;
		for (const w of e.warnings) {
			if (!w || seen.has(w)) continue;
			seen.add(w);
			out.push(w);
		}
	}
	return out;
}

// ---------- Pickup for callers that need a typed base ----------

/** Read the most recent event of a given kind with a status filter. Returns
 *  undefined when no event matches. */
export function findEventWithStatus(
	ledger: EvidenceLedger,
	kind: EvidenceEventKind,
	status: EvidenceStatus,
): EvidenceEvent | undefined {
	let best: EvidenceEvent | undefined;
	for (const e of ledger.events) {
		if (e.kind !== kind || e.status !== status) continue;
		if (!best || best.recordedAt < e.recordedAt) best = e;
	}
	return best;
}

/** Return a defensive shallow snapshot. */
export function snapshotLedger(ledger: EvidenceLedger): EvidenceLedger {
	return {
		ledgerId: ledger.ledgerId,
		runId: ledger.runId,
		createdAt: ledger.createdAt,
		updatedAt: ledger.updatedAt,
		events: ledger.events.slice(),
	};
}

export function snapshotRun(run: DeliveryRun): DeliveryRun {
	return {
		runId: run.runId,
		...(run.taskId ? { taskId: run.taskId } : {}),
		...(run.planId ? { planId: run.planId } : {}),
		...(run.currentPhaseId ? { currentPhaseId: run.currentPhaseId } : {}),
		...(run.currentLaneId ? { currentLaneId: run.currentLaneId } : {}),
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		ledger: snapshotLedger(run.ledger),
	};
}
