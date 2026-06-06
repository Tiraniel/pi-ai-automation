// Sprint subsystem — shared types and constants.
// Extracted from extensions/sprint-system.ts as part of TASK-018 Slice 4.
//
// All `sprint_*` tool/command/hook code, plus the .sprints on-disk format
// reference lives here so callers do not need to import the original
// sprint-system.ts (which is now a thin composition root). The shapes
// below match the v1 .sprints substrate (config.json, current.json,
// sessions pinned via custom entries of type `sprintBinding`).

export type AutoCreateMode = "always" | "ask" | "never";

export type SprintConfig = {
	version: number;
	visibility: "committed" | "private";
	autoCreate: AutoCreateMode;
	defaultTracker: "linear";
	linear: { enabled: boolean; teamKey: string | null; projectId: string | null };
};

export type SprintCurrent = {
	activeSprintPath: string | null;
	activeTaskPath: string | null;
	updatedAt: string;
};

export type SessionBinding = {
	sprintPath: string;
	taskPath: string;
	taskId: string;
	title: string;
	boundAt: string;
};

export const SPRINT_BINDING_CUSTOM_TYPE = "sprintBinding";

export const SPRINTS_DIR = ".sprints";

export const DEFAULT_CONFIG: SprintConfig = {
	version: 1,
	visibility: "committed",
	autoCreate: "ask",
	defaultTracker: "linear",
	linear: { enabled: false, teamKey: null, projectId: null },
};
