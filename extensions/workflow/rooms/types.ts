// Workflow Rooms (v1: durable async coordination) — shared types and constants.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 1.

export const ROOM_DIR_NAME = "workflow-runs";
export const ROOM_LOCK_TIMEOUT_MS = 5000;
export const ROOM_LOCK_RETRY_BASE_MS = 25;
export const ROOM_DEFAULT_AGENT_ID = "agent";
export const ROOM_ENV_ROOM_ID = "PI_WORKFLOW_ROOM_ID";
export const ROOM_ENV_AGENT_ID = "PI_WORKFLOW_AGENT_ID";
export const ROOM_ENV_AGENT_ROLE = "PI_WORKFLOW_AGENT_ROLE";
export const ROOM_ENV_ROOM_ROOT = "PI_WORKFLOW_ROOM_ROOT";
export const ROOM_BRAIN_AGENT_ID = "brain";
export const ROOM_TOOL_NAMES = [
	"room_create",
	"room_job_start",
	"room_send",
	"room_read",
	"room_job_done",
	"room_status",
] as const;
export const ROOM_ID_MAX = 64;
export const AGENT_ID_MAX = 64;
export const ROLE_MAX = 32;
export const ROOM_READ_DEFAULT_LIMIT = 200;
export const ROOM_UNREAD_PREVIEW_MAX = 5;
export const ROOM_BODY_PREVIEW = 240;

export type RoomEventType = "room_created" | "job_start" | "message" | "job_done";

export interface RoomEvent {
	seq: number;
	roomId: string;
	type: RoomEventType;
	from?: string;
	to?: string;
	topic?: string;
	body?: string;
	jobId?: string;
	summary?: string;
	owns?: string[];
	filesChanged?: string[];
	testsRun?: string[];
	createdAt: string;
	[key: string]: unknown;
}

export interface RoomAgentState {
	agentId: string;
	role: string;
	status: "active" | "done" | "aborted";
	lastReadSeq: number;
	updatedAt: string;
}

export interface ResolvedRoomContext {
	roomId: string;
	agentId: string;
	role: string;
}
