// Sprint subsystem composition root.
// Extracted from extensions/sprint-system.ts as part of TASK-018 Slice 4.
// The original 974-LOC file held types, fs helpers, prompt text builders,
// the `/sprint` command, the nine `sprint_*` AI-facing tools, and the
// `before_agent_start` hook. All of those now live under ./sprint
// (types.ts, store.ts, prompt.ts, command.ts, tools.ts, hooks.ts). This
// file is the thin composition root that just wires them into the
// ExtensionAPI.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerSprintCommand,
	registerSprintHooks,
	registerSprintShipTools,
	registerSprintTools,
} from "./sprint";

export default function sprintSystem(pi: ExtensionAPI) {
	registerSprintCommand(pi);
	registerSprintTools(pi);
	registerSprintShipTools(pi);
	registerSprintHooks(pi);
}
