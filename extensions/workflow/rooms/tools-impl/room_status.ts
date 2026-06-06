// Workflow Rooms — `room_status` tool registration.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 1.

import * as fs from "node:fs";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	getRoomAgentsPath,
	getRoomEventsPath,
	isMessageRelevantTo,
	readAgentsFile,
	readEventsFile,
	resolveAgentIdFromParamsOrEnv,
	resolveRoomIdFromParamsOrEnv,
} from "../store";
import { textResult } from "./text_result";

export function registerRoomStatus(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "room_status",
		label: "Workflow Room Status",
		description:
			"Summarize the active room: latest seq, agents, and (when agentId is known) the number of unread messages relevant to that agent.",
		promptSnippet: "Summarize the active workflow room.",
		promptGuidelines: [
			"Use room_status to inspect what other agents have done and what is queued for you.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roomId = resolveRoomIdFromParamsOrEnv(params ?? {}, ctx.cwd);
			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);
			if (!fs.existsSync(eventsPath)) return textResult(`Room not found: ${roomId}. Call room_create first.`, true);
			const events = readEventsFile(eventsPath);
			const agents = readAgentsFile(agentsPath);
			let latestSeq = 0;
			for (const e of events) if (e.seq > latestSeq) latestSeq = e.seq;

			let callerSummary: {
				agentId: string;
				lastReadSeq: number;
				unreadRelevant: number;
				status?: string;
			} | null = null;
			let callerAgentId: string | null = null;
			try {
				callerAgentId = resolveAgentIdFromParamsOrEnv(params ?? {});
			} catch {
				callerAgentId = null;
			}
			if (callerAgentId) {
				const state = agents[callerAgentId];
				const lastRead = state?.lastReadSeq ?? 0;
				const unreadRelevant = events.filter(
					(e) => e.seq > lastRead && isMessageRelevantTo(e, callerAgentId),
				).length;
				callerSummary = {
					agentId: callerAgentId,
					lastReadSeq: lastRead,
					unreadRelevant,
					status: state?.status,
				};
			}

			const agentList = Object.values(agents).map(
				(a) =>
					`${a.agentId} (role=${a.role}, status=${a.status}, lastReadSeq=${a.lastReadSeq})`,
			);
			const lines = [
				`room=${roomId} events=${events.length} latestSeq=${latestSeq}`,
				`agents (${agentList.length}): ${agentList.length ? agentList.join("; ") : "(none)"}`,
			];
			if (callerSummary) {
				lines.push(
					`you (${callerSummary.agentId}): lastReadSeq=${callerSummary.lastReadSeq} unreadRelevant=${callerSummary.unreadRelevant} status=${callerSummary.status ?? "unknown"}`,
				);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { roomId, latestSeq, events: events.length, agents, caller: callerSummary },
			};
		},
	});
}
