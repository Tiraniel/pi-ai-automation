#!/usr/bin/env node
// Sprint subsystem — pure debug escalation helper.

export type DebugEscalationAction =
	| "allow-debug-completion"
	| "promote-debug-item"
	| "promote-debug-item-with-root-cause"
	;

export type DebugEscalationRuleCode =
	| "DBG-001:core-file-threshold"
	| "DBG-002:loc-threshold"
	| "DBG-003:state-machine-or-architecture"
	| "DBG-004:multiple-behavior-paths"
	| "DBG-005:reviewer-evidence-missing"
	| "DBG-006:repeated-same-area"
	;

export type DebugItemStatus = "open" | "done" | "promoted";

export interface DebugEscalationRules {
	coreFilesThreshold: number;
	locThreshold: number;
	maxBehaviorPaths: number;	// escalation when behavior path count is above this value
	repeatAreaThreshold: number;	// escalate after this many prior done/promoted items in same area
}

export interface DebugEscalationRuleMatch {
	code: DebugEscalationRuleCode;
	summary: string;
}

export interface DebugLaneHistoryItem {
	id: string;
	title: string;	body?: string;
	status?: DebugItemStatus;
	area?: string;
}

export interface DebugEscalationInput {
	itemId?: string;
	itemTitle: string;	itemBody?: string;
	// explicit feature area wins over heuristics
	featureArea?: string;
	filesChanged?: number;
	locChanged?: number;
	behaviorPaths?: number;
	stateMachineOrArchitectureChange?: boolean;
	reviewerBehaviorEvidenceMissing?: boolean;	// explicit prior count or derive from history
	repeatedSameAreaFixCount?: number;
	history?: DebugLaneHistoryItem[];
	rules?: Partial<DebugEscalationRules>;
}

export interface DebugEscalationResult {
	itemId?: string;	itemTitle: string;	featureArea?: string;
	matchedRules: DebugEscalationRuleMatch[];
	suggestedAction: DebugEscalationAction;
	needsEscalation: boolean;	needsRootCauseTask: boolean;
	repeatedSameAreaFixCount: number;
	summary: string;	ruleCodes: DebugEscalationRuleCode[];
	acceptanceCriteria: string;
}

export interface DebugPromotionAppendix {
	contextSection: string;	acceptanceSection: string;
}

export const DEFAULT_DEBUG_ESCALATION_RULES: DebugEscalationRules = {
	coreFilesThreshold: 2,
	locThreshold: 50,
	maxBehaviorPaths: 1,
	repeatAreaThreshold: 2,
};

const RULE_DEFINITIONS: Record<DebugEscalationRuleCode, (result: DebugEscalationContext) => DebugEscalationRuleMatch | undefined> = {
	"DBG-001:core-file-threshold": (result) => result.filesChanged > result.thresholds.coreFilesThreshold
		? {
			code: "DBG-001:core-file-threshold",
			summary: `Touches ${result.filesChanged} files, exceeding the ${result.thresholds.coreFilesThreshold}-file core-file threshold for tiny debug.`,
		}
		: undefined,
	"DBG-002:loc-threshold": (result) => result.locChanged > result.thresholds.locThreshold
		? {
			code: "DBG-002:loc-threshold",
			summary: `Touches ${result.locChanged} changed LOC, exceeding the ${result.thresholds.locThreshold}-LOC threshold for tiny debug.`,
		}
		: undefined,
	"DBG-003:state-machine-or-architecture": (result) => result.stateMachineOrArchitectureChange
		? {
			code: "DBG-003:state-machine-or-architecture",
			summary: "Changes state-machine / navigation / architecture / persistence / schema behavior.",
		}
		: undefined,
	"DBG-004:multiple-behavior-paths": (result) => result.behaviorPaths > result.thresholds.maxBehaviorPaths
		? {
			code: "DBG-004:multiple-behavior-paths",
			summary: `Changes span ${result.behaviorPaths} behavior paths, above the ${result.thresholds.maxBehaviorPaths}-path tiny-scope boundary.`,
		}
		: undefined,
	"DBG-005:reviewer-evidence-missing": (result) => result.reviewerBehaviorEvidenceMissing
		? {
			code: "DBG-005:reviewer-evidence-missing",
			summary: "Reviewer-marked behavior evidence is missing for user-visible behavior changes.",
		}
		: undefined,
	"DBG-006:repeated-same-area": (result) => result.repeatedSameAreaFixCount >= result.thresholds.repeatAreaThreshold
		? {
			code: "DBG-006:repeated-same-area",
			summary: `Same-area chain already has ${result.repeatedSameAreaFixCount} prior done/promoted debug fix(es).`,
		}
		: undefined,
};

interface DebugEscalationContext {
	itemId?: string;	itemTitle: string;	itemBody?: string;	featureArea?: string;	filesChanged: number;	locChanged: number;	behaviorPaths: number;	stateMachineOrArchitectureChange: boolean;	reviewerBehaviorEvidenceMissing: boolean;	repeatedSameAreaFixCount: number;	thresholds: DebugEscalationRules;
}

function toPositiveInteger(value: unknown): number {
	if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function normalizeArea(value?: string): string {
	if (!value) return "";
	return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function normalizeHistoryItemId(value?: string): string {
	const normalized = String(value || "").trim().toUpperCase();
	return normalized;
}

export function inferDebugFeatureArea(title: string, body?: string): string | undefined {
	const haystack = `${title ?? ""} ${body ?? ""}`.toLowerCase();
	if (/workflow[\-_\s]?cfg/.test(haystack) || /\bworkflow\s*configuration\b/.test(haystack)) return "workflow_cfg";
	if (/menu\s+schema/.test(haystack) && /workflow/.test(haystack)) return "workflow_cfg";
	if (/\bworkflow\s*cfg\b/.test(haystack) && /navigation/.test(haystack)) return "workflow_cfg";
	if (/profile\s+config/.test(haystack) && /workflow/.test(haystack)) return "workflow_cfg";
	return undefined;
}

export function countCompletedDebugFixesInArea(history: DebugLaneHistoryItem[], area: string, excludeItemIds?: string | string[]): number {
	const target = normalizeArea(area);
	if (!target) return 0;
	const excludeIds = new Set<string>();
	if (typeof excludeItemIds === "string") {
		const normalized = normalizeHistoryItemId(excludeItemIds);
		if (normalized) excludeIds.add(normalized);
	} else if (Array.isArray(excludeItemIds)) {
		for (const id of excludeItemIds) {
			const normalized = normalizeHistoryItemId(id);
			if (normalized) excludeIds.add(normalized);
		}
	}
	let count = 0;
	for (const item of history) {
		if (item.status !== "done" && item.status !== "promoted") continue;
		if (item.id && excludeIds.has(normalizeHistoryItemId(item.id))) continue;
		const inferred = item.area
			? normalizeArea(item.area)
			: inferDebugFeatureArea(item.title, item.body) || "";
		if (!inferred) continue;
		if (normalizeArea(inferred) === target) count += 1;
	}
	return count;
}

export function evaluateDebugLaneEscalation(input: DebugEscalationInput): DebugEscalationResult {
	const thresholds: DebugEscalationRules = {
		coreFilesThreshold: Number.isFinite(Number(input.rules?.coreFilesThreshold)) ? Math.max(0, Math.floor(Number(input.rules?.coreFilesThreshold))) : DEFAULT_DEBUG_ESCALATION_RULES.coreFilesThreshold,
		locThreshold: Number.isFinite(Number(input.rules?.locThreshold)) ? Math.max(0, Math.floor(Number(input.rules?.locThreshold))) : DEFAULT_DEBUG_ESCALATION_RULES.locThreshold,
		maxBehaviorPaths: Number.isFinite(Number(input.rules?.maxBehaviorPaths)) ? Math.max(1, Math.floor(Number(input.rules?.maxBehaviorPaths))) : DEFAULT_DEBUG_ESCALATION_RULES.maxBehaviorPaths,
		repeatAreaThreshold: Number.isFinite(Number(input.rules?.repeatAreaThreshold)) ? Math.max(1, Math.floor(Number(input.rules?.repeatAreaThreshold))) : DEFAULT_DEBUG_ESCALATION_RULES.repeatAreaThreshold,
	};

	const explicitArea = normalizeArea(input.featureArea);
	const inferredArea = explicitArea || inferDebugFeatureArea(input.itemTitle, input.itemBody);
	const derivedArea = inferredArea ? normalizeArea(inferredArea) : "";

	const filesChanged = toPositiveInteger(input.filesChanged);
	const locChanged = toPositiveInteger(input.locChanged);
	const behaviorPaths = toPositiveInteger(input.behaviorPaths);
	const repeatedSameAreaFixCount = Number.isFinite(Number(input.repeatedSameAreaFixCount))
		? Math.max(0, Math.floor(Number(input.repeatedSameAreaFixCount)))
		: countCompletedDebugFixesInArea(input.history ?? [], derivedArea, input.itemId);

	const context: DebugEscalationContext = {
		itemId: input.itemId,
		itemTitle: input.itemTitle,
		itemBody: input.itemBody,
		featureArea: derivedArea,
		filesChanged,
		locChanged,
		behaviorPaths,
		stateMachineOrArchitectureChange: Boolean(input.stateMachineOrArchitectureChange),
		reviewerBehaviorEvidenceMissing: Boolean(input.reviewerBehaviorEvidenceMissing),
		repeatedSameAreaFixCount,
		thresholds,
	};

	const matchedRules = Object.values(RULE_DEFINITIONS)
		.map((evaluateRule) => evaluateRule(context))
		.filter((rule): rule is DebugEscalationRuleMatch => Boolean(rule));
	const ruleCodes = matchedRules.map((match) => match.code);

	const needsRootCause = matchedRules.some((rule) => rule.code === "DBG-006:repeated-same-area");
	const needsPromotion = matchedRules.length > 0;
	const suggestedAction: DebugEscalationAction = needsRootCause
		? "promote-debug-item-with-root-cause"
		: needsPromotion
			? "promote-debug-item"
			: "allow-debug-completion";

	const ruleSummary = matchedRules.length
		? matchedRules.map((rule) => rule.summary).join("; ")
		: "No escalation triggers detected for this debug item.";
	const summary = `${input.itemTitle} (${input.itemId ?? "debug-item"}, area=${derivedArea || "unknown"}): ${ruleSummary}`;
	const acceptanceCriteria = buildDebugPromotionAcceptanceCriteria({
		itemId: input.itemId,
		itemTitle: input.itemTitle,
		featureArea: derivedArea || undefined,
		matchedRules,
		requiresRootCauseTask: needsRootCause,
		reviewerBehaviorEvidenceMissing: Boolean(input.reviewerBehaviorEvidenceMissing),
	});

	return {
		itemId: input.itemId,
		itemTitle: input.itemTitle,
		featureArea: derivedArea || undefined,
		matchedRules,
		suggestedAction,
		needsEscalation: needsPromotion,
		needsRootCauseTask: needsRootCause,
		repeatedSameAreaFixCount,
		summary,
		ruleCodes,
		acceptanceCriteria,
	};
}

function bulletList(lines: string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

function quoteBlock(value: string): string {
	const normalized = value.trim();
	if (!normalized) return "> (no additional text provided)";
	return normalized.split(/\r?\n/).map((line) => `> ${line || " "}`).join("\n");
}

export function buildDebugPromotionAcceptanceCriteria(input: {
	itemId?: string;
	itemTitle: string;
	featureArea?: string;
	matchedRules: DebugEscalationRuleMatch[];
	requiresRootCauseTask: boolean;
	reviewerBehaviorEvidenceMissing: boolean;
}): string {
	const featurePart = input.featureArea ? ` (${input.featureArea})` : "";
	const lines = [
		`Resolve the original debug symptom: ${input.itemTitle}${featurePart}.`,
		`Preserve and reference the original debug lane context (including notes/evidence) for debug item ${input.itemId || "N/A"}.`,
	];
	if (input.matchedRules.length === 0) {
		lines.push("Keep scope to a tiny debug fix with direct evidence before completing the change.");
	} else {
		lines.push(`Address all escalation triggers: ${input.matchedRules.map((rule) => rule.code).join(", ")}.`);
		if (input.reviewerBehaviorEvidenceMissing) {
			lines.push("Gather reviewer-acceptable behavior evidence for user-visible behavior paths before completion.");
		} else {
			lines.push("Attach behavior evidence for all affected paths in task notes/evidence.");
		}
		if (input.requiresRootCauseTask) {
			lines.push("Include root-cause analysis and stabilization guidance because this is a repeated same-area debug chain.");
		}
	}
	return bulletList(lines);
}

export function buildDebugLaneContextSection(input: {
	itemId: string;	itemTitle: string;	itemStatus: DebugItemStatus;	itemBody: string;	promotionNote: string;	escalation?: DebugEscalationResult;
}): string {
	const escalation = input.escalation;
	const ruleCodesLine = escalation?.ruleCodes?.length ? escalation.ruleCodes.join(", ") : "(none)";
	const escalationSummary = escalation?.summary ?? "No escalation evaluation was supplied.";
	return [
		"## Debug Lane Context",
		`- Debug item id: ${input.itemId}`,
		`- Debug item title: ${input.itemTitle}`,
		`- Item status at promotion: ${input.itemStatus}`,
		`- Status intent: promoted to normal sprint task for full lifecycle handling.`,
		`- Promotion note: ${input.promotionNote}`,
		`- Escalation rule codes: ${ruleCodesLine}`,
		`- Escalation summary: ${escalationSummary}`,
		"",
		"### Original debug item body",
		quoteBlock(input.itemBody),
	"",
	].join("\n");
}

export function buildDebugPromotionAcceptanceSection(input: {
	itemId: string;	itemTitle: string;	featureArea?: string;	itemBody: string;	escalation?: DebugEscalationResult;
}): string {
	const acceptanceCriteria = input.escalation
		? input.escalation.acceptanceCriteria
		: buildDebugPromotionAcceptanceCriteria({
			itemId: input.itemId,
			itemTitle: input.itemTitle,
			featureArea: input.featureArea,
			matchedRules: [],
			requiresRootCauseTask: false,
			reviewerBehaviorEvidenceMissing: false,
		});
	return [
		"## Debug Lane Acceptance Criteria",
		`### Source debug item: ${input.itemId}`,
		`${acceptanceCriteria}`,
	].join("\n");
}

export function buildDebugPromotionAppendix(input: {
	itemId: string;	itemTitle: string;	itemStatus: DebugItemStatus;	itemBody: string;	featureArea?: string;	promotionNote: string;	escalation?: DebugEscalationResult;
}): DebugPromotionAppendix {
	return {
		contextSection: buildDebugLaneContextSection(input),
		acceptanceSection: buildDebugPromotionAcceptanceSection({
			itemId: input.itemId,
			itemTitle: input.itemTitle,
			featureArea: input.featureArea,
			itemBody: input.itemBody,
			escalation: input.escalation,
		}),
	};
}
