#!/usr/bin/env node
// TASK-009 Phase A + Phase B — workflow quality audit report smokes.
//
// Phase A: synthetic, real-repo, and regression fixture coverage of the
// audit scanners + summary helpers.
// Phase B: tool registration + finalization-runtime linkage coverage of
// `registerQualityAuditTools` / `workflow_quality_audit_report` and
// `evaluateSprintTaskFinalizationFromDisk`'s advisory audit summary.
//
// Reusable fixture helpers, constants, and shared types live in
// scripts/task-009-workflow-quality-audit-fixtures.ts to keep both files
// under the 500 LOC limit.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	runWorkflowQualityAudit,
	buildWorkflowQualityAuditFinalizationSummary,
	renderWorkflowQualityAuditReport,
} from "../extensions/workflow/quality-audit";

import {
	MEDIUM_OR_HIGHER,
	REQUIRED_RISKY_CODES,
	RISKY_FIXTURE_OPTIONS,
	WARNING_OR_HIGHER,
	SmokedFinding,
	buildRiskyFixture,
	createBulkOldCleanDelegateManifests,
	createDebugFixture,
	createDelegateManifest,
	createTaskFixture,
	makeBigFile,
	readFixtureFindings,
	resolveEvidenceRef,
	runAuditToolExecuteSmoke,
	runToolRegistrationAndFinalizationSmoke,
	stripLineSuffix,
	toSmoked,
	withTempWorkspace,
	writeJson,
	writeText,
} from "./task-009-workflow-quality-audit-fixtures";

let failures = 0;

function check(condition: boolean, message: string): void {
	if (condition) {
		console.log(`PASS: ${message}`);
		return;
	}
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function hasCodeBySeverityAtLeast(findings: SmokedFinding[], code: string, minSeverity: string): boolean {
	const order = ["critical", "high", "medium", "low", "warning", "info"];
	const min = order.indexOf(minSeverity);
	return findings.some((item) => item.code === code && order.indexOf(item.severity) <= min);
}

function ensureCodesPresent(findings: SmokedFinding[], codes: string[]): void {
	for (const code of codes) {
		check(findings.some((item) => item.code === code), `fixture contains required code ${code}`);
	}
}

function ensureNonEmptyEvidence(findings: SmokedFinding[]): void {
	for (const finding of findings) {
		check(finding.evidenceRefs.length > 0, `finding ${finding.code} has evidenceRefs`);
	}
}

function ensureFindingMetadata(finding: SmokedFinding): void {
	check(typeof finding.severity === "string" && finding.severity.length > 0, `finding ${finding.code} has valid severity`);
	check(finding.evidenceRefs.length > 0, `finding ${finding.code} has non-empty evidenceRefs`);
	const hasIds = finding.taskIds.length > 0 || finding.runIds.length > 0;
	const hasMetadata = hasIds || (finding.details && Object.keys(finding.details).length > 0);
	check(hasMetadata, `finding ${finding.code} has taskIds/runIds or useful details metadata`);
}

function ensureRefsResolve(cwd: string, findings: SmokedFinding[], severities: Set<string>): void {
	for (const finding of findings) {
		if (!severities.has(finding.severity)) continue;
		for (const ref of finding.evidenceRefs) {
			check(resolveEvidenceRef(cwd, ref).resolved, `finding ${finding.code} (${finding.severity}) evidence ref ${ref} resolves in fixture`);
		}
	}
}

function assertStrictContract(findings: SmokedFinding[], cwd: string, severities: Set<string>): void {
	for (const finding of findings) {
		if (!severities.has(finding.severity)) continue;
		ensureFindingMetadata(finding);
	}
	ensureRefsResolve(cwd, findings, severities);
}

function runCleanFixtureSmoke(): void {
	withTempWorkspace("task-009-clean", (cwd) => {
		createTaskFixture(cwd, "TASK-090", "All checks pass and behavior is covered by runtime smoke tests.");
		fs.mkdirSync(path.join(cwd, "extensions"), { recursive: true });
		makeBigFile(path.join(cwd, "extensions", "small.ts"), 25);
		const findings = readFixtureFindings(cwd, {
			maxDelegateManifests: 20, maxTaskFiles: 20, maxProgressFiles: 10, maxDebugItems: 10,
			maxMetricFiles: 20, maxMetricLines: 40, maxAgeDays: 1,
		});
		check(findings.every((item) => item.severity !== "critical" && item.severity !== "high"),
			"clean fixture has no critical/high findings");
	});
}

function runRiskyFixtureSmoke(): void {
	withTempWorkspace("task-009-risky", (cwd) => {
		buildRiskyFixture(cwd);
		const findings = readFixtureFindings(cwd, RISKY_FIXTURE_OPTIONS);

		ensureCodesPresent(findings, REQUIRED_RISKY_CODES);
		check(hasCodeBySeverityAtLeast(findings, "reviewer_retries_repeated", "medium"), "reviewer_retries_repeated has medium+ severity");
		check(hasCodeBySeverityAtLeast(findings, "delegate_auto_exit", "high"), "delegate_auto_exit is high severity");
		check(findings.some((item) => item.code === "delegate_process_exit"), "delegate_process_exit captured in risky fixture");
		check(findings.some((item) => item.code.startsWith("workflow_cfg_large_file")), "oversized workflow file found in risky fixture");
		check(findings.some((item) => item.code.startsWith("oversized_file")), "generic oversized file finding emitted");
		ensureNonEmptyEvidence(findings);

		const embeddedRun = "coder-embedded-auto-exit";
		check(!findings.some((item) => item.code === "delegate_missing_done" && item.runIds.includes(embeddedRun)),
			`embedded done run ${embeddedRun} does NOT emit delegate_missing_done`);
		check(findings.some((item) => item.code === "delegate_auto_exit" && item.runIds.includes(embeddedRun)),
			`embedded done run ${embeddedRun} emits delegate_auto_exit`);

		const retryFinding = findings.find((item) => item.code === "reviewer_retries_repeated");
		check(retryFinding !== undefined, "reviewer_retries_repeated present in risky fixture");
		if (retryFinding) {
			for (const ref of retryFinding.evidenceRefs) {
				check(resolveEvidenceRef(cwd, ref).resolved, `reviewer_retries_repeated evidence ref ${ref} resolves inside fixture`);
			}
		}

		assertStrictContract(findings, cwd, MEDIUM_OR_HIGHER);
		assertStrictContract(findings, cwd, new Set(["warning"]));

		const cfgRefs = findings.filter((f) => f.code === "workflow_cfg_large_file").flatMap((f) => f.evidenceRefs);
		check(cfgRefs.some((ref) => stripLineSuffix(ref).endsWith("configure-overlay.ts")),
			"workflow_cfg_large_file evidence includes extensions/configure-overlay.ts path");
		check(cfgRefs.some((ref) => stripLineSuffix(ref).endsWith("task-028-workflow-cfg-smokes.ts")),
			"workflow_cfg_large_file evidence includes scripts/task-028-workflow-cfg-smokes.ts path");
	});
}

function runEmbeddedDoneSmoke(): void {
	withTempWorkspace("task-009-embedded", (cwd) => {
		const root = path.join(cwd, ".pi", "workflow-runs", "delegates");
		fs.mkdirSync(root, { recursive: true });
		const manifest = {
			runId: "embedded-only", agent: "coder", task: "Task TASK-099", state: "completed",
			doneFile: "/var/folders/nowhere/embedded-only.done.json",
			done: { done: true, completion: "auto_exit" as const },
		};
		writeJson(path.join(root, "embedded-only.json"), manifest);
		const findings = readFixtureFindings(cwd, {
			maxDelegateManifests: 10, maxTaskFiles: 5, maxProgressFiles: 5, maxDebugItems: 5,
			maxMetricFiles: 5, maxMetricLines: 5, maxAgeDays: 1,
		});
		check(findings.some((item) => item.code === "delegate_auto_exit" && item.runIds.includes("embedded-only")),
			"embedded-done fixture emits delegate_auto_exit");
		check(!findings.some((item) => item.code === "delegate_missing_done" && item.runIds.includes("embedded-only")),
			"embedded-done fixture does NOT emit delegate_missing_done");
		for (const finding of findings) {
			for (const ref of finding.evidenceRefs) {
				check(!ref.includes("/var/folders/nowhere/"), `embedded-done evidence ref ${ref} excludes absolute outside-cwd path`);
			}
		}
		const escapeRef = path.join("..", "..", "..", "..", "var", "folders", "nowhere", "embedded-only.done.json");
		const escapeProbe = resolveEvidenceRef(cwd, escapeRef);
		check(escapeProbe.inside === false, `escape ref ${escapeRef} is detected as outside-cwd`);
		check(escapeProbe.resolved === false, `escape ref ${escapeRef} is rejected by strict resolver even if file exists`);
		const absRef = "/var/folders/nowhere/embedded-only.done.json";
		const absProbe = resolveEvidenceRef(cwd, absRef);
		check(absProbe.inside === false, `absolute outside-cwd ref ${absRef} is detected as outside-cwd`);
		check(absProbe.resolved === false, `absolute outside-cwd ref ${absRef} is rejected by strict resolver`);
		const autoExitFinding = findings.find((item) => item.code === "delegate_auto_exit" && item.runIds.includes("embedded-only"));
		check(autoExitFinding !== undefined, "embedded-done auto_exit finding present");
		if (autoExitFinding) {
			for (const ref of autoExitFinding.evidenceRefs) {
				const probe = resolveEvidenceRef(cwd, ref);
				check(probe.inside, `embedded-done auto_exit evidence ref ${ref} is inside-cwd`);
				check(probe.resolved, `embedded-done auto_exit evidence ref ${ref} resolves inside fixture`);
			}
		}
		assertStrictContract(findings, cwd, MEDIUM_OR_HIGHER);
		assertStrictContract(findings, cwd, new Set(["warning"]));
	});
}

function runProgressOnlySmoke(): void {
	withTempWorkspace("task-009-progress", (cwd) => {
		writeText(path.join(cwd, ".sprints", "sprints", "SPR-qa-progress", "progress", "PROGRESS.md"), [
			"## Notes",
			"- 2026-06-10T00:00:00Z task-555 -> done",
			"- 2026-06-10T00:00:30Z completed task-556",
			"- 2026-06-10T00:01:00Z dbg-010 completed",
			"",
		].join("\n"));
		const findings = readFixtureFindings(cwd, {
			maxDelegateManifests: 5, maxTaskFiles: 5, maxProgressFiles: 5, maxDebugItems: 5,
			maxMetricFiles: 5, maxMetricLines: 5, maxAgeDays: 1,
		});
		const debugChain = findings.filter((item) => item.code === "debug_chain_after_done");
		check(debugChain.length > 0, "PROGRESS-only fixture emits debug_chain_after_done after a done task followed by completed DBG");
		check(debugChain.flatMap((item) => item.taskIds).includes("DBG-010"),
			"PROGRESS-only fixture debug_chain_after_done references DBG-010 (case-normalized)");
		for (const item of debugChain) {
			for (const ref of item.evidenceRefs) {
				check(resolveEvidenceRef(cwd, ref).resolved, `PROGRESS-only debug_chain_after_done evidence ref ${ref} resolves to a real file`);
			}
		}
	});
}

function runDelegateMtimeOrderSmoke(): void {
	withTempWorkspace("task-009-delegate-mtime", (cwd) => {
		const OLD = 1_700_000_000_000; // 2023-11-14T22:13:20Z
		const NEW = 1_800_000_000_000; // ~111 days later
		createDelegateManifest(cwd, {
			runId: "aaa-old-clean", agent: "coder", state: "completed",
			withSidecar: true, sidecarDone: true, completion: "explicit",
			taskId: "TASK-040", mtimeMs: OLD,
		});
		createDelegateManifest(cwd, {
			runId: "zzz-recent-risky", agent: "coder", state: "failed",
			withSidecar: true, sidecarDone: false, completion: "auto_exit",
			taskId: "TASK-040", mtimeMs: NEW,
		});
		const findings = readFixtureFindings(cwd, {
			maxDelegateManifests: 1, maxTaskFiles: 5, maxProgressFiles: 5,
			maxDebugItems: 5, maxMetricFiles: 5, maxMetricLines: 5, maxAgeDays: 0,
		});
		check(findings.some((item) => item.code === "delegate_failed_coder" && item.runIds.includes("zzz-recent-risky")),
			"maxDelegateManifests=1 still scans lexicographically-later recent risky manifest (delegate_failed_coder)");
		check(findings.some((item) => item.code === "delegate_auto_exit" && item.runIds.includes("zzz-recent-risky")),
			"maxDelegateManifests=1 still scans lexicographically-later recent risky manifest (delegate_auto_exit)");
		check(!findings.some((item) => item.runIds.includes("aaa-old-clean")),
			"maxDelegateManifests=1 skips lexicographically-first older clean manifest");
	});
}

// Regression for the >1000 lexicographic pre-cap. The pre-fix scanner used
// collectCap = max(maxDelegateManifests * 4, 1000) before the mtime sort, so
// a directory containing 1100+ lexicographically earlier old clean manifests
// would lose any lexicographically-later newer risky manifest. This smoke
// creates 1100 aaa-* clean manifests (old mtime) + 1 zzz-* risky manifest
// (new mtime), runs with maxDelegateManifests=1, and asserts the risky
// manifest still emits delegate_failed_coder and delegate_auto_exit.
function runBulkDelegateMtimeSortSmoke(): void {
	withTempWorkspace("task-009-bulk-mtime", (cwd) => {
		const OLD = 1_700_000_000_000; // 2023-11-14T22:13:20Z
		const NEW = 1_800_000_000_000; // ~111 days later
		const BULK_COUNT = 1100;
		createBulkOldCleanDelegateManifests(cwd, BULK_COUNT, OLD, "TASK-091");
		createDelegateManifest(cwd, {
			runId: "zzz-recent-risky", agent: "coder", state: "failed",
			withSidecar: true, sidecarDone: false, completion: "auto_exit",
			taskId: "TASK-091", mtimeMs: NEW,
		});
		const findings = readFixtureFindings(cwd, {
			maxDelegateManifests: 1, maxTaskFiles: 5, maxProgressFiles: 5,
			maxDebugItems: 5, maxMetricFiles: 5, maxMetricLines: 5, maxAgeDays: 0,
		});
		check(findings.some((item) => item.code === "delegate_failed_coder" && item.runIds.includes("zzz-recent-risky")),
			`bulk fixture (${BULK_COUNT} aaa-* old + 1 zzz-* new) with maxDelegateManifests=1 surfaces delegate_failed_coder for zzz-recent-risky`);
		check(findings.some((item) => item.code === "delegate_auto_exit" && item.runIds.includes("zzz-recent-risky")),
			`bulk fixture (${BULK_COUNT} aaa-* old + 1 zzz-* new) with maxDelegateManifests=1 surfaces delegate_auto_exit for zzz-recent-risky`);
		check(!findings.some((item) => item.runIds.some((id) => id.startsWith("aaa-"))),
			`bulk fixture (${BULK_COUNT} aaa-* old + 1 zzz-* new) with maxDelegateManifests=1 excludes aaa-* manifests from the slice`);
	});
}

// Regression for the delegate sidecar mtime bug. The pre-fix scanner walked
// every `*.json` file under `.pi/workflow-runs/delegates`, including
// `<runId>.done.json` sidecars. Because sidecars are written after their
// manifest, a sidecar's mtime is typically newer than the manifest's, so
// `maxDelegateManifests: 1` could select the sidecar, parse it as a
// non-manifest, and silently drop the real risky manifest. This smoke
// creates a single risky manifest with a sidecar whose mtime is newer than
// the manifest, runs with `maxDelegateManifests: 1`, and asserts the
// manifest is still scanned and emits delegate_failed_coder /
// delegate_auto_exit for that run.
function runDelegateSidecarMtimeSmoke(): void {
	withTempWorkspace("task-009-delegate-sidecar-mtime", (cwd) => {
		const OLD = 1_700_000_000_000; // 2023-11-14T22:13:20Z (manifest mtime)
		const NEW = 1_800_000_000_000; // ~111 days later (sidecar mtime)
		createDelegateManifest(cwd, {
			runId: "risky-with-newer-sidecar",
			agent: "coder",
			state: "failed",
			withSidecar: true,
			sidecarDone: false,
			completion: "auto_exit",
			taskId: "TASK-009",
			mtimeMs: OLD,
			sidecarMtimeMs: NEW,
		});
		const findings = readFixtureFindings(cwd, {
			maxDelegateManifests: 1,
			maxTaskFiles: 5,
			maxProgressFiles: 5,
			maxDebugItems: 5,
			maxMetricFiles: 5,
			maxMetricLines: 5,
			maxAgeDays: 0,
		});
		check(findings.some((item) => item.code === "delegate_failed_coder" && item.runIds.includes("risky-with-newer-sidecar")),
			"manifest with newer .done.json sidecar still emits delegate_failed_coder under maxDelegateManifests=1");
		check(findings.some((item) => item.code === "delegate_auto_exit" && item.runIds.includes("risky-with-newer-sidecar")),
			"manifest with newer .done.json sidecar still emits delegate_auto_exit under maxDelegateManifests=1");
		// The sidecar must not be parsed/treated as a delegate manifest.
		check(!findings.some((item) => item.runIds.includes("risky-with-newer-sidecar.done")),
			"sidecar file (risky-with-newer-sidecar.done) is not treated as a manifest");
	});
}

// Regression for the outside-cwd `doneFile` sidecar bug. When a manifest has
// `state: completed`, no embedded done, and `doneFile` points to an existing
// file outside `cwd` containing `{done:false, completion:"auto_exit"}`, the
// audit must treat the outside sidecar as absent for ALL semantics: it should
// emit `delegate_missing_done` (no embedded + no repo-local sidecar) and must
// NOT emit `delegate_failed_coder` or `delegate_auto_exit` based on the
// outside-cwd sidecar contents. Evidence refs must never include the outside
// path and every medium+ ref must resolve inside `cwd`.
function runOutsideCwdSidecarSmoke(): void {
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-009-outside-sidecar-"));
	try {
		withTempWorkspace("task-009-outside-sidecar", (cwd) => {
			const outsideDonePath = path.join(outsideDir, "outside-sidecar.done.json");
			writeJson(outsideDonePath, { done: false, completion: "auto_exit" });
			const root = path.join(cwd, ".pi", "workflow-runs", "delegates");
			fs.mkdirSync(root, { recursive: true });
			const runId = "outside-cwd-sidecar";
			writeJson(path.join(root, `${runId}.json`), {
				runId,
				agent: "coder",
				task: "Task TASK-009",
				state: "completed",
				doneFile: outsideDonePath,
			});
			const findings = readFixtureFindings(cwd, {
				maxDelegateManifests: 5, maxTaskFiles: 5, maxProgressFiles: 5, maxDebugItems: 5,
				maxMetricFiles: 5, maxMetricLines: 5, maxAgeDays: 1,
			});
			check(findings.some((item) => item.code === "delegate_missing_done" && item.runIds.includes(runId)),
				"outside-cwd sidecar run emits delegate_missing_done");
			check(!findings.some((item) => item.code === "delegate_failed_coder" && item.runIds.includes(runId)),
				"outside-cwd sidecar run does NOT emit delegate_failed_coder");
			check(!findings.some((item) => item.code === "delegate_auto_exit" && item.runIds.includes(runId)),
				"outside-cwd sidecar run does NOT emit delegate_auto_exit");
			for (const finding of findings) {
				for (const ref of finding.evidenceRefs) {
					const stripped = stripLineSuffix(ref);
					check(stripped !== outsideDonePath && !stripped.includes(outsideDonePath),
						`evidence ref ${ref} excludes outside-cwd sidecar path ${outsideDonePath}`);
				}
			}
			for (const finding of findings) {
				if (!MEDIUM_OR_HIGHER.has(finding.severity)) continue;
				for (const ref of finding.evidenceRefs) {
					const probe = resolveEvidenceRef(cwd, ref);
					check(probe.inside, `medium+ ${finding.code} evidence ref ${ref} is inside-cwd`);
					check(probe.resolved, `medium+ ${finding.code} evidence ref ${ref} resolves inside fixture`);
				}
			}
		});
	} finally {
		try {
			fs.rmSync(outsideDir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	}
}

function runRealRepoSmoke(): void {
	const report = runWorkflowQualityAudit(process.cwd(), {
		maxDelegateManifests: 200, maxTaskFiles: 200, maxProgressFiles: 120, maxDebugItems: 40,
		maxMetricFiles: 200, maxMetricLines: 300, maxAgeDays: 3650,
	});
	const findings = toSmoked(report);
	check(findings.length > 0, "real repo produces findings for known quality risks");
	ensureCodesPresent(findings, [
		"TASK-028", "TASK-029",
		"DBG-001", "DBG-002", "DBG-003", "DBG-004", "DBG-005", "DBG-006",
		"workflow_cfg_large_file",
	]);
	check(findings.some((item) => item.code === "delegate_failed_coder"), "real repo surfaces failed coder delegate signals");
	check(findings.some((item) => item.code === "delegate_auto_exit") || findings.some((item) => item.code === "delegate_process_exit"),
		"real repo surfaces delegate completion exit risk");
	check(findings.some((item) => item.code === "debug_chain_after_done"), "real repo surfaces debug chain risk");
	check(findings.some((item) => item.code === "prompt_only_completion"), "real repo surfaces prompt-only language risk");
	check(renderWorkflowQualityAuditReport(report).includes("## Findings"), "renderer emits findings section when findings exist");

	const cfgRefs = findings.filter((f) => f.code === "workflow_cfg_large_file").flatMap((f) => f.evidenceRefs).map((r) => stripLineSuffix(r));
	check(cfgRefs.length > 0, "real repo has workflow_cfg_large_file findings");
	check(cfgRefs.includes("extensions/workflow/configure-overlay.ts"),
		"real repo workflow_cfg_large_file evidence includes extensions/workflow/configure-overlay.ts");
	check(cfgRefs.includes("scripts/task-028-workflow-cfg-smokes.ts"),
		"real repo workflow_cfg_large_file evidence includes scripts/task-028-workflow-cfg-smokes.ts");

	const exitCodes = ["delegate_auto_exit", "delegate_process_exit"];
	const exitFindings = findings.filter((item) => exitCodes.includes(item.code));
	check(exitFindings.length > 0, "real repo surfaces delegate_auto_exit/process_exit findings");
	for (const item of exitFindings) {
		for (const ref of item.evidenceRefs) {
			const probe = resolveEvidenceRef(process.cwd(), ref);
			check(probe.inside, `real-repo ${item.code} evidence ref ${ref} is inside-cwd (no /var/... escape)`);
			check(probe.resolved, `real-repo ${item.code} evidence ref ${ref} resolves to a real file in repo`);
			check(!ref.includes("/var/"), `real-repo ${item.code} evidence ref ${ref} excludes /var/ outside-cwd path`);
		}
	}
	assertStrictContract(findings, process.cwd(), MEDIUM_OR_HIGHER);
	assertStrictContract(findings, process.cwd(), WARNING_OR_HIGHER);

	const summary = buildWorkflowQualityAuditFinalizationSummary(report, { taskId: "TASK-009" });
	check(summary.taskId === "TASK-009", "finalization summary carries taskId filter");
	check(typeof summary.artifactPath === "string" && summary.artifactPath.length > 0, "finalization summary has non-empty artifactPath");
	check(typeof summary.artifactLink === "string" && summary.artifactLink.length > 0, "finalization summary has non-empty artifactLink");
	check(!path.isAbsolute(summary.artifactLink), "finalization summary artifactLink is repo-relative (not absolute)");
	check(Number.isFinite(summary.totalFindings), "finalization summary totalFindings is a finite number");
	check(Number.isFinite(summary.criticalOrHighCount), "finalization summary criticalOrHighCount is a finite number");
	check(Number.isFinite(summary.warningOrHighCount), "finalization summary warningOrHighCount is a finite number");
	check(summary.byCode && typeof summary.byCode === "object", "finalization summary byCode is a numeric-keyed object");
	check(Array.isArray(summary.firstFindingMessages), "finalization summary firstFindingMessages is an array");

	const reparsed = JSON.parse(JSON.stringify(summary)) as typeof summary;
	check(reparsed.artifactLink === summary.artifactLink, "finalization summary roundtrips through JSON for downstream linkage");

	const top = readFixtureFindings(process.cwd(), { maxMetricLines: 150 });
	check(top.length >= findings.length, "default real-repo re-run with lower thresholds is at least as permissive");
}

// Regression: `metricFileDirs` containing a `../outside` path used to allow
// `path.join(cwd, relDir)` to resolve outside the scanned cwd, after which
// `collectFiles` walked the outside directory and emitted evidence refs like
// `../outside/secret.ts`. The fix in `scanMetrics` rejects any dir that
// resolves outside cwd.
function runOutsideCwdMetricDirSmoke(): void {
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-009-outside-metric-"));
	try {
		withTempWorkspace("task-009-outside-metric", (cwd) => {
			makeBigFile(path.join(outsideDir, "secret.ts"), 220);
			const findings = readFixtureFindings(cwd, {
				maxDelegateManifests: 5, maxTaskFiles: 5, maxProgressFiles: 5, maxDebugItems: 5,
				maxMetricFiles: 20, maxMetricLines: 100, maxAgeDays: 1,
				metricFileDirs: ["extensions", path.relative(cwd, outsideDir)], metricExtensions: [".ts"],
			});
			const outsideRefs = findings.flatMap((f) => f.evidenceRefs).map((r) => stripLineSuffix(r));
			check(!outsideRefs.some((ref) => ref.includes("secret.ts")),
				"outside-cwd metric dir is rejected and does not emit secret.ts evidence");
			check(!outsideRefs.some((ref) => ref.startsWith("../")),
				"outside-cwd metric dir does not emit any ../ evidence ref");
			check(findings.every((f) => f.evidenceRefs.every((ref) => !ref.includes(outsideDir))),
				"no finding evidence ref contains the outside-cwd absolute path");
		});
	} finally {
		try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
	}
}

// Phase B tool-registration and finalization-linkage smoke is implemented in
// fixtures (see `runToolRegistrationAndFinalizationSmoke`) so this runner
// stays under the 500 LOC limit. It is invoked from `main()` below.

async function main(): Promise<void> {
	runCleanFixtureSmoke();
	runRiskyFixtureSmoke();
	runEmbeddedDoneSmoke();
	runProgressOnlySmoke();
	runDelegateMtimeOrderSmoke();
	runBulkDelegateMtimeSortSmoke();
	runDelegateSidecarMtimeSmoke();
	runOutsideCwdSidecarSmoke();
	runRealRepoSmoke();
	runOutsideCwdMetricDirSmoke();
	runToolRegistrationAndFinalizationSmoke(check);
	await runAuditToolExecuteSmoke(check);

	if (failures > 0) {
		console.error(`TASK-009 workflow-audit smokes failed: ${failures} assertion${failures === 1 ? "" : "s"}`);
		process.exitCode = 1;
		return;
	}
	console.log("TASK-009 workflow-audit smokes passed");
}

main();
