// Workflow deep-planning planner orchestration (Phase A, isolated contract block).
// Registers `workflow_deep_plan` and launches bounded-headless planning delegates
// in a durable workflow room using the existing room store helpers.

import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ThinkingLevelSchema,
	type DeepPlanningSummary,
	type PlannerRoundResult,
	appendRoomMessage,
	buildPlannerPreset,
	ensurePlanningRoom,
	isEnabledByConfig,
	mergeDeepPlanningConfig,
	normalizeDeepPlanningToolPlanners,
	readRoomTranscriptPreview,
	roomReadCommand,
	summarizeResult,
	TOOL_NAME,
	MAX_ROOM_PREVIEW_LINES,
	plannerDescriptor,
	readDeepPlanningTranscript as readCoreDeepPlanningTranscript,
} from "./deep-planning-core";
import { sanitizeAgentId } from "./rooms/store";
import { loadWorkflowConfig } from "./runtime/config";
import { runAgentPresetHeadless } from "./delegate/headless";

export function registerDeepPlanningTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Deep planning",
		description: "Run read-only deep-planning delegates before Brain starts implementation delegation.",
		promptSnippet: "Run planning-only multi-round deep-planning round-table and return summary for Brain synthesis.",
		promptGuidelines: [
			"Use this tool for opt-in deep planning before coder delegation.",
			"Planners must not write files or run edit/write/bash style changes.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Task to be planned" }),
			cwd: Type.Optional(Type.String({ description: "Optional working directory for planner delegates" })),
			roomId: Type.Optional(Type.String({ description: "Optional room id; auto-generates if omitted" })),
			title: Type.Optional(Type.String({ description: "Optional room title" })),
			force: Type.Optional(Type.Boolean({ description: "Run even when deep-planning is disabled" })),
			plannerCount: Type.Optional(Type.Integer({ minimum: 1 })),
			rounds: Type.Optional(Type.Integer({ minimum: 1 })),
			maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
			planners: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.Optional(Type.String({ description: "Planner id" })),
						role: Type.Optional(Type.String({ description: "Planner role" })),
						provider: Type.Optional(Type.String({ description: "Planner provider" })),
						model: Type.Optional(Type.String({ description: "Planner model" })),
						modelPreset: Type.Optional(Type.String({ description: "Planner model preset (for v2 configs)" })),
						thinkingLevel: Type.Optional(ThinkingLevelSchema),
						instructions: Type.Optional(Type.String({ description: "Planner-specific instructions" })),
					}),
				),
			),
		}),
		renderCall(args: any, theme) {
			const task = String((args as any)?.task ?? "").trim();
			const planners = normalizeDeepPlanningToolPlanners((args as any)?.planners);
			const merged = mergeDeepPlanningConfig(undefined, {
				force: (args as any)?.force === true,
				plannerCount: (args as any)?.plannerCount,
				rounds: (args as any)?.rounds,
				maxConcurrency: (args as any)?.maxConcurrency,
				planners,
			});
			const body = `workflow_deep_plan: task=${task ? `${task.slice(0, 80)}${task.length > 80 ? "…" : ""}` : "(no task)"}`;
			const details = `rounds=${merged.rounds} planners=${merged.planners?.length ?? 0} maxConcurrency=${merged.maxConcurrency}`;
			return new Text(`${theme.fg("toolTitle", theme.bold("workflow_deep_plan"))} ${theme.fg("accent", body)}\n${theme.fg("dim", details)}`, 0, 0);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const task = String((params as any)?.task ?? "").trim();
			if (!task) {
				return {
					content: [{ type: "text", text: "Missing planning task." }],
					details: { status: "failed" },
					isError: true,
				};
			}

			const cfgFromFile = loadWorkflowConfig(ctx.cwd);
			const requestedPlanners = normalizeDeepPlanningToolPlanners((params as any)?.planners);
			const force = (params as any)?.force === true;
			const effective = mergeDeepPlanningConfig(cfgFromFile.config.deepPlanning, {
				force,
				plannerCount: (params as any)?.plannerCount,
				rounds: (params as any)?.rounds,
				maxConcurrency: (params as any)?.maxConcurrency,
				planners: requestedPlanners,
			});
			const explicitPlannerOverride = requestedPlanners.length > 0;
			const explicitTuning = (params as any)?.plannerCount !== undefined
				|| (params as any)?.rounds !== undefined
				|| (params as any)?.maxConcurrency !== undefined;
			if (!force && !explicitPlannerOverride && !explicitTuning && !isEnabledByConfig(effective)) {
				return {
					content: [{
						type: "text",
						text:
							"Deep-planning is disabled by configuration. Set deepPlanning.enabled=true or pass force/plannerCount/rounds/maxConcurrency/planners to run an explicit deep-planning pass.",
					}],
					details: { enabled: false, mode: "disabled-no-override" },
				};
			}

			const workflowRoot = ctx.cwd;
			const plannerCwd = typeof (params as any)?.cwd === "string" ? String((params as any).cwd) : undefined;
			const room = await ensurePlanningRoom(
				workflowRoot,
				typeof (params as any)?.roomId === "string" ? String((params as any).roomId) : undefined,
				typeof (params as any)?.title === "string" ? String((params as any).title) : undefined,
				effective.roomIdPrefix || "deep-plan",
			);

			await appendRoomMessage(
				workflowRoot,
				room.roomId,
				sanitizeAgentId("brain"),
				"brain",
				`Deep-planning task: ${roomReadCommand(task)}`,
				"contract",
			);
			await appendRoomMessage(
				workflowRoot,
				room.roomId,
				sanitizeAgentId("brain"),
				"brain",
				`Planner params -> rounds: ${effective.rounds}; plannerCount: ${effective.plannerCount}; maxConcurrency: ${effective.maxConcurrency}`,
				"params",
			);

			const sourcePlanners = effective.planners && effective.planners.length > 0 ? effective.planners : [];
			const selectedPlanners = sourcePlanners.slice(0, effective.plannerCount);
			if (!selectedPlanners.length) {
				return {
					content: [{ type: "text", text: "No planners configured for deep-planning after normalization." }],
					details: { roomId: room.roomId, reason: "no-planners" },
					isError: true,
				};
			}

			const results: PlannerRoundResult[] = [];
			const rounds = effective.rounds ?? 1;
			const maxConcurrency = effective.maxConcurrency ?? selectedPlanners.length;
			const workerConcurrency = Math.max(1, Math.min(maxConcurrency, selectedPlanners.length));
			const plannerRounds = Math.max(1, rounds);
			for (let round = 1; round <= plannerRounds; round++) {
				const queue = selectedPlanners.map((planner, index) => ({ planner, index }));
				let cursor = 0;
				const runPlanner = async () => {
					while (cursor < queue.length) {
						if (signal?.aborted) return;
						const next = queue[cursor++];
						if (!next) continue;
						const planner = next.planner;
						const plannerId = sanitizeAgentId(planner.id || `planner-${next.index + 1}`);
						const plannerRole = sanitizeAgentId(planner.role || `planner-${next.index + 1}`);
						const roomContext = {
							roomId: room.roomId,
							agentId: plannerId,
							role: plannerRole,
						};
						await appendRoomMessage(
							workflowRoot,
							room.roomId,
							plannerId,
							plannerRole,
							`Starting round ${round} with planner ${plannerId}`,
							"round-start",
						);
						const result = await runAgentPresetHeadless(
							ctx,
							"reviewer",
							buildPlannerPreset(planner, task, round, rounds),
							`Run ${round} of ${rounds} for deep-planning: ${task}`,
							plannerCwd,
							signal,
							undefined,
							roomContext,
						);
						results.push({
							plannerId,
							plannerRole,
							round,
							status: result.status ?? "completed",
							exitCode: result.exitCode,
							model: result.model,
							thinkingLevel: result.thinkingLevel,
							reason: result.stopReason,
							outputPreview: summarizeResult(result),
						});
						await appendRoomMessage(
							workflowRoot,
							room.roomId,
							plannerId,
							plannerRole,
							`round ${round} done (status=${result.status ?? "completed"})`,
							"round-complete",
						);
					}
				};
				await Promise.all(Array.from({ length: workerConcurrency }, () => runPlanner()));
			}

			const transcript = readRoomTranscriptPreview(workflowRoot, room.roomId, MAX_ROOM_PREVIEW_LINES);
			const summary: DeepPlanningSummary = {
				roomId: room.roomId,
				roomDir: room.roomDir,
				enabled: true,
				rounds: plannerRounds,
				plannerCount: selectedPlanners.length,
				maxConcurrency: workerConcurrency,
				planners: selectedPlanners.map(plannerDescriptor),
				plannerResults: results,
				transcriptPreview: transcript,
			};
			const failed = results.some((result) => result.status !== "completed" || result.exitCode !== 0);
			return {
				content: [{
					type: "text",
					text: `Deep-planning complete in room ${room.roomId}. ${failed ? "Some planners failed; review plannerResults for details." : "All planners finished."}`,
				}],
				details: summary,
				isError: failed,
			};
		},
	});
}

export function readDeepPlanningTranscript(cwd: string, roomId: string, limit = MAX_ROOM_PREVIEW_LINES): string[] {
	return readCoreDeepPlanningTranscript(cwd, roomId, limit);
}
