#!/usr/bin/env node
// TASK-011 Phase B integration smokes: tool registration, slash command, prompt
// strings, doc references, and default-deny remote-action wiring. This file
// complements (does NOT replace) the Phase A smoke at scripts/task-011-three-
// lane-afk-smokes.ts; both must stay green.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ALL_AUTOMATION_LANES,
	ALL_DEBUG_NEXT_LANES,
	ALL_HOTFIX_KINDS,
} from "../extensions/sprint/lane-policy";
import {
	createInitialShipState,
	shipStateExists,
	writeShipReport,
	writeShipState,
} from "../extensions/sprint/ship-state";
import { transitionShipState } from "../extensions/sprint/ship-engine";
import { renderShipReport } from "../extensions/sprint/ship-report";
import { buildAfkShipKickoff } from "../extensions/sprint/prompt";
import { _internal as shipToolsInternal, registerSprintShipTools } from "../extensions/sprint/ship-tools";

let failures = 0;
function check(cond: boolean, msg: string): void {
	if (cond) { console.log(`PASS: ${msg}`); return; }
	failures += 1;
	console.error(`FAIL: ${msg}`);
}
function withTemp<T>(name: string, fn: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `task-011b-${name}-`));
	try { return fn(cwd); }
	finally { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// ----- 1) tool registration surface -----------------------------------------

type RegisteredTool = { name: string; description: string; promptGuidelines?: string[]; parameters?: unknown };
type ToolHost = { registeredTools: RegisteredTool[]; registerTool: (tool: RegisteredTool) => void };
function makeFakePi(): ToolHost {
	const registeredTools: RegisteredTool[] = [];
	return {
		registeredTools,
		registerTool: (tool) => { registeredTools.push(tool); },
	};
}

function main(): void {
	const pi = makeFakePi();
	registerSprintShipTools(pi as any);
	const names = pi.registeredTools.map((t) => t.name);
	check(names.includes("sprint_classify_lane"), "B-1a) sprint_ship registration includes sprint_classify_lane");
	check(names.includes("sprint_ship"), "B-1b) sprint_ship registration includes sprint_ship tool");
	const classifier = pi.registeredTools.find((t) => t.name === "sprint_classify_lane");
	const supervisor = pi.registeredTools.find((t) => t.name === "sprint_ship");
	check(Boolean(classifier), "B-1c) sprint_classify_lane registration present");
	check(Boolean(supervisor), "B-1d) sprint_ship registration present");
	const allClassifierText = `${classifier?.description ?? ""}\n${(classifier?.promptGuidelines ?? []).join("\n")}`;
	const allSupervisorText = `${supervisor?.description ?? ""}\n${(supervisor?.promptGuidelines ?? []).join("\n")}`;
	for (const lane of ALL_AUTOMATION_LANES) {
		check(allClassifierText.includes(lane), `B-1e) sprint_classify_lane description mentions lane "${lane}"`);
	}
	for (const next of ALL_DEBUG_NEXT_LANES) {
		check(allClassifierText.includes(next), `B-1f) sprint_classify_lane description mentions debug next lane "${next}"`);
	}
	for (const kind of ALL_HOTFIX_KINDS) {
		check(allClassifierText.includes(kind), `B-1g) sprint_classify_lane description mentions hotfix kind "${kind}"`);
	}
	check(allSupervisorText.includes("full-sprint") && allSupervisorText.includes("hotfix") && allSupervisorText.includes("debug"), "B-1h) sprint_ship description exposes all three lanes");
	check(allSupervisorText.includes("push") && allSupervisorText.includes("PR") && allSupervisorText.includes("deploy"), "B-1i) sprint_ship description explicitly mentions push/PR/deploy denial");
	check(allSupervisorText.includes("implementation") || allSupervisorText.includes("PRD"), "B-1j) sprint_ship description references full-sprint PRD/implementation gate");

	// ----- 2) classifier input validation ---------------------------------------
	const validClassifierInput = shipToolsInternal.buildLanePolicyInput({
		lane: "hotfix",
		hotfixKind: "code-changing",
		scopeStatement: "x",
		changedFiles: ["a.ts"],
	});
	check(validClassifierInput.lane === "hotfix" && validClassifierInput.hotfixKind === "code-changing", "B-2a) buildLanePolicyInput preserves lane/hotfixKind");
	const fullSprintInput = shipToolsInternal.buildLanePolicyInput({
		lane: "full-sprint",
		confirmations: { prdReady: true, sprintAuthorized: true, architectureApproved: true, implementationConfirmed: true },
	});
	check(fullSprintInput.lane === "full-sprint" && fullSprintInput.hotfixKind === undefined, "B-2b) buildLanePolicyInput for full-sprint lane has no hotfixKind");
	const debugInput = shipToolsInternal.buildLanePolicyInput({
		lane: "debug",
		diagnosis: "x",
		recommendedNextLane: "hotfix",
		affectedFiles: ["a.ts"],
		riskAssessment: "low",
	});
	check(debugInput.lane === "debug" && debugInput.recommendedNextLane === "hotfix", "B-2c) buildLanePolicyInput for debug lane preserves diagnosis/rec");
	const generated = shipToolsInternal.generateRunId("TASK-001");
	check(/^afk-TASK-001-/.test(generated), "B-2d) generateRunId prefixes afk-<task>- for TASK-001");

	// ----- 3) ShipEvent guard ----------------------------------------------------
	check(shipToolsInternal.isShipEvent({ kind: "implement_started" }), "B-3a) isShipEvent accepts implement_started");
	check(shipToolsInternal.isShipEvent({ kind: "coder_completed", changedFiles: [], evidenceRefs: [], checks: [] }), "B-3b) isShipEvent accepts coder_completed");
	check(shipToolsInternal.isShipEvent({ kind: "reviewer_approved", at: "2025-01-01T00:00:00.000Z" }), "B-3c) isShipEvent accepts reviewer_approved");
	check(shipToolsInternal.isShipEvent({ kind: "finalization_recorded", finalizationSummary: "x", finalizationResult: "passed", qualityAuditSummary: "x", qualityAuditArtifact: "x" }), "B-3d) isShipEvent accepts finalization_recorded");
	check(!shipToolsInternal.isShipEvent({ kind: "make_coffee" }), "B-3e) isShipEvent rejects unknown kinds");
	check(!shipToolsInternal.isShipEvent(null), "B-3f) isShipEvent rejects null");
	check(!shipToolsInternal.isShipEvent({}), "B-3g) isShipEvent rejects empty object");

	// ----- 3.5) sprint_ship parameter schema: `event` is optional for start/read/report
	const supervisorParams = supervisor?.parameters as { required?: unknown; properties?: Record<string, unknown> } | undefined;
	const requiredKeys = Array.isArray(supervisorParams?.required) ? supervisorParams!.required as unknown[] : [];
	check(!requiredKeys.includes("event") && Boolean(supervisorParams?.properties?.event), "B-3h) sprint_ship parameters: 'event' is NOT in the required keys list (optional for start/read/report) and the property still exists in the schema");

	// ----- 4) sprint_ship hotfix/debug start writes state+report ---------------
	withTemp("ship-hotfix-start", (cwd) => {
		const id = "afk-T011-b-hotfix-1";
		const state = createInitialShipState({ runId: id, taskId: "TASK-011", lane: "hotfix", hotfixKind: "code-changing", retryBudget: 2, allowedScope: "tighten one guard" });
		const persisted = writeShipState(cwd, state);
		const final = writeShipReport(cwd, persisted, { render: (s) => renderShipReport(s, { workspaceName: "test" }) });
		check(shipStateExists(cwd, id), "B-4a) hotfix AFK start creates state under .pi/workflow-runs/afk-ship/<runId>/state.json");
		check(fs.existsSync(shipToolsInternal.shipReportPath(cwd, id)), "B-4b) hotfix AFK start writes REPORT.md at the canonical path");
		check(final.finalReportPath === `.pi/workflow-runs/afk-ship/${id}/REPORT.md`, "B-4c) hotfix AFK start pins finalReportPath to repo-relative path");
		check(final.lane === "hotfix" && final.hotfixKind === "code-changing" && final.reviewerRequired === true, "B-4d) hotfix AFK start keeps lane/hotfixKind/reviewerRequired");
	});
	withTemp("ship-debug-start", (cwd) => {
		const id = "afk-T011-b-debug-1";
		const state = createInitialShipState({ runId: id, lane: "debug", diagnosis: "race in apply", rootCauseHypothesis: "missing null guard", affectedFiles: ["src/dispatcher.ts"], riskAssessment: "narrow", recommendedNextLane: "hotfix" });
		const persisted = writeShipState(cwd, state);
		const final = writeShipReport(cwd, persisted, { render: (s) => renderShipReport(s, { workspaceName: "test" }) });
		check(shipStateExists(cwd, id), "B-5a) debug AFK start creates state under .pi/workflow-runs/afk-ship/<runId>/state.json");
		check(final.lane === "debug" && final.diagnosis === "race in apply", "B-5b) debug AFK start preserves diagnosis");
		check(final.recommendedNextLane === "hotfix", "B-5c) debug AFK start preserves recommendedNextLane");
	});

	// ----- 6) AFK kickoff builder contains required safety strings --------------
	const kickoff = buildAfkShipKickoff({
		runId: "afk-TASK-011-b",
		lane: "full-sprint",
		taskId: "TASK-011",
		retryBudget: 3,
		reportPath: ".pi/workflow-runs/afk-ship/afk-TASK-011-b/REPORT.md",
		statePath: ".pi/workflow-runs/afk-ship/afk-TASK-011-b/state.json",
	});
	check(kickoff.includes("AFK ship supervisor session bound"), "B-6a) buildAfkShipKickoff prefixes AFK bound banner");
	check(kickoff.includes("afk-TASK-011-b"), "B-6b) buildAfkShipKickoff embeds runId");
	check(kickoff.includes(".pi/workflow-runs/afk-ship/afk-TASK-011-b/state.json"), "B-6c) buildAfkShipKickoff embeds statePath");
	check(kickoff.includes("REPORT.md"), "B-6d) buildAfkShipKickoff embeds report path");
	check(/local-only/i.test(kickoff), "B-6e) buildAfkShipKickoff states local-only MVP");
	check(/push|pr|deploy|publish|credentialed/i.test(kickoff), "B-6f) buildAfkShipKickoff mentions default-deny remote actions");
	check(/auto-run/i.test(kickoff), "B-6g) buildAfkShipKickoff distinguishes AFK from --auto-run");
	check(/PRD|sprint|architecture|implementation|confirmations/i.test(kickoff), "B-6h) buildAfkShipKickoff states full-sprint gate preservation");
	const hotfixKickoff = buildAfkShipKickoff({
		runId: "afk-T011-hf",
		lane: "hotfix",
		hotfixKind: "text-evidence-only",
		taskId: "TASK-011",
		retryBudget: 3,
		reportPath: ".pi/workflow-runs/afk-ship/afk-T011-hf/REPORT.md",
		statePath: ".pi/workflow-runs/afk-ship/afk-T011-hf/state.json",
	});
	check(hotfixKickoff.includes("hotfix") && hotfixKickoff.includes("text-evidence-only"), "B-6i) buildAfkShipKickoff for hotfix mentions hotfix/text-evidence-only");
	check(hotfixKickoff.includes("debug") && hotfixKickoff.includes("diagnose"), "B-6j) buildAfkShipKickoff references debug audit-first behavior");

	// ----- 7) default-deny + remote-action wiring (no shell-out) ---------------
	const supervisorDesc = allSupervisorText;
	check(/no.*push|no.*PR|no.*deploy/i.test(supervisorDesc) || /default permissions deny push, pr, deploy/i.test(supervisorDesc), "B-7a) sprint_ship description states default-deny push/pr/deploy");
	check(/never shells out|do NOT shell out/i.test(supervisorDesc) || /local-only/i.test(supervisorDesc), "B-7b) sprint_ship description reaffirms no remote shell-out");
	check(/authorization|authorized/i.test(supervisorDesc), "B-7c) sprint_ship description references authorization");

	// ----- 8) documentation coverage -------------------------------------------
	const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
	const docs = fs.readFileSync(path.join(process.cwd(), "docs/workflow-config-v2.md"), "utf8");
	check(readme.includes("sprint_classify_lane"), "B-8a) README mentions sprint_classify_lane tool");
	check(readme.includes("sprint_ship"), "B-8b) README mentions sprint_ship tool");
	check(readme.includes("/sprint task ship"), "B-8c) README mentions /sprint task ship slash command");
	check(/full[- ]sprint/i.test(readme), "B-8d) README mentions full sprint");
	check(/hotfix/i.test(readme), "B-8e) README mentions hotfix");
	check(/debug/i.test(readme), "B-8f) README mentions debug");
	check(/AFK/i.test(readme), "B-8g) README mentions AFK");
	check(/--auto-run/i.test(readme), "B-8h) README mentions --auto-run");
	check(/evidence-only/i.test(readme), "B-8i) README mentions evidence-only");
	check(/push/i.test(readme) && /PR/i.test(readme) && /deploy/i.test(readme), "B-8j) README mentions push/PR/deploy");
	check(docs.includes("sprint_classify_lane") || /sprint_classify_lane/.test(docs), "B-8k) docs/workflow-config-v2.md mentions sprint_classify_lane");
	check(/AFK|afk-ship|sprint_ship/i.test(docs), "B-8l) docs/workflow-config-v2.md mentions AFK/sprint_ship");
	check(/push|PR|deploy|default-deny/i.test(docs), "B-8m) docs/workflow-config-v2.md mentions default-deny remote actions");

	// ----- 9) Command help text strings ----------------------------------------
	const commandText = fs.readFileSync(path.join(process.cwd(), "extensions/sprint/command.ts"), "utf8");
	check(commandText.includes("/sprint task ship"), "B-9a) command.ts includes /sprint task ship");
	check(commandText.includes("--afk"), "B-9b) command.ts includes --afk");
	check(commandText.includes("--lane"), "B-9c) command.ts includes --lane");
	check(commandText.includes("--hotfix-kind"), "B-9d) command.ts includes --hotfix-kind");
	check(commandText.includes("--scope"), "B-9e) command.ts includes --scope");
	check(commandText.includes("AFK"), "B-9f) command.ts includes AFK");
	check(commandText.includes("full-sprint|hotfix|debug"), "B-9g) command.ts exposes all three lanes in help");
	check(commandText.includes("evidence-only"), "B-9h) command.ts mentions evidence-only");
	check(commandText.includes("push") || commandText.includes("PR") || commandText.includes("deploy"), "B-9i) command.ts mentions default-deny remote actions");

	// ----- 10) No remote shell-out in default paths ----------------------------
	// Safety/default-deny documentation strings (e.g. mentions of "git push" or
	// "gh pr" in tool descriptions or safety text) are allowed and required. The
	// blocker here is actual shell execution or import of child_process APIs in
	// the default path. We also assert that the `sprint_ship` AI tool does not
	// call into `exec`/`execFile`/`spawn` (or the `node:child_process` module).
	const sprintDir = path.join(process.cwd(), "extensions/sprint");
	const scriptsDir = path.join(process.cwd(), "scripts");
	const shipToolsText = fs.readFileSync(path.join(sprintDir, "ship-tools.ts"), "utf8");
	const commandTextText = fs.readFileSync(path.join(sprintDir, "command.ts"), "utf8");
	const promptText = fs.readFileSync(path.join(sprintDir, "prompt.ts"), "utf8");
	const childProcessRe = /\b(exec|execFile|execSync|execFileSync|spawn|spawnSync)\s*\(/;
	const childImportRe = /(from\s+["']node:child_process["']|require\(\s*["']child_process["']\s*\))/;
	check(!childProcessRe.test(shipToolsText) && !childImportRe.test(shipToolsText), "B-10a) ship-tools.ts does not import or call child_process shell APIs");
	check(!childProcessRe.test(commandTextText) && !childImportRe.test(commandTextText), "B-10b) command.ts does not import or call child_process shell APIs");
	check(!childProcessRe.test(promptText) && !childImportRe.test(promptText), "B-10c) prompt.ts does not import or call child_process shell APIs");
	// Every task-011 smoke under scripts/ must also avoid child_process shell execution in the default path.
	for (const file of fs.readdirSync(scriptsDir)) {
		if (!file.startsWith("task-011") || !file.endsWith(".ts")) continue;
		const text = fs.readFileSync(path.join(scriptsDir, file), "utf8");
		check(!childProcessRe.test(text) && !childImportRe.test(text), `B-10d) scripts/${file} does not import or call child_process shell APIs`);
	}
	// Safety documentation text (e.g. "git push", "gh pr") is explicitly allowed in the tool descriptions
	// and in the README/docs default-deny safety section. We do not assert the absence of those strings.
	check(/no.*push|no.*PR|no.*deploy|default-deny/i.test(shipToolsText), "B-10e) ship-tools.ts keeps default-deny safety strings");

	// ----- 11) Reviewer-required implementation-evidence gate (B-fix) ----------
	// Reviewer-required lanes (full-sprint or code-changing hotfix) must have
	// concrete implementation evidence on durable state (changedFiles +
	// evidenceRefs + >=1 passed check + 0 failed checks) before either
	// `reviewer_approved` or `finalization_recorded` can advance. This blocks
	// a fabricated `reviewerOutcome: approved` from reaching `delivery_complete`
	// without prior coder/focused-fix/evidence work.
	const rrie = "reviewer-required-implementation-evidence-missing";
	withTemp("rrie-hotfix-fresh-reviewer-approved", (cwd) => {
		const init = writeShipState(cwd, createInitialShipState({ runId: "afk-rrie-hf-fresh-1", lane: "hotfix", hotfixKind: "code-changing" }));
		// No implement_started / coder_completed / focused_fix_completed / evidence_collected at all.
		const t = transitionShipState(init, { kind: "reviewer_approved", at: "2026-06-12T00:00:00.000Z", notes: "lgtm" });
		check(t.toStage === "blocked" && t.stopCondition === rrie, "B-11a) fresh code-changing hotfix + reviewer_approved blocks with reviewer-required-implementation-evidence-missing (does NOT advance to finalizing)");
		check(t.state.blockers.some((b) => b.includes("changedFiles") || b.includes("changedFiles")), "B-11a-evidence) blocker text references missing implementation evidence");
	});
	withTemp("rrie-hotfix-fabricated-outcome-finalize", (cwd) => {
		const init = writeShipState(cwd, createInitialShipState({ runId: "afk-rrie-hf-fab-1", lane: "hotfix", hotfixKind: "code-changing" }));
		// Simulate a fabricated state: reviewerOutcome=approved, but NO actual coder/focused-fix/evidence work happened (changedFiles/evidenceRefs/checks all empty).
		const fabricated = { ...init, reviewerOutcome: { kind: "approved", at: "2026-06-12T00:00:00.000Z", notes: "fabricated" } as typeof init.reviewerOutcome };
		const t = transitionShipState(fabricated, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "passed", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(t.toStage === "blocked" && t.state.finalizationStatus === "blocked", "B-11b) code-changing hotfix with fabricated reviewerOutcome:approved but empty changedFiles/evidenceRefs/checks: finalization_recorded blocks delivery_complete");
		check(t.state.blockers.some((b) => b.includes("changedFiles") || b.includes("evidenceRefs") || b.includes("passed check") || b.includes("failed checks")), "B-11b-evidence) blocker text surfaces the missing-evidence reason even when reviewerOutcome=approved is injected");
	});
	withTemp("rrie-fullsprint-fabricated-outcome-finalize", (cwd) => {
		const init = writeShipState(cwd, createInitialShipState({ runId: "afk-rrie-fs-fab-1", lane: "full-sprint", fullSprintGatesConfirmed: true }));
		// fullSprintGatesConfirmed=true removes the full-sprint-gates-not-confirmed blocker; the only remaining gate must be implementation evidence.
		const fabricated = { ...init, reviewerOutcome: { kind: "approved", at: "2026-06-12T00:00:00.000Z", notes: "fabricated" } as typeof init.reviewerOutcome };
		const t = transitionShipState(fabricated, { kind: "finalization_recorded", finalizationSummary: "ok", finalizationResult: "passed", qualityAuditSummary: "ok", qualityAuditArtifact: "x.json" });
		check(t.toStage === "blocked" && t.state.finalizationStatus === "blocked", "B-11c) confirmed full-sprint with fabricated reviewerOutcome:approved but empty changedFiles/evidenceRefs/checks: finalization_recorded blocks delivery_complete");
		check(t.state.blockers.some((b) => b.includes("changedFiles") || b.includes("evidenceRefs") || b.includes("passed check") || b.includes("failed checks")), "B-11c-evidence) full-sprint blocker text surfaces the missing-evidence reason");
		check(!t.state.blockers.some((b) => b.includes("full-sprint-gates-not-confirmed")), "B-11c-gate-ok) full-sprint-gates-not-confirmed is NOT in blockers when fullSprintGatesConfirmed=true");
	});

	if (failures > 0) {
		console.error(`task-011 phase B integration smoke failed: ${failures}`);
		process.exitCode = 1;
		return;
	}
	console.log("task-011 phase B integration smoke checks passed");
}
main();
