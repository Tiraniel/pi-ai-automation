// TASK-004 Phase A — role-based quality-review contract for the reviewer swarm.
// No runtime wiring; Phase B wires `runReviewerSwarm` and `delegate_to_reviewer`
// to these helpers. Contract:
//   - Targets derived from `WorkflowArchitecturePlan.acceptanceEvidenceMatrix` +
//     non-trivial default role set, with `docs-config` added when in scope.
//   - Explicit Brain `goals` are supplemental only; never replace required roles.
//   - Behavior/evidence roles downgrade/block source-string / static-only TUI
//     evidence and prompt-only runtime mitigations.
//   - `auto_exit` / `process_exit` / missing / legacy completion is provisional
//     and blocks required-role approval without explicit structured reviewer evidence.
//   - Memo consolidator blocks final approval on any required-role blocker.

import type {
	AcceptanceEvidenceMatrixEntry,
	RequiredEvidenceItem,
	ReviewerRole,
	WorkflowArchitecturePlan,
} from "../architecture/types";
import type {
	DelegateCompletionSource,
	DelegateRunResult,
	ReviewerTargetResult,
} from "../types";

// ---------- Constants ----------
// The closed reviewer-role id set lives in `../reviewer-protocol`
// (REVIEWER_ROLE_IDS); this module only defines role *policy*.

/** Default required role set for a non-trivial matrix-gated plan. */
export const DEFAULT_NON_TRIVIAL_REQUIRED_ROLES: readonly ReviewerRole[] = [
	"behavior", "evidence-test", "implementation", "maintainability", "regression",
] as const;

// Path-shaped hints match as substrings; word hints match on word boundaries
// so "config" does not fire on "configure/reconfigurable" and "example" does
// not fire on "counterexample". Over-scoping makes docs-config a REQUIRED
// role, which can spuriously block final approval.
const DOCS_CONFIG_PATH_HINTS: readonly string[] = [
	"docs/", "examples/", "workflow.quality-gates", "workflow.json", "settings.json",
];
const DOCS_CONFIG_WORD_HINTS: readonly string[] = [
	"readme", "docs", "documentation", "example", "examples", "config", "configuration",
];
const DOCS_CONFIG_WORD_REGEXES: ReadonlyArray<{ hint: string; regex: RegExp }> = DOCS_CONFIG_WORD_HINTS.map((hint) => ({
	hint,
	regex: new RegExp(`\\b${hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
}));
const RUNTIME_SCOPE_HINTS: readonly string[] = [
	"tui", "runtime", "ui", "terminal", "pane", "cmux", "tool render", "toolresult",
];
const STATIC_ONLY_PHRASES: readonly string[] = [
	"by reading the source", "reading the source", "read the source", "read-source",
	"source string", "source-string", "static-only",
	"static check is sufficient", "covered by static", "static analysis shows",
	"no need to run", "no runtime run", "no-runtime-run", "skipped running",
];
const PROMPT_ONLY_PHRASES: readonly string[] = [
	"prompt the model", "added to the prompt", "added to instructions",
	"updated the system prompt", "prompt-only fix", "prompt only fix",
	"prompt-only mitigation", "no code change", "documentation only", "comment-only fix",
];
const POSITIVE_RUNTIME_REGEX = /(behavior test passed|runtime gate passed|regression test passed|executed the test|test passed|exited 0|exit code 0)/i;

// ---------- Types ----------

export interface ReviewerRoleTarget {
	target: string;
	role: ReviewerRole;
	required: boolean;
	rationale: string;
	criteria: string[];
	requiredEvidence: RequiredEvidenceItem[];
	blockingConditions: string[];
	matrixEntryIndices: number[];
	supplementalGoals: string[];
	roleRules: string[];
	label: string;
}

/** Minimal plan surface for derivation; lets synthetic fixtures drive the smoke. */
export interface ReviewerRolePlanShape {
	planId?: string;
	title?: string;
	status?: "ready" | "draft";
	acceptanceCriteria?: string[];
	acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[];
	files?: string[];
	goals?: string[];
}

export interface DeriveReviewerRoleTargetsOptions {
	goals?: string[];
	/** Defaults to `DEFAULT_NON_TRIVIAL_REQUIRED_ROLES`. Pass `[]` to keep matrix-only. */
	defaultRequiredRoles?: readonly ReviewerRole[];
	/** Force-include `docs-config` even without a scope signal. */
	includeDocsConfig?: boolean;
	files?: string[];
	acceptanceCriteria?: string[];
}

export interface ReviewerRoleDerivation {
	targets: ReviewerRoleTarget[];
	supplementalGoals: string[];
	docsConfigInScope: boolean;
	docsConfigSignals: string[];
	rolesRequired: ReviewerRole[];
	rolesSupplemental: ReviewerRole[];
	skippedRoles: Array<{ role: ReviewerRole; reason: string }>;
	usedDefaults: boolean;
	usedMatrix: boolean;
}

export interface ReviewerResultLike {
	verdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";
	finalOutput?: string;
	completionSource?: DelegateCompletionSource | string;
	completionWarning?: string;
	status?: "running" | "completed" | "failed" | "aborted";
	reviewerEvidence?: ReviewerStructuredEvidence;
	details?: Record<string, unknown>;
}

/** Minimal structured reviewer-evidence shape (boolean/coverage check only). */
export interface ReviewerStructuredEvidence {
	present?: boolean;
	criterionCoverage?: Array<{ criterion: string; evidenceKind?: string; summary?: string }>;
	commandsRun?: Array<{ command: string; outcome?: string; summary?: string }>;
	explicitDeclaration?: boolean;
}

export interface ReviewerEvaluation {
	role: ReviewerRole;
	target: string;
	required: boolean;
	verdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";
	effectiveVerdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";
	provisional: boolean;
	blockingReasons: string[];
	weakEvidence: string[];
	promptOnlyCaveats: string[];
	unresolvedRisks: string[];
	supplementalGoals: string[];
	notes: string[];
}

export interface ReviewerMemo {
	planId: string | undefined;
	phase: string | undefined;
	approved: boolean;
	finalRecommendation: string;
	approvals: ReviewerEvaluation[];
	changesRequested: ReviewerEvaluation[];
	weakEvidence: ReviewerEvaluation[];
	promptOnlyCaveats: ReviewerEvaluation[];
	unresolvedRisks: ReviewerEvaluation[];
	provisionalCaveats: ReviewerEvaluation[];
	unknownOrFailed: ReviewerEvaluation[];
	markdown: string;
	supplementalGoals: string[];
	docsConfigInScope: boolean;
	rolesRequired: ReviewerRole[];
	/** Required roles that have no evaluation supplied; fail-closed blocker. */
	missingRequiredRoles: ReviewerRole[];
}

// ---------- Helpers ----------

function lc(value: string | undefined): string {
	return typeof value === "string" ? value.toLowerCase() : "";
}

function uniqueOrdered(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function buildRoleLabel(role: ReviewerRole): string {
	switch (role) {
		case "behavior": return "Behavior reviewer";
		case "evidence-test": return "Evidence/test-adequacy reviewer";
		case "implementation": return "Implementation reviewer";
		case "regression": return "Regression reviewer";
		case "maintainability": return "Maintainability/architecture reviewer";
		case "docs-config": return "Docs/config reviewer";
	}
}

const COMMON_ROLE_RULES: readonly string[] = [
	"Do not validate, approve, or critique Brain-owned plan quality, architecture plans, contract/block plans, or phase plans.",
	"Start your response with APPROVED or CHANGES_REQUESTED as the first token. Free-form completion without that prefix is provisional and does not satisfy the role.",
	"Map findings to specific files/lines and matrix criterion text whenever possible.",
];

/** Per-role hard rules the prompt must surface so reviewers self-enforce. */
function buildRoleHardRules(role: ReviewerRole): string[] {
	const downstream = role === "behavior" || role === "evidence-test" || role === "regression";
	const rules: string[] = [...COMMON_ROLE_RULES];
	if (downstream) {
		rules.push(
			"Reject source-string / static-only / \"read-the-source\" / \"walked the code\" / \"I inspected the code\" / \"I reviewed the source\" claims as the sole evidence for TUI / runtime-behavior criteria. Behavior must be confirmed by a runnable behavior test, runtime gate, observed tool output, or explicit structured reviewer evidence.",
			"Reject prompt-only / instructions-only mitigations for runtime behavior. Prompt changes do not satisfy runtime-behavior or behavior-test criteria.",
		);
	}
	rules.push("auto_exit / process_exit / missing completion is provisional and blocking for this required role unless explicit structured reviewer evidence (criterion coverage rows, command outcomes, or an explicit reviewer evidence declaration) is present.");
	return rules;
}

/** Detect whether the docs-config role should be in scope for a plan. */
export function isDocsConfigInScope(input: {
	files?: string[];
	acceptanceCriteria?: string[];
	acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[];
	goals?: string[];
}): { inScope: boolean; signals: string[] } {
	const signals: string[] = [];
	const collect = (lower: string, kind: string) => {
		for (const hint of DOCS_CONFIG_PATH_HINTS) if (lower.includes(hint)) { signals.push(`${kind}:${hint}`); return; }
		for (const { hint, regex } of DOCS_CONFIG_WORD_REGEXES) if (regex.test(lower)) { signals.push(`${kind}:${hint}`); return; }
	};
	for (const file of input.files ?? []) collect(lc(file), "file");
	for (const text of input.acceptanceCriteria ?? []) collect(lc(text), "acceptance");
	const matrix = input.acceptanceEvidenceMatrix ?? [];
	for (let i = 0; i < matrix.length; i += 1) {
		const entry = matrix[i];
		if (!entry) continue;
		if (entry.criterionKind === "documentation" || entry.criterionKind === "configuration") {
			signals.push(`matrix[${i}].criterionKind=${entry.criterionKind}`);
		}
		if (entry.reviewerRoles.includes("docs-config")) signals.push(`matrix[${i}].reviewerRoles=docs-config`);
	}
	return { inScope: signals.length > 0, signals: uniqueOrdered(signals) };
}

// ---------- Derivation ----------

/** Derive reviewer role targets from a plan, default role policy, and explicit Brain
 *  goals. Matrix `reviewerRoles` drive the role set; defaults fill gaps; explicit
 *  `goals` are supplemental-only and never replace required roles. */
export function deriveReviewerRoleTargets(
	plan: ReviewerRolePlanShape | WorkflowArchitecturePlan | null | undefined,
	options: DeriveReviewerRoleTargetsOptions = {},
): ReviewerRoleDerivation {
	const matrix = (plan?.acceptanceEvidenceMatrix ?? []).filter((e): e is AcceptanceEvidenceMatrixEntry => Boolean(e));
	const files = options.files ?? plan?.files ?? [];
	const acceptanceCriteria = options.acceptanceCriteria ?? plan?.acceptanceCriteria ?? [];
	// `WorkflowArchitecturePlan` does not declare `goals`; only the synthetic
	// `ReviewerRolePlanShape` does. Read plan goals only when the property
	// actually exists on the plan, otherwise fall back to `options.goals`.
	const planGoals: string[] | undefined = plan && typeof plan === "object" && "goals" in plan
		? (Array.isArray((plan as ReviewerRolePlanShape).goals) ? (plan as ReviewerRolePlanShape).goals : undefined)
		: undefined;
	const goals = options.goals ?? planGoals ?? [];
	const docsConfig = isDocsConfigInScope({ files, acceptanceCriteria, acceptanceEvidenceMatrix: matrix, goals });
	const docsConfigInScope = docsConfig.inScope || options.includeDocsConfig === true;
	const supplementalGoals = uniqueOrdered(goals);

	const usedDefaults = options.defaultRequiredRoles === undefined;
	const defaultSet = new Set<ReviewerRole>(options.defaultRequiredRoles ?? DEFAULT_NON_TRIVIAL_REQUIRED_ROLES);
	const skippedRoles: Array<{ role: ReviewerRole; reason: string }> = [];

	const matrixRoleEntries = new Map<ReviewerRole, { indices: number[]; criteria: string[]; evidence: RequiredEvidenceItem[]; blocking: string[] }>();
	const requiredRoles: ReviewerRole[] = [];
	const requiredSeen = new Set<ReviewerRole>();
	for (let i = 0; i < matrix.length; i += 1) {
		const entry = matrix[i];
		if (!entry) continue;
		for (const role of entry.reviewerRoles) {
			const slot = matrixRoleEntries.get(role) ?? { indices: [], criteria: [], evidence: [], blocking: [] };
			slot.indices.push(i);
			slot.criteria.push(entry.criterion);
			slot.evidence.push(...entry.requiredEvidence);
			slot.blocking.push(...entry.blockingConditions);
			matrixRoleEntries.set(role, slot);
			if (!requiredSeen.has(role)) { requiredSeen.add(role); requiredRoles.push(role); }
		}
	}
	if (docsConfigInScope && !requiredSeen.has("docs-config")) {
		requiredRoles.push("docs-config");
		requiredSeen.add("docs-config");
		matrixRoleEntries.set("docs-config", { indices: [], criteria: [], evidence: [], blocking: [] });
	}
	if (matrix.length > 0 || options.defaultRequiredRoles !== undefined) {
		for (const role of defaultSet) {
			if (!requiredSeen.has(role)) {
				requiredSeen.add(role);
				requiredRoles.push(role);
				matrixRoleEntries.set(role, { indices: [], criteria: [], evidence: [], blocking: [] });
			}
		}
	} else {
		for (const role of defaultSet) skippedRoles.push({ role, reason: "plan has no acceptanceEvidenceMatrix; default role policy skipped" });
	}

	// One target per required role; matrix entries for the same role are merged.
	const targets: ReviewerRoleTarget[] = [];
	for (let i = 0; i < requiredRoles.length; i += 1) {
		const role = requiredRoles[i];
		if (!role) continue;
		const slot = matrixRoleEntries.get(role) ?? { indices: [], criteria: [], evidence: [], blocking: [] };
		const label = buildRoleLabel(role);
		const rationaleParts: string[] = [];
		if (slot.indices.length > 0) rationaleParts.push(`matrix entries ${slot.indices.join(", ")}`);
		if (defaultSet.has(role) && slot.indices.length === 0) rationaleParts.push("default non-trivial role policy");
		if (role === "docs-config" && docsConfigInScope) rationaleParts.push(`docs/config scope signals: ${docsConfig.signals.join("; ")}`);
		const rationale = rationaleParts.join("; ") || "default role policy";
		const hardRules = buildRoleHardRules(role);
		targets.push({
			target: `${role}#${i + 1} ${label}`.replace(/\s+/g, " ").trim(),
			role,
			required: true,
			rationale,
			criteria: slot.criteria.length > 0 ? slot.criteria : acceptanceCriteria.slice(0, 5),
			requiredEvidence: slot.evidence,
			blockingConditions: uniqueOrdered([...slot.blocking, ...hardRules]),
			matrixEntryIndices: slot.indices,
			supplementalGoals: supplementalGoals.slice(),
			roleRules: hardRules,
			label,
		});
	}

	return {
		targets,
		supplementalGoals,
		docsConfigInScope,
		docsConfigSignals: docsConfig.signals,
		rolesRequired: requiredRoles,
		rolesSupplemental: [],
		skippedRoles,
		usedDefaults,
		usedMatrix: matrix.length > 0,
	};
}

// ---------- Role prompt builder ----------

/** Build a role-aware reviewer task from a base delegated task and one role target.
 *  Fail-closed: names the role; surfaces criteria/evidence/blocking conditions; attaches
 *  supplemental goals without replacing required role criteria; forces the response to
 *  start with APPROVED or CHANGES_REQUESTED. No `code-only` wording. */
export function buildReviewerRoleTask(task: string, roleTarget: ReviewerRoleTarget): string {
	const s: string[] = [];
	s.push(`# Reviewer role: ${roleTarget.label}`, "");
	s.push("You are assigned the following role for this review:");
	s.push(`- role: ${roleTarget.role}`);
	s.push(`- required: ${roleTarget.required ? "yes" : "no"}`);
	s.push(`- rationale: ${roleTarget.rationale}`, "");
	if (roleTarget.matrixEntryIndices.length > 0) {
		s.push(`You are responsible for matrix entries: ${roleTarget.matrixEntryIndices.join(", ")}.`, "");
	}
	s.push("## Role criteria");
	for (const criterion of roleTarget.criteria) s.push(`- ${criterion}`);
	s.push("");
	if (roleTarget.requiredEvidence.length > 0) {
		s.push("## Required evidence for this role");
		for (const item of roleTarget.requiredEvidence) s.push(`- [${item.kind}] ${item.description}${item.command ? ` (command: \`${item.command}\`)` : ""}`);
		s.push("");
	}
	s.push("## Blocking conditions");
	for (const condition of roleTarget.blockingConditions) s.push(`- ${condition}`);
	s.push("");
	s.push("## Hard role rules");
	for (const rule of roleTarget.roleRules) s.push(`- ${rule}`);
	s.push("");
	if (roleTarget.supplementalGoals.length > 0) {
		s.push("## Supplemental goals (do NOT replace required role criteria)");
		for (const goal of roleTarget.supplementalGoals) s.push(`- ${goal}`);
		s.push("");
	}
	s.push("## Base delegated task", task.trim(), "");
	s.push("## Response contract");
	s.push("- Start your response with APPROVED or CHANGES_REQUESTED as the first token — plain text, no markdown decoration around the word.");
	s.push("- If the role's hard rules or blocking conditions apply, you MUST return CHANGES_REQUESTED with the specific reason and the file/line where the issue occurs.");
	s.push("- Free-form completion (no APPROVED/CHANGES_REQUESTED prefix) is provisional and does NOT satisfy the role; Brain will treat it as a blocker for required roles.");
	s.push("- Do not validate, approve, or critique Brain-owned plan quality. Focus only on implementation diffs, behavior, evidence, and the role criteria above.");
	s.push("- This role focus takes precedence over the general reviewer checklist in your system prompt: report out-of-role findings briefly, but your verdict is decided by THIS role's criteria.");
	return s.join("\n");
}

// ---------- Evaluator ----------

function hasRuntimeBehaviorScope(roleTarget: ReviewerRoleTarget): boolean {
	// Behavior, evidence-test, and regression are inherently runtime/evidence-
	// sensitive roles: the regression role validates regression-proof evidence,
	// which is a runtime claim by definition. Treating it as runtime-scope keeps
	// the evaluator's source-string / static-only / skipped-running / prompt-only
	// downgrade paths consistent with the prompt's hard role rules (which
	// already list `regression` as a downstream runtime-sensitive role).
	if (roleTarget.role === "behavior" || roleTarget.role === "evidence-test" || roleTarget.role === "regression") return true;
	for (const criterion of roleTarget.criteria) {
		const lower = lc(criterion);
		if (RUNTIME_SCOPE_HINTS.some((hint) => lower.includes(hint))) return true;
	}
	return false;
}

function isSourceStringOnlyEvidence(output: string): boolean {
	// Downgrade only when the output EXPLICITLY relies on source-string / static-only
	// / read-the-source / skipped-running phrasing. Absence of a positive runtime
	// phrase alone is not evidence of static-only review; many valid reviewers
	// describe behavior without that exact wording, and over-eager downgrades
	// here would silently fail required approvals.
	const lower = lc(output);
	return STATIC_ONLY_PHRASES.some((p) => lower.includes(p));
}

function isPromptOnlyCaveatFromMatrix(roleTarget: ReviewerRoleTarget, output: string): boolean {
	const lower = lc(output);
	if (PROMPT_ONLY_PHRASES.some((p) => lower.includes(p))) return true;
	const matrixPromptsOnly = roleTarget.criteria.some((c) => /prompt-?only/i.test(c));
	return matrixPromptsOnly && lower.includes("prompt-only") && !POSITIVE_RUNTIME_REGEX.test(output);
}

function hasNonEmptyCriterionCoverage(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	for (const c of value) {
		if (c && typeof c === "object" && typeof (c as Record<string, unknown>).criterion === "string"
			&& ((c as Record<string, unknown>).criterion as string).length > 0) {
			return true;
		}
	}
	return false;
}

function hasNonEmptyCommandOutcomes(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	for (const c of value) {
		if (c && typeof c === "object" && typeof (c as Record<string, unknown>).command === "string"
			&& ((c as Record<string, unknown>).command as string).length > 0) {
			return true;
		}
	}
	return false;
}

function hasExplicitStructuredReviewerEvidence(input: ReviewerResultLike): boolean {
	// Fail-closed: a bare `present: true` or `explicitDeclaration: true` flag
	// is NOT enough to suppress auto_exit provisional blocking. We require
	// meaningful typed content (non-empty `criterionCoverage` or non-empty
	// `commandsRun`) on the `reviewerEvidence` / `details.reviewerEvidence`
	// object. Final-output label detection is intentionally NOT used: vague
	// labels like "evidence packet: ok ok" or "reviewer evidence: ok ok" in
	// the final text are NOT structured reviewer evidence and must not
	// suppress provisional blocking.
	const ev = input.reviewerEvidence;
	if (ev) {
		if (hasNonEmptyCriterionCoverage(ev.criterionCoverage)) return true;
		if (hasNonEmptyCommandOutcomes(ev.commandsRun)) return true;
		if (ev.explicitDeclaration === true
			&& (hasNonEmptyCriterionCoverage(ev.criterionCoverage) || hasNonEmptyCommandOutcomes(ev.commandsRun))) {
			return true;
		}
	}
	const details = input.details;
	if (details && typeof details === "object") {
		const reviewerEvidence = (details as { reviewerEvidence?: unknown }).reviewerEvidence;
		if (reviewerEvidence && typeof reviewerEvidence === "object") {
			if (hasNonEmptyCriterionCoverage((reviewerEvidence as Record<string, unknown>).criterionCoverage)) return true;
			if (hasNonEmptyCommandOutcomes((reviewerEvidence as Record<string, unknown>).commandsRun)) return true;
		}
	}
	return false;
}

function isProvisionalCompletionSource(source: DelegateCompletionSource | string | undefined): boolean {
	return source === "auto_exit" || source === "process_exit" || source === "missing" || source === "legacy";
}

/** Evaluate a single reviewer result against a role target. */
export function evaluateReviewerResult(
	roleTarget: ReviewerRoleTarget,
	input: ReviewerResultLike,
): ReviewerEvaluation {
	const output = typeof input.finalOutput === "string" ? input.finalOutput : "";
	const baseVerdict = input.verdict ?? "UNKNOWN";
	const status = input.status ?? (baseVerdict === "APPROVED" || baseVerdict === "CHANGES_REQUESTED" ? "completed" : "unknown");
	const failed = status === "failed" || status === "aborted";
	const provisionalSource = isProvisionalCompletionSource(input.completionSource);
	const explicitEvidence = hasExplicitStructuredReviewerEvidence(input);

	const blockingReasons: string[] = [];
	const weakEvidence: string[] = [];
	const promptOnlyCaveats: string[] = [];
	const unresolvedRisks: string[] = [];
	const notes: string[] = [];

	if (failed) blockingReasons.push(`Reviewer status is ${status}.`);
	if (roleTarget.required && baseVerdict === "UNKNOWN") {
		blockingReasons.push("Reviewer verdict is UNKNOWN; required role did not return a parseable APPROVED/CHANGES_REQUESTED prefix.");
	}
	if (provisionalSource) {
		if (!explicitEvidence) {
			blockingReasons.push(`Completion source is ${String(input.completionSource)} without explicit structured reviewer evidence; required role is provisional.`);
			notes.push("provisional: no structured reviewer evidence present");
		} else {
			notes.push(`Completion source is ${String(input.completionSource)} but explicit structured reviewer evidence is present; provisional flag suppressed.`);
		}
	}
	if (baseVerdict === "APPROVED" && (roleTarget.role === "behavior" || roleTarget.role === "evidence-test" || roleTarget.role === "regression")) {
		// Fail-closed for behavior / evidence-test / regression on runtime-behavior
		// scope: an APPROVED result must cite acceptable runtime evidence (runnable
		// behavior test, runtime gate, observed tool output, explicit
		// "behavior test passed" / "exit code 0" / similar) OR carry explicit
		// structured reviewer evidence. Code-walk / source-inspection only
		// approvals (e.g. "I walked the code and confirmed ...") are
		// downgraded even when no static-only phrase is present.
		// Source-string / static-only / read-the-source / skipped-running /
		// no-runtime-run claims OVERRIDE broad positive runtime phrases:
		// an output that mixes "test passed" with "no runtime run" is still
		// downgraded, unless explicit structured reviewer evidence is
		// supplied. Regression role is included because its hard role rules
		// already reject source-string / static-only / skipped-running
		// evidence; the evaluator must enforce what the prompt requires.
		if (hasRuntimeBehaviorScope(roleTarget)) {
			const isStaticOnly = isSourceStringOnlyEvidence(output);
			const hasPositiveRuntime = POSITIVE_RUNTIME_REGEX.test(output);
			if (isStaticOnly && !explicitEvidence) {
				blockingReasons.push(
					"Reviewer output relies on source-string / static-only / read-the-source / skipped-running / no-runtime-run evidence for a TUI/runtime-behavior criterion, even though it also contains a positive phrase; required role is downgraded to CHANGES_REQUESTED.",
				);
				weakEvidence.push("source-string / static-only / read-the-source / skipped-running / no-runtime-run evidence claimed for runtime-behavior scope");
			} else if (!hasPositiveRuntime && !explicitEvidence) {
				const reasonSuffix = isStaticOnly
					? "code-walk / source-inspection evidence only; no runnable behavior test, runtime gate, observed tool output, or explicit structured reviewer evidence"
					: "no runnable behavior test, runtime gate, observed tool output, or explicit structured reviewer evidence";
				blockingReasons.push(`Reviewer output relies on ${reasonSuffix} for a TUI/runtime-behavior criterion. Required role is downgraded to CHANGES_REQUESTED.`);
				weakEvidence.push(`${reasonSuffix} claimed for runtime-behavior scope`);
			}
		}
	}
	if (baseVerdict === "APPROVED" && hasRuntimeBehaviorScope(roleTarget) && isPromptOnlyCaveatFromMatrix(roleTarget, output)) {
		blockingReasons.push("Reviewer output approves a prompt-only / instructions-only mitigation for runtime behavior. Required role is downgraded to CHANGES_REQUESTED.");
		promptOnlyCaveats.push("prompt-only runtime mitigation observed");
	}
	if (roleTarget.required && baseVerdict === "CHANGES_REQUESTED") blockingReasons.push("Reviewer returned CHANGES_REQUESTED.");
	if (/\bunresolved\b|\bneed more evidence\b|\bto be confirmed\b/i.test(output)) {
		unresolvedRisks.push("Reviewer flagged unresolved / needs-more-evidence items in the output.");
	}

	let effectiveVerdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN" = baseVerdict;
	if (roleTarget.required && blockingReasons.length > 0) effectiveVerdict = "CHANGES_REQUESTED";
	else if (!roleTarget.required && blockingReasons.length > 0 && baseVerdict === "APPROVED") effectiveVerdict = "CHANGES_REQUESTED";
	else if (roleTarget.required && baseVerdict === "UNKNOWN") effectiveVerdict = "UNKNOWN";

	return {
		role: roleTarget.role,
		target: roleTarget.target,
		required: roleTarget.required,
		verdict: baseVerdict,
		effectiveVerdict,
		provisional: roleTarget.required && provisionalSource && !explicitEvidence,
		blockingReasons,
		weakEvidence,
		promptOnlyCaveats,
		unresolvedRisks,
		supplementalGoals: roleTarget.supplementalGoals.slice(),
		notes,
	};
}

// ---------- Memo consolidator ----------

function bullets(items: string[]): string {
	return items.length === 0 ? "_(none)_" : items.map((i) => `- ${i}`).join("\n");
}

function formatEvaluationBlock(e: ReviewerEvaluation): string {
	const lines: string[] = [
		`### ${e.target} (${e.role})`,
		`- verdict: ${e.verdict}`,
		`- effective verdict: ${e.effectiveVerdict}`,
		`- required: ${e.required ? "yes" : "no"}`,
		`- provisional: ${e.provisional ? "yes" : "no"}`,
	];
	for (const [label, items] of [
		["blocking reasons", e.blockingReasons],
		["weak evidence", e.weakEvidence],
		["prompt-only caveats", e.promptOnlyCaveats],
		["unresolved risks", e.unresolvedRisks],
		["notes", e.notes],
	] as ReadonlyArray<readonly [string, readonly string[]]>) {
		if (items.length > 0) lines.push(`- ${label}:\n${bullets([...items])}`);
	}
	return lines.join("\n");
}

/** Consolidate role evaluations into a memo. Final approval requires every required
 *  role to be APPROVED, not provisional, and have no blocking reasons. */
export function consolidateReviewerMemo(input: {
	planId?: string;
	phase?: string;
	evaluations: ReviewerEvaluation[];
	supplementalGoals?: string[];
	docsConfigInScope?: boolean;
	rolesRequired?: ReviewerRole[];
}): ReviewerMemo {
	const evaluations = input.evaluations;
	const buckets: Record<"approvals" | "changesRequested" | "weakEvidence" | "promptOnlyCaveats" | "unresolvedRisks" | "provisionalCaveats" | "unknownOrFailed", ReviewerEvaluation[]> = {
		approvals: [], changesRequested: [], weakEvidence: [], promptOnlyCaveats: [],
		unresolvedRisks: [], provisionalCaveats: [], unknownOrFailed: [],
	};
	for (const e of evaluations) {
		if (e.effectiveVerdict === "APPROVED" && !e.provisional) buckets.approvals.push(e);
		else if (e.effectiveVerdict === "CHANGES_REQUESTED" || e.provisional) buckets.changesRequested.push(e);
		else buckets.unknownOrFailed.push(e);
		if (e.weakEvidence.length > 0) buckets.weakEvidence.push(e);
		if (e.promptOnlyCaveats.length > 0) buckets.promptOnlyCaveats.push(e);
		if (e.unresolvedRisks.length > 0) buckets.unresolvedRisks.push(e);
		if (e.provisional) buckets.provisionalCaveats.push(e);
	}
	const requiredRoles = input.rolesRequired ?? [];
	const evaluatedRoles = new Set(evaluations.map((e) => e.role));
	const missingRequired = requiredRoles.filter((r) => !evaluatedRoles.has(r));
	const requiredBlocked = evaluations.some((e) =>
		e.required && (e.effectiveVerdict !== "APPROVED" || e.provisional || e.blockingReasons.length > 0));
	// Fail-closed: any required role with no evaluation is a blocker.
	const approved = !requiredBlocked && missingRequired.length === 0
		&& buckets.unknownOrFailed.length === 0 && buckets.changesRequested.length === 0;
	const finalRecommendation = approved
		? "All required roles approved. Final approval can proceed."
		: missingRequired.length > 0
			? `Final approval blocked: required role evaluation missing for: ${missingRequired.join(", ")}.`
			: requiredBlocked
				? "Final approval blocked: at least one required role has CHANGES_REQUESTED, UNKNOWN, is provisional, or has unresolved blockers."
				: "Final approval blocked: no required-role approvals and no blockers; treat as not yet reviewed.";
	const sections: ReadonlyArray<readonly [string, readonly ReviewerEvaluation[]]> = [
		["Approvals", buckets.approvals],
		["Changes requested / blocked", buckets.changesRequested],
		["Unknown / failed", buckets.unknownOrFailed],
		["Weak evidence", buckets.weakEvidence],
		["Prompt-only caveats", buckets.promptOnlyCaveats],
		["Unresolved risks", buckets.unresolvedRisks],
		["Provisional caveats", buckets.provisionalCaveats],
	];
	const lines: string[] = [
		`# Reviewer memo${input.planId ? ` for ${input.planId}` : ""}${input.phase ? ` (${input.phase})` : ""}`,
		"",
		`- required roles: ${input.rolesRequired && input.rolesRequired.length > 0 ? input.rolesRequired.join(", ") : "(none)"}`,
		`- docs/config in scope: ${input.docsConfigInScope ? "yes" : "no"}`,
		`- supplemental goals: ${input.supplementalGoals && input.supplementalGoals.length > 0 ? input.supplementalGoals.join("; ") : "(none)"}`,
	];
	if (missingRequired.length > 0) {
		lines.push(
			`- **MISSING REQUIRED ROLES**: ${missingRequired.join(", ")} (no evaluation supplied; treat as blocker)`,
			"",
		);
	} else {
		lines.push("");
	}
	for (const [label, list] of sections) {
		lines.push(`## ${label}`);
		lines.push(list.length > 0 ? list.map(formatEvaluationBlock).join("\n\n") : "_(none)_");
		lines.push("");
	}
	lines.push("## Final recommendation", finalRecommendation, "");
	return {
		planId: input.planId,
		phase: input.phase,
		approved,
		finalRecommendation,
		...buckets,
		markdown: lines.join("\n"),
		supplementalGoals: input.supplementalGoals ?? [],
		docsConfigInScope: input.docsConfigInScope ?? false,
		rolesRequired: input.rolesRequired ?? [],
		missingRequiredRoles: missingRequired,
	};
}

/** Derive targets, evaluate a list of reviewer results aligned to those targets, and
 *  return the consolidated memo. Missing `results` entries are reported as UNKNOWN blockers. */
export function buildReviewerMemoForResults(
	plan: ReviewerRolePlanShape | WorkflowArchitecturePlan | null | undefined,
	phase: string | undefined,
	results: ReviewerResultLike[],
	options: DeriveReviewerRoleTargetsOptions = {},
): { derivation: ReviewerRoleDerivation; evaluations: ReviewerEvaluation[]; memo: ReviewerMemo } {
	const derivation = deriveReviewerRoleTargets(plan, options);
	const evaluations: ReviewerEvaluation[] = [];
	for (let i = 0; i < derivation.targets.length; i += 1) {
		const roleTarget = derivation.targets[i];
		if (!roleTarget) continue;
		const result = results[i] ?? { verdict: "UNKNOWN" as const, status: "failed" as const, finalOutput: "(no reviewer result provided)" };
		evaluations.push(evaluateReviewerResult(roleTarget, result));
	}
	const memo = consolidateReviewerMemo({
		planId: plan?.planId,
		phase,
		evaluations,
		supplementalGoals: derivation.supplementalGoals,
		docsConfigInScope: derivation.docsConfigInScope,
		rolesRequired: derivation.rolesRequired,
	});
	return { derivation, evaluations, memo };
}

/** Map a `ReviewerEvaluation` back onto a `ReviewerTargetResult` so Phase B can carry
 *  role metadata on the swarm result shape. */
export function toReviewerTargetResult(
	roleTarget: ReviewerRoleTarget,
	evaluation: ReviewerEvaluation,
	delegateResult?: DelegateRunResult,
): ReviewerTargetResult {
	return {
		target: roleTarget.target,
		verdict: evaluation.effectiveVerdict,
		status: delegateResult
			? (delegateResult.aborted ? "aborted" : (delegateResult.exitCode === 0 ? "completed" : "failed"))
			: "completed",
		result: delegateResult,
		role: roleTarget.role,
		required: roleTarget.required,
		effectiveVerdict: evaluation.effectiveVerdict,
		provisional: evaluation.provisional,
		blockingReasons: evaluation.blockingReasons,
		weakEvidence: evaluation.weakEvidence,
		promptOnlyCaveats: evaluation.promptOnlyCaveats,
		unresolvedRisks: evaluation.unresolvedRisks,
		roleTarget,
	};
}
