// Workflow Rooms — public barrel for the extracted room subsystem.
// See ./types.ts for shared types/constants, ./store.ts for fs/lock/resolvers,
// ./prompt.ts for the system-prompt block and event preview,
// and ./tools.ts for the ExtensionAPI tool registration entry point.

export {
	AGENT_ID_MAX,
	ROOM_BODY_PREVIEW,
	ROOM_BRAIN_AGENT_ID,
	ROOM_DEFAULT_AGENT_ID,
	ROOM_DIR_NAME,
	ROOM_ENV_AGENT_ID,
	ROOM_ENV_AGENT_ROLE,
	ROOM_ENV_ROOM_ID,
	ROOM_ENV_ROOM_ROOT,
	ROOM_ID_MAX,
	ROOM_LOCK_RETRY_BASE_MS,
	ROOM_LOCK_TIMEOUT_MS,
	ROOM_READ_DEFAULT_LIMIT,
	ROOM_TOOL_NAMES,
	ROOM_UNREAD_PREVIEW_MAX,
	ROLE_MAX,
	type ResolvedRoomContext,
	type RoomAgentState,
	type RoomEvent,
	type RoomEventType,
} from "./types";

export {
	appendAgentIdSuffix,
	appendEventLine,
	ensureDir,
	generateRoomId,
	getRoomAgentsPath,
	getRoomCurrentPointerPath,
	getRoomDir,
	getRoomEventsPath,
	getRoomLockPath,
	getWorkflowRunsRoot,
	isMessageRelevantTo,
	nextSeq,
	nowIso,
	readAgentsFile,
	readCurrentRoomPointer,
	readEventsFile,
	resolveAgentIdFromParamsOrEnv,
	resolveRoleFromParamsOrEnv,
	resolveRoomContextFromDelegateParams,
	resolveRoomIdFromParamsOrEnv,
	sanitizeAgentId,
	sanitizeRole,
	sanitizeRoomId,
	withRoomLock,
	writeAgentsFile,
	writeCurrentRoomPointer,
} from "./store";

export { buildRoomCommunicationBlock, previewEvent } from "./prompt";
export { registerRoomTools } from "./tools";
