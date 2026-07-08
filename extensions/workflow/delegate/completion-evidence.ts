// TASK-003 Phase A — pure coder completion evidence contract + validator.
// Phase B (not this file) wires this into tools.ts / done sidecars / prompts.
import type { DelegateCompletionSource } from "../types";
import type { AcceptanceEvidenceMatrixEntry, RequiredEvidenceKind } from "../architecture/types";

// ---------- Evidence kind taxonomy ----------
/** Kind of evidence a coder row provides. Weak kinds (prompt-only /
 *  static-only / source-string / skipped) cannot satisfy runnable matrix
 *  requirements. */
export type CoderEvidenceKind =
	| "runnable-check" | "behavior-test" | "runtime-gate" | "regression-test" | "unit-test"
	| "static-check" | "diff" | "artifact" | "reviewer-approval" | "manual-validation"
	| "prompt-only" | "static-only" | "source-string" | "skipped";
/** Strength of one criterionCoverage row. Only sufficient / manual-caveat
 *  can satisfy a matrix row; weak / insufficient / skipped are issues. */
export type CoderEvidenceStrength =
	| "sufficient" | "weak" | "insufficient" | "skipped" | "manual-caveat";
export type CommandOutcome = "passed" | "failed" | "skipped";
export interface CoderCommandRun {
	command: string; outcome: CommandOutcome; summary?: string; exitCode?: number;
}
export interface CoderCriterionCoverage {
	criterion: string; evidenceKind: CoderEvidenceKind; strength: CoderEvidenceStrength;
	supportingFiles: string[]; supportingCommands: string[]; summary: string;
	caveats?: string; gaps?: string;
}
export interface CoderDelegateAttempt {
	attempt: number; completionSource: DelegateCompletionSource;
	status: "completed" | "failed" | "aborted";
	finalOutputPreview?: string; warning?: string; at?: string;
}
export interface CoderDelegateHistory {
	attempts: CoderDelegateAttempt[]; warnings: string[]; retries: number;
	autoExitObserved: boolean; processExitObserved: boolean;
	missingSidecarObserved: boolean; freeFormOnlyObserved: boolean;
}
export interface CoderCompletionEvidence {
	filesChanged: string[]; commandsRun: CoderCommandRun[];
	criterionCoverage: CoderCriterionCoverage[]; knownGaps: string[];
	caveats: string[]; summary?: string; delegateHistory: CoderDelegateHistory;
}

// ---------- Validator result codes ----------
export type CoderEvidenceRejectionCode =
	| "evidence_packet_missing" | "evidence_packet_unreadable"
	| "matrix_not_gated" | "matrix_unreadable"
	| "missing_criterion" | "duplicate_coverage"
	| "weak_evidence" | "insufficient_evidence"
	| "static_only_behavior_criterion" | "prompt_only_runtime_criterion"
	| "failed_command_unsupported" | "skipped_command_unsupported"
	| "free_form_only"
	| "auto_exit_incomplete" | "process_exit_incomplete" | "missing_sidecar_incomplete"
	| "lightweight_bypass_refused"
	| "missing_files_changed" | "missing_commands_run"
	// WP2 (G7/G9) verification codes:
	| "evidence_diff_mismatch" | "diff_unverifiable"
	| "evidence_rerun_failed" | "evidence_rerun_unverifiable";

// ---------- WP2 verification observations (produced by
// delegate/evidence-verification.ts, folded into issues here) ----------

/** Observed workspace diff across the delegate run, pre-normalized to
 *  delegate-cwd-relative posix paths so it compares 1:1 with
 *  `coderEvidence.filesChanged`. */
export interface ObservedDiffCheck {
	verifiable: boolean;
	reason?: string;
	changedFiles: string[];
}

/** Result of the gate re-running one claimed-passed evidence command. */
export interface EvidenceCommandRerunOutcome {
	command: string;
	/** null = killed before an exit code was produced (e.g. timeout). */
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	outputPreview?: string;
	spawnError?: string;
}

/** A runnable-supporting command the gate decided not to re-run.
 *  `not_allowlisted` is fail-closed (error); `command_cap` is a bounded-
 *  budget skip (warning). */
export interface EvidenceRerunSkip {
	command: string;
	reason: "not_allowlisted" | "command_cap";
}
export type CoderEvidenceSeverity = "error" | "warning";
export interface CoderEvidenceIssue {
	code: CoderEvidenceRejectionCode; message: string;
	criterion?: string; severity: CoderEvidenceSeverity;
}
export interface CoderEvidenceEvaluation {
	ok: boolean; isMatrixGated: boolean; lightweight: boolean;
	issues: CoderEvidenceIssue[]; rejectionCodes: CoderEvidenceRejectionCode[];
	diagnostics: {
		delegateHistory: CoderDelegateHistory; coverageRows: number;
		missingCriteria: string[]; weakCriteria: string[];
		commandOutcomes: Record<CommandOutcome, number>;
		sourcePrecedence:
			| "explicit-structured" | "headless-structured" | "pane-structured"
			| "free-form-only" | "none";
		/** WP2 G7: present when an observed diff was supplied. */
		diffCheck?: {
			verifiable: boolean;
			undeclaredChangedFiles: string[];
			declaredUnchangedFiles: string[];
		};
		/** WP2 G9: present when the gate re-ran evidence commands. */
		commandReruns?: EvidenceCommandRerunOutcome[];
		rerunSkipped?: EvidenceRerunSkip[];
	};
	reason?: string;
}

// ---------- Constants ----------
/** Matrix `requiredEvidence.kind`s that demand runnable proof. Exported for
 *  the WP2 re-run selector (delegate/evidence-verification.ts) — one owner. */
export const RUNNABLE_REQUIRED_KINDS: ReadonlySet<RequiredEvidenceKind> = new Set<RequiredEvidenceKind>([
	"behavior-test", "runtime-gate-test", "regression-test", "unit-test",
]);
const REVIEW_OR_MANUAL_KINDS: ReadonlySet<RequiredEvidenceKind> = new Set<RequiredEvidenceKind>([
	"reviewer-approval", "manual-validation",
]);
const RUNNABLE_CODER_KINDS: ReadonlySet<CoderEvidenceKind> = new Set<CoderEvidenceKind>([
	"runnable-check", "behavior-test", "runtime-gate", "regression-test", "unit-test",
]);
const WEAK_CODER_KINDS: ReadonlySet<CoderEvidenceKind> = new Set<CoderEvidenceKind>([
	"prompt-only", "static-only", "source-string",
]);
const STRENGTH_RANK: Record<CoderEvidenceStrength, number> = {
	sufficient: 4, "manual-caveat": 3, weak: 2, insufficient: 1, skipped: 0,
};
const EVIDENCE_KINDS = new Set<string>([
	"runnable-check", "behavior-test", "runtime-gate", "regression-test", "unit-test",
	"static-check", "diff", "artifact", "reviewer-approval", "manual-validation",
	"prompt-only", "static-only", "source-string", "skipped",
]);
const DELEGATE_STATUSES = new Set<string>(["completed", "failed", "aborted"]);
const COMPLETION_SOURCES = new Set<string>(["explicit", "auto_exit", "process_exit", "missing", "legacy"]);
const COMMAND_OUTCOMES = new Set<string>(["passed", "failed", "skipped"]);
const STRENGTHS = new Set<string>(["sufficient", "weak", "insufficient", "skipped", "manual-caveat"]);
const FLAG_KEYS = ["autoExitObserved", "processExitObserved", "missingSidecarObserved", "freeFormOnlyObserved"] as const;

// ---------- Helpers ----------
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function trimString(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function asStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const item of v) { const t = trimString(item); if (t) out.push(t); }
	return out;
}
function pickOne<T extends string>(v: unknown, allowed: ReadonlySet<string>): T | undefined {
	return typeof v === "string" && allowed.has(v) ? (v as T) : undefined;
}
function pushIssue(
	issues: CoderEvidenceIssue[], code: CoderEvidenceRejectionCode, message: string,
	severity: CoderEvidenceSeverity = "warning", criterion?: string,
): void {
	issues.push(criterion ? { code, message, severity, criterion } : { code, message, severity });
}
function freshHistory(): CoderDelegateHistory {
	return { attempts: [], warnings: [], retries: 0, autoExitObserved: false, processExitObserved: false, missingSidecarObserved: false, freeFormOnlyObserved: false };
}
function cloneHistory(h: CoderDelegateHistory): CoderDelegateHistory {
	return { attempts: h.attempts.slice(), warnings: h.warnings.slice(), retries: h.retries, autoExitObserved: h.autoExitObserved, processExitObserved: h.processExitObserved, missingSidecarObserved: h.missingSidecarObserved, freeFormOnlyObserved: h.freeFormOnlyObserved };
}

// ---------- Normalizer ----------
export interface NormalizeCoderEvidenceInput {
	packet: unknown; delegateHistory?: Partial<CoderDelegateHistory>;
	completionSource?: DelegateCompletionSource; finalOutput?: string; summary?: string;
}
export interface NormalizeCoderEvidenceResult {
	value: CoderCompletionEvidence | undefined; issues: CoderEvidenceIssue[];
}

function buildHistory(
	packetHistory: unknown, override: Partial<CoderDelegateHistory> | undefined,
	completionSource: DelegateCompletionSource | undefined, finalOutput: string | undefined,
): CoderDelegateHistory {
	const out = freshHistory();
	const mergeFlags = (src: { [k: string]: unknown } | undefined, maxRetries: boolean): void => {
		if (!src) return;
		for (const k of FLAG_KEYS) if (src[k] === true) out[k] = true;
		if (typeof src.retries === "number" && Number.isFinite(src.retries) && src.retries >= 0) {
			const n = Math.floor(src.retries);
			out.retries = maxRetries ? Math.max(out.retries, n) : n;
		}
	};
	if (isPlainObject(packetHistory)) {
		const attempts = Array.isArray(packetHistory.attempts) ? packetHistory.attempts : [];
		for (let i = 0; i < attempts.length; i += 1) {
			const item = attempts[i];
			if (!isPlainObject(item)) continue;
			const source = pickOne<DelegateCompletionSource>(item.completionSource, COMPLETION_SOURCES);
			const status = pickOne<"completed" | "failed" | "aborted">(item.status, DELEGATE_STATUSES);
			if (!source || !status) continue;
			const attempt: CoderDelegateAttempt = {
				attempt: typeof item.attempt === "number" && Number.isFinite(item.attempt) ? item.attempt : i + 1,
				completionSource: source, status,
			};
			const preview = trimString(item.finalOutputPreview ?? item.preview);
			if (preview) attempt.finalOutputPreview = preview;
			const warning = trimString(item.warning);
			if (warning) attempt.warning = warning;
			const at = trimString(item.at);
			if (at) attempt.at = at;
			out.attempts.push(attempt);
		}
		out.warnings.push(...asStringArray(packetHistory.warnings));
		mergeFlags(packetHistory, false);
	}
	if (override) {
		// Preserve packet warnings: an override is additive (e.g. a
		// result-level completionWarning), not a replacement. The Brain
		// pre-review summary needs to see both the agent's structured
		// warnings AND the runner's completionWarning, so we append
		// the override warnings to the packet warnings instead of
		// overwriting them.
		if (override.attempts?.length) out.attempts = override.attempts.slice();
		if (override.warnings?.length) out.warnings.push(...override.warnings);
		mergeFlags(override, true);
	}
	if (completionSource === "auto_exit") out.autoExitObserved = true;
	else if (completionSource === "process_exit") out.processExitObserved = true;
	else if (completionSource === "missing") out.missingSidecarObserved = true;
	else if (completionSource === "legacy") out.freeFormOnlyObserved = true;
	if (completionSource && completionSource !== "explicit") {
		const preview = typeof finalOutput === "string" && finalOutput.trim() ? finalOutput.slice(0, 1000) : undefined;
		out.attempts.push({
			attempt: out.attempts.length + 1, completionSource,
			status: completionSource === "auto_exit" ? "completed" : "failed",
			...(preview ? { finalOutputPreview: preview } : {}),
		});
		if (preview) out.freeFormOnlyObserved = true;
	}
	return out;
}

export function normalizeCoderCompletionEvidence(input: NormalizeCoderEvidenceInput): NormalizeCoderEvidenceResult {
	const issues: CoderEvidenceIssue[] = [];
	if (input.packet === undefined || input.packet === null) {
		pushIssue(issues, "evidence_packet_missing", "No coder completion evidence packet was provided.", "error");
		return {
			value: { filesChanged: [], commandsRun: [], criterionCoverage: [], knownGaps: [], caveats: [], summary: input.summary, delegateHistory: buildHistory(undefined, input.delegateHistory, input.completionSource, input.finalOutput) },
			issues,
		};
	}
	if (!isPlainObject(input.packet)) {
		pushIssue(issues, "evidence_packet_unreadable", "Coder completion evidence packet must be an object.", "error");
		return { value: undefined, issues };
	}
	const filesChanged = asStringArray(input.packet.filesChanged);
	const summary = trimString(input.packet.summary) || input.summary;
	const commandsRun: CoderCommandRun[] = [];
	const commandsRaw = Array.isArray(input.packet.commandsRun) ? input.packet.commandsRun : [];
	for (let i = 0; i < commandsRaw.length; i += 1) {
		const item = commandsRaw[i];
		if (!isPlainObject(item)) { pushIssue(issues, "evidence_packet_unreadable", `commandsRun[${i}] must be an object.`, "warning"); continue; }
		const command = trimString(item.command);
		if (!command) { pushIssue(issues, "evidence_packet_unreadable", `commandsRun[${i}].command is required.`, "warning"); continue; }
		const outcome = pickOne<CommandOutcome>(item.outcome ?? item.result, COMMAND_OUTCOMES);
		if (!outcome) { pushIssue(issues, "evidence_packet_unreadable", `commandsRun[${i}].outcome must be "passed" | "failed" | "skipped".`, "warning"); continue; }
		const run: CoderCommandRun = { command, outcome };
		const itemSummary = trimString(item.summary);
		if (itemSummary) run.summary = itemSummary;
		if (typeof item.exitCode === "number" && Number.isFinite(item.exitCode)) run.exitCode = item.exitCode;
		commandsRun.push(run);
	}
	const criterionCoverage: CoderCriterionCoverage[] = [];
	const coverageRaw = Array.isArray(input.packet.criterionCoverage) ? input.packet.criterionCoverage : [];
	for (let i = 0; i < coverageRaw.length; i += 1) {
		const item = coverageRaw[i];
		if (!isPlainObject(item)) { pushIssue(issues, "evidence_packet_unreadable", `criterionCoverage[${i}] must be an object.`, "warning"); continue; }
		const criterion = trimString(item.criterion);
		if (!criterion) { pushIssue(issues, "evidence_packet_unreadable", `criterionCoverage[${i}].criterion is required.`, "warning"); continue; }
		const evidenceKind = pickOne<CoderEvidenceKind>(item.evidenceKind, EVIDENCE_KINDS);
		if (!evidenceKind) { pushIssue(issues, "evidence_packet_unreadable", `criterionCoverage[${i}].evidenceKind is not a known kind.`, "warning", criterion); continue; }
		const strength = pickOne<CoderEvidenceStrength>(item.strength, STRENGTHS);
		if (!strength) { pushIssue(issues, "evidence_packet_unreadable", `criterionCoverage[${i}].strength is not a known strength.`, "warning", criterion); continue; }
		const rowSummary = trimString(item.summary);
		if (!rowSummary) { pushIssue(issues, "evidence_packet_unreadable", `criterionCoverage[${i}].summary is required.`, "warning", criterion); continue; }
		const row: CoderCriterionCoverage = {
			criterion, evidenceKind, strength,
			supportingFiles: asStringArray(item.supportingFiles),
			supportingCommands: asStringArray(item.supportingCommands),
			summary: rowSummary,
		};
		const caveats = trimString(item.caveats);
		if (caveats) row.caveats = caveats;
		const gaps = trimString(item.gaps);
		if (gaps) row.gaps = gaps;
		criterionCoverage.push(row);
	}
	return {
		value: {
			filesChanged, commandsRun, criterionCoverage,
			knownGaps: asStringArray(input.packet.knownGaps),
			caveats: asStringArray(input.packet.caveats),
			summary,
			delegateHistory: buildHistory(input.packet.delegateHistory, input.delegateHistory, input.completionSource, input.finalOutput),
		},
		issues,
	};
}

// ---------- Validator ----------
export interface CoderEvidencePlanShape {
	acceptanceCriteria?: string[];
	acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[];
	status?: "ready" | "draft";
}
export interface EvaluateCoderEvidenceOptions {
	/** Apply the lightweight (tiny/admin/debug) exception. Refused on
	 *  matrix-gated plans to prevent silent bypass. */
	lightweight?: boolean; lightweightScope?: "tiny" | "admin" | "debug";
	/** Force matrix-gated classification regardless of plan shape. */
	isMatrixGated?: boolean;
	/** Treat missing filesChanged / commandsRun as errors. */
	requireFilesAndCommands?: boolean;
	/** WP2 G7: observed workspace diff across the delegate run. When present
	 *  on a matrix-gated plan, `filesChanged` must match it exactly
	 *  (`evidence_diff_mismatch`) and an unverifiable diff blocks
	 *  (`diff_unverifiable`). Absent = the caller did not capture snapshots
	 *  (e.g. pure smokes); the wired delegation boundary always supplies it. */
	observedDiff?: ObservedDiffCheck;
	/** WP2 G9: outcomes of the gate's own re-run of claimed-passed runnable
	 *  evidence commands. Any non-zero exit / timeout blocks
	 *  (`evidence_rerun_failed`). */
	commandReruns?: EvidenceCommandRerunOutcome[];
	/** WP2 G9: runnable-supporting commands the gate refused/declined to
	 *  re-run. `not_allowlisted` blocks fail-closed
	 *  (`evidence_rerun_unverifiable`); `command_cap` is a warning. */
	rerunSkipped?: EvidenceRerunSkip[];
}

/** Lexical path normalization for the declared-vs-observed comparison: both
 *  sides are delegate-cwd-relative, so posix separators + "./" stripping is
 *  all that is needed. */
function normalizeEvidencePath(file: string): string {
	let out = file.trim().replace(/\\/g, "/");
	while (out.startsWith("./")) out = out.slice(2);
	return out.replace(/\/+$/, "");
}
export function isMatrixGated(plan: CoderEvidencePlanShape | null, forced: boolean | undefined): boolean {
	if (forced === true) return true;
	if (!plan) return false;
	if (plan.status !== "ready") return false;
	const matrix = plan.acceptanceEvidenceMatrix ?? [];
	if (matrix.length === 0) return false;
	// A ready plan with acceptanceEvidenceMatrix rows is matrix-gated even if
	// acceptanceCriteria is empty/missing; otherwise a tiny/admin/debug bypass
	// could silently skip a ready plan that already has matrix rows.
	return true;
}
function classifySourcePrecedence(packet: CoderCompletionEvidence | undefined, history: CoderDelegateHistory): CoderEvidenceEvaluation["diagnostics"]["sourcePrecedence"] {
	if (!packet) return (history.autoExitObserved || history.processExitObserved || history.missingSidecarObserved) ? "pane-structured" : "none";
	const hasStructured = packet.criterionCoverage.length > 0 || packet.commandsRun.length > 0;
	if (history.processExitObserved || history.missingSidecarObserved) return "pane-structured";
	if (history.autoExitObserved) return hasStructured ? "pane-structured" : "free-form-only";
	if (history.freeFormOnlyObserved) return "free-form-only";
	return hasStructured ? "explicit-structured" : "free-form-only";
}
function rowSatisfiesEntry(entry: AcceptanceEvidenceMatrixEntry, row: CoderCriterionCoverage, commandLookup: Map<string, CommandOutcome>): CoderEvidenceIssue[] {
	const issues: CoderEvidenceIssue[] = [];
	const c = entry.criterion;
	if (row.strength === "skipped") { pushIssue(issues, "skipped_command_unsupported", `Criterion ${c} has strength=skipped.`, "error", c); return issues; }
	const runnable = entry.requiredEvidence.some((ev) => RUNNABLE_REQUIRED_KINDS.has(ev.kind));
	const reviewOrManual = !runnable && entry.requiredEvidence.every((ev) => REVIEW_OR_MANUAL_KINDS.has(ev.kind));
	if (runnable) {
		if (WEAK_CODER_KINDS.has(row.evidenceKind)) pushIssue(issues, "static_only_behavior_criterion", `Criterion ${c} requires runnable evidence; got weak kind ${row.evidenceKind}.`, "error", c);
		else if (!RUNNABLE_CODER_KINDS.has(row.evidenceKind)) pushIssue(issues, "insufficient_evidence", `Criterion ${c} requires runnable evidence; got ${row.evidenceKind}.`, "error", c);
		else if (row.strength !== "sufficient") pushIssue(issues, "weak_evidence", `Criterion ${c} has runnable kind ${row.evidenceKind} but strength=${row.strength}.`, "error", c);
		else if (row.supportingCommands.length === 0) pushIssue(issues, "insufficient_evidence", `Criterion ${c} requires runnable evidence with at least one supporting command.`, "error", c);
		else {
			const hasPassed = row.supportingCommands.some((cmd) => commandLookup.get(cmd) === "passed");
			if (!hasPassed) pushIssue(issues, "insufficient_evidence", `Criterion ${c} requires at least one passed supporting command.`, "error", c);
			if (row.supportingCommands.some((cmd) => { const o = commandLookup.get(cmd); return o === "failed" || o === "skipped"; })) {
				pushIssue(issues, "failed_command_unsupported", `Criterion ${c} references a failed/skipped supporting command.`, "error", c);
			}
		}
		return issues;
	}
	if (reviewOrManual) {
		if (row.evidenceKind !== "reviewer-approval" && row.evidenceKind !== "manual-validation") pushIssue(issues, "insufficient_evidence", `Criterion ${c} requires reviewer-approval or manual-validation; got ${row.evidenceKind}.`, "error", c);
		else if (row.strength !== "manual-caveat" && row.strength !== "sufficient") pushIssue(issues, "weak_evidence", `Criterion ${c} requires manual-caveat strength; got ${row.strength}.`, "error", c);
		else if (!row.caveats || !row.caveats.trim()) pushIssue(issues, "weak_evidence", `Criterion ${c} requires a non-empty caveats field for manual/reviewer evidence.`, "error", c);
		return issues;
	}
	if (row.strength !== "sufficient" && row.strength !== "manual-caveat") pushIssue(issues, "weak_evidence", `Criterion ${c} has strength=${row.strength}; expected sufficient or manual-caveat.`, "error", c);
	if (WEAK_CODER_KINDS.has(row.evidenceKind)) pushIssue(issues, "insufficient_evidence", `Criterion ${c} has weak evidenceKind ${row.evidenceKind}; expected non-weak kind.`, "error", c);
	return issues;
}

export function evaluateCoderCompletionEvidence(plan: CoderEvidencePlanShape | null, packet: CoderCompletionEvidence | undefined, options: EvaluateCoderEvidenceOptions = {}): CoderEvidenceEvaluation {
	const issues: CoderEvidenceIssue[] = [];
	const history = packet ? cloneHistory(packet.delegateHistory) : freshHistory();
	const matrixGated = isMatrixGated(plan, options.isMatrixGated);
	const lightweight = options.lightweight === true;
	const requireFilesAndCommands = options.requireFilesAndCommands === true;
	const commandOutcomes: Record<CommandOutcome, number> = { passed: 0, failed: 0, skipped: 0 };
	if (packet) for (const cmd of packet.commandsRun) commandOutcomes[cmd.outcome] += 1;
	const sourcePrecedence = classifySourcePrecedence(packet, history);
	const coverageRows = packet?.criterionCoverage.length ?? 0;
	const missingCriteria: string[] = [];
	const weakCriteria: string[] = [];

	if (lightweight) {
		if (!options.lightweightScope) pushIssue(issues, "lightweight_bypass_refused", "Lightweight exception requires an explicit lightweightScope.", "error");
		if (matrixGated) pushIssue(issues, "lightweight_bypass_refused", `Lightweight ${options.lightweightScope ?? "unspecified"} exception cannot bypass a matrix-gated plan.`, "error");
	}
	if (!matrixGated) {
		return {
			ok: issues.length === 0, isMatrixGated: false, lightweight, issues,
			rejectionCodes: issues.map((i) => i.code),
			diagnostics: { delegateHistory: history, coverageRows, missingCriteria, weakCriteria, commandOutcomes, sourcePrecedence },
			reason: issues.length > 0 ? issues.map((i) => i.message).join("; ") : "Plan is not matrix-gated; evidence check is a no-op.",
		};
	}
	if (!packet) pushIssue(issues, "evidence_packet_missing", "Matrix-gated coder phase requires a structured evidence packet.", "error");
	if (history.autoExitObserved) pushIssue(issues, "auto_exit_incomplete", "Matrix-gated coder phase cannot advance on auto-exit fallback.", "error");
	if (history.processExitObserved) pushIssue(issues, "process_exit_incomplete", "Matrix-gated coder phase cannot advance on process-exit sidecar.", "error");
	if (history.missingSidecarObserved) pushIssue(issues, "missing_sidecar_incomplete", "Matrix-gated coder phase cannot advance without an explicit done sidecar.", "error");
	if (sourcePrecedence === "free-form-only" || (history.freeFormOnlyObserved && (!packet || coverageRows === 0))) {
		pushIssue(issues, "free_form_only", "Free-form final assistant text is diagnostic only and never sufficient for matrix-gated coder work.", "error");
	}
	if (packet) {
		if (requireFilesAndCommands && packet.filesChanged.length === 0) pushIssue(issues, "missing_files_changed", "Matrix-gated coder evidence packet must include filesChanged.", "error");
		if (requireFilesAndCommands && packet.commandsRun.length === 0) pushIssue(issues, "missing_commands_run", "Matrix-gated coder evidence packet must include commandsRun.", "error");
		if (packet.criterionCoverage.length === 0) pushIssue(issues, "missing_criterion", "Matrix-gated coder evidence packet must include at least one criterionCoverage row.", "error");
	}
	const matrix = plan?.acceptanceEvidenceMatrix ?? [];
	const rowsByCriterion = new Map<string, CoderCriterionCoverage[]>();
	if (packet) for (const row of packet.criterionCoverage) {
		const list = rowsByCriterion.get(row.criterion) ?? [];
		list.push(row);
		rowsByCriterion.set(row.criterion, list);
	}
	const commandLookup = new Map<string, CommandOutcome>();
	if (packet) for (const cmd of packet.commandsRun) commandLookup.set(cmd.command, cmd.outcome);
	for (const entry of matrix) {
		const rows = rowsByCriterion.get(entry.criterion) ?? [];
		if (rows.length === 0) {
			missingCriteria.push(entry.criterion);
			pushIssue(issues, "missing_criterion", `Acceptance criterion is not covered by any evidence row: ${entry.criterion}.`, "error", entry.criterion);
			continue;
		}
		if (rows.length > 1) pushIssue(issues, "duplicate_coverage", `Multiple evidence rows for criterion ${entry.criterion}; using the strongest.`, "warning", entry.criterion);
		rows.sort((a, b) => STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength]);
		const strongest = rows[0]!;
		const rowIssues = rowSatisfiesEntry(entry, strongest, commandLookup);
		for (const issue of rowIssues) issues.push(issue);
		if (rowIssues.some((i) => i.severity === "error")) weakCriteria.push(entry.criterion);
	}
	if (packet) {
		const referenced = new Set<string>();
		for (const row of packet.criterionCoverage) for (const cmd of row.supportingCommands) referenced.add(cmd);
		for (const cmd of packet.commandsRun) {
			if (referenced.has(cmd.command)) continue;
			if (cmd.outcome === "failed") pushIssue(issues, "failed_command_unsupported", `Command failed but is not referenced in any criterionCoverage row: ${cmd.command}.`, "warning");
			else if (cmd.outcome === "skipped") pushIssue(issues, "skipped_command_unsupported", `Command skipped but is not referenced in any criterionCoverage row: ${cmd.command}.`, "warning");
		}
	}
	// ---- WP2 G7: declared filesChanged must match the observed diff ----
	let diffCheck: CoderEvidenceEvaluation["diagnostics"]["diffCheck"];
	if (options.observedDiff) {
		if (!options.observedDiff.verifiable) {
			diffCheck = { verifiable: false, undeclaredChangedFiles: [], declaredUnchangedFiles: [] };
			pushIssue(issues, "diff_unverifiable", `Workspace diff for the coder run could not be verified: ${options.observedDiff.reason ?? "unknown reason"}. Matrix-gated evidence is fail-closed — run the coder delegate inside a git worktree so filesChanged can be checked against the real diff.`, "error");
		} else if (packet) {
			const declared = new Set(packet.filesChanged.map(normalizeEvidencePath).filter((f) => f.length > 0));
			const observed = new Set(options.observedDiff.changedFiles.map(normalizeEvidencePath).filter((f) => f.length > 0));
			const undeclaredChangedFiles = [...observed].filter((f) => !declared.has(f)).sort();
			const declaredUnchangedFiles = [...declared].filter((f) => !observed.has(f)).sort();
			diffCheck = { verifiable: true, undeclaredChangedFiles, declaredUnchangedFiles };
			if (undeclaredChangedFiles.length > 0) {
				pushIssue(issues, "evidence_diff_mismatch", `Files changed during the coder run but not declared in coderEvidence.filesChanged: ${undeclaredChangedFiles.join(", ")}. Declare every changed file or revert unintended edits.`, "error");
			}
			if (declaredUnchangedFiles.length > 0) {
				pushIssue(issues, "evidence_diff_mismatch", `Files declared in coderEvidence.filesChanged but not actually changed during the coder run: ${declaredUnchangedFiles.join(", ")}. Remove stale entries so the report matches the real diff.`, "error");
			}
		}
	}
	// ---- WP2 G9: gate-side re-run of claimed-passed runnable commands ----
	for (const rerun of options.commandReruns ?? []) {
		if (rerun.timedOut) {
			pushIssue(issues, "evidence_rerun_failed", `Re-run of claimed-passed evidence command timed out after ${rerun.durationMs}ms: ${rerun.command}. Fix the command or the implementation so the evidence is reproducible.`, "error");
		} else if (rerun.exitCode !== 0) {
			pushIssue(issues, "evidence_rerun_failed", `Re-run of claimed-passed evidence command exited ${rerun.exitCode ?? "without a status"}: ${rerun.command}.${rerun.spawnError ? ` Spawn error: ${rerun.spawnError}.` : ""}${rerun.outputPreview ? ` Output tail: ${rerun.outputPreview}` : ""}`, "error");
		}
	}
	for (const skip of options.rerunSkipped ?? []) {
		if (skip.reason === "not_allowlisted") {
			pushIssue(issues, "evidence_rerun_unverifiable", `Claimed-passed command supporting a runnable criterion cannot be re-run because it is not in evidence.rerunAllowlist: ${skip.command}. Use an allowlisted runner (or extend evidence.rerunAllowlist in workflow config).`, "error");
		} else {
			pushIssue(issues, "evidence_rerun_unverifiable", `Claimed-passed command was not re-run (per-phase re-run command cap reached): ${skip.command}.`, "warning");
		}
	}
	const rejectionCodes: CoderEvidenceRejectionCode[] = [];
	for (const issue of issues) if (issue.severity === "error") rejectionCodes.push(issue.code);
	const ok = rejectionCodes.length === 0;
	return {
		ok, isMatrixGated: true, lightweight, issues, rejectionCodes,
		diagnostics: {
			delegateHistory: history, coverageRows, missingCriteria, weakCriteria, commandOutcomes, sourcePrecedence,
			...(diffCheck ? { diffCheck } : {}),
			...(options.commandReruns ? { commandReruns: options.commandReruns } : {}),
			...(options.rerunSkipped?.length ? { rerunSkipped: options.rerunSkipped } : {}),
		},
		reason: ok ? undefined : issues.filter((i) => i.severity === "error").map((i) => i.message).join("; "),
	};
}

/** True when a (plan, options) pair is eligible for the explicit lightweight
 *  exception. Callers should still pass lightweight=true and a
 *  lightweightScope to evaluateCoderCompletionEvidence so the bypass is
 *  visible in audit logs / structured handoff details. */
export function canUseLightweightEvidenceCheck(plan: CoderEvidencePlanShape | null, options: { lightweightScope?: "tiny" | "admin" | "debug"; isMatrixGated?: boolean } = {}): boolean {
	if (!options.lightweightScope) return false;
	if (isMatrixGated(plan, options.isMatrixGated)) return false;
	return true;
}
