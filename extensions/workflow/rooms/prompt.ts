// Workflow Rooms — prompt block builder and event preview.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 1.

import type { AgentName } from "../types";
import {
	ROOM_BODY_PREVIEW,
	ROOM_DIR_NAME,
	ROOM_ENV_AGENT_ID,
	ROOM_ENV_AGENT_ROLE,
	ROOM_ENV_ROOM_ID,
	type ResolvedRoomContext,
	type RoomEvent,
} from "./types";

function truncateText(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}

export function buildRoomCommunicationBlock(agent: AgentName, room: ResolvedRoomContext): string {
	return `## Workflow Room Communication (v1, durable async)

You are running as ${room.agentId} (role: ${room.role}, sub-agent of ${agent}) inside workflow room "${room.roomId}".

Room context is provided via env vars (${ROOM_ENV_ROOM_ID}, ${ROOM_ENV_AGENT_ID}, ${ROOM_ENV_AGENT_ROLE}) and may be overridden via tool params. The room is a durable async coordination queue persisted under .pi/${ROOM_DIR_NAME}/${room.roomId}/. Treat it as an audit log; do not rely on real-time interruption.

Required checkpoint flow at job boundaries:
1. Call room_job_start({ jobId, summary, owns }) BEFORE doing meaningful work to register yourself, your jobId, and your scope/ownership so other agents can see you.
2. Use room_send({ to?, topic, message }) for assumptions, contracts, blockers, and decisions. Bodies must be self-contained and specific. Omit 'to' to broadcast; set it to another agentId to direct a message.
3. Call room_read({ markRead: true }) AFTER heavy work and BEFORE finalizing to pick up queued messages from other agents.
4. Call room_job_done({ jobId, summary, filesChanged, testsRun }) when finished. If it returns an error listing unread relevant messages, address them (use room_send to reply/resolve or update your job), then retry room_job_done.
5. Do not silently change shared contracts (public APIs, file ownership boundaries, schema, dependencies). If you must, announce it via room_send first and wait for acknowledgment if other agents depend on it.

Storage layout: events.jsonl (append-only, monotonic seq) and agents.json (per-agent read cursor and status). Use the same jobId across all room_* calls within a single delegated job so other agents can correlate.

If roomId, agentId, or role is missing from both params and env, call room_status or stop and report back to Brain.`;
}

export function previewEvent(event: RoomEvent): string {
	const base = `#${event.seq} ${event.type}${event.from ? ` from=${event.from}` : ""}${event.to ? ` to=${event.to}` : ""}${event.topic ? ` [${event.topic}]` : ""}`;
	const body = typeof event.body === "string" ? truncateText(event.body, ROOM_BODY_PREVIEW) : "";
	return body ? `${base}\n${body}` : base;
}
