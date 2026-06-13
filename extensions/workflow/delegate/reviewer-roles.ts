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
import { extractCanonicalEvidence, type CanonicalExtraction } from "./canonical-evidence";

// ---------- Constants ----------

/** Closed set of reviewer role ids; aligned with `ReviewerRole`. */
export const REVIEWER_ROLE_IDS: readonly ReviewerRole[] = [
	"implementation", "evidence-test", "behavior", "regression", "maintainability", "docs-config",
] as const;

/** Default required role set for a non-trivial matrix-gated plan. */
export const DEFAULT_NON_TRIVIAL_REQUIRED_ROLES: readonly ReviewerRole[] = [
	"behavior", "evidence-test", "implementation", "maintainability", "regression",
] as const;

const DOCS_CONFIG_HINTS: readonly string[] = [
	"readme", "docs/", "documentation", "example", "examples/", "config",
	"configuration", "workflow.quality-gates", "workflow.json", "settings.json",
];
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
		for (const hint of DOCS_CONFIG_HINTS) if (lower.includes(hint)) { signals.push(`${kind}:${hint}`); return; }
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
	s.push("- Start your response with `APPROVED` or `CHANGES_REQUESTED` as the first token.");
	s.push("- If the role's hard rules or blocking conditions apply, you MUST return `CHANGES_REQUESTED` with the specific reason and the file/line where the issue occurs.");
	s.push("- Free-form completion (no APPROVED/CHANGES_REQUESTED prefix) is provisional and does NOT satisfy the role; Brain will treat it as a blocker for required roles.");
	s.push("- Do not validate, approve, or critique Brain-owned plan quality. Focus only on implementation diffs, behavior, evidence, and the role criteria above.");
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Check whether a candidate value is a typed reviewer-evidence object with
 *  meaningful content. A payload is considered typed when ANY of the
 *  following holds:
 *    - non-empty `criterionCoverage` (typed evidence row);
 *    - non-empty `commandsRun` (typed command outcomes);
 *    - a CHANGES_REQUESTED canonical verdict (`verdict` /
 *      `effectiveVerdict`) paired with non-empty `blockingReasons`
 *      (a typed rejection that does not need separate coverage rows
 *      to be authoritative under the canonical-only contract).
 *  Bare `{ present: true }` / `{ explicitDeclaration: true }` objects
 *  without any of the above are intentionally NOT accepted. */
function isTypedReviewerEvidenceObject(value: unknown): boolean {
	const record = asRecord(value);
	if (!record) return false;
	if (hasNonEmptyCriterionCoverage(record.criterionCoverage)) return true;
	if (hasNonEmptyCommandOutcomes(record.commandsRun)) return true;
	const verdict = record.effectiveVerdict ?? record.verdict;
	if (verdict === "CHANGES_REQUESTED") {
		if (Array.isArray(record.blockingReasons)) {
			for (const reason of record.blockingReasons) {
				if (typeof reason === "string" && reason.trim().length > 0) return true;
			}
		}
	}
	return false;
}

/** Result of resolving explicit structured reviewer evidence from a
 *  reviewer-result-like input. Under the TASK-002 HARD-CUT, the
 *  resolver is a pure canonical envelope parser: `found` is true ONLY
 *  when a typed reviewer payload (non-empty `criterionCoverage` or
 *  `commandsRun`) is located on a CANONICAL envelope
 *  (`details.evidence` or `details.done.evidence` / `done.evidence`).
 *  Legacy sidecar fields (`input.reviewerEvidence`,
 *  `details.done.coderEvidence`, `details.done.reviewerEvidence`,
 *  parseable `details.done.summary` JSON, etc.) are NOT a fallback
 *  authority: the resolver returns `found: false` and `provenance:
 *  "none"` for them, and the role evaluator must downgrade the role
 *  to `CHANGES_REQUESTED` / `provisional` when no canonical reviewer
 *  evidence is found. The previous `legacyAdaptersUsed` accounting
 *  has been DELETED along with the legacy-import adapter bridge. */
export interface ResolvedReviewerExplicitEvidence {
	found: boolean;
	provenance: "canonical" | "none";
	mirroredReviewerEvidence: unknown | undefined;
	warnings: string[];
	/** TASK-002 hard-cut: number of legacy-import adapter calls performed
	 *  by the resolver. Always `0` under the canonical-only contract (the
	 *  legacy adapter no longer runs from the resolver). Retained as a
	 *  stable structured field so callers and smoke tests can assert the
	 *  resolver is canonical-only. */
	legacyAdaptersUsed: number;
}

export interface ResolveReviewerExplicitEvidenceOptions {
	runId?: string;
	now?: string;
	deliveryContextFactory?: (runId: string) => { runId: string };
}

/** Resolve typed reviewer evidence from a `ReviewerResultLike` using
 *  canonical-only precedence. The resolver is a pure canonical envelope
 *  parser: it inspects `details.evidence` and `details.done.evidence`
 *  (i.e. canonical envelopes attached directly to the result, or
 *  parsed from a done sidecar) and looks for a typed
 *  `reviewer_evidence` payload (non-empty `criterionCoverage` or
 *  `commandsRun`). All legacy / free-form / summary-JSON /
 *  nested-delegateHistory inputs are refused: the resolver returns
 *  `found: false` and `provenance: "none"` so the role evaluator
 *  treats the role as `provisional` and downgrades to
 *  `CHANGES_REQUESTED` (or `UNKNOWN` when no verdict is supplied). */
export function resolveReviewerExplicitEvidence(
	input: ReviewerResultLike,
	_options: ResolveReviewerExplicitEvidenceOptions = {},
): ResolvedReviewerExplicitEvidence {
	const details = asRecord(input.details);
	const done = asRecord(details?.done);
	// Canonical path: walk the well-known envelope locations.
	const candidates: unknown[] = [
		details?.evidence,
		done?.evidence,
	];
	for (const candidate of candidates) {
		if (candidate === undefined || candidate === null) continue;
		const extracted: CanonicalExtraction = extractCanonicalEvidence(candidate);
		if (extracted.provenance === "canonical" && isTypedReviewerEvidenceObject(extracted.reviewerEvidence)) {
			return {
				found: true,
				provenance: "canonical",
				mirroredReviewerEvidence: extracted.reviewerEvidence,
				warnings: extracted.warnings.slice(),
				legacyAdaptersUsed: 0,
			};
		}
	}
	// TASK-002 HARD-CUT: legacy paths (input.reviewerEvidence,
	// details.reviewerEvidence, details.done.reviewerEvidence,
	// details.done.coderEvidence, nested delegateHistory.reviewerEvidence,
	// details.done.summary) are NOT canonical. The resolver returns
	// `found: false` and `provenance: "none"` so the role evaluator
	// downgrades the role to provisional / CHANGES_REQUESTED. The
	// resolver never invokes the legacy-import adapter under the
	// hard-cut, so `legacyAdaptersUsed` is always `0`.
	return { found: false, provenance: "none", mirroredReviewerEvidence: undefined, warnings: [], legacyAdaptersUsed: 0 };
}

function isProvisionalCompletionSource(source: DelegateCompletionSource | string | undefined): boolean {
	return source === "auto_exit" || source === "process_exit" || source === "missing" || source === "legacy";
}

// ---------- Canonical reviewer-verdict helpers (TASK-002 hard-cut) ----------
//
// The reviewer role gate must derive its verdict from the canonical
// `reviewerEvidence.verdict` / `effectiveVerdict` schema on a
// `details.evidence` / `details.done.evidence` / `done.evidence`
// envelope. `input.verdict` (parsed final output) is diagnostic only
// and is NEVER approval authority. The helpers below let
// `evaluateReviewerResult` walk the canonical payload, fold typed
// arrays into the evaluation, and refuse any other shape.

/** Closed set of canonical reviewer-verdict tokens. `UNKNOWN` is
 *  included so the helper has a stable return type that maps to the
 *  evaluation's verdict/effectiveVerdict union. */
type ReviewerVerdictToken = "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";

/** Narrow a value to a canonical reviewer-verdict token. Returns
 *  `undefined` for any value that is not one of the exact strings
 *  `"APPROVED"`, `"CHANGES_REQUESTED"`, or `"UNKNOWN"`. The check is
 *  intentionally strict (no coercion, no lowercasing): the canonical
 *  envelope stores these tokens verbatim and the gate must not
 *  accept language-localized approval phrases. */
function asReviewerVerdict(value: unknown): ReviewerVerdictToken | undefined {
	if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "UNKNOWN") return value;
	return undefined;
}

/** Return the trimmed strings from a candidate array value. Non-string
 *  elements, empty strings, and non-array values are filtered out.
 *  Used to fold canonical arrays (`blockingReasons`, `weakEvidence`,
 *  `promptOnlyCaveats`, `unresolvedRisks`) from the reviewer-evidence
 *  payload into the evaluation. */
function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed.length > 0) out.push(trimmed);
	}
	return out;
}

/** Pick the canonical reviewer-verdict token from a candidate
 *  reviewer-evidence record. `effectiveVerdict` wins over `verdict`
 *  when both are present; the result is narrowed through
 *  `asReviewerVerdict` so any non-token value (language-localized
 *  phrase, free-form text, malformed payload) returns `undefined`.
 *  This is the ONLY path that should ever set approval authority
 *  inside `evaluateReviewerResult`. */
function pickCanonicalReviewerEvidenceVerdict(value: unknown): ReviewerVerdictToken | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const effective = asReviewerVerdict(record.effectiveVerdict);
	if (effective !== undefined) return effective;
	return asReviewerVerdict(record.verdict);
}

/** Evaluate a single reviewer result against a role target. */
export function evaluateReviewerResult(
	roleTarget: ReviewerRoleTarget,
	input: ReviewerResultLike,
): ReviewerEvaluation {
	const output = typeof input.finalOutput === "string" ? input.finalOutput : "";
	// `inputVerdict` is parsed from the final text prefix and is
	// diagnostic only under the TASK-002 hard-cut. Approval authority
	// belongs to the canonical `reviewerEvidence.verdict` /
	// `effectiveVerdict` schema on the canonical envelope.
	const inputVerdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN" = input.verdict ?? "UNKNOWN";
	const status = input.status ?? (inputVerdict === "APPROVED" || inputVerdict === "CHANGES_REQUESTED" ? "completed" : "unknown");
	const failed = status === "failed" || status === "aborted";
	const provisionalSource = isProvisionalCompletionSource(input.completionSource);
	const resolvedEvidence = resolveReviewerExplicitEvidence(input);
	const explicitEvidence = resolvedEvidence.found;
	// Canonical verdict authority (TASK-002 hard-cut):
	//   1. If the canonical envelope carries `effectiveVerdict` or
	//      `verdict`, that token is the authority.
	//   2. Otherwise, an input/final-text CHANGES_REQUESTED still
	//      blocks (it is the safer fail-closed choice for an
	//      inconsistent legacy fixture).
	//   3. Otherwise the role is UNKNOWN — final-text APPROVED never
	//      approves without canonical reviewerEvidence under the
	//      hard-cut contract.
	const canonicalRecord = asRecord(resolvedEvidence.mirroredReviewerEvidence);
	const canonicalVerdict = pickCanonicalReviewerEvidenceVerdict(canonicalRecord);
	const baseVerdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN" = canonicalVerdict
		?? (inputVerdict === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : "UNKNOWN");
	// `finalTextApprovalClaimed` records whether the parsed final-text
	// prefix asserted APPROVED. Under the TASK-002 hard-cut, final text
	// is diagnostic only and NEVER approval authority (canonical
	// `reviewerEvidence.verdict` / `effectiveVerdict` is the only path
	// that approves a role). The flag is used to keep the
	// source-string / prompt-only diagnostic paths alive when the
	// canonical verdict is missing or UNKNOWN but the final text
	// claimed APPROVED — those diagnostics must still surface as
	// blockers / weak evidence / caveats so the memo records the
	// degrade, even though they cannot upgrade the verdict.
	const finalTextApprovalClaimed = inputVerdict === "APPROVED";

	const blockingReasons: string[] = [];
	const weakEvidence: string[] = [];
	const promptOnlyCaveats: string[] = [];
	const unresolvedRisks: string[] = [];
	const notes: string[] = [];

	// Fold canonical arrays from the typed reviewer-evidence envelope
	// into the evaluation. These are the structured counterparts of
	// the parsed final-text heuristics below and are the
	// gate-authoritative inputs for the canonical verdict path.
	if (canonicalRecord) {
		blockingReasons.push(...asStringList(canonicalRecord.blockingReasons));
		weakEvidence.push(...asStringList(canonicalRecord.weakEvidence));
		promptOnlyCaveats.push(...asStringList(canonicalRecord.promptOnlyCaveats));
		unresolvedRisks.push(...asStringList(canonicalRecord.unresolvedRisks));
	}

	if (failed) blockingReasons.push(`Reviewer status is ${status}.`);
	if (roleTarget.required && baseVerdict === "UNKNOWN") {
		blockingReasons.push(
			"Reviewer verdict is UNKNOWN; canonical reviewerEvidence verdict/effectiveVerdict is missing on the canonical `done.evidence` envelope (final text and free-form prose are diagnostic only and never satisfy role-gated approval).",
		);
	}
	if (provisionalSource) {
		if (!explicitEvidence) {
			blockingReasons.push(`Completion source is ${String(input.completionSource)} without explicit structured reviewer evidence; required role is provisional.`);
			notes.push("provisional: no structured reviewer evidence present");
		} else {
			notes.push(`Completion source is ${String(input.completionSource)} but explicit structured reviewer evidence is present; provisional flag suppressed.`);
		}
	}
	// TASK-002 HARD-CUT: the legacy-import adapter no longer runs from
	// the resolver, so there are no `legacyAdaptersUsed` accounting
	// markers and no legacy-adapter warnings to surface here. The
	// resolver returns `provenance: "canonical"` when the typed
	// reviewer evidence came from a canonical envelope, otherwise
	// `provenance: "none"`. The note preserves the diagnostic surface
	// so the memo / notes can still show which path the resolver took.
	if (resolvedEvidence.provenance === "canonical") {
		notes.push("reviewer evidence resolved via canonical envelope; legacy import adapter not used (TASK-002 hard-cut)");
	} else {
		notes.push("reviewer evidence absent; no canonical envelope found (TASK-002 hard-cut)");
	}
	if ((baseVerdict === "APPROVED" || finalTextApprovalClaimed) && (roleTarget.role === "behavior" || roleTarget.role === "evidence-test" || roleTarget.role === "regression")) {
		// TASK-002 (TIGHTENED): for behavior / evidence-test / regression
		// roles on runtime-behavior scope, an APPROVED result MUST carry
		// canonical typed reviewer evidence (non-empty `criterionCoverage`
		// or `commandsRun` on the canonical envelope). Free-form English
		// / non-English prose — even phrases like "test passed" or
		// "exit code 0" — is diagnostic only and CANNOT satisfy the
		// fail-closed gate. Source-string / static-only /
		// read-the-source / skipped-running / no-runtime-run phrasing
		// remains an additional blocker; both are required to be absent
		// for an APPROVED role to stay APPROVED. The diagnostic
		// condition also fires when the final text claimed APPROVED
		// (finalTextApprovalClaimed) but the canonical verdict is
		// missing or UNKNOWN, so the source-string / prompt-only
		// downgrade path is preserved even when baseVerdict is
		// UNKNOWN — the diagnostic adds blockers / weak evidence /
		// caveats but does NOT make final text an approval authority.
		if (hasRuntimeBehaviorScope(roleTarget)) {
			const isStaticOnly = isSourceStringOnlyEvidence(output);
			if (isStaticOnly && !explicitEvidence) {
				blockingReasons.push(
					"Reviewer output relies on source-string / static-only / read-the-source / skipped-running / no-runtime-run evidence for a TUI/runtime-behavior criterion, even though it also contains a positive phrase; required role is downgraded to CHANGES_REQUESTED.",
				);
				weakEvidence.push("source-string / static-only / read-the-source / skipped-running / no-runtime-run evidence claimed for runtime-behavior scope");
			} else if (!explicitEvidence) {
				// Under the tightened contract, positive runtime phrases
				// like "test passed" / "exit code 0" are NOT sufficient.
				// Canonical typed reviewer evidence is the only path
				// that satisfies the role. The diagnostic message names
				// the missing authority so operators see what the gate
				// actually needs.
				const reasonSuffix = isStaticOnly
					? "code-walk / source-inspection evidence only; no canonical typed reviewer evidence (criterionCoverage / commandsRun on the canonical `done.evidence` envelope)"
					: "no canonical typed reviewer evidence (criterionCoverage / commandsRun on the canonical `done.evidence` envelope); free-form final text is diagnostic only and never sufficient for matrix-gated reviewer work";
				blockingReasons.push(`Reviewer output relies on ${reasonSuffix} for a TUI/runtime-behavior criterion. Required role is downgraded to CHANGES_REQUESTED.`);
				weakEvidence.push(`${reasonSuffix} claimed for runtime-behavior scope`);
			}
		}
	}
	if ((baseVerdict === "APPROVED" || finalTextApprovalClaimed) && hasRuntimeBehaviorScope(roleTarget) && isPromptOnlyCaveatFromMatrix(roleTarget, output)) {
		// Final-text APPROVED is diagnostic only — the prompt-only
		// caveat still fires (and adds a blocker / caveat) so the
		// memo records the degrade, but it cannot promote the role
		// to APPROVED. Canonical verdict authority is unchanged.
		blockingReasons.push("Reviewer output approves a prompt-only / instructions-only mitigation for runtime behavior. Required role is downgraded to CHANGES_REQUESTED.");
		promptOnlyCaveats.push("prompt-only runtime mitigation observed");
	}
	if (roleTarget.required && baseVerdict === "CHANGES_REQUESTED") {
		if (canonicalVerdict === "CHANGES_REQUESTED") {
			blockingReasons.push("Reviewer returned CHANGES_REQUESTED (canonical reviewerEvidence verdict authority).");
		} else if (!blockingReasons.some((r) => r === "Reviewer returned CHANGES_REQUESTED.")) {
			blockingReasons.push("Reviewer returned CHANGES_REQUESTED.");
		}
	}
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
