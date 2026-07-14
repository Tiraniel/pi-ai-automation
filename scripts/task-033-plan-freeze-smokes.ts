#!/usr/bin/env node
// TASK-033 (WP5) — OSOT plan-freeze smokes.
// The freeze must:
//   - hash the plan CONTRACT deterministically (key order irrelevant;
//     volatile fields — updatedAt / phase progress — never drift the hash);
//   - snapshot to .pi/workflow-architecture/plans/<planId>.<phase>.frozen.json
//     on the first coder delegation of a phase (ensure-once semantics);
//   - detect drift when the plan contract changes after the snapshot and
//     fail closed on unreadable snapshots;
//   - block the coder phase-advancement gate (plan_drift_detected) and the
//     reviewer delegation fail-fast path (before any child spawn);
//   - re-baseline ONLY via workflow_update_architecture_plan
//     { rebaselinePhase: true }: snapshot re-frozen, phase reset to
//     not_started, planning-state implementation confirmation invalidated
//     (same "contract change resets clearances" semantics as invalidatedBy).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createFakeContext, createFakePi } from "../tests/fake-pi";
import {
	canonicalJson,
	checkPlanDrift,
	computePlanContractSha256,
	ensurePlanFrozenForPhase,
	formatPlanDriftText,
	freezePlanForPhase,
	frozenPlanPathFor,
	readFrozenPlanSnapshot,
} from "../extensions/workflow/architecture/plan-freeze";
import {
	createArchitecturePlanRecord,
	readArchitecturePlan,
	updatePlanPhase,
	updatePlanRecord,
} from "../extensions/workflow/architecture/store";
import { registerArchitectureTools } from "../extensions/workflow/architecture";
import { registerDelegateTools } from "../extensions/workflow/delegate/tools";
import { evaluateCoderPhaseAdvancement } from "../extensions/workflow/delegate/completion-evidence-gate";
import { createPlanningState, readPlanningState } from "../extensions/workflow/planning-state";
import { writePlanningCurrentRoomPointer } from "../extensions/workflow/planning-pointer";
import type { AcceptanceEvidenceMatrixEntry, WorkflowArchitecturePlan } from "../extensions/workflow/architecture/types";
import type { CoderCompletionEvidence } from "../extensions/workflow/delegate/completion-evidence";
import type { DelegateRunResult, UsageStats } from "../extensions/workflow/types";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

const ZERO_USAGE: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
const CRITERION = "alpha-behavior";

function makeMatrix(): AcceptanceEvidenceMatrixEntry[] {
	return [{
		criterion: CRITERION,
		criterionKind: "runtime-behavior",
		businessRiskIfWrong: "alpha path may regress",
		enforcementLevel: ["behavior-test"],
		requiredEvidence: [{ kind: "behavior-test", description: "alpha behavior test", command: "npx tsx t.ts" }],
		reviewerRoles: ["behavior"],
		blockingConditions: ["alpha behavior test fails"],
	}];
}

function createReadyPlan(cwd: string, planId: string): WorkflowArchitecturePlan {
	return createArchitecturePlanRecord({
		cwd,
		planId,
		status: "ready",
		businessPlan: "b", technicalPlan: "t", parallelAssessment: "serial", contractBlockPlan: "c",
		acceptanceCriteria: [CRITERION],
		acceptanceEvidenceMatrix: makeMatrix(),
	});
}

function makeEvidencePacket(): CoderCompletionEvidence {
	return {
		filesChanged: ["src/thing.ts"],
		commandsRun: [{ command: "npx tsx t.ts", outcome: "passed", exitCode: 0 }],
		criterionCoverage: [{
			criterion: CRITERION, evidenceKind: "behavior-test", strength: "sufficient",
			supportingFiles: ["src/thing.ts"], supportingCommands: ["npx tsx t.ts"], summary: "covered",
		}],
		knownGaps: [], caveats: [],
		delegateHistory: {
			attempts: [{ attempt: 1, completionSource: "explicit", status: "completed" }],
			warnings: [], retries: 0,
			autoExitObserved: false, processExitObserved: false, missingSidecarObserved: false, freeFormOnlyObserved: false,
		},
	};
}

function makeResult(packet: CoderCompletionEvidence): DelegateRunResult {
	const result: DelegateRunResult = {
		agent: "coder", task: "task-033", cwd: "/tmp",
		exitCode: 0, messages: [], stderr: "", usage: { ...ZERO_USAGE },
		stopReason: "end_turn", status: "completed",
		finalOutput: "structured evidence attached", display: "headless",
		completionSource: "explicit",
	};
	// TASK-002 hard-cut (merged from main): only the canonical
	// `details.evidence.coderEvidence` envelope is gate-authoritative.
	(result as unknown as { details?: Record<string, unknown> }).details = { evidence: { coderEvidence: packet } };
	return result;
}

async function main(): Promise<void> {
	const cleanups: string[] = [];
	const makeTempCwd = (prefix: string): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		cleanups.push(dir);
		return dir;
	};
	try {
		// (1) Deterministic contract hash: key order irrelevant, volatile
		//     fields excluded, contract changes change the hash.
		{
			check(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }) === canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }),
				"1: canonicalJson is stable under key order");
			const cwd = makeTempCwd("task-033-hash-");
			const plan = createReadyPlan(cwd, "task-033-hash");
			const sha = computePlanContractSha256(plan);
			updatePlanPhase(cwd, "task-033-hash", "phaseA", "coder_completed", "phase progress");
			const afterPhase = readArchitecturePlan(cwd, "task-033-hash")!;
			check(computePlanContractSha256(afterPhase) === sha, "1: phase progress / updatedAt do NOT change the contract hash");
			updatePlanRecord(cwd, "task-033-hash", { technicalPlan: "t2" });
			const afterEdit = readArchitecturePlan(cwd, "task-033-hash")!;
			check(computePlanContractSha256(afterEdit) !== sha, "1: a contract change DOES change the hash");
		}

		// (2) Freeze + drift lifecycle.
		{
			const cwd = makeTempCwd("task-033-freeze-");
			const plan = createReadyPlan(cwd, "task-033-freeze");
			const before = checkPlanDrift(cwd, "task-033-freeze", "phaseA");
			check(before.status === "no_snapshot", "2: no snapshot before the first freeze");
			const first = ensurePlanFrozenForPhase(cwd, plan, "phaseA");
			check(first.created === true && first.drift.status === "match", "2: first ensure creates the snapshot");
			check(fs.existsSync(frozenPlanPathFor(cwd, "task-033-freeze", "phaseA")), "2: snapshot file lives at <planId>.<phase>.frozen.json");
			const second = ensurePlanFrozenForPhase(cwd, plan, "phaseA");
			check(second.created === false && second.drift.status === "match", "2: second ensure is idempotent and matches");
			const snapshot = readFrozenPlanSnapshot(cwd, "task-033-freeze", "phaseA");
			check(snapshot.snapshot?.sha256 === computePlanContractSha256(plan), "2: snapshot sha256 matches the plan contract hash");
			updatePlanRecord(cwd, "task-033-freeze", { businessPlan: "b2" });
			const drift = checkPlanDrift(cwd, "task-033-freeze", "phaseA");
			check(drift.status === "drift", "2: contract edit after freeze is detected as drift");
			check(formatPlanDriftText(drift).includes("rebaselinePhase"), "2: drift text names the rebaseline escape hatch");
			// Fail-closed on a corrupted snapshot.
			fs.writeFileSync(frozenPlanPathFor(cwd, "task-033-freeze", "phaseA"), "not-json", "utf8");
			check(checkPlanDrift(cwd, "task-033-freeze", "phaseA").status === "snapshot_unreadable", "2: corrupted snapshot fails closed (snapshot_unreadable)");
			// Independent phases: phaseB has its own snapshot.
			check(checkPlanDrift(cwd, "task-033-freeze", "phaseB").status === "no_snapshot", "2: phaseB snapshot is independent of phaseA");
		}

		// (3) Coder phase-advancement gate blocks on drift.
		{
			const cwd = makeTempCwd("task-033-gate-");
			const plan = createReadyPlan(cwd, "task-033-gate");
			const result = makeResult(makeEvidencePacket());
			const driftAdv = evaluateCoderPhaseAdvancement(plan, result, {}, {
				planFreeze: { status: "drift", expectedSha256: "aaaa", currentSha256: "bbbb", reason: "plan contract changed after the phaseA snapshot" },
			});
			check(driftAdv.kind === "block", "3: drift blocks phase advancement");
			if (driftAdv.kind === "block") {
				check(driftAdv.rejectionCodes.includes("plan_drift_detected"), `3: plan_drift_detected reported (got: ${driftAdv.rejectionCodes.join(",")})`);
				check((driftAdv.reason ?? "").includes("rebaselinePhase"), "3: rejection reason names the rebaseline path");
			}
			const matchAdv = evaluateCoderPhaseAdvancement(plan, result, {}, {
				planFreeze: { status: "match", expectedSha256: "aaaa", currentSha256: "aaaa" },
			});
			check(matchAdv.kind === "advance", "3: matching snapshot advances");
			const unreadableAdv = evaluateCoderPhaseAdvancement(plan, result, {}, {
				planFreeze: { status: "snapshot_unreadable", reason: "corrupted file" },
			});
			check(unreadableAdv.kind === "block", "3: unreadable snapshot fails closed at advancement");
		}

		// (4) Reviewer delegation fail-fast: drifted plan blocks BEFORE any
		//     child spawn (the error returns synchronously from the tool).
		{
			const cwd = makeTempCwd("task-033-reviewer-");
			const plan = createReadyPlan(cwd, "task-033-review");
			updatePlanPhase(cwd, "task-033-review", "phaseA", "coder_completed", "coder finished");
			freezePlanForPhase(cwd, readArchitecturePlan(cwd, "task-033-review")!, "phaseA");
			updatePlanRecord(cwd, "task-033-review", { technicalPlan: "drifted" });
			const fake = createFakePi();
			registerDelegateTools(fake.pi);
			const reviewerTool = fake.tools.get("delegate_to_reviewer")!;
			const ctx = createFakeContext(cwd);
			const blocked = await reviewerTool.execute("t1", {
				task: "review the alpha implementation",
				architecture: { planId: "task-033-review", phase: "phaseA" },
			}, undefined, undefined, ctx);
			check(blocked.isError === true, "4: reviewer delegation on a drifted plan is refused");
			check((blocked.details as any)?.reason === "plan_drift_detected", `4: reason is plan_drift_detected (got: ${(blocked.details as any)?.reason})`);
			check(String(blocked.content?.[0]?.text ?? "").includes("rebaselinePhase"), "4: reviewer block text names the rebaseline path");
			// unused var guard
			void plan;
		}

		// (5) Rebaseline via workflow_update_architecture_plan: snapshot
		//     re-frozen, phase reset, planning-state invalidated.
		{
			const cwd = makeTempCwd("task-033-rebase-");
			createReadyPlan(cwd, "task-033-rebase");
			updatePlanPhase(cwd, "task-033-rebase", "phaseA", "coder_completed", "coder finished");
			freezePlanForPhase(cwd, readArchitecturePlan(cwd, "task-033-rebase")!, "phaseA");
			// Active planning room with confirmed implementation.
			writePlanningCurrentRoomPointer(cwd, "wp5-room");
			createPlanningState({
				cwd, roomId: "wp5-room", scopeClassification: "non_trivial",
				states: { prd_started: true, prd_ready_for_sprint: true, sprint_confirmed: true, implementation_confirmed: true },
			});
			updatePlanRecord(cwd, "task-033-rebase", { contractBlockPlan: "c2" });
			check(checkPlanDrift(cwd, "task-033-rebase", "phaseA").status === "drift", "5: fixture drifts before rebaseline");
			const fake = createFakePi();
			registerArchitectureTools(fake.pi);
			const updateTool = fake.tools.get("workflow_update_architecture_plan")!;
			const ctx = createFakeContext(cwd);
			const missingPhase = await updateTool.execute("t1", { planId: "task-033-rebase", rebaselinePhase: true }, undefined, undefined, ctx);
			check(missingPhase.isError === true && (missingPhase.details as any)?.reason === "missing_phase_for_rebaseline", "5: rebaselinePhase without phase is refused");
			const rebase = await updateTool.execute("t2", { planId: "task-033-rebase", phase: "phaseA", rebaselinePhase: true }, undefined, undefined, ctx);
			check(rebase.isError !== true, `5: rebaseline succeeds (got: ${String(rebase.content?.[0]?.text ?? "")})`);
			const after = checkPlanDrift(cwd, "task-033-rebase", "phaseA");
			check(after.status === "match", "5: snapshot re-frozen to the current plan (match)");
			const planAfter = readArchitecturePlan(cwd, "task-033-rebase")!;
			check(planAfter.phases.phaseA.status === "not_started", "5: phase reset to not_started on rebaseline");
			const planningAfter = readPlanningState(cwd, "wp5-room").state!;
			check(planningAfter.invalidatedBy?.kind === "architecture_or_evidence", "5: planning-state invalidated (architecture_or_evidence)");
			check(planningAfter.states.implementation_confirmed === false, "5: implementation_confirmed cleared by the invalidation");
			check((rebase.details as any)?.rebaselined?.planningInvalidated === "wp5-room", "5: tool details report the planning invalidation");
		}
	} finally {
		for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
	}
}

main().then(() => {
	if (failures > 0) { console.error(`\n${failures} plan freeze smoke check(s) failed.`); process.exit(1); }
	console.log("\nAll TASK-033 plan freeze smoke checks passed.");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
