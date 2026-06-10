// Sprint subsystem — AI-facing `sprint_*` tool registration.
// Extracted from extensions/sprint-system.ts as part of TASK-018 Slice 4.
//
// `registerSprintTools(pi)` registers AI-facing tools the agent uses
// to read/write the .sprints substrate and lightweight debug lane.
// Key tools:
//   - sprint_start_task_session: auto-starts a task session when ctx.newSession
//     is available; falls back to preparing the /sprint task start command
//     in the editor when automatic start is unavailable.
// Tool bodies delegate fs/pointer work to helpers in ./store and the debug
// lane helpers in ./debug.

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EMPTY_BRAIN_MARKERS, readBrainMarkersForTaskFile } from "./markers";
import {
	appendProgress,
	createEpic,
	createSprint,
	createTask,
	loadCurrent,
	normalizeActiveSprintPath,
	normalizeActiveTaskPath,
	nowIso,
	readJson,
	readSessionBinding,
	rootPaths,
	saveCurrent,
	setActiveTask,
	updateTaskStatus,
} from "./store";
import { startSprintTaskSession } from "./start-session";
import { appendDebugNote, createDebugItem, readDebugLaneSummary, promoteDebugItem } from "./debug";
import { evaluateDebugEscalationForSprintDebug, runSprintDebugDone } from "./debug-tooling";
import { evaluateSprintTaskFinalizationFromDisk } from "../workflow/finalization-runtime";
import { isFinalizationStatus } from "../workflow/finalization-gate";
import { gateSprintEntryPoint, sprintGateErrorResult } from "./planning-gate";
import type { SprintConfig, SprintCurrent } from "./types";

export function registerSprintTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sprint_read_context",
		label: "Sprint: Read Context",
		description: "Read active sprint config/current/task pointers with brief snippets; reports the session binding as effective context when pinned to a task.",
		promptSnippet: "Read sprint context before planning or coding.",
		promptGuidelines: ["Use sprint_read_context first when sprint pointers exist or sprint state is unclear."],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const paths = rootPaths(cwd);
			const config = readJson<SprintConfig>(paths.configPath);
			const current = readJson<SprintCurrent>(paths.currentPath);
			const binding = readSessionBinding((ctx as any).sessionManager);
			let sprintPath: string | null = null;
			let taskPath: string | null = null;
			let source: "sessionBinding" | "current.json" | "none" = "none";
			if (binding?.sprintPath && binding?.taskPath) {
				try {
					sprintPath = normalizeActiveSprintPath(cwd, binding.sprintPath, true).absolutePath;
					taskPath = normalizeActiveTaskPath(cwd, binding.taskPath, sprintPath).absolutePath;
					source = "sessionBinding";
				} catch {
					sprintPath = null;
					taskPath = null;
				}
			}
			if (!sprintPath && current?.activeSprintPath) {
				try {
					sprintPath = normalizeActiveSprintPath(cwd, current.activeSprintPath).absolutePath;
					if (current.activeTaskPath) taskPath = normalizeActiveTaskPath(cwd, current.activeTaskPath, sprintPath).absolutePath;
					source = "current.json";
				} catch {
					sprintPath = null;
					taskPath = null;
				}
			}
			const sprintReadme = sprintPath && fs.existsSync(path.join(sprintPath, "README.md")) ? fs.readFileSync(path.join(sprintPath, "README.md"), "utf8").slice(0, 400) : "";
			const taskHead = taskPath && fs.existsSync(taskPath) ? fs.readFileSync(taskPath, "utf8").slice(0, 400) : "";
			const brainMarkers = taskPath ? readBrainMarkersForTaskFile(taskPath) : { ...EMPTY_BRAIN_MARKERS };
			const debugLane = readDebugLaneSummary(cwd, 5);
			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						config,
						current,
						sessionBinding: binding,
						effectiveSource: source,
						sprintPath: sprintPath ? path.relative(cwd, sprintPath) : null,
						taskPath: taskPath ? path.relative(cwd, taskPath) : null,
						sprintReadme,
						taskHead,
						brainMarkers,
						debugLane,
					}),
				}],
			};
		},
	});

	pi.registerTool({
		name: "sprint_create",
		label: "Sprint: Create Sprint",
		description: "Create+activate a sprint. Gated by the PRD-first planning state for non-trivial work (prd_started + prd_ready_for_sprint + sprint_confirmed).",
		promptSnippet: "Create a sprint when non-trivial work starts without one.",
		promptGuidelines: [
			"Use sprint_create when there is no active sprint and work should be tracked in .sprints.",
			"For non-trivial work the gate requires prd_started + prd_ready_for_sprint + sprint_confirmed; pass planningRoomId or set the dedicated planning-current pointer first. Tiny debug add/note/done are intentionally ungated; creation is gated.",
		],
		parameters: Type.Object({
			name: Type.String(),
			planningRoomId: Type.Optional(Type.String({ description: "Optional planning room id. Falls back to .pi/workflow-runs/planning-current.json first, then to .pi/workflow-runs/current.json for compatibility." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const name = String((params as any).name || "").trim();
			if (!name) return { isError: true, content: [{ type: "text", text: "Missing name" }] };
			const gate = gateSprintEntryPoint(cwd, (params as any).planningRoomId, "sprint");
			if (!gate.allowed) return sprintGateErrorResult(gate.details);
			const created = createSprint(cwd, name);
			return { content: [{ type: "text", text: `Created ${path.relative(cwd, created.sprintPath)}` }] };
		},
	});

	pi.registerTool({
		name: "sprint_create_task",
		label: "Sprint: Create Task",
		description: "Create task in active sprint. Gated by the PRD-first planning state for non-trivial work (prd_started + prd_ready_for_sprint + sprint_confirmed).",
		promptSnippet: "Create a task for concrete implementation work.",
		promptGuidelines: [
			"Use sprint_create_task for scoped units of work inside the active sprint.",
			"For non-trivial work the gate requires prd_started + prd_ready_for_sprint + sprint_confirmed; pass planningRoomId or set the dedicated planning-current pointer first. Tiny debug add/note/done are intentionally ungated; task creation is gated.",
		],
		parameters: Type.Object({
			title: Type.String(),
			humanSummary: Type.Optional(Type.String()),
			aiContext: Type.Optional(Type.String()),
			acceptanceCriteria: Type.Optional(Type.String()),
			epic: Type.Optional(Type.String()),
			priority: Type.Optional(Type.String()),
			planningRoomId: Type.Optional(Type.String({ description: "Optional planning room id. Falls back to .pi/workflow-runs/planning-current.json first, then to .pi/workflow-runs/current.json for compatibility." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as any;
			const title = String(p.title || "").trim();
			if (!title) return { isError: true, content: [{ type: "text", text: "Missing title" }] };
			const gate = gateSprintEntryPoint(ctx.cwd, p.planningRoomId, "sprint");
			if (!gate.allowed) return sprintGateErrorResult(gate.details);
			const created = createTask(ctx.cwd, title, {
				humanSummary: p.humanSummary,
				aiContext: p.aiContext,
				acceptanceCriteria: p.acceptanceCriteria,
				epic: p.epic,
				priority: p.priority,
			});
			return { content: [{ type: "text", text: `Created task ${created.id}` }] };
		},
	});

	pi.registerTool({
		name: "sprint_create_epic",
		label: "Sprint: Create Epic",
		description: "Create an epic under .sprints/epics. Gated by the PRD-first planning state for non-trivial work (prd_started + prd_ready_for_sprint + sprint_confirmed).",
		promptSnippet: "Create an epic for larger multi-task initiative context.",
		promptGuidelines: [
			"Use sprint_create_epic when work spans multiple tasks and needs durable shared context.",
			"For non-trivial work the gate requires prd_started + prd_ready_for_sprint + sprint_confirmed; pass planningRoomId or set the dedicated planning-current pointer first. Tiny debug add/note/done are intentionally ungated; epic creation is gated.",
		],
		parameters: Type.Object({
			title: Type.String(),
			humanSummary: Type.Optional(Type.String()),
			aiContext: Type.Optional(Type.String()),
			planningRoomId: Type.Optional(Type.String({ description: "Optional planning room id. Falls back to .pi/workflow-runs/planning-current.json first, then to .pi/workflow-runs/current.json for compatibility." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as any;
			const title = String(p.title || "").trim();
			if (!title) return { isError: true, content: [{ type: "text", text: "Missing title" }] };
			const gate = gateSprintEntryPoint(ctx.cwd, p.planningRoomId, "sprint");
			if (!gate.allowed) return sprintGateErrorResult(gate.details);
			const epic = createEpic(ctx.cwd, title, { humanSummary: p.humanSummary, aiContext: p.aiContext });
			return { content: [{ type: "text", text: `Created epic ${epic.epicId} at ${path.relative(ctx.cwd, epic.epicPath)}` }] };
		},
	});

	pi.registerTool({
		name: "sprint_debug",
		label: "Sprint: Debug/Hotfix Lane",
		description: "Track tiny debug/hotfix items in the .sprints/debug lane. add/note/done/status remain ungated; `action: promote` remains gated by the PRD-first planning state.",
		promptSnippet: "Use sprint_debug for tiny debug/hotfix/few-line fixes without starting a full sprint task session.",
		promptGuidelines: [
			"Use sprint_debug for minimal debug/hotfix items with optional notes/evidence. For larger work, promote to a normal sprint task with `action: promote`.",
			"When action is `promote`, the item is converted into a normal sprint task via `createTask` and does not start a session. The sprint planning gate runs before promote; pass `planningRoomId` or set the dedicated planning-current pointer first.",
		],
		parameters: Type.Object({
			action: Type.String(),
			itemId: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			note: Type.Optional(Type.String()),
			evidence: Type.Optional(Type.String()),
			area: Type.Optional(Type.String({ description: "Optional explicit feature area label used for same-area repeat escalation analysis." })),
			filesChanged: Type.Optional(Type.Number()),
			locChanged: Type.Optional(Type.Number()),
			behaviorPaths: Type.Optional(Type.Number()),
			stateMachineOrArchitectureChange: Type.Optional(Type.Boolean()),
			reviewerBehaviorEvidenceMissing: Type.Optional(Type.Boolean()),
			limit: Type.Optional(Type.Number()),
			finalizationGateMode: Type.Optional(Type.Union([Type.Literal("strict"), Type.Literal("dry-run")])),
			planningRoomId: Type.Optional(Type.String({ description: "Optional planning room id for the sprint planning gate. Required when action=promote and the planning state is not on the dedicated planning pointer; ignored for add/note/done/status." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as any;
			const action = String(p.action || "").trim();
			if (!action) return { isError: true, content: [{ type: "text", text: "Missing action" }] };
			const actionLower = action.toLowerCase();
			if (!new Set(["status", "add", "note", "done", "promote"]).has(actionLower)) {
				return {
					isError: true,
					content: [{ type: "text", text: "Unsupported sprint_debug action. Use status|add|note|done|promote" }],
				};
			}
			try {
				const cwd = ctx.cwd;
				if (actionLower === "status") {
					const rawLimit = p.limit;
					const safeLimit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 5;
					const summary = readDebugLaneSummary(cwd, safeLimit || 5);
					return {
						content: [
							{
								type: "text",
								text: `Debug lane: open=${summary.openCount}, done=${summary.doneCount}, promoted=${summary.promotedCount} (latest=${summary.latest.length})`,
							},
							{ type: "text", text: JSON.stringify({ summary }) },
						],
					};
				}
				if (actionLower === "add") {
					const title = String(p.title || "").trim();
					if (!title) return { isError: true, content: [{ type: "text", text: "Missing title" }] };
					const created = createDebugItem(cwd, title);
					return {
						content: [
							{ type: "text", text: `Created ${created.id}: ${created.title}` },
							{ type: "text", text: JSON.stringify({ item: created }) },
						],
					};
				}
				if (actionLower === "note") {
					const itemId = String(p.itemId || "").trim();
					const note = String(p.note || "").trim();
					if (!itemId) return { isError: true, content: [{ type: "text", text: "Missing itemId" }] };
					if (!note) return { isError: true, content: [{ type: "text", text: "Missing note" }] };
					const updated = appendDebugNote(cwd, itemId, note);
					return {
						content: [
							{ type: "text", text: `Appended note to ${updated.id}` },
							{ type: "text", text: JSON.stringify({ item: updated }) },
						],
					};
				}
				if (actionLower === "done") {
					const itemId = String(p.itemId || "").trim();
					if (!itemId) return { isError: true, content: [{ type: "text", text: "Missing itemId" }] };
					return runSprintDebugDone({
						cwd,
						itemId,
						area: p.area,
						filesChanged: p.filesChanged,
						locChanged: p.locChanged,
						behaviorPaths: p.behaviorPaths,
						stateMachineOrArchitectureChange: p.stateMachineOrArchitectureChange,
						reviewerBehaviorEvidenceMissing: p.reviewerBehaviorEvidenceMissing,
						evidence: p.evidence,
						note: p.note,
						finalizationGateMode: p.finalizationGateMode,
					});
				}
				const itemId = String(p.itemId || "").trim();
				if (!itemId) return { isError: true, content: [{ type: "text", text: "Missing itemId" }] };
				const gate = gateSprintEntryPoint(cwd, p.planningRoomId, "sprint");
				if (!gate.allowed) return sprintGateErrorResult(gate.details);
				const escalation = evaluateDebugEscalationForSprintDebug(cwd, itemId, p);
				const title = String(p.title || "").trim();
				const result = promoteDebugItem(cwd, itemId, title ? { title, escalation } : { escalation });
				return {
					content: [
						{ type: "text", text: `Promoted ${result.item.id} to ${result.task.id}` },
						{ type: "text", text: JSON.stringify({ item: result.item, task: result.task, escalation }) },
					],
				};
			} catch (error) {
				return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
			}
		},
	});

	pi.registerTool({
		name: "sprint_set_active",
		label: "Sprint: Set Active",
		description: "Set active sprint/task pointer.",
		promptSnippet: "Update active sprint/task pointers.",
		promptGuidelines: ["Use sprint_set_active to update pointers; if both sprintPath and taskId are provided, switch sprint first, then resolve task in that sprint."],
		parameters: Type.Object({ sprintPath: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const p = params as any;
			let sprintPathText: string | null = null;
			let taskPathText: string | null = null;
			if (p.sprintPath) {
				const current = loadCurrent(cwd) ?? { activeSprintPath: null, activeTaskPath: null, updatedAt: nowIso() };
				const normalized = normalizeActiveSprintPath(cwd, String(p.sprintPath));
				current.activeSprintPath = normalized.relativePath;
				if (!p.taskId) current.activeTaskPath = null;
				current.updatedAt = nowIso();
				saveCurrent(cwd, current);
				sprintPathText = current.activeSprintPath;
			}
			if (p.taskId) {
				const taskFile = setActiveTask(cwd, String(p.taskId));
				taskPathText = path.relative(cwd, taskFile);
			}
			const latest = loadCurrent(cwd);
			return {
				content: [
					{ type: "text", text: `Active pointers updated (sprint=${latest?.activeSprintPath ?? sprintPathText ?? "(unchanged)"}, task=${latest?.activeTaskPath ?? taskPathText ?? "(unchanged)"})` },
				],
			};
		},
	});

	pi.registerTool({
		name: "sprint_update_task",
		label: "Sprint: Update Task",
		description: "Update task status and append task notes/evidence. Operates on the session-bound sprint/task when this session is pinned to a task, otherwise on the global active sprint. When bound, refuses to update a taskId that does not match the bound task.",
		promptSnippet: "Update task status during implementation progress.",
		promptGuidelines: [
			"Use sprint_update_task to move task state and attach concise evidence notes.",
			"This tool will refuse to update a taskId that does not match the session-bound task. Sessions pinned to a single task cannot accidentally write to a different task.",
		],
		parameters: Type.Object({
			taskId: Type.String(),
			status: Type.Optional(Type.String()),
			note: Type.Optional(Type.String()),
			finalizationGateMode: Type.Optional(Type.Union([Type.Literal("strict"), Type.Literal("dry-run")])) ,
			finalizationGatePlanId: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as any;
			const taskId = String(p.taskId || "").trim();
			if (!taskId) return { isError: true, content: [{ type: "text", text: "Missing taskId" }] };
			const status = p.status ? String(p.status) : "in_progress";
			const mode = p.finalizationGateMode === "dry-run" ? "dry-run" : "strict";
			const sessionManager = (ctx as any).sessionManager;
			const binding = readSessionBinding(sessionManager);
			if (binding && binding.taskId !== taskId) {
				return {
					isError: true,
					content: [{
						type: "text",
						text: `Session is bound to ${binding.taskId}; refusing to update ${taskId}. This session is dedicated to a single sprint task.`,
					}],
				};
			}
			let finalizationGate;
			if (isFinalizationStatus(status)) {
				finalizationGate = evaluateSprintTaskFinalizationFromDisk({
					cwd: ctx.cwd,
					taskId,
					requestedStatus: status,
					mode,
					finalNote: p.note ? String(p.note) : undefined,
					finalEvidence: p.note ? String(p.note) : undefined,
					sessionManager,
					planId: p.finalizationGatePlanId ? String(p.finalizationGatePlanId) : undefined,
				});
				if (!finalizationGate.allowed && mode === "dry-run") {
					// dry-run never blocks the task update.
				} else if (!finalizationGate.allowed && mode === "strict") {
					return {
						isError: true,
						details: { finalizationGate },
						content: [
							{ type: "text", text: finalizationGate.summary },
							{ type: "text", text: `Blockers: ${finalizationGate.blockers.join("; ") || "none"}` },
							...(finalizationGate.warnings.length ? [{ type: "text", text: `Warnings: ${finalizationGate.warnings.join("; ")}` }] : []),
							{ type: "text", text: `recommendedStatus=${finalizationGate.recommendedStatus} recommendation=${finalizationGate.recommendation}` },
						],
					};
				}
			}
			const file = updateTaskStatus(ctx.cwd, taskId, status, p.note ? String(p.note) : undefined, sessionManager, binding?.taskPath);
			const content = [{ type: "text", text: `Updated ${path.basename(file)}` }];
			if (finalizationGate) {
				content.push({ type: "text", text: finalizationGate.summary });
				content.push({ type: "text", text: `recommendedStatus=${finalizationGate.recommendedStatus} recommendation=${finalizationGate.recommendation}` });
				if (finalizationGate.blockers.length) content.push({ type: "text", text: `Blockers: ${finalizationGate.blockers.join("; ")}` });
				if (finalizationGate.warnings.length) content.push({ type: "text", text: `Warnings: ${finalizationGate.warnings.join("; ")}` });
			}
			return { content, details: finalizationGate ? { finalizationGate } : undefined };
		},
	});

	pi.registerTool({
		name: "sprint_log_progress",
		label: "Sprint: Log Progress",
		description: "Append message to active sprint PROGRESS.md; uses the session-bound sprint when this session is pinned to a task.",
		promptSnippet: "Log notable sprint progress milestones.",
		promptGuidelines: ["Use sprint_log_progress after meaningful changes, checks, or decisions."],
		parameters: Type.Object({ message: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const msg = String((params as any).message || "").trim();
			if (!msg) return { isError: true, content: [{ type: "text", text: "Missing message" }] };
			appendProgress(ctx.cwd, msg, (ctx as any).sessionManager);
			return { content: [{ type: "text", text: "Logged" }] };
		},
	});

	pi.registerTool({
		name: "sprint_start_task_session",
		label: "Sprint: Start Task Session",
		description: "Start a sprint task session for TASK-ID with --auto-run. Uses ctx.newSession when available; falls back to placing the /sprint task start command in the editor. This command is gated by the PRD-first planning state for non-trivial work.",
		promptSnippet: "Start a sprint task session automatically when possible.",
		promptGuidelines: [
			"Use sprint_start_task_session to auto-start a task session; if ctx.newSession is unavailable it places the /sprint task start command in the editor for the user to run.",
			"Do not call this when the current session is already pinned to the same task.",
			"For non-trivial work the gate requires prd_started + prd_ready_for_sprint + sprint_confirmed; pass `planningRoomId` or set the dedicated planning-current pointer first.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "TASK-ID (e.g. TASK-001) to bind the new session to" }),
			planningRoomId: Type.Optional(Type.String({ description: "Optional planning room id. Falls back to .pi/workflow-runs/planning-current.json first, then to .pi/workflow-runs/current.json for compatibility." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const taskId = String((params as any).taskId || "").trim();
			if (!taskId) return { isError: true, content: [{ type: "text", text: "Missing taskId" }] };
			const gate = gateSprintEntryPoint(ctx.cwd, (params as any).planningRoomId, "sprint");
			if (!gate.allowed) return sprintGateErrorResult(gate.details);
			const newSession = (ctx as any).newSession;
			if (typeof newSession === "function") {
				try {
					const result = await startSprintTaskSession(ctx, taskId, { autoRun: true });
					return { content: [{ type: "text", text: result.message }] };
				} catch (error) {
					return {
						isError: true,
						content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					};
				}
			}
			// Fallback: automatic session start unavailable; prepare slash command in editor
			const command = `/sprint task start ${taskId} --auto-run`;
			const ui = (ctx as any).ui;
			let placedInEditor = false;
			if (ctx.hasUI && ui && typeof ui.setEditorText === "function") {
				try {
					ui.setEditorText(command);
					placedInEditor = true;
				} catch {
					// ignore; fall back to notification only
				}
			}
			if (ui && typeof ui.notify === "function") {
				const where = placedInEditor ? "Editor now contains" : "Run";
				ui.notify(
					`${where} ${command} to switch to a dedicated session for ${taskId}. Automatic session start is unavailable in this context; the user must run the command to switch sessions.`,
					"info",
				);
			}
			return {
				content: [{
					type: "text",
					text: `Automatic session start unavailable. Prepared command: ${command}. The user must run it to switch sessions.`,
				}],
			};
		},
	});

	pi.registerTool({
		name: "sprint_get_session_binding",
		label: "Sprint: Get Session Binding",
		description: "Read the session-pinned sprint/task binding for the current Pi session, if any.",
		promptSnippet: "Check whether the current session is pinned to a sprint task.",
		promptGuidelines: [
			"Use sprint_get_session_binding to confirm which task this session is dedicated to before doing task-scoped work.",
		],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const binding = readSessionBinding((ctx as any).sessionManager);
			return { content: [{ type: "text", text: JSON.stringify({ binding }) }] };
		},
	});
}
