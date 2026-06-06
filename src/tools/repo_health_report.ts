/**
 * repo_health_report tool — deterministic project integrity consultant.
 *
 * Lazily syncs the deterministic index, persists explicit/inferred principles,
 * refreshes cached findings when needed, and returns a ranked advisory report.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "../runtime";
import { syncRepo } from "../index/sync";
import { openDb, closeDb } from "../index/db";
import { loadConfig } from "../config/loader";
import {
	findingsNeedRefresh,
	generateFindings,
	loadAllPrinciples,
	persistFindings,
	persistPrinciples,
	rankFindings,
	readFindingsFromDb,
	type ConsultantParams,
	type Finding,
	type Principle,
} from "../integrity/consultant";

export const repoHealthReportParameters = Type.Object({
	maxFindings: Type.Optional(Type.Integer({ default: 20, description: "Max findings to return" })),
	includeGantt: Type.Optional(Type.Boolean({ default: false, description: "Include simple Markdown/Mermaid Gantt" })),
	categories: Type.Optional(Type.Array(Type.String(), { description: "Filter by category" })),
	minSeverity: Type.Optional(Type.String({ default: "info", description: "Minimum severity to include" })),
	forceRefresh: Type.Optional(Type.Boolean({ default: false, description: "Bypass cache and regenerate findings" })),
	taskId: Type.Optional(Type.String({ description: "Optional task id for task-scoped ranking" })),
	taskFiles: Type.Optional(Type.Array(Type.String(), { description: "Optional task-relevant file paths" })),
	taskQuery: Type.Optional(Type.String({ description: "Optional task query for task-scoped ranking" })),
});

const SEVERITIES = ["critical", "warning", "info", "ok"] as const;
type Severity = typeof SEVERITIES[number];

function clamp(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeSeverity(value: unknown): Severity {
	return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)
		? value as Severity
		: "info";
}

function normalizeStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const arr = value
		.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
		.map((v) => v.trim());
	return arr.length > 0 ? [...new Set(arr)] : null;
}

function severityCounts(findings: Finding[]): Record<Severity, number> {
	const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0, ok: 0 };
	for (const f of findings) {
		if ((SEVERITIES as readonly string[]).includes(f.severity)) {
			counts[f.severity as Severity]++;
		}
	}
	return counts;
}

function formatRefs(refs: string[]): string {
	return refs.length > 0 ? refs.join(", ") : "(none)";
}

function sanitizeGanttLabel(text: string): string {
	return text.replace(/[^a-zA-Z0-9 ._/-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 64) || "Finding";
}

function renderGantt(findings: Finding[], generatedAt: number): string {
	const start = new Date(generatedAt);
	const date = start.toISOString().slice(0, 10);
	const lines = [
		"## Gantt",
		"",
		"```mermaid",
		"gantt",
		"    title repo_health_report advisory plan",
		"    dateFormat  YYYY-MM-DD",
		"    axisFormat  %m-%d",
	];
	for (const f of findings.slice(0, 8)) {
		const duration = f.severity === "critical" ? "3d" : f.severity === "warning" ? "2d" : "1d";
		const label = sanitizeGanttLabel(`${f.rank}. ${f.category}: ${f.finding}`);
		const state = f.severity === "critical" ? "active" : "";
		lines.push(`    ${label} :${state ? state + ", " : ""}f${f.rank}, ${date}, ${duration}`);
	}
	if (findings.length === 0) {
		lines.push(`    No evidence-bound findings :done, f0, ${date}, 1d`);
	}
	lines.push("```", "");
	return lines.join("\n");
}

function renderPrinciple(p: Principle): string {
	const sourceNote = p.source.startsWith("inferred:")
		? "inferred"
		: p.source === "builtin"
			? "builtin baseline"
			: "explicit";
	const category = p.category ? ` category=${p.category}` : "";
	return `- confidence=${p.confidence.toFixed(2)} source=${p.source} (${sourceNote})${category}: ${p.text}`;
}

export function registerRepoHealthReport(pi: ExtensionAPI) {
	pi.registerTool({
		name: "repo_health_report",
		label: "Repo: Health Report",
		description: "Return a ranked deterministic integrity/consultant report with evidence-bound findings.",
		promptSnippet: "Get a ranked health report for the repo",
		promptGuidelines: [
			"Use repo_health_report to surface evidence-bound integrity findings such as stale context, test coverage gaps, type safety issues, security risks, or architectural drift.",
			"Findings are advisory and ranked by severity, task relevance, confidence, support, and recency.",
		],
		parameters: repoHealthReportParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const rt = buildRuntime(ctx);
			const cfg = loadConfig(rt.repoRoot);
			if (!cfg.enabled) {
				return {
					content: [{ type: "text", text: "repo_health_report is disabled for this repository." }],
					details: { enabled: false },
				};
			}
			if (!cfg.integrity.enabled) {
				return {
					content: [{ type: "text", text: "repo_health_report integrity consultant is disabled for this repository." }],
					details: { enabled: true, integrityEnabled: false },
				};
			}

			const p = params as any;
			const maxFindings = clamp(Number(p?.maxFindings ?? cfg.tools.repo_health_report.maxFindings), 1, 100);
			const includeGantt = Boolean(p?.includeGantt ?? cfg.tools.repo_health_report.includeGanttDefault);
			const forceRefresh = Boolean(p?.forceRefresh ?? cfg.tools.repo_health_report.forceRefreshDefault);
			const categories = normalizeStringArray(p?.categories) ?? cfg.integrity.defaultCategories;
			const minSeverity = normalizeSeverity(p?.minSeverity);
			const taskId = typeof p?.taskId === "string" && p.taskId.trim().length > 0 ? p.taskId.trim() : null;
			const taskFiles = normalizeStringArray(p?.taskFiles);
			const taskQuery = typeof p?.taskQuery === "string" && p.taskQuery.trim().length > 0 ? p.taskQuery.trim() : null;

			const sync = syncRepo(rt.repoRoot, rt.repoKey, rt.cacheDbPath);
			const handle = openDb(rt.repoKey, rt.repoRoot);
			try {
				const db = handle.db;
				const consultantParams: ConsultantParams = {
					maxFindings,
					categories,
					minSeverity,
					forceRefresh,
					taskId,
					taskFiles,
					taskQuery,
					includeGantt,
				};

				const principles = loadAllPrinciples(rt.repoRoot);
				persistPrinciples(db, rt.repoKey, principles);

				const taskScoped = Boolean(taskId || taskQuery || (taskFiles && taskFiles.length > 0));
				let refreshed = false;
				let findings: Finding[];
				if (taskScoped) {
					const generated = generateFindings(db, rt.repoKey, rt.repoRoot, sync.contextVersion, principles, consultantParams);
					findings = rankFindings(generated, consultantParams);
					refreshed = true;
				} else {
					if (findingsNeedRefresh(db, rt.repoKey, sync.contextVersion, cfg.integrity.maxAgeMs, forceRefresh)) {
						const generated = generateFindings(db, rt.repoKey, rt.repoRoot, sync.contextVersion, principles, consultantParams);
						const allFindingsParams: ConsultantParams = {
							...consultantParams,
							maxFindings: 1000,
							categories: null,
							minSeverity: "ok",
						};
						const ranked = rankFindings(generated, allFindingsParams);
						persistFindings(db, rt.repoKey, sync.contextVersion, ranked);
						refreshed = true;
					}
					findings = readFindingsFromDb(db, rt.repoKey, consultantParams);
				}
				const counts = severityCounts(findings);
				const trustedCount = findings.filter((f) => f.trusted).length;
				const untrustedCount = findings.length - trustedCount;
				const now = Date.now();

				const lines: string[] = [];
				lines.push("# repo_health_report", "");
				lines.push("## Metadata");
				lines.push(`- repoRoot: ${rt.repoRoot}`);
				lines.push(`- repoKey: ${rt.repoKey}`);
				lines.push(`- context_version: ${sync.contextVersion}`);
				lines.push(`- last_sync_at: ${new Date(sync.lastSyncAt).toISOString()}`);
				lines.push(`- generated_at: ${new Date(now).toISOString()}`);
				lines.push(`- refreshed: ${refreshed}`);
				lines.push(`- filters: maxFindings=${maxFindings}, minSeverity=${minSeverity}, categories=${categories.join(", ") || "(all)"}`);
				if (taskId || taskQuery || taskFiles) {
					lines.push(`- task_scope: taskId=${taskId ?? "(none)"}, taskQuery=${taskQuery ?? "(none)"}, taskFiles=${taskFiles?.join(", ") ?? "(none)"}`);
				}
				lines.push("");

				lines.push("## Principles");
				for (const principle of principles) {
					lines.push(renderPrinciple(principle));
				}
				lines.push("");

				lines.push("## Executive Summary");
				lines.push(`- findings: ${findings.length}`);
				lines.push(`- critical: ${counts.critical}, warning: ${counts.warning}, info: ${counts.info}, ok: ${counts.ok}`);
				lines.push(`- trusted: ${trustedCount}, untrusted/inferred: ${untrustedCount}`);
				lines.push("- trust rule: trusted findings include file_refs or evidence_refs; untrusted findings are low-confidence inferred advisories.");
				lines.push("");

				lines.push("## Findings");
				if (findings.length === 0) {
					lines.push("No evidence-bound findings found for the selected filters.");
				} else {
					for (const finding of findings) {
						lines.push(`### ${finding.rank}. [${finding.severity}] ${finding.category}`);
						lines.push(finding.finding);
						lines.push(`- confidence: ${finding.confidence.toFixed(2)}`);
						lines.push(`- trusted: ${finding.trusted}`);
						lines.push(`- scope: ${finding.scope}`);
						lines.push(`- task_relevance: ${finding.taskRelevance.toFixed(2)}`);
						lines.push(`- principle_source: ${finding.principleSource}`);
						lines.push(`- file_refs: ${formatRefs(finding.fileRefs)}`);
						lines.push(`- evidence_refs: ${formatRefs(finding.evidenceRefs)}`);
						lines.push(`- recommendation: ${finding.recommendation}`);
						lines.push("");
					}
				}

				if (includeGantt) {
					lines.push(renderGantt(findings, now));
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						scaffold: false,
						consultantAvailable: true,
						enabled: true,
						integrityEnabled: true,
						repoRoot: rt.repoRoot,
						repoKey: rt.repoKey,
						contextVersion: sync.contextVersion,
						findingsCount: findings.length,
						principles,
						findings,
						filters: { maxFindings, categories, minSeverity, taskId, taskFiles, taskQuery },
						includeGantt,
						forceRefresh,
						refreshed,
					},
				};
			} finally {
				closeDb(handle);
			}
		},
	});
}
