#!/usr/bin/env node
// TASK-005 Phase B — finalization-runtime disk adapter smoke checks.
// These fixtures validate plan/reviewer/coder evidence resolution from disk artifacts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
	AcceptanceEvidenceMatrixEntry,
	WorkflowArchitecturePlan,
} from "../extensions/workflow/architecture/types";
import { evaluateSprintTaskFinalizationFromDisk } from "../extensions/workflow/finalization-runtime";

let failures = 0;

function check(condition: boolean, message: string): void {
	if (condition) {
		console.log(`PASS: ${message}`);
		return;
	}
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function makeMatrixEntry(overrides: Partial<AcceptanceEvidenceMatrixEntry>): AcceptanceEvidenceMatrixEntry {
	return {
		criterion: "criterion",
		criterionKind: "runtime-behavior",
		businessRiskIfWrong: "production regression",
		enforcementLevel: ["behavior-test"],
		requiredEvidence: [{ kind: "behavior-test", description: "run behavior test" }],
		reviewerRoles: ["behavior"],
		blockingConditions: ["behavior test fails"],
		...overrides,
	};
}

function makePlan(overrides: Partial<WorkflowArchitecturePlan> = {}): WorkflowArchitecturePlan {
	const entries = overrides.acceptanceEvidenceMatrix ?? [
		makeMatrixEntry({
			criterion: "runtime-check",
			criterionKind: "runtime-behavior",
			requiredEvidence: [{ kind: "behavior-test", description: "runtime behavior test", command: "npx tsx test-runtime.ts" }],
			enforcementLevel: ["behavior-test"],
		}),
		makeMatrixEntry({
			criterion: "docs-check",
			criterionKind: "documentation",
			reviewerRoles: ["docs-config"],
			enforcementLevel: ["manual-validation"],
			requiredEvidence: [{ kind: "manual-validation", description: "docs reviewer signed off" }],
			blockingConditions: ["manual review missing"],
		}),
	];
	return {
		planId: "task-005",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "ready",
		businessPlan: "b",
		technicalPlan: "t",
		parallelAssessment: "serial",
		contractBlockPlan: "c",
		acceptanceCriteria: entries.map((entry) => entry.criterion),
		acceptanceEvidenceMatrix: entries,
		phases: {
			phaseA: { status: "review_approved" as const, updatedAt: new Date().toISOString(), evidence: [] },
			phaseB: { status: "not_started" as const, updatedAt: new Date().toISOString(), evidence: [] },
		},
		...overrides,
	};
}

function makeEvidencePacket() {
	return {
		filesChanged: ["src/task.ts"],
		commandsRun: [{ command: "npx tsx test-runtime.ts", outcome: "passed", summary: "runtime behavior test passes", exitCode: 0 }],
		criterionCoverage: [
			{
				criterion: "runtime-check",
				evidenceKind: "behavior-test",
				strength: "sufficient",
				supportingFiles: ["src/task.ts"],
				supportingCommands: ["npx tsx test-runtime.ts"],
				summary: "runtime behavior covered",
			},
			{
				criterion: "docs-check",
				evidenceKind: "manual-validation",
				strength: "manual-caveat",
				supportingFiles: ["docs/readme.md"],
				supportingCommands: ["echo docs validated"],
				summary: "docs validated",
				caveats: "manual docs review",
			},
		],
		knownGaps: [],
		caveats: ["none"],
		summary: "coder delegate evidence",
	};
}

function writeText(filePath: string, value: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${value}\n`);
}

function writeJson(filePath: string, value: unknown): void {
	writeText(filePath, JSON.stringify(value, null, 2));
}

function buildReviewerMemoFile(cwd: string, planId: string, phase: "phaseA" | "phaseB"): string {
	return path.join(cwd, ".pi", "workflow-runs", "reviewer-memos", `${planId}-${phase}.md`);
}

function withTempWorkspace<T>(label: string, run: (cwd: string) => T): T {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
	try {
		return run(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function writePlanFixture(cwd: string, planId: string, taskId: string, planOverrides: Partial<WorkflowArchitecturePlan> = {}): WorkflowArchitecturePlan {
	const now = new Date().toISOString();
	const sprintId = `SPR-${planId.replace(/[^a-z0-9]+/gi, "-")}`;
	const sprintPath = path.join(cwd, ".sprints", "sprints", sprintId);
	const storagePath = path.join(sprintPath, "artifacts", "workflow-architecture", `${planId}.json`);
	writeJson(path.join(sprintPath, "sprint.json"), {
		id: sprintId,
		title: `Sprint ${sprintId}`,
		createdAt: now,
		updatedAt: now,
		taskCount: 0,
	});
	writeJson(path.join(cwd, ".sprints", "current.json"), {
		activeSprintPath: path.join(".sprints", "sprints", sprintId),
		activeTaskPath: null,
		updatedAt: now,
	});
	const plan = makePlan({
		planId,
		taskId,
		status: "ready",
		updatedAt: now,
		...planOverrides,
	});
	writeJson(storagePath, plan);
	return plan;
}

function writeReviewerMemoFixture(
	cwd: string,
	planId: string,
	phase: "phaseA" | "phaseB",
	recommendation: string,
	missingRoles: string[] = [],
	promptOnlyCaveats: string[] = [],
	changesRequested: string[] = [],
	unknownOrFailed: string[] = [],
): void {
	const file = buildReviewerMemoFile(cwd, planId, phase);
	const missingRolesLines = missingRoles.length > 0 ? missingRoles.map((role) => `- ${role}`) : ["- none"];
	const promptOnlyLines = promptOnlyCaveats.length > 0 ? promptOnlyCaveats.map((caveat) => `- ${caveat}`) : ["- none"];
	const changesRequestedLines = changesRequested.length > 0 ? changesRequested.map((entry) => `- ${entry}`) : ["- none"];
	const unknownOrFailedLines = unknownOrFailed.length > 0 ? unknownOrFailed.map((entry) => `- ${entry}`) : ["- none"];
	const body = `# Reviewer Memo for ${planId}\n\n## Final recommendation\n${recommendation}\n\n## Missing required roles\n${missingRolesLines.join("\n")}\n\n## Changes requested\n${changesRequestedLines.join("\n")}\n\n## Unknown / failed\n${unknownOrFailedLines.join("\n")}\n\n## Prompt-only caveats\n${promptOnlyLines.join("\n")}\n`;
	writeText(file, body);
}

function writeDelegateManifest(cwd: string, input: {
	runId: string;
	planId: string;
	agent: "coder" | "reviewer";
	status: "completed" | "failed" | "aborted";
	completion: "explicit" | "auto_exit" | "process_exit";
	hasSidecar: boolean;
	at?: string;
	withCoderEvidence: boolean;
	note?: string;
	// TASK-002 Phase B: optional sidecar format override. The default
	// (`"canonical"`) writes the canonical `evidence: { coderEvidence }`
	// envelope. `"legacy-top-level"` deliberately writes top-level
	// `coderEvidence` only (no `evidence` envelope) so a regression
	// smoke can prove strict finalization blocks on a legacy-only
	// sidecar. The legacy format is NEVER used in success-path smokes.
	sidecarFormat?: "canonical" | "legacy-top-level";
}): void {
	const root = path.join(cwd, ".pi", "workflow-runs", "delegates");
	fs.mkdirSync(root, { recursive: true });
	const now = input.at ?? new Date().toISOString();
	const donePath = path.join(root, `${input.runId}.done.json`);
	const evidence = input.withCoderEvidence ? makeEvidencePacket() : undefined;
	const manifest: Record<string, unknown> = {
		manifestVersion: 1,
		runId: input.runId,
		startedAt: now,
		updatedAt: now,
		cwd,
		agent: input.agent,
		task: `Architecture plan ${input.planId} completion`,
		taskPreview: `Finalize architecture plan ${input.planId}`,
		groupKey: `task-${input.planId}`,
		groupTitle: `Task ${input.planId}`,
		tabTitle: `Task ${input.planId}`,
		sessionFile: path.join(root, `${input.runId}.session.json`),
		stderrFile: path.join(root, `${input.runId}.stderr.log`),
		activityFile: path.join(root, `${input.runId}.activity.json`),
		doneFile: donePath,
		state: input.status,
	};
	if (input.hasSidecar) {
		// TASK-002 HARD-CUT (Phase B): successful coder sidecars must
		// write the canonical `evidence: { coderEvidence }` envelope,
		// not top-level `coderEvidence`. The top-level `coderEvidence`
		// field is a legacy diagnostic and cannot satisfy strict
		// finalization. The fixture therefore writes the canonical
		// envelope as the strict success path; the
		// `sidecarFormat: "legacy-top-level"` option below lets a
		// regression case deliberately write a legacy-only sidecar
		// to prove strict finalization blocks on it.
		const envelope: Record<string, unknown> | undefined = input.withCoderEvidence && evidence
			? { coderEvidence: evidence }
			: undefined;
		const sidecarBody: Record<string, unknown> = {
			done: input.status === "completed",
			summary: input.note || `${input.runId} completed`,
			at: now,
			completion: input.completion,
		};
		if (input.sidecarFormat === "legacy-top-level") {
			// Legacy-only: writes top-level `coderEvidence` and NO
			// `evidence` envelope. Used to prove strict finalization
			// must fail closed on this path.
			sidecarBody.coderEvidence = evidence;
		} else if (envelope !== undefined) {
			sidecarBody.evidence = envelope;
		}
		writeJson(donePath, sidecarBody);
	}
	writeJson(path.join(root, `${input.runId}.json`), manifest);
}

function main(): void {
	const pass = withTempWorkspace("task-005-adapter-success", (cwd) => {
		const plan = makePlan({
			planId: "task-005-success",
			taskId: "TASK-005-8",
			phases: {
				phaseA: { status: "not_started" as const, updatedAt: new Date().toISOString(), evidence: [] },
				phaseB: { status: "review_approved" as const, updatedAt: new Date().toISOString(), evidence: [] },
			},
		});
		writePlanFixture(cwd, plan.planId, "TASK-005-8", { phases: plan.phases, taskId: "TASK-005-8" });
		writeReviewerMemoFixture(cwd, plan.planId, "phaseB", "APPROVED");
		writeDelegateManifest(cwd, {
			runId: "task-005-success-coder",
			planId: plan.planId,
			agent: "coder",
			status: "completed",
			completion: "explicit",
			hasSidecar: true,
			withCoderEvidence: true,
			note: "Completed with sidecar evidence",
		});
		return evaluateSprintTaskFinalizationFromDisk({
			cwd,
			taskId: "TASK-005-8",
			requestedStatus: "done",
			mode: "strict",
			finalEvidence: "All checks completed in delegate sidecar.",
			finalNote: "All checks passed",
		});
	});
	check(pass.ok === true, "runtime: adapter strict mode passes with disk-backed artifacts");
	check(pass.allowed === true, "runtime: adapter strict pass remains allowed");
	check(pass.strictBlocking === false, "runtime: adapter strict decision is non-blocking");
	check(
		pass.details?.reviewer.present === true,
		"runtime: reviewer memo parse is present for APPROVED fixture",
	);
	check(pass.details?.reviewer.missingRequiredRoles.length === 0, "runtime: reviewer memo with '- none' maps to no missing roles");

	const missingMemo = withTempWorkspace("task-005-adapter-missing-memo", (cwd) => {
		const plan = makePlan({
			planId: "task-005-memo",
			taskId: "TASK-005-9",
			phases: {
				phaseA: { status: "review_approved" as const, updatedAt: new Date().toISOString(), evidence: [] },
				phaseB: { status: "not_started" as const, updatedAt: new Date().toISOString(), evidence: [] },
			},
		});
		writePlanFixture(cwd, plan.planId, "TASK-005-9", { phases: plan.phases, taskId: "TASK-005-9" });
		writeDelegateManifest(cwd, {
			runId: "task-005-memo-coder",
			planId: plan.planId,
			agent: "coder",
			status: "completed",
			completion: "explicit",
			hasSidecar: true,
			withCoderEvidence: true,
			note: "Completed with sidecar evidence",
		});
		return {
			strict: evaluateSprintTaskFinalizationFromDisk({ cwd, taskId: "TASK-005-9", requestedStatus: "done", mode: "strict" }),
			dry: evaluateSprintTaskFinalizationFromDisk({ cwd, taskId: "TASK-005-9", requestedStatus: "done", mode: "dry-run" }),
		};
	});
	check(missingMemo.strict.ok === false, "runtime: adapter strict blocks when reviewer memo is missing");
	check(missingMemo.strict.blockers.some((reason) => reason.toLowerCase().includes("reviewer memo") || reason.toLowerCase().includes("memo")),
		"runtime: missing memo blocker is visible");
	check(missingMemo.dry.ok === true, "runtime: adapter dry-run remains allowed while memo is missing");
	check(missingMemo.dry.strictBlocking === true, "runtime: dry-run keeps strictBlocking when memo is missing");

	const phaseBChangesRequestedInSection = withTempWorkspace("task-005-adapter-phaseb-section-block", (cwd) => {
		const plan = makePlan({
			planId: "task-005-section-block",
			taskId: "TASK-005-12",
			phases: {
				phaseA: { status: "review_approved" as const, updatedAt: new Date().toISOString(), evidence: [] },
				phaseB: { status: "changes_requested" as const, updatedAt: new Date().toISOString(), evidence: [] },
			},
		});
		writePlanFixture(cwd, plan.planId, "TASK-005-12", { phases: plan.phases, taskId: "TASK-005-12" });
		writeReviewerMemoFixture(cwd, plan.planId, "phaseA", "APPROVED");
		writeReviewerMemoFixture(cwd, plan.planId, "phaseB", "APPROVED", [], [], ["Address remaining runtime findings before done"]);
		writeDelegateManifest(cwd, {
			runId: "task-005-section-block-coder",
			planId: plan.planId,
			agent: "coder",
			status: "completed",
			completion: "explicit",
			hasSidecar: true,
			withCoderEvidence: true,
			note: "Completed with sidecar evidence",
		});
		return evaluateSprintTaskFinalizationFromDisk({
			cwd,
			taskId: "TASK-005-12",
			requestedStatus: "done",
			mode: "strict",
		});
	});
	check(phaseBChangesRequestedInSection.ok === false, "runtime: phaseB memo wins when phaseB has started even if final recommendation is APPROVED");
	check(phaseBChangesRequestedInSection.blockers.some((reason) => reason.toLowerCase().includes("reviewer") || reason.toLowerCase().includes("changes")),
		"runtime: section-based changes-requested blocker blocks finalization");

	const missingCoder = withTempWorkspace("task-005-adapter-missing-coder", (cwd) => {
		const plan = makePlan({
			planId: "task-005-coder",
			taskId: "TASK-005-10",
			phases: {
				phaseA: { status: "review_approved" as const, updatedAt: new Date().toISOString(), evidence: [] },
				phaseB: { status: "not_started" as const, updatedAt: new Date().toISOString(), evidence: [] },
			},
		});
		writePlanFixture(cwd, plan.planId, "TASK-005-10", { phases: plan.phases, taskId: "TASK-005-10" });
		writeReviewerMemoFixture(cwd, plan.planId, "phaseA", "APPROVED");
		return evaluateSprintTaskFinalizationFromDisk({
			cwd,
			taskId: "TASK-005-10",
			requestedStatus: "done",
			mode: "strict",
		});
	});
	check(missingCoder.ok === false, "runtime: adapter strict blocks when delegate coder evidence is missing");
	check(missingCoder.blockers.some((reason) => reason.toLowerCase().includes("coder") || reason.toLowerCase().includes("evidence")),
		"runtime: missing coder blocker is surfaced by adapter");

	const reviewerEvidenceOnly = withTempWorkspace("task-005-adapter-reviewer-evidence-only", (cwd) => {
		const plan = makePlan({
			planId: "task-005-reviewer-evidence-only",
			taskId: "TASK-005-11",
			phases: {
				phaseA: { status: "review_approved" as const, updatedAt: new Date().toISOString(), evidence: [] },
				phaseB: { status: "not_started" as const, updatedAt: new Date().toISOString(), evidence: [] },
			},
		});
		writePlanFixture(cwd, plan.planId, "TASK-005-11", { phases: plan.phases, taskId: "TASK-005-11" });
		writeReviewerMemoFixture(cwd, plan.planId, "phaseA", "APPROVED");
		writeDelegateManifest(cwd, {
			runId: "task-005-reviewer-evidence-only-reviewer",
			planId: plan.planId,
			agent: "reviewer",
			status: "completed",
			completion: "explicit",
			hasSidecar: true,
			withCoderEvidence: true,
			note: "Reviewer sidecar includes coderEvidence-shaped payload",
		});
		return evaluateSprintTaskFinalizationFromDisk({
			cwd,
			taskId: "TASK-005-11",
			requestedStatus: "done",
			mode: "strict",
		});
	});
	check(reviewerEvidenceOnly.ok === false, "runtime: reviewer-side coderEvidence-only should not satisfy coder evidence requirement");
	check(reviewerEvidenceOnly.blockers.some((reason) => reason.toLowerCase().includes("coder") || reason.toLowerCase().includes("evidence")),
		"runtime: reviewer-only evidence sidecar is rejected for coder proof");

	// TASK-002 Phase B regression: a coder sidecar that contains ONLY a
	// top-level `coderEvidence` field (the old legacy shape) and NO
	// canonical `evidence: { coderEvidence }` envelope must NOT
	// satisfy strict finalization. The adapter treats this as
	// missing coder evidence, so the gate must block.
	const legacyTopLevelOnly = withTempWorkspace("task-005-adapter-legacy-top-level", (cwd) => {
		const plan = makePlan({
			planId: "task-005-legacy-top-level",
			taskId: "TASK-005-12",
			phases: {
				phaseA: { status: "review_approved" as const, updatedAt: new Date().toISOString(), evidence: [] },
				phaseB: { status: "not_started" as const, updatedAt: new Date().toISOString(), evidence: [] },
			},
		});
		writePlanFixture(cwd, plan.planId, "TASK-005-12", { phases: plan.phases, taskId: "TASK-005-12" });
		writeReviewerMemoFixture(cwd, plan.planId, "phaseA", "APPROVED");
		writeDelegateManifest(cwd, {
			runId: "task-005-legacy-top-level-coder",
			planId: plan.planId,
			agent: "coder",
			status: "completed",
			completion: "explicit",
			hasSidecar: true,
			withCoderEvidence: true,
			sidecarFormat: "legacy-top-level",
			note: "Legacy top-level coderEvidence, no evidence envelope",
		});
		return evaluateSprintTaskFinalizationFromDisk({
			cwd,
			taskId: "TASK-005-12",
			requestedStatus: "done",
			mode: "strict",
		});
	});
	check(legacyTopLevelOnly.ok === false, "runtime: legacy top-level coderEvidence-only sidecar must NOT satisfy strict finalization");
	check(legacyTopLevelOnly.blockers.some((reason) => reason.toLowerCase().includes("coder") || reason.toLowerCase().includes("evidence")),
		"runtime: legacy top-level sidecar is rejected with coder/evidence blocker");
	// The adapter falls back to an empty coder evidence packet for
	// legacy-only sidecars, so `present` is true but `ok` is false
	// and the gate has no runnable coverage rows to satisfy the
	// matrix. The strict decision must still block and the coder
	// section must report it as not ok.
	check(legacyTopLevelOnly.details?.coder.ok === false,
		"runtime: legacy top-level sidecar yields non-ok coder section in gate details");
	check((legacyTopLevelOnly.details?.coder.evidenceRows ?? 0) === 0,
		"runtime: legacy top-level sidecar yields zero runnable coverage rows");

	const retryWarnings = withTempWorkspace("task-005-adapter-retry", (cwd) => {
		const now = new Date();
		const base = {
			phases: {
				phaseA: { status: "not_started" as const, updatedAt: now.toISOString(), evidence: [] },
				phaseB: { status: "review_approved" as const, updatedAt: now.toISOString(), evidence: [] },
			},
		};
		const plan = makePlan({
			planId: "task-005-retry",
			taskId: "TASK-005-11",
			phases: base.phases,
		});
		writePlanFixture(cwd, plan.planId, "TASK-005-11", { phases: base.phases, taskId: "TASK-005-11" });
		writeReviewerMemoFixture(cwd, plan.planId, "phaseB", "APPROVED");
		writeDelegateManifest(cwd, {
			runId: "task-005-retry-coder-failed",
			planId: plan.planId,
			agent: "coder",
			status: "failed",
			completion: "process_exit",
			at: new Date(now.getTime() + 1000).toISOString(),
			hasSidecar: false,
			withCoderEvidence: true,
		});
		writeDelegateManifest(cwd, {
			runId: "task-005-retry-reviewer",
			planId: plan.planId,
			agent: "reviewer",
			status: "completed",
			completion: "auto_exit",
			at: new Date(now.getTime() + 2000).toISOString(),
			hasSidecar: false,
			withCoderEvidence: false,
		});
		writeDelegateManifest(cwd, {
			runId: "task-005-retry-coder-final",
			planId: plan.planId,
			agent: "coder",
			status: "completed",
			completion: "explicit",
			at: new Date(now.getTime() + 3000).toISOString(),
			hasSidecar: true,
			withCoderEvidence: true,
			note: "Completed with final evidence",
		});
		return {
			noDisclosure: evaluateSprintTaskFinalizationFromDisk({
				cwd,
				taskId: "TASK-005-11",
				requestedStatus: "done",
				mode: "strict",
			}),
			withDisclosure: evaluateSprintTaskFinalizationFromDisk({
				cwd,
				taskId: "TASK-005-11",
				requestedStatus: "done",
				mode: "strict",
				finalNote: "A failed attempt with process-exit occurred, then an auto-exit event, and one delegate run missing a sidecar; 2 retries total before final explicit completion.",
			}),
		};
	});
	check(retryWarnings.noDisclosure.ok === false, "runtime: adapter blocks when retry history is absent from final note");
	check(retryWarnings.noDisclosure.blockers.some((reason) => reason.toLowerCase().includes("disclosure") || reason.toLowerCase().includes("retry")),
		"runtime: adapter retry blocker appears without disclosure");
	check(retryWarnings.withDisclosure.ok === true, "runtime: adapter allows when final note discloses retries and sidecar/mode history");

	if (failures > 0) {
		console.error(`task-005 finalization runtime smokes failed: ${failures}`);
		process.exitCode = 1;
		return;
	}
	console.log("task-005 finalization runtime smokes passed");
}

main();
