// Shared small helpers for the architecture-plan modules.
// Keep this file dependency-free so it can be imported from store,
// evidence-matrix, gate, and any future architecture helper module.

import type { EvidenceMatrixValidationIssue } from "./types";

export function trimString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const text = trimString(item);
		if (text) out.push(text);
	}
	return out;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toIsoDate(): string {
	return new Date().toISOString();
}

// Non-persisted marker for plans whose on-disk acceptanceEvidenceMatrix could
// not be normalized cleanly. Read paths attach the validation issues to the
// returned plan via this Symbol so assertReadyMatrix / validatePhaseGate can
// reject the plan with acceptance_matrix_invalid. writeArchitecturePlan strips
// the marker so the on-disk state never carries it (Symbol keys are ignored
// by JSON.stringify, but explicit removal keeps the contract obvious and
// survives any future serializer that walks symbol-keyed properties).
const MATRIX_READ_ISSUES: unique symbol = Symbol("task002.matrixReadIssues");

export interface MatrixReadIssuesCarrier {
	[MATRIX_READ_ISSUES]?: EvidenceMatrixValidationIssue[];
}

export function getMatrixReadIssues(plan: unknown): EvidenceMatrixValidationIssue[] {
	const carrier = plan as MatrixReadIssuesCarrier | null | undefined;
	return carrier?.[MATRIX_READ_ISSUES] ?? [];
}

export function attachMatrixReadIssues(plan: object, issues: EvidenceMatrixValidationIssue[]): void {
	if (issues.length === 0) return;
	(plan as MatrixReadIssuesCarrier)[MATRIX_READ_ISSUES] = issues;
}

export function stripMatrixReadIssues(plan: object): void {
	delete (plan as MatrixReadIssuesCarrier)[MATRIX_READ_ISSUES];
}
