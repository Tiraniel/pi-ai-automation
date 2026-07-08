#!/usr/bin/env node
// TASK-031 (WP1) — operator escalation channel smokes.
// Behavioral: tools are driven through the fake ExtensionAPI
// (tests/fake-pi.ts) against temp cwds; the queue / gates are exercised on
// real files. The channel must:
//   - round-trip ask -> read -> answer on the durable JSONL queue and
//     tolerate a torn (truncated) tail line;
//   - register the full tool set in the parent session and ONLY the ask
//     tool in a delegate child (env-based registration, like done-tools);
//   - export the questions file to delegate children via buildChildEnv;
//   - block strict finalization with `operator_question_pending` while a
//     blocking question is open, and unblock once answered;
//   - refuse to record prd_ready_for_sprint while the planning room has an
//     open blocking question;
//   - stop the AFK ship engine with `awaiting-operator` instead of
//     delivery_complete, list open questions in REPORT.md, and clear after
//     the answer;
//   - carry the escalation rule in Brain/planner prompt surfaces (single
//     owner, interpolated).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createFakeContext, createFakePi } from "../tests/fake-pi";
import {
	answerOperatorQuestionInFile,
	appendOperatorQuestionToFile,
	listOpenBlockingQuestionsForCwd,
	listOpenBlockingQuestionsInFile,
	operatorQuestionsPathForRoom,
	readOperatorQuestionsFromFile,
	OPERATOR_QUESTIONS_FILE_ENV_VAR,
	OPERATOR_QUESTIONS_FILE_NAME,
} from "../extensions/workflow/operator-questions";
import { registerOperatorQuestionTools } from "../extensions/workflow/operator-question-tools";
import { registerPlanningTools } from "../extensions/workflow/planning-tools";
import { writePrdContractFile } from "../extensions/workflow/planning-prd-contract";
import { buildChildEnv } from "../extensions/workflow/delegate/child";
import { evaluateFinalizationGate } from "../extensions/workflow/finalization-gate";
import { BRAIN_INSTRUCTIONS, OPERATOR_ESCALATION_RULE } from "../extensions/workflow/prompts";
import { DEFAULT_CONFIG } from "../extensions/workflow/defaults";
import { transitionShipState } from "../extensions/sprint/ship-engine";
import { registerSprintShipTools } from "../extensions/sprint/ship-tools";
import { shipRunDir, type ShipState } from "../extensions/sprint/ship-state";
import type { CoderCompletionEvidence } from "../extensions/workflow/delegate/completion-evidence";
import type { ReviewerMemo } from "../extensions/workflow/delegate/reviewer-roles";
import type { WorkflowArchitecturePlan } from "../extensions/workflow/architecture/types";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function makeTempCwd(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- passing finalization fixture (task-005 style) ----
function makePlan(): WorkflowArchitecturePlan {
	const now = new Date().toISOString();
	return {
		planId: "task-031", createdAt: now, updatedAt: now, status: "ready",
		businessPlan: "b", technicalPlan: "t", parallelAssessment: "serial", contractBlockPlan: "c",
		acceptanceCriteria: ["runtime-check"],
		acceptanceEvidenceMatrix: [{
			criterion: "runtime-check", criterionKind: "runtime-behavior",
			businessRiskIfWrong: "regression",
			enforcementLevel: ["behavior-test"],
			requiredEvidence: [{ kind: "behavior-test", description: "runtime test", command: "npx tsx t.ts" }],
			reviewerRoles: ["behavior"], blockingConditions: ["test fails"],
		}],
		phases: {
			phaseA: { status: "review_approved", updatedAt: now, evidence: [] },
			phaseB: { status: "not_started", updatedAt: now, evidence: [] },
		},
	};
}
function makeEvidence(): CoderCompletionEvidence {
	return {
		filesChanged: ["src/thing.ts"],
		commandsRun: [{ command: "npx tsx t.ts", outcome: "passed", exitCode: 0, summary: "green" }],
		criterionCoverage: [{
			criterion: "runtime-check", evidenceKind: "behavior-test", strength: "sufficient",
			supportingFiles: ["src/thing.ts"], supportingCommands: ["npx tsx t.ts"], summary: "covered",
		}],
		knownGaps: [], caveats: [], summary: "packet",
		delegateHistory: {
			attempts: [{ attempt: 1, completionSource: "explicit", status: "completed" }],
			warnings: [], retries: 0,
			autoExitObserved: false, processExitObserved: false, missingSidecarObserved: false, freeFormOnlyObserved: false,
		},
	};
}
function makeMemo(): ReviewerMemo {
	return {
		planId: "task-031", phase: "phaseB", approved: true, finalRecommendation: "APPROVED",
		approvals: [], changesRequested: [], weakEvidence: [], promptOnlyCaveats: [],
		unresolvedRisks: [], provisionalCaveats: [], unknownOrFailed: [],
		markdown: "# Memo\n\nAPPROVED", supplementalGoals: [], docsConfigInScope: false,
		rolesRequired: ["behavior"], missingRequiredRoles: [],
	};
}

function makeApprovedHotfixShipState(overrides: Partial<ShipState> = {}): ShipState {
	const now = new Date().toISOString();
	return {
		version: 2, runId: "afk-task-031", lane: "hotfix", hotfixKind: "code-changing",
		stage: "finalizing", attempts: 1, retryBudget: 3, blockers: [],
		evidenceRefs: ["scripts/task-031-operator-questions-smokes.ts#case"],
		changedFiles: ["src/thing.ts"],
		checks: [{ command: "npx tsx t.ts", outcome: "passed" }],
		reviewerOutcome: { kind: "approved", at: now },
		permissions: { push: false, pr: false, deploy: false, destructive: false, credentialed: false },
		reviewerRequired: true, promotionReasonCodes: [], finalizationStatus: "pending",
		affectedFiles: [], createdAt: now, updatedAt: now,
		...overrides,
	};
}
const FINALIZATION_EVENT = {
	kind: "finalization_recorded" as const,
	finalizationSummary: "Finalization checks passed.",
	finalizationResult: "passed",
	qualityAuditSummary: "audit clean",
	qualityAuditArtifact: ".pi/workflow-runs/quality-audit/task-031.json",
};

async function main(): Promise<void> {
	const cleanups: string[] = [];
	try {
		// (1) Queue round-trip + tail-truncation tolerance.
		{
			const cwd = makeTempCwd("task-031-queue-");
			cleanups.push(cwd);
			const file = operatorQuestionsPathForRoom(cwd, "room-a");
			const asked = appendOperatorQuestionToFile(file, {
				question: "Ship with feature flag on or off?", from: "brain", blocking: true,
				options: ["on", "off"], recommendedDefault: "off",
			});
			check(listOpenBlockingQuestionsInFile(file).length === 1, "1: blocking question is open after ask");
			// torn tail line must be skipped, not crash the reader
			fs.appendFileSync(file, `{"id":"q-torn","question":"partial`, "utf8");
			check(readOperatorQuestionsFromFile(file).length === 1, "1: torn tail line is tolerated");
			const answered = answerOperatorQuestionInFile(file, asked.id, "off", "operator");
			check(answered.answer === "off" && Boolean(answered.answeredAt), "1: answer recorded");
			check(listOpenBlockingQuestionsInFile(file).length === 0, "1: no open blocking questions after answer");
			const merged = readOperatorQuestionsFromFile(file).find((q) => q.id === asked.id);
			check(merged?.question === asked.question && merged?.recommendedDefault === "off", "1: merged record keeps ask metadata");
			let doubleAnswerRejected = false;
			try { answerOperatorQuestionInFile(file, asked.id, "on"); } catch { doubleAnswerRejected = true; }
			check(doubleAnswerRejected, "1: answering an already-answered question is refused");
		}

		// (2) Parent tool registration + ask/answer/list behavior via fake-pi.
		{
			const cwd = makeTempCwd("task-031-tools-");
			cleanups.push(cwd);
			const fake = createFakePi();
			registerOperatorQuestionTools(fake.pi);
			check(fake.tools.has("workflow_ask_operator") && fake.tools.has("workflow_answer_question") && fake.tools.has("workflow_operator_questions"),
				"2: parent session registers ask + answer + list tools");
			const notifications: string[] = [];
			const ctx = createFakeContext(cwd, { ui: { notify: (text: string) => notifications.push(text), setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } } });
			const askResult = await fake.tools.get("workflow_ask_operator")!.execute("t1", {
				question: "Use kebab or snake case for the stop condition?", blocking: true, roomId: "room-b",
				options: ["kebab", "snake"], recommendedDefault: "kebab",
			}, undefined, undefined, ctx);
			check(askResult.isError !== true, "2: ask tool succeeds");
			const askedId = (askResult.details as any)?.question?.id as string;
			check(typeof askedId === "string" && askedId.length > 0, "2: ask tool returns the question id");
			check(notifications.some((n) => n.includes("Blocking operator question")), "2: blocking ask notifies the parent UI");
			const listResult = await fake.tools.get("workflow_operator_questions")!.execute("t2", { roomId: "room-b" }, undefined, undefined, ctx);
			check((listResult.details as any)?.openBlockingCount === 1, "2: list reports one open blocking question");
			const answerResult = await fake.tools.get("workflow_answer_question")!.execute("t3", { id: askedId, answer: "kebab", roomId: "room-b" }, undefined, undefined, ctx);
			check(answerResult.isError !== true && (answerResult.details as any)?.openBlockingCount === 0, "2: answer tool unblocks the room queue");
		}

		// (3) Child (delegate) registration: env var present -> only the ask tool.
		{
			const cwd = makeTempCwd("task-031-child-");
			cleanups.push(cwd);
			const childFile = path.join(cwd, ".pi", "workflow-runs", "room-c", OPERATOR_QUESTIONS_FILE_NAME);
			const prevEnv = process.env[OPERATOR_QUESTIONS_FILE_ENV_VAR];
			process.env[OPERATOR_QUESTIONS_FILE_ENV_VAR] = childFile;
			try {
				const fake = createFakePi();
				registerOperatorQuestionTools(fake.pi);
				check(fake.tools.has("workflow_ask_operator"), "3: child session registers the ask tool");
				check(!fake.tools.has("workflow_answer_question") && !fake.tools.has("workflow_operator_questions"),
					"3: child session does NOT register answer/list tools");
				const result = await fake.tools.get("workflow_ask_operator")!.execute("t1", {
					question: "Is deleting the legacy file in scope?", blocking: true,
				}, undefined, undefined, createFakeContext(cwd));
				check(result.isError !== true, "3: child ask succeeds");
				check(listOpenBlockingQuestionsInFile(childFile).length === 1, "3: child ask appends to the env-exported file");
				check(listOpenBlockingQuestionsInFile(childFile)[0]!.from === "delegate", "3: child ask defaults from=delegate");
			} finally {
				if (prevEnv === undefined) delete process.env[OPERATOR_QUESTIONS_FILE_ENV_VAR];
				else process.env[OPERATOR_QUESTIONS_FILE_ENV_VAR] = prevEnv;
			}
		}

		// (4) buildChildEnv exports the questions file (room scope and default scope).
		{
			const cwd = makeTempCwd("task-031-env-");
			cleanups.push(cwd);
			const noRoom = buildChildEnv(cwd);
			check(noRoom[OPERATOR_QUESTIONS_FILE_ENV_VAR] === operatorQuestionsPathForRoom(cwd, "operator"),
				"4: buildChildEnv without room exports the default operator queue");
			const withRoom = buildChildEnv(cwd, { roomId: "room-d", agentId: "coder", role: "coder" } as any);
			check(withRoom[OPERATOR_QUESTIONS_FILE_ENV_VAR] === operatorQuestionsPathForRoom(cwd, "room-d"),
				"4: buildChildEnv with room exports the room queue");
		}

		// (5) Finalization gate: open blocking question blocks; answered unblocks.
		{
			const base = {
				mode: "strict" as const,
				requestedStatus: "done",
				target: { kind: "sprint-task" as const, taskId: "TASK-031", planId: "task-031" },
				plan: makePlan(),
				coderEvidence: makeEvidence(),
				reviewerMemo: makeMemo(),
			};
			const clean = evaluateFinalizationGate(base);
			check(clean.ok === true, `5: baseline fixture passes strict finalization (blockers: ${clean.blockers.join("; ") || "none"})`);
			const blocked = evaluateFinalizationGate({
				...base,
				openOperatorQuestions: [{ id: "q-1", question: "Which retention policy?", from: "coder", scope: "room-a" }],
			});
			check(blocked.ok === false, "5: open blocking operator question blocks strict finalization");
			check(blocked.codes.includes("operator_question_pending"), `5: operator_question_pending code reported (got: ${blocked.codes.join(",")})`);
			check(blocked.blockers.some((b) => b.includes("q-1") && b.includes("workflow_answer_question")), "5: blocker text names the question id and the answer tool");
			check(blocked.details.operatorQuestions.openBlockingCount === 1, "5: details carry the open question count");
		}

		// (6) Cwd-wide scan: room-level and nested run-level queues are both found.
		{
			const cwd = makeTempCwd("task-031-scan-");
			cleanups.push(cwd);
			appendOperatorQuestionToFile(operatorQuestionsPathForRoom(cwd, "room-e"), { question: "room question", from: "brain", blocking: true });
			const nested = path.join(cwd, ".pi", "workflow-runs", "afk-ship", "run-1", OPERATOR_QUESTIONS_FILE_NAME);
			appendOperatorQuestionToFile(nested, { question: "ship question", from: "coder", blocking: true });
			appendOperatorQuestionToFile(operatorQuestionsPathForRoom(cwd, "room-f"), { question: "advisory", from: "brain", blocking: false });
			const open = listOpenBlockingQuestionsForCwd(cwd);
			check(open.length === 2, `6: scan finds both blocking questions (got: ${open.length})`);
			check(open.some((q) => q.scope === "room-e") && open.some((q) => q.scope === "afk-ship/run-1"), "6: scan reports room and nested run scopes");
		}

		// (7) Planning: prd_ready_for_sprint refused while a blocking question is open.
		//     (WP3 also requires a valid prd.json; this case provides a ready
		//     contract so the ad-hoc WP1 queue block is what is under test.)
		{
			const cwd = makeTempCwd("task-031-planning-");
			cleanups.push(cwd);
			const fake = createFakePi();
			registerPlanningTools(fake.pi);
			const planningTool = fake.tools.get("workflow_planning_state")!;
			const ctx = createFakeContext(cwd);
			const created = await planningTool.execute("t1", { action: "create", roomId: "wp1-room", scopeClassification: "non_trivial" }, undefined, undefined, ctx);
			check(created.isError !== true, "7: planning state created");
			writePrdContractFile(cwd, "wp1-room", {
				summary: "task-031 planning smoke",
				expected_behavior: [{ id: "B1", description: "flagged flow works" }],
				edge_cases: [], forbidden_behavior: [], assumptions: [], open_questions: [],
			});
			appendOperatorQuestionToFile(operatorQuestionsPathForRoom(cwd, "wp1-room"), {
				question: "Blocked: which storage backend?", from: "brain", blocking: true, id: "q-storage",
			});
			const refused = await planningTool.execute("t2", { action: "set_flag", roomId: "wp1-room", state: "prd_ready_for_sprint", value: true }, undefined, undefined, ctx);
			check(refused.isError === true, "7: prd_ready_for_sprint refused with open blocking question");
			check((refused.details as any)?.reason === "operator_question_pending", `7: refusal reason is operator_question_pending (got: ${(refused.details as any)?.reason})`);
			answerOperatorQuestionInFile(operatorQuestionsPathForRoom(cwd, "wp1-room"), "q-storage", "sqlite", "operator");
			const allowed = await planningTool.execute("t3", { action: "set_flag", roomId: "wp1-room", state: "prd_ready_for_sprint", value: true }, undefined, undefined, ctx);
			check(allowed.isError !== true, "7: prd_ready_for_sprint recorded after the answer");
		}

		// (8) Ship engine: awaiting-operator beats delivery_complete; clears after answer.
		{
			const withQuestion = makeApprovedHotfixShipState({
				openOperatorQuestions: [{ id: "q-ship", question: "OK to skip migration?", from: "coder" }],
			});
			const blocked = transitionShipState(withQuestion, FINALIZATION_EVENT);
			check(blocked.toStage === "blocked" && blocked.stopCondition === "awaiting-operator",
				`8: finalization_recorded stops with awaiting-operator (got: ${blocked.toStage}/${blocked.stopCondition})`);
			check((blocked.blocker ?? "").includes("q-ship"), "8: blocker names the open question id");
			const clean = transitionShipState(makeApprovedHotfixShipState(), FINALIZATION_EVENT);
			check(clean.toStage === "delivery_complete" && clean.stopCondition === "delivery-complete",
				`8: without open questions the same event completes delivery (got: ${clean.toStage}/${clean.stopCondition})`);
		}

		// (9) Ship tools: run-dir questions refresh onto durable state + REPORT.md.
		{
			const cwd = makeTempCwd("task-031-ship-");
			cleanups.push(cwd);
			const fake = createFakePi();
			registerSprintShipTools(fake.pi);
			const shipTool = fake.tools.get("sprint_ship")!;
			const ctx = createFakeContext(cwd);
			const started = await shipTool.execute("t1", {
				action: "start", runId: "run-wp1", lane: "hotfix", hotfixKind: "code-changing", allowedScope: "task-031 smoke",
			}, undefined, undefined, ctx);
			check(started.isError !== true, "9: AFK hotfix run starts");
			const runQuestions = path.join(shipRunDir(cwd, "run-wp1"), OPERATOR_QUESTIONS_FILE_NAME);
			appendOperatorQuestionToFile(runQuestions, { question: "Confirm scope for run?", from: "coder", blocking: true, id: "q-run" });
			const read = await shipTool.execute("t2", { action: "read", runId: "run-wp1" }, undefined, undefined, ctx);
			const readState = (read.details as any)?.state as ShipState;
			check((readState.openOperatorQuestions ?? []).some((q) => q.id === "q-run"), "9: action=read refreshes openOperatorQuestions from the run dir");
			check(String((read.details as any)?.renderedReport ?? "").includes("## Open operator questions")
				&& String((read.details as any)?.renderedReport ?? "").includes("q-run"), "9: REPORT.md lists the open question");
			const transitioned = await shipTool.execute("t3", { action: "transition", runId: "run-wp1", event: FINALIZATION_EVENT }, undefined, undefined, ctx);
			check((transitioned.details as any)?.stopCondition === "awaiting-operator", `9: transition finalization_recorded stops awaiting-operator (got: ${(transitioned.details as any)?.stopCondition})`);
			answerOperatorQuestionInFile(runQuestions, "q-run", "yes, in scope", "operator");
			const after = await shipTool.execute("t4", { action: "read", runId: "run-wp1" }, undefined, undefined, ctx);
			check(((after.details as any)?.state as ShipState).openOperatorQuestions?.length === 0, "9: answered question clears from the refreshed state");
		}

		// (10) Prompt surfaces carry the single-owner escalation rule.
		{
			check(BRAIN_INSTRUCTIONS.includes(OPERATOR_ESCALATION_RULE), "10: BRAIN_INSTRUCTIONS embeds the operator escalation rule");
			check(BRAIN_INSTRUCTIONS.split("workflow_ask_operator").length >= 2, "10: BRAIN_INSTRUCTIONS mentions workflow_ask_operator");
			const plannerInstructions = DEFAULT_CONFIG.deepPlanning?.planners?.[0]?.instructions ?? "";
			check(plannerInstructions.includes(OPERATOR_ESCALATION_RULE), "10: default planner instructions embed the operator escalation rule");
		}
	} finally {
		for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
	}
}

main().then(() => {
	if (failures > 0) { console.error(`\n${failures} operator questions smoke check(s) failed.`); process.exit(1); }
	console.log("\nAll TASK-031 operator escalation channel smoke checks passed.");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
