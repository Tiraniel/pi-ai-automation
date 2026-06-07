// Sprint subsystem — public barrel.
// Extracted from extensions/sprint-system.ts as part of TASK-018 Slice 4.
//
// See ./types.ts for shared types and constants, ./store.ts for the fs /
// sprint-lifecycle / task / session-binding / heuristic helpers, ./prompt.ts
// for the session-binding/global-pointer/auto-run prompt text builders,
// ./command.ts for the `/sprint` slash command registration, ./tools.ts
// for the AI-facing `sprint_*` tool registration, and ./hooks.ts for the
// `before_agent_start` hook registration. The thin composition root
// extensions/sprint-system.ts re-exports `registerSprintCommand`,
// `registerSprintTools`, and `registerSprintHooks`.

export {
	DEFAULT_CONFIG,
	SPRINT_BINDING_CUSTOM_TYPE,
	SPRINTS_DIR,
	type AutoCreateMode,
	type SessionBinding,
	type SprintConfig,
	type SprintCurrent,
} from "./types";

export {
	activeSprintAbs,
	appendFile,
	appendProgress,
	askUi,
	askUiInput,
	createEpic,
	createSprint,
	createTask,
	deriveSprintName,
	ensureFile,
	ensurePrivateGitExclusion,
	findTaskFileInSprint,
	getGlobalAutoCreate,
	initSprints,
	isNonTrivialPrompt,
	loadCurrent,
	nextEpicId,
	nextTaskId,
	normalizeActiveSprintPath,
	normalizeActiveTaskPath,
	nowIso,
	parseArgs,
	parseTaskFile,
	readJson,
	readSessionBinding,
	resolveSprintAbs,
	rootPaths,
	safeSlug,
	saveCurrent,
	setActiveTask,
	sprintIdFromName,
	updateTaskStatus,
	writeJson,
	writeTaskFile,
} from "./store";

export {
	DEFAULT_BRAIN_MARKERS_BLOCK,
	EMPTY_BRAIN_MARKERS,
	formatBrainMarkersForPrompt,
	parseBrainMarkersFromText,
	readBrainMarkersForTaskFile,
	type BrainAgentMarker,
	type BrainContractMarker,
	type BrainMarkers,
	type BrainParallelMode,
} from "./markers";

export {
	appendDebugNote,
	completeDebugItem,
	createDebugItem,
	ensureDebugLane,
	promoteDebugItem,
	readDebugLaneSummary,
	type DebugItem,
	type DebugItemStatus,
	type DebugLaneSummary,
} from "./debug";

export { buildTaskSessionKickoff, sessionBindingPromptText, sprintPointerText } from "./prompt";

export { registerSprintCommand } from "./command";
export { registerSprintTools } from "./tools";
export { registerSprintHooks } from "./hooks";
