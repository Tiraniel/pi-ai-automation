// TASK-009 Phase A — workflow quality audit smoke fixtures. Reusable fixture
// helpers, constants, and shared types for
// scripts/task-009-workflow-quality-audit-smokes.ts. This split keeps both
// files under the 500 LOC limit while preserving prior assertions/shapes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	runWorkflowQualityAudit,
} from "../extensions/workflow/quality-audit";
import { registerQualityAuditTools } from "../extensions/workflow/quality-audit-tools";
import { evaluateSprintTaskFinalizationFromDisk } from "../extensions/workflow/finalization-runtime";

export type CheckFn = (condition: boolean, message: string) => void;

export function readText(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

export interface SmokedFinding {
	code: string;
	severity: string;
	evidenceRefs: string[];
	taskIds: string[];
	runIds: string[];
	category: string;
	details?: Record<string, unknown>;
}

export const MEDIUM_OR_HIGHER = new Set(["critical", "high", "medium"]);
export const WARNING_OR_HIGHER = new Set(["critical", "high", "medium", "low", "warning"]);

export function withTempWorkspace<T>(label: string, run: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
	try {
		return run(cwd);
	} finally {
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {
			// cleanup intentionally best-effort
		}
	}
}

export function writeText(filePath: string, value: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${value}\n`);
}

export function writeJson(filePath: string, value: unknown): void {
	writeText(filePath, JSON.stringify(value, null, 2));
}

export function toSmoked(report: ReturnType<typeof runWorkflowQualityAudit>): SmokedFinding[] {
	return report.findings.map((finding) => ({
		code: finding.code,
		severity: finding.severity,
		evidenceRefs: [...finding.evidenceRefs],
		taskIds: [...finding.taskIds],
		runIds: [...finding.runIds],
		category: finding.category,
		details: (finding.details as Record<string, unknown> | undefined) ?? undefined,
	}));
}

export function readFixtureFindings(cwd: string, options: Record<string, unknown> = {}): SmokedFinding[] {
	return toSmoked(runWorkflowQualityAudit(cwd, options));
}

export function stripLineSuffix(ref: string): string {
	return ref.replace(/:L\d+(?::\d+)?$/i, "").trim();
}

export function isPathInsideCwd(cwd: string, target: string): boolean {
	if (!target) return false;
	const targetAbs = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
	const cwdAbs = path.resolve(cwd);
	const rel = path.relative(cwdAbs, targetAbs);
	if (!rel) return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}

export function resolveEvidenceRef(cwd: string, ref: string): { resolved: boolean; inside: boolean; absolute: string } {
	const stripped = stripLineSuffix(ref);
	if (!stripped) return { resolved: false, inside: false, absolute: "" };
	const absolute = path.isAbsolute(stripped) ? stripped : path.resolve(cwd, stripped);
	const inside = isPathInsideCwd(cwd, absolute);
	// Strict rule: every warning/high/critical evidence ref must resolve inside the
	// scanned cwd. Escape paths like "../../../../var/..." are NEVER considered resolved
	// even if the file exists on disk, because they reference outside-cwd artifacts.
	if (!inside) return { resolved: false, inside, absolute };
	return { resolved: fs.existsSync(absolute), inside, absolute };
}

export type DelegateSpec = {
	runId: string;
	state: "running" | "completed" | "failed" | "aborted";
	agent: "coder" | "reviewer";
	completion?: "explicit" | "auto_exit" | "process_exit";
	withSidecar: boolean;
	sidecarDone?: boolean;
	taskId?: string;
	donePath?: string;
	embeddedDone?: { done?: boolean; completion?: "explicit" | "auto_exit" | "process_exit" };
	mtimeMs?: number;
	sidecarMtimeMs?: number;
};

export function createDelegateManifest(cwd: string, input: DelegateSpec): void {
	const root = path.join(cwd, ".pi", "workflow-runs", "delegates");
	fs.mkdirSync(root, { recursive: true });
	const sidecar = input.donePath || path.join(root, `${input.runId}.done.json`);
	const manifest: Record<string, unknown> = {
		runId: input.runId,
		agent: input.agent,
		task: input.taskId ? `Task ${input.taskId}` : "Synthetic task",
		state: input.state,
		doneFile: sidecar,
	};
	if (input.embeddedDone) manifest.done = input.embeddedDone;
	const manifestPath = path.join(root, `${input.runId}.json`);
	writeJson(manifestPath, manifest);
	if (input.withSidecar) {
		writeJson(sidecar, {
			done: input.sidecarDone ?? (input.state === "completed"),
			completion: input.completion,
			summary: "synthetic smoke delegate manifest",
		});
	}
	if (typeof input.mtimeMs === "number") {
		const atime = new Date(input.mtimeMs);
		fs.utimesSync(manifestPath, atime, atime);
	}
	if (typeof input.sidecarMtimeMs === "number" && input.withSidecar) {
		const atime = new Date(input.sidecarMtimeMs);
		fs.utimesSync(sidecar, atime, atime);
	}
}

export function createTaskFixture(cwd: string, taskId: string, body: string, title = "Fixture Task"): void {
	const sprint = path.join(cwd, ".sprints", "sprints", `SPR-qa-${taskId.toLowerCase()}`, "tasks");
	writeText(path.join(sprint, `${taskId}-task.md`), `---\nid: ${taskId}\ntitle: ${title}\nstatus: in_progress\n---\n\n${body}\n`);
}

export function createDebugFixture(cwd: string, id: string, title: string, body: string, status = "done"): void {
	const dir = path.join(cwd, ".sprints", "debug", "items");
	const ts = new Date().toISOString();
	writeText(path.join(dir, `${id}-smoke.md`), `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\ncreatedAt: ${ts}\ncompletedAt: ${ts}\n---\n\n${body}\n`);
}

export function makeBigFile(filePath: string, lines: number): void {
	const payload = Array.from({ length: lines }, (_, i) => `// smoke line ${String(i + 1).padStart(4, "0")}`).join("\n");
	writeText(filePath, payload);
}

export const RISKY_DELEGATES: DelegateSpec[] = [
	{ runId: "coder-failed-missing-sidecar", agent: "coder", state: "failed", withSidecar: false, taskId: "TASK-009" },
	{ runId: "coder-auto-exit", agent: "coder", state: "completed", withSidecar: true, sidecarDone: false, completion: "auto_exit", taskId: "TASK-009" },
	{ runId: "reviewer-attempt-a", agent: "reviewer", state: "failed", withSidecar: true, sidecarDone: false, completion: "process_exit", taskId: "TASK-010" },
	{ runId: "reviewer-attempt-b", agent: "reviewer", state: "completed", withSidecar: true, sidecarDone: true, completion: "explicit", taskId: "TASK-010" },
	// Embedded done: no sidecar, completion auto_exit, done=true => must NOT be delegate_missing_done.
	{ runId: "coder-embedded-auto-exit", agent: "coder", state: "completed", withSidecar: false, taskId: "TASK-009", embeddedDone: { done: true, completion: "auto_exit" } },
];

export const RISKY_TASKS: Array<[string, string]> = [
	["TASK-010", "This change is prompt-only and docs-only, should be high-severity."],
	["TASK-011", "Static-only tests were run and no interactive validation was executed; this should be flagged."],
	["TASK-028", "Premature task done pattern for TASK-028 risk fixture."],
	["TASK-029", "Prompt-only enforcement fixture for TASK-029 risk check."],
];

export const RISKY_DBG_CHAIN: Array<[string, string, string]> = [
	["DBG-001", "Fix workflow_cfg model picker arrow key navigation", "Chain this follow-up after prior profile config fix."],
	["DBG-002", "Clean workflow_cfg menu grouping and navigation", "follow-up chain after prior profile config fix"],
	["DBG-003", "Refactor workflow_cfg menu schema to per-block apply", "follow-up chain after DBG-002 in same workflow_cfg area"],
	["DBG-004", "Fix workflow_cfg profile persistence and follow-up chain", "continued chain follow-up after DBG-001 for same workflow_cfg area"],
	["DBG-005", "Chain workflow_cfg model selection into thinking picker", "followup chain: this one links to earlier profile and model flow"],
	["DBG-006", "Fix workflow_cfg profile selection and nested chain", "further follow chain and fix area behavior"],
];

export const RISKY_PROGRESS = [
	"- 2026-06-10T00:00:00Z task-999 -> done",
	"- 2026-06-10T00:00:30Z completed task-028",
	"- 2026-06-10T00:01:00Z dbg-001 completed",
	"- 2026-06-10T00:01:30Z dbg-002 completed",
	"- 2026-06-10T00:02:00Z task-029 -> done",
	"- 2026-06-10T00:02:30Z dbg-003 finished",
	"",
].join("\n");

export const REQUIRED_RISKY_CODES = [
	"delegate_failed_coder", "delegate_missing_done", "delegate_auto_exit", "delegate_process_exit",
	"reviewer_retries_repeated", "debug_chain_after_done", "prompt_only_completion",
	"static_only_interactive_validation", "workflow_cfg_large_file",
	"DBG-001", "DBG-002", "DBG-003", "DBG-004", "DBG-005", "DBG-006",
	"TASK-028", "TASK-029",
];

export function buildRiskyFixture(cwd: string): void {
	for (const spec of RISKY_DELEGATES) createDelegateManifest(cwd, spec);
	for (const [id, body] of RISKY_TASKS) createTaskFixture(cwd, id, body);
	for (const [id, title, body] of RISKY_DBG_CHAIN) createDebugFixture(cwd, id, title, body);
	writeText(path.join(cwd, ".sprints", "sprints", "SPR-qa-task-009", "progress", "PROGRESS.md"), RISKY_PROGRESS);
	makeBigFile(path.join(cwd, "extensions", "configure-overlay.ts"), 220);
	makeBigFile(path.join(cwd, "scripts", "task-028-workflow-cfg-smokes.ts"), 220);
	makeBigFile(path.join(cwd, "scripts", "task-009-noise-smoke.ts"), 220);
}

export const RISKY_FIXTURE_OPTIONS = {
	maxDelegateManifests: 20, maxTaskFiles: 20, maxProgressFiles: 20, maxDebugItems: 20,
	maxMetricFiles: 40, maxMetricLines: 120, maxAgeDays: 0,
	metricFileDirs: ["extensions", "scripts"], metricExtensions: [".ts", ".md", ".tsx"],
};

// Bulk-old delegate manifest writer for the mtime-sort regression smoke.
// Writes `count` lexicographically earlier manifests (old mtime, no sidecar)
// that outnumber the prior `collectCap` so a pre-sort cap cannot drop a
// lexicographically-later newer risky manifest before mtime sort.
export function createBulkOldCleanDelegateManifests(
	cwd: string,
	count: number,
	oldMtimeMs: number,
	taskId: string,
): void {
	const root = path.join(cwd, ".pi", "workflow-runs", "delegates");
	fs.mkdirSync(root, { recursive: true });
	for (let i = 0; i < count; i += 1) {
		const runId = `aaa-${String(i).padStart(4, "0")}`;
		const manifestPath = path.join(root, `${runId}.json`);
		writeJson(manifestPath, {
			runId,
			agent: "coder",
			task: `Task ${taskId}`,
			state: "completed",
			doneFile: path.join(root, `${runId}.done.json`),
		});
		const atime = new Date(oldMtimeMs);
		fs.utimesSync(manifestPath, atime, atime);
	}
}

// Phase B: minimal fake ExtensionAPI that records registered tool
// definitions. We only model the methods `registerQualityAuditTools`
// actually calls; everything else is left as a no-op so the real
// registration code path runs without throwing. The fake stores the
// full tool spec (including `execute`) so the audit tool smoke can
// invoke the registered handler and assert the returned details.
export interface FakeToolDefinition {
	name: string;
	label?: string;
	description?: string;
	execute?: (toolCallId: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: { cwd?: string }) => Promise<unknown>;
}

export interface FakeExtensionAPI {
	registerTool: (tool: FakeToolDefinition) => unknown;
	registeredTools: FakeToolDefinition[];
}

export function makeFakeExtensionAPI(): FakeExtensionAPI {
	const registered: FakeToolDefinition[] = [];
	return {
		registeredTools: registered,
		registerTool(tool: FakeToolDefinition): unknown {
			registered.push(tool);
			return undefined;
		},
	};
}

// Phase B: write a minimal but valid architecture plan + reviewer memo +
// coder delegate sidecar for `evaluateSprintTaskFinalizationFromDisk` so
// the audit linkage path can be exercised end-to-end. The plan + memo shape
// mirrors the helper used in task-005 finalization-runtime-smokes so the
// audit smoke can be reasoned about in isolation.
export interface FinalizationAuditFixtureOptions {
	cwd: string;
	planId: string;
	taskId: string;
	includeReviewerMemo: boolean;
	includeCoderEvidence: boolean;
}

export function buildFinalizationAuditFixture(options: FinalizationAuditFixtureOptions): void {
	const { cwd, planId, taskId } = options;
	const now = new Date().toISOString();
	const sprintId = `SPR-${planId.replace(/[^a-z0-9]+/gi, "-")}`;
	const sprintPath = path.join(cwd, ".sprints", "sprints", sprintId);
	const storagePath = path.join(sprintPath, "artifacts", "workflow-architecture", `${planId}.json`);
	writeJson(path.join(sprintPath, "sprint.json"), {
		id: sprintId, title: `Sprint ${sprintId}`, createdAt: now, updatedAt: now, taskCount: 0,
	});
	writeJson(path.join(cwd, ".sprints", "current.json"), {
		activeSprintPath: path.join(".sprints", "sprints", sprintId),
		activeTaskPath: null,
		updatedAt: now,
	});
	const matrix = [{
		criterion: "runtime-check",
		criterionKind: "runtime-behavior",
		businessRiskIfWrong: "regression",
		enforcementLevel: ["behavior-test"],
		requiredEvidence: [{ kind: "behavior-test", description: "behavior test", command: "npx tsx runtime.ts" }],
		reviewerRoles: ["behavior"],
		blockingConditions: ["behavior test fails"],
	}];
	const plan = {
		planId, createdAt: now, updatedAt: now, status: "ready",
		taskId, businessPlan: "b", technicalPlan: "t", parallelAssessment: "serial",
		contractBlockPlan: "c", acceptanceCriteria: matrix.map((entry) => entry.criterion),
		acceptanceEvidenceMatrix: matrix,
		phases: {
			phaseA: { status: "review_approved" as const, updatedAt: now, evidence: [] },
			phaseB: { status: "not_started" as const, updatedAt: now, evidence: [] },
		},
	};
	writeJson(storagePath, plan);
	if (options.includeReviewerMemo) {
		const memoPath = path.join(cwd, ".pi", "workflow-runs", "reviewer-memos", `${planId}-phaseA.md`);
		const body = `# Reviewer Memo for ${planId}\n\n## Final recommendation\nAPPROVED\n\n## Missing required roles\n- none\n\n## Changes requested\n- none\n\n## Unknown / failed\n- none\n\n## Prompt-only caveats\n- none\n`;
		writeText(memoPath, body);
	}
	const delegateRoot = path.join(cwd, ".pi", "workflow-runs", "delegates");
	fs.mkdirSync(delegateRoot, { recursive: true });
	const runId = `${planId}-coder`;
	const donePath = path.join(delegateRoot, `${runId}.done.json`);
	const evidence = options.includeCoderEvidence ? {
		filesChanged: ["src/runtime.ts"],
		commandsRun: [{ command: "npx tsx runtime.ts", outcome: "passed", summary: "runtime behavior test passes", exitCode: 0 }],
		criterionCoverage: [{
			criterion: "runtime-check",
			evidenceKind: "behavior-test",
			strength: "sufficient",
			supportingFiles: ["src/runtime.ts"],
			supportingCommands: ["npx tsx runtime.ts"],
			summary: "runtime behavior covered",
		}],
		knownGaps: [],
		caveats: ["none"],
		summary: "coder delegate evidence",
	} : undefined;
	if (options.includeCoderEvidence) {
		writeJson(donePath, {
			done: true, summary: `${runId} completed`, at: now, completion: "explicit", coderEvidence: evidence,
		});
	}
	writeJson(path.join(delegateRoot, `${runId}.json`), {
		manifestVersion: 1, runId, startedAt: now, updatedAt: now, cwd,
		agent: "coder", task: `Architecture plan ${planId} completion`,
		taskPreview: `Finalize architecture plan ${planId}`,
		groupKey: `task-${planId}`, groupTitle: `Task ${planId}`, tabTitle: `Task ${planId}`,
		sessionFile: path.join(delegateRoot, `${runId}.session.json`),
		stderrFile: path.join(delegateRoot, `${runId}.stderr.log`),
		activityFile: path.join(delegateRoot, `${runId}.activity.json`),
		doneFile: donePath, state: "completed",
	});
	// Risky audit artifacts so the audit has findings to surface when the
	// fixture is wired into the finalization path. We keep these repo-local
	// (under `.pi/workflow-runs/...`) so the artifactPath is under
	// `.pi/workflow-runs/quality-audit/`.
	createDelegateManifest(cwd, {
		runId: `${planId}-coder-failed-risky`,
		agent: "coder",
		state: "failed",
		withSidecar: false,
		taskId,
	});
}

// Phase B: verify the public `workflow_quality_audit_report` tool is
// registered by `registerQualityAuditTools(pi)` using a minimal fake
// ExtensionAPI, that the composition root registers the helper, and that
// the finalization gate consumes the advisory audit summary while
// preserving existing strict blockers. Lives in fixtures (not smokes) so the
// smoke runner stays under the 500 LOC limit.
export function runToolRegistrationAndFinalizationSmoke(check: CheckFn): void {
	const fakePi = makeFakeExtensionAPI();
	registerQualityAuditTools(fakePi as any);
	const names = fakePi.registeredTools.map((tool) => tool.name);
	for (const required of ["workflow_quality_audit_report", "workflow_run_quality_audit", "workflow_render_quality_audit_report", "workflow_build_quality_audit_summary"]) {
		check(names.includes(required), `registerQualityAuditTools registers ${required}`);
	}
	const source = readText(path.join(process.cwd(), "extensions", "brain-workflow.ts"));
	check(source !== undefined && /registerQualityAuditTools\s*\(\s*pi\s*\)/.test(source),
		"brain-workflow composition root source calls registerQualityAuditTools(pi)");

	const linkage = withTempWorkspace("task-009-finalize-audit-allowed", (cwd) => {
		buildFinalizationAuditFixture({
			cwd, planId: "task-009-audit-allowed", taskId: "TASK-009",
			includeReviewerMemo: true, includeCoderEvidence: true,
		});
		return evaluateSprintTaskFinalizationFromDisk({
			cwd, taskId: "TASK-009", requestedStatus: "done", mode: "strict",
			finalNote: "All checks passed; audit warnings are advisory only.",
			finalEvidence: "All checks completed in delegate sidecar.",
		});
	});
	check(linkage.allowed === true, "valid plan + memo + coder evidence allows strict finalization");
	check(linkage.strictBlocking === false, "audit findings do not create strict blockers");
	const audit = linkage.details?.qualityAudit;
	check(audit?.present === true, "details.qualityAudit.present === true");
	if (audit) {
		check(!path.isAbsolute(audit.artifactLink ?? ""), "details.qualityAudit.artifactLink is repo-relative");
		check((audit.artifactPath ?? "").replace(/\\/g, "/").includes(".pi/workflow-runs/quality-audit"),
			`details.qualityAudit.artifactPath is under .pi/workflow-runs/quality-audit/ (got ${audit.artifactPath})`);
		check(Number.isFinite(audit.totalFindings) && audit.byCode && Object.keys(audit.byCode).length > 0,
			"details.qualityAudit carries finite totalFindings and populated byCode");
		const codesArr = (linkage.codes || []).map((c) => String(c));
		check(codesArr.includes("quality_audit_findings") || codesArr.includes("quality_audit_clean"),
			`result.codes includes quality_audit_findings or quality_audit_clean (got ${codesArr.join(",")})`);
		check((linkage.warnings || []).some((w) => /audit/i.test(w)), "warnings include an audit mention");
	}
	const memoBlocked = withTempWorkspace("task-009-finalize-audit-no-memo", (cwd) => {
		buildFinalizationAuditFixture({
			cwd, planId: "task-009-audit-no-memo", taskId: "TASK-009",
			includeReviewerMemo: false, includeCoderEvidence: true,
		});
		return evaluateSprintTaskFinalizationFromDisk({ cwd, taskId: "TASK-009", requestedStatus: "done", mode: "strict" });
	});
	check(memoBlocked.allowed === false, "missing reviewer memo still blocks strict finalization with audit findings");
	check(/reviewer|memo/.test((memoBlocked.blockers || []).join(" ").toLowerCase()),
		`blockers mention reviewer/memo (got '${memoBlocked.blockers.join(" | ")}')`);
	const coderBlocked = withTempWorkspace("task-009-finalize-audit-no-coder", (cwd) => {
		buildFinalizationAuditFixture({
			cwd, planId: "task-009-audit-no-coder", taskId: "TASK-009",
			includeReviewerMemo: true, includeCoderEvidence: false,
		});
		return evaluateSprintTaskFinalizationFromDisk({ cwd, taskId: "TASK-009", requestedStatus: "done", mode: "strict" });
	});
	check(coderBlocked.allowed === false, "missing coder evidence still blocks strict finalization with audit findings");
	check(/coder|evidence/.test((coderBlocked.blockers || []).join(" ").toLowerCase()),
		`blockers mention coder/evidence (got '${coderBlocked.blockers.join(" | ")}')`);
}

// Phase B: execute the registered `workflow_quality_audit_report` handler
// through the fake ExtensionAPI collector and assert the returned details
// include the persisted `artifactLink`/`artifactPath`, `bySeverity`,
// `firstFindingMessages`, `reportGeneratedAt`, `findingCount`, and `byCode`
// fields. Uses a risky fixture so the counts and code buckets are non-empty.
// Use fs.mkdtempSync directly + try/finally (not withTempWorkspace) so the
// risky fixture cwd stays alive through the awaited tool.execute() call.
export async function runAuditToolExecuteSmoke(check: CheckFn): Promise<void> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-009-audit-execute-"));
	try {
		buildRiskyFixture(cwd);
		const fakePi = makeFakeExtensionAPI();
		registerQualityAuditTools(fakePi as any);
		const tool = fakePi.registeredTools.find((entry) => entry.name === "workflow_quality_audit_report");
		if (!tool || typeof tool.execute !== "function") {
			check(false, "workflow_quality_audit_report tool is registered with an execute function");
			return;
		}
		const result = await tool.execute("call-task-009-audit", { cwd, taskId: "TASK-009" }, undefined, undefined, { cwd });
		const toolResult = result as { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> } | undefined;
		const details = (toolResult?.details ?? {}) as Record<string, unknown>;
		check(!toolResult?.content?.some((entry) => entry.text === "cwd is required for workflow quality audit report"),
			"audit tool execute does not return missing-cwd error when cwd is provided");
		check(typeof details.artifactLink === "string" && (details.artifactLink as string).length > 0,
			"audit tool execute details.artifactLink is a non-empty string");
		check(typeof details.artifactPath === "string" && (details.artifactPath as string).includes(".pi/workflow-runs/quality-audit"),
			"audit tool execute details.artifactPath is under .pi/workflow-runs/quality-audit/");
		check(fs.existsSync(details.artifactPath as string),
			`audit tool execute details.artifactPath exists on disk (${details.artifactPath})`);
		check(!path.isAbsolute(details.artifactLink as string),
			"audit tool execute details.artifactLink is repo-relative (not absolute)");
		check(typeof details.bySeverity === "object" && details.bySeverity !== null && Object.keys(details.bySeverity as object).length > 0,
			"audit tool execute details.bySeverity is a populated object");
		const bySeverity = details.bySeverity as Record<string, number>;
		check(Number.isFinite(bySeverity.critical) && Number.isFinite(bySeverity.high),
			"audit tool execute details.bySeverity has finite critical/high counts");
		check(Array.isArray(details.firstFindingMessages),
			"audit tool execute details.firstFindingMessages is an array");
		check((details.firstFindingMessages as unknown[]).length > 0,
			"audit tool execute details.firstFindingMessages is non-empty for risky fixture");
		check(typeof details.reportGeneratedAt === "string" && !Number.isNaN(Date.parse(details.reportGeneratedAt as string)),
			"audit tool execute details.reportGeneratedAt is a parseable ISO date string");
		check(typeof details.findingCount === "number" && (details.findingCount as number) > 0,
			"audit tool execute details.findingCount is a positive number for risky fixture");
		check(typeof details.byCode === "object" && details.byCode !== null && Object.keys(details.byCode as object).length > 0,
			"audit tool execute details.byCode is a populated object");
		const persisted = JSON.parse(fs.readFileSync(details.artifactPath as string, "utf8")) as { artifactLink?: string; bySeverity?: Record<string, number>; reportGeneratedAt?: string; firstFindingMessages?: string[]; byCode?: Record<string, number>; totalFindings?: number };
		check(persisted.artifactLink === details.artifactLink,
			"persisted audit summary JSON round-trips details.artifactLink");
		check(persisted.reportGeneratedAt === details.reportGeneratedAt,
			"persisted audit summary JSON round-trips details.reportGeneratedAt");
	} finally {
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
	}
}
