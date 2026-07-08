import { KNOWN_REVIEWER_ROLES } from "../reviewer-protocol";
import { PRD_COVERS_ID_PATTERN, PRD_CRITERION_ID_PATTERN } from "../planning-prd-contract";
import {
	isPlainObject,
	normalizeStringArray,
	trimString,
} from "./plan-helpers";
import type {
	AcceptanceEvidenceMatrixEntry,
	CriterionKind,
	EnforcementLevel,
	EvidenceMatrixValidationIssue,
	EvidenceMatrixValidationResult,
	RequiredEvidenceItem,
	RequiredEvidenceKind,
	ReviewerRole,
} from "./types";

export const KNOWN_CRITERION_KINDS: ReadonlySet<CriterionKind> = new Set<CriterionKind>([
	"runtime-behavior",
	"planning-artifact",
	"documentation",
	"configuration",
	"test-infrastructure",
	"manual-process",
]);

export const KNOWN_ENFORCEMENT_LEVELS: ReadonlySet<EnforcementLevel> = new Set<EnforcementLevel>([
	"prompt-only",
	"config-default",
	"runtime-gate",
	"behavior-test",
	"manual-validation",
	"regression-proof",
]);

export const KNOWN_REQUIRED_EVIDENCE_KINDS: ReadonlySet<RequiredEvidenceKind> = new Set<RequiredEvidenceKind>([
	"artifact",
	"diff",
	"static-check",
	"unit-test",
	"behavior-test",
	"regression-test",
	"runtime-gate-test",
	"manual-validation",
	"reviewer-approval",
]);

export interface NormalizeMatrixResult {
	value: AcceptanceEvidenceMatrixEntry[] | undefined;
	issues: EvidenceMatrixValidationIssue[];
}

export interface ValidateEvidenceMatrixOptions {
	isReadyPlan?: boolean;
}

function pushEntryIssue(
	issues: EvidenceMatrixValidationIssue[],
	code: EvidenceMatrixValidationIssue["code"],
	message: string,
	index: number,
): void {
	issues.push({ code, message, index });
}

export function normalizeEvidenceItem(input: unknown, index: number): {
	value: RequiredEvidenceItem | undefined;
	issues: EvidenceMatrixValidationIssue[];
} {
	const issues: EvidenceMatrixValidationIssue[] = [];
	if (!isPlainObject(input)) {
		pushEntryIssue(issues, "entry_missing_required_field", "Evidence item must be an object.", index);
		return { value: undefined, issues };
	}
	const kindRaw = trimString(input.kind);
	if (!kindRaw) {
		pushEntryIssue(issues, "entry_missing_required_field", "Evidence item kind is required.", index);
		return { value: undefined, issues };
	}
	if (!KNOWN_REQUIRED_EVIDENCE_KINDS.has(kindRaw as RequiredEvidenceKind)) {
		pushEntryIssue(
			issues,
			"entry_invalid_value",
			`Evidence item kind is not a known kind: ${kindRaw}.`,
			index,
		);
		return { value: undefined, issues };
	}
	const description = trimString(input.description);
	if (!description) {
		pushEntryIssue(issues, "entry_missing_required_field", "Evidence item description is required.", index);
		return { value: undefined, issues };
	}
	const command = trimString(input.command) || undefined;
	const value: RequiredEvidenceItem = { kind: kindRaw as RequiredEvidenceKind, description };
	if (command) value.command = command;
	return { value, issues };
}

export function normalizeMatrixEntry(input: unknown, index: number): {
	value: AcceptanceEvidenceMatrixEntry | undefined;
	issues: EvidenceMatrixValidationIssue[];
} {
	const issues: EvidenceMatrixValidationIssue[] = [];
	if (!isPlainObject(input)) {
		pushEntryIssue(issues, "entry_missing_required_field", "Matrix entry must be an object.", index);
		return { value: undefined, issues };
	}
	const criterion = trimString(input.criterion);
	if (!criterion) {
		pushEntryIssue(issues, "entry_missing_required_field", "Matrix entry criterion is required.", index);
		return { value: undefined, issues };
	}
	const criterionKindRaw = trimString(input.criterionKind);
	if (!criterionKindRaw) {
		pushEntryIssue(issues, "entry_missing_required_field", "Matrix entry criterionKind is required.", index);
		return { value: undefined, issues };
	}
	if (!KNOWN_CRITERION_KINDS.has(criterionKindRaw as CriterionKind)) {
		pushEntryIssue(
			issues,
			"entry_invalid_value",
			`Matrix entry criterionKind is not a known kind: ${criterionKindRaw}.`,
			index,
		);
		return { value: undefined, issues };
	}
	const businessRiskIfWrong = trimString(input.businessRiskIfWrong);
	if (!businessRiskIfWrong) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry businessRiskIfWrong is required.",
			index,
		);
		return { value: undefined, issues };
	}
	const enforcementRaw = normalizeStringArray(input.enforcementLevel);
	if (enforcementRaw.length === 0) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry enforcementLevel must include at least one level.",
			index,
		);
		return { value: undefined, issues };
	}
	const enforcementLevel: EnforcementLevel[] = [];
	for (const level of enforcementRaw) {
		if (!KNOWN_ENFORCEMENT_LEVELS.has(level as EnforcementLevel)) {
			pushEntryIssue(
				issues,
				"entry_invalid_value",
				`Matrix entry enforcementLevel has unknown level: ${level}.`,
				index,
			);
			return { value: undefined, issues };
		}
		enforcementLevel.push(level as EnforcementLevel);
	}
	const evidenceInput = Array.isArray(input.requiredEvidence) ? input.requiredEvidence : null;
	if (!evidenceInput) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry requiredEvidence must be an array with at least one item.",
			index,
		);
		return { value: undefined, issues };
	}
	const requiredEvidence: RequiredEvidenceItem[] = [];
	for (let i = 0; i < evidenceInput.length; i += 1) {
		const itemResult = normalizeEvidenceItem(evidenceInput[i], i);
		if (itemResult.issues.length > 0) issues.push(...itemResult.issues);
		if (itemResult.value) requiredEvidence.push(itemResult.value);
	}
	if (requiredEvidence.length === 0) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry requiredEvidence must include at least one valid item.",
			index,
		);
		return { value: undefined, issues };
	}
	const reviewerRolesRaw = normalizeStringArray(input.reviewerRoles);
	if (reviewerRolesRaw.length === 0) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry reviewerRoles must include at least one role.",
			index,
		);
		return { value: undefined, issues };
	}
	const reviewerRoles: ReviewerRole[] = [];
	for (const role of reviewerRolesRaw) {
		if (!KNOWN_REVIEWER_ROLES.has(role as ReviewerRole)) {
			pushEntryIssue(
				issues,
				"entry_invalid_value",
				`Matrix entry reviewerRoles has unknown role: ${role}.`,
				index,
			);
			return { value: undefined, issues };
		}
		reviewerRoles.push(role as ReviewerRole);
	}
	const blockingConditions = normalizeStringArray(input.blockingConditions);
	if (blockingConditions.length === 0) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry blockingConditions must include at least one non-empty condition.",
			index,
		);
		return { value: undefined, issues };
	}
	const promptOnlyCaveat = trimString(input.promptOnlyCaveat) || undefined;
	const manualValidationPlan = trimString(input.manualValidationPlan) || undefined;
	// WP3 traceability fields (optional). Malformed values are rejected, not
	// silently dropped, so a typo'd covers id cannot fake X* coverage.
	const criterionId = trimString(input.criterionId) || undefined;
	if (criterionId && !PRD_CRITERION_ID_PATTERN.test(criterionId)) {
		pushEntryIssue(issues, "entry_invalid_value", `Matrix entry criterionId ${JSON.stringify(criterionId)} does not match ${PRD_CRITERION_ID_PATTERN}.`, index);
		return { value: undefined, issues };
	}
	let covers: string[] | undefined;
	if (input.covers !== undefined && input.covers !== null) {
		covers = normalizeStringArray(input.covers);
		for (const covered of covers) {
			if (!PRD_COVERS_ID_PATTERN.test(covered)) {
				pushEntryIssue(issues, "entry_invalid_value", `Matrix entry covers id ${JSON.stringify(covered)} does not match ${PRD_COVERS_ID_PATTERN} (expected B<N> or X<N>).`, index);
				return { value: undefined, issues };
			}
		}
		if (covers.length === 0) covers = undefined;
	}
	let negative: boolean | undefined;
	if (input.negative !== undefined && input.negative !== null) {
		if (typeof input.negative !== "boolean") {
			pushEntryIssue(issues, "entry_invalid_value", "Matrix entry negative must be a boolean when provided.", index);
			return { value: undefined, issues };
		}
		negative = input.negative;
	}
	const value: AcceptanceEvidenceMatrixEntry = {
		criterion,
		criterionKind: criterionKindRaw as CriterionKind,
		businessRiskIfWrong,
		enforcementLevel,
		requiredEvidence,
		reviewerRoles,
		blockingConditions,
	};
	if (promptOnlyCaveat) value.promptOnlyCaveat = promptOnlyCaveat;
	if (manualValidationPlan) value.manualValidationPlan = manualValidationPlan;
	if (criterionId) value.criterionId = criterionId;
	if (covers) value.covers = covers;
	if (negative !== undefined) value.negative = negative;
	return { value, issues };
}

export function normalizeMatrix(input: unknown): NormalizeMatrixResult {
	if (input === undefined || input === null) {
		return { value: undefined, issues: [] };
	}
	if (!Array.isArray(input)) {
		return {
			value: undefined,
			issues: [{ code: "entry_invalid_value", message: "acceptanceEvidenceMatrix must be an array if provided." }],
		};
	}
	const issues: EvidenceMatrixValidationIssue[] = [];
	const value: AcceptanceEvidenceMatrixEntry[] = [];
	for (let i = 0; i < input.length; i += 1) {
		const entryResult = normalizeMatrixEntry(input[i], i);
		if (entryResult.issues.length > 0) issues.push(...entryResult.issues);
		if (entryResult.value) value.push(entryResult.value);
	}
	return { value, issues };
}

export function validateMatrixEntryStructure(
	entry: AcceptanceEvidenceMatrixEntry,
	index: number,
): EvidenceMatrixValidationIssue[] {
	const issues: EvidenceMatrixValidationIssue[] = [];
	if (!entry.criterion) {
		pushEntryIssue(issues, "entry_missing_required_field", "Matrix entry criterion must be non-empty.", index);
	}
	if (!entry.businessRiskIfWrong) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry businessRiskIfWrong must be non-empty.",
			index,
		);
	}
	if (!KNOWN_CRITERION_KINDS.has(entry.criterionKind)) {
		pushEntryIssue(
			issues,
			"entry_invalid_value",
			`Matrix entry criterionKind is unknown: ${entry.criterionKind}.`,
			index,
		);
	}
	if (!Array.isArray(entry.enforcementLevel) || entry.enforcementLevel.length === 0) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry enforcementLevel must be a non-empty array.",
			index,
		);
	} else {
		for (const level of entry.enforcementLevel) {
			if (!KNOWN_ENFORCEMENT_LEVELS.has(level)) {
				pushEntryIssue(
					issues,
					"entry_invalid_value",
					`Matrix entry enforcementLevel has unknown level: ${level}.`,
					index,
				);
			}
		}
	}
	if (!Array.isArray(entry.requiredEvidence) || entry.requiredEvidence.length === 0) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry requiredEvidence must be a non-empty array.",
			index,
		);
	} else {
		for (const item of entry.requiredEvidence) {
			if (!KNOWN_REQUIRED_EVIDENCE_KINDS.has(item.kind)) {
				pushEntryIssue(
					issues,
					"entry_invalid_value",
					`Matrix entry requiredEvidence has unknown kind: ${item.kind}.`,
					index,
				);
			}
			if (!item.description) {
				pushEntryIssue(
					issues,
					"entry_missing_required_field",
					"Matrix entry requiredEvidence item description must be non-empty.",
					index,
				);
			}
		}
	}
	if (!Array.isArray(entry.reviewerRoles) || entry.reviewerRoles.length === 0) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry reviewerRoles must be a non-empty array.",
			index,
		);
	} else {
		for (const role of entry.reviewerRoles) {
			if (!KNOWN_REVIEWER_ROLES.has(role)) {
				pushEntryIssue(
					issues,
					"entry_invalid_value",
					`Matrix entry reviewerRoles has unknown role: ${role}.`,
					index,
				);
			}
		}
	}
	if (!Array.isArray(entry.blockingConditions) || entry.blockingConditions.length === 0) {
		pushEntryIssue(
			issues,
			"entry_missing_required_field",
			"Matrix entry blockingConditions must be a non-empty array.",
			index,
		);
	} else {
		for (const cond of entry.blockingConditions) {
			if (!cond) {
				pushEntryIssue(
					issues,
					"entry_missing_required_field",
					"Matrix entry blockingConditions entries must be non-empty.",
					index,
				);
			}
		}
	}
	if (entry.criterionId !== undefined && !PRD_CRITERION_ID_PATTERN.test(entry.criterionId)) {
		pushEntryIssue(
			issues,
			"entry_invalid_value",
			`Matrix entry criterionId is invalid: ${entry.criterionId}.`,
			index,
		);
	}
	if (entry.covers !== undefined) {
		for (const covered of entry.covers) {
			if (!PRD_COVERS_ID_PATTERN.test(covered)) {
				pushEntryIssue(
					issues,
					"entry_invalid_value",
					`Matrix entry covers id is invalid: ${covered}.`,
					index,
				);
			}
		}
	}
	return issues;
}

export function validateMatrixCoverage(plan: {
	acceptanceCriteria: string[];
	acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[];
}): EvidenceMatrixValidationIssue[] {
	const issues: EvidenceMatrixValidationIssue[] = [];
	const matrix = plan.acceptanceEvidenceMatrix ?? [];
	if (matrix.length === 0) {
		issues.push({
			code: "matrix_missing",
			message: "acceptanceEvidenceMatrix is required for ready-plan coverage validation.",
		});
		return issues;
	}
	const seen = new Set<string>();
	const dupes = new Set<string>();
	for (const entry of matrix) {
		if (seen.has(entry.criterion)) dupes.add(entry.criterion);
		seen.add(entry.criterion);
	}
	for (const dupe of dupes) {
		issues.push({
			code: "criterion_duplicate",
			message: `Duplicate matrix entry for criterion: ${dupe}.`,
			criterion: dupe,
		});
	}
	const matched = new Set<string>();
	for (const entry of matrix) {
		if (dupes.has(entry.criterion)) continue;
		if (plan.acceptanceCriteria.includes(entry.criterion)) {
			matched.add(entry.criterion);
		} else {
			issues.push({
				code: "criterion_extra",
				message: `Matrix entry has criterion that is not in acceptanceCriteria: ${entry.criterion}.`,
				criterion: entry.criterion,
			});
		}
	}
	for (const criterion of plan.acceptanceCriteria) {
		if (!matched.has(criterion)) {
			issues.push({
				code: "criterion_missing",
				message: `Acceptance criterion is not covered by any matrix entry: ${criterion}.`,
				criterion,
			});
		}
	}
	return issues;
}

export function validateMatrixPromptOnlyRules(plan: {
	acceptanceCriteria: string[];
	acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[];
}): EvidenceMatrixValidationIssue[] {
	const issues: EvidenceMatrixValidationIssue[] = [];
	const matrix = plan.acceptanceEvidenceMatrix ?? [];
	matrix.forEach((entry, index) => {
		const usesPromptOnly = entry.enforcementLevel.includes("prompt-only");
		if (usesPromptOnly && !entry.promptOnlyCaveat) {
			issues.push({
				code: "prompt_only_missing_caveat",
				message: `Matrix entry uses prompt-only enforcement and must include promptOnlyCaveat: ${entry.criterion}.`,
				criterion: entry.criterion,
				index,
			});
		}
		if (
			entry.criterionKind === "runtime-behavior" &&
			entry.enforcementLevel.length > 0 &&
			entry.enforcementLevel.every((level) => level === "prompt-only")
		) {
			issues.push({
				code: "runtime_prompt_only_only",
				message: `Runtime-behavior matrix entry may not rely on prompt-only as the only enforcement level: ${entry.criterion}.`,
				criterion: entry.criterion,
				index,
			});
		}
	});
	return issues;
}

export function validateEvidenceMatrix(
	plan: {
		acceptanceCriteria: string[];
		acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[];
	},
	options?: ValidateEvidenceMatrixOptions,
): EvidenceMatrixValidationResult {
	const isReadyPlan = options?.isReadyPlan === true;
	const issues: EvidenceMatrixValidationIssue[] = [];
	const matrix = plan.acceptanceEvidenceMatrix ?? [];
	if (isReadyPlan && matrix.length === 0) {
		issues.push({
			code: "matrix_missing",
			message: "Acceptance evidence matrix is required for ready plans.",
		});
	}
	matrix.forEach((entry, index) => {
		issues.push(...validateMatrixEntryStructure(entry, index));
	});
	if (isReadyPlan) {
		issues.push(...validateMatrixCoverage(plan));
		issues.push(...validateMatrixPromptOnlyRules(plan));
	}
	return { ok: issues.length === 0, issues };
}

export function formatMatrixValidationIssues(issues: EvidenceMatrixValidationIssue[]): string {
	if (issues.length === 0) return "";
	const parts: string[] = [];
	for (const issue of issues) {
		const where = issue.criterion
			? `criterion=${JSON.stringify(issue.criterion)}`
			: issue.index !== undefined
				? `index=${issue.index}`
				: "matrix";
		parts.push(`[${issue.code}] ${issue.message} (${where})`);
	}
	return parts.join("; ");
}
