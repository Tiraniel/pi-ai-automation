#!/usr/bin/env node
// TASK-011 Phase A — deterministic AFK ship delivery/blocker report renderer.
// Pure: takes a ShipState and returns a markdown string. Never touches fs.

import * as path from "node:path";

import type { ShipState } from "./ship-state";

export interface ShipReportOptions {
	workspaceName?: string;
}

function relativeReportPath(state: ShipState, cwd?: string): string {
	const stored = state.finalReportPath;
	if (stored && !path.isAbsolute(stored)) return stored;
	if (stored && path.isAbsolute(stored) && cwd) return path.relative(cwd, stored);
	return stored ?? "";
}

function renderReviewerOutcome(state: ShipState): string {
	const outcome = state.reviewerOutcome;
	if (!outcome) {
		if (state.lane === "hotfix" && state.hotfixKind === "text-evidence-only") {
			return "Reviewer outcome: not applicable (text-evidence-only path).";
		}
		if (state.lane === "debug") {
			return "Reviewer outcome: not applicable (debug lane is diagnostic-first).";
		}
		return "Reviewer outcome: not recorded yet.";
	}
	switch (outcome.kind) {
		case "not-required":
			return "Reviewer outcome: not required for this lane.";
		case "approved":
			return `Reviewer outcome: approved at ${outcome.at}${outcome.notes ? ` (${outcome.notes})` : ""}.`;
		case "changes-requested":
			return `Reviewer outcome: changes-requested at ${outcome.at}${outcome.notes ? ` (${outcome.notes})` : ""}${outcome.broaderRisk ? " [broader-risk flag]" : ""}.`;
	}
}

function renderChangedFiles(state: ShipState): string {
	if (state.changedFiles.length === 0) return "- (no changed files recorded yet)";
	return state.changedFiles.map((file) => `- ${file}`).join("\n");
}

function renderAffectedFiles(state: ShipState): string {
	if (state.affectedFiles.length === 0) return "- (no affected files recorded yet)";
	return state.affectedFiles.map((file) => `- ${file}`).join("\n");
}

function renderChecks(state: ShipState): string {
	if (state.checks.length === 0) return "- (no checks recorded yet)";
	return state.checks
		.map((check) => `- [${check.outcome.toUpperCase()}] ${check.command}${check.summary ? ` — ${check.summary}` : ""}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""}`)
		.join("\n");
}

function renderEvidenceRefs(state: ShipState): string {
	if (state.evidenceRefs.length === 0) return "- (no evidence refs recorded yet)";
	return state.evidenceRefs.map((ref) => `- ${ref}`).join("\n");
}

function renderBlockers(state: ShipState): string {
	if (state.blockers.length === 0) return "- (none)";
	return state.blockers.map((blocker) => `- ${blocker}`).join("\n");
}

function renderPermissions(state: ShipState): string {
	const entries = Object.entries(state.permissions) as Array<[keyof ShipState["permissions"], boolean]>;
	return entries
		.map(([action, allowed]) => `- ${action}: ${allowed ? "allowed" : "denied (default)"}`)
		.join("\n");
}

function renderPromotionReasonCodes(state: ShipState): string {
	if (state.promotionReasonCodes.length === 0) return "- (none recorded)";
	return state.promotionReasonCodes.map((code) => `- ${code}`).join("\n");
}

function renderResidualRisks(state: ShipState): string {
	const lines: string[] = [];
	if (state.lane === "hotfix" && state.reviewerRequired && state.reviewerOutcome?.kind !== "approved") {
		lines.push("- Hotfix (code-changing or reviewer-required) did not record an approved reviewer outcome; consider re-review before delivery.");
	}
	if (state.lane === "debug" && !state.selectedNextLane) {
		lines.push("- Debug lane did not select/promote a next lane; remaining work is report-only.");
	}
	if (state.lane === "debug" && state.selectedNextLane === "no-code/report-only") {
		lines.push("- Debug lane explicitly chose no-code/report-only; this report is the deliverable.");
	}
	if (state.finalizationStatus === "blocked") {
		lines.push("- Finalization status: blocked — see blockers/finalization sections.");
	}
	if (state.lastStopCondition) {
		lines.push(`- Last stop condition: ${state.lastStopCondition}.`);
	}
	if (state.blockers.length > 0) {
		lines.push(...state.blockers.map((b) => `- Residual: ${b}`));
	}
	if (lines.length === 0) return "- (no residual risks recorded)";
	return lines.join("\n");
}

function renderOpenOperatorQuestions(state: ShipState): string {
	const open = state.openOperatorQuestions ?? [];
	if (open.length === 0) return "- (none)";
	return open
		.map((q) => `- [OPEN blocking] ${q.id} (from ${q.from}): ${q.question} — answer via workflow_answer_question`)
		.join("\n");
}

function renderFinalStatus(state: ShipState): string {
	if (state.stage === "delivery_complete" && state.reviewerOutcome?.kind !== "changes-requested" && state.blockers.length === 0) {
		return "Final status: DELIVERY COMPLETE";
	}
	if (state.stage === "blocked") {
		if (state.lastStopCondition === "report-only-stop") {
			return "Final status: REPORT-ONLY (debug diagnosis delivered; no implementation was authorized)";
		}
		return "Final status: BLOCKED — see blockers/residual risks";
	}
	return `Final status: in-progress (stage=${state.stage})`;
}

export function renderShipReport(state: ShipState, options: ShipReportOptions = {}): string {
	const workspace = options.workspaceName ?? "(workspace)";
	const lines: string[] = [];
	lines.push("# AFK Ship Supervisor Report");
	lines.push(`Workspace: ${workspace}`);
	lines.push(`Run id: ${state.runId}`);
	lines.push(`Generated: ${state.updatedAt}`);
	lines.push("");
	lines.push("## Lane and scope");
	lines.push(`- Lane: ${state.lane}${state.hotfixKind ? ` (hotfixKind=${state.hotfixKind})` : ""}`);
	lines.push(`- Reviewer required: ${state.reviewerRequired ? "yes" : "no"}`);
	lines.push(`- Task id: ${state.taskId ?? "(none)"}${state.itemId ? ` | Debug item id: ${state.itemId}` : ""}`);
	lines.push(`- Stage: ${state.stage}`);
	lines.push(`- Attempts: ${state.attempts} / ${state.retryBudget}`);
	lines.push(`- Cost spent (USD): ${(state.costUsdSpent ?? 0).toFixed(2)}${state.loopBudget?.maxCostUsd !== undefined ? ` / max ${state.loopBudget.maxCostUsd.toFixed(2)}` : ""}${state.loopBudget?.maxWallClockMs !== undefined ? ` | wall-clock cap ${state.loopBudget.maxWallClockMs}ms` : ""}`);
	lines.push(`- Next action: ${state.nextAction ?? "(unset)"}`);
	lines.push(`- Last stop condition: ${state.lastStopCondition ?? "(none)"}`);
	lines.push(`- Allowed scope: ${state.allowedScope ?? "(not set)"}`);
	if (state.lane === "debug") {
		lines.push("");
		lines.push("## Debug diagnosis");
		lines.push(`- Diagnosis: ${state.diagnosis ?? "(none recorded)"}`);
		lines.push(`- Root-cause hypothesis: ${state.rootCauseHypothesis ?? "(none recorded)"}`);
		lines.push(`- Recommended next lane: ${state.recommendedNextLane ?? "(unset)"}`);
		lines.push(`- Selected next lane: ${state.selectedNextLane ?? "(not selected)"}`);
		lines.push(`- Risk assessment: ${state.riskAssessment ?? "(none recorded)"}`);
		lines.push("");
		lines.push("## Affected files");
		lines.push(renderAffectedFiles(state));
	}
	lines.push("");
	lines.push("## Changed files");
	lines.push(renderChangedFiles(state));
	lines.push("");
	lines.push("## Evidence refs");
	lines.push(renderEvidenceRefs(state));
	lines.push("");
	lines.push("## Checks");
	lines.push(renderChecks(state));
	lines.push("");
	lines.push("## Reviewer outcome");
	lines.push(renderReviewerOutcome(state));
	lines.push("");
	lines.push("## Finalization + workflow quality audit");
	lines.push(`- Finalization status: ${state.finalizationStatus}`);
	lines.push(`- Finalization summary: ${state.finalizationSummary ?? "(missing)"}`);
	lines.push(`- Finalization result: ${state.finalizationResult ?? "(missing)"}`);
	lines.push(`- Quality-audit summary: ${state.qualityAuditSummary ?? "(missing)"}`);
	lines.push(`- Quality-audit artifact: ${state.qualityAuditArtifact ?? "(missing)"}`);
	lines.push("");
	lines.push("## Promotion / reason codes");
	lines.push(renderPromotionReasonCodes(state));
	lines.push("");
	lines.push("## Open operator questions");
	lines.push(renderOpenOperatorQuestions(state));
	lines.push("");
	lines.push("## Blockers");
	lines.push(renderBlockers(state));
	lines.push("");
	lines.push("## Residual risks");
	lines.push(renderResidualRisks(state));
	lines.push("");
	lines.push("## Permissions / remote actions");
	lines.push(renderPermissions(state));
	lines.push("");
	lines.push("## Final status");
	lines.push(renderFinalStatus(state));
	lines.push("");
	lines.push("## Final report path");
	lines.push(relativeReportPath(state) || "(not persisted yet)");
	lines.push("");
	return lines.join("\n");
}
