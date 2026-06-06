// Workflow Rooms — `room_read` tool registration.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 1.

import * as fs from "node:fs";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { previewEvent } from "../prompt";
import {
	getRoomAgentsPath,
	getRoomEventsPath,
	getRoomLockPath,
	isMessageRelevantTo,
	readAgentsFile,
	readEventsFile,
	resolveAgentIdFromParamsOrEnv,
	resolveRoleFromParamsOrEnv,
	resolveRoomIdFromParamsOrEnv,
	withRoomLock,
	writeAgentsFile,
} from "../store";
import { ROOM_READ_DEFAULT_LIMIT, type RoomAgentState, type RoomEvent } from "../types";
import { textResult } from "./text_result";

export function registerRoomRead(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "room_read",
		label: "Workflow Room Read",
		description:
			"Read events from the active room after the given cursor. By default also advances the calling agent's lastReadSeq so subsequent room_job_done guards treat those events as read.",
		promptSnippet: "Read queued room events after a cursor.",
		promptGuidelines: [
			"Call room_read after heavy work and before finalizing to catch messages from other agents.",
			"Use markRead=true (default) so room_job_done doesn't reject on already-seen messages.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			afterSeq: Type.Optional(
				Type.Number({
					description: "Return events with seq > afterSeq; defaults to the agent's lastReadSeq",
				}),
			),
			markRead: Type.Optional(
				Type.Boolean({
					description: "If true, advance the agent's lastReadSeq to the latest seq returned. Default: true.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: `Maximum events to return. Default: ${ROOM_READ_DEFAULT_LIMIT}`,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roomId = resolveRoomIdFromParamsOrEnv(params ?? {}, ctx.cwd);
			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);
			const lockPath = getRoomLockPath(ctx.cwd, roomId);
			if (!fs.existsSync(eventsPath))
				return textResult(`Room not found or empty: ${roomId}. Call room_create first.`, true);

			const agentId = resolveAgentIdFromParamsOrEnv(params ?? {});
			const role = resolveRoleFromParamsOrEnv(params ?? {}, agentId);
			const markRead = params?.markRead !== false;
			const limit = Math.max(
				1,
				Math.min(2000, Number(params?.limit ?? ROOM_READ_DEFAULT_LIMIT) || ROOM_READ_DEFAULT_LIMIT),
			);

			let cursor = 0;
			let returnedEvents: RoomEvent[] = [];
			let unreadRelevant = 0;
			let latestSeq = 0;
			let latestAvailableSeq = 0;
			let hasMore = false;
			let markReadSkippedAhead = false;
			let agentLastRead = 0;
			let agentStatus: RoomAgentState["status"] | undefined;

			await withRoomLock(lockPath, async () => {
				const events = readEventsFile(eventsPath);
				const agents = readAgentsFile(agentsPath);
				const existing = agents[agentId];
				agentLastRead = existing?.lastReadSeq ?? 0;
				agentStatus = existing?.status;
				const requestedAfter =
					typeof params?.afterSeq === "number" ? Math.max(0, Math.floor(params.afterSeq)) : agentLastRead;
				cursor = requestedAfter;
				const filtered = events.filter((e) => e.seq > cursor);
				returnedEvents = filtered.slice(0, limit);
				hasMore = filtered.length > returnedEvents.length;
				// latestSeq = max seq among RETURNED events (used to advance lastReadSeq).
				for (const e of returnedEvents) if (e.seq > latestSeq) latestSeq = e.seq;
				// latestAvailableSeq = max seq among ALL events after the cursor (for display / hasMore).
				for (const e of filtered) if (e.seq > latestAvailableSeq) latestAvailableSeq = e.seq;
				// unreadRelevant = count of relevant messages after the agent's actual lastReadSeq,
				// not just after the (potentially manually supplied) cursor. When markRead=true,
				// report the post-read count so agents can trust it before room_job_done.
				const countUnreadRelevant = (afterSeq: number) =>
					events.filter((e) => e.seq > afterSeq && isMessageRelevantTo(e, agentId)).length;
				unreadRelevant = countUnreadRelevant(agentLastRead);

				if (markRead && requestedAfter > agentLastRead) {
					markReadSkippedAhead = true;
					return;
				}

				if (markRead) {
					const newLastRead = Math.max(agentLastRead, latestSeq);
					agents[agentId] = {
						agentId,
						role,
						status: existing?.status ?? "active",
						lastReadSeq: newLastRead,
						updatedAt: new Date().toISOString(),
					};
					writeAgentsFile(agentsPath, agents);
					agentLastRead = newLastRead;
					unreadRelevant = countUnreadRelevant(agentLastRead);
				}
			});

			if (markReadSkippedAhead) {
				return {
					content: [
						{
							type: "text",
							text: `Refused: markRead=true with afterSeq=${cursor} would skip this agent's stored lastReadSeq=${agentLastRead}. Call room_read without afterSeq to advance the cursor safely, or use markRead=false for a lookahead read.`,
						},
					],
					details: {
						roomId,
						agentId,
						afterSeq: cursor,
						lastReadSeq: agentLastRead,
						latestAvailableSeq,
						hasMore,
					},
					isError: true,
				};
			}

			const lines = returnedEvents.map(previewEvent);
			const summaryLine = `room=${roomId} afterSeq=${cursor} returned=${returnedEvents.length} latestSeq=${latestSeq} latestAvailableSeq=${latestAvailableSeq} hasMore=${hasMore} unreadRelevant=${unreadRelevant}`;
			const text = lines.length
				? `${summaryLine}\n` + lines.join("\n")
				: `${summaryLine} (no events)`;
			return {
				content: [{ type: "text", text }],
				details: {
					roomId,
					agentId,
					afterSeq: cursor,
					markRead,
					limit,
					returnedCount: returnedEvents.length,
					events: returnedEvents,
					latestSeq,
					latestAvailableSeq,
					hasMore,
					lastReadSeq: agentLastRead,
					unreadRelevant,
					agentStatus,
				},
			};
		},
	});
}
