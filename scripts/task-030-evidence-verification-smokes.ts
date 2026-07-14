#!/usr/bin/env node
// TASK-030 (WP2) — verifiable coder evidence smokes (G7 report-matches-diff
// + G9 evidence re-run ported from agent-harness into the main workflow).
// Behavioral: every diff case runs against a REAL temporary git repository
// with snapshots captured around simulated coder edits, and every re-run
// case executes REAL allowlisted commands. The gate must:
//   - accept honest evidence (declared files == observed diff, commands
//     green on re-run);
//   - block an undeclared changed file and a declared-but-unchanged file
//     with `evidence_diff_mismatch`;
//   - block a claimed-passed command that fails on re-run with
//     `evidence_rerun_failed`;
//   - block a non-git delegate cwd with `diff_unverifiable` (fail-closed);
//   - block a non-allowlisted runnable-supporting command with
//     `evidence_rerun_unverifiable` (fail-closed);
//   - honor `evidence.rerun: "off"` and the bounded re-run command cap;
//   - see files committed mid-run (HEAD moved) in the observed diff.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	evaluateCoderPhaseAdvancement,
	runCompletionEvidenceGate,
	type CoderEvidenceVerificationContext,
} from "../extensions/workflow/delegate/completion-evidence-gate";
import type { CoderCompletionEvidence } from "../extensions/workflow/delegate/completion-evidence";
import {
	captureWorkspaceDiffSnapshot,
	commandMatchesAllowlist,
	computeObservedWorkspaceDiff,
	resolveEvidenceRerunPolicy,
	selectEvidenceRerunCommands,
	DEFAULT_EVIDENCE_RERUN_ALLOWLIST,
	EVIDENCE_RERUN_COMMAND_CAP,
	type ResolvedEvidenceRerunPolicy,
} from "../extensions/workflow/delegate/evidence-verification";
import type { AcceptanceEvidenceMatrixEntry, WorkflowArchitecturePlan } from "../extensions/workflow/architecture/types";
import type { DelegateRunResult, UsageStats } from "../extensions/workflow/types";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

const ZERO_USAGE: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
const CMD_OK = `node -e "process.exit(0)"`;
const CMD_FAIL = `node -e "process.exit(1)"`;

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeGitRepo(prefix: string): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "smoke@example.com");
	git(repo, "config", "user.name", "Smoke");
	fs.mkdirSync(path.join(repo, "src"), { recursive: true });
	fs.writeFileSync(path.join(repo, "src", "app.txt"), "base\n", "utf8");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "base");
	return repo;
}

function makePlan(commands: string[] = [CMD_OK]): WorkflowArchitecturePlan {
	const matrix: AcceptanceEvidenceMatrixEntry[] = [{
		criterion: "alpha-behavior",
		criterionKind: "runtime-behavior",
		businessRiskIfWrong: "alpha path may regress",
		enforcementLevel: ["behavior-test"],
		requiredEvidence: commands.map((command) => ({ kind: "behavior-test" as const, description: "alpha behavior test", command })),
		reviewerRoles: ["behavior"],
		blockingConditions: ["alpha behavior test fails"],
	}];
	return {
		planId: "task-030-evidence-verification",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "ready",
		businessPlan: "b", technicalPlan: "t", parallelAssessment: "serial", contractBlockPlan: "c",
		acceptanceCriteria: ["alpha-behavior"],
		acceptanceEvidenceMatrix: matrix,
		phases: {
			phaseA: { status: "review_approved", updatedAt: new Date().toISOString(), evidence: [] },
			phaseB: { status: "not_started", updatedAt: new Date().toISOString(), evidence: [] },
		},
	};
}

function makePacket(filesChanged: string[], commands: string[] = [CMD_OK]): CoderCompletionEvidence {
	return {
		filesChanged,
		commandsRun: commands.map((command) => ({ command, outcome: "passed" as const, exitCode: 0, summary: "claimed green" })),
		criterionCoverage: [{
			criterion: "alpha-behavior", evidenceKind: "behavior-test", strength: "sufficient",
			supportingFiles: filesChanged, supportingCommands: commands,
			summary: "alpha behavior verified by runnable command.",
		}],
		knownGaps: [], caveats: [],
		summary: "task-030 synthetic coder evidence",
		delegateHistory: {
			attempts: [{ attempt: 1, completionSource: "explicit", status: "completed" }],
			warnings: [], retries: 0,
			autoExitObserved: false, processExitObserved: false,
			missingSidecarObserved: false, freeFormOnlyObserved: false,
		},
	};
}

function makeResult(packet: CoderCompletionEvidence, cwd: string): DelegateRunResult {
	const result: DelegateRunResult = {
		agent: "coder", task: "task-030 coder work", cwd,
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

const REQUIRED_POLICY: ResolvedEvidenceRerunPolicy = { mode: "required", allowlist: [...DEFAULT_EVIDENCE_RERUN_ALLOWLIST] };

function makeVerification(repo: string, mutate: () => void, policy: ResolvedEvidenceRerunPolicy = REQUIRED_POLICY): CoderEvidenceVerificationContext {
	const snapshotBefore = captureWorkspaceDiffSnapshot(repo);
	mutate();
	const snapshotAfter = captureWorkspaceDiffSnapshot(repo);
	return { delegateCwd: repo, snapshotBefore, snapshotAfter, rerun: policy };
}

function main(): void {
	const cleanups: string[] = [];
	try {
		// (1) Honest evidence: declared file matches the observed diff, the
		//     supporting command re-runs green -> advance.
		{
			const repo = makeGitRepo("task-030-honest-");
			cleanups.push(repo);
			const verification = makeVerification(repo, () => {
				fs.writeFileSync(path.join(repo, "src", "app.txt"), "changed by coder\n", "utf8");
			});
			const packet = makePacket(["src/app.txt"]);
			const adv = evaluateCoderPhaseAdvancement(makePlan(), makeResult(packet, repo), {}, { verification });
			check(adv.kind === "advance", `1: honest evidence advances (got: ${adv.kind === "block" ? adv.reason : "advance"})`);
			if (adv.kind === "advance") {
				check(adv.evaluation.diagnostics.diffCheck?.verifiable === true, "1: diffCheck.verifiable true in diagnostics");
				check((adv.evaluation.diagnostics.commandReruns?.length ?? 0) === 1, `1: one command re-run recorded (got: ${adv.evaluation.diagnostics.commandReruns?.length ?? 0})`);
				check(adv.evaluation.diagnostics.commandReruns?.[0]?.exitCode === 0, "1: re-run exit code 0");
			}
		}

		// (2) Undeclared changed file -> evidence_diff_mismatch block.
		{
			const repo = makeGitRepo("task-030-undeclared-");
			cleanups.push(repo);
			const verification = makeVerification(repo, () => {
				fs.writeFileSync(path.join(repo, "src", "app.txt"), "declared change\n", "utf8");
				fs.writeFileSync(path.join(repo, "src", "sneaky.txt"), "undeclared change\n", "utf8");
			});
			const packet = makePacket(["src/app.txt"]);
			const adv = evaluateCoderPhaseAdvancement(makePlan(), makeResult(packet, repo), {}, { verification });
			check(adv.kind === "block", "2: undeclared changed file blocks");
			if (adv.kind === "block") {
				check(adv.rejectionCodes.includes("evidence_diff_mismatch"), `2: evidence_diff_mismatch reported (got: ${adv.rejectionCodes.join(",")})`);
				check((adv.reason ?? "").includes("src/sneaky.txt"), "2: rejection reason names the undeclared file");
				check(adv.evaluation.diagnostics.diffCheck?.undeclaredChangedFiles.includes("src/sneaky.txt") === true, "2: diagnostics list src/sneaky.txt as undeclared");
			}
		}

		// (3) Declared-but-unchanged file -> evidence_diff_mismatch block.
		{
			const repo = makeGitRepo("task-030-stale-decl-");
			cleanups.push(repo);
			const verification = makeVerification(repo, () => {
				fs.writeFileSync(path.join(repo, "src", "app.txt"), "only this changed\n", "utf8");
			});
			const packet = makePacket(["src/app.txt", "src/phantom.txt"]);
			const adv = evaluateCoderPhaseAdvancement(makePlan(), makeResult(packet, repo), {}, { verification });
			check(adv.kind === "block", "3: declared-but-unchanged file blocks");
			if (adv.kind === "block") {
				check(adv.rejectionCodes.includes("evidence_diff_mismatch"), `3: evidence_diff_mismatch reported (got: ${adv.rejectionCodes.join(",")})`);
				check(adv.evaluation.diagnostics.diffCheck?.declaredUnchangedFiles.includes("src/phantom.txt") === true, "3: diagnostics list src/phantom.txt as declared-but-unchanged");
			}
		}

		// (4) Claimed-passed command failing on re-run -> evidence_rerun_failed.
		{
			const repo = makeGitRepo("task-030-rerun-fail-");
			cleanups.push(repo);
			const verification = makeVerification(repo, () => {
				fs.writeFileSync(path.join(repo, "src", "app.txt"), "changed\n", "utf8");
			});
			const packet = makePacket(["src/app.txt"], [CMD_FAIL]);
			const adv = evaluateCoderPhaseAdvancement(makePlan([CMD_FAIL]), makeResult(packet, repo), {}, { verification });
			check(adv.kind === "block", "4: failing re-run blocks");
			if (adv.kind === "block") {
				check(adv.rejectionCodes.includes("evidence_rerun_failed"), `4: evidence_rerun_failed reported (got: ${adv.rejectionCodes.join(",")})`);
				check((adv.reason ?? "").includes("exited 1"), "4: rejection reason carries the re-run exit code");
			}
		}

		// (5) Non-git delegate cwd -> diff_unverifiable block (fail-closed).
		{
			const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-030-no-git-"));
			cleanups.push(plainDir);
			// A tmp dir is never inside a git worktree; both snapshots come back unavailable.
			const verification = makeVerification(plainDir, () => {
				fs.writeFileSync(path.join(plainDir, "app.txt"), "changed\n", "utf8");
			});
			check(verification.snapshotBefore.gitAvailable === false, "5: snapshot reports non-git cwd");
			const packet = makePacket(["app.txt"]);
			const adv = evaluateCoderPhaseAdvancement(makePlan(), makeResult(packet, plainDir), {}, { verification });
			check(adv.kind === "block", "5: non-git cwd blocks matrix-gated advancement");
			if (adv.kind === "block") {
				check(adv.rejectionCodes.includes("diff_unverifiable"), `5: diff_unverifiable reported (got: ${adv.rejectionCodes.join(",")})`);
			}
		}

		// (6) evidence.rerun: "off" skips the re-run (diff check stays on):
		//     a command that WOULD fail on re-run no longer blocks.
		{
			const repo = makeGitRepo("task-030-rerun-off-");
			cleanups.push(repo);
			const verification = makeVerification(repo, () => {
				fs.writeFileSync(path.join(repo, "src", "app.txt"), "changed\n", "utf8");
			}, { mode: "off", allowlist: [...DEFAULT_EVIDENCE_RERUN_ALLOWLIST] });
			const packet = makePacket(["src/app.txt"], [CMD_FAIL]);
			const adv = evaluateCoderPhaseAdvancement(makePlan([CMD_FAIL]), makeResult(packet, repo), {}, { verification });
			check(adv.kind === "advance", `6: rerun=off skips command re-run (got: ${adv.kind === "block" ? adv.reason : "advance"})`);
			if (adv.kind === "advance") {
				check(adv.evaluation.diagnostics.commandReruns === undefined, "6: no re-run outcomes recorded when rerun=off");
				check(adv.evaluation.diagnostics.diffCheck?.verifiable === true, "6: diff check still performed when rerun=off");
			}
		}

		// (7) Non-allowlisted runnable-supporting command -> fail-closed
		//     evidence_rerun_unverifiable (an exotic runner cannot dodge G9).
		{
			const repo = makeGitRepo("task-030-not-allowlisted-");
			cleanups.push(repo);
			const exotic = `bash -c "exit 0"`;
			const verification = makeVerification(repo, () => {
				fs.writeFileSync(path.join(repo, "src", "app.txt"), "changed\n", "utf8");
			});
			const packet = makePacket(["src/app.txt"], [exotic]);
			const adv = evaluateCoderPhaseAdvancement(makePlan([exotic]), makeResult(packet, repo), {}, { verification });
			check(adv.kind === "block", "7: non-allowlisted runnable command blocks");
			if (adv.kind === "block") {
				check(adv.rejectionCodes.includes("evidence_rerun_unverifiable"), `7: evidence_rerun_unverifiable reported (got: ${adv.rejectionCodes.join(",")})`);
				check((adv.reason ?? "").includes("rerunAllowlist"), "7: rejection reason points at evidence.rerunAllowlist");
			}
		}

		// (8) Bounded re-run: more allowlisted commands than the cap -> only
		//     EVIDENCE_RERUN_COMMAND_CAP execute; overflow is a warning skip,
		//     honest evidence still advances.
		{
			const repo = makeGitRepo("task-030-cap-");
			cleanups.push(repo);
			const commands = Array.from({ length: EVIDENCE_RERUN_COMMAND_CAP + 1 }, (_, i) => `node -e "process.exit(0) // ${i}"`);
			const verification = makeVerification(repo, () => {
				fs.writeFileSync(path.join(repo, "src", "app.txt"), "changed\n", "utf8");
			});
			const packet = makePacket(["src/app.txt"], commands);
			const adv = evaluateCoderPhaseAdvancement(makePlan(commands), makeResult(packet, repo), {}, { verification });
			check(adv.kind === "advance", `8: capped re-run still advances (got: ${adv.kind === "block" ? adv.reason : "advance"})`);
			if (adv.kind === "advance") {
				check((adv.evaluation.diagnostics.commandReruns?.length ?? 0) === EVIDENCE_RERUN_COMMAND_CAP, `8: exactly ${EVIDENCE_RERUN_COMMAND_CAP} commands re-ran (got: ${adv.evaluation.diagnostics.commandReruns?.length ?? 0})`);
				check(adv.evaluation.diagnostics.rerunSkipped?.some((s) => s.reason === "command_cap") === true, "8: overflow command recorded as command_cap skip");
			}
		}

		// (9) Commit mid-run: files committed between snapshots (HEAD moved)
		//     are still part of the observed diff.
		{
			const repo = makeGitRepo("task-030-commit-");
			cleanups.push(repo);
			const verification = makeVerification(repo, () => {
				fs.writeFileSync(path.join(repo, "src", "app.txt"), "committed change\n", "utf8");
				git(repo, "add", ".");
				git(repo, "commit", "-q", "-m", "coder committed mid-run");
			});
			const observed = computeObservedWorkspaceDiff(verification.snapshotBefore, verification.snapshotAfter, repo);
			check(observed.verifiable === true, "9: commit-crossing diff is verifiable");
			check(observed.changedFiles.includes("src/app.txt"), `9: committed file visible in observed diff (got: ${observed.changedFiles.join(",")})`);
			// Undeclared committed file must still block.
			const packet = makePacket([]);
			packet.filesChanged = [];
			const adv = evaluateCoderPhaseAdvancement(makePlan(), makeResult(packet, repo), {}, { verification });
			check(adv.kind === "block", "9: undeclared committed file blocks");
			if (adv.kind === "block") {
				check(adv.rejectionCodes.includes("evidence_diff_mismatch") || adv.rejectionCodes.includes("missing_files_changed"), `9: mismatch/missing-files reported (got: ${adv.rejectionCodes.join(",")})`);
			}
		}

		// (9b) Workflow runtime substrate written during the run
		//      (.pi/workflow-runs/...: sidecars, manifests, operator questions)
		//      is NOT part of the observed diff — no false mismatch.
		{
			const repo = makeGitRepo("task-030-substrate-");
			cleanups.push(repo);
			const verification = makeVerification(repo, () => {
				fs.writeFileSync(path.join(repo, "src", "app.txt"), "declared change\n", "utf8");
				fs.mkdirSync(path.join(repo, ".pi", "workflow-runs", "room-x"), { recursive: true });
				fs.writeFileSync(path.join(repo, ".pi", "workflow-runs", "room-x", "questions.jsonl"), `{"id":"q1","question":"?"}\n`, "utf8");
			});
			const packet = makePacket(["src/app.txt"]);
			const adv = evaluateCoderPhaseAdvancement(makePlan(), makeResult(packet, repo), {}, { verification });
			check(adv.kind === "advance", `9b: .pi/workflow-runs substrate excluded from observed diff (got: ${adv.kind === "block" ? adv.reason : "advance"})`);
		}

		// (10) Non-matrix-gated draft plan: gate remains a no-op without verification.
		{
			const repo = makeGitRepo("task-030-draft-");
			cleanups.push(repo);
			const draft = makePlan();
			draft.status = "draft";
			const packet = makePacket(["src/app.txt"]);
			const gate = runCompletionEvidenceGate(draft, makeResult(packet, repo));
			check(gate.ok === true, "10: draft plan gate stays a no-op");
			check(gate.evaluation.isMatrixGated === false, "10: draft plan is not matrix-gated");
		}

		// (11) Pure helpers: policy defaults + allowlist word-boundary match +
		//      selection filtering.
		{
			const policy = resolveEvidenceRerunPolicy(undefined);
			check(policy.mode === "required", "11: default rerun mode is required");
			check(policy.allowlist.join("|") === DEFAULT_EVIDENCE_RERUN_ALLOWLIST.join("|"), "11: default allowlist matches DEFAULT_EVIDENCE_RERUN_ALLOWLIST");
			const off = resolveEvidenceRerunPolicy({ evidence: { rerun: "off", rerunAllowlist: ["python"] } });
			check(off.mode === "off" && off.allowlist.join("|") === "python", "11: configured mode/allowlist override defaults");
			check(commandMatchesAllowlist("node -e \"1\"", ["node"]), "11: 'node -e' matches 'node' prefix");
			check(commandMatchesAllowlist("node", ["node"]), "11: bare 'node' matches");
			check(!commandMatchesAllowlist("node_modules/.bin/evil", ["node"]), "11: 'node_modules/...' does NOT match 'node'");
			check(!commandMatchesAllowlist("nodex --version", ["node"]), "11: 'nodex' does NOT match 'node'");
			const selection = selectEvidenceRerunCommands(
				{ status: "ready", acceptanceEvidenceMatrix: makePlan().acceptanceEvidenceMatrix },
				makePacket(["src/app.txt"], [CMD_OK, "python run.py"]),
				["node"],
			);
			check(selection.selected.length === 1 && selection.selected[0] === CMD_OK, "11: selection keeps the allowlisted passed command");
			check(selection.skipped.some((s) => s.command === "python run.py" && s.reason === "not_allowlisted"), "11: selection records the non-allowlisted skip");
		}
	} finally {
		for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
	}
}

main();
if (failures > 0) { console.error(`\n${failures} evidence verification smoke check(s) failed.`); process.exit(1); }
console.log("\nAll TASK-030 verifiable coder evidence smoke checks passed.");
