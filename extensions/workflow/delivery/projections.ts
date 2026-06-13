// TASK-001 Phase A — pure projection helpers for memo / report rows.
// Render concise, structured rows from `EvidenceEvent`s. Projections are
// diagnostic only: every row carries the eventId, status, provenance,
// warnings, and the ids of linked decision events, so operators do not need
// to read free-form text to trace provenance.

import type {
	AfkReferenceEvent,
	CoderEvidenceEvent,
	EvidenceEvent,
	EvidenceEventKind,
	EvidenceLedger,
	EvidenceProvenance,
	EvidenceStatus,
	FinalizationDecisionEvent,
	GateDecisionEvent,
	LegacyImportEvent,
	QualityAuditBlockerEvent,
	ReviewerEvidenceEvent,
} from "./types";

// ---------- Projection row types ----------

/** Memo-friendly one-line-per-event row. Carries provenance + warnings +
 *  linked decision ids so the memo reader can trace the chain. */
export interface MemoRow {
	eventId: string;
	runId: string;
	kind: EvidenceEventKind;
	status: EvidenceStatus;
	provenance: EvidenceProvenance;
	recordedAt: string;
	source?: string;
	summary: string;
	detail?: string;
	warnings: string[];
	decisionLinks: string[];
	taskId?: string;
	planId?: string;
	phaseId?: string;
	laneId?: string;
}

/** Report-friendly row, slightly more verbose and includes evidence refs
 *  (e.g. quality-audit evidence refs, AFK referenced events). */
export interface ReportRow extends MemoRow {
	evidenceIds: string[];
}

// ---------- Top-level projection helpers ----------

export interface ProjectionFilter {
	kind?: EvidenceEventKind;
	runId?: string;
	/** When true (default), superseded and rejected events are omitted. */
	currentOnly?: boolean;
}

function passesFilter(event: EvidenceEvent, filter: ProjectionFilter | undefined): boolean {
	if (!filter) return true;
	if (filter.kind && event.kind !== filter.kind) return false;
	if (filter.runId && event.runId !== filter.runId) return false;
	if (filter.currentOnly !== false && (event.status === "superseded" || event.status === "rejected")) return false;
	return true;
}

function compareRecordedAt(a: { recordedAt: string }, b: { recordedAt: string }): number {
	return a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0;
}

/** Render every event that matches the filter as a memo row, sorted by
 *  recordedAt ascending. */
export function toMemoRows(ledger: EvidenceLedger, filter?: ProjectionFilter): MemoRow[] {
	return ledger.events
		.filter((e) => passesFilter(e, filter))
		.slice()
		.sort(compareRecordedAt)
		.map(toMemoRow);
}

/** Render every event that matches the filter as a report row. Report rows
 *  include evidence ids in addition to memo row fields. */
export function toReportRows(ledger: EvidenceLedger, filter?: ProjectionFilter): ReportRow[] {
	return toMemoRows(ledger, filter).map((row) => {
		const event = ledger.events.find((e) => e.eventId === row.eventId);
		const evidenceIds = event ? collectEvidenceIds(event) : [];
		return { ...row, evidenceIds };
	});
}

/** Render a single event as a memo row. */
export function toMemoRow(event: EvidenceEvent): MemoRow {
	const row: MemoRow = {
		eventId: event.eventId,
		runId: event.runId,
		kind: event.kind,
		status: event.status,
		provenance: event.provenance,
		recordedAt: event.recordedAt,
		warnings: event.warnings.slice(),
		decisionLinks: collectDecisionLinks(event),
		summary: renderSummary(event),
	};
	if (event.source !== undefined) row.source = event.source;
	if (event.context.taskId !== undefined) row.taskId = event.context.taskId;
	if (event.context.planId !== undefined) row.planId = event.context.planId;
	if (event.context.phaseId !== undefined) row.phaseId = event.context.phaseId;
	if (event.context.laneId !== undefined) row.laneId = event.context.laneId;
	const detail = renderDetail(event);
	if (detail) row.detail = detail;
	return row;
}

/** Render a single event as a report row. */
export function toReportRow(event: EvidenceEvent): ReportRow {
	const memo = toMemoRow(event);
	return { ...memo, evidenceIds: collectEvidenceIds(event) };
}

// ---------- Per-kind renderers ----------

function renderSummary(event: EvidenceEvent): string {
	switch (event.kind) {
		case "coder_evidence": return renderCoderSummary(event);
		case "reviewer_evidence": return renderReviewerSummary(event);
		case "gate_decision": return renderGateSummary(event);
		case "finalization_decision": return renderFinalizationSummary(event);
		case "quality_audit_blocker": return renderQualityAuditSummary(event);
		case "afk_reference": return renderAfkSummary(event);
		case "legacy_import": return renderLegacySummary(event);
	}
}

function renderDetail(event: EvidenceEvent): string | undefined {
	switch (event.kind) {
		case "coder_evidence": return renderCoderDetail(event);
		case "reviewer_evidence": return renderReviewerDetail(event);
		case "gate_decision": return renderGateDetail(event);
		case "finalization_decision": return renderFinalizationDetail(event);
		case "quality_audit_blocker": return renderQualityAuditDetail(event);
		case "afk_reference": return renderAfkDetail(event);
		case "legacy_import": return renderLegacyDetail(event);
	}
}

function renderCoderSummary(event: CoderEvidenceEvent): string {
	const files = event.payload.filesChanged.length;
	const commands = event.payload.commandsRun.length;
	const coverage = event.payload.criterionCoverage.length;
	return `coder_evidence: ${coverage} criterion(s), ${commands} command(s), ${files} file(s) changed`;
}

function renderCoderDetail(event: CoderEvidenceEvent): string | undefined {
	const passed = event.payload.commandsRun.filter((c) => c.outcome === "passed").length;
	const failed = event.payload.commandsRun.filter((c) => c.outcome === "failed").length;
	const skipped = event.payload.commandsRun.filter((c) => c.outcome === "skipped").length;
	const parts: string[] = [];
	if (event.payload.commandsRun.length > 0) parts.push(`commands: ${passed} passed, ${failed} failed, ${skipped} skipped`);
	if (event.payload.criterionCoverage.length > 0) {
		const criteria = event.payload.criterionCoverage.map((c) => `${c.criterion}=${c.strength}`).join(", ");
		parts.push(`criteria: ${criteria}`);
	}
	if (event.payload.summary) parts.push(`summary: ${event.payload.summary}`);
	return parts.length > 0 ? parts.join(" | ") : undefined;
}

function renderReviewerSummary(event: ReviewerEvidenceEvent): string {
	return `reviewer_evidence: role=${event.payload.role}, verdict=${event.payload.verdict}, effective=${event.payload.effectiveVerdict}`;
}

function renderReviewerDetail(event: ReviewerEvidenceEvent): string | undefined {
	const parts: string[] = [];
	if (event.payload.blockingReasons.length > 0) parts.push(`blocking: ${event.payload.blockingReasons.join("; ")}`);
	if (event.payload.weakEvidence.length > 0) parts.push(`weak: ${event.payload.weakEvidence.join("; ")}`);
	if (event.payload.promptOnlyCaveats.length > 0) parts.push(`prompt-only: ${event.payload.promptOnlyCaveats.join("; ")}`);
	if (event.payload.unresolvedRisks.length > 0) parts.push(`unresolved: ${event.payload.unresolvedRisks.join("; ")}`);
	return parts.length > 0 ? parts.join(" | ") : undefined;
}

function renderGateSummary(event: GateDecisionEvent): string {
	return `gate_decision: ${event.payload.gateId} -> ${event.payload.outcome}`;
}

function renderGateDetail(event: GateDecisionEvent): string | undefined {
	const parts: string[] = [];
	if (event.payload.reason) parts.push(`reason: ${event.payload.reason}`);
	if (event.payload.rejectionCodes.length > 0) parts.push(`codes: ${event.payload.rejectionCodes.join(", ")}`);
	return parts.length > 0 ? parts.join(" | ") : undefined;
}

function renderFinalizationSummary(event: FinalizationDecisionEvent): string {
	return `finalization_decision: requested=${event.payload.requestedStatus}, recommended=${event.payload.recommendedStatus}, allowed=${event.payload.allowed ? "yes" : "no"}`;
}

function renderFinalizationDetail(event: FinalizationDecisionEvent): string | undefined {
	const parts: string[] = [];
	if (event.payload.blockers.length > 0) parts.push(`blockers: ${event.payload.blockers.join("; ")}`);
	if (event.payload.warnings.length > 0) parts.push(`warnings: ${event.payload.warnings.join("; ")}`);
	return parts.length > 0 ? parts.join(" | ") : undefined;
}

function renderQualityAuditSummary(event: QualityAuditBlockerEvent): string {
	return `quality_audit_blocker: ${event.payload.severity} ${event.payload.code} - ${truncate(event.payload.message, 80)}`;
}

function renderQualityAuditDetail(event: QualityAuditBlockerEvent): string | undefined {
	if (event.payload.evidenceRefs.length === 0) return undefined;
	return `evidence: ${event.payload.evidenceRefs.join(", ")}`;
}

function renderAfkSummary(event: AfkReferenceEvent): string {
	const refs = event.payload.referencedEventIds.length;
	return `afk_reference: lane=${event.payload.laneId}, ${refs} referenced event(s) - ${truncate(event.payload.summary, 60)}`;
}

function renderAfkDetail(event: AfkReferenceEvent): string | undefined {
	return event.payload.escalation ? `escalation: ${event.payload.escalation}` : undefined;
}

function renderLegacySummary(event: LegacyImportEvent): string {
	return `legacy_import: from=${event.payload.importedFrom}, structured=${event.payload.hasStructuredContent ? "yes" : "no"}`;
}

function renderLegacyDetail(event: LegacyImportEvent): string | undefined {
	const parts: string[] = [];
	parts.push(`source: ${event.payload.originalSource}`);
	if (event.payload.rawSummary) parts.push(`raw: ${truncate(event.payload.rawSummary, 200)}`);
	return parts.join(" | ");
}

// ---------- Linkage helpers ----------

function collectDecisionLinks(event: EvidenceEvent): string[] {
	// Heuristics: a legacy_import event that is followed by a typed
	// `coder_evidence` / `reviewer_evidence` event for the same run is the
	// canonical "paired" import. We can't see the other events here (we
	// only get the single event), so the default is an empty list. The
	// ledger-level helpers below fill this in for batch projections.
	void event;
	return [];
}

/** Build the decision links for a memo row using the full ledger: a legacy
 *  import is linked to the next typed event for the same run, and any
 *  event is linked to the most recent gate_decision / finalization_decision
 *  for the same run. */
export function buildDecisionLinks(ledger: EvidenceLedger, event: EvidenceEvent): string[] {
	const links: string[] = [];
	for (const other of ledger.events) {
		if (other.eventId === event.eventId) continue;
		if (other.runId !== event.runId) continue;
		if (other.status === "superseded") continue;
		if (other.kind === "gate_decision" || other.kind === "finalization_decision") {
			links.push(other.eventId);
		}
	}
	if (event.kind === "legacy_import") {
		for (const other of ledger.events) {
			if (other.eventId === event.eventId) continue;
			if (other.runId !== event.runId) continue;
			if (other.status === "superseded") continue;
			if ((other.kind === "coder_evidence" || other.kind === "reviewer_evidence")
				&& other.provenance === "legacy") {
				links.push(other.eventId);
			}
		}
	}
	return uniqueOrdered(links);
}

function collectEvidenceIds(event: EvidenceEvent): string[] {
	if (event.kind === "afk_reference") return event.payload.referencedEventIds.slice();
	if (event.kind === "quality_audit_blocker") return event.payload.evidenceRefs.slice();
	return [];
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

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------- Memo / report helpers that DO see the ledger ----------

/** Same as `toMemoRows` but enriches each row with `decisionLinks` by
 *  scanning the ledger. Prefer this for human-facing memos. */
export function toMemoRowsWithLinks(ledger: EvidenceLedger, filter?: ProjectionFilter): MemoRow[] {
	return toMemoRows(ledger, filter).map((row) => {
		const event = ledger.events.find((e) => e.eventId === row.eventId);
		if (!event) return row;
		return { ...row, decisionLinks: buildDecisionLinks(ledger, event) };
	});
}

/** Same as `toReportRows` but enriches each row with `decisionLinks` by
 *  scanning the ledger. Prefer this for human-facing reports. */
export function toReportRowsWithLinks(ledger: EvidenceLedger, filter?: ProjectionFilter): ReportRow[] {
	return toReportRows(ledger, filter).map((row) => {
		const event = ledger.events.find((e) => e.eventId === row.eventId);
		if (!event) return row;
		return { ...row, decisionLinks: buildDecisionLinks(ledger, event) };
	});
}

/** Render a Markdown-friendly memo from a ledger. The memo is diagnostic
 *  only — it never replaces structured ledger data. Every row carries
 *  `eventId`, `kind`, `status`, `provenance`, `warnings`, `decisionLinks`,
 *  and `evidenceIds` columns populated from the underlying structured
 *  ledger events (via `toReportRowsWithLinks`). Operators do not need to
 *  read free-form text to trace provenance: linked gate/finalization
 *  decision IDs, referenced evidence IDs, and warning codes are all
 *  rendered as structured Markdown table cells. */
export function renderLedgerMarkdown(ledger: EvidenceLedger, filter?: ProjectionFilter): string {
	const rows = toReportRowsWithLinks(ledger, filter);
	const lines: string[] = [];
	lines.push(`# Delivery ledger ${ledger.ledgerId} (run ${ledger.runId})`);
	lines.push("");
	lines.push(`- events: ${rows.length}`);
	lines.push(`- generated: ${ledger.updatedAt}`);
	lines.push("");
	if (rows.length === 0) {
		lines.push("_(no events)_");
		return lines.join("\n");
	}
	lines.push("| eventId | kind | status | provenance | recordedAt | summary | warnings | decisionLinks | evidenceIds |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const row of rows) {
		const warningsCell = row.warnings.length > 0 ? escapeTable(row.warnings.join("; ")) : "";
		const decisionLinksCell = row.decisionLinks.length > 0 ? escapeTable(row.decisionLinks.join(", ")) : "";
		const evidenceIdsCell = row.evidenceIds.length > 0 ? escapeTable(row.evidenceIds.join(", ")) : "";
		lines.push(`| ${row.eventId} | ${row.kind} | ${row.status} | ${row.provenance} | ${row.recordedAt} | ${escapeTable(row.summary)} | ${warningsCell} | ${decisionLinksCell} | ${evidenceIdsCell} |`);
	}
	return lines.join("\n");
}

function escapeTable(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
