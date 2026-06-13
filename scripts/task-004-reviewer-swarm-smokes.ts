#!/usr/bin/env node
// TASK-004 Phase B — reviewer swarm / memo / tool-result integration smoke.
// All assertions are source-string + synthetic, no real delegate launches or
// panes. The integration wiring must:
//   - use deriveReviewerRoleTargets / buildReviewerRoleTask / buildReviewerMemoForResults
//     from `extensions/workflow/delegate/reviewer-roles.ts`;
//   - pass `{ goals: goals ?? undefined }` into buildReviewerMemoForResults so
//     the caller's explicit goals stay supplemental through the memo;
//   - forward `{ plan: architecture.plan, phase: architectureRequirement.phase }`
//     to runReviewerSwarm in delegate_to_reviewer;
//   - surface `reviewerMemoPath` and `reviewerMemo` in the delegate_to_reviewer
//     tool result via buildReviewerToolResult;
//   - write the durable memo under `.pi/workflow-runs/reviewer-memos/` with a
//     sanitized deterministic filename and use `REVIEWER_MEMO_DIRNAME`;
//   - drop the forbidden "code-only" framing from `buildReviewerGoalTask`;
//   - mention role-based behavior/evidence/implementation/maintainability/
//     regression/docs-config review in `DEFAULT_REVIEWER_SWARM_TARGETS`,
//     README, docs, and the quality-gates example;
//   - matrix-gated reviews still call runReviewerSwarm (role mode) even
//     when reviewerSwarm.enabled is false (Phase B fix #1);
//   - memo write failure (role mode + memo present + memoPath undefined)
//     blocks approval via both runReviewerSwarm.failed and
//     buildReviewerToolResult.isError (Phase B fix #2);
//   - the example agent catalog and the managed bootstrap reference the
//     new role gate ids and not the old review-goal-* ids (Phase B fix
//     #3 + #4);
//   - docs/workflow-config-v2.md describes the role-based / six-goal
//     reviewer swarm and not the legacy "four-goal" framing (Phase B
//     fix #5).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildReviewerGoalTask } from "../extensions/workflow/delegate/swarm";
import {
	REVIEWER_MEMO_DIRNAME,
	REVIEWER_MEMO_FILE_EXT,
	buildReviewerMemoPath,
	buildReviewerToolResult,
	readReviewerMemoFile,
	sanitizeMemoFileSegment,
	writeReviewerMemoFile,
} from "../extensions/workflow/delegate/reviewer-memo-file";
import {
	buildReviewerMemoForResults,
	buildReviewerRoleTask,
	deriveReviewerRoleTargets,
	evaluateReviewerResult,
} from "../extensions/workflow/delegate/reviewer-roles";
import { DEFAULT_REVIEWER_SWARM_TARGETS } from "../extensions/workflow/prompts";
import { buildReviewerResultLikeForRoleEvaluation } from "../extensions/workflow/delegate/swarm";
import type { ReviewerTargetResult } from "../extensions/workflow/types";
import type {
	AcceptanceEvidenceMatrixEntry,
	WorkflowArchitecturePlan,
} from "../extensions/workflow/architecture/types";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

const REPO_ROOT = path.resolve(__dirname, "..");
const SWARM_PATH = path.join(REPO_ROOT, "extensions/workflow/delegate/swarm.ts");
const TOOLS_PATH = path.join(REPO_ROOT, "extensions/workflow/delegate/tools.ts");
const MEMO_FILE_PATH = path.join(REPO_ROOT, "extensions/workflow/delegate/reviewer-memo-file.ts");
const PROMPTS_PATH = path.join(REPO_ROOT, "extensions/workflow/prompts.ts");
const EXAMPLES_QG_PATH = path.join(REPO_ROOT, "examples/workflow.quality-gates.json");
const EXAMPLES_AGENT_CATALOG_PATH = path.join(REPO_ROOT, "examples/workflow.agent-catalog.json");
const BOOTSTRAP_PATH = path.join(REPO_ROOT, "extensions/workflow/runtime/bootstrap.ts");
const README_PATH = path.join(REPO_ROOT, "README.md");
const DOCS_PATH = path.join(REPO_ROOT, "docs/workflow-config-v2.md");

function readText(file: string): string {
	return fs.readFileSync(file, "utf8");
}

function makeMatrixEntry(overrides: Partial<AcceptanceEvidenceMatrixEntry>): AcceptanceEvidenceMatrixEntry {
	return {
		criterion: "criterion",
		criterionKind: "runtime-behavior",
		businessRiskIfWrong: "service unavailable",
		enforcementLevel: ["behavior-test"],
		requiredEvidence: [{ kind: "behavior-test", description: "covered by behavior test" }],
		reviewerRoles: ["behavior"],
		blockingConditions: ["behavior test fails"],
		...overrides,
	};
}

function makeMatrixPlan(): WorkflowArchitecturePlan {
	return {
		planId: "task-004-reviewer-swarm-integration",
		taskId: "TASK-004",
		title: "Redesign reviewer swarm into role-based quality review",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "ready",
		businessPlan: "b",
		technicalPlan: "t",
		parallelAssessment: "serial",
		contractBlockPlan: "c",
		acceptanceCriteria: ["role-based reviewer swarm exists"],
		acceptanceEvidenceMatrix: [
			makeMatrixEntry({ criterion: "Behavior reviewer criterion", reviewerRoles: ["behavior"] }),
			makeMatrixEntry({ criterion: "Evidence/test reviewer criterion", reviewerRoles: ["evidence-test"] }),
			makeMatrixEntry({ criterion: "Implementation reviewer criterion", reviewerRoles: ["implementation"] }),
			makeMatrixEntry({ criterion: "Maintainability reviewer criterion", reviewerRoles: ["maintainability"] }),
			makeMatrixEntry({ criterion: "Regression reviewer criterion", reviewerRoles: ["regression"] }),
		],
		files: ["extensions/workflow/delegate/swarm.ts"],
		phases: {
			phaseA: { status: "review_approved", updatedAt: new Date().toISOString(), evidence: [] },
			phaseB: { status: "not_started", updatedAt: new Date().toISOString(), evidence: [] },
		},
	};
}

function makeSyntheticSwarm(input: {
	supplementalGoals?: string[];
	derivedGoals?: string[];
	memoPath?: string;
	approved?: boolean;
}): Parameters<typeof buildReviewerToolResult>[0]["swarm"] {
	const supplementalGoals = input.supplementalGoals ?? [];
	const derivedGoals = input.derivedGoals ?? [];
	return {
		results: [
			{
				target: "behavior reviewer",
				verdict: "APPROVED",
				status: "completed",
				role: "behavior",
				required: true,
				effectiveVerdict: "APPROVED",
				provisional: false,
				blockingReasons: [],
				weakEvidence: [],
				promptOnlyCaveats: [],
				unresolvedRisks: [],
			},
		] as ReviewerTargetResult[],
		failed: false,
		aborted: false,
		roleMode: true,
		evaluations: [],
		memo: {
			planId: "plan-id",
			phase: "phaseA",
			approved: input.approved ?? true,
			finalRecommendation: "All required roles approved.",
			approvals: [],
			changesRequested: [],
			weakEvidence: [],
			promptOnlyCaveats: [],
			unresolvedRisks: [],
			provisionalCaveats: [],
			unknownOrFailed: [],
			markdown: "# memo\n",
			supplementalGoals,
			docsConfigInScope: false,
			rolesRequired: ["behavior"],
			missingRequiredRoles: [],
		},
		memoPath: input.memoPath,
		rolesRequired: ["behavior"],
		supplementalGoals,
		docsConfigInScope: false,
		derivedGoals,
	};
}

function main(): void {
	const swarmText = readText(SWARM_PATH);
	const toolsText = readText(TOOLS_PATH);
	const memoFileText = readText(MEMO_FILE_PATH);
	const promptsText = readText(PROMPTS_PATH);
	const examplesText = readText(EXAMPLES_QG_PATH);
	const readmeText = readText(README_PATH);
	const docsText = readText(DOCS_PATH);

	// (1) swarm.ts imports + uses the role helpers and forwards `{ goals }`
	//     into the memo builder so supplemental goals survive consolidation.
	{
		check(/from\s+["']\.\/reviewer-roles["']/.test(swarmText),
			"1: swarm.ts imports from ./reviewer-roles");
		const importBlock = swarmText.match(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/reviewer-roles["']/);
		const imported = importBlock?.[0] ?? "";
		check(/buildReviewerMemoForResults/.test(imported),
			"1: swarm.ts imports buildReviewerMemoForResults");
		check(/deriveReviewerRoleTargets/.test(imported),
			"1: swarm.ts imports deriveReviewerRoleTargets");
		check(/buildReviewerRoleTask/.test(imported),
			"1: swarm.ts imports buildReviewerRoleTask");
		// writeReviewerMemoFile is imported from reviewer-memo-file.ts; the
		// helper writes the durable memo at the path exported by
		// buildReviewerMemoPath.
		check(/from\s+["']\.\/reviewer-memo-file["']/.test(swarmText),
			"1: swarm.ts imports from ./reviewer-memo-file");
		const memoImport = swarmText.match(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/reviewer-memo-file["']/);
		check(/writeReviewerMemoFile/.test(memoImport?.[0] ?? ""),
			"1: swarm.ts imports writeReviewerMemoFile");
		// buildReviewerMemoForResults must be called with `{ goals: goals ?? undefined }`
		// to preserve supplemental goals through the memo.
		const callMatch = swarmText.match(/buildReviewerMemoForResults\([\s\S]*?\}\s*\)/);
		check(Boolean(callMatch),
			"1: buildReviewerMemoForResults call found in swarm.ts");
		const call = callMatch?.[0] ?? "";
		check(/goals\s*:\s*goals\s*\?\?\s*undefined/.test(call),
			`1: buildReviewerMemoForResults call passes { goals: goals ?? undefined } (got: ${call.slice(0, 80)}...)`);
		// The role-mode call also writes the durable memo via writeReviewerMemoFile.
		check(/writeReviewerMemoFile\(/.test(swarmText),
			"1: swarm.ts calls writeReviewerMemoFile to persist the memo");
	}

	// (2) tools.ts forwards architecture plan + phase into runReviewerSwarm
	//     and surfaces `reviewerMemoPath` + `reviewerMemo` via
	//     buildReviewerToolResult.
	{
		// The reviewer tool call must use architecture.plan and
		// architectureRequirement.phase as the `plan` / `phase` keys of the
		// review context.
		const swarmCall = toolsText.match(/runReviewerSwarm\([\s\S]*?\)\s*;/);
		check(Boolean(swarmCall),
			"2: runReviewerSwarm call found in tools.ts");
		const call = swarmCall?.[0] ?? "";
		check(/plan\s*:\s*architecture\.plan/.test(call),
			"2: runReviewerSwarm receives { plan: architecture.plan }");
		check(/phase\s*:\s*architectureRequirement\.phase/.test(call),
			"2: runReviewerSwarm receives { phase: architectureRequirement.phase }");
		// buildReviewerToolResult call must include `swarm` so the helper can
		// emit reviewerMemoPath / reviewerMemo in the details.
		const toolResultCall = toolsText.match(/buildReviewerToolResult\([\s\S]*?\}\s*\)/);
		check(Boolean(toolResultCall),
			"2: buildReviewerToolResult call found in tools.ts");
		const resultCall = toolResultCall?.[0] ?? "";
		check(/swarm\s*[,}]/.test(resultCall) || /swarm\s*:/ .test(resultCall),
			"2: buildReviewerToolResult receives the `swarm` result");
		check(/planId\s*:/.test(resultCall) && /phase\s*:/.test(resultCall),
			"2: buildReviewerToolResult receives planId + phase");
		// Structural verification of the helper's output shape.
		const toolResult = buildReviewerToolResult({
			delegatedTask: "task",
			requestedCwd: undefined,
			baseCwd: "/tmp",
			planId: "plan-id",
			phase: "phaseA",
			swarm: makeSyntheticSwarm({
				supplementalGoals: ["extra goal"],
				derivedGoals: ["behavior reviewer"],
				memoPath: "/tmp/synthetic-memo.md",
			}),
			reviewerUpdate: undefined,
		});
		const details = toolResult.details as Record<string, unknown>;
		check(details.reviewerMemoPath === "/tmp/synthetic-memo.md",
			`2: tool details surfaces reviewerMemoPath (got: ${String(details.reviewerMemoPath)})`);
		check(typeof details.reviewerMemo === "object" && details.reviewerMemo !== null,
			"2: tool details surfaces reviewerMemo (object)");
		const memoSummary = details.reviewerMemo as Record<string, unknown>;
		check(memoSummary.approved === true,
			"2: tool details.reviewerMemo.approved matches the memo");
		check(Array.isArray(memoSummary.supplementalGoals) && (memoSummary.supplementalGoals as string[]).includes("extra goal"),
			"2: tool details.reviewerMemo surfaces supplementalGoals");
		check(toolResult.isError === false,
			"2: tool result isError=false when all required roles are approved");
		const contentText = (toolResult.content[0] as { type: "text"; text: string }).text;
		check(contentText.includes("Reviewer memo written to: /tmp/synthetic-memo.md"),
			"2: tool content surfaces the durable memo path");
		check(contentText.includes("Memo decision: approved"),
			"2: tool content surfaces the memo decision");
	}

	// (3) reviewer-memo-file.ts writes under the `reviewer-memos` dir and
	//     `buildReviewerMemoPath` produces deterministic sanitized names.
	{
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-004-reviewer-memo-"));
		try {
			const planId = "task-004/phase:review *bad?";
			const phase = "phase A";
			const built = buildReviewerMemoPath(tmpDir, planId, phase);
			check(built.dir.endsWith(path.join(".pi", "workflow-runs", REVIEWER_MEMO_DIRNAME)),
				`3: buildReviewerMemoPath places the file under the reviewer-memos dir (got: ${built.dir})`);
			check(built.file.endsWith(`${REVIEWER_MEMO_FILE_EXT}`),
				`3: buildReviewerMemoPath file has the .md extension (got: ${built.file})`);
			// No forbidden characters should leak into the path.
			check(!/[\\:*?"<>|]/.test(path.basename(built.file).slice(0, -REVIEWER_MEMO_FILE_EXT.length)),
				`3: sanitized filename has no forbidden path chars (got: ${path.basename(built.file)})`);
			// No whitespace inside the sanitized segment.
			check(!/\s/.test(path.basename(built.file)),
				`3: sanitized filename has no whitespace (got: ${path.basename(built.file)})`);
			// Same inputs produce the same path on repeated calls (deterministic).
			const builtAgain = buildReviewerMemoPath(tmpDir, planId, phase);
			check(builtAgain.file === built.file,
				`3: buildReviewerMemoPath is deterministic (got: ${built.file} vs ${builtAgain.file})`);
			// writeReviewerMemoFile must actually create the file at the path.
			const memoPath = writeReviewerMemoFile(tmpDir, planId, phase, "# reviewer memo\nbody\n");
			check(typeof memoPath === "string" && memoPath === built.file,
				`3: writeReviewerMemoFile returns the resolved path (got: ${String(memoPath)})`);
			check(fs.existsSync(built.file),
				"3: writeReviewerMemoFile creates the file on disk");
			const round = readReviewerMemoFile(built.file);
			check(typeof round === "string" && round.includes("reviewer memo"),
				"3: readReviewerMemoFile round-trips the memo body");
			// sanitizeMemoFileSegment: empty input falls back to the placeholder.
			check(sanitizeMemoFileSegment("", "plan") === "plan",
				"3: sanitizeMemoFileSegment falls back on empty input");
			check(sanitizeMemoFileSegment(undefined, "plan") === "plan",
				"3: sanitizeMemoFileSegment falls back on undefined input");
			check(sanitizeMemoFileSegment("a/b c:d", "plan") === "a-b-c-d",
				`3: sanitizeMemoFileSegment replaces forbidden chars (got: ${sanitizeMemoFileSegment("a/b c:d", "plan")})`);
			// Internal const export: REVIEWER_MEMO_DIRNAME matches the literal
			// used in buildReviewerMemoPath.
			check(memoFileText.includes(REVIEWER_MEMO_DIRNAME),
				"3: reviewer-memo-file.ts module exports and uses REVIEWER_MEMO_DIRNAME");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	// (4) buildReviewerGoalTask no longer contains the forbidden `code-only`
	//     framing. The role-aware builder (`buildReviewerRoleTask`) is the
	//     primary path; the legacy builder is kept for non-matrix callers.
	{
		const out = buildReviewerGoalTask("base task", "some goal");
		check(!out.includes("code-only"),
			"4: buildReviewerGoalTask prompt does not contain 'code-only'");
		check(out.includes("APPROVED") && out.includes("CHANGES_REQUESTED"),
			"4: buildReviewerGoalTask prompt still requires APPROVED/CHANGES_REQUESTED prefix");
		check(out.includes("some goal"),
			"4: buildReviewerGoalTask prompt embeds the assigned goal");
		// The role-aware prompt builder also must not include 'code-only'.
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		check(Boolean(behaviorTarget), "4: behavior target derived for matrix-gated plan");
		const rolePrompt = buildReviewerRoleTask("base task", behaviorTarget!);
		check(!rolePrompt.includes("code-only"),
			"4: buildReviewerRoleTask prompt does not contain 'code-only'");
	}

	// (5) DEFAULT_REVIEWER_SWARM_TARGETS, README, docs, and the quality-gates
	//     example mention role-based behavior/evidence/implementation/
	//     maintainability/regression/docs-config review.
	{
		const targetsText = DEFAULT_REVIEWER_SWARM_TARGETS.join("\n").toLowerCase();
		check(/behavior/.test(targetsText),
			"5: DEFAULT_REVIEWER_SWARM_TARGETS mentions 'behavior'");
		check(/evidence/.test(targetsText),
			"5: DEFAULT_REVIEWER_SWARM_TARGETS mentions 'evidence'");
		check(/implementation/.test(targetsText),
			"5: DEFAULT_REVIEWER_SWARM_TARGETS mentions 'implementation'");
		check(/maintainability/.test(targetsText),
			"5: DEFAULT_REVIEWER_SWARM_TARGETS mentions 'maintainability'");
		check(/regression/.test(targetsText),
			"5: DEFAULT_REVIEWER_SWARM_TARGETS mentions 'regression'");
		check(/docs-config|docs\/config|docs \/ config|configuration|documentation/.test(targetsText),
			"5: DEFAULT_REVIEWER_SWARM_TARGETS mentions docs/config");
		// README "Role-based reviewer swarm" section.
		check(/Role-based reviewer swarm/.test(readmeText),
			"5: README has a 'Role-based reviewer swarm' section");
		check(/acceptanceEvidenceMatrix/.test(readmeText),
			"5: README mentions acceptanceEvidenceMatrix for role mode");
		check(/supplemental/.test(readmeText),
			"5: README mentions supplemental goals");
		check(/reviewer-memos/.test(readmeText),
			"5: README mentions the reviewer-memos dir");
		check(/legacy\/no-matrix/.test(readmeText),
			"5: README documents reviewerSwarm.enabled caveat for legacy/no-matrix plans");
		check(/matrix-gated .*ready/.test(readmeText),
			"5: README documents matrix-gated ready plans keep role-based review");
		// Quality-gates example: each review-goal role id is present.
		check(/"review-goal-behavior"/.test(examplesText),
			"5: examples/workflow.quality-gates.json has review-goal-behavior");
		check(/"review-goal-evidence-test"/.test(examplesText),
			"5: examples/workflow.quality-gates.json has review-goal-evidence-test");
		check(/"review-goal-implementation"/.test(examplesText),
			"5: examples/workflow.quality-gates.json has review-goal-implementation");
		check(/"review-goal-maintainability"/.test(examplesText),
			"5: examples/workflow.quality-gates.json has review-goal-maintainability");
		check(/"review-goal-regression"/.test(examplesText),
			"5: examples/workflow.quality-gates.json has review-goal-regression");
		check(/"review-goal-docs-config"/.test(examplesText),
			"5: examples/workflow.quality-gates.json has review-goal-docs-config");
		// Default target string literal is exported with the role names.
		check(/Behavior reviewer/.test(promptsText),
			"5: prompts.ts DEFAULT_REVIEWER_SWARM_TARGETS exports 'Behavior reviewer'");
		check(/Evidence\/test-adequacy reviewer/.test(promptsText),
			"5: prompts.ts DEFAULT_REVIEWER_SWARM_TARGETS exports 'Evidence/test-adequacy reviewer'");
		check(/Implementation reviewer/.test(promptsText),
			"5: prompts.ts DEFAULT_REVIEWER_SWARM_TARGETS exports 'Implementation reviewer'");
		check(/Maintainability/.test(promptsText),
			"5: prompts.ts DEFAULT_REVIEWER_SWARM_TARGETS exports 'Maintainability/architecture reviewer'");
		check(/Regression reviewer/.test(promptsText),
			"5: prompts.ts DEFAULT_REVIEWER_SWARM_TARGETS exports 'Regression reviewer'");
		check(/Docs\/config reviewer/.test(promptsText),
			"5: prompts.ts DEFAULT_REVIEWER_SWARM_TARGETS exports 'Docs/config reviewer'");
		// docs/workflow-config-v2.md mentions the role-based reviewer swarm.
		check(/role-based reviewer swarm|matrix-derived reviewer swarm|role-based quality review|role[- ]based reviewer/i.test(docsText),
			"5: docs/workflow-config-v2.md mentions the role-based reviewer swarm");
		check(/compatibility switch only for legacy\/no-matrix plans/.test(docsText),
			"5: docs/workflow-config-v2.md states reviewerSwarm.enabled is legacy/no-matrix-only in compatibility overlay");
		check(/acceptanceEvidenceMatrix/.test(docsText) && /role-based reviewer coverage remains required/.test(docsText),
			"5: docs/workflow-config-v2.md caveat states matrix-gated ready plans still require role-based coverage");
		// Phase B fix #5: docs no longer say "four-goal reviewer swarm".
		check(!/four-goal reviewer swarm/i.test(docsText),
			"5: docs/workflow-config-v2.md does not say 'four-goal reviewer swarm'");
		check(/six-goal reviewer swarm|role-based six-goal/i.test(docsText),
			"5: docs/workflow-config-v2.md describes the role-based / six-goal reviewer swarm");
	}

	// (6) Synthetic helper assertion: explicit goals remain supplemental in
	//     role mode through both `deriveReviewerRoleTargets` and
	//     `buildReviewerMemoForResults`.
	{
		const plan = makeMatrixPlan();
		const explicitGoals = [
			"focus on the extensions/workflow/delegate/reviewer-roles.ts diff",
			"verify the docs mention the role-based reviewer swarm",
		];
		const derivation = deriveReviewerRoleTargets(plan, { goals: explicitGoals });
		check(derivation.supplementalGoals.length === explicitGoals.length,
			`6: derivation preserves all explicit goals as supplemental (got: ${derivation.supplementalGoals.length}, expected ${explicitGoals.length})`);
		for (const goal of explicitGoals) {
			check(derivation.supplementalGoals.includes(goal),
				`6: supplementalGoals carries '${goal}'`);
		}
		// Required roles are matrix-derived and not replaced by goals.
		const requiredRoles = new Set(derivation.rolesRequired);
		check(requiredRoles.has("behavior") && requiredRoles.has("evidence-test")
			&& requiredRoles.has("implementation") && requiredRoles.has("maintainability")
			&& requiredRoles.has("regression"),
			"6: required roles include the matrix-derived non-trivial set");
		// Each target's `supplementalGoals` mirrors the caller's list.
		for (const target of derivation.targets) {
			check(target.supplementalGoals.length === explicitGoals.length,
				`6: per-target ${target.role} carries all supplemental goals (got: ${target.supplementalGoals.length})`);
		}
		// buildReviewerMemoForResults preserves the supplemental goals on the
		// consolidated memo and embeds them into the markdown body.
		const results = derivation.targets.map(() => ({
			verdict: "APPROVED" as const,
			finalOutput: "APPROVED. Diff matches the spec; criterion satisfied.",
			completionSource: "explicit" as const,
			status: "completed" as const,
			reviewerEvidence: {
				present: true,
				explicitDeclaration: true,
				criterionCoverage: [{ criterion: "criterion", evidenceKind: "diff", summary: "diff review" }],
			},
		}));
		const { memo } = buildReviewerMemoForResults(plan, "phaseA", results, { goals: explicitGoals });
		check(memo.supplementalGoals.length === explicitGoals.length,
			`6: memo.supplementalGoals preserves the caller's goals (got: ${memo.supplementalGoals.length})`);
		for (const goal of explicitGoals) {
			check(memo.markdown.includes(goal),
				`6: memo markdown embeds supplemental goal '${goal}'`);
		}
		check(memo.markdown.includes("supplemental goals:"),
			"6: memo markdown labels the supplemental-goals section");
		check(memo.approved === true,
			"6: synthetic explicit-goal pass results in approved memo");
	}

	// (7) Tool-output `details` carries supplemental goals through the
	//     delegate_to_reviewer path (defense in depth against the
	//     `swarm.ts` change that already passes `{ goals }` to
	//     `buildReviewerMemoForResults`).
	{
		const toolResult = buildReviewerToolResult({
			delegatedTask: "task",
			requestedCwd: undefined,
			baseCwd: "/tmp",
			planId: "plan-id",
			phase: "phaseA",
			swarm: makeSyntheticSwarm({
				supplementalGoals: ["goal-1", "goal-2"],
				derivedGoals: ["goal-1", "goal-2"],
				memoPath: "/tmp/synthetic-memo.md",
			}),
			reviewerUpdate: undefined,
		});
		const details = toolResult.details as Record<string, unknown>;
		check(Array.isArray(details.supplementalGoals)
			&& (details.supplementalGoals as string[]).join("|") === "goal-1|goal-2",
			`7: tool details.supplementalGoals preserves caller goals (got: ${JSON.stringify(details.supplementalGoals)})`);
		check(Array.isArray(details.derivedGoals)
			&& (details.derivedGoals as string[]).length === 2,
			"7: tool details.derivedGoals surfaces the derived goal list");
		check(details.roleMode === true,
			"7: tool details.roleMode === true in role mode");
		check(details.reviewerMemoPath === "/tmp/synthetic-memo.md",
			"7: tool details.reviewerMemoPath surfaces the durable memo path");
	}

	// (8) Phase B fix #1: matrix-gated reviews must run through role mode
	//     even when `reviewerSwarm.enabled === false`. Source-string guard
	//     on `tools.ts` (the `isMatrixGatedPlan` import + the negated
	//     `!swarmConfig.enabled && !isMatrixGatedPlan(architecture.plan)`
	//     branch). The reviewer-required change is structural and lives
	//     in source, so a regex check on `tools.ts` is the right level of
	//     assertion here.
	{
		// The disabled-swarm fallback branch in tools.ts must be guarded
		// by `!isMatrixGatedPlan(architecture.plan)` so role mode still
		// runs for matrix-gated plans.
		const disabledBranch = /!swarmConfig\.enabled[\s\S]{0,80}isMatrixGatedPlan\(architecture\.plan\)[\s\S]{0,80}?\{/m;
		check(disabledBranch.test(toolsText),
			"8: tools.ts disabled-swarm branch is guarded by isMatrixGatedPlan(architecture.plan)");
		// isMatrixGatedPlan must be imported from ./swarm in tools.ts.
		check(/import\s*\{[\s\S]*?isMatrixGatedPlan[\s\S]*?\}\s*from\s*["']\.\/swarm["']/.test(toolsText),
			"8: tools.ts imports isMatrixGatedPlan from ./swarm");
	}

	// (9) Phase B fix #2: a role-mode swarm run that produced a memo but
	//     did NOT durably write it must surface as a failure both in
	//     `runReviewerSwarm` (via `failed: true`) and in
	//     `buildReviewerToolResult` (via `isError: true` /
	//     `status: "failed"` / `exitCode: 1`).
	{
		// 9a: runReviewerSwarm source guard: the role-mode `failed`
		//     computation must include the `memo && memoPath === undefined`
		//     check.
		check(/if\s*\(\s*memo\s*&&\s*memoPath\s*===\s*undefined\s*\)\s*failed\s*=\s*true/.test(swarmText),
			"9a: swarm.ts role-mode failed computation includes memo && memoPath === undefined guard");
		// 9b: buildReviewerToolResult structural check: the helper must
		//     derive `memoWriteFailed = Boolean(memo) && memoPath === undefined`
		//     and fold it into status / exitCode / isError.
		check(/memoWriteFailed\s*=\s*Boolean\(memo\)\s*&&\s*memoPath\s*===\s*undefined/.test(memoFileText),
			"9b: reviewer-memo-file.ts computes memoWriteFailed from memo + memoPath");
		check(/isError:\s*effectiveStatus\s*!==\s*"completed"/.test(memoFileText),
			"9b: reviewer-memo-file.ts isError uses effectiveStatus so memoWriteFailed surfaces as failure");
		check(/exitCode:\s*swarm\.failed\s*\|\|\s*memoWriteFailed/.test(memoFileText),
			"9b: reviewer-memo-file.ts exitCode folds memoWriteFailed");
		// 9c: behavioral assertion. Build the synthetic tool result with
		//     role mode + memo + memoPath undefined + failed=false. The
		//     helper must NOT present this as a completed approval.
		const broken = buildReviewerToolResult({
			delegatedTask: "task",
			requestedCwd: undefined,
			baseCwd: "/tmp",
			planId: "plan-id",
			phase: "phaseA",
			swarm: makeSyntheticSwarm({
				supplementalGoals: ["g1"],
				derivedGoals: ["g1"],
				memoPath: undefined,
				approved: true,
			}),
			reviewerUpdate: undefined,
		});
		// Force failed=false by rebuilding the swarm with the canonical
		// helper so the memo-missing case is synthetic but realistic.
		const swarm: Parameters<typeof buildReviewerToolResult>[0]["swarm"] = {
			results: makeSyntheticSwarm({ memoPath: undefined }).results,
			failed: false,
			aborted: false,
			roleMode: true,
			evaluations: [],
			memo: makeSyntheticSwarm({ memoPath: undefined }).memo,
			memoPath: undefined,
			rolesRequired: ["behavior"],
			supplementalGoals: ["g1"],
			docsConfigInScope: false,
			derivedGoals: ["g1"],
		};
		const out = buildReviewerToolResult({
			delegatedTask: "task",
			requestedCwd: undefined,
			baseCwd: "/tmp",
			planId: "plan-id",
			phase: "phaseA",
			swarm,
			reviewerUpdate: undefined,
		});
		const details = out.details as Record<string, unknown>;
		check(out.isError === true,
			`9c: buildReviewerToolResult isError=true when role mode has memo but memoPath is undefined (got: ${out.isError})`);
		check(details.status === "failed",
			`9c: tool details.status reflects memo-write failure (got: ${String(details.status)})`);
		check(details.exitCode === 1,
			`9c: tool details.exitCode is 1 on memo-write failure (got: ${String(details.exitCode)})`);
		check(!out.content[0] || !String((out.content[0] as { text: string }).text).includes("Memo decision: approved"),
			"9c: tool content does NOT present 'Memo decision: approved' on memo-write failure");
		// Confirm the broken builder also flipped status.
		const brokenDetails = broken.details as Record<string, unknown>;
		check(brokenDetails.status === "failed",
			`9c: default makeSyntheticSwarm(memoPath=undefined) builder also flips status (got: ${String(brokenDetails.status)})`);
	}

	// (10) Phase B fix #3: example agent catalog's reviewer qualityGates
	//      must all exist in the quality-gates catalog. Cross-check the
	//      JSON files.
	{
		const agentCatalog = JSON.parse(readText(EXAMPLES_AGENT_CATALOG_PATH)) as { agents: Array<{ id: string; role: string; qualityGates?: string[] }> };
		const qualityGates = JSON.parse(readText(EXAMPLES_QG_PATH)) as { gates: Array<{ id: string; kind?: string }> };
		const gateIds = new Set(qualityGates.gates.map((g) => g.id));
		const reviewer = agentCatalog.agents.find((a) => a.role === "reviewer");
		check(Boolean(reviewer), "10: example agent catalog has a reviewer entry");
		const reviewerGates = reviewer?.qualityGates ?? [];
		check(reviewerGates.length > 0,
			"10: example reviewer qualityGates is non-empty");
		for (const id of reviewerGates) {
			check(gateIds.has(id),
				`10: example reviewer qualityGate '${id}' exists in workflow.quality-gates.json`);
		}
		// Required role ids must be present on the reviewer.
		for (const roleId of ["review-goal-behavior", "review-goal-evidence-test", "review-goal-implementation", "review-goal-maintainability", "review-goal-regression", "review-goal-docs-config"]) {
			check(reviewerGates.includes(roleId),
				`10: example reviewer qualityGates includes '${roleId}'`);
		}
		// Old review-goal-* ids must be gone.
		for (const oldId of ["review-goal-architecture", "review-goal-correctness", "review-goal-tests", "review-goal-security"]) {
			check(!reviewerGates.includes(oldId),
				`10: example reviewer qualityGates no longer includes legacy '${oldId}'`);
		}
	}

	// (11) Phase B fix #4: managed bootstrap must reference the new role
	//      gate ids and NOT the old review-goal-* ids. Source-string
	//      check on `extensions/workflow/runtime/bootstrap.ts`.
	{
		const bootstrapText = readText(BOOTSTRAP_PATH);
		// managedAgentCatalog reviewer qualityGates must include the new
		// role ids.
		for (const roleId of ["review-goal-behavior", "review-goal-evidence-test", "review-goal-implementation", "review-goal-maintainability", "review-goal-regression", "review-goal-docs-config"]) {
			check(new RegExp(`["']${roleId}["']`).test(bootstrapText),
				`11: bootstrap.ts managedAgentCatalog references new role id '${roleId}'`);
		}
		// managedQualityGates must declare the same new role ids.
		for (const roleId of ["review-goal-behavior", "review-goal-evidence-test", "review-goal-implementation", "review-goal-maintainability", "review-goal-regression", "review-goal-docs-config"]) {
			check(new RegExp(`id:\\s*["']${roleId}["']`).test(bootstrapText),
				`11: bootstrap.ts managedQualityGates declares new role id '${roleId}'`);
		}
		// Old review-goal-* ids must not appear in the bootstrap.
		for (const oldId of ["review-goal-architecture", "review-goal-correctness", "review-goal-tests", "review-goal-security"]) {
			check(!bootstrapText.includes(oldId),
				`11: bootstrap.ts no longer references legacy reviewer gate id '${oldId}'`);
		}
	}

	// (12) DBG-007 sidecar-to-evaluator runtime shaping: the role-mode
	//      path must read pane done sidecars from `result.doneFile` and
	//      forward them as `details.done` so the role evaluator's
	//      fallback evidence paths can see `coderEvidence` /
	//      `summary` JSON stored in the actual sidecar. Cover the
	//      positive case (typed coderEvidence in sidecar suppresses
	//      auto_exit provisional and approves the memo) and the
	//      negative cases (missing / unreadable / empty sidecar
	//      fail-closed: no details.done is fabricated, the role
	//      stays provisional, and the memo is not approved).
	{
		const plan = makeMatrixPlan();
		const derivation = deriveReviewerRoleTargets(plan);
		const behaviorTarget = derivation.targets.find((t) => t.role === "behavior");
		const regressionTarget = derivation.targets.find((t) => t.role === "regression");
		check(Boolean(behaviorTarget && regressionTarget),
			"12: behavior + regression targets present for sidecar shaping test");

		// 12a: source-string guard confirming the helper exists in
		//      swarm.ts and is wired into the role-mode resultLikes
		//      mapping (so runtime sidecars are forwarded into the
		//      evaluator).
		check(/export\s+function\s+buildReviewerResultLikeForRoleEvaluation\s*\(/.test(swarmText),
			"12a: swarm.ts exports buildReviewerResultLikeForRoleEvaluation");
		check(/parseDoneSidecar\s*\(/.test(swarmText),
			"12a: swarm.ts uses parseDoneSidecar to read pane done sidecars");
		check(/from\s+["']\.\/pane-status["']/.test(swarmText),
			"12a: swarm.ts imports parseDoneSidecar from ./pane-status");
		check(/resultLikes:\s*ReviewerResultLike\[\]\s*=\s*results\.map\(\(r\)\s*=>\s*buildReviewerResultLikeForRoleEvaluation\(r\)\)/.test(swarmText),
			"12a: swarm.ts role-mode resultLikes uses buildReviewerResultLikeForRoleEvaluation(r)");

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-004-sidecar-"));
		try {
			// 12b: positive — typed coderEvidence.criterionCoverage in
			//      a real on-disk done sidecar + auto_exit completion
			//      source + no direct reviewerEvidence suppresses
			//      provisional, keeps the role approved, and the memo
			//      becomes approved.
			const doneFile = path.join(tmpDir, "done-b.json");
			fs.writeFileSync(doneFile, JSON.stringify({
				done: true,
				completion: "auto_exit",
				source: "shell_exit",
				exit_code: 0,
				from_auto_exit: true,
				coderEvidence: {
					present: true,
					explicitDeclaration: true,
					criterionCoverage: [
						{ criterion: "Behavior reviewer criterion", evidenceKind: "behavior-test", summary: "behavior test passed" },
					],
					commandsRun: [
						{ command: "npx tsx scripts/smoke-tui.ts", outcome: "exit 0", summary: "smoke passed" },
					],
				},
			}) + "\n", "utf8");
			const autoExitTarget: ReviewerTargetResult = {
				target: "behavior#1 Behavior reviewer",
				verdict: "APPROVED",
				status: "completed",
				result: {
					agent: "reviewer",
					task: "task",
					cwd: "/tmp",
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					finalOutput: "APPROVED. Looks good.",
					completionSource: "auto_exit",
					doneFile,
				},
			};
			const like = buildReviewerResultLikeForRoleEvaluation(autoExitTarget);
			check(like.completionSource === "auto_exit",
				"12b: helper preserves completionSource=auto_exit from delegate result");
			check(like.details !== undefined && (like.details as Record<string, unknown>).done !== undefined,
				"12b: helper forwards parsed sidecar as details.done when doneFile is readable");
			const sidecar = (like.details as Record<string, unknown>).done as Record<string, unknown>;
			check(sidecar.coderEvidence !== undefined,
				"12b: forwarded sidecar preserves coderEvidence");
			const sidecarCoder = sidecar.coderEvidence as Record<string, unknown>;
			check(Array.isArray(sidecarCoder.criterionCoverage) && (sidecarCoder.criterionCoverage as unknown[]).length > 0,
				"12b: forwarded sidecar preserves typed criterionCoverage");
			// Drive the helper output through the role evaluator and
			// the canonical memo builder end-to-end. Every required
			// role needs a result aligned to its target. The behavior
			// role is auto_exit + sidecar fallback evidence; the other
			// roles approve with explicit evidence so they are not
			// downgraded by the runtime-scope / static-only checks.
			const otherResults: import("../extensions/workflow/delegate/reviewer-roles").ReviewerResultLike[] = [];
			const { evaluations, memo } = buildReviewerMemoForResults(
				plan,
				"phaseA",
				[like, ...otherResults],
				{ goals: undefined },
			);
			const behaviorEval = evaluations.find((e) => e.role === "behavior");
			check(Boolean(behaviorEval), "12b: behavior evaluation present after sidecar forwarding");
			check(behaviorEval?.provisional === false,
				`12b: behavior auto_exit with sidecar coderEvidence is NOT provisional (got: ${behaviorEval?.provisional})`);
			check(behaviorEval?.effectiveVerdict === "APPROVED",
				`12b: behavior auto_exit with sidecar coderEvidence stays APPROVED (got: ${behaviorEval?.effectiveVerdict})`);
			// The memo is not fully approved yet because the
			// other-role evaluations are synthesized as UNKNOWN by
			// `buildReviewerMemoForResults` when fewer results than
			// targets are supplied. Those synthesized UNKNOWN
			// evaluations are downgraded to CHANGES_REQUESTED by
			// the role evaluator (UNKNOWN verdict + required role
			// adds a blocking reason), so they land in the
			// `changesRequested` bucket and must block final
			// approval. This is the expected fail-closed end-state
			// for this synthetic target list.
			check(memo.approved === false,
				"12b: synthetic partial result set still blocks final approval (fail-closed for UNKNOWN other roles)");
			check(memo.changesRequested.length >= 4,
				`12b: memo buckets the synthesized UNKNOWN other roles as changesRequested (got: ${memo.changesRequested.length})`);

			// 12c: full end-to-end — every required role is supplied,
			//      one is auto_exit + sidecar fallback, the rest are
			//      explicit + typed structured evidence. The memo
			//      must be approved and have no provisional caveats.
			const fullResults: import("../extensions/workflow/delegate/reviewer-roles").ReviewerResultLike[] = derivation.targets.map((t, i) => {
				if (i === 0) {
					// behavior: sidecar fallback evidence + auto_exit.
					return buildReviewerResultLikeForRoleEvaluation(autoExitTarget);
				}
				// Other roles: explicit + typed structured evidence.
				return {
					verdict: "APPROVED" as const,
					finalOutput: "APPROVED. behavior test passed: tsx scripts/smoke-tui.ts exited 0.",
					completionSource: "explicit" as const,
					status: "completed" as const,
					reviewerEvidence: {
						present: true,
						explicitDeclaration: true,
						criterionCoverage: [{ criterion: t.criteria[0] ?? "criterion", evidenceKind: "behavior-test", summary: "behavior test passed" }],
					},
				};
			});
			const full = buildReviewerMemoForResults(plan, "phaseA", fullResults, { goals: undefined });
			check(full.memo.approved === true,
				"12c: end-to-end memo approved=true when auto_exit role uses sidecar coderEvidence fallback");
			check(full.memo.provisionalCaveats.length === 0,
				`12c: end-to-end memo has no provisionalCaveats (got: ${full.memo.provisionalCaveats.length})`);

			// 12d: negative — missing doneFile => no details.done is
			//      fabricated; the role evaluator must still treat
			//      auto_exit as provisional and block.
			const noDoneFileTarget: ReviewerTargetResult = {
				target: "behavior#1 Behavior reviewer",
				verdict: "APPROVED",
				status: "completed",
				result: {
					agent: "reviewer",
					task: "task",
					cwd: "/tmp",
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					finalOutput: "APPROVED. Looks good.",
					completionSource: "auto_exit",
				},
			};
			const noDoneFileLike = buildReviewerResultLikeForRoleEvaluation(noDoneFileTarget);
			const noDoneFileDetails = noDoneFileLike.details as Record<string, unknown> | undefined;
			check(noDoneFileDetails === undefined || noDoneFileDetails.done === undefined,
				"12d: helper omits details.done when result.doneFile is absent");
			const noDoneFileEval = evaluateReviewerResult(behaviorTarget!, noDoneFileLike);
			check(noDoneFileEval.provisional === true,
				"12d: missing doneFile keeps auto_exit provisional (no fabricated sidecar)");

			// 12e: negative — unreadable doneFile (path that does
			//      not exist) => no details.done is fabricated; the
			//      role evaluator must still treat auto_exit as
			//      provisional and block.
			const unreadableTarget: ReviewerTargetResult = {
				target: "behavior#1 Behavior reviewer",
				verdict: "APPROVED",
				status: "completed",
				result: {
					agent: "reviewer",
					task: "task",
					cwd: "/tmp",
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					finalOutput: "APPROVED. Looks good.",
					completionSource: "auto_exit",
					doneFile: path.join(tmpDir, "does-not-exist-done.json"),
				},
			};
			const unreadableLike = buildReviewerResultLikeForRoleEvaluation(unreadableTarget);
			const unreadableDetails = unreadableLike.details as Record<string, unknown> | undefined;
			check(unreadableDetails === undefined || unreadableDetails.done === undefined,
				"12e: helper omits details.done when doneFile path is unreadable");
			const unreadableEval = evaluateReviewerResult(behaviorTarget!, unreadableLike);
			check(unreadableEval.provisional === true,
				"12e: unreadable doneFile keeps auto_exit provisional (no fabricated evidence)");

			// 12f: negative — empty sidecar (parseable but
			//      object-only with no reviewerEvidence /
			//      coderEvidence / summary) => details.done is
			//      forwarded but evaluator must still treat
			//      auto_exit as provisional and block.
			const emptySidecarFile = path.join(tmpDir, "done-empty.json");
			fs.writeFileSync(emptySidecarFile, JSON.stringify({ done: true, completion: "auto_exit" }) + "\n", "utf8");
			const emptySidecarTarget: ReviewerTargetResult = {
				target: "behavior#1 Behavior reviewer",
				verdict: "APPROVED",
				status: "completed",
				result: {
					agent: "reviewer",
					task: "task",
					cwd: "/tmp",
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					finalOutput: "APPROVED. Looks good.",
					completionSource: "auto_exit",
					doneFile: emptySidecarFile,
				},
			};
			const emptyLike = buildReviewerResultLikeForRoleEvaluation(emptySidecarTarget);
			const emptyDetails = emptyLike.details as Record<string, unknown>;
			check(emptyDetails && emptyDetails.done !== undefined,
				"12f: helper forwards empty-but-valid sidecar as details.done");
			const emptyEval = evaluateReviewerResult(behaviorTarget!, emptyLike);
			check(emptyEval.provisional === true,
				"12f: empty sidecar keeps auto_exit provisional (no typed evidence to suppress)");
			check(emptyEval.effectiveVerdict === "CHANGES_REQUESTED",
				"12f: empty sidecar does not approve a required role");

			// 12g: positive — typed criterionCoverage under
			//      `coderEvidence.delegateHistory.reviewerEvidence`
			//      in the on-disk sidecar (legacy reviewer's
			//      structured evidence path) also suppresses
			//      auto_exit provisional for the regression role.
			const regFile = path.join(tmpDir, "done-reg.json");
			fs.writeFileSync(regFile, JSON.stringify({
				done: true,
				completion: "auto_exit",
				source: "shell_exit",
				exit_code: 0,
				coderEvidence: {
					delegateHistory: {
						reviewerEvidence: {
							commandsRun: [{ command: "npx tsx scripts/regression-smoke.ts", outcome: "exit 0", summary: "regression test passed" }],
						},
					},
				},
			}) + "\n", "utf8");
			const regTarget: ReviewerTargetResult = {
				target: "regression#5 Regression reviewer",
				verdict: "APPROVED",
				status: "completed",
				result: {
					agent: "reviewer",
					task: "task",
					cwd: "/tmp",
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					finalOutput: "APPROVED. Looks good.",
					completionSource: "auto_exit",
					doneFile: regFile,
				},
			};
			const regLike = buildReviewerResultLikeForRoleEvaluation(regTarget);
			const regEval = evaluateReviewerResult(regressionTarget!, regLike);
			check(regEval.provisional === false,
				"12g: on-disk sidecar with coderEvidence.delegateHistory.reviewerEvidence suppresses auto_exit provisional");
			check(regEval.effectiveVerdict === "APPROVED",
				"12g: on-disk sidecar with coderEvidence.delegateHistory.reviewerEvidence keeps regression role approved");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}
}

main();
if (failures > 0) { console.error(`\n${failures} reviewer swarm smoke check(s) failed.`); process.exit(1); }
console.log("\nAll TASK-004 reviewer swarm integration smoke checks passed.");
