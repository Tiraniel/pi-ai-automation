#!/usr/bin/env node
import type { DelegateCompletionSource } from "./types";
import type { ReviewerMemo } from "./delegate/reviewer-roles";
import type { WorkflowArchitecturePlan } from "./architecture/types";
import { validateEvidenceMatrix } from "./architecture/evidence-matrix";
import {
	normalizeCoderCompletionEvidence,
	evaluateCoderCompletionEvidence,
	type CoderEvidencePlanShape,
	type CoderCompletionEvidence,
	type CoderCriterionCoverage,
} from "./delegate/completion-evidence";
import type { WorkflowQualityAuditFinalizationSummary, WorkflowQualityAuditSeverity } from "./quality-audit-types";
export type FinalizationMode = "strict" | "dry-run";
export type FinalizationTarget =
	| { kind: "sprint-task"; taskId: string; planId?: string }
	| { kind: "debug-item"; itemId: string; area?: string };
type FinalizationSprintTarget = Extract<FinalizationTarget, { kind: "sprint-task" }>;
export interface FinalizationGateDebugChain {
	repeatedInAreaCount?: number;
	priorFailureCount?: number;
}
/** WP1: an unanswered blocking operator question anywhere in the workspace
 *  queue (`.pi/workflow-runs/<room|run>/questions.jsonl`). The disk adapter
 *  (`evaluateSprintTaskFinalizationFromDisk`) populates these via
 *  `listOpenBlockingQuestionsForCwd`; pure callers pass them explicitly. */
export interface FinalizationOperatorQuestionRef { id: string; question: string; from: string; scope?: string; }
export interface FinalizationGateInput { mode?: FinalizationMode; requestedStatus: string; target: FinalizationTarget; plan?: WorkflowArchitecturePlan; coderEvidence?: unknown; coderCompletionSource?: DelegateCompletionSource; coderEvidenceSummary?: string; reviewerMemo?: ReviewerMemo; finalNote?: string; finalEvidence?: string; debugChain?: FinalizationGateDebugChain; qualityAuditSummary?: WorkflowQualityAuditFinalizationSummary; openOperatorQuestions?: FinalizationOperatorQuestionRef[]; }
export type FinalizationRecommendedStatus = "done" | "provisional_done" | "prompt_only_mitigation";
export interface FinalizationGateDetails { isFinalStatus: boolean; finalStatusAlias: string; recommendedStatus: FinalizationRecommendedStatus; operatorQuestions: { openBlockingCount: number; questions: FinalizationOperatorQuestionRef[] }; matrix: { planStatus: "missing" | "ready" | "draft" | "active" | "unknown"; isMatrixCoverageOk: boolean; coverageIssues: string[]; promptOnlyCriteria: string[] }; coder: { present: boolean; ok: boolean; rejectionCodes: string[]; missingCriteria: string[]; source: string; evidenceRows: number; history: { autoExitObserved: boolean; processExitObserved: boolean; missingSidecarObserved: boolean; freeFormOnlyObserved: boolean; retries: number; warnings: string[]; failedAttempts: number } }; reviewer: { present: boolean; approved: boolean; missingRequiredRoles: string[]; missingRecommendations: boolean; promptOnlyCaveats: string[] }; debug: { repeatedSameAreaCount: number; priorFailureCount: number; needsEscalation: boolean; rootCauseMentioned: boolean }; qualityAudit: { present: boolean; summary?: string; artifactLink?: string; artifactPath?: string; totalFindings: number; criticalOrHighCount: number; warningOrHighCount: number; byCode: Record<string, number>; bySeverity: Record<WorkflowQualityAuditSeverity, number>; reportGeneratedAt?: string; firstFindingMessages: string[]; taskId?: string; error?: string; } }
export interface FinalizationGateResult { mode: FinalizationMode; ok: boolean; allowed: boolean; strictBlocking: boolean; requestedStatus: string; target: FinalizationTarget; summary: string; codes: string[]; blockers: string[]; warnings: string[]; isFinalStatus: boolean; recommendation: string; recommendedStatus: FinalizationRecommendedStatus; details: FinalizationGateDetails; }
const FULL_FINAL_STATUSES = new Set(["done", "completed", "complete", "closed", "close", "resolved", "resolved-with-root-cause", "resolved_with_root_cause", "finalized", "final"]);
const PROMPT_ONLY_MITIGATION_STATUSES = new Set(["prompt_only_mitigation", "prompt-only-mitigation"]);
const PROVISIONAL_DONE_STATUSES = new Set(["provisional_done", "provisional-done"]);
const FINALIZATION_STATUSES = new Set<string>([...FULL_FINAL_STATUSES, ...PROMPT_ONLY_MITIGATION_STATUSES, ...PROVISIONAL_DONE_STATUSES]);
function trimString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
function normalizeMode(mode: FinalizationMode | undefined): FinalizationMode {
	return mode === "dry-run" ? "dry-run" : "strict";
}
function normalizeStatus(value: unknown): string {
	return trimString(value).toLowerCase();
}
const isFullFinalizationStatus = (value: unknown): boolean => FULL_FINAL_STATUSES.has(normalizeStatus(value));
const isPromptOnlyMitigationStatus = (value: unknown): boolean => PROMPT_ONLY_MITIGATION_STATUSES.has(normalizeStatus(value));
const isProvisionalDoneStatus = (value: unknown): boolean => PROVISIONAL_DONE_STATUSES.has(normalizeStatus(value));
const isFinalizationStatusValue = (value: unknown): boolean => FINALIZATION_STATUSES.has(normalizeStatus(value));
function canonicalDowngradedStatus(value: unknown): FinalizationRecommendedStatus {
	const normalized = normalizeStatus(value);
	return isProvisionalDoneStatus(normalized) ? "provisional_done" : "prompt_only_mitigation";
}
const PROMPT_ONLY_SIGNAL_PHRASES = ["prompt-only", "prompt only", "prompt-only mitigation", "docs-only", "doc-only", "documentation-only", "documentation only", "instructions-only", "instruction-only", "instructions only", "instruction only", "runtime mitigation", "runtime-mitigation", "docs only"];
function toPositiveInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}
function hasPromptOnlyWording(value: unknown): boolean {
	const normalized = normalizeStatus(value);
	if (!normalized) return false;
	for (const phrase of PROMPT_ONLY_SIGNAL_PHRASES) {
		if (normalized.includes(phrase)) return true;
	}
	return false;
}
function hasPromptOnlyInCriterionCoverageRows(rows: CoderCriterionCoverage[] | undefined): boolean {
	return (rows ?? []).some((row) => hasPromptOnlyWording(row.summary) || hasPromptOnlyWording(row.caveats) || hasPromptOnlyWording(row.gaps));
}
function hasPromptOnlyInCoderPacket(evidence: CoderCompletionEvidence | undefined): boolean {
	if (!evidence) return false;
	return (
		hasPromptOnlyWording(evidence.summary)
		|| evidence.caveats.some((caveat) => hasPromptOnlyWording(caveat))
		|| evidence.knownGaps.some((gap) => hasPromptOnlyWording(gap))
		|| hasPromptOnlyInCriterionCoverageRows(evidence.criterionCoverage)
	);
}
// Disclosure must name the issue, not merely brush against it: tokens are
// issue-specific terms only. Generic words ("issue", "risk", "concern",
// bare "sidecar") satisfied every disclosure by accident and turned the
// waiver into a loophole around the provisional-completion block.
const DISCLOSURE_ISSUE_TOKENS: Record<string, string[]> = {
	auto_exit: ["auto exit", "auto_exit", "auto-exit"],
	process_exit: ["process exit", "process_exit", "process-exit"],
	missing_sidecar: ["missing sidecar", "missing a sidecar", "missing done sidecar", "missing_sidecar", "no done sidecar", "sidecar missing"],
	free_form: ["free form", "freeform", "free-form"],
	retries: ["retry", "retries", "retried"],
	warnings: ["warning", "warnings"],
	failed_attempt: ["failed", "failure"],
};
function containsAllDisclosures(text: string, issues: string[]): boolean {
	if (issues.length === 0) return true;
	const normalized = normalizeStatus(text);
	return issues.every((issue) => (DISCLOSURE_ISSUE_TOKENS[issue] ?? []).some((token) => normalized.includes(token)));
}
function historyDisclosureIssues(history: FinalizationGateDetails["coder"]["history"]): string[] {
	const pairs: Array<[string, boolean]> = [
		["auto_exit", history.autoExitObserved],
		["process_exit", history.processExitObserved],
		["missing_sidecar", history.missingSidecarObserved],
		["free_form", history.freeFormOnlyObserved],
		["retries", history.retries > 0],
		["failed_attempt", history.failedAttempts > 0],
	];
	return pairs.filter(([, observed]) => observed).map(([code]) => code);
}
function promptOnlyRows(plan: WorkflowArchitecturePlan | undefined): string[] {
	if (!plan?.acceptanceEvidenceMatrix) return [];
	return plan.acceptanceEvidenceMatrix
		.filter((entry) => entry.enforcementLevel.includes("prompt-only"))
		.map((entry) => entry.criterion);
}
function buildBaseDetails(input: FinalizationGateInput, finalStatus: boolean, requestedStatus: string): FinalizationGateDetails {
	const normalizedStatus = normalizeStatus(requestedStatus);
	const emptySeverityCounts: Record<WorkflowQualityAuditSeverity, number> = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		warning: 0,
		info: 0,
	};
	const openOperatorQuestions = input.openOperatorQuestions ?? [];
	return {
		isFinalStatus: finalStatus,
		finalStatusAlias: normalizedStatus,
		recommendedStatus: isPromptOnlyMitigationStatus(normalizedStatus) || isProvisionalDoneStatus(normalizedStatus)
			? canonicalDowngradedStatus(normalizedStatus)
			: "done",
		operatorQuestions: { openBlockingCount: openOperatorQuestions.length, questions: [...openOperatorQuestions] },
		matrix: { planStatus: "missing", isMatrixCoverageOk: false, coverageIssues: [], promptOnlyCriteria: [] },
		coder: {
			present: false,
			ok: false,
			rejectionCodes: [],
			missingCriteria: [],
			source: "missing",
			evidenceRows: 0,
			history: {
				autoExitObserved: false,
				processExitObserved: false,
				missingSidecarObserved: false,
				freeFormOnlyObserved: false,
				retries: 0,
				warnings: [],
				failedAttempts: 0,
			},
		},
		reviewer: { present: false, approved: false, missingRequiredRoles: [], missingRecommendations: false, promptOnlyCaveats: [] },
		debug: {
			repeatedSameAreaCount: toPositiveInteger(input.debugChain?.repeatedInAreaCount),
			priorFailureCount: toPositiveInteger(input.debugChain?.priorFailureCount),
			needsEscalation: false,
			rootCauseMentioned: false,
		},
		qualityAudit: {
			present: false,
			totalFindings: 0,
			criticalOrHighCount: 0,
			warningOrHighCount: 0,
			byCode: {},
			bySeverity: emptySeverityCounts,
			firstFindingMessages: [],
		},
	};
}
function evaluateSprint(
	input: Omit<FinalizationGateInput, "target"> & { target: FinalizationSprintTarget },
	mode: FinalizationMode,
): FinalizationGateResult {
	const sprintTarget = input.target;
	const requestedStatus = normalizeStatus(input.requestedStatus);
	const isFullFinal = isFullFinalizationStatus(requestedStatus);
	const isDowngradedFinal = isPromptOnlyMitigationStatus(requestedStatus) || isProvisionalDoneStatus(requestedStatus);
	const requestedDowngradedStatus: FinalizationRecommendedStatus = isDowngradedFinal
		? canonicalDowngradedStatus(requestedStatus)
		: "done";
	if (!input.plan) {
		const details = buildBaseDetails(input, true, input.requestedStatus);
		details.matrix.coverageIssues = ["plan_missing"];
		const allow = mode !== "strict";
		return {
			mode,
			ok: allow,
			allowed: allow,
			strictBlocking: true,
			requestedStatus,
			target: input.target,
			summary: mode === "dry-run"
				? `Dry-run would block finalization for ${sprintTarget.taskId}: architecture plan was missing for final-state check.`
				: "Finalization blocked: architecture plan missing for final-state check.",
			codes: ["plan_missing"],
			blockers: ["No architecture plan was provided for this task."],
			warnings: ["Provide planId/taskId context before allowing finalization."],
			isFinalStatus: true,
			recommendation: "blocked",
			recommendedStatus: requestedDowngradedStatus,
			details,
		};
	}
	const plan = input.plan;
	const details = buildBaseDetails(input, true, input.requestedStatus);
	details.matrix.planStatus = (plan.status === "ready" ? "ready" : plan.status === "draft" ? "draft" : plan.status === "active" ? "active" : "unknown");
	const blockers: string[] = [];
	const warnings: string[] = [];
	const codes: string[] = ["sprint_finalization", requestedStatus];
	// WP1: an unanswered blocking operator question is a durable stop signal;
	// finalization must wait for the human answer.
	const openOperatorQuestions = input.openOperatorQuestions ?? [];
	if (openOperatorQuestions.length > 0) {
		const preview = openOperatorQuestions.slice(0, 5).map((q) => `${q.id}${q.scope ? ` [${q.scope}]` : ""}: ${q.question}`).join("; ");
		blockers.push(`Unanswered blocking operator question(s) (${openOperatorQuestions.length}): ${preview}. Record the operator's answer via workflow_answer_question before finalization.`);
		codes.push("operator_question_pending");
	}
	const matrixValidation = validateEvidenceMatrix(plan, { isReadyPlan: true });
	details.matrix.coverageIssues = matrixValidation.issues.map((issue) => issue.code);
	if (plan.status !== "ready") {
		blockers.push("Architecture plan must be ready for finalization.");
		details.matrix.planStatus = plan.status === "draft" ? "draft" : "unknown";
	}
	if (!matrixValidation.ok) {
		details.matrix.isMatrixCoverageOk = false;
		blockers.push("Acceptance evidence matrix is not ready-plan valid or complete.");
		codes.push("matrix_coverage");
	} else {
		details.matrix.isMatrixCoverageOk = true;
	}
	const promptOnlyCriteria = promptOnlyRows(plan);
	details.matrix.promptOnlyCriteria = promptOnlyCriteria;
	const normalized = normalizeCoderCompletionEvidence({
		packet: input.coderEvidence,
		summary: input.coderEvidenceSummary,
		completionSource: input.coderCompletionSource,
	});
	const evidence = normalized.value as CoderCompletionEvidence | undefined;
	details.coder.present = Boolean(evidence);
	details.coder.evidenceRows = evidence?.criterionCoverage.length ?? 0;
	details.coder.source = evidence ? String(input.coderCompletionSource ?? "external") : "missing";
	if (evidence?.delegateHistory) {
		details.coder.history.autoExitObserved = evidence.delegateHistory.autoExitObserved;
		details.coder.history.processExitObserved = evidence.delegateHistory.processExitObserved;
		details.coder.history.missingSidecarObserved = evidence.delegateHistory.missingSidecarObserved;
		details.coder.history.freeFormOnlyObserved = evidence.delegateHistory.freeFormOnlyObserved;
		details.coder.history.retries = evidence.delegateHistory.retries;
		details.coder.history.warnings = [...evidence.delegateHistory.warnings];
		for (const attempt of evidence.delegateHistory.attempts) {
			if (attempt.status === "failed") details.coder.history.failedAttempts += 1;
		}
	}
	const coderPlanShape: CoderEvidencePlanShape = {
		status: plan.status,
		acceptanceCriteria: plan.acceptanceCriteria,
		acceptanceEvidenceMatrix: plan.acceptanceEvidenceMatrix,
	};
	const coderEval = evaluateCoderCompletionEvidence(coderPlanShape, evidence, {
		isMatrixGated: true,
		requireFilesAndCommands: true,
	});
	const noteText = `${trimString(input.finalNote)}\n${trimString(input.finalEvidence)}`;
	const disclosureIssues = historyDisclosureIssues(details.coder.history);
	const historyDisclosureSatisfied = disclosureIssues.length > 0 ? containsAllDisclosures(noteText, disclosureIssues) : true;
	const waivableHistoryCodes = new Set(["auto_exit_incomplete", "process_exit_incomplete", "missing_sidecar_incomplete"]);
	const effectiveCoderRejectionCodes = historyDisclosureSatisfied
		? coderEval.rejectionCodes.filter((code) => !waivableHistoryCodes.has(code))
		: [...coderEval.rejectionCodes];
	details.coder.ok = effectiveCoderRejectionCodes.length === 0;
	details.coder.rejectionCodes = effectiveCoderRejectionCodes;
	details.coder.missingCriteria = coderEval.diagnostics.missingCriteria;
	if (!details.coder.ok) {
		blockers.push("Coder completion evidence does not satisfy finalization requirements.");
		codes.push(...effectiveCoderRejectionCodes);
	}
	if (input.reviewerMemo) {
		details.reviewer.present = true;
		details.reviewer.approved = Boolean(input.reviewerMemo.approved);
		details.reviewer.missingRequiredRoles = [...(input.reviewerMemo.missingRequiredRoles ?? [])];
		details.reviewer.promptOnlyCaveats = (input.reviewerMemo.promptOnlyCaveats ?? []).flatMap((row) => row.promptOnlyCaveats);
		const memoHardBlock =
			!details.reviewer.approved ||
			details.reviewer.missingRequiredRoles.length > 0 ||
			(input.reviewerMemo.changesRequested ?? []).length > 0 ||
			(input.reviewerMemo.unknownOrFailed ?? []).length > 0 ||
			/changes requested|blocked|not approved/i.test(input.reviewerMemo.finalRecommendation ?? "");
		if (memoHardBlock) {
			details.reviewer.missingRecommendations = true;
			blockers.push("Reviewer memo does not cleanly approve the task for done.");
			codes.push("reviewer_blocked");
		}
		if (details.reviewer.promptOnlyCaveats.length > 0) {
			warnings.push("Reviewer memo includes prompt-only caveats.");
			codes.push("prompt_only_caveat");
		}
	} else {
		details.reviewer.present = false;
		blockers.push("Reviewer memo is required for finalization.");
		codes.push("reviewer_memo_missing");
	}
	const hasPromptOnlyEvidenceRows =
		Boolean((evidence?.criterionCoverage ?? []).some((row) => row.evidenceKind === "prompt-only"));
	const memoMarkdownText = input.reviewerMemo
		? input.reviewerMemo.markdown.split(/\r?\n/).filter((line) => !/^\s*#+/.test(line)).join(" ")
		: "";
	const reviewerPromptOnlyTextSignal = input.reviewerMemo
		? hasPromptOnlyWording(input.reviewerMemo.finalRecommendation) || hasPromptOnlyWording(memoMarkdownText)
		: false;
	const hasPromptOnlySignal =
		promptOnlyCriteria.length > 0 ||
		hasPromptOnlyEvidenceRows ||
		hasPromptOnlyInCoderPacket(evidence) ||
		reviewerPromptOnlyTextSignal ||
		details.reviewer.promptOnlyCaveats.length > 0;
	if (hasPromptOnlySignal) {
		warnings.push("Prompt-only evidence/criteria is present; recommend provisional or prompt-only-mitigation completion.");
		codes.push("prompt_only_mitigation");
	}
	if (hasPromptOnlySignal && isFullFinal) {
		blockers.push("Prompt-only caveats detected, so request a downgraded final status such as prompt-only-mitigation or provisional-done.");
		codes.push("prompt_only_full_status");
	}
	if (disclosureIssues.length > 0 && !containsAllDisclosures(noteText, disclosureIssues)) {
		blockers.push("Delegate history requires explicit disclosure of failures/retries/sidecar issues in final note/evidence.");
		codes.push("history_disclosure_missing");
	}
	// Workflow quality audit summary: ALWAYS advisory. The audit surfaces
	// historical/recent workflow risk; it is consumed/linked from
	// `evaluateSprintTaskFinalizationFromDisk` so Brain can cite the
	// artifactLink during finalization, but it must never block
	// otherwise-valid strict finalization on its own.
	if (input.qualityAuditSummary) {
		const audit = input.qualityAuditSummary;
		details.qualityAudit = {
			present: true,
			summary: audit.summary,
			artifactLink: audit.artifactLink,
			artifactPath: audit.artifactPath,
			totalFindings: audit.totalFindings,
			criticalOrHighCount: audit.criticalOrHighCount,
			warningOrHighCount: audit.warningOrHighCount,
			byCode: { ...audit.byCode },
			bySeverity: { ...audit.bySeverity },
			reportGeneratedAt: audit.reportGeneratedAt,
			firstFindingMessages: [...audit.firstFindingMessages],
			taskId: audit.taskId,
		};
		if (audit.totalFindings > 0) {
			warnings.push(`Workflow quality audit surfaced ${audit.totalFindings} finding(s) (${audit.criticalOrHighCount} critical/high); see ${audit.artifactLink} for details.`);
			codes.push("quality_audit_findings");
		} else {
			warnings.push(`Workflow quality audit clean; see ${audit.artifactLink}.`);
			codes.push("quality_audit_clean");
		}
	} else if (sprintTarget.planId || sprintTarget.taskId) {
		// The disk adapter is expected to populate qualityAuditSummary for
		// sprint tasks. If it is missing, surface an advisory signal in
		// details without creating a blocker.
		details.qualityAudit.error = "audit_not_run";
		warnings.push("Workflow quality audit could not run; finalization is allowed but may miss historical workflow risk context.");
		codes.push("quality_audit_unavailable");
	}
	const matrixCoverageText = matrixValidation.ok ? "" : matrixValidation.issues.map((i) => `${i.code}: ${i.message}`).join("; ");
	const hasWarnPromptOnly = warnings.some((w) => w.includes("Prompt-only") || w.includes("prompt-only"));
	const recommendedStatus: FinalizationRecommendedStatus = hasPromptOnlySignal
		? isFullFinal
			? "prompt_only_mitigation"
			: requestedDowngradedStatus
		: requestedDowngradedStatus;
	const summary = blockers.length
		? mode === "dry-run"
			? `Dry-run would block finalization for ${sprintTarget.taskId}: ${blockers.join("; ")}`
			: `Finalization blocked for ${sprintTarget.taskId}: ${blockers.join("; ")}`
		: hasWarnPromptOnly
			? `Finalization checks passed with warnings for ${sprintTarget.taskId}: ${warnings.join("; ")}`
			: `Finalization checks passed for ${sprintTarget.taskId}.`;
	if (matrixCoverageText) {
		details.matrix.coverageIssues.push(matrixCoverageText);
	}
	const wouldBlock = blockers.length > 0;
	const allow = mode === "strict" ? !wouldBlock : true;
	return {
		mode,
		ok: allow,
		allowed: allow,
		strictBlocking: wouldBlock,
		requestedStatus,
		target: input.target,
		summary: matrixCoverageText && summary ? `${summary} ${matrixCoverageText}`.trim() : summary,
		codes: [...new Set(codes)],
		blockers,
		warnings,
		isFinalStatus: true,
		recommendation: wouldBlock ? "blocked" : hasWarnPromptOnly ? "provisional" : "allowed",
		recommendedStatus,
		details,
	};
}
function evaluateDebug(input: FinalizationGateInput, mode: FinalizationMode): FinalizationGateResult {
	const details = buildBaseDetails(input, true, input.requestedStatus);
	const chainCount = details.debug.repeatedSameAreaCount;
	details.debug.needsEscalation = chainCount >= 2;
	const noteText = `${trimString(input.finalNote)} ${trimString(input.finalEvidence)}`;
	details.debug.rootCauseMentioned = /root[-\s]?cause|analysis|investigation|cause\s+analysis/i.test(noteText);
	const blockers: string[] = [];
	const warnings: string[] = [];
	const codes: string[] = ["debug_finalization", normalizeStatus(input.requestedStatus)];
	if (details.debug.needsEscalation) {
		warnings.push(`Repeated debug fixes in same area (${chainCount + 1}). Recommend promotion and explicit root-cause closure.`);
		codes.push("debug_repeated_area");
		if (!details.debug.rootCauseMentioned) {
			warnings.push("Root-cause analysis was not disclosed in final note/evidence.");
			codes.push("debug_no_root_cause");
		}
	}
	if (!details.debug.needsEscalation && details.debug.priorFailureCount > 0) {
		warnings.push("Debug item had prior failures; monitor closure carefully.");
		codes.push("debug_prior_failures");
	}
	const summary = details.debug.needsEscalation
		? `Debug completion warning: repeated same-area hotfixes for ${input.target.kind} ${input.target.kind === "debug-item" ? input.target.itemId : ""}.`
		: "Debug completion checks passed.";
	const allow = true;
	return {
		mode,
		ok: allow,
		allowed: allow,
		strictBlocking: false,
		requestedStatus: normalizeStatus(input.requestedStatus),
		target: input.target,
		summary,
		codes: [...new Set(codes)],
		blockers,
		warnings,
		isFinalStatus: true,
		recommendation: details.debug.needsEscalation ? "provisional" : "allowed",
		recommendedStatus: details.debug.needsEscalation ? "provisional_done" : "done",
		details,
	};
}
function isSprintFinalizationGateInput(
	input: FinalizationGateInput,
): input is Omit<FinalizationGateInput, "target"> & { target: FinalizationSprintTarget } {
	return input.target.kind === "sprint-task";
}
export function evaluateFinalizationGate(input: FinalizationGateInput): FinalizationGateResult {
	const mode = normalizeMode(input.mode);
	const normalizedStatus = normalizeStatus(input.requestedStatus);
	const finalStatus = isFinalizationStatusValue(input.requestedStatus);
	if (!finalStatus) {
		const details = buildBaseDetails(input, false, input.requestedStatus);
		return {
			mode,
			ok: true,
			allowed: true,
			strictBlocking: false,
			requestedStatus: normalizedStatus,
			target: input.target,
			summary: `Finalization gate skipped for non-final status \"${normalizedStatus}\".`,
			codes: ["finalization_noop"],
			blockers: [],
			warnings: [],
			isFinalStatus: false,
			recommendation: "no-op",
			recommendedStatus: "done",
			details,
		};
	}
	if (isSprintFinalizationGateInput(input)) {
		return evaluateSprint(input, mode);
	}
	return evaluateDebug(input, mode);
}
export function isFinalizationStatus(status: unknown): boolean {
	return isFinalizationStatusValue(status);
}
