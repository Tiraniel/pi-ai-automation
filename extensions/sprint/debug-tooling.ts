#!/usr/bin/env node
// Sprint subsystem — debug lane tooling helpers for `sprint_debug` responses.

import { completeDebugItem, evaluateDebugLaneEscalationFromDisk } from "./debug";
import { evaluateDebugFinalization } from "../workflow/finalization-runtime";

export interface SprintDebugDoneParams {
	itemId: string;
	area?: unknown;
	filesChanged?: unknown;
	locChanged?: unknown;
	behaviorPaths?: unknown;
	stateMachineOrArchitectureChange?: unknown;
	reviewerBehaviorEvidenceMissing?: unknown;
	evidence?: unknown;
	note?: unknown;
	finalizationGateMode?: "strict" | "dry-run";
}

interface DebugToolText {
	type: "text";
	text: string;
}

export interface SprintDebugToolResult {
	isError?: boolean;
	content: DebugToolText[];
}

export interface EvaluateDebugEscalationInput extends SprintDebugDoneParams {}

export function evaluateDebugEscalationForSprintDebug(cwd: string, itemId: string, input: EvaluateDebugEscalationInput) {
	return evaluateDebugLaneEscalationFromDisk(cwd, {
		itemId,
		area: String(input.area || "").trim() || undefined,
		filesChanged: input.filesChanged,
		locChanged: input.locChanged,
		behaviorPaths: input.behaviorPaths,
		stateMachineOrArchitectureChange: input.stateMachineOrArchitectureChange,
		reviewerBehaviorEvidenceMissing: input.reviewerBehaviorEvidenceMissing,
		evidenceText: input.evidence ? String(input.evidence) : undefined,
	});
}

export function runSprintDebugDone(params: SprintDebugDoneParams & { cwd: string }): SprintDebugToolResult {
	const escalation = evaluateDebugEscalationForSprintDebug(params.cwd, params.itemId, params);

	const mode = params.finalizationGateMode === "dry-run" ? "dry-run" : "strict";
	const finalization = evaluateDebugFinalization({
		itemId: params.itemId,
		requestedStatus: "done",
		mode,
		finalNote: params.note ? String(params.note) : undefined,
		finalEvidence: params.evidence ? String(params.evidence) : undefined,
		debugChain: { repeatedInAreaCount: escalation.repeatedSameAreaFixCount },
	});
	if (escalation.needsEscalation && mode === "strict") {
		return {
			isError: true,
			content: [
				{ type: "text", text: `Debug completion blocked for ${params.itemId}: escalation requires ${escalation.suggestedAction}.` },
				{ type: "text", text: `Recommended action: ${escalation.suggestedAction}.` },
				{ type: "text", text: `Rule codes: ${escalation.ruleCodes.join("; ")}` },
				{ type: "text", text: `Summary: ${escalation.summary}` },
				{ type: "text", text: escalation.needsRootCauseTask
					? "Repeated same-area chain detected; promote to a normal task with root-cause stabilization now to avoid repeated hidden refactors in debug lane."
					: "Promote to a normal sprint task to continue with explicit scope controls and full lifecycle tracking." },
				...(finalization.blockers.length ? [{ type: "text", text: `Blockers: ${finalization.blockers.join("; ")}` }] : []),
				...(finalization.warnings.length ? [{ type: "text", text: `Warnings: ${finalization.warnings.join("; ")}` }] : []),
				{ type: "text", text: JSON.stringify({ escalation, finalizationGate: finalization }) },
			],
		};
	}
	const evidence = params.evidence ? String(params.evidence) : undefined;
	const updated = completeDebugItem(params.cwd, params.itemId, evidence);
	const statusLine = finalization.allowed
		? `Finalization gate allowed as ${finalization.recommendedStatus || "done"}.`
		: `Finalization gate allowed as advisory only in ${mode === "dry-run" ? "dry-run" : "strict"} mode.`;
	return {
		content: [
			{ type: "text", text: `Completed ${updated.id}` },
			{ type: "text", text: statusLine },
			...(escalation.needsEscalation
				? [{ type: "text", text: `Escalation warnings present but non-blocking in ${mode}: ${escalation.ruleCodes.join("; ")}` }]
				: []),
			...(finalization.blockers.length ? [{ type: "text", text: `Blockers: ${finalization.blockers.join("; ")}` }] : []),
			...(finalization.warnings.length ? [{ type: "text", text: `Warnings: ${finalization.warnings.join("; ")}` }] : []),
			{ type: "text", text: JSON.stringify({ item: updated, finalizationGate: finalization, escalation }) },
		],
	};
}
