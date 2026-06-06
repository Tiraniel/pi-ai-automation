// Workflow Rooms — `room_job_start` tool registration.
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

export function registerRoomJobStart(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "room_job_start",
		label: "Workflow Room Job Start",
		description:
			"Register a new job for an agent in the active room. Records jobId, summary, and optional file ownership so other agents can see scope. Must be called before room_send/room_read/room_job_done for the same job.",
		promptSnippet: "Register a job in the active workflow room.",
		promptGuidelines: [
			"Call room_job_start before doing meaningful work when room context is active.",
			"Use a stable jobId so other agents and your later room_job_done can reference this job.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			jobId: Type.String({ description: "Job identifier (e.g. 'backend-auth', 'reviewer-tests')" }),
			summary: Type.Optional(Type.String({ description: "One-line summary of the job" })),
			owns: Type.Optional(
				Type.Array(Type.String(), {
					description: "File paths or globs this job owns; advisory to avoid conflicts",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roomId = resolveRoomIdFromParamsOrEnv(params ?? {}, ctx.cwd);
			const agentId = resolveAgentIdFromParamsOrEnv(params ?? {});
			const role = resolveRoleFromParamsOrEnv(params ?? {}, agentId);
			const jobId = String(params?.jobId ?? "").trim();
			if (!jobId) return textResult("Missing jobId", true);
			const summary = typeof params?.summary === "string" ? params.summary.trim() : undefined;
			const owns = Array.isArray(params?.owns)
				? (params!.owns as unknown[]).map((v) => String(v)).filter((v) => v.length > 0)
				: undefined;

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
					type: "job_start",
					from: agentId,
					jobId,
					summary,
					owns,
					createdAt: new Date().toISOString(),
				};
				appendEventLine(eventsPath, event);
				appendedSeq = event.seq;

				const agents = readAgentsFile(agentsPath);
				const existing = agents[agentId];
				agents[agentId] = {
					agentId,
					role,
					status: "active",
					lastReadSeq: existing?.lastReadSeq ?? 0,
					updatedAt: new Date().toISOString(),
				};
				writeAgentsFile(agentsPath, agents);
			});

			return {
				content: [
					{
						type: "text",
						text: `job_start seq=${appendedSeq} room=${roomId} agent=${agentId} role=${role} jobId=${jobId}`,
					},
				],
				details: { roomId, agentId, role, jobId, seq: appendedSeq },
			};
		},
	});
}
