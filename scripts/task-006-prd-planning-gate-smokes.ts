#!/usr/bin/env node
// TASK-006 Phase A — PRD-first planning state helper synthetic behavior smokes.
// Pure unit smokes for the planning-state module; every check uses temp dirs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	PLANNING_STATE_NAMES, SCOPE_CLASSIFICATIONS, STAGE_CONFIRMATIONS,
	PlanningStateRecord, ScopeClassification,
	classifyPlanningApproval, classifyTinyDebugBypass, createPlanningState,
	evaluateImplementationGate, evaluateSprintPlanningGate, invalidatePlanningState,
	isExplicitStageConfirmation, isGenericPlanningApproval, isNonTrivialScope,
	isTinyDebugScope, planningStatePathsFor, readPlanningState, setScopeClassification,
	setStateFlag, setStateFlags, stateFileExists, writePlanningState,
} from "../extensions/workflow/planning-state";

let failures = 0;
const check = (cond: boolean, msg: string): void => {
	if (cond) { console.log(`PASS: ${msg}`); return; }
	failures += 1; console.error(`FAIL: ${msg}`);
};
const checkAll = (group: string, cases: ReadonlyArray<readonly [boolean, string]>): void => {
	for (const [c, label] of cases) check(!!c, `${group}: ${label}`);
};
const META = { actor: "test", source: "smoke", evidence: "synthetic test fixture" };
const freshRoom = (): { cwd: string; roomId: string; cleanup: () => void } => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-006-planning-"));
	const roomId = `room-${Math.random().toString(36).slice(2, 10)}`;
	fs.mkdirSync(path.join(cwd, ".pi", "workflow-runs", roomId), { recursive: true });
	return { cwd, roomId, cleanup: () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ } } };
};
const withRoom = (scope: ScopeClassification, taskId: string, fn: (cwd: string, roomId: string) => void): void => {
	const r = freshRoom();
	try { createPlanningState({ cwd: r.cwd, roomId: r.roomId, scopeClassification: scope, taskId }); fn(r.cwd, r.roomId); }
	finally { r.cleanup(); }
};
const setAllFlags = (cwd: string, roomId: string): void => {
	setStateFlags(cwd, roomId, PLANNING_STATE_NAMES.map((name) => ({ name, value: true, meta: META })));
};
const buildRecord = (overrides: Partial<PlanningStateRecord> = {}): PlanningStateRecord => ({
	version: 1, roomId: "room-x", scopeClassification: "non_trivial", materialVersion: "room-x-v1",
	artifactPaths: { prd: ".pi/workflow-runs/room-x/PRD.md", memo: ".pi/workflow-runs/room-x/memo.md" },
	states: { prd_started: false, prd_ready_for_sprint: false, sprint_confirmed: false, implementation_confirmed: false },
	transitions: [], invalidatedBy: null, updatedAt: new Date().toISOString(), ...overrides,
});

function main(): void {
	// 0) Exports sanity.
	checkAll("0", [
		[PLANNING_STATE_NAMES.length === 4, "PLANNING_STATE_NAMES exports four flag names"],
		[PLANNING_STATE_NAMES.includes("prd_started"), "prd_started flag exported"],
		[PLANNING_STATE_NAMES.includes("prd_ready_for_sprint"), "prd_ready_for_sprint flag exported"],
		[PLANNING_STATE_NAMES.includes("sprint_confirmed"), "sprint_confirmed flag exported"],
		[PLANNING_STATE_NAMES.includes("implementation_confirmed"), "implementation_confirmed flag exported"],
		[SCOPE_CLASSIFICATIONS.length === 3, "SCOPE_CLASSIFICATIONS has three classifications"],
		[SCOPE_CLASSIFICATIONS.includes("tiny_debug"), "tiny_debug scope exported"],
		[SCOPE_CLASSIFICATIONS.includes("non_trivial"), "non_trivial scope exported"],
		[SCOPE_CLASSIFICATIONS.includes("expanded_from_tiny"), "expanded_from_tiny scope exported"],
		[STAGE_CONFIRMATIONS.includes("sprint") && STAGE_CONFIRMATIONS.includes("implementation"), "sprint/implementation stage confirmations exported"],
		[typeof isTinyDebugScope === "function", "isTinyDebugScope exported"],
		[typeof isNonTrivialScope === "function", "isNonTrivialScope exported"],
	]);

	// 1) Missing state file blocks both gates.
	const r1 = freshRoom();
	try {
		const sr = readPlanningState(r1.cwd, r1.roomId);
		checkAll("1", [
			[sr.state === null, "read returns null when state file is missing"],
			[sr.issue?.code === "state_file_missing", "read issue code is state_file_missing"],
			[!stateFileExists(r1.cwd, r1.roomId), "stateFileExists is false before write"],
		]);
		const sprint = evaluateSprintPlanningGate(sr.state);
		const impl = evaluateImplementationGate(sr.state);
		checkAll("1", [
			[!sprint.allowed && !sprint.ok, "sprint gate blocks when state is missing"],
			[sprint.codes.includes("state_missing"), "sprint gate includes state_missing code"],
			[sprint.missing.length === PLANNING_STATE_NAMES.length, "sprint gate reports all flags missing"],
			[/sprint planning gate is blocked: durable planning state is missing/i.test(sprint.summary), "sprint summary names missing state file"],
			[!impl.allowed && !impl.ok, "implementation gate blocks when state is missing"],
			[impl.codes.includes("state_missing"), "implementation gate includes state_missing code"],
			[impl.missing.length === PLANNING_STATE_NAMES.length, "implementation gate reports all flags missing"],
			[/implementation gate is blocked: durable planning state is missing/i.test(impl.summary), "implementation summary names missing state file"],
		]);
	} finally { r1.cleanup(); }

	// 2) Generic `approved` does NOT set sprint or implementation confirmation.
	checkAll("2", [
		[isGenericPlanningApproval("approved"), "'approved' is generic"],
		[isGenericPlanningApproval("yes"), "'yes' is generic"],
		[isGenericPlanningApproval("ok"), "'ok' is generic"],
		[isGenericPlanningApproval("lgtm"), "'lgtm' is generic"],
		[isGenericPlanningApproval("Looks good."), "'Looks good.' is generic"],
		[!isGenericPlanningApproval("plan the sprint please"), "'plan the sprint please' is not generic"],
		[!isGenericPlanningApproval(""), "empty string is not generic"],
	]);
	{
		const a = classifyPlanningApproval("approved");
		checkAll("2", [
			[a.isGenericPositive, "classifier marks 'approved' as generic positive"],
			[a.mentionedStages.length === 0, "'approved' mentions no stage"],
			[a.explicitStageConfirmation === null, "'approved' is not an explicit stage confirmation"],
			[!isExplicitStageConfirmation("approved", "sprint"), "isExplicitStageConfirmation rejects 'approved' for sprint"],
			[!isExplicitStageConfirmation("approved", "implementation"), "isExplicitStageConfirmation rejects 'approved' for implementation"],
		]);
		const i = classifyPlanningApproval("approved — go ahead and start coding");
		const s = classifyPlanningApproval("approved — plan the sprint");
		checkAll("2", [
			[i.explicitStageConfirmation === "implementation", "stage-keyword approval is explicit implementation confirmation"],
			[s.explicitStageConfirmation === "sprint", "stage-keyword approval is explicit sprint confirmation"],
		]);
		// Negation must suppress explicit stage confirmation even when stage keywords are present.
		const n1 = classifyPlanningApproval("not approved — plan the sprint");
		const n2 = classifyPlanningApproval("do not go ahead and start coding");
		checkAll("2", [
			[n1.hasNegation, "'not approved — plan the sprint' is detected as negated"],
			[n1.mentionsStage, "'not approved — plan the sprint' still mentions sprint stage"],
			[n1.explicitStageConfirmation === null, "negated stage-keyword approval is NOT explicit sprint confirmation"],
			[!isExplicitStageConfirmation("not approved — plan the sprint", "sprint"), "isExplicitStageConfirmation rejects negated 'plan the sprint'"],
			[n2.hasNegation, "'do not go ahead and start coding' is detected as negated"],
			[n2.mentionsStage, "'do not go ahead and start coding' still mentions implementation stage"],
			[n2.explicitStageConfirmation === null, "negated stage-keyword approval is NOT explicit implementation confirmation"],
			[!isExplicitStageConfirmation("do not go ahead and start coding", "implementation"), "isExplicitStageConfirmation rejects negated 'start coding'"],
		]);
	}
	withRoom("non_trivial", "TASK-X", (cwd, roomId) => {
		setStateFlags(cwd, roomId, [
			{ name: "prd_started", value: true, meta: META },
			{ name: "prd_ready_for_sprint", value: true, meta: META },
		]);
		const s = readPlanningState(cwd, roomId).state;
		const sprint = evaluateSprintPlanningGate(s);
		checkAll("2", [
			[s?.states.sprint_confirmed === false, "generic 'approved' alone does not set sprint_confirmed"],
			[s?.states.implementation_confirmed === false, "generic 'approved' alone does not set implementation_confirmed"],
			[!sprint.allowed, "sprint gate remains blocked after a generic approval"],
			[sprint.codes.includes("sprint_not_confirmed"), "sprint gate still flags sprint_not_confirmed"],
		]);
	});

	// 2b) Strong stage-keyword confirmations: 'confirm sprint creation' / 'authorize implementation' are explicit by themselves even when no generic positive word is present.
	{
		const cs = classifyPlanningApproval("confirm sprint creation");
		const asprint = classifyPlanningApproval("authorize sprint creation");
		const ci = classifyPlanningApproval("confirm implementation");
		const ai = classifyPlanningApproval("authorize implementation");
		const cdc = classifyPlanningApproval("confirm delegate to coder");
		const adc = classifyPlanningApproval("authorize delegate to coder");
		checkAll("2b", [
			[cs.explicitStageConfirmation === "sprint", "'confirm sprint creation' is an explicit sprint confirmation (no generic positive required)"],
			[asprint.explicitStageConfirmation === "sprint", "'authorize sprint creation' is an explicit sprint confirmation (no generic positive required)"],
			[ci.explicitStageConfirmation === "implementation", "'confirm implementation' is an explicit implementation confirmation (no generic positive required)"],
			[ai.explicitStageConfirmation === "implementation", "'authorize implementation' is an explicit implementation confirmation (no generic positive required)"],
			[cdc.explicitStageConfirmation === "implementation", "'confirm delegate to coder' is an explicit implementation confirmation (no generic positive required)"],
			[adc.explicitStageConfirmation === "implementation", "'authorize delegate to coder' is an explicit implementation confirmation (no generic positive required)"],
			[isExplicitStageConfirmation("confirm sprint creation", "sprint"), "isExplicitStageConfirmation('confirm sprint creation', 'sprint') is true"],
			[isExplicitStageConfirmation("authorize implementation", "implementation"), "isExplicitStageConfirmation('authorize implementation', 'implementation') is true"],
			[isExplicitStageConfirmation("Confirm Sprint Creation.", "sprint"), "strong phrase is case/insensitive and ignores trailing punctuation"],
		]);
	}

	// 2c) Word-boundary / negation safety: 'unconfirmed sprint', 'unauthorized implementation', and explicit 'do not confirm' must NOT be explicit.
	{
		const unconfSprint = classifyPlanningApproval("unconfirmed sprint");
		const unauthImpl = classifyPlanningApproval("unauthorized implementation");
		const unconfImpl = classifyPlanningApproval("unconfirmed — plan the implementation");
		const notConfSprint = classifyPlanningApproval("do not confirm sprint creation");
		const notAuthImpl = classifyPlanningApproval("please don't authorize implementation");
		checkAll("2c", [
			[unconfSprint.explicitStageConfirmation === null, "'unconfirmed sprint' is NOT an explicit sprint confirmation (word boundary)"],
			[!isExplicitStageConfirmation("unconfirmed sprint", "sprint"), "isExplicitStageConfirmation rejects 'unconfirmed sprint' for sprint"],
			[unauthImpl.explicitStageConfirmation === null, "'unauthorized implementation' is NOT an explicit implementation confirmation (word boundary)"],
			[!isExplicitStageConfirmation("unauthorized implementation", "implementation"), "isExplicitStageConfirmation rejects 'unauthorized implementation' for implementation"],
			[unconfImpl.explicitStageConfirmation === null, "'unconfirmed — plan the implementation' is NOT an explicit implementation confirmation"],
			[notConfSprint.explicitStageConfirmation === null, "'do not confirm sprint creation' is NOT an explicit sprint confirmation (negation)"],
			[notAuthImpl.explicitStageConfirmation === null, "'please don't authorize implementation' is NOT an explicit implementation confirmation (negation)"],
		]);
	}

	// 3) Explicit sprint confirmation allows sprint gate but blocks implementation.
	withRoom("non_trivial", "TASK-Y", (cwd, roomId) => {
		setStateFlags(cwd, roomId, [
			{ name: "prd_started", value: true, meta: META },
			{ name: "prd_ready_for_sprint", value: true, meta: META },
			{ name: "sprint_confirmed", value: true, meta: META },
		]);
		const sprint = evaluateSprintPlanningGate(readPlanningState(cwd, roomId).state);
		checkAll("3", [
			[sprint.allowed, "sprint gate passes"],
			[sprint.missing.length === 0, "sprint gate reports no missing flags"],
			[sprint.codes.length === 0, "sprint gate emits no blocking codes"],
		]);
		const impl = evaluateImplementationGate(readPlanningState(cwd, roomId).state);
		checkAll("3", [
			[!impl.allowed, "implementation gate still blocks when only sprint confirmed"],
			[impl.missing.includes("implementation_confirmed"), "implementation gate lists implementation_confirmed as missing"],
			[impl.codes.includes("implementation_not_confirmed"), "implementation gate emits implementation_not_confirmed code"],
		]);
	});

	// 4) Implementation confirmation after all four flags opens impl gate.
	withRoom("non_trivial", "TASK-Z", (cwd, roomId) => {
		setAllFlags(cwd, roomId);
		const impl = evaluateImplementationGate(readPlanningState(cwd, roomId).state);
		checkAll("4", [
			[impl.allowed, "implementation gate passes with all four flags set"],
			[impl.missing.length === 0, "implementation gate reports no missing flags"],
			[impl.codes.length === 0, "implementation gate emits no blocking codes"],
			[/all four confirmation flags are set/i.test(impl.summary), "implementation summary describes all-flags-set state"],
		]);
	});

	// 5) Tiny debug bypass passes both gates without PRD state.
	withRoom("tiny_debug", "DBG-TINY", (cwd, roomId) => {
		const s = readPlanningState(cwd, roomId).state;
		const bypass = classifyTinyDebugBypass(s, true);
		checkAll("5", [
			[s?.scopeClassification === "tiny_debug", "state is tiny_debug"],
			[!s?.states.prd_started, "tiny_debug state has prd_started=false"],
			[bypass.requested && bypass.allowed, "tiny_debug bypass is allowed for tiny_debug scope"],
		]);
		const sprint = evaluateSprintPlanningGate(s, { allowTinyDebugBypass: true });
		const impl = evaluateImplementationGate(s, { allowTinyDebugBypass: true });
		const implNoBypass = evaluateImplementationGate(s);
		checkAll("5", [
			[sprint.allowed, "sprint gate passes via tiny_debug bypass"],
			[sprint.codes.includes("tiny_debug_bypass"), "sprint gate emits tiny_debug_bypass code"],
			[impl.allowed, "implementation gate passes via tiny_debug bypass"],
			[impl.codes.includes("tiny_debug_bypass"), "implementation gate emits tiny_debug_bypass code"],
			[!implNoBypass.allowed, "implementation gate blocks tiny_debug when bypass not requested"],
			[implNoBypass.codes.includes("tiny_debug_bypass_disallowed"), "implementation gate emits tiny_debug_bypass_disallowed code"],
		]);
	});

	// 6) Expanded/promoted tiny debug is non-trivial and blocks without PRD/sprint state.
	withRoom("tiny_debug", "DBG-PROMOTE", (cwd, roomId) => {
		const tinyState = readPlanningState(cwd, roomId).state;
		checkAll("6", [
			[isTinyDebugScope(tinyState), "starts as tiny_debug scope"],
			[!isNonTrivialScope(tinyState), "tiny_debug is not non-trivial"],
		]);
		setScopeClassification(cwd, roomId, "non_trivial", META);
		const promoted = readPlanningState(cwd, roomId).state;
		checkAll("6", [
			[promoted?.scopeClassification === "non_trivial", "scope promoted to non_trivial"],
			[promoted?.invalidatedBy?.kind === "prd_or_scope", "invalidation kind is prd_or_scope"],
			[promoted?.states.sprint_confirmed === false, "sprint_confirmed cleared on promotion"],
			[promoted?.states.implementation_confirmed === false, "implementation_confirmed cleared on promotion"],
			[promoted?.states.prd_ready_for_sprint === false, "prd_ready_for_sprint cleared on promotion"],
		]);
		const sprint = evaluateSprintPlanningGate(promoted);
		checkAll("6", [
			[!sprint.allowed, "promoted non_trivial record blocks sprint gate"],
			[sprint.missing.includes("prd_started"), "promoted gate lists prd_started as missing"],
			[sprint.missing.includes("sprint_confirmed"), "promoted gate lists sprint_confirmed as missing"],
		]);
		const expanded = buildRecord({ scopeClassification: "expanded_from_tiny" });
		const expandedImpl = evaluateImplementationGate(expanded);
		checkAll("6", [
			[isNonTrivialScope(expanded), "expanded_from_tiny is treated as non-trivial"],
			[!expandedImpl.allowed, "expanded_from_tiny scope still blocks implementation gate"],
			[expandedImpl.missing.length === PLANNING_STATE_NAMES.length, "expanded_from_tiny reports all flags missing"],
		]);
	});
	// Promote tiny_debug with stale true flags to expanded_from_tiny must clear flags and re-block.
	withRoom("tiny_debug", "DBG-PROMOTE-EXP", (cwd, roomId) => {
		setAllFlags(cwd, roomId);
		const stale = readPlanningState(cwd, roomId).state;
		checkAll("6", [
			[stale?.states.sprint_confirmed === true, "stale tiny_debug has sprint_confirmed=true pre-promotion"],
			[stale?.states.implementation_confirmed === true, "stale tiny_debug has implementation_confirmed=true pre-promotion"],
			[stale?.states.prd_ready_for_sprint === true, "stale tiny_debug has prd_ready_for_sprint=true pre-promotion"],
		]);
		setScopeClassification(cwd, roomId, "expanded_from_tiny", META);
		const promotedExp = readPlanningState(cwd, roomId).state;
		checkAll("6", [
			[promotedExp?.scopeClassification === "expanded_from_tiny", "scope promoted to expanded_from_tiny"],
			[promotedExp?.invalidatedBy?.kind === "prd_or_scope", "expanded_from_tiny promotion invalidates with prd_or_scope"],
			[promotedExp?.states.prd_started === true, "prd_started preserved across expanded_from_tiny promotion"],
			[promotedExp?.states.prd_ready_for_sprint === false, "prd_ready_for_sprint cleared on expanded_from_tiny promotion"],
			[promotedExp?.states.sprint_confirmed === false, "sprint_confirmed cleared on expanded_from_tiny promotion"],
			[promotedExp?.states.implementation_confirmed === false, "implementation_confirmed cleared on expanded_from_tiny promotion"],
		]);
		const implAfter = evaluateImplementationGate(promotedExp);
		const sprintAfter = evaluateSprintPlanningGate(promotedExp);
		checkAll("6", [
			[!implAfter.allowed, "implementation gate blocks after expanded_from_tiny promotion"],
			[implAfter.missing.includes("implementation_confirmed"), "implementation gate lists implementation_confirmed missing post-expanded promotion"],
			[implAfter.missing.includes("sprint_confirmed"), "implementation gate lists sprint_confirmed missing post-expanded promotion"],
			[!sprintAfter.allowed, "sprint gate blocks after expanded_from_tiny promotion"],
		]);
	});

	// 7) Durable write/read round-trip preserves artifact paths and booleans.
	const r7 = freshRoom();
	try {
		const stateFile = path.join(r7.cwd, ".pi", "workflow-runs", r7.roomId, "planning-state.json");
		checkAll("7", [
			[!fs.existsSync(stateFile), "state file does not exist before createPlanningState"],
		]);
		const record = createPlanningState({
			cwd: r7.cwd, roomId: r7.roomId, scopeClassification: "non_trivial", taskId: "TASK-RT",
			materialVersion: "task-rt-v3",
			artifactPaths: { prd: ".pi/workflow-runs/rt/PRD.md", memo: ".pi/workflow-runs/rt/memo.md" },
		});
		checkAll("7", [
			[fs.existsSync(stateFile), "state file is written to disk after createPlanningState"],
			[stateFileExists(r7.cwd, r7.roomId), "stateFileExists returns true after createPlanningState"],
		]);
		const paths = planningStatePathsFor(r7.cwd, r7.roomId);
		checkAll("7", [
			[paths.stateFile === stateFile, "planningStatePathsFor resolves the same state file path"],
			[paths.prdFile.endsWith("PRD.md"), "planningStatePathsFor prdFile ends with PRD.md"],
			[paths.memoFile.endsWith("memo.md"), "planningStatePathsFor memoFile ends with memo.md"],
		]);
		setStateFlag(r7.cwd, r7.roomId, "prd_started", true, META);
		setStateFlag(r7.cwd, r7.roomId, "sprint_confirmed", true, META);
		const reloaded = readPlanningState(r7.cwd, r7.roomId).state;
		if (!reloaded) { check(false, "7: round-trip read returns a non-null state"); return; }
		const last = reloaded.transitions[reloaded.transitions.length - 1];
		checkAll("7", [
			[reloaded.materialVersion === "task-rt-v3", "materialVersion is preserved across writes"],
			[reloaded.artifactPaths.prd === ".pi/workflow-runs/rt/PRD.md", "artifact path prd is preserved"],
			[reloaded.artifactPaths.memo === ".pi/workflow-runs/rt/memo.md", "artifact path memo is preserved"],
			[reloaded.states.prd_started === true, "prd_started boolean is preserved"],
			[reloaded.states.sprint_confirmed === true, "sprint_confirmed boolean is preserved"],
			[reloaded.states.implementation_confirmed === false, "untouched flags remain false"],
			[reloaded.transitions.length >= 2, "at least two transitions are recorded"],
			[last.state === "sprint_confirmed", "last transition records the most recent flag"],
			[last.value === true, "last transition value matches the latest write"],
			[last.actor === "test", "transition actor is recorded"],
			[last.source === "smoke", "transition source is recorded"],
			[typeof last.at === "string" && last.at.length > 0, "transition at timestamp is recorded"],
		]);
		// Corrupt the JSON to verify the reader surfaces a clear issue.
		fs.writeFileSync(stateFile, "{ this is not json", "utf-8");
		const corrupt = readPlanningState(r7.cwd, r7.roomId);
		checkAll("7", [
			[corrupt.state === null, "corrupt state file returns null state"],
			[corrupt.issue?.code === "state_file_invalid_json", "corrupt state file surfaces state_file_invalid_json issue"],
		]);
		// writePlanningState round-trip: restore a valid record via the public writer.
		writePlanningState(r7.cwd, r7.roomId, record);
		const restored = readPlanningState(r7.cwd, r7.roomId).state;
		checkAll("7", [
			[restored?.roomId === record.roomId, "writePlanningState round-trips roomId"],
			[restored?.states.prd_started === false, "writePlanningState round-trips default flags"],
		]);
	} finally { r7.cleanup(); }

	// 8a) PRD/scope invalidation clears prd_ready_for_sprint, sprint_confirmed, implementation_confirmed.
	withRoom("non_trivial", "TASK-INV-A", (cwd, roomId) => {
		setAllFlags(cwd, roomId);
		const allSet = readPlanningState(cwd, roomId).state;
		checkAll("8a", [
			[allSet?.states.implementation_confirmed === true, "implementation_confirmed is true before invalidation"],
		]);
		const invalidated = invalidatePlanningState(cwd, roomId, { kind: "prd_or_scope", reason: "PRD scope changed", ...META });
		const cleared = invalidated.invalidatedBy?.clearedFlags ?? [];
		checkAll("8a", [
			[invalidated.states.prd_started === true, "prd_started preserved on prd_or_scope invalidation"],
			[invalidated.states.prd_ready_for_sprint === false, "prd_ready_for_sprint cleared"],
			[invalidated.states.sprint_confirmed === false, "sprint_confirmed cleared"],
			[invalidated.states.implementation_confirmed === false, "implementation_confirmed cleared"],
			[invalidated.invalidatedBy?.kind === "prd_or_scope", "invalidatedBy records prd_or_scope"],
			[cleared.includes("prd_ready_for_sprint"), "clearedFlags includes prd_ready_for_sprint"],
			[cleared.includes("sprint_confirmed"), "clearedFlags includes sprint_confirmed"],
			[cleared.includes("implementation_confirmed"), "clearedFlags includes implementation_confirmed"],
		]);
		const impl = evaluateImplementationGate(readPlanningState(cwd, roomId).state);
		checkAll("8a", [
			[!impl.allowed, "implementation gate re-blocks after prd_or_scope invalidation"],
			[impl.codes.includes("material_architecture_invalidation"), "implementation gate emits material_architecture_invalidation code"],
		]);
	});

	// 8b) Architecture/evidence invalidation clears only implementation_confirmed; gates must fail-closed.
	withRoom("non_trivial", "TASK-INV-B", (cwd, roomId) => {
		setAllFlags(cwd, roomId);
		const invalidated = invalidatePlanningState(cwd, roomId, { kind: "architecture_or_evidence", reason: "architecture evidence changed", ...META });
		const cleared = invalidated.invalidatedBy?.clearedFlags ?? [];
		checkAll("8b", [
			[invalidated.states.prd_started === true, "prd_started preserved on architecture_or_evidence invalidation"],
			[invalidated.states.prd_ready_for_sprint === true, "prd_ready_for_sprint preserved on architecture_or_evidence invalidation"],
			[invalidated.states.sprint_confirmed === true, "sprint_confirmed preserved on architecture_or_evidence invalidation"],
			[invalidated.states.implementation_confirmed === false, "implementation_confirmed cleared on architecture_or_evidence invalidation"],
			[invalidated.invalidatedBy?.kind === "architecture_or_evidence", "invalidatedBy records architecture_or_evidence"],
			[cleared.length === 1, "clearedFlags has exactly one entry"],
			[cleared[0] === "implementation_confirmed", "clearedFlags entry is implementation_confirmed"],
		]);
		// Reviewer requirement: gates must fail-closed whenever invalidatedBy is present, so the sprint gate must also block until the user re-issues the (PRD + sprint) confirmations for the new architecture/evidence material version.
		const sprint = evaluateSprintPlanningGate(readPlanningState(cwd, roomId).state);
		const impl = evaluateImplementationGate(readPlanningState(cwd, roomId).state);
		checkAll("8b", [
			[!sprint.allowed, "sprint gate blocks after architecture_or_evidence invalidation"],
			[sprint.codes.includes("material_prd_invalidation"), "sprint gate emits material_prd_invalidation code"],
			[/invalidated .*re-confirmation required/i.test(sprint.summary), "sprint summary calls out invalidation + re-confirmation"],
			[!impl.allowed, "implementation gate blocks after architecture_or_evidence invalidation"],
			[impl.missing.includes("implementation_confirmed"), "implementation gate lists implementation_confirmed as missing"],
		]);
	});

	// 9) Scope helpers, state name list, and stage confirmation export sanity.
	{
		const tiny = buildRecord({ scopeClassification: "tiny_debug" });
		const expanded = buildRecord({ scopeClassification: "expanded_from_tiny" });
		const nonTrivial = buildRecord({ scopeClassification: "non_trivial" });
		const classifier = classifyPlanningApproval("ok, proceed");
		checkAll("9", [
			[isTinyDebugScope(tiny), "isTinyDebugScope recognizes tiny_debug"],
			[!isTinyDebugScope(expanded), "isTinyDebugScope rejects expanded_from_tiny"],
			[!isTinyDebugScope(null), "isTinyDebugScope returns false on null"],
			[isNonTrivialScope(nonTrivial), "isNonTrivialScope recognizes non_trivial"],
			[isNonTrivialScope(expanded), "isNonTrivialScope recognizes expanded_from_tiny"],
			[!isNonTrivialScope(tiny), "isNonTrivialScope rejects tiny_debug"],
			[!isNonTrivialScope(null), "isNonTrivialScope returns false on null"],
			[classifier.isGenericPositive, "'ok, proceed' is a generic positive approval"],
			[classifier.explicitStageConfirmation === null, "'ok, proceed' is not an explicit stage confirmation"],
		]);
	}

	// 10) Word-boundary safety: prefix-only overlaps like "disapprove"/"unapproved" must NOT surface as a generic positive approval.
	{
		const disapprove = classifyPlanningApproval("disapprove sprint");
		checkAll("10", [
			[!disapprove.isGenericPositive, "'disapprove' is NOT a generic positive approval (word boundary)"],
			[disapprove.mentionsStage, "'disapprove sprint' still mentions sprint stage keyword"],
			[disapprove.explicitStageConfirmation === null, "'disapprove sprint' is NOT an explicit sprint confirmation"],
			[!isExplicitStageConfirmation("disapprove sprint", "sprint"), "isExplicitStageConfirmation rejects 'disapprove sprint' for sprint"],
			[!isExplicitStageConfirmation("disapprove sprint", "implementation"), "isExplicitStageConfirmation rejects 'disapprove sprint' for implementation"],
		]);
		const unapproved = classifyPlanningApproval("unapproved — plan the sprint");
		checkAll("10", [
			[!unapproved.isGenericPositive, "'unapproved' is NOT a generic positive approval (word boundary)"],
			[!unapproved.hasNegation, "'unapproved — plan the sprint' has no standalone negation marker"],
			[unapproved.mentionsStage, "'unapproved — plan the sprint' still mentions sprint stage keyword"],
			[unapproved.explicitStageConfirmation === null, "'unapproved — plan the sprint' is NOT an explicit sprint confirmation"],
			[!isExplicitStageConfirmation("unapproved — plan the sprint", "sprint"), "isExplicitStageConfirmation rejects 'unapproved — plan the sprint' for sprint"],
		]);
		// Sanity: the whole-word form must still classify as expected after the word-boundary fix.
		checkAll("10", [
			[isExplicitStageConfirmation("approved — plan the sprint", "sprint"), "sanity: 'approved — plan the sprint' is still an explicit sprint confirmation"],
		]);
	}

	// 11) An invalidated tiny_debug state must fail-closed even with allowTinyDebugBypass: true.
	withRoom("tiny_debug", "DBG-INV-BYPASS", (cwd, roomId) => {
		const invalidated = invalidatePlanningState(cwd, roomId, { kind: "prd_or_scope", reason: "scope expanded mid-flight", ...META });
		checkAll("11", [
			[invalidated.scopeClassification === "tiny_debug", "invalidated state retains tiny_debug scope"],
			[invalidated.invalidatedBy?.kind === "prd_or_scope", "invalidated state records prd_or_scope invalidation"],
		]);
		const sprint = evaluateSprintPlanningGate(invalidated, { allowTinyDebugBypass: true });
		const impl = evaluateImplementationGate(invalidated, { allowTinyDebugBypass: true });
		checkAll("11", [
			[!sprint.allowed, "sprint gate blocks invalidated tiny_debug even with bypass enabled"],
			[sprint.codes.includes("material_prd_invalidation"), "sprint gate emits material_prd_invalidation"],
			[!sprint.codes.includes("tiny_debug_bypass"), "sprint gate does NOT surface tiny_debug_bypass when invalidation is present"],
			[/invalidated .*re-confirmation required/i.test(sprint.summary), "sprint summary calls out invalidation + re-confirmation"],
			[!impl.allowed, "implementation gate blocks invalidated tiny_debug even with bypass enabled"],
			[impl.codes.includes("material_architecture_invalidation"), "implementation gate emits material_architecture_invalidation"],
			[!impl.codes.includes("tiny_debug_bypass"), "implementation gate does NOT surface tiny_debug_bypass when invalidation is present"],
			[/invalidated .*re-confirmation required/i.test(impl.summary), "implementation summary calls out invalidation + re-confirmation"],
		]);
		// After clearing the invalidation (e.g., user re-confirms), the bypass should re-open the gates.
		setStateFlag(cwd, roomId, "prd_started", true, META);
		const cleared = readPlanningState(cwd, roomId).state;
		const sprintCleared = evaluateSprintPlanningGate(cleared, { allowTinyDebugBypass: true });
		const implCleared = evaluateImplementationGate(cleared, { allowTinyDebugBypass: true });
		checkAll("11", [
			[cleared?.invalidatedBy === null, "invalidatedBy clears after a setStateFlag write"],
			[sprintCleared.allowed, "sprint gate re-opens via bypass after invalidation clears"],
			[sprintCleared.codes.includes("tiny_debug_bypass"), "sprint gate re-emits tiny_debug_bypass after invalidation clears"],
			[implCleared.allowed, "implementation gate re-opens via bypass after invalidation clears"],
			[implCleared.codes.includes("tiny_debug_bypass"), "implementation gate re-emits tiny_debug_bypass after invalidation clears"],
		]);
	});

	if (failures > 0) { console.error(`task-006 planning-state smokes failed: ${failures}`); process.exitCode = 1; return; }
	console.log("task-006 PRD planning gate smokes passed");
}

main();
