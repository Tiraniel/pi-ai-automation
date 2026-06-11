#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	runWorkflowQualityAudit,
	renderWorkflowQualityAuditReport,
	buildWorkflowQualityAuditFinalizationSummary,
	WorkflowQualityAuditOptions,
	WorkflowQualityAuditReport,
	WorkflowQualityAuditFinalizationSummary,
} from "./quality-audit";

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeMetricExtensions(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry) => typeof entry === "string")
		.map((entry) => asString(entry))
		.filter(Boolean)
		.map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
}

function normalizeOptions(input: Record<string, unknown>): WorkflowQualityAuditOptions {
	return {
		maxDelegateManifests: Number.isFinite(Number((input as any).maxDelegateManifests)) ? Number((input as any).maxDelegateManifests) : undefined,
		maxTaskFiles: Number.isFinite(Number((input as any).maxTaskFiles)) ? Number((input as any).maxTaskFiles) : undefined,
		maxProgressFiles: Number.isFinite(Number((input as any).maxProgressFiles)) ? Number((input as any).maxProgressFiles) : undefined,
		maxDebugItems: Number.isFinite(Number((input as any).maxDebugItems)) ? Number((input as any).maxDebugItems) : undefined,
		maxMetricFiles: Number.isFinite(Number((input as any).maxMetricFiles)) ? Number((input as any).maxMetricFiles) : undefined,
		maxMetricLines: Number.isFinite(Number((input as any).maxMetricLines)) ? Number((input as any).maxMetricLines) : undefined,
		metricFileDirs: Array.isArray((input as any).metricFileDirs)
			? (input as any).metricFileDirs.filter((value: unknown) => typeof value === "string").map((value: string) => asString(value))
			: undefined,
		metricExtensions: normalizeMetricExtensions((input as any).metricExtensions),
		maxAgeDays: Number.isFinite(Number((input as any).maxAgeDays)) ? Number((input as any).maxAgeDays) : undefined,
	};
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

export { runWorkflowQualityAudit, renderWorkflowQualityAuditReport, buildWorkflowQualityAuditFinalizationSummary };

export function runQualityAuditWithRenderedReport(cwd: string, options: Record<string, unknown>): WorkflowQualityAuditReport & { renderedReport: string } {
	const auditOptions = normalizeOptions(options);
	const report = runWorkflowQualityAudit(cwd, auditOptions);
	return {
		...report,
		renderedReport: renderWorkflowQualityAuditReport(report),
	};
}

export function runQualityAuditFinalizationSummary(cwd: string, options: Record<string, unknown>): WorkflowQualityAuditFinalizationSummary {
	const taskId = asString((options as any).taskId) || undefined;
	const reportPath = asString((options as any).reportPath) || undefined;
	const report = runWorkflowQualityAudit(cwd, normalizeOptions(options));
	return buildWorkflowQualityAuditFinalizationSummary(report, { taskId, reportPath });
}

// Run the local audit, build a task-filtered finalization summary, and
// persist the JSON summary under `.pi/workflow-runs/quality-audit/`. Used by
// both the public `workflow_quality_audit_report` tool and the finalization
// disk adapter so the persisted artifactPath/artifactLink match. Returns
// `undefined` if the audit cannot run; callers should treat that as advisory
// "audit not available" and continue finalization.
export function runAndPersistWorkflowQualityAudit(
	cwd: string,
	taskId: string,
	auditOptions: Record<string, unknown> = {},
): WorkflowQualityAuditFinalizationSummary | undefined {
	if (!cwd) return undefined;
	let report: WorkflowQualityAuditReport;
	try {
		report = runWorkflowQualityAudit(cwd, normalizeOptions(auditOptions));
	} catch {
		return undefined;
	}
	const summary = buildWorkflowQualityAuditFinalizationSummary(report, { taskId });
	try {
		fs.mkdirSync(path.dirname(summary.artifactPath), { recursive: true });
		fs.writeFileSync(summary.artifactPath, JSON.stringify(summary, null, 2));
	} catch {
		// Persistence is best-effort; the in-memory summary is still useful.
	}
	return summary;
}

export function registerQualityAuditTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "workflow_run_quality_audit",
		label: "Run workflow quality audit",
		description: "Generate a deterministic workflow quality audit from local workflow artifacts only.",
		promptSnippet: "Run a quality audit before finalization review.",
		parameters: Type.Object({
			cwd: Type.String({ description: "Path to run the scan from." }),
			maxDelegateManifests: Type.Optional(Type.Number({ minimum: 0 })),
			maxTaskFiles: Type.Optional(Type.Number({ minimum: 0 })),
			maxProgressFiles: Type.Optional(Type.Number({ minimum: 0 })),
			maxDebugItems: Type.Optional(Type.Number({ minimum: 0 })),
			maxMetricFiles: Type.Optional(Type.Number({ minimum: 0 })),
			maxMetricLines: Type.Optional(Type.Number({ minimum: 1 })),
			metricFileDirs: Type.Optional(Type.Array(Type.String())),
			metricExtensions: Type.Optional(Type.Array(Type.String())),
			maxAgeDays: Type.Optional(Type.Number({ minimum: 0 })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const cwd = asString((params as any).cwd) || ctx.cwd;
			if (!cwd) {
				return errTool("cwd is required for workflow quality audit", { reason: "missing_cwd" });
			}
			const report = runWorkflowQualityAudit(cwd, normalizeOptions(params as Record<string, unknown>));
			const rendered = renderWorkflowQualityAuditReport(report);
			return okTool(rendered, {
				codeCount: Object.keys(report.counts.byCode).length,
				findingCount: report.findings.length,
				cwd: report.cwd,
			});
		},
	});

	// Public Phase B tool: runs the audit, persists the finalization summary
	// under `.pi/workflow-runs/quality-audit/`, and returns rendered Markdown
	// plus useful details. This is the entry point Brain and the finalization
	// disk adapter call when they need a structured audit linkage.
	pi.registerTool({
		name: "workflow_quality_audit_report",
		label: "Workflow quality audit report",
		description: "Run a deterministic workflow quality audit, persist a task-filtered finalization summary, and return the rendered Markdown plus structured details (finding/code counts, summary, artifact link, severity breakdown).",
		promptSnippet: "Run the quality audit and return a structured audit report for finalization.",
		promptGuidelines: [
			"Use this before finalizing a sprint task to surface historical workflow risk (failed delegates, missing sidecars, auto_exit completions, debug chains, prompt-only/static-only wording, oversized files).",
			"The returned details.artifactLink is repo-relative; details.artifactPath is the absolute path under `.pi/workflow-runs/quality-audit/`.",
			"Findings are advisory: the tool never fails the run; downstream finalization remains allowed unless strict blockers (plan/coder/reviewer) are otherwise triggered.",
		],
		parameters: Type.Object({
			cwd: Type.String({ description: "Path to run the scan from." }),
			taskId: Type.Optional(Type.String({ description: "Optional task id to filter the persisted summary by." })),
			maxDelegateManifests: Type.Optional(Type.Number({ minimum: 0 })),
			maxTaskFiles: Type.Optional(Type.Number({ minimum: 0 })),
			maxProgressFiles: Type.Optional(Type.Number({ minimum: 0 })),
			maxDebugItems: Type.Optional(Type.Number({ minimum: 0 })),
			maxMetricFiles: Type.Optional(Type.Number({ minimum: 0 })),
			maxMetricLines: Type.Optional(Type.Number({ minimum: 1 })),
			metricFileDirs: Type.Optional(Type.Array(Type.String())),
			metricExtensions: Type.Optional(Type.Array(Type.String())),
			maxAgeDays: Type.Optional(Type.Number({ minimum: 0 })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const cwd = asString((params as any).cwd) || ctx.cwd;
			if (!cwd) {
				return errTool("cwd is required for workflow quality audit report", { reason: "missing_cwd" });
			}
			const taskId = asString((params as any).taskId);
			let report: WorkflowQualityAuditReport;
			try {
				report = runWorkflowQualityAudit(cwd, normalizeOptions(params as Record<string, unknown>));
			} catch (error) {
				return errTool(`Quality audit failed: ${error instanceof Error ? error.message : String(error)}`, {
					reason: "audit_failed",
					cwd,
				});
			}
			const summary = runAndPersistWorkflowQualityAudit(cwd, taskId, params as Record<string, unknown>);
			const rendered = renderWorkflowQualityAuditReport(report);
			return okTool(rendered, {
				cwd: report.cwd,
				codeCount: Object.keys(report.counts.byCode).length,
				findingCount: report.findings.length,
				taskId: summary?.taskId,
				summary: summary?.summary,
				artifactPath: summary?.artifactPath,
				artifactLink: summary?.artifactLink,
				totalFindings: summary?.totalFindings ?? report.findings.length,
				criticalOrHighCount: summary?.criticalOrHighCount ?? 0,
				warningOrHighCount: summary?.warningOrHighCount ?? 0,
				byCode: summary?.byCode ?? report.counts.byCode,
				bySeverity: summary?.bySeverity ?? report.counts.bySeverity,
				firstFindingMessages: summary?.firstFindingMessages ?? report.findings
					.slice(0, 3)
					.map((f) => `${f.severity}:${f.code}:${f.message}`),
				reportGeneratedAt: summary?.reportGeneratedAt ?? report.generatedAt,
			});
		},
	});

	pi.registerTool({
		name: "workflow_render_quality_audit_report",
		label: "Render workflow quality audit report",
		description: "Render deterministic markdown from an in-memory quality audit report payload.",
		parameters: Type.Object({
			report: Type.Any({ description: "Raw report payload generated by workflow_run_quality_audit." }),
		}),
		execute: async (_toolCallId, params) => {
			const report = (params as any).report as WorkflowQualityAuditReport | undefined;
			if (!report?.findings || !Array.isArray(report.findings)) {
				return errTool("Invalid report payload.", { reason: "invalid_report" });
			}
			return okTool(renderWorkflowQualityAuditReport(report), { findingCount: report.findings.length });
		},
	});

	pi.registerTool({
		name: "workflow_build_quality_audit_summary",
		label: "Build workflow quality audit finalization summary",
		description: "Build a compact finalization summary payload from a scan report.",
		parameters: Type.Object({
			report: Type.Any({ description: "Raw report payload generated by workflow_run_quality_audit." }),
			taskId: Type.Optional(Type.String({ description: "Optional taskId filter for the finalization context." })),
			reportPath: Type.Optional(Type.String({ description: "Optional summary output path hint for downstream wiring." })),
		}),
		execute: async (_toolCallId, params) => {
			const report = (params as any).report as WorkflowQualityAuditReport | undefined;
			if (!report?.findings || !Array.isArray(report.findings)) {
				return errTool("Invalid report payload.", { reason: "invalid_report" });
			}
			const summary = buildWorkflowQualityAuditFinalizationSummary(report, {
				taskId: asString((params as any).taskId),
				reportPath: asString((params as any).reportPath),
			});
			return okTool(`Finalization summary built for ${summary.taskId || "workspace"}.`, {
				taskId: summary.taskId,
				artifactPath: summary.artifactPath,
				totalFindings: summary.totalFindings,
			});
		},
	});
}
