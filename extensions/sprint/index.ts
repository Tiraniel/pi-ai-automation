// Sprint subsystem — public barrel.
//
// The sprint module's interface is deliberately small: the four register*
// entry points the composition root (extensions/sprint-system.ts) wires into
// the ExtensionAPI, plus the shared public types. Internal helpers (store,
// markers, debug lane, prompt builders) are imported from their own files by
// the modules that need them; re-exporting them here only widened the seam.

export {
	DEFAULT_CONFIG,
	SPRINT_BINDING_CUSTOM_TYPE,
	SPRINTS_DIR,
	type AutoCreateMode,
	type SessionBinding,
	type SprintConfig,
	type SprintCurrent,
} from "./types";

export { registerSprintCommand } from "./command";
export { registerSprintTools } from "./tools";
export { registerSprintShipTools } from "./ship-tools";
export { registerSprintHooks } from "./hooks";
