// Workflow Rooms — ExtensionAPI tool registration orchestrator.
// The original makeRoomTools body is split across per-tool files under
// ./tools-impl/ to keep each module under the 500-line budget. Public export
// `registerRoomTools` is preserved so consumers (brain-workflow.ts) and the
// rooms/ barrel re-export it unchanged.

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRoomCreate } from "./tools-impl/room_create";
import { registerRoomJobDone } from "./tools-impl/room_job_done";
import { registerRoomJobStart } from "./tools-impl/room_job_start";
import { registerRoomRead } from "./tools-impl/room_read";
import { registerRoomSend } from "./tools-impl/room_send";
import { registerRoomStatus } from "./tools-impl/room_status";

export function registerRoomTools(pi: ExtensionAPI): void {
	registerRoomCreate(pi);
	registerRoomJobStart(pi);
	registerRoomSend(pi);
	registerRoomRead(pi);
	registerRoomJobDone(pi);
	registerRoomStatus(pi);
}
