#!/usr/bin/env node
// TASK-006 Phase B - runtime smoke for PRD-first planning tools/registry + source checks.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { registerPlanningTools } from "../extensions/workflow/planning-tools";
import {
	buildGateErrorDetails,
	evaluateImplementationGateForCwd,
	formatGateErrorText,
	evaluateSprintGateForCwd,
} from "../extensions/workflow/planning-gate-runtime";
import { planningStatePathsFor } from "../extensions/workflow/planning-state";
import {
	planningCurrentRoomPointerPath,
	readPlanningCurrentRoomPointer,
} from "../extensions/workflow/planning-pointer";
import { writeCurrentRoomPointer } from "../extensions/workflow/rooms/store";


let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1; console.error(`FAIL: ${message}`);
}
function checkAll(group: string, cases: ReadonlyArray<readonly [boolean, string]>): void {
	for (const [cond, label] of cases) check(!!cond, `${group}: ${label}`);
}

function freshCwd(): { cwd: string; roomId: string; cleanup: () => void } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-006-runtime-"));
	const roomId = `room-${Math.random().toString(36).slice(2, 10)}`;
	fs.mkdirSync(path.join(cwd, ".pi", "workflow-runs", roomId), { recursive: true });
	return {
		cwd, roomId,
		cleanup: () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ } },
	};
}

function writeCurrentRoomPointerRaw(cwd: string, roomId: string): void {
	const pointerPath = path.join(cwd, ".pi", "workflow-runs", "current.json");
	fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
	fs.writeFileSync(pointerPath, JSON.stringify({ roomId }, null, 2) + "\n", "utf-8");
}

function writePlanningCurrentRoomPointerRaw(cwd: string, roomId: string): void {
	fs.mkdirSync(path.dirname(planningCurrentRoomPointerPath(cwd)), { recursive: true });
	fs.writeFileSync(planningCurrentRoomPointerPath(cwd), JSON.stringify({ roomId }, null, 2) + "\n", "utf-8");
}


interface FakePi {
	registered: any[];
	registerTool: (def: any) => void;
}
function makeFakePi(): FakePi {
	const registered: any[] = [];
	return { registered, registerTool: (def: any) => { registered.push(def); } };
}

async function invoke(tool: any, params: Record<string, unknown>, cwd: string): Promise<any> {
	if (!tool || typeof tool.execute !== "function") throw new Error("missing tool.execute");
	const ctx = { cwd, hasUI: false, ui: {}, sessionManager: undefined, model: undefined, mode: "rpc" } as any;
	return tool.execute("call-id", params, undefined, undefined, ctx);
}

function textOf(result: any): string {
	const c = result?.content ?? result?.details?.content;
	return Array.isArray(c) && c.length > 0 ? String(c[0]?.text ?? "") : "";
}
function detailsOf(result: any): any { return result?.details ?? {}; }
function isErrorResult(result: any): boolean {
	if (result?.isError === true) return true;
	const d = detailsOf(result);
	return d && d.isError === true;
}


function testRegistration(): void {
	const fake = makeFakePi();
	registerPlanningTools(fake as any);
	const names = fake.registered.map((t) => t?.name);
	checkAll("1", [
		[names.includes("workflow_planning_state"), "workflow_planning_state tool registered"],
		[names.includes("workflow_planning_artifacts"), "workflow_planning_artifacts tool registered"],
		[fake.registered.length === 2, "exactly two planning tools registered"],
	]);
	const stateTool = fake.registered.find((t) => t?.name === "workflow_planning_state");
	const artTool = fake.registered.find((t) => t?.name === "workflow_planning_artifacts");
	checkAll("1", [
		[!!stateTool?.label, "state tool has a label"],
		[!!stateTool?.description?.includes("PRD"), "state tool description mentions PRD"],
		[!!stateTool?.description?.includes("approved") || !!stateTool?.description?.includes("stage-keyword"), "state tool description calls out approval classification"],
		[Array.isArray(stateTool?.promptGuidelines) && stateTool.promptGuidelines.length >= 3, "state tool exposes promptGuidelines (>=3)"],
		[!!artTool?.label, "artifacts tool has a label"],
		[!!artTool?.description?.includes("PRD.md") || !!artTool?.description?.includes("PRD"), "artifacts tool description mentions PRD artifact"],
		[Array.isArray(artTool?.promptGuidelines) && artTool.promptGuidelines.length >= 2, "artifacts tool exposes promptGuidelines (>=2)"],
	]);
}


async function testEndToEnd(): Promise<void> {
	const fake = makeFakePi();
	registerPlanningTools(fake as any);
	const stateTool = fake.registered.find((t) => t?.name === "workflow_planning_state");
	const artTool = fake.registered.find((t) => t?.name === "workflow_planning_artifacts");
	const fixture = freshCwd();
	try {
		const cwd = fixture.cwd;
		const roomId = fixture.roomId;

		const prdRes = await invoke(artTool, { action: "write_prd", roomId, content: "# PRD\nready_for_sprint: yes\n" }, cwd);
		await invoke(artTool, { action: "write_memo", roomId, content: "# Memo\nBrain synthesis: ok\n" }, cwd);
		checkAll("2a", [
			[!isErrorResult(prdRes), "write_prd succeeded"],
			[fs.existsSync(path.join(cwd, ".pi", "workflow-runs", roomId, "PRD.md")), "PRD.md written under .pi/workflow-runs/<room>/"],
			[fs.readFileSync(path.join(cwd, ".pi", "workflow-runs", roomId, "PRD.md"), "utf-8").includes("ready_for_sprint: yes"), "PRD.md content round-trips"],
		]);
		const artRead = await invoke(artTool, { action: "read", roomId }, cwd);
		const artDetails = detailsOf(artRead);
		checkAll("2a", [
			[!isErrorResult(artRead), "artifacts read succeeded after writes"],
			[artDetails.prd?.includes("ready_for_sprint: yes"), "artifacts read returns PRD content"],
			[artDetails.memo?.includes("Brain synthesis"), "artifacts read returns memo content"],
			[String(artDetails.prdPath ?? "").endsWith("PRD.md"), "artifacts read prdPath ends with PRD.md"],
		]);

		const created = await invoke(stateTool, { action: "create", roomId, scopeClassification: "non_trivial", taskId: "TASK-006-RT" }, cwd);
		checkAll("2b", [
			[!isErrorResult(created), "state create succeeded"],
			[detailsOf(created).state?.scopeClassification === "non_trivial", "state is created with scopeClassification=non_trivial"],
			[detailsOf(created).state?.roomId === roomId, "created state roomId matches"],
		]);
		const paths = planningStatePathsFor(cwd, roomId);
		checkAll("2b", [
			[fs.existsSync(paths.stateFile), "planning-state.json is written to disk after create"],
		]);

		const setStarted = await invoke(stateTool, { action: "set_flag", roomId, state: "prd_started", value: true }, cwd);
		const setReady = await invoke(stateTool, { action: "set_flag", roomId, state: "prd_ready_for_sprint", value: true }, cwd);
		checkAll("2c", [
			[!isErrorResult(setStarted), "set_flag prd_started succeeded"],
			[!isErrorResult(setReady), "set_flag prd_ready_for_sprint succeeded"],
			[detailsOf(setStarted).state?.states?.prd_started === true, "prd_started state is true after set_flag"],
			[detailsOf(setReady).state?.states?.prd_ready_for_sprint === true, "prd_ready_for_sprint state is true after set_flag"],
			[detailsOf(setReady).state?.states?.sprint_confirmed === false, "sprint_confirmed is still false after non-confirmation set_flag calls"],
		]);

		const genSprint = await invoke(stateTool, { action: "set_flag", roomId, state: "sprint_confirmed", value: true, approvalText: "approved" }, cwd);
		const genSprintDetails = detailsOf(genSprint);
		checkAll("2d", [
			[isErrorResult(genSprint), "set_flag sprint_confirmed with 'approved' is an error"],
			[genSprintDetails.reason === "approval_classified_as_generic", "rejection reason is approval_classified_as_generic"],
			[genSprintDetails.state === "sprint_confirmed", "rejection details name the state (sprint_confirmed)"],
			[genSprintDetails.expectedStage === "sprint", "rejection details expectedStage is sprint"],
			[fs.readFileSync(paths.stateFile, "utf-8").includes('"sprint_confirmed": false'), "sprint_confirmed remains false on disk after generic approval"],
		]);

		const expSprint = await invoke(stateTool, { action: "set_flag", roomId, state: "sprint_confirmed", value: true, approvalText: "confirm sprint creation" }, cwd);
		checkAll("2e", [
			[!isErrorResult(expSprint), "explicit 'confirm sprint creation' is accepted for sprint_confirmed"],
			[detailsOf(expSprint).state?.states?.sprint_confirmed === true, "sprint_confirmed is true on the returned state"],
		]);
		const sprintGate = evaluateSprintGateForCwd(cwd, roomId, { allowTinyDebugBypass: true });
		const implGateBlocked = evaluateImplementationGateForCwd(cwd, roomId, { allowTinyDebugBypass: true });
		checkAll("2e", [
			[sprintGate.allowed, "evaluateSprintGateForCwd allows sprint after explicit sprint confirmation"],
			[!implGateBlocked.allowed, "evaluateImplementationGateForCwd still blocks implementation after only sprint confirmation"],
			[implGateBlocked.missing.includes("implementation_confirmed"), "implementation gate reports implementation_confirmed missing"],
		]);

		const genImpl = await invoke(stateTool, { action: "set_flag", roomId, state: "implementation_confirmed", value: true, approvalText: "approved" }, cwd);
		const genImplDetails = detailsOf(genImpl);
		checkAll("2f", [
			[isErrorResult(genImpl), "set_flag implementation_confirmed with 'approved' is an error"],
			[genImplDetails.reason === "approval_classified_as_generic", "implementation rejection reason is approval_classified_as_generic"],
			[genImplDetails.expectedStage === "implementation", "implementation rejection details expectedStage is implementation"],
		]);

		const expImpl = await invoke(stateTool, { action: "set_flag", roomId, state: "implementation_confirmed", value: true, approvalText: "confirm implementation" }, cwd);
		checkAll("2g", [
			[!isErrorResult(expImpl), "explicit 'confirm implementation' is accepted for implementation_confirmed"],
			[detailsOf(expImpl).state?.states?.implementation_confirmed === true, "implementation_confirmed is true on the returned state"],
		]);
		const implGateAllowed = evaluateImplementationGateForCwd(cwd, roomId, { allowTinyDebugBypass: true });
		checkAll("2g", [
			[implGateAllowed.allowed, "evaluateImplementationGateForCwd allows implementation after all four confirmations"],
			[implGateAllowed.missing.length === 0, "implementation gate reports no missing flags after all four confirmations"],
		]);

		const noPointer = freshCwd();
		try {

			const noPointerSprintDetails = buildGateErrorDetails(noPointer.cwd, undefined, "sprint", { allowTinyDebugBypass: true });
			const noPointerImplDetails = buildGateErrorDetails(noPointer.cwd, undefined, "implementation", { allowTinyDebugBypass: true });
			checkAll("2h", [
				[noPointerSprintDetails.allowed === false && noPointerImplDetails.allowed === false && noPointerSprintDetails.codes.includes("state_missing") && noPointerImplDetails.codes.includes("state_missing") && noPointerSprintDetails.missing.join(",") === "prd_started,prd_ready_for_sprint,sprint_confirmed,implementation_confirmed" && noPointerImplDetails.missing.join(",") === "prd_started,prd_ready_for_sprint,sprint_confirmed,implementation_confirmed", "both gates block and report state_missing with all expected missing flags"],
				[String(formatGateErrorText(noPointerSprintDetails)).includes("Pass planningRoomId or call workflow_planning_state") && String(formatGateErrorText(noPointerImplDetails)).includes("Pass planningRoomId or call workflow_planning_state") && String(formatGateErrorText(noPointerSprintDetails)).includes("missingFlags=") && String(formatGateErrorText(noPointerImplDetails)).includes("missingFlags="), "guidance text resolves pointer and includes missing flags for both gates"],
			]);
		} finally {
			noPointer.cleanup();
		}
		const alt = freshCwd();
		try {
			writeCurrentRoomPointer(alt.cwd, alt.roomId);
			const altState = await invoke(stateTool, { action: "create", scopeClassification: "tiny_debug", taskId: "TASK-006-PTR" }, alt.cwd);
			checkAll("2h", [
				[!isErrorResult(altState), "create without explicit roomId uses active pointer"],
				[detailsOf(altState).state?.roomId === alt.roomId, "create resolves roomId from active pointer"],
			]);
			const sprintFromPtr = evaluateSprintGateForCwd(alt.cwd, undefined);
			checkAll("2h", [
				[!sprintFromPtr.allowed, "evaluateSprintGateForCwd with undefined roomId uses active pointer and blocks tiny_debug without explicit bypass"],
			]);
			const sprintFromPtrWithBypass = evaluateSprintGateForCwd(alt.cwd, undefined, { allowTinyDebugBypass: true });
			checkAll("2h", [
				[sprintFromPtrWithBypass.allowed, "evaluateSprintGateForCwd with explicit tiny-debug bypass can still allow when explicitly requested"],
				[sprintFromPtrWithBypass.codes.includes("tiny_debug_bypass"), "explicit bypass mode surfaces tiny_debug_bypass code"],
			]);

			const staleRoom = "task-006-phase-b";
			const planningRoom = `room-${Math.random().toString(36).slice(2, 10)}-plan`;
			const explicitPlan = await invoke(
				stateTool,
				{ action: "create", roomId: planningRoom, scopeClassification: "non_trivial", taskId: "TASK-006-STALE" },
				alt.cwd,
			);
			checkAll("2i", [[!isErrorResult(explicitPlan), "explicit create for plan room succeeds while stale pointer test runs"]]);
			await invoke(stateTool, { action: "set_flag", roomId: planningRoom, state: "prd_started", value: true }, alt.cwd);
			await invoke(stateTool, { action: "set_flag", roomId: planningRoom, state: "prd_ready_for_sprint", value: true }, alt.cwd);
			await invoke(stateTool, { action: "set_flag", roomId: planningRoom, state: "sprint_confirmed", value: true, approvalText: "confirm sprint creation" }, alt.cwd);
			await invoke(
				stateTool,
				{ action: "set_flag", roomId: planningRoom, state: "implementation_confirmed", value: true, approvalText: "confirm implementation" },
				alt.cwd,
			);
			writeCurrentRoomPointer(alt.cwd, staleRoom);
			const stalePlanningGate = evaluateSprintGateForCwd(alt.cwd, undefined, { allowTinyDebugBypass: true });
			const stalePlanningDetails = buildGateErrorDetails(alt.cwd, undefined, "sprint", { allowTinyDebugBypass: true });
			const staleImplGate = evaluateImplementationGateForCwd(alt.cwd, undefined, { allowTinyDebugBypass: true });
			checkAll("2i", [
				[readPlanningCurrentRoomPointer(alt.cwd) === planningRoom, "planning-current pointer records room for stale-pointer regression fixture"],
				[fs.existsSync(planningCurrentRoomPointerPath(alt.cwd)), "planning-current pointer file exists"],
				[stalePlanningGate.allowed, "sprint gate resolves through planning-current pointer despite stale workflow current pointer"],
				[staleImplGate.allowed, "implementation gate resolves through planning-current pointer despite stale workflow current pointer"],
				[stalePlanningDetails.pointerPath === planningCurrentRoomPointerPath(alt.cwd), "planning fallback emits planning-current pointerPath in details"],
				[!fs.existsSync(path.join(alt.cwd, ".pi", "workflow-runs", staleRoom, "planning-state.json")), "stale workflow pointer room still has no planning-state"],
			]);

			const planningCurrentMissingStateCwd = freshCwd();
			try {
				const missingStateRoom = `room-${Math.random().toString(36).slice(2, 10)}-nostate`;
				writePlanningCurrentRoomPointerRaw(planningCurrentMissingStateCwd.cwd, missingStateRoom);
				const missingStateDetails = buildGateErrorDetails(planningCurrentMissingStateCwd.cwd, undefined, "sprint", { allowTinyDebugBypass: true });
				checkAll("2k", [
					[!missingStateDetails.allowed, "planning-current without state does not unexpectedly allow sprint gate"],
					[missingStateDetails.codes.includes("state_missing"), "planning-current without state reports state_missing"],
					[typeof missingStateDetails.stateIssue === "string" && missingStateDetails.stateIssue.includes("planning state file missing"), "buildGateErrorDetails exposes actionable stateIssue for missing planning state"],
				]);
			} finally { planningCurrentMissingStateCwd.cleanup(); }

			const invalidPlanPtrWithLegacy = freshCwd();
			try {
				const legacyRoom = `room-${Math.random().toString(36).slice(2, 10)}-legacy`;
				writeCurrentRoomPointer(invalidPlanPtrWithLegacy.cwd, legacyRoom);
				const legacyCreate = await invoke(stateTool, { action: "create", scopeClassification: "non_trivial", taskId: "TASK-006-LEGACY" }, invalidPlanPtrWithLegacy.cwd);
				await Promise.all([
					invoke(stateTool, { action: "set_flag", roomId: legacyRoom, state: "prd_started", value: true }, invalidPlanPtrWithLegacy.cwd),
					invoke(stateTool, { action: "set_flag", roomId: legacyRoom, state: "prd_ready_for_sprint", value: true }, invalidPlanPtrWithLegacy.cwd),
					invoke(
						stateTool,
						{ action: "set_flag", roomId: legacyRoom, state: "sprint_confirmed", value: true, approvalText: "confirm sprint creation" },
						invalidPlanPtrWithLegacy.cwd,
					),
					invoke(
						stateTool,
						{ action: "set_flag", roomId: legacyRoom, state: "implementation_confirmed", value: true, approvalText: "confirm implementation" },
						invalidPlanPtrWithLegacy.cwd,
					),
				]);
				writePlanningCurrentRoomPointerRaw(invalidPlanPtrWithLegacy.cwd, "../../outside");
				fs.writeFileSync(planningCurrentRoomPointerPath(invalidPlanPtrWithLegacy.cwd), "{ this is not valid json", "utf-8");
				checkAll("2l", [
					[!isErrorResult(legacyCreate), "legacy workflow-room planning state create for explicit room succeeds"],
					[buildGateErrorDetails(invalidPlanPtrWithLegacy.cwd, undefined, "sprint").codes.includes("planning_room_id_invalid") && buildGateErrorDetails(invalidPlanPtrWithLegacy.cwd, undefined, "sprint").pointerPath === planningCurrentRoomPointerPath(invalidPlanPtrWithLegacy.cwd), "invalid dedicated planning-current pointer blocks fallback to valid workflow current pointer and pointerPath is reflected in details"],
					[buildGateErrorDetails(invalidPlanPtrWithLegacy.cwd, undefined, "sprint", { allowTinyDebugBypass: true }).codes.includes("planning_room_id_invalid") && buildGateErrorDetails(invalidPlanPtrWithLegacy.cwd, undefined, "sprint", { allowTinyDebugBypass: true }).pointerPath === planningCurrentRoomPointerPath(invalidPlanPtrWithLegacy.cwd), "malformed dedicated planning-current pointer maps to planning_room_id_invalid and is reflected in pointerPath"],
				]);
			} finally { invalidPlanPtrWithLegacy.cleanup(); }
			const legacyInterop = freshCwd();
			try {
				const workflowRoom = `room-${Math.random().toString(36).slice(2, 10)}-legacy`;
				const plannedRoom = `room-${Math.random().toString(36).slice(2, 10)}-plan`;
				const staleRoom = `room-${Math.random().toString(36).slice(2, 10)}-stale`;
				writeCurrentRoomPointer(legacyInterop.cwd, workflowRoom);
				const legacyWorkflowCreate = await invoke(
					stateTool,
					{ action: "create", scopeClassification: "non_trivial", taskId: "TASK-006-LEGACY-READ" },
					legacyInterop.cwd,
				);
				await invoke(stateTool, { action: "set_flag", roomId: workflowRoom, state: "prd_started", value: true }, legacyInterop.cwd);
				await invoke(
					stateTool,
					{ action: "create", roomId: plannedRoom, scopeClassification: "non_trivial", taskId: "TASK-006-PLANROOM" },
					legacyInterop.cwd,
				);
				writeCurrentRoomPointer(legacyInterop.cwd, staleRoom);
				const legacyCreate = await invoke(stateTool, { action: "create", scopeClassification: "non_trivial", taskId: "TASK-006-PLANCREATE" }, legacyInterop.cwd);
				checkAll("2m", [
					[!isErrorResult(legacyWorkflowCreate), "workflow-room current pointer is used for create fallback when planning-current is absent"],
					[detailsOf(legacyCreate).roomId === staleRoom, "action=create targets workflow-current room when both pointers are present"],
					[readPlanningCurrentRoomPointer(legacyInterop.cwd) === staleRoom, "create updates planning-current to the workflow-current create room"],
				]);
			} finally { legacyInterop.cleanup(); }
			const invalidRoomId = "../../outside";
			const invalidState = await invoke(stateTool, { action: "create", roomId: invalidRoomId, scopeClassification: "tiny_debug", taskId: "TASK-006-BAD" }, cwd);
			const invalidGate = evaluateSprintGateForCwd(cwd, invalidRoomId);
			checkAll("2i", [
				[isErrorResult(invalidState), "workflow_planning_state rejects invalid roomId with error"],
				[String(textOf(invalidState)).includes("invalid planning room id"), "invalid roomId error is actionable"],
				[invalidGate.codes.includes("planning_room_id_invalid"), "planning gate surfaces planning_room_id_invalid for explicit bad roomId"],
				[!invalidGate.allowed, "planning gate blocks explicit invalid roomId"],
				[!fs.existsSync(path.join(cwd, "outside")), "explicit invalid roomId does not write outside cwd/.pi/workflow-runs"],
				[!fs.existsSync(path.join(cwd, ".pi", "workflow-runs", "outside", "planning-state.json")), "explicit invalid roomId does not create in-scope sanitized room"],
			]);

			const invalidPtrCwd = freshCwd();
			try {
				writeCurrentRoomPointerRaw(invalidPtrCwd.cwd, "../../outside");
				const invalidPtrState = await invoke(stateTool, { action: "create", scopeClassification: "tiny_debug", taskId: "TASK-006-BADPTR" }, invalidPtrCwd.cwd);
				const invalidPtrGate = evaluateSprintGateForCwd(invalidPtrCwd.cwd, undefined);
				const invalidPtrDetails = buildGateErrorDetails(invalidPtrCwd.cwd, undefined, "sprint", { allowTinyDebugBypass: true });
				checkAll("2j", [
					[isErrorResult(invalidPtrState), "workflow_planning_state create without roomId rejects invalid active pointer"],
					[String(textOf(invalidPtrState)).includes("invalid planning room id"), "invalid active pointer is surfaced as planning-room-id invalid"],
					[!invalidPtrGate.allowed, "sprint gate blocks create without explicit roomId when active pointer invalid"],
					[invalidPtrGate.codes.includes("planning_room_id_invalid"), "sprint gate surfaces planning_room_id_invalid for invalid active pointer"],
					[invalidPtrDetails.codes.includes("planning_room_id_invalid"), "buildGateErrorDetails surfaces planning_room_id_invalid for invalid active pointer"],
					[String(invalidPtrDetails.summary).includes("invalid planning room id"), "buildGateErrorDetails summary surfaces invalid room id reason"],
					[invalidPtrDetails.pointerPath === path.join(invalidPtrCwd.cwd, ".pi", "workflow-runs", "current.json"), "buildGateErrorDetails pointerPath reflects workflow current pointer path when that pointer is the active resolution source"],
					[!fs.existsSync(path.join(invalidPtrCwd.cwd, ".pi", "workflow-runs", "outside", "planning-state.json")), "invalid active pointer does not create in-scope sanitized room"],
				]);
			} finally { invalidPtrCwd.cleanup(); }
		} finally { alt.cleanup(); }
	} finally { fixture.cleanup(); }
}


function readSource(rel: string): string {
	return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf-8");
}

function toolBodies(source: string): Map<string, string> {
	const out = new Map<string, string>();
	const registerToolRe = /pi\.registerTool\(\{/g;
	const nameRe = /name:\s*"(sprint_[^"]+)"/g;

	const registerStarts: number[] = [];
	let regMatch: RegExpExecArray | null;
	while ((regMatch = registerToolRe.exec(source)) !== null) registerStarts.push(regMatch.index);

	const nameMatches: Array<{ name: string; start: number }> = [];
	let nameMatch: RegExpExecArray | null;
	while ((nameMatch = nameRe.exec(source)) !== null) {
		nameMatches.push({ name: nameMatch[1], start: nameMatch.index });
	}

	for (let i = 0; i < nameMatches.length; i++) {
		const current = nameMatches[i] as { name: string; start: number };
		let end = source.length;
		const nextName = nameMatches[i + 1];
		if (nextName) end = nextName.start;
		for (const nextRegister of registerStarts) {
			if (nextRegister > current.start && nextRegister < end) end = nextRegister;
		}
		out.set(current.name, source.slice(current.start, end));
	}

	return out;
}

function testSourceChecks(): void {
	const brain = readSource("extensions/brain-workflow.ts");
	checkAll("3a", [
		[/import\s+\{[^}]*\bregisterPlanningTools\b[^}]*\}\s+from\s+["']\.\/workflow\/planning-tools["']/.test(brain),
			"brain-workflow.ts imports registerPlanningTools from ./workflow/planning-tools"],
		[/registerPlanningTools\(\s*pi\s*\)/.test(brain), "brain-workflow.ts calls registerPlanningTools(pi)"],
	]);

	const sprint = readSource("extensions/sprint/tools.ts");
	const sprintBodies = toolBodies(sprint);
	function bodyHas(body: string, name: string, planningRoomId = true, gate = true): boolean {
		return body.includes(`name: "${name}"`) && (!planningRoomId || body.includes("planningRoomId")) && (!gate || body.includes("gateSprintEntryPoint"));
	}
	const sprintCreate = sprintBodies.get("sprint_create") ?? "";
	const sprintCreateTask = sprintBodies.get("sprint_create_task") ?? "";
	const sprintCreateEpic = sprintBodies.get("sprint_create_epic") ?? "";
	const sprintStartSession = sprintBodies.get("sprint_start_task_session") ?? "";
	const sprintDebug = sprintBodies.get("sprint_debug") ?? "";
	const sprintDebugAddIdx = sprintDebug.indexOf('actionLower === "add"');
	const sprintDebugNoteIdx = sprintDebug.indexOf('actionLower === "note"');
	const sprintDebugDoneIdx = sprintDebug.indexOf('actionLower === "done"');
	const sprintDebugGateIdx = sprintDebug.indexOf("gateSprintEntryPoint");
	const sprintDebugPromoteIdx = sprintDebug.indexOf("promoteDebugItem");
	checkAll("3b", [
		[/import\s+\{[^}]*\bgateSprintEntryPoint\b[^}]*\}\s+from\s+["']\.\/planning-gate["']/.test(sprint),
			"sprint/tools.ts imports gateSprintEntryPoint"],
		[bodyHas(sprintCreate, "sprint_create"), "sprint_create body has planningRoomId and gateSprintEntryPoint"],
		[bodyHas(sprintCreateTask, "sprint_create_task"), "sprint_create_task body has planningRoomId and gateSprintEntryPoint"],
		[bodyHas(sprintCreateEpic, "sprint_create_epic"), "sprint_create_epic body has planningRoomId and gateSprintEntryPoint"],
		[bodyHas(sprintStartSession, "sprint_start_task_session"), "sprint_start_task_session body has planningRoomId and gateSprintEntryPoint"],
		[bodyHas(sprintDebug, "sprint_debug"), "sprint_debug body has planningRoomId and gateSprintEntryPoint"],
		[/actionLower === "add"/.test(sprintDebug), "sprint_debug body has add branch"],
		[/actionLower === "note"/.test(sprintDebug), "sprint_debug body has note branch"],
		[/actionLower === "done"/.test(sprintDebug), "sprint_debug body has done branch"],
		[/new Set\(\[\"status\",\s*\"add\",\s*\"note\",\s*\"done\",\s*\"promote\"\]\)/.test(sprintDebug),
			"sprint_debug action allowlist includes status, add, note, done, promote"],
		[/promoteDebugItem/.test(sprintDebug), "sprint_debug contains promoteDebugItem"],
		[sprintDebugAddIdx >= 0 && sprintDebugNoteIdx >= 0 && sprintDebugDoneIdx >= 0 && sprintDebugGateIdx >= 0,
			"sprint_debug exposes add, note, done branches and gate entry point"],
		[sprintDebugAddIdx < sprintDebugNoteIdx && sprintDebugNoteIdx < sprintDebugDoneIdx && sprintDebugDoneIdx < sprintDebugGateIdx,
			"sprint_debug add/note/done branches appear before gateSprintEntryPoint"],
		[sprintDebugGateIdx < sprintDebugPromoteIdx && sprintDebugPromoteIdx >= 0,
			"sprint_debug gateSprintEntryPoint executes before promoteDebugItem"],
	]);

	const command = readSource("extensions/sprint/command.ts");
	const commandGateCount = (command.match(/gateSprintEntryPoint\(ctx\.cwd, undefined, "sprint"\)/g) ?? []).length;
	const cmdNewGate = /if\s*\(\s*sub === "new"[\s\S]{0,260}?gateSprintEntryPoint\(ctx\.cwd, undefined, "sprint"\)/.test(command);
	const cmdTaskAddGate = /if\s*\(\s*sub === "task"\s*&&\s*args\[1\]\s*===\s*"add"[\s\S]{0,260}?gateSprintEntryPoint\(ctx\.cwd, undefined, "sprint"\)/.test(command);
	const taskStartBranchIdx = command.indexOf('if (sub === "task" && args[1] === "start")');
	const cmdTaskStartGate = taskStartBranchIdx >= 0
		&& command.indexOf('const gate = gateSprintEntryPoint(ctx.cwd, undefined, "sprint");', taskStartBranchIdx) >= 0;
	const cmdEpicAddGate = /if\s*\(\s*sub === "epic"\s*&&\s*args\[1\]\s*===\s*"add"[\s\S]{0,220}?gateSprintEntryPoint\(ctx\.cwd, undefined, "sprint"\)/.test(command);
	const cmdDebugPromoteGate = /if\s*\(\s*action === "promote"[\s\S]{0,260}?gateSprintEntryPoint\(ctx\.cwd, undefined, "sprint"\)/.test(command);
	const cmdDebugAddIdx = command.indexOf('action === "add"');
	const cmdDebugNoteIdx = command.indexOf('action === "note"');
	const cmdDebugDoneIdx = command.indexOf('action === "done"');
	const cmdDebugPromoteIdx = command.indexOf('action === "promote"');
	checkAll("3c", [
		[/import\s+\{[^}]*\bgateSprintEntryPoint\b[^}]*\}\s+from\s+["']\.\/planning-gate["']/.test(command),
			"command.ts imports gateSprintEntryPoint"],
		[commandGateCount === 5, "command.ts gates non-trivial slash branches with gateSprintEntryPoint"],
		[cmdNewGate, "/sprint new is wrapped with gateSprintEntryPoint"],
		[cmdTaskAddGate, "/sprint task add is wrapped with gateSprintEntryPoint"],
		[cmdTaskStartGate, "/sprint task start is wrapped with gateSprintEntryPoint"],
		[cmdEpicAddGate, "/sprint epic add is wrapped with gateSprintEntryPoint"],
		[cmdDebugPromoteGate, "/sprint debug promote is wrapped with gateSprintEntryPoint"],
		[cmdDebugAddIdx >= 0 && cmdDebugNoteIdx >= 0 && cmdDebugDoneIdx >= 0 && cmdDebugPromoteIdx >= 0,
			"command.ts keeps debug action branches order"],
		[cmdDebugAddIdx < cmdDebugNoteIdx && cmdDebugNoteIdx < cmdDebugDoneIdx && cmdDebugDoneIdx < cmdDebugPromoteIdx,
			"/sprint debug add/note/done branches remain before gated promote branch"],
	]);

	const hook = readSource("extensions/sprint/hooks.ts");
	checkAll("3d", [
		[/import\s+\{[^}]*\bgateSprintEntryPoint\b[^}]*\}\s+from\s+["']\.\/planning-gate["']/.test(hook),
			"hooks.ts imports gateSprintEntryPoint from ./planning-gate"],
		[/if\s*\(mode === "always"[\s\S]{0,260}?blockedSprintAutoCreateMessage\(ctx, "via auto-create"\)/.test(hook),
			"hooks.ts blocks always-mode auto-create when planning gate fails"],
		[/const gateMessage = blockedSprintAutoCreateMessage\(ctx, "via user-confirmed bootstrap"\);[\s\S]{0,220}if \(gateMessage\)/.test(hook),
			"hooks.ts blocks user-confirmed auto-create when planning gate fails"],
		[/if \(isLikelyLightweightDebugPrompt\(prompt\)\)[\s\S]{0,80}debugLaneGuidanceText/.test(hook),
			"hooks.ts retains lightweight debug guidance path"],
	]);

	const delegate = readSource("extensions/workflow/delegate/tools.ts");
	checkAll("3e", [
		[/planningRoomId/.test(delegate), "delegate/tools.ts references planningRoomId"],
		[/import\s+\{[^}]*\bbuildGateErrorDetails\b[^}]*\bformatGateErrorText\b[^}]*\}\s+from\s+["']\.\.\/planning-gate-runtime["']/.test(delegate),
			"delegate/tools.ts imports buildGateErrorDetails and formatGateErrorText from ../planning-gate-runtime"],
		[/if\s*\(\s*agent\s*===\s*"coder"\s*\)/.test(delegate), "delegate/tools.ts has explicit `if (agent === \"coder\")` branch"],
		[/delegate_to_coder/.test(delegate), "delegate/tools.ts registers delegate_to_coder tool"],
		[/delegate_to_reviewer/.test(delegate), "delegate/tools.ts registers delegate_to_reviewer tool"],
		[/agent\s*===\s*"reviewer"/.test(delegate), "delegate/tools.ts retains a separately-handled reviewer branch"],
		[/if\s*\(\s*agent\s*===\s*"reviewer"\s*\)[\s\S]{0,400}planningGate/.test(delegate) === false,
			"reviewer branch does NOT contain a generic planningGate guard"],
		[/if\s*\(\s*agent\s*===\s*"coder"[\s\S]{0,400}buildGateErrorDetails[\s\S]{0,200}implementation/.test(delegate),
			"coder branch calls buildGateErrorDetails with gate='implementation'"],
	]);
}


async function main(): Promise<void> {
	testRegistration();
	await testEndToEnd();
	testSourceChecks();
	if (failures > 0) {
		console.error(`task-006 prd planning runtime smokes failed: ${failures}`);
		process.exitCode = 1;
		return;
	}
	console.log("task-006 PRD planning runtime smokes passed");
}

main().catch((error) => {
	console.error("task-006 PRD planning runtime smokes crashed:", error);
	process.exitCode = 1;
});
