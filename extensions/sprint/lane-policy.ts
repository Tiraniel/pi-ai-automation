#!/usr/bin/env node
// TASK-011 Phase A — three-lane automation policy (pure, no fs/tooling).
// Owns lane vocabulary, hotfix kinds, debug next-lane enum, lane-risk codes, and evaluateLanePolicy(input) -> LaneDecision plus small accessors; isolated so other modules can import lane policy without pulling fs or runtime helpers.
export type AutomationLane = "full-sprint" | "hotfix" | "debug";

export const ALL_AUTOMATION_LANES: readonly AutomationLane[] = [
	"full-sprint",
	"hotfix",
	"debug",
];

export function isAutomationLane(value: unknown): value is AutomationLane {
	return value === "full-sprint" || value === "hotfix" || value === "debug";
}

export type HotfixKind = "code-changing" | "text-evidence-only";

export const ALL_HOTFIX_KINDS: readonly HotfixKind[] = [
	"code-changing",
	"text-evidence-only",
];

export type DebugNextLane = "hotfix" | "full-sprint" | "no-code/report-only";

export const ALL_DEBUG_NEXT_LANES: readonly DebugNextLane[] = [
	"hotfix",
	"full-sprint",
	"no-code/report-only",
];

export function isDebugNextLane(value: unknown): value is DebugNextLane {
	return value === "hotfix" || value === "full-sprint" || value === "no-code/report-only";
}

export type LaneStatus =
	| "allow"
	| "block"
	| "promote"
	| "review-required"
	| "evidence-only";

export type LaneRiskCode =
	| "scope-expansion"
	| "file-threshold"
	| "loc-threshold"
	| "multiple-behavior-paths"
	| "architecture-state-schema-refactor"
	| "unclear-root-cause"
	| "repeated-same-area"
	| "reviewer-broader-risk"
	| "missing-text-refs"
	| "missing-validation-evidence"
	| "text-classification-uncertain"
	| "full-sprint-confirmation-missing"
	| "full-sprint-architecture-missing"
	| "full-sprint-implementation-confirmation-missing"
	| "debug-diagnosis-missing"
	| "debug-next-lane-missing"
	| "debug-implementation-without-selected-lane"
	| "unauthorized-remote-action"
	| "invalid-lane"
	| "invalid-debug-recommendation"
	| "debug-implementation-with-report-only-selection";

export interface LaneThresholds {
	filesChanged: number; // > triggers file-threshold
	locChanged: number; // > triggers loc-threshold
	behaviorPaths: number; // > triggers multiple-behavior-paths
	repeatAreaThreshold: number; // >= triggers repeated-same-area
}

export const DEFAULT_LANE_THRESHOLDS: LaneThresholds = {
	filesChanged: 2,
	locChanged: 50,
	behaviorPaths: 1,
	repeatAreaThreshold: 2,
};

export interface LaneConfirmations {
	prdReady?: boolean;
	sprintAuthorized?: boolean;
	architectureApproved?: boolean;
	implementationConfirmed?: boolean;
}

export type TextOnlyClassification = "docs" | "prompt-template" | "typo" | "other" | "uncertain";

export interface LanePolicyInput {
	// selection
	lane: AutomationLane;
	hotfixKind?: HotfixKind;
	thresholds?: Partial<LaneThresholds>;
	// full-sprint gates
	confirmations?: LaneConfirmations;
	// hotfix scope
	scopeStatement?: string;
	changedFiles?: string[];
	changedLOC?: number;
	behaviorPaths?: number;
	architectureStateSchemaOrRefactor?: boolean;
	rootCauseClear?: boolean;
	repeatedSameAreaFixCount?: number;
	reviewerBroaderRisk?: boolean;
	// text-evidence-only
	textOnlyClass?: TextOnlyClassification;
	textOnlyConcreteRefs?: string[];
	textOnlyValidationEvidence?: string[];
	// debug
	diagnosis?: string;
	rootCauseHypothesis?: string;
	affectedFiles?: string[];
	riskAssessment?: string;
	recommendedNextLane?: DebugNextLane;
	selectedNextLane?: DebugNextLane;
	debugImplementationAttempt?: boolean;
	// remote action guard (used to assert default deny)
	requestedRemoteAction?: "push" | "pr" | "deploy" | "destructive" | "credentialed";
	remoteActionAuthorized?: boolean;
}

export interface LaneDecision {
	lane: AutomationLane;
	hotfixKind?: HotfixKind;
	status: LaneStatus;
	// full-sprint gate requirements
	requiresPlanningGate: boolean;
	requiresArchitectureGate: boolean;
	requiresImplementationConfirmation: boolean;
	// reviewer / evidence-only flags
	reviewerRequired: boolean;
	evidenceOnly: boolean;
	// recommended next lane when promoting
	recommendedNextLane?: DebugNextLane;
	// diagnostics
	riskCodes: LaneRiskCode[];
	blockers: string[];
	warnings: string[];
	summary: string;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

// Path heuristics for text-evidence-only classification. Conservative: any path that looks like code/control-flow (code file extension or code dir like `extensions/`/`src/`) is ALWAYS refused for evidence-only, regardless of `textOnlyClass` or whether the path name contains `prompt`/`template`. The textOnlyClass=='prompt-template' shortcut for code files was a known reviewer blocker (task-011 review fix #4) and is removed here: prompt/template text edits that live in TS source are not text-only, they are code-changing.
const CODE_FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|cts|mts|py|go|rs|java|c|cpp|cc|cxx|h|hpp|rb|php|swift|kt|scala|sh|bash|zsh|fish|ps1|psm1|sql|css|scss|sass|less|vue|svelte|astro|graphql|gql)$/i;
const CODE_DIR_RE = /(^|\/)(src|extensions|lib|libs|app|packages|bin|scripts|test|tests|spec|__tests__|dist|build|out|target|node_modules|vendor|internal|cmd|pkg|module|modules|core|server|client|api|routes|middleware|services|controllers|models|views|components|hooks|utils|helpers)\//i;
const DOCS_RE = /(^|\/)(docs?|documentation|guides?|specs?|readme|changelog|notes?|examples?)\//i;
const README_RE = /(^|\/)README/i;
const DOCS_EXT_RE = /\.(md|markdown|mdx|txt|rst|adoc|asciidoc)$/i;
const PROMPT_PACK_EXT_RE = /\.(prompt|template|tmpl)$/i;

function isCodeLookingPath(p: string): boolean {
	return isNonEmptyString(p) && (CODE_FILE_EXT_RE.test(p) || CODE_DIR_RE.test(p));
}
function isDocsOrTypoPath(p: string): boolean {
	return isNonEmptyString(p) && (DOCS_EXT_RE.test(p) || DOCS_RE.test(p) || README_RE.test(p));
}
// True for non-code prompt/template artifact paths (true markdown/text prompt packs, not .ts/.tsx in code dirs). Used only for diagnostics in the blocker text; the path-class guard itself uses `isCodeLookingPath` which is strict by design.
function isNonCodePromptTemplatePath(p: string): boolean {
	if (!isNonEmptyString(p)) return false;
	if (isCodeLookingPath(p)) return false;
	return PROMPT_PACK_EXT_RE.test(p) || DOCS_RE.test(p) || README_RE.test(p) || DOCS_EXT_RE.test(p);
}

// Strip the `#line/section` suffix from a ref like "src/app.ts#L42" → "src/app.ts". Only the file portion of a text-only ref is inspected for the code/control-flow guard.
function stripRefLineSection(ref: string): string {
	if (!isNonEmptyString(ref)) return "";
	return ref.replace(/#.*$/, "").trim();
}

function normalizeThresholds(input?: Partial<LaneThresholds>): LaneThresholds {
	const t = input ?? {};
	return {
		filesChanged: Number.isFinite(Number(t.filesChanged)) ? Math.max(0, Math.floor(Number(t.filesChanged))) : DEFAULT_LANE_THRESHOLDS.filesChanged,
		locChanged: Number.isFinite(Number(t.locChanged)) ? Math.max(0, Math.floor(Number(t.locChanged))) : DEFAULT_LANE_THRESHOLDS.locChanged,
		behaviorPaths: Number.isFinite(Number(t.behaviorPaths)) ? Math.max(1, Math.floor(Number(t.behaviorPaths))) : DEFAULT_LANE_THRESHOLDS.behaviorPaths,
		repeatAreaThreshold: Number.isFinite(Number(t.repeatAreaThreshold)) ? Math.max(1, Math.floor(Number(t.repeatAreaThreshold))) : DEFAULT_LANE_THRESHOLDS.repeatAreaThreshold,
	};
}

function countChangedFiles(input: LanePolicyInput): number {
	if (Array.isArray(input.changedFiles)) return input.changedFiles.length;
	return 0;
}

function countRepeatedSameArea(input: LanePolicyInput, threshold: number): number {
	const value = Number(input.repeatedSameAreaFixCount);
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function evaluateFullSprintLane(input: LanePolicyInput, decision: LaneDecision): void {
	const confirmations = input.confirmations ?? {};
	decision.requiresPlanningGate = true;
	decision.requiresArchitectureGate = true;
	decision.requiresImplementationConfirmation = true;
	decision.reviewerRequired = true;
	decision.evidenceOnly = false;

	if (!confirmations.prdReady || !confirmations.sprintAuthorized) {
		decision.riskCodes.push("full-sprint-confirmation-missing");
		decision.blockers.push("Full-sprint lane requires PRD-ready and sprint-authorized confirmations.");
	}
	if (!confirmations.architectureApproved) {
		decision.riskCodes.push("full-sprint-architecture-missing");
		decision.blockers.push("Full-sprint lane requires architecture/evidence-matrix approval.");
	}
	if (!confirmations.implementationConfirmed) {
		decision.riskCodes.push("full-sprint-implementation-confirmation-missing");
		decision.blockers.push("Full-sprint lane requires explicit implementation confirmation.");
	}

	decision.summary = `Full-sprint lane: PRD/architecture/implementation gates must all be confirmed.`;
}

function evaluateHotfixScope(input: LanePolicyInput, decision: LaneDecision, thresholds: LaneThresholds): void {
	if (!isNonEmptyString(input.scopeStatement)) {
		decision.riskCodes.push("scope-expansion");
		decision.blockers.push("Hotfix lane requires an explicit scope statement.");
	}

	const filesChanged = countChangedFiles(input);
	if (filesChanged > thresholds.filesChanged) {
		decision.riskCodes.push("file-threshold");
		decision.blockers.push(`Hotfix touches ${filesChanged} files; >${thresholds.filesChanged}-file threshold.`);
	}

	const locChanged = Number.isFinite(Number(input.changedLOC)) ? Math.max(0, Math.floor(Number(input.changedLOC))) : 0;
	if (locChanged > thresholds.locChanged) {
		decision.riskCodes.push("loc-threshold");
		decision.blockers.push(`Hotfix touches ${locChanged} LOC; >${thresholds.locChanged}-LOC threshold.`);
	}

	const behaviorPaths = Number.isFinite(Number(input.behaviorPaths)) ? Math.max(0, Math.floor(Number(input.behaviorPaths))) : 0;
	if (behaviorPaths > thresholds.behaviorPaths) {
		decision.riskCodes.push("multiple-behavior-paths");
		decision.blockers.push(`Hotfix spans ${behaviorPaths} behavior paths; >${thresholds.behaviorPaths}-path threshold.`);
	}

	if (input.architectureStateSchemaOrRefactor) {
		decision.riskCodes.push("architecture-state-schema-refactor");
		decision.blockers.push("Hotfix touches architecture/state-machine/schema/persistence/refactor surface; promote to full sprint.");
	}

	if (input.rootCauseClear === false) {
		decision.riskCodes.push("unclear-root-cause");
		decision.blockers.push("Hotfix requires clear root cause; otherwise promote to full sprint or debug first.");
	}

	const repeated = countRepeatedSameArea(input, thresholds.repeatAreaThreshold);
	if (repeated >= thresholds.repeatAreaThreshold) {
		decision.riskCodes.push("repeated-same-area");
		decision.blockers.push(`Hotfix is part of a repeated same-area chain (${repeated} prior fixes); promote to full sprint.`);
	}

	if (input.reviewerBroaderRisk) {
		decision.riskCodes.push("reviewer-broader-risk");
		decision.blockers.push("Reviewer flagged the change as broader/riskier than expected; promote to full sprint.");
	}
}

function evaluateTextEvidenceOnlyHotfix(input: LanePolicyInput, decision: LaneDecision): void {
	const textClass = input.textOnlyClass ?? "uncertain";
	const requireReviewerFor = (code: LaneRiskCode, blocker: string) => {
		decision.reviewerRequired = true;
		decision.evidenceOnly = false;
		decision.riskCodes.push(code);
		decision.blockers.push(blocker);
	};
	if (textClass === "uncertain" || textClass === "other") {
		requireReviewerFor("text-classification-uncertain", "Text-only classification is uncertain; require reviewer or promote to full sprint.");
		return;
	}
	const refs = Array.isArray(input.textOnlyConcreteRefs) ? input.textOnlyConcreteRefs.filter((ref) => isNonEmptyString(ref)) : [];
	const evidence = Array.isArray(input.textOnlyValidationEvidence) ? input.textOnlyValidationEvidence.filter((e) => isNonEmptyString(e)) : [];
	if (refs.length === 0) {
		requireReviewerFor("missing-text-refs", "Text-only hotfix requires concrete changed refs (files/sections/lines).");
	}
	if (evidence.length === 0) {
		requireReviewerFor("missing-validation-evidence", "Text-only hotfix requires validation evidence (static check, render, smoke).");
	}
	if (refs.length === 0 || evidence.length === 0) return;

	// Path-class guard: text-only evidence-only is NEVER allowed for code/control-flow files, even if the file name contains `prompt`/`template` or the classification is `prompt-template`. This blocks reviewer-free text-evidence-only for paths like `extensions/sprint/prompt.ts#...` while still allowing true non-code prompt/template artifacts (e.g. `examples/prompt-packs/brain-orchestrator-core.md#...`). Inspect both `changedFiles` and `textOnlyConcreteRefs` (stripping any `#...` line/section suffix) so a typo'd `src/foo.ts#L1` ref is still rejected.
	const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles.filter((f) => isNonEmptyString(f)) : [];
	const refPaths = refs.map(stripRefLineSection).filter((ref) => isNonEmptyString(ref));
	const codeLooking = (f: string): boolean => isCodeLookingPath(f);
	const offendingFiles = changedFiles.filter(codeLooking);
	const offendingRefs = refPaths.filter(codeLooking);
	if (offendingFiles.length > 0 || offendingRefs.length > 0) {
		const samples = [...offendingFiles, ...offendingRefs];
		requireReviewerFor(
			"text-classification-uncertain",
			`Text-only hotfix with textOnlyClass="${textClass}" cannot be evidence-only for code/control-flow files (extensions/ src/ .ts etc): ${samples.join(", ")}. Promote to code-changing hotfix or full sprint.`,
		);
		return;
	}

	decision.evidenceOnly = true;
	decision.reviewerRequired = false;
}

function evaluateHotfixLane(input: LanePolicyInput, decision: LaneDecision, thresholds: LaneThresholds): void {
	const kind: HotfixKind = input.hotfixKind === "text-evidence-only" ? "text-evidence-only" : "code-changing";
	decision.hotfixKind = kind;

	// Code-changing hotfix always requires reviewer by default and must not be evidence-only.
	if (kind === "code-changing") {
		decision.reviewerRequired = true;
		decision.evidenceOnly = false;
		decision.summary = "Hotfix (code-changing): reviewer required by default; evidence-only is not allowed.";
	} else {
		decision.reviewerRequired = false;
		decision.evidenceOnly = false;
		decision.summary = "Hotfix (text-evidence-only): reviewer-free only when classification is explicit AND refs/evidence are present.";
		evaluateTextEvidenceOnlyHotfix(input, decision);
	}

	// Promote triggers (must always be honored, even for text-evidence-only attempts).
	evaluateHotfixScope(input, decision, thresholds);
}

function evaluateDebugLane(input: LanePolicyInput, decision: LaneDecision): void {
	decision.requiresPlanningGate = false;
	decision.requiresArchitectureGate = false;
	decision.requiresImplementationConfirmation = false;
	decision.reviewerRequired = false;
	decision.evidenceOnly = false;

	const hasDiagnosis = isNonEmptyString(input.diagnosis) || isNonEmptyString(input.rootCauseHypothesis);
	if (!hasDiagnosis) {
		decision.riskCodes.push("debug-diagnosis-missing");
		decision.blockers.push("Debug lane requires a diagnosis / root-cause hypothesis before exiting the lane.");
	}

	// Runtime validation: recommendedNextLane must be exactly one of `hotfix|full-sprint|no-code/report-only` when provided.
	const rec = input.recommendedNextLane ?? null;
	if (rec === null) {
		decision.riskCodes.push("debug-next-lane-missing");
		decision.blockers.push("Debug lane must output a recommended next lane: hotfix, full-sprint, or no-code/report-only.");
	} else if (isDebugNextLane(rec)) {
		decision.recommendedNextLane = rec;
	} else {
		decision.riskCodes.push("invalid-debug-recommendation");
		decision.blockers.push(`Invalid recommendedNextLane "${String(rec)}"; must be exactly "hotfix", "full-sprint", or "no-code/report-only".`);
	}

	// Runtime validation: selectedNextLane must be a valid debug next lane.
	const sel = input.selectedNextLane ?? null;
	if (sel !== null && !isDebugNextLane(sel)) {
		decision.riskCodes.push("invalid-debug-recommendation");
		decision.blockers.push(`Invalid selectedNextLane "${String(sel)}"; must be exactly "hotfix", "full-sprint", or "no-code/report-only".`);
	}

	// Debug may not implement without a selected/promoted implementation lane.
	if (input.debugImplementationAttempt) {
		if (sel === null) {
			decision.riskCodes.push("debug-implementation-without-selected-lane");
			decision.blockers.push("Debug lane cannot perform broad implementation without an explicit selected/promoted next lane.");
		} else if (isReportOnlyDebugNextLane(sel)) {
			decision.riskCodes.push("debug-implementation-with-report-only-selection");
			decision.blockers.push("Debug lane cannot perform implementation: selectedNextLane is no-code/report-only.");
		} else if (!debugNextLaneAllowsImplementation(sel)) {
			decision.riskCodes.push("debug-implementation-without-selected-lane");
			decision.blockers.push(`Debug lane cannot perform broad implementation: selectedNextLane "${String(sel)}" is not an implementation lane.`);
		}
	}

	decision.summary = `Debug lane: diagnosis-first; recommended next lane = ${decision.recommendedNextLane ?? "unset"}.`;
}

export function isReportOnlyDebugNextLane(value: unknown): value is "no-code/report-only" {
	return value === "no-code/report-only";
}

export function debugNextLaneAllowsImplementation(value: DebugNextLane | undefined | null): boolean {
	return value === "hotfix" || value === "full-sprint";
}

export function defaultReviewerRequiredFor(lane: AutomationLane, hotfixKind?: HotfixKind): boolean {
	if (lane === "full-sprint") return true;
	if (lane === "hotfix" && hotfixKind === "text-evidence-only") return false;
	if (lane === "hotfix") return true; // code-changing default
	if (lane === "debug") return false;
	return true;
}

function evaluateRemoteActionGuard(input: LanePolicyInput, decision: LaneDecision): void {
	if (!input.requestedRemoteAction) return;
	if (input.remoteActionAuthorized) return;
	decision.riskCodes.push("unauthorized-remote-action");
	decision.blockers.push(`Remote action "${input.requestedRemoteAction}" is not authorized by default.`);
}

function finalizeDecision(decision: LaneDecision): void {
	if (decision.blockers.length > 0) {
		// Promotion-trigger style blockers always result in promote; missing-gate blockers block.
		const isPromoteOnly = decision.riskCodes.every((code) =>
			code === "scope-expansion"
			|| code === "file-threshold"
			|| code === "loc-threshold"
			|| code === "multiple-behavior-paths"
			|| code === "architecture-state-schema-refactor"
			|| code === "unclear-root-cause"
			|| code === "repeated-same-area"
			|| code === "reviewer-broader-risk"
			|| code === "text-classification-uncertain"
		);
		decision.status = isPromoteOnly ? "promote" : "block";
		return;
	}

	if (decision.reviewerRequired) {
		decision.status = "review-required";
		return;
	}
	if (decision.evidenceOnly) {
		decision.status = "evidence-only";
		return;
	}
	decision.status = "allow";
}

export function evaluateLanePolicy(input: LanePolicyInput): LaneDecision {
	const decision: LaneDecision = {
		lane: input.lane,
		status: "allow",
		requiresPlanningGate: false,
		requiresArchitectureGate: false,
		requiresImplementationConfirmation: false,
		reviewerRequired: false,
		evidenceOnly: false,
		riskCodes: [],
		blockers: [],
		warnings: [],
		summary: "",
	};
	// Runtime validation: fail closed if the lane is not exactly one of `full-sprint|hotfix|debug`. A typo or stray runtime value must not be silently treated as a valid lane.
	if (!isAutomationLane(input.lane)) {
		decision.riskCodes.push("invalid-lane");
		decision.blockers.push(
			`Invalid lane "${String(input.lane)}"; must be exactly "full-sprint", "hotfix", or "debug".`,
		);
		decision.status = "block";
		decision.summary = `Invalid lane "${String(input.lane)}"; lane policy refuses to evaluate.`;
		return decision;
	}
	const thresholds = normalizeThresholds(input.thresholds);

	switch (input.lane) {
		case "full-sprint":
			evaluateFullSprintLane(input, decision);
			break;
		case "hotfix":
			evaluateHotfixLane(input, decision, thresholds);
			break;
		case "debug":
			evaluateDebugLane(input, decision);
			break;
	}

	evaluateRemoteActionGuard(input, decision);
	finalizeDecision(decision);
	return decision;
}

export function requiresReviewer(decision: LaneDecision): boolean {
	return decision.reviewerRequired;
}

export function requiresPromotion(decision: LaneDecision): boolean {
	if (decision.status === "promote") return true;
	return decision.riskCodes.some((code) =>
		code === "scope-expansion"
		|| code === "file-threshold"
		|| code === "loc-threshold"
		|| code === "multiple-behavior-paths"
		|| code === "architecture-state-schema-refactor"
		|| code === "unclear-root-cause"
		|| code === "repeated-same-area"
		|| code === "reviewer-broader-risk"
		|| code === "text-classification-uncertain"
	);
}

export function buildLaneSummary(decision: LaneDecision): string {
	const header = `lane=${decision.lane} status=${decision.status}${decision.hotfixKind ? ` hotfixKind=${decision.hotfixKind}` : ""}`;
	const reviewer = decision.reviewerRequired ? " reviewer=required" : decision.evidenceOnly ? " reviewer=not-required(evidence-only)" : " reviewer=not-required";
	const next = decision.recommendedNextLane ? ` recommendedNextLane=${decision.recommendedNextLane}` : "";
	const codes = decision.riskCodes.length ? ` riskCodes=${decision.riskCodes.join(",")}` : "";
	return `${header}${reviewer}${next}${codes} | ${decision.summary}`;
}
