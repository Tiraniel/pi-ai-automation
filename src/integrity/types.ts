/**
 * Shared types for the integrity consultant subsystem.
 *
 * Extracted from consultant.ts to keep each module under the project 500-LOC
 * budget. Behavior, fields, and ordering are preserved.
 */

export interface Principle {
	category: string | null;
	text: string;
	source: string;
	confidence: number;
	configRef: string | null;
}

export interface Finding {
	id?: number;
	severity: "critical" | "warning" | "info" | "ok";
	category: string;
	finding: string;
	evidenceRefs: string[];
	fileRefs: string[];
	confidence: number;
	principleSource: string;
	recommendation: string;
	generatedAt: number;
	contextVersion: string;
	rank: number;
	trusted: boolean;
	scope: "global" | "task";
	taskRelevance: number;
}

export interface ConsultantParams {
	maxFindings: number;
	categories: string[] | null;
	minSeverity: "critical" | "warning" | "info" | "ok";
	forceRefresh: boolean;
	taskId: string | null;
	taskFiles: string[] | null;
	taskQuery: string | null;
	includeGantt: boolean;
}
