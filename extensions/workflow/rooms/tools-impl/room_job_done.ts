// Workflow Rooms — `room_job_done` tool registration.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 1.

import * as fs from "node:fs";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { previewEvent } from "../prompt";
import {
	appendEventLine,
	getRoomAgentsPath,
	getRoomEventsPath,
	getRoomLockPath,
	isMessageRelevantTo,
	nextSeq,
	readAgentsFile,
	readEventsFile,
	resolveAgentIdFromParamsOrEnv,
	resolveRoleFromParamsOrEnv,
	resolveRoomIdFromParamsOrEnv,
	withRoomLock,
	writeAgentsFile,
} from "../store";
import { ROOM_UNREAD_PREVIEW_MAX, type RoomEvent } from "../types";
import { textResult } from "./text_result";

export function registerRoomJobDone(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "room_job_done",
		label: "Workflow Room Job Done",
		description:
			"Mark a job as done in the active room. By default refuses with isError if there are unread messages relevant to the calling agent; pass allowUnread=true to override and return previews of those messages.",
		promptSnippet: "Mark a job done in the active workflow room.",
		promptGuidelines: [
			"Call room_job_done only after you have called room_read and addressed any queued messages relevant to you.",
			"If room_job_done returns an error listing unread messages, read them, act on them, and retry.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			jobId: Type.String({ description: "Job identifier matching the prior room_job_start" }),
			summary: Type.Optional(Type.String()),
			filesChanged: Type.Optional(Type.Array(Type.String())),
			testsRun: Type.Optional(Type.Array(Type.String())),
			allowUnread: Type.Optional(
				Type.Boolean({ description: "Override the unread-message guard" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roomId = resolveRoomIdFromParamsOrEnv(params ?? {}, ctx.cwd);
			const agentId = resolveAgentIdFromParamsOrEnv(params ?? {});
			const role = resolveRoleFromParamsOrEnv(params ?? {}, agentId);
			const jobId = String(params?.jobId ?? "").trim();
			if (!jobId) return textResult("Missing jobId", true);
			const allowUnread = params?.allowUnread === true;
			const summary = typeof params?.summary === "string" ? params.summary.trim() : undefined;
			const filesChanged = Array.isArray(params?.filesChanged)
				? (params!.filesChanged as unknown[]).map((v) => String(v)).filter((v) => v.length > 0)
				: undefined;
			const testsRun = Array.isArray(params?.testsRun)
				? (params!.testsRun as unknown[]).map((v) => String(v)).filter((v) => v.length > 0)
				: undefined;

			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);
			const lockPath = getRoomLockPath(ctx.cwd, roomId);
			if (!fs.existsSync(eventsPath)) return textResult(`Room not found: ${roomId}. Call room_create first.`, true);

			let unread: RoomEvent[] = [];
			let appendedSeq = 0;

			await withRoomLock(lockPath, async () => {
				const events = readEventsFile(eventsPath);
				const agents = readAgentsFile(agentsPath);
				const existing = agents[agentId];
				const lastRead = existing?.lastReadSeq ?? 0;
				unread = events.filter((e) => e.seq > lastRead && isMessageRelevantTo(e, agentId));

				if (unread.length > 0 && !allowUnread) {
					return; // do not append
				}

				const event: RoomEvent = {
					seq: nextSeq(events),
					roomId,
					type: "job_done",
					from: agentId,
					jobId,
					summary,
					filesChanged,
					testsRun,
					createdAt: new Date().toISOString(),
				};
				appendEventLine(eventsPath, event);
				appendedSeq = event.seq;

				agents[agentId] = {
					agentId,
					role,
					status: "done",
					lastReadSeq: existing?.lastReadSeq ?? 0,
					updatedAt: new Date().toISOString(),
				};
				writeAgentsFile(agentsPath, agents);
			});

			if (unread.length > 0 && !allowUnread) {
				const previews = unread.slice(0, ROOM_UNREAD_PREVIEW_MAX).map(previewEvent);
				return {
					content: [
						{
							type: "text",
							text: `Refused: ${unread.length} unread relevant message(s) for ${agentId} in room ${roomId}. Read them via room_read, act on them, then retry. Pass allowUnread=true to override.\n` + previews.join("\n"),
						},
					],
					details: {
						roomId,
						agentId,
						jobId,
						unreadCount: unread.length,
						unread: unread.slice(0, ROOM_UNREAD_PREVIEW_MAX),
					},
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `job_done seq=${appendedSeq} room=${roomId} agent=${agentId} jobId=${jobId}${allowUnread ? " (allowUnread)" : ""}`,
					},
				],
				details: {
					roomId,
					agentId,
					jobId,
					seq: appendedSeq,
					allowUnread,
					unreadOverridden: unread.length,
				},
			};
		},
	});
}
