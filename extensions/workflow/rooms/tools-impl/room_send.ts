// Workflow Rooms — `room_send` tool registration.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 1.

import * as fs from "node:fs";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	appendEventLine,
	getRoomAgentsPath,
	getRoomDir,
	getRoomEventsPath,
	getRoomLockPath,
	nextSeq,
	readAgentsFile,
	readEventsFile,
	resolveAgentIdFromParamsOrEnv,
	resolveRoleFromParamsOrEnv,
	resolveRoomIdFromParamsOrEnv,
	withRoomLock,
	writeAgentsFile,
} from "../store";
import type { RoomEvent } from "../types";
import { textResult } from "./text_result";

export function registerRoomSend(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "room_send",
		label: "Workflow Room Send",
		description:
			"Append a message to the active room. Omit 'to' to broadcast; set 'to' to a specific agentId to direct it. Messages persist under .pi/workflow-runs/<roomId>/events.jsonl.",
		promptSnippet: "Send a message into the active workflow room.",
		promptGuidelines: [
			"Use room_send for assumptions, contracts, blockers, and decisions that other agents need to see.",
			"Omit 'to' for broadcast; set 'to' to a specific agentId to direct a message.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			to: Type.Optional(Type.String({ description: "Target agentId; omit to broadcast" })),
			topic: Type.Optional(Type.String({ description: "Short topic label" })),
			message: Type.String({ description: "Message body" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roomId = resolveRoomIdFromParamsOrEnv(params ?? {}, ctx.cwd);
			const agentId = resolveAgentIdFromParamsOrEnv(params ?? {});
			const role = resolveRoleFromParamsOrEnv(params ?? {}, agentId);
			const message = String(params?.message ?? "").trim();
			if (!message) return textResult("Missing message", true);
			const to = typeof params?.to === "string" && params.to.trim() ? params.to.trim() : undefined;
			const topic = typeof params?.topic === "string" && params.topic.trim() ? params.topic.trim() : undefined;

			const roomDir = getRoomDir(ctx.cwd, roomId);
			if (!fs.existsSync(roomDir)) return textResult(`Room not found: ${roomId}. Call room_create first.`, true);
			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);
			const lockPath = getRoomLockPath(ctx.cwd, roomId);

			let appendedSeq = 0;
			await withRoomLock(lockPath, async () => {
				const events = readEventsFile(eventsPath);
				const event: RoomEvent = {
					seq: nextSeq(events),
					roomId,
					type: "message",
					from: agentId,
					to,
					topic,
					body: message,
					createdAt: new Date().toISOString(),
				};
				appendEventLine(eventsPath, event);
				appendedSeq = event.seq;

				const agents = readAgentsFile(agentsPath);
				const existing = agents[agentId];
				agents[agentId] = {
					agentId,
					role,
					status: existing?.status ?? "active",
					lastReadSeq: existing?.lastReadSeq ?? 0,
					updatedAt: new Date().toISOString(),
				};
				writeAgentsFile(agentsPath, agents);
			});

			return {
				content: [
					{
						type: "text",
						text: `message seq=${appendedSeq} room=${roomId} from=${agentId}${to ? ` to=${to}` : " (broadcast)"}${topic ? ` [${topic}]` : ""}`,
					},
				],
				details: { roomId, agentId, to, topic, seq: appendedSeq },
			};
		},
	});
}
