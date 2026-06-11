// TASK-009 Phase A — workflow quality audit shared types, defaults, and small helpers.

export type WorkflowQualityAuditSeverity = "critical" | "high" | "medium" | "low" | "warning" | "info";

export interface WorkflowQualityAuditFinding {
	code: string;
	category: string;
	severity: WorkflowQualityAuditSeverity;
	message: string;
	evidenceRefs: string[];
	taskIds: string[];
	runIds: string[];
	details?: Record<string, unknown>;
}

export interface WorkflowQualityAuditOptions {
	maxDelegateManifests?: number;
	maxTaskFiles?: number;
	maxProgressFiles?: number;
	maxDebugItems?: number;
	maxMetricFiles?: number;
	maxMetricLines?: number;
	metricFileDirs?: string[];
	metricExtensions?: string[];
	maxAgeDays?: number;
}

export interface WorkflowQualityAuditReport {
	cwd: string;
	generatedAt: string;
	options: Required<WorkflowQualityAuditOptions>;
	findings: WorkflowQualityAuditFinding[];
	counts: {
		total: number;
		bySeverity: Record<WorkflowQualityAuditSeverity, number>;
		byCategory: Record<string, number>;
		byCode: Record<string, number>;
	};
}

export interface WorkflowQualityAuditFinalizationSummary {
	taskId?: string;
	reportGeneratedAt: string;
	artifactPath: string;
	artifactLink: string;
	summary: string;
	totalFindings: number;
	criticalOrHighCount: number;
	warningOrHighCount: number;
	bySeverity: Record<WorkflowQualityAuditSeverity, number>;
	byCode: Record<string, number>;
	firstFindingMessages: string[];
}

export interface ParsedArtifact {
	frontmatter: Record<string, string>;
	body: string;
}

export interface DelegateManifestRecord {
	runId: string;
	task?: string;
	agent?: "coder" | "reviewer" | string;
	state?: "running" | "completed" | "failed" | "aborted";
	doneFile?: string;
	done?: DelegateDoneRecord;
}

export interface DelegateDoneRecord {
	done?: boolean;
	completion?: "explicit" | "auto_exit" | "process_exit";
}

export interface DebugItem {
	id: string;
	title: string;
	status: string;
	createdAt: string;
	completedAt: string;
	path: string;
	body: string;
	area: string;
}

export interface AttemptRecord {
	runId: string;
	agent: string;
	failed: boolean;
	at: number;
	taskId: string;
	relManifest: string;
}

export interface FindingCounts {
	total: number;
	bySeverity: Record<WorkflowQualityAuditSeverity, number>;
	byCategory: Record<string, number>;
	byCode: Record<string, number>;
}

export const DEFAULT_OPTIONS: Required<WorkflowQualityAuditOptions> = {
	maxDelegateManifests: 250,
	maxTaskFiles: 250,
	maxProgressFiles: 150,
	maxDebugItems: 250,
	maxMetricFiles: 250,
	maxMetricLines: 700,
	metricFileDirs: ["extensions", "scripts"],
	metricExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md"],
	maxAgeDays: 3650,
};

export const SEVERITY_RANK: Record<WorkflowQualityAuditSeverity, number> = {
	critical: 6,
	high: 5,
	medium: 4,
	low: 3,
	warning: 2,
	info: 1,
};

export const STABLE_CODES = new Set([
	"delegate_failed_coder",
	"delegate_missing_done",
	"delegate_auto_exit",
	"delegate_process_exit",
	"reviewer_retries_repeated",
	"debug_chain_after_done",
	"prompt_only_completion",
	"static_only_interactive_validation",
	"oversized_file",
	"workflow_cfg_large_file",
	"TASK-028",
	"TASK-029",
	"DBG-001",
	"DBG-002",
	"DBG-003",
	"DBG-004",
	"DBG-005",
	"DBG-006",
]);

export function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function countFindings(findings: WorkflowQualityAuditFinding[]): FindingCounts {
	const bySeverity: Record<WorkflowQualityAuditSeverity, number> = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		warning: 0,
		info: 0,
	};
	const byCategory: Record<string, number> = {};
	const byCode: Record<string, number> = {};
	for (const finding of findings) {
		bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
		byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
		byCode[finding.code] = (byCode[finding.code] || 0) + 1;
	}
	return { total: findings.length, bySeverity, byCategory, byCode };
}

export function sortFindings(findings: WorkflowQualityAuditFinding[]): WorkflowQualityAuditFinding[] {
	return findings.sort((left, right) => {
		if (left.severity !== right.severity) return SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
		if (left.category !== right.category) return left.category.localeCompare(right.category);
		if (left.code !== right.code) return left.code.localeCompare(right.code);
		return left.message.localeCompare(right.message);
	});
}
