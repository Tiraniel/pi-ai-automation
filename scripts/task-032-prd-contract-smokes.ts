#!/usr/bin/env node
// TASK-032 (WP3) — structural PRD contract + ID traceability smokes.
// The contract must:
//   - normalize/validate prd.json fail-closed (B*/E*/X*/A*/Q* id patterns,
//     unique ids, A* referencing an existing Q*, explicit blocking flags);
//   - compute (not assert) ready_for_sprint: blocking Q* answered inline or
//     via an answered WP1 operator-queue record with the same id, and every
//     A* covering a CLOSED Q*;
//   - gate workflow_planning_state prd_ready_for_sprint on a valid ready
//     contract (missing/invalid prd.json blocks with an actionable error);
//   - mirror blocking Q* into the room's operator queue on
//     write_prd_contract;
//   - carry criterionId (AC*) / covers (B*/X*) / negative on matrix rows and
//     require every X* to be covered by a negative row on ready plans
//     (including the architecture-store hard-lock when a planning room with
//     prd.json is active);
//   - parse the adversarial verifier's fenced JSON finding and honor the
//     deepPlanning.verifier config default.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createFakeContext, createFakePi } from "../tests/fake-pi";
import {
	computePrdReadiness,
	normalizePrdContract,
	prdContractPathFor,
	readPrdContractFile,
	validateMatrixCoversForbiddenBehavior,
	validateReadyPlanAgainstActivePrdContract,
	writePrdContractFile,
	type PrdContract,
} from "../extensions/workflow/planning-prd-contract";
import {
	answerOperatorQuestionInFile,
	appendOperatorQuestionToFile,
	operatorQuestionsPathForRoom,
	readOperatorQuestionsFromFile,
} from "../extensions/workflow/operator-questions";
import { registerPlanningTools } from "../extensions/workflow/planning-tools";
import { normalizeMatrixEntry } from "../extensions/workflow/architecture/evidence-matrix";
import { createArchitecturePlanRecord } from "../extensions/workflow/architecture/store";
import { writePlanningCurrentRoomPointer } from "../extensions/workflow/planning-pointer";
import {
	buildVerifierPrompt,
	mergeDeepPlanningConfig,
	parseVerifierFinding,
} from "../extensions/workflow/deep-planning-core";
import { DEFAULT_CONFIG } from "../extensions/workflow/defaults";
import type { AcceptanceEvidenceMatrixEntry } from "../extensions/workflow/architecture/types";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function makeTempCwd(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeContract(overrides: Partial<PrdContract> = {}): PrdContract {
	return {
		summary: "Users can export reports as CSV.",
		expected_behavior: [
			{ id: "B1", description: "Clicking export downloads a CSV of the current view." },
			{ id: "B2", description: "Export respects active filters." },
		],
		edge_cases: [{ id: "E1", description: "Empty view exports a header-only CSV." }],
		forbidden_behavior: [{ id: "X1", description: "Export must never include soft-deleted rows." }],
		assumptions: [{ id: "A1", description: "Assume UTF-8 output is acceptable.", covers_question: "Q1" }],
		open_questions: [{ id: "Q1", question: "Which encoding must the CSV use?", blocking: true }],
		...overrides,
	};
}

function makeMatrixRow(overrides: Partial<AcceptanceEvidenceMatrixEntry> = {}): AcceptanceEvidenceMatrixEntry {
	return {
		criterion: "export produces filtered CSV",
		criterionKind: "runtime-behavior",
		businessRiskIfWrong: "wrong data leaves the system",
		enforcementLevel: ["behavior-test"],
		requiredEvidence: [{ kind: "behavior-test", description: "export behavior test", command: "npx tsx t.ts" }],
		reviewerRoles: ["behavior"],
		blockingConditions: ["export test fails"],
		...overrides,
	};
}

async function main(): Promise<void> {
	const cleanups: string[] = [];
	try {
		// (1) Normalize/validate: honest contract passes; envelope form accepted.
		{
			const direct = normalizePrdContract(makeContract());
			check(direct.value !== undefined && direct.issues.length === 0, "1: valid contract normalizes cleanly");
			const envelope = normalizePrdContract({ business_requirement: makeContract() });
			check(envelope.value !== undefined, "1: harness-style business_requirement envelope accepted");
			check(envelope.value?.expected_behavior.length === 2, "1: envelope preserves expected_behavior");
		}

		// (2) Fail-closed structural validation.
		{
			const badId = normalizePrdContract(makeContract({ expected_behavior: [{ id: "BEH-1", description: "x" }] }));
			check(badId.value === undefined && badId.issues.some((i) => i.code === "id_pattern_invalid"), "2: id pattern B* enforced");
			const dupe = normalizePrdContract(makeContract({ edge_cases: [{ id: "E1", description: "a" }, { id: "E1", description: "b" }] }));
			check(dupe.value === undefined && dupe.issues.some((i) => i.code === "id_duplicate"), "2: duplicate ids rejected");
			const noSummary = normalizePrdContract({ ...makeContract(), summary: " " });
			check(noSummary.value === undefined && noSummary.issues.some((i) => i.code === "summary_missing"), "2: missing summary rejected");
			const noBehavior = normalizePrdContract(makeContract({ expected_behavior: [] }));
			check(noBehavior.value === undefined && noBehavior.issues.some((i) => i.code === "expected_behavior_missing"), "2: at least one B* required");
			const badBlocking = normalizePrdContract(makeContract({ open_questions: [{ id: "Q1", question: "?", blocking: "yes" as unknown as boolean }] }));
			check(badBlocking.value === undefined && badBlocking.issues.some((i) => i.code === "contract_invalid_shape"), "2: non-boolean blocking rejected");
			const orphanAssumption = normalizePrdContract(makeContract({ assumptions: [{ id: "A1", description: "a", covers_question: "Q9" }] }));
			check(orphanAssumption.value === undefined && orphanAssumption.issues.some((i) => i.code === "assumption_question_unknown"), "2: A* covering unknown Q* rejected");
		}

		// (3) Readiness is computed: blocking Q* + assumption closure.
		{
			const contract = makeContract();
			const open = computePrdReadiness(contract, []);
			check(open.ready === false, "3: open blocking Q1 blocks readiness");
			check(open.openBlockingQuestionIds.includes("Q1"), "3: Q1 reported open");
			check(open.unresolvedAssumptionIds.includes("A1"), "3: A1 covering open Q1 reported unresolved");
			const inlineAnswered = computePrdReadiness(makeContract({
				open_questions: [{ id: "Q1", question: "Which encoding?", blocking: true, answer: "UTF-8", answeredAt: new Date().toISOString() }],
			}), []);
			check(inlineAnswered.ready === true, "3: inline answer closes Q1 and unblocks A1");
			const queueAnswered = computePrdReadiness(contract, [
				{ id: "Q1", at: new Date().toISOString(), from: "brain", question: "Which encoding?", blocking: true, answer: "UTF-8", answeredAt: new Date().toISOString() },
			]);
			check(queueAnswered.ready === true, "3: answered WP1 queue record with the same id closes Q1");
			const nonBlockingOnly = computePrdReadiness(makeContract({
				assumptions: [],
				open_questions: [{ id: "Q1", question: "nice to know?", blocking: false }],
			}), []);
			check(nonBlockingOnly.ready === true, "3: non-blocking Q* never blocks readiness");
		}

		// (4) write_prd_contract: fail-closed write + blocking Q* mirrored into the queue.
		{
			const cwd = makeTempCwd("task-032-artifacts-");
			cleanups.push(cwd);
			const fake = createFakePi();
			registerPlanningTools(fake.pi);
			const artifacts = fake.tools.get("workflow_planning_artifacts")!;
			const ctx = createFakeContext(cwd);
			const invalid = await artifacts.execute("t1", { action: "write_prd_contract", roomId: "wp3-room", contract: { summary: "s" } }, undefined, undefined, ctx);
			check(invalid.isError === true, "4: invalid contract is refused");
			check(!fs.existsSync(prdContractPathFor(cwd, "wp3-room")), "4: refused contract is NOT written");
			const valid = await artifacts.execute("t2", { action: "write_prd_contract", roomId: "wp3-room", contract: makeContract() }, undefined, undefined, ctx);
			check(valid.isError !== true, "4: valid contract writes prd.json");
			check(fs.existsSync(prdContractPathFor(cwd, "wp3-room")), "4: prd.json exists on disk");
			const queue = readOperatorQuestionsFromFile(operatorQuestionsPathForRoom(cwd, "wp3-room"));
			check(queue.some((q) => q.id === "Q1" && q.blocking), "4: blocking Q1 mirrored into the operator queue");
			check((valid.details as any)?.readiness?.ready === false, "4: write result reports computed readiness=false");
			const read = await artifacts.execute("t3", { action: "read", roomId: "wp3-room" }, undefined, undefined, ctx);
			check((read.details as any)?.prdContract?.summary === makeContract().summary, "4: read returns the parsed contract");
			// JSON-string form is accepted too.
			const asString = await artifacts.execute("t4", { action: "write_prd_contract", roomId: "wp3-room", contract: JSON.stringify(makeContract()) }, undefined, undefined, ctx);
			check(asString.isError !== true, "4: JSON-string contract accepted");
		}

		// (5) prd_ready_for_sprint requires a valid, READY contract.
		{
			const cwd = makeTempCwd("task-032-ready-");
			cleanups.push(cwd);
			const fake = createFakePi();
			registerPlanningTools(fake.pi);
			const planning = fake.tools.get("workflow_planning_state")!;
			const artifacts = fake.tools.get("workflow_planning_artifacts")!;
			const ctx = createFakeContext(cwd);
			await planning.execute("t1", { action: "create", roomId: "wp3-ready", scopeClassification: "non_trivial" }, undefined, undefined, ctx);
			const noContract = await planning.execute("t2", { action: "set_flag", roomId: "wp3-ready", state: "prd_ready_for_sprint", value: true }, undefined, undefined, ctx);
			check(noContract.isError === true && (noContract.details as any)?.reason === "prd_contract_missing_or_invalid",
				`5: missing prd.json blocks prd_ready_for_sprint (got: ${(noContract.details as any)?.reason})`);
			check(String(noContract.content?.[0]?.text ?? "").includes("write_prd_contract"), "5: blocker text names the fix tool/action");
			await artifacts.execute("t3", { action: "write_prd_contract", roomId: "wp3-ready", contract: makeContract() }, undefined, undefined, ctx);
			const notReady = await planning.execute("t4", { action: "set_flag", roomId: "wp3-ready", state: "prd_ready_for_sprint", value: true }, undefined, undefined, ctx);
			check(notReady.isError === true && (notReady.details as any)?.reason === "prd_not_ready",
				`5: open blocking Q1 blocks readiness (got: ${(notReady.details as any)?.reason})`);
			answerOperatorQuestionInFile(operatorQuestionsPathForRoom(cwd, "wp3-ready"), "Q1", "UTF-8", "operator");
			const ready = await planning.execute("t5", { action: "set_flag", roomId: "wp3-ready", state: "prd_ready_for_sprint", value: true }, undefined, undefined, ctx);
			check(ready.isError !== true, `5: answered Q1 (via WP1 queue) unblocks prd_ready_for_sprint (got: ${String(ready.content?.[0]?.text ?? "")})`);
			// Corrupted prd.json fails closed.
			fs.writeFileSync(prdContractPathFor(cwd, "wp3-ready"), "not-json", "utf8");
			const corrupted = await planning.execute("t6", { action: "set_flag", roomId: "wp3-ready", state: "prd_ready_for_sprint", value: true }, undefined, undefined, ctx);
			check(corrupted.isError === true && (corrupted.details as any)?.reason === "prd_contract_missing_or_invalid", "5: corrupted prd.json fails closed");
		}

		// (6) Matrix traceability fields normalize + validate.
		{
			const parsed = normalizeMatrixEntry(makeMatrixRow({ criterionId: "AC1", covers: ["B1", "X1"], negative: true }), 0);
			check(parsed.value?.criterionId === "AC1" && parsed.value?.covers?.join(",") === "B1,X1" && parsed.value?.negative === true,
				"6: criterionId/covers/negative parsed on matrix rows");
			const badCovers = normalizeMatrixEntry(makeMatrixRow({ covers: ["Z1"] }), 0);
			check(badCovers.value === undefined && badCovers.issues.some((i) => i.code === "entry_invalid_value"), "6: covers id must match B*/X*");
			const badCriterionId = normalizeMatrixEntry(makeMatrixRow({ criterionId: "C1" }), 0);
			check(badCriterionId.value === undefined, "6: criterionId must match AC*");
			const badNegative = normalizeMatrixEntry(makeMatrixRow({ negative: "yes" as unknown as boolean }), 0);
			check(badNegative.value === undefined, "6: non-boolean negative rejected");
		}

		// (7) Every X* must be covered by a NEGATIVE row.
		{
			const contract = makeContract();
			const uncovered = validateMatrixCoversForbiddenBehavior([makeMatrixRow({ covers: ["B1"] })], contract);
			check(uncovered.some((i) => i.code === "forbidden_behavior_uncovered" && i.id === "X1"), "7: X1 without a negative row is reported");
			const positiveOnly = validateMatrixCoversForbiddenBehavior([makeMatrixRow({ covers: ["X1"] })], contract);
			check(positiveOnly.some((i) => i.code === "forbidden_behavior_uncovered"), "7: a non-negative row covering X1 does not satisfy the rule");
			const covered = validateMatrixCoversForbiddenBehavior([
				makeMatrixRow({ covers: ["B1"] }),
				makeMatrixRow({ criterion: "soft-deleted rows never exported", criterionId: "AC2", covers: ["X1"], negative: true }),
			], contract);
			check(covered.length === 0, "7: negative row covering X1 satisfies the rule");
			const unknownCover = validateMatrixCoversForbiddenBehavior([makeMatrixRow({ covers: ["B9"], negative: true }), makeMatrixRow({ covers: ["X1"], negative: true })], contract);
			check(unknownCover.some((i) => i.code === "covers_unknown_id"), "7: covers referencing undeclared ids is reported");
		}

		// (8) Architecture-store ready hard-lock enforces X* coverage when the
		//     active planning room carries prd.json.
		{
			const cwd = makeTempCwd("task-032-store-");
			cleanups.push(cwd);
			writePlanningCurrentRoomPointer(cwd, "wp3-store");
			writePrdContractFile(cwd, "wp3-store", makeContract());
			const basePlan = {
				cwd,
				planId: "task-032-plan",
				status: "ready" as const,
				businessPlan: "b", technicalPlan: "t", parallelAssessment: "serial", contractBlockPlan: "c",
				acceptanceCriteria: ["export produces filtered CSV"],
			};
			let threw = "";
			try {
				createArchitecturePlanRecord({ ...basePlan, acceptanceEvidenceMatrix: [makeMatrixRow({ covers: ["B1"] })] });
			} catch (error) {
				threw = error instanceof Error ? error.message : String(error);
			}
			check(threw.includes("forbidden_behavior_uncovered"), `8: ready plan without negative X1 coverage is refused (got: ${threw.slice(0, 100) || "no error"})`);
			const okPlan = createArchitecturePlanRecord({
				...basePlan,
				planId: "task-032-plan-ok",
				acceptanceCriteria: ["export produces filtered CSV", "soft-deleted rows never exported"],
				acceptanceEvidenceMatrix: [
					makeMatrixRow({ covers: ["B1"], criterionId: "AC1" }),
					makeMatrixRow({ criterion: "soft-deleted rows never exported", criterionId: "AC2", covers: ["X1"], negative: true }),
				],
			});
			check(okPlan.status === "ready", "8: ready plan with negative X1 coverage records fine");
			check(okPlan.acceptanceEvidenceMatrix?.[1]?.negative === true, "8: negative flag survives the store round-trip");
			// No planning room / no prd.json -> the store check is a no-op.
			const plainCwd = makeTempCwd("task-032-store-plain-");
			cleanups.push(plainCwd);
			const coverage = validateReadyPlanAgainstActivePrdContract(plainCwd, [makeMatrixRow()]);
			check(coverage.checked === false, "8: no active planning room means no PRD coverage check");
		}

		// (9) Verifier: config default + finding parser.
		{
			check(DEFAULT_CONFIG.deepPlanning?.verifier === true, "9: deepPlanning.verifier default is true");
			const merged = mergeDeepPlanningConfig(undefined, {});
			check(merged.verifier === true, "9: merged config keeps verifier on by default");
			check(mergeDeepPlanningConfig({ verifier: false }, {}).verifier === false, "9: config verifier=false is honored");
			check(mergeDeepPlanningConfig({ verifier: false }, { verifier: true }).verifier === true, "9: explicit request beats config");
			check(buildVerifierPrompt("task").includes("json"), "9: verifier prompt demands the fenced JSON block");
			const finding = parseVerifierFinding(`Analysis prose...
\`\`\`json
{"gaps": ["failure path for network loss is unspecified"], "questions": [{"question": "What happens on partial export failure?", "recommendedDefault": "abort and report"}, "Is pagination in scope?"]}
\`\`\``);
			check(finding !== undefined && finding.gaps.length === 1, "9: gaps parsed from the fenced block");
			check(finding?.questions.length === 2 && finding.questions[0]?.recommendedDefault === "abort and report", "9: object and string questions both parsed");
			check(parseVerifierFinding("no json here") === undefined, "9: unparsable output yields undefined (no prose guessing)");
			const lastBlockWins = parseVerifierFinding(`\`\`\`json
{"gaps": ["old"], "questions": []}
\`\`\`
revised:
\`\`\`json
{"gaps": ["new"], "questions": []}
\`\`\``);
			check(lastBlockWins?.gaps[0] === "new", "9: the LAST parsable fenced block wins");
		}

		// (10) readPrdContractFile round-trip via file helpers.
		{
			const cwd = makeTempCwd("task-032-io-");
			cleanups.push(cwd);
			writePrdContractFile(cwd, "wp3-io", makeContract());
			const read = readPrdContractFile(cwd, "wp3-io");
			check(read.contract?.forbidden_behavior[0]?.id === "X1", "10: prd.json round-trips through the file helpers");
			const missing = readPrdContractFile(cwd, "wp3-io-missing");
			check(missing.exists === false && missing.issues.some((i) => i.code === "contract_missing"), "10: missing prd.json reports contract_missing");
		}
	} finally {
		for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
	}
}

main().then(() => {
	if (failures > 0) { console.error(`\n${failures} PRD contract smoke check(s) failed.`); process.exit(1); }
	console.log("\nAll TASK-032 PRD contract smoke checks passed.");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
