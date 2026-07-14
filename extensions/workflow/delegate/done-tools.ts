// Workflow delegate runtime — child-only `sub_agent_done` and
// `workflow_delegate_done` completion tools.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// These two tools are *only* registered when `PI_WORKFLOW_DELEGATE_DONE_FILE`
// is set in the child process env (the parent sets it before launching a
// pane delegate). They write the done sidecar JSON file that the pane
// runner is polling and then call `ctx.shutdown()` to terminate the child
// Pi session so the pane can be closed.
//
// `sub_agent_done` is the primary tool; `workflow_delegate_done` is a
// legacy alias kept for backward compatibility with older prompts that
// still reference that name. The alias exposes the SAME canonical-only
// `evidence` envelope schema; it does not preserve legacy top-level
// `coderEvidence` / `reviewerEvidence` compatibility fields.

import * as fs from "node:fs";
import { writeFileAtomicSync } from "../fs-atomic";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DELEGATE_ACTIVITY_ENV_VAR,
	DELEGATE_DONE_ENV_VAR,
	DELEGATE_DONE_TOOL_NAME,
	DELEGATE_RUN_ID_ENV_VAR,
	SUB_AGENT_DONE_TOOL_NAME,
} from "./constants";
import { makeActivityPayload, type ActivityPhase, writeActivitySidecar } from "./pane-status";

const NOISY_ACTIVITY_EVENT_THROTTLE_MS = 1500;
const AGENT_END_AUTO_EXIT_WARNING = "Pane delegate did not call sub_agent_done/workflow_delegate_done; auto-completing on normal agent_end.";
const ABORTING_STOP_REASONS = new Set(["aborted", "interrupted", "cancelled", "canceled", "error"]);

interface DelegateActivityHooksState {
	lastWrite: number;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function toText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function asArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

function asAssistantMessagePayload(value: unknown): unknown | undefined {
	const record = asObject(value);
	if (!record) return undefined;
	const role = toText(record.role);
	if (role && role !== "assistant") return undefined;
	return value;
}

function asAssistantRoleMessagePayload(value: unknown): unknown | undefined {
	const record = asObject(value);
	if (!record) return undefined;
	if (toText(record.role) !== "assistant") return undefined;
	return value;
}

function getStopReasonFromMessage(message: unknown, requireAssistantRole = false): string | undefined {
	const record = asObject(message);
	if (!record) return undefined;
	if (requireAssistantRole) {
		if (toText(record.role) !== "assistant") return undefined;
	} else {
		const role = toText(record.role);
		if (role && role !== "assistant") return undefined;
	}
	return toText(record.stopReason) || toText(record.stop_reason);
}

function getErrorMessageFromMessage(message: unknown, requireAssistantRole = false): string | undefined {
	const record = asObject(message);
	if (!record) return undefined;
	if (requireAssistantRole) {
		if (toText(record.role) !== "assistant") return undefined;
	} else {
		const role = toText(record.role);
		if (role && role !== "assistant") return undefined;
	}
	return toText(record.errorMessage);
}

function getLatestAssistantMessage(messages: unknown[]): unknown | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const record = asObject(messages[i]);
		const role = toText(record?.role);
		if (role === "assistant") return messages[i];
	}
	return undefined;
}

function getLatestAssistantPayload(input: unknown): unknown | undefined {
	const messages = asArray(input);
	if (messages) {
		return getLatestAssistantMessage(messages);
	}

	const value = asObject(input);
	if (!value) return undefined;

	const valueMessages = asArray(value.messages);
	if (valueMessages) {
		return getLatestAssistantMessage(valueMessages);
	}

	return asAssistantMessagePayload(value.assistantMessage) || asAssistantRoleMessagePayload(value.message);
}

/**
 * Find the latest assistant stop reason from an `agent_end` event object or
 * session message list.
 */
export function findLatestAssistantStopReason(input: unknown): string | undefined {
	const messages = asArray(input);
	if (messages) {
		const assistantMessage = getLatestAssistantMessage(messages);
		return getStopReasonFromMessage(assistantMessage);
	}

	const value = asObject(input);
	if (!value) return undefined;

	const directStopReason = toText(value.stopReason) || toText(value.stop_reason);
	if (directStopReason) return directStopReason;

	const valueMessages = asArray(value.messages);
	if (valueMessages) {
		const assistantMessage = getLatestAssistantMessage(valueMessages);
		const stopReason = getStopReasonFromMessage(assistantMessage);
		if (stopReason) return stopReason;
	}

	return getStopReasonFromMessage(value.assistantMessage) || getStopReasonFromMessage(value.message, true);
}

function hasAssistantErrorMessage(input: unknown): boolean {
	const messages = asArray(input);
	if (messages) {
		return Boolean(getErrorMessageFromMessage(getLatestAssistantMessage(messages)));
	}

	const value = asObject(input);
	if (!value) return false;

	if (toText(value.errorMessage)) return true;

	const valueMessages = asArray(value.messages);
	if (valueMessages) {
		if (Boolean(getErrorMessageFromMessage(getLatestAssistantMessage(valueMessages)))) return true;
	}

	return Boolean(getErrorMessageFromMessage(value.assistantMessage) || getErrorMessageFromMessage(value.message, true));
}

function hasLatestAssistantPayload(input: unknown): boolean {
	return Boolean(getLatestAssistantPayload(input));
}

/**
 * Decide if the latest assistant turn appears to be a normal completion.
 */
export function shouldAutoCompleteOnAgentEnd(agentEndPayload: unknown): boolean {
	const directErrorMessage = asObject(agentEndPayload)?.errorMessage;
	if (toText(directErrorMessage)) return false;
	if (!hasLatestAssistantPayload(agentEndPayload)) return false;
	if (hasAssistantErrorMessage(agentEndPayload)) return false;
	const stopReason = findLatestAssistantStopReason(agentEndPayload);
	if (!stopReason) return true;
	return !ABORTING_STOP_REASONS.has(stopReason.toLowerCase());
}

export interface AutoExitDoneWriteOptions {
	summary?: string;
	stopReason?: string;
	warning?: string;
}

/**
 * Write a durable sidecar from child `agent_end` using exclusive create
 * semantics so explicit completion tool writes are never overwritten.
 */
export async function writeAutoExitDoneSidecar(doneFile: string, options: AutoExitDoneWriteOptions = {}): Promise<boolean> {
	const payload = {
		done: true as const,
		completion: "auto_exit" as const,
		source: "agent_end" as const,
		from_auto_exit: true,
		at: new Date().toISOString(),
		summary: options.summary,
		stop_reason: options.stopReason,
		warning: options.warning ?? AGENT_END_AUTO_EXIT_WARNING,
		exit_code: 0,
	};
	try {
		await fs.promises.writeFile(doneFile, JSON.stringify(payload) + "\n", { encoding: "utf8", flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function okTool(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function errTool(text: string, details: Record<string, unknown> = {}) {
	return {
		isError: true,
		content: [{ type: "text" as const, text }],
		details,
	};
}

function registerDelegateActivityHooks(pi: ExtensionAPI): void {
	const activityFile = process.env[DELEGATE_ACTIVITY_ENV_VAR];
	if (!activityFile) return;

	const runId = process.env[DELEGATE_RUN_ID_ENV_VAR] || "";
	const state: DelegateActivityHooksState = { lastWrite: 0 };

	const writeActivity = (eventName: string, phase: ActivityPhase): void => {
		const now = Date.now();
		if (eventName === "message_update" && now - state.lastWrite < NOISY_ACTIVITY_EVENT_THROTTLE_MS) {
			return;
		}
		state.lastWrite = now;
		void writeActivitySidecar(activityFile, makeActivityPayload(runId, phase, eventName, now));
	};

	pi.on("session_start", () => writeActivity("session_start", "starting"));
	pi.on("before_agent_start", () => writeActivity("before_agent_start", "starting"));
	pi.on("agent_start", () => writeActivity("agent_start", "active"));
	pi.on("turn_start", () => writeActivity("turn_start", "active"));
	pi.on("turn_end", () => writeActivity("turn_end", "active"));
	pi.on("before_provider_request", () => writeActivity("before_provider_request", "active"));
	pi.on("after_provider_response", () => writeActivity("after_provider_response", "active"));
	pi.on("message_update", () => writeActivity("message_update", "active"));
	pi.on("tool_execution_start", () => writeActivity("tool_execution_start", "active"));
	pi.on("tool_execution_end", () => writeActivity("tool_execution_end", "active"));
	pi.on("tool_result", () => writeActivity("tool_result", "active"));
	pi.on("session_shutdown", () => writeActivity("session_shutdown", "done"));
}

function registerDelegateAutoExitHook(pi: ExtensionAPI, doneFile: string): void {
	const runId = process.env[DELEGATE_RUN_ID_ENV_VAR] || "";
	pi.on("agent_end", async (_event, ctx) => {
		const rawEvent = _event as any;
		if (!shouldAutoCompleteOnAgentEnd(rawEvent)) {
			return;
		}
		const stopReason = findLatestAssistantStopReason(rawEvent);
		const warning = AGENT_END_AUTO_EXIT_WARNING + (stopReason ? ` (stop_reason=${stopReason})` : "");
		void writeAutoExitDoneSidecar(doneFile, {
			stopReason,
			warning,
		}).then((didWrite) => {
			if (!didWrite) return;
			const activityFile = process.env[DELEGATE_ACTIVITY_ENV_VAR];
			if (activityFile) {
				void writeActivitySidecar(activityFile, makeActivityPayload(runId, "done", "agent_end"));
			}
			if (ctx && typeof ctx.shutdown === "function") {
				setTimeout(() => ctx.shutdown(), 250);
			}
		}).catch(() => {
			// best effort: explicit done sidecar should always win if present
		});
	});
}

function makeDoneToolExecute(toolName: string) {
	return async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) => {
		const doneFile = process.env[DELEGATE_DONE_ENV_VAR];
		if (!doneFile) {
			return errTool("Done file path not set in env.", { reason: "missing_env" });
		}
		const summary = String(params?.summary ?? "").trim();
		// TASK-002 HARD-CUT: the completion tool boundary is canonical-only.
		// The schema exposes only `summary` and `evidence` parameters.
		// Deprecated top-level `coderEvidence` / `reviewerEvidence` params
		// are NO LONGER declared on the tool schema. If a caller passes
		// unknown top-level keys (e.g. older agents), the writer simply
		// ignores them: no normalization, no sidecar write of top-level
		// fields, no diagnostic warning. The canonical `evidence`
		// envelope is the SOLE gate-authoritative input. New runs MUST
		// pass `evidence: { coderEvidence?, reviewerEvidence? }`.
		const rawEvidence = params && typeof params.evidence === "object" && params.evidence !== null
			? (params.evidence as Record<string, unknown>)
			: undefined;
		const canonicalCoder = rawEvidence && "coderEvidence" in rawEvidence && typeof rawEvidence.coderEvidence === "object" && rawEvidence.coderEvidence !== null
			? rawEvidence.coderEvidence
			: undefined;
		const canonicalReviewer = rawEvidence && "reviewerEvidence" in rawEvidence && typeof rawEvidence.reviewerEvidence === "object" && rawEvidence.reviewerEvidence !== null
			? rawEvidence.reviewerEvidence
			: undefined;
		const canonicalWarnings = rawEvidence && Array.isArray(rawEvidence.warnings)
			? (rawEvidence.warnings as unknown[]).filter((w): w is string => typeof w === "string")
			: undefined;
		const runId = process.env[DELEGATE_RUN_ID_ENV_VAR] || "";
		const now = new Date().toISOString();
		try {
			const data: Record<string, unknown> = {
				done: true as const,
				completion: "explicit" as const,
				source: "tool" as const,
				summary: summary || undefined,
				at: now,
				tool: toolName,
				exit_code: 0,
			};
			// Canonical evidence envelope. The envelope is the sole
			// gate-readable path. Top-level `data.coderEvidence` /
			// `data.reviewerEvidence` is NOT written under any condition
			// (TASK-002 hard-cut). The schema does not declare legacy
			// top-level params, and the writer does not surface any
			// legacy diagnostic — the contract is canonical-only.
			const envelope: Record<string, unknown> = {};
			if (canonicalCoder !== undefined) envelope.coderEvidence = canonicalCoder;
			if (canonicalReviewer !== undefined) envelope.reviewerEvidence = canonicalReviewer;
			if (canonicalWarnings && canonicalWarnings.length > 0) envelope.warnings = canonicalWarnings;
			if (Object.keys(envelope).length > 0) {
				data.evidence = envelope;
			}
			// Atomic: the parent polls this file; explicit completion must never
			// be observed half-written.
			writeFileAtomicSync(doneFile, JSON.stringify(data) + "\n");
			const activityFile = process.env[DELEGATE_ACTIVITY_ENV_VAR];
			if (activityFile) {
				void writeActivitySidecar(activityFile, makeActivityPayload(runId, "done", summary || "completed"));
			}
		} catch (error) {
			return errTool(`Failed to write done file: ${error}`, { reason: "write_failed" });
		}
		setTimeout(() => ctx.shutdown(), 500);
		const details: Record<string, unknown> = { doneFile, tool: toolName, completion: "explicit", source: "tool" };
		if (canonicalCoder !== undefined) details.canonicalCoderEvidenceProvided = true;
		if (canonicalReviewer !== undefined) details.canonicalReviewerEvidenceProvided = true;
		return okTool("Delegate completion signaled. Shutting down.", details);
	};
}

// TASK-003 Phase B: optional structured coder completion evidence parameter.
// Kept as a Type.Object (no required keys) so the parent completion-evidence
// validator is the only source of truth for the shape. Tiny / non-matrix
// coder work may omit it.
const coderEvidenceParameters = Type.Optional(Type.Object({
	filesChanged: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files changed during the coder phase." })),
	commandsRun: Type.Optional(Type.Array(Type.Object({
		command: Type.String({ minLength: 1, description: "Command that produced evidence." }),
		outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")], { description: "Command outcome." }),
		summary: Type.Optional(Type.String({ description: "Optional short summary of the command output." })),
		exitCode: Type.Optional(Type.Number({ description: "Optional exit code." })),
	}), { description: "Commands run during the coder phase, with outcomes." })),
	criterionCoverage: Type.Optional(Type.Array(Type.Object({
		criterion: Type.String({ minLength: 1, description: "Exact acceptance-criterion text this row covers." }),
		evidenceKind: Type.String({ minLength: 1, description: "Evidence kind (runnable-check, behavior-test, runtime-gate, etc.)." }),
		strength: Type.String({ minLength: 1, description: "Evidence strength (sufficient, weak, insufficient, skipped, manual-caveat)." }),
		supportingFiles: Type.Optional(Type.Array(Type.String())),
		supportingCommands: Type.Optional(Type.Array(Type.String())),
		summary: Type.String({ minLength: 1, description: "One-sentence description of what the evidence shows." }),
		caveats: Type.Optional(Type.String()),
		gaps: Type.Optional(Type.String()),
	}), { description: "Per-criterion coverage rows mapped to the architecture plan's acceptanceEvidenceMatrix." })),
	knownGaps: Type.Optional(Type.Array(Type.String())),
	caveats: Type.Optional(Type.Array(Type.String())),
	summary: Type.Optional(Type.String()),
	delegateHistory: Type.Optional(Type.Object({}, { description: "Optional structured delegate history (attempts, retries, warnings)." })),
}, { description: "Optional TASK-003 structured coder completion evidence. The parent completion-evidence-gate validates this packet against the architecture plan's matrix; tiny / non-matrix work may omit it." }));

// TASK-002: canonical reviewer-evidence parameter (typed object; the
// parent reviewer-roles gate is the source of truth for the shape).
// Kept as a Type.Object (no required keys) so a single envelope covers
// the matrix-gated case and tiny / non-matrix fallback.
const reviewerEvidenceParameters = Type.Optional(Type.Object({
	role: Type.Optional(Type.String({ description: "Reviewer role id (behavior, evidence-test, implementation, regression, maintainability, docs-config)." })),
	verdict: Type.Optional(Type.Union([Type.Literal("APPROVED"), Type.Literal("CHANGES_REQUESTED"), Type.Literal("UNKNOWN")], { description: "Reviewer verdict token (first word of response)." })),
	effectiveVerdict: Type.Optional(Type.Union([Type.Literal("APPROVED"), Type.Literal("CHANGES_REQUESTED"), Type.Literal("UNKNOWN")], { description: "Effective verdict after role-aware evaluation." })),
	blockingReasons: Type.Optional(Type.Array(Type.String())),
	weakEvidence: Type.Optional(Type.Array(Type.String())),
	promptOnlyCaveats: Type.Optional(Type.Array(Type.String())),
	unresolvedRisks: Type.Optional(Type.Array(Type.String())),
	criterionCoverage: Type.Optional(Type.Array(Type.Object({
		criterion: Type.String({ minLength: 1, description: "Criterion text this reviewer row covers." }),
		evidenceKind: Type.Optional(Type.String({ description: "Evidence kind (behavior-test, runtime-gate, regression-test, ...)." })),
		summary: Type.Optional(Type.String({ description: "Short summary of the reviewer's evidence." })),
	}, { description: "Per-criterion coverage rows (non-empty for typed reviewer evidence)." }))),
	commandsRun: Type.Optional(Type.Array(Type.Object({
		command: Type.String({ minLength: 1, description: "Command that produced reviewer evidence." }),
		outcome: Type.Optional(Type.String({ description: "Command outcome." })),
		summary: Type.Optional(Type.String()),
	}, { description: "Commands run by the reviewer to produce evidence (non-empty for typed reviewer evidence)." }))),
	finalOutput: Type.Optional(Type.String({ description: "Optional final output preview." })),
	explicitDeclaration: Type.Optional(Type.Boolean({ description: "Optional explicit declaration flag (NOT sufficient on its own)." })),
}, { description: "Optional TASK-002 structured reviewer completion evidence. The parent reviewer-roles gate validates the packet; bare { present: true } / { explicitDeclaration: true } objects are NOT sufficient." }));

// TASK-002 HARD-CUT: canonical evidence envelope parameter. New coder /
// reviewer runs MUST pass `evidence: { coderEvidence?, reviewerEvidence? }`.
// Deprecated top-level `coderEvidence` / `reviewerEvidence` parameters
// have been DELETED from the strict delegate completion schema. The
// canonical `evidence` envelope is the SOLE gate-authoritative input.
const evidenceEnvelopeParameters = Type.Optional(Type.Object({
	coderEvidence: coderEvidenceParameters,
	reviewerEvidence: reviewerEvidenceParameters,
	warnings: Type.Optional(Type.Array(Type.String({ description: "Optional structured warning strings." }))),
	event: Type.Optional(Type.Object({}, { description: "Optional canonical EvidenceEvent-shaped payload (kind/provenance/payload)." })),
}, { description: "Required TASK-002 canonical done.evidence envelope. New runs MUST write `evidence.coderEvidence` and / or `evidence.reviewerEvidence` here; deprecated top-level `coderEvidence` / `reviewerEvidence` parameters have been removed from the strict delegate completion schema and are not accepted." }));

export function registerDelegateDoneTools(pi: ExtensionAPI): void {
	// Child-only completion tools for pane delegates. Only registered when the
	// env var is set (parent sets it before launching a pane delegate).
	const doneFile = process.env[DELEGATE_DONE_ENV_VAR];
	if (!doneFile) return;

	registerDelegateActivityHooks(pi);
	registerDelegateAutoExitHook(pi, doneFile);

	pi.registerTool({
		name: SUB_AGENT_DONE_TOOL_NAME,
		label: "Sub-Agent Done",
		description: `Signal that the delegated task is complete. Only available in pane-delegate child sessions. Writes the done sidecar and shuts down the session.`,
		promptSnippet: "Signal task completion and shut down.",
		promptGuidelines: [
			"Call this as your final action after producing your normal concise handoff to return control to Brain.",
			"For matrix-gated architecture-plan work, also pass an `evidence` envelope (see below) that maps your changed files and validation commands to the plan's acceptance criteria.",
			"Use `evidence.coderEvidence` for coder runs and `evidence.reviewerEvidence` for reviewer runs. The canonical `evidence` envelope is the SOLE gate-authoritative input — do not rely on final assistant text, Markdown, or free-form English / non-English approval phrases.",
			"TASK-002 HARD-CUT: deprecated top-level `coderEvidence` / `reviewerEvidence` parameters have been REMOVED from the strict delegate completion schema. New runs MUST pass the `evidence` envelope directly. Unknown top-level params are ignored.",
			"This tool writes the done sidecar and terminates the session.",
		],
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "Optional one-line completion summary" })),
			evidence: evidenceEnvelopeParameters,
		}),
		execute: makeDoneToolExecute(SUB_AGENT_DONE_TOOL_NAME),
	});
	pi.registerTool({
		name: DELEGATE_DONE_TOOL_NAME,
		label: "Delegate Done (alias)",
		description: `Alias for ${SUB_AGENT_DONE_TOOL_NAME}. Use ${SUB_AGENT_DONE_TOOL_NAME} instead.`,
		promptSnippet: "Signal task completion and shut down.",
		promptGuidelines: [
			`Prefer ${SUB_AGENT_DONE_TOOL_NAME}. This alias exposes the same canonical-only contract — only the \`evidence\` envelope is gate-authoritative; deprecated top-level \`coderEvidence\` / \`reviewerEvidence\` params are not part of the strict delegate completion schema.`,
		],
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "Optional one-line completion summary" })),
			evidence: evidenceEnvelopeParameters,
		}),
		execute: makeDoneToolExecute(DELEGATE_DONE_TOOL_NAME),
	});
}
