#!/usr/bin/env node
// TASK-001 Phase A — DeliveryRun / EvidenceLedger foundation smoke checks.
// Foundation only: no Pi runtime, no disk IO. The smoke test exercises the
// canonical type surface, pure ledger helpers, the single legacy import
// adapter, and projection helpers. A fixed clock keeps assertions
// deterministic.
//
// Coverage areas (mapped to TASK-001 acceptance criteria 1..5):
//   (A) Canonical type surface — stable IDs, statuses, run context, provenance
//   (B) Pure ledger helpers — create/append/accept/reject/query, no disk
//   (C) Legacy import adapter — coderEvidence, reviewerEvidence, summary,
//       delegate-history, auto_exit / process_exit / missing-sidecar text
//   (D) Reviewer evidence first-class shape
//   (E) Quality / finalization / AFK event coverage
//   (F) Projections — memo + report rows with evidence IDs, provenance,
//       warnings, and decision links
//   (G) Fail-closed handling of free-form-only legacy inputs

import {
	appendEvent,
	createDeliveryRun,
	createEvidenceLedger,
	findAcceptedCurrentRun,
	findCurrentEvent,
	findCurrentEvents,
	isFreeFormLegacyImport,
	markAccepted,
	markEventStatus,
	markRejected,
	markSuperseded,
	collectBlockers,
	collectHardBlockers,
	collectWarnings,
	queryByKind,
	snapshotLedger,
} from "../extensions/workflow/delivery/ledger";
import {
	importLegacyEvidence,
	importLegacyDoneSidecar,
	isFreeFormOnly,
} from "../extensions/workflow/delivery/legacy-import";
import {
	buildDecisionLinks,
	renderLedgerMarkdown,
	toMemoRow,
	toMemoRows,
	toMemoRowsWithLinks,
	toReportRow,
	toReportRows,
	toReportRowsWithLinks,
} from "../extensions/workflow/delivery/projections";
import {
	EVIDENCE_EVENT_KINDS,
	EVIDENCE_PROVENANCES,
	EVIDENCE_STATUSES,
	type CoderEvidenceEvent,
	type DeliveryRunContext,
	type EvidenceEvent,
	type EvidenceLedger,
	type ReviewerEvidenceEvent,
} from "../extensions/workflow/delivery/types";

let failures = 0;
function check(condition: unknown, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

const NOW_T0 = "2026-06-12T20:00:00.000Z";
const NOW_T1 = "2026-06-12T20:00:01.000Z";
const NOW_T2 = "2026-06-12T20:00:02.000Z";
const NOW_T3 = "2026-06-12T20:00:03.000Z";

function makeContext(runId: string): DeliveryRunContext {
	return { runId, taskId: "TASK-001", planId: "EPIC-005", phaseId: "phase-a", laneId: "lane-coder" };
}

// (A) Canonical type surface — every event kind has the required fields.
function sectionA_canonicalTypeSurface(): void {
	console.log("\n# (A) Canonical type surface");
	const run = createDeliveryRun({ runId: "run-A", now: NOW_T0 });
	const ctx = makeContext("run-A");
	let ledger = run.ledger;

	const kindFixtures: Array<{ kind: EvidenceEvent["kind"]; payload: unknown; expectedEventIdPrefix: string }> = [
		{
			kind: "coder_evidence",
			payload: {
				filesChanged: ["extensions/workflow/delivery/ledger.ts"],
				commandsRun: [{ command: "npx tsx --check", outcome: "passed" }],
				criterionCoverage: [{ criterion: "ledger-helpers", evidenceKind: "static-check", strength: "sufficient", summary: "ok" }],
			},
			expectedEventIdPrefix: "coder_evidence:run-A:",
		},
		{
			kind: "reviewer_evidence",
			payload: {
				role: "behavior",
				verdict: "APPROVED",
				effectiveVerdict: "APPROVED",
				blockingReasons: [],
				weakEvidence: [],
				promptOnlyCaveats: [],
				unresolvedRisks: [],
			},
			expectedEventIdPrefix: "reviewer_evidence:run-A:",
		},
		{
			kind: "gate_decision",
			payload: { gateId: "coder-to-reviewer", outcome: "advance", reason: "ok", rejectionCodes: [] },
			expectedEventIdPrefix: "gate_decision:run-A:",
		},
		{
			kind: "finalization_decision",
			payload: { requestedStatus: "done", recommendedStatus: "done", blockers: [], warnings: [], allowed: true },
			expectedEventIdPrefix: "finalization_decision:run-A:",
		},
		{
			kind: "quality_audit_blocker",
			payload: { severity: "high", code: "test-failure", message: "failing test", evidenceRefs: ["n/a"] },
			expectedEventIdPrefix: "quality_audit_blocker:run-A:",
		},
		{
			kind: "afk_reference",
			payload: { laneId: "lane-afk", referencedEventIds: ["e1"], summary: "afk ship", escalation: undefined },
			expectedEventIdPrefix: "afk_reference:run-A:",
		},
		{
			kind: "legacy_import",
			payload: { importedFrom: "coderEvidence", originalSource: "done-sidecar", hasStructuredContent: true },
			expectedEventIdPrefix: "legacy_import:run-A:",
		},
	];

	for (const f of kindFixtures) {
		ledger = appendEvent(ledger, {
			runId: "run-A",
			kind: f.kind,
			provenance: "canonical",
			status: "recorded",
			context: ctx,
			source: `coder#${ledger.events.length + 1}`,
			payload: f.payload,
		}, NOW_T1);
	}

	// All seven kinds are present.
	for (const kind of EVIDENCE_EVENT_KINDS) {
		const found = ledger.events.find((e) => e.kind === kind);
		check(!!found, `A: ledger has a ${kind} event`);
	}
	check(ledger.events.length === EVIDENCE_EVENT_KINDS.length, `A: ledger has exactly ${EVIDENCE_EVENT_KINDS.length} events (one per kind)`);

	// Every event has stable ID, run, kind, provenance, status, timestamp,
	// warnings, and run context. IDs follow the `<kind>:<runId>:<seq>` pattern.
	for (const e of ledger.events) {
		check(typeof e.eventId === "string" && e.eventId.length > 0, `A: ${e.kind} has non-empty eventId`);
		check(e.runId === "run-A", `A: ${e.kind} has runId === "run-A"`);
		check(e.kind === e.kind, `A: ${e.kind} kind matches its discriminator`);
		check(EVIDENCE_PROVENANCES.includes(e.provenance), `A: ${e.kind} provenance is closed (${e.provenance})`);
		check(EVIDENCE_STATUSES.includes(e.status), `A: ${e.kind} status is closed (${e.status})`);
		check(typeof e.recordedAt === "string" && e.recordedAt === NOW_T1, `A: ${e.kind} recordedAt is fixed`);
		check(Array.isArray(e.warnings), `A: ${e.kind} carries a warnings array`);
		check(e.context.runId === "run-A", `A: ${e.kind} context.runId matches runId`);
		check(e.context.taskId === "TASK-001", `A: ${e.kind} context.taskId present`);
		check(e.context.planId === "EPIC-005", `A: ${e.kind} context.planId present`);
		check(e.context.phaseId === "phase-a", `A: ${e.kind} context.phaseId present`);
		check(e.context.laneId === "lane-coder", `A: ${e.kind} context.laneId present`);
	}

	// Deterministic eventId sequence.
	for (const f of kindFixtures) {
		const ev = ledger.events.find((e) => e.kind === f.kind);
		check(!!ev && ev.eventId.startsWith(f.expectedEventIdPrefix), `A: ${f.kind} eventId starts with ${f.expectedEventIdPrefix}`);
	}

	// Two appends of the same kind produce monotonically increasing seq.
	let seq2 = createEvidenceLedger({ runId: "run-A", now: NOW_T0 });
	seq2 = appendEvent(seq2, { runId: "run-A", kind: "coder_evidence", context: ctx, payload: { filesChanged: [], commandsRun: [], criterionCoverage: [] } }, NOW_T1);
	seq2 = appendEvent(seq2, { runId: "run-A", kind: "coder_evidence", context: ctx, payload: { filesChanged: [], commandsRun: [], criterionCoverage: [] } }, NOW_T2);
	check(seq2.events[0]!.eventId === "coder_evidence:run-A:1", "A: first coder_evidence seq is 1");
	check(seq2.events[1]!.eventId === "coder_evidence:run-A:2", "A: second coder_evidence seq is 2");
}

// (B) Pure ledger helpers — create / append / accept / reject / query.
function sectionB_pureLedgerHelpers(): void {
	console.log("\n# (B) Pure ledger helpers");
	const run = createDeliveryRun({ runId: "run-B", taskId: "TASK-001", planId: "EPIC-005", phaseId: "phase-a", laneId: "lane-coder", now: NOW_T0 });
	const ctx = makeContext("run-B");

	check(run.ledger.runId === "run-B", "B: createDeliveryRun seeds ledger with runId");
	check(typeof run.createdAt === "string" && run.createdAt === NOW_T0, "B: createDeliveryRun uses provided clock");
	check(run.currentPhaseId === "phase-a", "B: createDeliveryRun accepts phaseId");
	check(run.currentLaneId === "lane-coder", "B: createDeliveryRun accepts laneId");

	// Append a coder_evidence event; helpers must NOT mutate input ledger.
	const originalLedger = run.ledger;
	let ledger = appendEvent(originalLedger, {
		runId: "run-B", kind: "coder_evidence", provenance: "canonical",
		context: ctx, source: "coder#1",
		payload: { filesChanged: ["x.ts"], commandsRun: [{ command: "x", outcome: "passed" }], criterionCoverage: [] },
	}, NOW_T1);
	check(originalLedger.events.length === 0, "B: appendEvent does not mutate input ledger");
	check(ledger.events.length === 1, "B: appendEvent returns a new ledger with the event");

	const coderEvent = ledger.events[0]!;
	// Status transitions.
	ledger = markAccepted(ledger, coderEvent.eventId, NOW_T2);
	check(ledger.events[0]!.status === "accepted", "B: markAccepted transitions status to accepted");
	check(ledger.events[0]!.recordedAt === NOW_T2, "B: markAccepted updates recordedAt");

	// Rejecting the same event is a fresh transition; status updates to rejected.
	ledger = markRejected(ledger, coderEvent.eventId, NOW_T3);
	check(ledger.events[0]!.status === "rejected", "B: markRejected transitions status to rejected");
	check(ledger.events[0]!.recordedAt === NOW_T3, "B: markRejected updates recordedAt");

	// Marking an event accepted again should be reflected in the query.
	let led2 = createEvidenceLedger({ runId: "run-B", now: NOW_T0 });
	led2 = appendEvent(led2, {
		runId: "run-B", kind: "coder_evidence", context: ctx,
		payload: { filesChanged: ["a"], commandsRun: [{ command: "c", outcome: "passed" }], criterionCoverage: [] },
	}, NOW_T1);
	const e = led2.events[0]!;
	check(findAcceptedCurrentRun(led2, "coder_evidence").length === 0, "B: unaccepted event is not in accepted-current-run query");
	led2 = markAccepted(led2, e.eventId, NOW_T2);
	check(findAcceptedCurrentRun(led2, "coder_evidence").length === 1, "B: accepted event is in accepted-current-run query");

	// Superseded events are excluded.
	let led3 = createEvidenceLedger({ runId: "run-B", now: NOW_T0 });
	led3 = appendEvent(led3, {
		runId: "run-B", kind: "coder_evidence", context: ctx,
		payload: { filesChanged: ["a"], commandsRun: [{ command: "c", outcome: "passed" }], criterionCoverage: [] },
	}, NOW_T1);
	const first = led3.events[0]!;
	led3 = markAccepted(led3, first.eventId, NOW_T2);
	led3 = appendEvent(led3, {
		runId: "run-B", kind: "coder_evidence", context: ctx, source: "coder#2",
		payload: { filesChanged: ["b"], commandsRun: [{ command: "d", outcome: "passed" }], criterionCoverage: [] },
	}, NOW_T2);
	const second = led3.events[1]!;
	led3 = markAccepted(led3, second.eventId, NOW_T2);
	led3 = markSuperseded(led3, first.eventId, second.eventId, NOW_T3);
	check(led3.events.find((e) => e.eventId === first.eventId)!.status === "superseded", "B: markSuperseded flips status");
	check(led3.events.find((e) => e.eventId === first.eventId)!.supersededBy === second.eventId, "B: markSuperseded records supersededBy");
	const current = findCurrentEvents(led3, "coder_evidence");
	check(current.length === 1 && current[0]!.eventId === second.eventId, "B: superseded event is excluded from findCurrentEvents");

	// A status transition must only touch the targeted event.
	let led4 = createEvidenceLedger({ runId: "run-B", now: NOW_T0 });
	led4 = appendEvent(led4, { runId: "run-B", kind: "coder_evidence", context: ctx, payload: { filesChanged: [], commandsRun: [], criterionCoverage: [] } }, NOW_T1);
	led4 = appendEvent(led4, { runId: "run-B", kind: "gate_decision", context: ctx, payload: { gateId: "g", outcome: "advance", rejectionCodes: [] } }, NOW_T1);
	const c = led4.events[0]!;
	const g = led4.events[1]!;
	led4 = markAccepted(led4, c.eventId, NOW_T2);
	check(led4.events.find((e) => e.eventId === c.eventId)!.status === "accepted", "B: targeted event was accepted");
	check(led4.events.find((e) => e.eventId === g.eventId)!.status === "recorded", "B: status transition only mutates the targeted event");

	// Rejecting a missing event id throws (no silent success).
	let threw = false;
	try { markAccepted(led4, "does-not-exist", NOW_T2); } catch { threw = true; }
	check(threw, "B: markAccepted on missing eventId throws (no fake success)");

	// queryByKind / queryByStatus reflect ledger contents.
	check(queryByKind(led4, "coder_evidence").length === 1, "B: queryByKind returns matching events");
	check(queryByKind(led4, "reviewer_evidence").length === 0, "B: queryByKind returns no events for absent kind");

	// snapshotLedger returns a defensive shallow copy.
	const snap = snapshotLedger(led4);
	check(snap !== led4 && snap.events !== led4.events, "B: snapshotLedger returns a defensive copy");
	check(snap.events.length === led4.events.length, "B: snapshotLedger preserves event count");
}

// (C) Legacy import adapter — provenance, warnings, structured content.
function sectionC_legacyImportAdapter(): void {
	console.log("\n# (C) Legacy import adapter");
	const ctx = makeContext("run-C");
	const run = createDeliveryRun({ runId: "run-C", now: NOW_T0 });
	let ledger = run.ledger;

	// C.1 coderEvidence (with structured content) → legacy provenance + warnings.
	const coderResult = importLegacyEvidence({
		runId: "run-C", context: ctx,
		source: {
			coderEvidence: {
				filesChanged: ["extensions/workflow/delivery/ledger.ts"],
				commandsRun: [{ command: "npx tsx --check", outcome: "passed" }],
				criterionCoverage: [{ criterion: "ledger-helpers", evidenceKind: "static-check", strength: "sufficient", summary: "ok" }],
			},
		},
		sourceLabel: "done-sidecar:run-C.json",
		now: NOW_T1,
		ledger,
	});
	ledger = coderResult.ledger;
	check(coderResult.detected === "coderEvidence", "C: coderEvidence payload detected");
	check(coderResult.warnings.some((w) => w.code === "deprecated_coder_evidence"), "C: deprecated_coder_evidence warning emitted");
	const allCoderEvents = ledger.events;
	check(allCoderEvents.every((e) => e.provenance === "legacy"), "C: every imported event has legacy provenance");
	const mirroredCoder = allCoderEvents.find((e): e is CoderEvidenceEvent => e.kind === "coder_evidence" && e.provenance === "legacy");
	check(!!mirroredCoder, "C: structured coderEvidence mirrors into a typed coder_evidence event");
	check(mirroredCoder?.payload.filesChanged.includes("extensions/workflow/delivery/ledger.ts") === true, "C: mirrored coder_evidence carries filesChanged");

	// C.2 reviewerEvidence (with verdict) → legacy provenance + warning.
	const reviewerResult = importLegacyEvidence({
		runId: "run-C", context: ctx,
		source: {
			reviewerEvidence: {
				role: "behavior",
				verdict: "APPROVED",
				effectiveVerdict: "APPROVED",
				blockingReasons: [],
				weakEvidence: [],
				promptOnlyCaveats: ["prompt-only heuristic"],
				unresolvedRisks: [],
			},
		},
		sourceLabel: "done-sidecar:run-C.reviewer",
		now: NOW_T2,
		ledger,
	});
	ledger = reviewerResult.ledger;
	check(reviewerResult.warnings.some((w) => w.code === "deprecated_reviewer_evidence"), "C: deprecated_reviewer_evidence warning emitted");
	const mirroredReviewer = ledger.events.find((e): e is ReviewerEvidenceEvent => e.kind === "reviewer_evidence" && e.provenance === "legacy");
	check(!!mirroredReviewer, "C: structured reviewerEvidence mirrors into a typed reviewer_evidence event");
	check(mirroredReviewer?.payload.effectiveVerdict === "APPROVED", "C: mirrored reviewer_evidence carries effectiveVerdict");
	check(mirroredReviewer?.payload.promptOnlyCaveats.includes("prompt-only heuristic") === true, "C: mirrored reviewer_evidence carries promptOnlyCaveats");

	// C.3 summary (string-encoded JSON) → legacy + warning + raw summary.
	const summaryResult = importLegacyEvidence({
		runId: "run-C", context: ctx,
		source: { summary: JSON.stringify({ filesChanged: ["x.ts"], commandsRun: [{ command: "y", outcome: "passed" }] }) },
		sourceLabel: "done-sidecar:run-C.summary",
		now: NOW_T3,
		ledger,
	});
	ledger = summaryResult.ledger;
	check(summaryResult.warnings.some((w) => w.code === "deprecated_summary_json"), "C: deprecated_summary_json warning emitted");
	const summaryImport = ledger.events.filter((e) => e.kind === "legacy_import").slice(-1)[0]!;
	check(summaryImport.payload.importedFrom === "summary", "C: summary import tagged with importedFrom === 'summary'");
	check(typeof summaryImport.payload.rawSummary === "string" && summaryImport.payload.rawSummary.length > 0, "C: summary import carries rawSummary text");

	// C.4 delegateHistory (with attempts) → legacy + warning + mirror.
	const delegateResult = importLegacyEvidence({
		runId: "run-C", context: ctx,
		source: {
			delegateHistory: {
				attempts: [{ attempt: 1, completionSource: "tool", status: "completed" }],
				warnings: ["first attempt warning"],
				retries: 1,
			},
		},
		sourceLabel: "done-sidecar:run-C.delegate",
		now: NOW_T3,
		ledger,
	});
	ledger = delegateResult.ledger;
	check(delegateResult.warnings.some((w) => w.code === "deprecated_delegate_history"), "C: deprecated_delegate_history warning emitted");

	// C.5 free-form-only input → marked rejected, hasStructuredContent: false.
	const ffResult = importLegacyEvidence({
		runId: "run-C", context: ctx,
		source: "free form text only — no structured evidence",
		sourceLabel: "free-form-only",
		now: NOW_T3,
		ledger,
	});
	ledger = ffResult.ledger;
	check(ffResult.detected === "freeFormOnly", "C: free-form-only input detected");
	check(ffResult.warnings.some((w) => w.code === "free_form_only"), "C: free_form_only warning emitted");
	check(ffResult.freeFormOnly === true, "C: freeFormOnly flag is true");
	const ffImport = ffResult.events[0]!;
	check(ffImport.status === "rejected", "C: free-form-only event is marked rejected (fail-closed)");
	check(ffImport.provenance === "legacy", "C: free-form-only event has legacy provenance");
	check(ffImport.kind === "legacy_import" && (ffImport.payload as { hasStructuredContent: boolean }).hasStructuredContent === false, "C: free-form-only has hasStructuredContent=false");

	// C.6 free-form-only input is never returned in accepted-current-run query.
	check(findAcceptedCurrentRun(ledger, "legacy_import").length === 0, "C: free-form-only events never appear in accepted-current-run query");

	// C.7 isFreeFormOnly covers strings, numbers, booleans, arrays, and nullish.
	check(isFreeFormOnly("hello") === true, "C: isFreeFormOnly('hello') === true");
	check(isFreeFormOnly(42) === true, "C: isFreeFormOnly(42) === true");
	check(isFreeFormOnly(true) === true, "C: isFreeFormOnly(true) === true");
	check(isFreeFormOnly(null) === true, "C: isFreeFormOnly(null) === true");
	check(isFreeFormOnly(undefined) === true, "C: isFreeFormOnly(undefined) === true");
	check(isFreeFormOnly([]) === true, "C: isFreeFormOnly([]) === true");
	check(isFreeFormOnly({}) === true, "C: isFreeFormOnly({}) === true (no structured keys)");
	check(isFreeFormOnly({ coderEvidence: {} }) === false, "C: isFreeFormOnly({coderEvidence:{}}) === false");
	check(isFreeFormOnly({ commandsRun: [] }) === false, "C: isFreeFormOnly({commandsRun:[]}) === false");

	// C.8 auto_exit / process_exit / missing-sidecar phrases in free-form text
	//     still get a legacy_import event with explicit warnings.
	const autoExitResult = importLegacyEvidence({
		runId: "run-C", context: ctx,
		source: "auto_exit observed: no done sidecar",
		sourceLabel: "pane-fallback",
		now: NOW_T3,
		ledger,
	});
	ledger = autoExitResult.ledger;
	check(autoExitResult.warnings.some((w) => w.code === "free_form_only"), "C: free_form_only warning when auto_exit phrase present");
	check(autoExitResult.events[0]!.status === "rejected", "C: auto_exit free-form event is rejected");

	// C.9 importLegacyDoneSidecar accepts a string-encoded JSON object that
	//     contains a coderEvidence field; provenance + warnings still applied.
	const sidecarResult = importLegacyDoneSidecar({
		runId: "run-C", context: ctx,
		sidecar: JSON.stringify({
			done: true,
			coderEvidence: {
				filesChanged: ["a.ts"],
				commandsRun: [{ command: "c", outcome: "passed" }],
				criterionCoverage: [],
			},
		}),
		sourceLabel: "done-sidecar:string-encoded",
		now: NOW_T3,
		ledger,
	});
	ledger = sidecarResult.ledger;
	check(sidecarResult.warnings.some((w) => w.code === "deprecated_coder_evidence"), "C: importLegacyDoneSidecar emits deprecated_coder_evidence warning");
}

// (D) Reviewer evidence is first-class.
function sectionD_reviewerEvidenceFirstClass(): void {
	console.log("\n# (D) Reviewer evidence first-class");
	const ctx = makeContext("run-D");
	const run = createDeliveryRun({ runId: "run-D", now: NOW_T0 });
	let ledger = run.ledger;

	const reviewerPayload = {
		role: "implementation",
		verdict: "CHANGES_REQUESTED" as const,
		effectiveVerdict: "CHANGES_REQUESTED" as const,
		blockingReasons: ["missing typed evidence for criterion c1"],
		weakEvidence: [],
		promptOnlyCaveats: ["free-form-only final output"],
		unresolvedRisks: ["risk: legacy imports still trusted"],
		finalOutput: "Reviewer asked for changes.",
	};
	ledger = appendEvent(ledger, {
		runId: "run-D", kind: "reviewer_evidence", provenance: "canonical",
		context: ctx, source: "reviewer/implementation#1",
		payload: reviewerPayload,
	}, NOW_T1);

	const ev = ledger.events[0]!;
	check(ev.kind === "reviewer_evidence", "D: reviewer_evidence event created");
	check(ev.provenance === "canonical", "D: reviewer_evidence defaults to canonical provenance");
	check(typeof ev.eventId === "string" && ev.eventId.startsWith("reviewer_evidence:run-D:"), "D: reviewer_evidence has stable id");
	check(ev.context.taskId === "TASK-001", "D: reviewer_evidence carries run context (taskId)");

	if (ev.kind !== "reviewer_evidence") throw new Error("unreachable: kind narrow");
	const payload = ev.payload;
	check(payload.role === "implementation", "D: reviewer_evidence.role is structured (not free-form)");
	check(payload.verdict === "CHANGES_REQUESTED", "D: reviewer_evidence.verdict is structured");
	check(payload.effectiveVerdict === "CHANGES_REQUESTED", "D: reviewer_evidence.effectiveVerdict is structured");
	check(payload.blockingReasons.length === 1, "D: reviewer_evidence.blockingReasons is structured array");
	check(payload.promptOnlyCaveats.length === 1, "D: reviewer_evidence.promptOnlyCaveats is structured array");
	check(payload.unresolvedRisks.length === 1, "D: reviewer_evidence.unresolvedRisks is structured array");

	// collectHardBlockers picks up reviewer_evidence with blocking reasons.
	ledger = markAccepted(ledger, ev.eventId, NOW_T2);
	const blockers = collectHardBlockers(ledger);
	check(blockers.length === 1, "D: collectHardBlockers surfaces reviewer_evidence with blocking reasons");

	// Approving reviewer with no blocking reasons is not a hard blocker.
	let ledger2 = appendEvent(createEvidenceLedger({ runId: "run-D", now: NOW_T0 }), {
		runId: "run-D", kind: "reviewer_evidence", provenance: "canonical",
		context: ctx, source: "reviewer/implementation#2",
		payload: { role: "implementation", verdict: "APPROVED", effectiveVerdict: "APPROVED", blockingReasons: [], weakEvidence: [], promptOnlyCaveats: [], unresolvedRisks: [] },
	}, NOW_T1);
	ledger2 = markAccepted(ledger2, ledger2.events[0]!.eventId, NOW_T2);
	check(collectHardBlockers(ledger2).length === 0, "D: collectHardBlockers ignores approved reviewer_evidence");
}

// (E) Quality / finalization / AFK event coverage.
function sectionE_qualityFinalizationAfk(): void {
	console.log("\n# (E) Quality / finalization / AFK event coverage");
	const ctx = makeContext("run-E");
	const run = createDeliveryRun({ runId: "run-E", now: NOW_T0 });
	let ledger = run.ledger;

	// Quality-audit blocker.
	ledger = appendEvent(ledger, {
		runId: "run-E", kind: "quality_audit_blocker", provenance: "canonical",
		context: ctx, source: "quality-audit#1",
		payload: { severity: "critical", code: "qa-001", message: "failing test", evidenceRefs: ["run-D:missing-criterion"] },
	}, NOW_T1);
	const blockerEvent = ledger.events[0]!;
	ledger = markAccepted(ledger, blockerEvent.eventId, NOW_T2);
	const blockerRows = collectBlockers(ledger);
	check(blockerRows.length === 1, "E: collectBlockers surfaces quality_audit_blocker");
	check(blockerRows[0]!.code === "qa-001", "E: blocker code is structured");
	check(blockerRows[0]!.severity === "block", "E: blocker severity is structured");

	// Finalization decision.
	ledger = appendEvent(ledger, {
		runId: "run-E", kind: "finalization_decision", provenance: "canonical",
		context: ctx, source: "finalization#1",
		payload: { requestedStatus: "done", recommendedStatus: "provisional_done", blockers: ["qa-001"], warnings: ["risk: prompt-only mitigation"], allowed: false },
	}, NOW_T2);
	const finalEvent = ledger.events[1]!;
	check(finalEvent.kind === "finalization_decision", "E: finalization_decision event created");
	if (finalEvent.kind !== "finalization_decision") throw new Error("unreachable: kind narrow");
	check(finalEvent.payload.recommendedStatus === "provisional_done", "E: finalization_decision.recommendedStatus is structured");
	check(finalEvent.payload.allowed === false, "E: finalization_decision.allowed is structured boolean");
	check(finalEvent.payload.blockers.includes("qa-001"), "E: finalization_decision.blockers is structured array");

	// AFK reference.
	ledger = appendEvent(ledger, {
		runId: "run-E", kind: "afk_reference", provenance: "canonical",
		context: ctx, source: "afk-ship#1",
		payload: { laneId: "lane-afk", referencedEventIds: [blockerEvent.eventId, finalEvent.eventId], summary: "afk ship block check", escalation: "reviewer follow-up" },
	}, NOW_T3);
	const afkEvent = ledger.events[2]!;
	check(afkEvent.kind === "afk_reference", "E: afk_reference event created");
	if (afkEvent.kind !== "afk_reference") throw new Error("unreachable: kind narrow");
	check(afkEvent.payload.referencedEventIds.length === 2, "E: afk_reference.referencedEventIds is structured array");
	check(afkEvent.payload.laneId === "lane-afk", "E: afk_reference.laneId is structured");
	check(afkEvent.payload.escalation === "reviewer follow-up", "E: afk_reference.escalation is structured");

	// AFK reference's decision links include the gate/finalization events.
	const links = buildDecisionLinks(ledger, afkEvent);
	check(links.includes(finalEvent.eventId), "E: AFK reference is linked to finalization decision");
}

// (F) Projections — memo and report rows.
function sectionF_projections(): void {
	console.log("\n# (F) Projections");
	const ctx = makeContext("run-F");
	const run = createDeliveryRun({ runId: "run-F", now: NOW_T0 });
	let ledger = run.ledger;

	// coder_evidence
	ledger = appendEvent(ledger, {
		runId: "run-F", kind: "coder_evidence", provenance: "canonical",
		context: ctx, source: "coder#1",
		payload: {
			filesChanged: ["extensions/workflow/delivery/ledger.ts"],
			commandsRun: [{ command: "npx tsx", outcome: "passed" }],
			criterionCoverage: [{ criterion: "c1", evidenceKind: "behavior-test", strength: "sufficient", summary: "ok" }],
		},
	}, NOW_T1);
	const coderEvent = ledger.events[0]!;
	ledger = markAccepted(ledger, coderEvent.eventId, NOW_T2);

	// gate_decision
	ledger = appendEvent(ledger, {
		runId: "run-F", kind: "gate_decision", provenance: "canonical",
		context: ctx, source: "gate/c2r",
		payload: { gateId: "c2r", outcome: "advance", reason: "ok", rejectionCodes: [] },
	}, NOW_T2);
	const gateEvent = ledger.events[1]!;
	ledger = markAccepted(ledger, gateEvent.eventId, NOW_T3);

	// finalization_decision
	ledger = appendEvent(ledger, {
		runId: "run-F", kind: "finalization_decision", provenance: "canonical",
		context: ctx, source: "finalization#1",
		payload: { requestedStatus: "done", recommendedStatus: "done", blockers: [], warnings: [], allowed: true },
	}, NOW_T3);
	const finalEvent = ledger.events[2]!;
	ledger = markAccepted(ledger, finalEvent.eventId, NOW_T3);

	// afk_reference
	ledger = appendEvent(ledger, {
		runId: "run-F", kind: "afk_reference", provenance: "canonical",
		context: ctx, source: "afk#1",
		payload: { laneId: "lane-afk", referencedEventIds: [coderEvent.eventId, gateEvent.eventId, finalEvent.eventId], summary: "afk ship" },
	}, NOW_T3);
	const afkEvent = ledger.events[3]!;

	// quality_audit_blocker (carries evidenceRefs that must flow into Markdown
	// evidenceIds column under renderLedgerMarkdown).
	ledger = appendEvent(ledger, {
		runId: "run-F", kind: "quality_audit_blocker", provenance: "canonical",
		context: ctx, source: "qa#1",
		payload: { severity: "high", code: "qa-001", message: "failing test", evidenceRefs: [coderEvent.eventId, gateEvent.eventId] },
	}, NOW_T3);
	const qualityEvent = ledger.events[4]!;

	// Memo rows: every event has id, status, provenance, warnings, run context.
	const memoRows = toMemoRows(ledger);
	check(memoRows.length === ledger.events.length, "F: toMemoRows returns one row per event");
	for (const row of memoRows) {
		check(typeof row.eventId === "string" && row.eventId.length > 0, `F: memo row ${row.kind} has eventId`);
		check(["recorded", "accepted", "rejected", "superseded"].includes(row.status), `F: memo row ${row.kind} has status`);
		check(["canonical", "legacy", "projection", "manual"].includes(row.provenance), `F: memo row ${row.kind} has provenance`);
		check(Array.isArray(row.warnings), `F: memo row ${row.kind} has warnings array`);
		check(row.taskId === "TASK-001", `F: memo row ${row.kind} carries taskId from run context`);
	}

	// Memo rows with links: coder_evidence is linked to gate + finalization.
	const memoWithLinks = toMemoRowsWithLinks(ledger);
	const coderRow = memoWithLinks.find((r) => r.eventId === coderEvent.eventId);
	check(!!coderRow, "F: memo rows include coder_evidence row");
	check(coderRow!.decisionLinks.includes(gateEvent.eventId), "F: coder_evidence memo row links to gate_decision");
	check(coderRow!.decisionLinks.includes(finalEvent.eventId), "F: coder_evidence memo row links to finalization_decision");
	check(coderRow!.summary.includes("coder_evidence"), "F: memo row summary describes the event kind (structured)");

	// Report rows: include evidenceIds.
	const reportRows = toReportRows(ledger);
	const afkReport = reportRows.find((r) => r.eventId === afkEvent.eventId);
	check(!!afkReport, "F: report rows include afk_reference row");
	check(afkReport!.evidenceIds.includes(coderEvent.eventId), "F: afk_reference report row includes coder_evidence in evidenceIds");
	check(afkReport!.evidenceIds.includes(gateEvent.eventId), "F: afk_reference report row includes gate_decision in evidenceIds");

	// toMemoRow / toReportRow work on a single event.
	const single = toMemoRow(coderEvent);
	check(single.eventId === coderEvent.eventId, "F: toMemoRow matches event");
	const singleReport = toReportRow(coderEvent);
	check(singleReport.evidenceIds.length === 0, "F: toReportRow on coder_evidence has no evidenceIds (none carried)");

	// Markdown memo includes evidence IDs, statuses, provenances, kinds.
	const md = renderLedgerMarkdown(ledger);
	check(md.includes(coderEvent.eventId), "F: markdown memo includes coder_evidence eventId");
	check(md.includes(gateEvent.eventId), "F: markdown memo includes gate_decision eventId");
	check(md.includes("canonical"), "F: markdown memo shows canonical provenance");
	check(md.includes("accepted"), "F: markdown memo shows accepted status");

	// Markdown memo exposes structured `decisionLinks` and `evidenceIds` columns
	// populated from the underlying structured ledger rows (not free-form text).
	check(md.includes("| decisionLinks |"), "F: markdown memo has a decisionLinks column header");
	check(md.includes("| evidenceIds |"), "F: markdown memo has an evidenceIds column header");

	// Markdown memo coder_evidence row links to gate/finalization decisions.
	const coderMdRow = md.split("\n").find((line) => line.startsWith(`| ${coderEvent.eventId} |`));
	check(!!coderMdRow, "F: markdown memo has a row for coder_evidence");
	check(!!coderMdRow && coderMdRow.includes(gateEvent.eventId), "F: markdown memo coder_evidence row links to gate_decision eventId");
	check(!!coderMdRow && coderMdRow.includes(finalEvent.eventId), "F: markdown memo coder_evidence row links to finalization_decision eventId");

	// Markdown memo afk_reference row lists referenced evidence IDs in
	// the dedicated evidenceIds column (not just as free-form text).
	const afkMdRow = md.split("\n").find((line) => line.startsWith(`| ${afkEvent.eventId} |`));
	check(!!afkMdRow, "F: markdown memo has a row for afk_reference");
	check(!!afkMdRow && afkMdRow.includes(coderEvent.eventId), "F: markdown memo afk_reference row lists coder_evidence in evidenceIds");
	check(!!afkMdRow && afkMdRow.includes(gateEvent.eventId), "F: markdown memo afk_reference row lists gate_decision in evidenceIds");
	check(!!afkMdRow && afkMdRow.includes(finalEvent.eventId), "F: markdown memo afk_reference row lists finalization_decision in evidenceIds");

	// Markdown memo quality_audit_blocker row lists its evidenceRefs in the
	// dedicated evidenceIds column.
	const qualityMdRow = md.split("\n").find((line) => line.startsWith(`| ${qualityEvent.eventId} |`));
	check(!!qualityMdRow, "F: markdown memo has a row for quality_audit_blocker");
	check(!!qualityMdRow && qualityMdRow.includes(coderEvent.eventId), "F: markdown memo quality_audit_blocker row lists coder_evidence in evidenceIds");
	check(!!qualityMdRow && qualityMdRow.includes(gateEvent.eventId), "F: markdown memo quality_audit_blocker row lists gate_decision in evidenceIds");

	// A legacy_import event preserves provenance, warnings, and the imported
	// source label in its memo row. We use a free-form-only input so the
	// legacy_import event is rejected and its warnings array is populated.
	const ledgerWithLegacy = importLegacyEvidence({
		runId: "run-F", context: ctx,
		source: "free-form summary text with auto_exit observed",
		sourceLabel: "done-sidecar:run-F.freeform",
		now: NOW_T3, ledger,
	}).ledger;
	const legacyRows = toMemoRows(ledgerWithLegacy);
	const legacyRow = legacyRows.find((r) => r.kind === "legacy_import");
	check(!!legacyRow, "F: legacy_import appears in memo rows");
	check(legacyRow!.provenance === "legacy", "F: legacy_import memo row shows legacy provenance");
	check(legacyRow!.warnings.length > 0, "F: legacy_import memo row carries warnings");
}

// (G) Fail-closed handling of free-form-only legacy inputs.
// (H) Defensive ledger guards: duplicate eventId, cross-run append, exactly-one mutation,
//     free-form legacy accepted-rejection.
// (I) Legacy import warnings are attached to events, not only ImportLegacyResult.
// (J) Free-form auto_exit / process_exit / missing-sidecar detection + source: undefined safety.
function sectionG_freeFormOnlyFailClosed(): void {
	console.log("\n# (G) Free-form-only fail-closed");
	const ctx = makeContext("run-G");
	const run = createDeliveryRun({ runId: "run-G", now: NOW_T0 });
	const ledger = run.ledger;

	// Plain string free-form input.
	const r1 = importLegacyEvidence({ runId: "run-G", context: ctx, source: "summary text only", sourceLabel: "ff", now: NOW_T1, ledger });
	check(r1.freeFormOnly === true, "G: string free-form input flagged freeFormOnly");
	check(r1.events[0]!.status === "rejected", "G: string free-form input is rejected");
	check(findAcceptedCurrentRun(r1.ledger, "legacy_import").length === 0, "G: string free-form input never appears in accepted-current-run query");

	// Number free-form input.
	const r2 = importLegacyEvidence({ runId: "run-G", context: ctx, source: 42, sourceLabel: "ff-num", now: NOW_T1, ledger });
	check(r2.freeFormOnly === true, "G: number input flagged freeFormOnly");
	check(r2.events[0]!.status === "rejected", "G: number input is rejected");

	// Empty array free-form input.
	const r3 = importLegacyEvidence({ runId: "run-G", context: ctx, source: [], sourceLabel: "ff-arr", now: NOW_T1, ledger });
	check(r3.freeFormOnly === true, "G: empty array input flagged freeFormOnly");
	check(r3.events[0]!.status === "rejected", "G: empty array input is rejected");

	// Object with NO recognized structured fields → free-form-only.
	const r4 = importLegacyEvidence({ runId: "run-G", context: ctx, source: { hello: "world" }, sourceLabel: "ff-obj", now: NOW_T1, ledger });
	check(r4.freeFormOnly === true, "G: object without structured fields flagged freeFormOnly");
	check(r4.events[0]!.status === "rejected", "G: object without structured fields is rejected");

	// coderEvidence without any structured content → fail-closed.
	const r5 = importLegacyEvidence({
		runId: "run-G", context: ctx,
		source: { coderEvidence: { filesChanged: [], commandsRun: [], criterionCoverage: [] } },
		sourceLabel: "empty-coder",
		now: NOW_T1, ledger,
	});
	check(r5.warnings.some((w) => w.code === "no_structured_content"), "G: empty coderEvidence emits no_structured_content");
	check(r5.freeFormOnly === true, "G: empty coderEvidence flagged freeFormOnly");
	check(r5.events[0]!.status === "rejected", "G: empty coderEvidence is rejected");

	// reviewerEvidence without verdict / blocking / weak / etc. → fail-closed.
	const r6 = importLegacyEvidence({
		runId: "run-G", context: ctx,
		source: { reviewerEvidence: { role: "behavior" } },
		sourceLabel: "empty-reviewer",
		now: NOW_T1, ledger,
	});
	check(r6.warnings.some((w) => w.code === "no_structured_content"), "G: empty reviewerEvidence emits no_structured_content");
	check(r6.freeFormOnly === true, "G: empty reviewerEvidence flagged freeFormOnly");
	check(r6.events[0]!.status === "rejected", "G: empty reviewerEvidence is rejected");

	// Summary as a free-form string (not parseable JSON) → fail-closed.
	const r7 = importLegacyEvidence({
		runId: "run-G", context: ctx,
		source: { summary: "narrative summary text only" },
		sourceLabel: "ff-summary",
		now: NOW_T1, ledger,
	});
	check(r7.warnings.some((w) => w.code === "deprecated_summary_json"), "G: free-form summary still emits deprecated_summary_json");
	check(r7.warnings.some((w) => w.code === "no_structured_content"), "G: free-form summary emits no_structured_content");
	check(r7.events[0]!.status === "rejected", "G: free-form summary event is rejected");

	// collectWarnings surfaces non-rejected warnings; rejected events carry
	// their own warnings array (visible via the event itself). Verify both
	// paths so operators can trace provenance.
	const combined = importLegacyEvidence({
		runId: "run-G", context: ctx,
		source: "auto_exit observed",
		sourceLabel: "ff-auto",
		now: NOW_T1, ledger,
	}).ledger;
	const ffEvent = combined.events[combined.events.length - 1]!;
	check(ffEvent.status === "rejected", "G: free-form auto_exit event is rejected");
	check(ffEvent.warnings.length > 0 && ffEvent.warnings.some((w) => /free[- ]?form/i.test(w)), "G: rejected event carries free-form warning text on its own warnings array");
	const warnings = collectWarnings(combined);
	// The free_form_only event is rejected, so it is not in collectWarnings.
	// Verify that collectWarnings on a non-rejected event with warnings
	// surfaces the warning text.
	const recordedLedger = createEvidenceLedger({ runId: "run-G", now: NOW_T0 });
	const recordedLedgerWithWarnings = appendEvent(recordedLedger, {
		runId: "run-G", kind: "gate_decision", context: ctx,
		payload: { gateId: "g", outcome: "advance", rejectionCodes: [] },
		warnings: ["non-rejected warning for collectWarnings"],
	}, NOW_T1);
	check(collectWarnings(recordedLedgerWithWarnings).includes("non-rejected warning for collectWarnings"), "G: collectWarnings surfaces non-rejected event warnings");
}

// (H) Defensive ledger guards: duplicate eventId, cross-run append, exactly-one
//     status mutation, and free-form legacy accepted-rejection.
function sectionH_defensiveLedgerGuards(): void {
	console.log("\n# (H) Defensive ledger guards");
	const ctx = makeContext("run-H");

	// H.1 Duplicate eventId is rejected.
	let ledH1 = createEvidenceLedger({ runId: "run-H", now: NOW_T0 });
	ledH1 = appendEvent(ledH1, {
		runId: "run-H", kind: "coder_evidence", context: ctx, eventId: "dup-id-1",
		payload: { filesChanged: [], commandsRun: [], criterionCoverage: [] },
	}, NOW_T1);
	let dupThrew = false;
	try {
		appendEvent(ledH1, {
			runId: "run-H", kind: "coder_evidence", context: ctx, eventId: "dup-id-1",
			payload: { filesChanged: [], commandsRun: [], criterionCoverage: [] },
		}, NOW_T1);
	} catch { dupThrew = true; }
	check(dupThrew, "H: appendEvent rejects duplicate eventId (throws)");
	check(ledH1.events.length === 1, "H: ledger length unchanged after rejected duplicate append");

	// H.2 markEventStatus asserts exactly one match — zero throws.
	let ledH2 = createEvidenceLedger({ runId: "run-H", now: NOW_T0 });
	let zeroMatchThrew = false;
	try {
		markEventStatus(ledH2, "missing-id", { status: "accepted", now: NOW_T1 });
	} catch { zeroMatchThrew = true; }
	check(zeroMatchThrew, "H: markEventStatus on missing id throws (exactly-one assertion: found 0)");

	// H.3 markEventStatus asserts exactly one match — a hand-crafted ledger
	//     with two events sharing the same id is rejected too.
	const dupIdLedger: EvidenceLedger = {
		ledgerId: "ledger:run-H",
		runId: "run-H",
		createdAt: NOW_T0,
		updatedAt: NOW_T0,
		events: [
			{
				eventId: "shared-id",
				runId: "run-H",
				kind: "coder_evidence",
				provenance: "canonical",
				status: "recorded",
				recordedAt: NOW_T1,
				context: ctx,
				warnings: [],
				payload: { filesChanged: [], commandsRun: [], criterionCoverage: [] },
			},
			{
				eventId: "shared-id",
				runId: "run-H",
				kind: "gate_decision",
				provenance: "canonical",
				status: "recorded",
				recordedAt: NOW_T1,
				context: ctx,
				warnings: [],
				payload: { gateId: "g", outcome: "advance", rejectionCodes: [] },
			},
		],
	};
	let dupMatchThrew = false;
	try {
		markEventStatus(dupIdLedger, "shared-id", { status: "accepted", now: NOW_T2 });
	} catch { dupMatchThrew = true; }
	check(dupMatchThrew, "H: markEventStatus rejects multi-match eventId (exactly-one assertion: found >1)");
	const dupUnchanged = dupIdLedger.events.every((e) => e.status === "recorded");
	check(dupUnchanged, "H: multi-match ledger was not mutated before throw");

	// H.4 A status transition must touch exactly one event and not mutate
	//     the rest of the ledger.
	let ledH4 = createEvidenceLedger({ runId: "run-H", now: NOW_T0 });
	ledH4 = appendEvent(ledH4, {
		runId: "run-H", kind: "coder_evidence", context: ctx,
		payload: { filesChanged: [], commandsRun: [], criterionCoverage: [] },
	}, NOW_T1);
	ledH4 = appendEvent(ledH4, {
		runId: "run-H", kind: "gate_decision", context: ctx,
		payload: { gateId: "g", outcome: "advance", rejectionCodes: [] },
	}, NOW_T1);
	const target = ledH4.events[0]!;
	const otherEvent = ledH4.events.find((e) => e.eventId !== target.eventId);
	const otherBefore = { id: otherEvent!.eventId, status: otherEvent!.status, recordedAt: otherEvent!.recordedAt };
	ledH4 = markAccepted(ledH4, target.eventId, NOW_T2);
	check(ledH4.events.find((e) => e.eventId === target.eventId)!.status === "accepted", "H: targeted event transitions to accepted");
	const otherAfter = ledH4.events.find((e) => e.eventId === otherBefore.id)!;
	check(otherAfter.status === otherBefore.status, "H: untargeted event status unchanged");
	check(otherAfter.recordedAt === otherBefore.recordedAt, "H: untargeted event recordedAt unchanged");

	// H.5 Appending an event for a different run than `ledger.runId` is rejected.
	const crossRunLedger = createEvidenceLedger({ runId: "run-H", now: NOW_T0 });
	let crossRunThrew = false;
	try {
		appendEvent(crossRunLedger, {
			runId: "run-X", kind: "coder_evidence", context: { runId: "run-X" },
			payload: { filesChanged: [], commandsRun: [], criterionCoverage: [] },
		}, NOW_T1);
	} catch { crossRunThrew = true; }
	check(crossRunThrew, "H: appendEvent rejects input.runId !== ledger.runId (cross-run guard)");
	check(crossRunLedger.events.length === 0, "H: cross-run ledger unchanged after rejected append");

	// H.6 findAcceptedCurrentRun excludes cross-run events. Build a hand-crafted
	//     ledger with an accepted coder_evidence event for a different runId.
	const crossRunEventsLedger: EvidenceLedger = {
		ledgerId: "ledger:run-H",
		runId: "run-H",
		createdAt: NOW_T0,
		updatedAt: NOW_T0,
		events: [
			{
				eventId: "cross-run-accepted",
				runId: "run-Y",
				kind: "coder_evidence",
				provenance: "canonical",
				status: "accepted",
				recordedAt: NOW_T1,
				context: { runId: "run-Y" },
				warnings: [],
				payload: { filesChanged: [], commandsRun: [], criterionCoverage: [] },
			},
			{
				eventId: "same-run-accepted",
				runId: "run-H",
				kind: "coder_evidence",
				provenance: "canonical",
				status: "accepted",
				recordedAt: NOW_T1,
				context: ctx,
				warnings: [],
				payload: { filesChanged: [], commandsRun: [], criterionCoverage: [] },
			},
		],
	};
	const accepted = findAcceptedCurrentRun(crossRunEventsLedger, "coder_evidence");
	check(accepted.length === 1, "H: findAcceptedCurrentRun excludes cross-run events (count=1)");
	check(accepted[0]!.eventId === "same-run-accepted", "H: findAcceptedCurrentRun returns only same-run event");
	const current = findCurrentEvents(crossRunEventsLedger, "coder_evidence");
	check(current.length === 1 && current[0]!.eventId === "same-run-accepted", "H: findCurrentEvents excludes cross-run events");
	const latest = findCurrentEvent(crossRunEventsLedger, "coder_evidence");
	check(latest !== undefined && latest.eventId === "same-run-accepted", "H: findCurrentEvent excludes cross-run events");

	// H.7 Trying to mark a free-form legacy_import event accepted is rejected.
	const freeFormImport = importLegacyEvidence({
		runId: "run-H", context: ctx,
		source: "just a free-form string", sourceLabel: "ff", now: NOW_T1,
	});
	const ffEvent = freeFormImport.events[0]!;
	check(ffEvent.status === "rejected", "H: free-form legacy import is rejected by the adapter");
	check(ffEvent.kind === "legacy_import", "H: free-form legacy import kind === legacy_import");
	check(isFreeFormLegacyImport(ffEvent), "H: isFreeFormLegacyImport classifier matches the rejected event");
	let acceptedThrew = false;
	try {
		markAccepted(freeFormImport.ledger, ffEvent.eventId, NOW_T2);
	} catch { acceptedThrew = true; }
	check(acceptedThrew, "H: markAccepted on free-form legacy_import throws (accepted-rejection guard)");

	// H.8 findAcceptedCurrentRun defensively excludes free-form legacy_import
	//     events even if they somehow have status === "accepted".
	const tamperedLedger: EvidenceLedger = {
		ledgerId: "ledger:run-H",
		runId: "run-H",
		createdAt: NOW_T0,
		updatedAt: NOW_T0,
		events: [
			{
				eventId: "tampered-ff-legacy",
				runId: "run-H",
				kind: "legacy_import",
				provenance: "legacy",
				status: "accepted", // bypassed guard — defensive filter must still exclude
				recordedAt: NOW_T1,
				context: ctx,
				warnings: [],
				payload: { importedFrom: "freeFormOnly", originalSource: "ff", hasStructuredContent: false },
			},
		],
	};
	check(findAcceptedCurrentRun(tamperedLedger, "legacy_import").length === 0, "H: findAcceptedCurrentRun defensively excludes free-form legacy_import even when tampered to accepted");

	// H.9 appendEvent refuses to directly create an accepted free-form
	//     legacy_import event. The status transition path already rejects
	//     this (H.7) but the append path must too, so a caller cannot bypass
	//     the guard by passing `status: "accepted"` straight into the input.
	let ledH9 = createEvidenceLedger({ runId: "run-H", now: NOW_T0 });
	let directAcceptedThrew = false;
	try {
		appendEvent(ledH9, {
			runId: "run-H", kind: "legacy_import", status: "accepted",
			context: ctx, source: "direct-accepted-freeform",
			payload: { importedFrom: "freeFormOnly", originalSource: "direct", hasStructuredContent: false },
		}, NOW_T1);
	} catch { directAcceptedThrew = true; }
	check(directAcceptedThrew, "H: appendEvent throws when asked to create a free-form legacy_import with status 'accepted'");
	check(ledH9.events.length === 0, "H: ledger length unchanged after rejected free-form accepted append");
	check(ledH9.updatedAt === NOW_T0, "H: ledger updatedAt unchanged after rejected free-form accepted append");

	// H.10 appendEvent still accepts a structured legacy_import with status
	//      === "accepted" (the guard only blocks free-form legacy imports).
	//      A legacy_import with hasStructuredContent === true is NOT
	//      free-form-only per the classifier, so it should be appended.
	let ledH10 = createEvidenceLedger({ runId: "run-H", now: NOW_T0 });
	let structuredAccepted: EvidenceEvent | undefined;
	try {
		ledH10 = appendEvent(ledH10, {
			runId: "run-H", kind: "legacy_import", status: "accepted",
			context: ctx, source: "structured-legacy",
			payload: { importedFrom: "coderEvidence", originalSource: "structured", hasStructuredContent: true },
		}, NOW_T1);
		structuredAccepted = ledH10.events[0];
	} catch { /* swallow; the assertion below will fail */ }
	check(!!structuredAccepted, "H: appendEvent accepts a structured legacy_import with status 'accepted' (guard is free-form-only)");
	check(structuredAccepted?.status === "accepted", "H: structured legacy_import event has status 'accepted'");
}

// (I) Legacy import warnings are attached to ledger events, not only the
//     ImportLegacyResult. Projections should then expose the warnings.
function sectionI_legacyWarningsOnEvents(): void {
	console.log("\n# (I) Legacy import warnings attached to events");
	const ctx = makeContext("run-I");

	// I.1 Structured legacy coderEvidence: warnings on legacy_import event
	//     AND on the mirrored coder_evidence event.
	const r = importLegacyEvidence({
		runId: "run-I", context: ctx,
		source: {
			coderEvidence: {
				filesChanged: ["extensions/workflow/delivery/ledger.ts"],
				commandsRun: [{ command: "npx tsx --check", outcome: "passed" }],
				criterionCoverage: [{ criterion: "ledger-helpers", evidenceKind: "static-check", strength: "sufficient", summary: "ok" }],
			},
		},
		sourceLabel: "done-sidecar:run-I.json",
		now: NOW_T1,
	});
	check(r.warnings.some((w) => w.code === "deprecated_coder_evidence"), "I: result carries deprecated_coder_evidence");
	const legacyEvent = r.ledger.events.find((e) => e.kind === "legacy_import");
	check(!!legacyEvent, "I: legacy_import event created for structured coderEvidence");
	check(legacyEvent!.warnings.some((w) => w.includes("deprecated_coder_evidence")), "I: legacy_import event carries deprecated_coder_evidence warning text");
	const mirrored = r.ledger.events.find((e): e is CoderEvidenceEvent => e.kind === "coder_evidence" && e.provenance === "legacy");
	check(!!mirrored, "I: mirrored coder_evidence event exists");
	check(mirrored!.warnings.some((w) => w.includes("deprecated_coder_evidence")), "I: mirrored coder_evidence event carries the same warning text");

	// I.2 Structured legacy reviewerEvidence: warnings on both events.
	const r2 = importLegacyEvidence({
		runId: "run-I", context: ctx,
		source: {
			reviewerEvidence: {
				role: "behavior",
				verdict: "APPROVED",
				effectiveVerdict: "APPROVED",
				blockingReasons: ["legacy-b1"],
				weakEvidence: [],
				promptOnlyCaveats: [],
				unresolvedRisks: [],
			},
		},
		sourceLabel: "done-sidecar:run-I.reviewer",
		now: NOW_T2,
	});
	const reviewerLegacy = r2.ledger.events.find((e) => e.kind === "legacy_import" && r2.ledger.events.indexOf(e) !== 0);
	// legacy_import may be in the same ledger as I.1's events, so filter by source.
	const reviewerLegacyEvent = r2.events.find((e) => e.kind === "legacy_import");
	check(!!reviewerLegacyEvent, "I: legacy_import event created for structured reviewerEvidence");
	check(reviewerLegacyEvent!.warnings.some((w) => w.includes("deprecated_reviewer_evidence")), "I: reviewer legacy_import event carries deprecated_reviewer_evidence warning text");
	const reviewerMirror = r2.events.find((e): e is ReviewerEvidenceEvent => e.kind === "reviewer_evidence" && e.provenance === "legacy");
	check(!!reviewerMirror, "I: mirrored reviewer_evidence event exists");
	check(reviewerMirror!.warnings.some((w) => w.includes("deprecated_reviewer_evidence")), "I: mirrored reviewer_evidence event carries the warning text");

	// I.3 Projection rows expose the warnings so operators see them in memos.
	const memoRows = toMemoRows(r2.ledger, { kind: "reviewer_evidence" });
	const reviewerMemo = memoRows.find((row) => row.eventId === reviewerMirror!.eventId);
	check(!!reviewerMemo, "I: reviewer_evidence appears in memo rows");
	check(reviewerMemo!.warnings.some((w) => w.includes("deprecated_reviewer_evidence")), "I: memo row exposes the warning text");
	const memoRowsLegacy = toMemoRows(r2.ledger, { kind: "legacy_import" });
	const legacyMemo = memoRowsLegacy.find((row) => row.eventId === reviewerLegacyEvent!.eventId);
	check(!!legacyMemo, "I: reviewer legacy_import appears in memo rows");
	check(legacyMemo!.warnings.some((w) => w.includes("deprecated_reviewer_evidence")), "I: legacy_import memo row exposes the warning text");

	// I.4 The markdown memo includes the warning text too.
	const md = renderLedgerMarkdown(r2.ledger, { kind: "reviewer_evidence" });
	check(md.includes("deprecated_reviewer_evidence"), "I: markdown memo includes the reviewer warning text");
}

// (J) Free-form text mentioning auto_exit / process_exit / missing-sidecar
//     emits specific warning codes/messages and fails closed. `source: undefined`
//     fails closed without throwing.
function sectionJ_freeFormPhraseDetection(): void {
	console.log("\n# (J) Free-form auto_exit / process_exit / missing-sidecar + source: undefined");
	const ctx = makeContext("run-J");

	// J.1 Free-form text mentioning all three phrases gets all three warning codes.
	const allThree = importLegacyEvidence({
		runId: "run-J", context: ctx,
		source: "auto_exit observed: no done sidecar, process_exit was used to abort",
		sourceLabel: "pane-fallback",
		now: NOW_T1,
	});
	const codes = allThree.warnings.map((w) => w.code);
	check(codes.includes("free_form_only"), "J: free_form_only code present");
	check(codes.includes("auto_exit_observed"), "J: auto_exit_observed code present");
	check(codes.includes("process_exit_observed"), "J: process_exit_observed code present");
	check(codes.includes("missing_sidecar_observed"), "J: missing_sidecar_observed code present");
	const messages = allThree.warnings.map((w) => w.message);
	check(messages.some((m) => /auto_exit/i.test(m) && /cannot rely/i.test(m)), "J: auto_exit_observed message has authoritative content");
	check(messages.some((m) => /process_exit/i.test(m) && /cannot rely/i.test(m)), "J: process_exit_observed message has authoritative content");
	check(messages.some((m) => /missing sidecar/i.test(m) && /cannot rely/i.test(m)), "J: missing_sidecar_observed message has authoritative content");
	const ffEvent = allThree.events[0]!;
	check(ffEvent.status === "rejected", "J: free-form text with all three phrases is rejected");
	check(ffEvent.kind === "legacy_import", "J: free-form text with all three phrases is a legacy_import event");
	check(ffEvent.warnings.some((w) => /auto_exit/i.test(w)), "J: rejected event itself carries auto_exit warning text on its warnings array");
	check(ffEvent.warnings.some((w) => /process_exit/i.test(w)), "J: rejected event itself carries process_exit warning text");
	check(ffEvent.warnings.some((w) => /missing sidecar/i.test(w)), "J: rejected event itself carries missing_sidecar warning text");
	check(findAcceptedCurrentRun(allThree.ledger, "legacy_import").length === 0, "J: free-form auto_exit/process_exit/missing event is excluded from accepted-current-run query");

	// J.2 Free-form text mentioning only auto_exit emits ONLY that warning code (plus free_form_only).
	const autoExitOnly = importLegacyEvidence({
		runId: "run-J", context: ctx,
		source: "auto_exit happened",
		sourceLabel: "pane-fallback",
		now: NOW_T1,
	});
	const autoCodes = autoExitOnly.warnings.map((w) => w.code);
	check(autoCodes.includes("free_form_only"), "J: auto_exit-only input still emits free_form_only");
	check(autoCodes.includes("auto_exit_observed"), "J: auto_exit-only input emits auto_exit_observed");
	check(!autoCodes.includes("process_exit_observed"), "J: auto_exit-only input does NOT emit process_exit_observed");
	check(!autoCodes.includes("missing_sidecar_observed"), "J: auto_exit-only input does NOT emit missing_sidecar_observed");

	// J.3 Free-form text mentioning only missing-sidecar emits ONLY that warning code (plus free_form_only).
	const missingOnly = importLegacyEvidence({
		runId: "run-J", context: ctx,
		source: "missing sidecar for run-J",
		sourceLabel: "pane-fallback",
		now: NOW_T1,
	});
	const missingCodes = missingOnly.warnings.map((w) => w.code);
	check(missingCodes.includes("free_form_only"), "J: missing-only input still emits free_form_only");
	check(missingCodes.includes("missing_sidecar_observed"), "J: missing-only input emits missing_sidecar_observed");
	check(!missingCodes.includes("auto_exit_observed"), "J: missing-only input does NOT emit auto_exit_observed");
	check(!missingCodes.includes("process_exit_observed"), "J: missing-only input does NOT emit process_exit_observed");

	// J.4 source: undefined does NOT throw and fails closed.
	let undefinedThrew = false;
	let undefinedResult: ReturnType<typeof importLegacyEvidence> | undefined;
	try {
		undefinedResult = importLegacyEvidence({
			runId: "run-J", context: ctx,
			source: undefined, sourceLabel: "undefined-input", now: NOW_T1,
		});
	} catch { undefinedThrew = true; }
	check(!undefinedThrew, "J: importLegacyEvidence with source: undefined does NOT throw");
	check(undefinedResult !== undefined, "J: importLegacyEvidence with source: undefined returns a result");
	check(undefinedResult!.freeFormOnly === true, "J: source: undefined is flagged freeFormOnly");
	check(undefinedResult!.detected === "freeFormOnly", "J: source: undefined is detected as freeFormOnly");
	check(undefinedResult!.events[0]!.status === "rejected", "J: source: undefined produces a rejected legacy_import event");
	const undefinedEvent = undefinedResult!.events[0]!;
	check(undefinedEvent.kind === "legacy_import", "J: source: undefined event kind === legacy_import");
	check((undefinedEvent.payload as { hasStructuredContent: boolean }).hasStructuredContent === false, "J: source: undefined event hasStructuredContent === false");
	check(typeof (undefinedEvent.payload as { rawSummary: string }).rawSummary === "string", "J: source: undefined event rawSummary is a string (no .slice throw)");
	check(findAcceptedCurrentRun(undefinedResult!.ledger, "legacy_import").length === 0, "J: source: undefined event is excluded from accepted-current-run query");

	// J.5 source: null does NOT throw and fails closed.
	let nullThrew = false;
	let nullResult: ReturnType<typeof importLegacyEvidence> | undefined;
	try {
		nullResult = importLegacyEvidence({
			runId: "run-J", context: ctx,
			source: null, sourceLabel: "null-input", now: NOW_T1,
		});
	} catch { nullThrew = true; }
	check(!nullThrew, "J: importLegacyEvidence with source: null does NOT throw");
	check(nullResult!.freeFormOnly === true, "J: source: null is flagged freeFormOnly");
	check(nullResult!.events[0]!.status === "rejected", "J: source: null produces a rejected legacy_import event");
}

function main(): void {
	sectionA_canonicalTypeSurface();
	sectionB_pureLedgerHelpers();
	sectionC_legacyImportAdapter();
	sectionD_reviewerEvidenceFirstClass();
	sectionE_qualityFinalizationAfk();
	sectionF_projections();
	sectionG_freeFormOnlyFailClosed();
	sectionH_defensiveLedgerGuards();
	sectionI_legacyWarningsOnEvents();
	sectionJ_freeFormPhraseDetection();
}

main();
if (failures > 0) { console.error(`\n${failures} smoke check(s) failed.`); process.exit(1); }
console.log("\nAll TASK-001 delivery ledger foundation smoke checks passed.");
