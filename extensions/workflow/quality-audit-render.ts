// TASK-009 Phase A — workflow quality audit report rendering and finalization summary.

import * as path from "node:path";
import {
	asString,
	countFindings,
	WorkflowQualityAuditFinalizationSummary,
	WorkflowQualityAuditReport,
} from "./quality-audit-types";
import { relativeFrom } from "./quality-audit-scan-helpers";

export function renderWorkflowQualityAuditReport(report: WorkflowQualityAuditReport): string {
	const lines: string[] = [];
	lines.push("# Workflow Quality Audit Report");
	lines.push(`Workspace: ${path.basename(report.cwd)}`);
	lines.push(`Generated: ${report.generatedAt}`);
	lines.push(`Total findings: ${report.counts.total}`);
	lines.push(`Delegates scanned: up to ${report.options.maxDelegateManifests}`);
	lines.push(`Tasks scanned: up to ${report.options.maxTaskFiles}`);
	lines.push(`Progress files scanned: up to ${report.options.maxProgressFiles}`);
	lines.push(`Debug items scanned: up to ${report.options.maxDebugItems}`);
	lines.push(`Metric files scanned: up to ${report.options.maxMetricFiles}`);
	lines.push(`Metric threshold: ${report.options.maxMetricLines} lines`);
	lines.push("");

	const sevLines = Object.entries(report.counts.bySeverity)
		.filter(([, value]) => value > 0)
		.map(([severity, value]) => `- ${severity}: ${value}`);
	if (sevLines.length > 0) {
		lines.push("## Severity");
		lines.push(...sevLines);
		lines.push("");
	}
	if (report.counts.byCode) {
		lines.push("## Top codes");
		const codes = Object.entries(report.counts.byCode)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([code, count]) => `- ${code}: ${count}`);
		lines.push(...codes);
	}

	lines.push("");
	if (report.findings.length === 0) {
		lines.push("No findings detected.");
		return `${lines.join("\n")}\n`;
	}
	lines.push("## Findings");
	for (const finding of report.findings) {
		lines.push(`- [${finding.severity.toUpperCase()}] ${finding.code} (${finding.category})`);
		lines.push(`  - Message: ${finding.message}`);
		lines.push(`  - Task IDs: ${finding.taskIds.length ? finding.taskIds.join(", ") : "n/a"}`);
		lines.push(`  - Run IDs: ${finding.runIds.length ? finding.runIds.join(", ") : "n/a"}`);
		for (const ref of finding.evidenceRefs) {
			lines.push(`  - Evidence: ${ref}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function buildWorkflowQualityAuditFinalizationSummary(
	report: WorkflowQualityAuditReport,
	options: { taskId?: string; reportPath?: string } = {},
): WorkflowQualityAuditFinalizationSummary {
	const target = asString(options.taskId).trim().toUpperCase();
	const filtered = target
		? report.findings.filter((finding) => finding.taskIds.includes(target))
		: report.findings;
	const counts = countFindings(filtered);
	const criticalOrHighCount = counts.bySeverity.critical + counts.bySeverity.high;
	const warningOrHighCount = criticalOrHighCount + counts.bySeverity.warning;
	const summary = target
		? `Task ${target}: ${filtered.length} findings (${criticalOrHighCount} critical/high, ${warningOrHighCount} warning/high).`
		: `Workspace findings: ${filtered.length} (${criticalOrHighCount} critical/high, ${warningOrHighCount} warning/high).`;
	const reportDir = options.reportPath
		? path.dirname(options.reportPath)
		: path.join(report.cwd, ".pi", "workflow-runs", "quality-audit");
	const artifactPath = path.join(
		reportDir,
		target ? `${target}-quality-audit-summary.json` : "latest-quality-audit-summary.json",
	);
	return {
		taskId: target || undefined,
		reportGeneratedAt: report.generatedAt,
		artifactPath,
		artifactLink: relativeFrom(report.cwd, artifactPath),
		summary,
		totalFindings: filtered.length,
		criticalOrHighCount,
		warningOrHighCount,
		bySeverity: counts.bySeverity,
		byCode: counts.byCode,
		firstFindingMessages: filtered
			.slice(0, 3)
			.map((f) => `${f.severity}:${f.code}:${f.message}`),
	};
}
