// TASK-001 Phase A — canonical DeliveryRun / EvidenceLedger type surface.
// Foundation only. No runtime wiring, no disk IO, no Pi runtime imports.
// The shape must remain stable so TASK-002..004 can plug real transports in
// without changing these names.

/** Closed set of evidence event kinds. The union is exhaustive so the
 *  ledger helpers can switch on `event.kind` and the TypeScript compiler
 *  will surface any new kind that is added without a handler. */
export type EvidenceEventKind =
	| "coder_evidence"
	| "reviewer_evidence"
	| "gate_decision"
	| "finalization_decision"
	| "quality_audit_blocker"
	| "afk_reference"
	| "legacy_import";

/** Closed set of evidence event kinds as a readonly tuple. Useful for
 *  membership checks in normalizers / validators that work in plain JS
 *  contexts. */
export const EVIDENCE_EVENT_KINDS: readonly EvidenceEventKind[] = [
	"coder_evidence",
	"reviewer_evidence",
	"gate_decision",
	"finalization_decision",
	"quality_audit_blocker",
	"afk_reference",
	"legacy_import",
] as const;

/** Provenance of an evidence event — who/what produced it.
 *  - canonical: produced by current structured workflows (TASK-002..004).
 *  - legacy: imported from a pre-canonical artifact (done sidecar, summary,
 *    coderEvidence, reviewerEvidence, delegate-history, free-form text).
 *  - projection: derived from other events by `projections.ts`.
 *  - manual: hand-authored or operator override. */
export type EvidenceProvenance = "canonical" | "legacy" | "projection" | "manual";

export const EVIDENCE_PROVENANCES: readonly EvidenceProvenance[] = [
	"canonical",
	"legacy",
	"projection",
	"manual",
] as const;

/** Lifecycle status of a single evidence event.
 *  - recorded: present in the ledger but not yet evaluated.
 *  - accepted: validated as authoritative for its kind.
 *  - rejected: validated as NOT authoritative; carries a warning/reason.
 *  - superseded: replaced by a newer event of the same kind+run. */
export type EvidenceStatus = "recorded" | "accepted" | "rejected" | "superseded";

export const EVIDENCE_STATUSES: readonly EvidenceStatus[] = [
	"recorded",
	"accepted",
	"rejected",
	"superseded",
] as const;

/** Run/task/phase/lane context. Always present on every event so the ledger
 *  can be sliced by any dimension without re-derivation. */
export interface DeliveryRunContext {
	runId: string;
	taskId?: string;
	planId?: string;
	phaseId?: string;
	laneId?: string;
}

/** Common fields on every evidence event. Per-kind event types extend this
 *  with a kind-specific payload. */
export interface EvidenceEventBase {
	/** Stable, ledger-unique event id. Once written, never changes. */
	eventId: string;
	runId: string;
	kind: EvidenceEventKind;
	provenance: EvidenceProvenance;
	status: EvidenceStatus;
	/** ISO-8601 timestamp the event was recorded in the ledger. */
	recordedAt: string;
	context: DeliveryRunContext;
	/** Human-readable warnings produced at create / validate / status time. */
	warnings: string[];
	/** Optional short label of the producer (e.g. "coder#1", "reviewer/behavior#1",
	 *  "done-sidecar:sample-001"). Diagnostic only; never authoritative. */
	source?: string;
	/** When status === "superseded", the eventId of the replacing event. */
	supersededBy?: string;
	/** When this event supersedes an earlier one, the eventId of the older
	 *  event. Optional; absent for first-of-kind events. */
	supersedes?: string;
}

// ---------- Per-kind payload shapes ----------

export interface CoderEvidenceCommand {
	command: string;
	outcome: "passed" | "failed" | "skipped";
	summary?: string;
	exitCode?: number;
}

export interface CoderEvidenceCriterion {
	criterion: string;
	evidenceKind: string;
	strength: string;
	summary: string;
}

export interface CoderEvidencePayload {
	filesChanged: string[];
	commandsRun: CoderEvidenceCommand[];
	criterionCoverage: CoderEvidenceCriterion[];
	summary?: string;
}

export interface CoderEvidenceEvent extends EvidenceEventBase {
	kind: "coder_evidence";
	payload: CoderEvidencePayload;
}

export interface ReviewerEvidencePayload {
	role: string;
	verdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";
	effectiveVerdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";
	blockingReasons: string[];
	weakEvidence: string[];
	promptOnlyCaveats: string[];
	unresolvedRisks: string[];
	finalOutput?: string;
}

export interface ReviewerEvidenceEvent extends EvidenceEventBase {
	kind: "reviewer_evidence";
	payload: ReviewerEvidencePayload;
}

export interface GateDecisionPayload {
	gateId: string;
	outcome: "advance" | "block";
	reason?: string;
	rejectionCodes: string[];
}

export interface GateDecisionEvent extends EvidenceEventBase {
	kind: "gate_decision";
	payload: GateDecisionPayload;
}

export type FinalizationRecommendedStatus =
	| "done"
	| "provisional_done"
	| "prompt_only_mitigation";

export interface FinalizationDecisionPayload {
	requestedStatus: string;
	recommendedStatus: FinalizationRecommendedStatus;
	blockers: string[];
	warnings: string[];
	allowed: boolean;
}

export interface FinalizationDecisionEvent extends EvidenceEventBase {
	kind: "finalization_decision";
	payload: FinalizationDecisionPayload;
}

export type QualityAuditSeverity =
	| "critical" | "high" | "medium" | "low" | "warning" | "info";

export interface QualityAuditBlockerPayload {
	severity: QualityAuditSeverity;
	code: string;
	message: string;
	evidenceRefs: string[];
}

export interface QualityAuditBlockerEvent extends EvidenceEventBase {
	kind: "quality_audit_blocker";
	payload: QualityAuditBlockerPayload;
}

export interface AfkReferencePayload {
	laneId: string;
	/** Event ids the AFK ship/lane flow recorded or consumed. */
	referencedEventIds: string[];
	summary: string;
	escalation?: string;
}

export interface AfkReferenceEvent extends EvidenceEventBase {
	kind: "afk_reference";
	payload: AfkReferencePayload;
}

export type LegacyImportSourceKind =
	| "coderEvidence"
	| "reviewerEvidence"
	| "summary"
	| "delegateHistory"
	| "doneSidecar"
	| "freeFormOnly";

export interface LegacyImportPayload {
	/** Stable kind identifier for the imported artifact. */
	importedFrom: LegacyImportSourceKind;
	/** Human-readable origin label, e.g. "done-sidecar:./tmp/done.json". */
	originalSource: string;
	/** Optional non-authoritative free-form text. Never authoritative by
	 *  itself; the legacy adapter treats a free-form-only payload as a
	 *  recorded (not accepted) event with explicit warnings. */
	rawSummary?: string;
	/** Whether the imported payload carried any structured (non-free-form)
	 *  content. When false, the event must never be marked accepted. */
	hasStructuredContent: boolean;
}

export interface LegacyImportEvent extends EvidenceEventBase {
	kind: "legacy_import";
	payload: LegacyImportPayload;
}

/** Discriminated union of every evidence event kind. */
export type EvidenceEvent =
	| CoderEvidenceEvent
	| ReviewerEvidenceEvent
	| GateDecisionEvent
	| FinalizationDecisionEvent
	| QualityAuditBlockerEvent
	| AfkReferenceEvent
	| LegacyImportEvent;

// ---------- Containers ----------

export interface EvidenceLedger {
	ledgerId: string;
	runId: string;
	createdAt: string;
	updatedAt: string;
	events: EvidenceEvent[];
}

export interface DeliveryRun {
	runId: string;
	taskId?: string;
	planId?: string;
	currentPhaseId?: string;
	currentLaneId?: string;
	createdAt: string;
	updatedAt: string;
	ledger: EvidenceLedger;
}

// ---------- Warning codes (legacy adapter / future validators) ----------

/** Stable reason codes produced by `legacy-import.ts`. These are diagnostic;
 *  they are never used to mark a free-form-only event accepted. */
export type LegacyImportWarningCode =
	| "free_form_only"
	| "deprecated_coder_evidence"
	| "deprecated_reviewer_evidence"
	| "deprecated_summary_json"
	| "deprecated_delegate_history"
	| "auto_exit_observed"
	| "process_exit_observed"
	| "missing_sidecar_observed"
	| "no_structured_content"
	| "unreadable_input";

export interface LegacyImportWarning {
	code: LegacyImportWarningCode;
	message: string;
}
