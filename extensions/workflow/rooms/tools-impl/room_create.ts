// Workflow Rooms — `room_create` tool registration.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 1.

import * as fs from "node:fs";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	appendEventLine,
	ensureDir,
	generateRoomId,
	getRoomAgentsPath,
	getRoomDir,
	getRoomEventsPath,
	getRoomLockPath,
	sanitizeRoomId,
	withRoomLock,
	writeAgentsFile,
	writeCurrentRoomPointer,
} from "../store";
import type { RoomEvent } from "../types";
import { truncateLabel } from "./text_result";

export function registerRoomCreate(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "room_create",
		label: "Create Workflow Room",
		description:
			"Create or re-activate a durable workflow room under .pi/workflow-runs/<roomId>/. Sets it as the active room for subsequent room_* calls in this session. Pass a stable roomId when you want to share a room across delegated agents; otherwise one is generated.",
		promptSnippet: "Create a durable workflow room and mark it as active.",
		promptGuidelines: [
			"Call room_create before delegating agents that need to coordinate via room tools.",
			"Pass a stable roomId (lowercase letters, digits, hyphens) so it can be referenced later; otherwise one is generated.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(
				Type.String({
					description:
						"Stable room id. Lowercase letters, digits, and hyphens. Auto-generated if omitted.",
				}),
			),
			title: Type.Optional(Type.String({ description: "Human-readable title for this room" })),
		}),
		renderCall(args: any, theme) {
			const id = args?.roomId ? sanitizeRoomId(String(args.roomId)) : "(auto)";
			const title = args?.title ? String(args.title) : "";
			const head = `${theme.fg("toolTitle", theme.bold("room_create"))} ${theme.fg("accent", id)}`;
			return new Text(
				title ? `${head} ${theme.fg("muted", `— ${truncateLabel(title, 80)}`)}` : head,
				0,
				0,
			);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requested = params?.roomId ? sanitizeRoomId(String(params.roomId)) : "";
			const roomId = requested || generateRoomId();
			const roomDir = getRoomDir(ctx.cwd, roomId);
			const lockPath = getRoomLockPath(ctx.cwd, roomId);
			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);

			ensureDir(roomDir);
			await withRoomLock(lockPath, async () => {
				if (!fs.existsSync(eventsPath)) {
					const event: RoomEvent = {
						seq: 1,
						roomId,
						type: "room_created",
						from: "brain",
						topic: String(params?.title ?? "").trim() || undefined,
						body: String(params?.title ?? "").trim() || undefined,
						createdAt: new Date().toISOString(),
					};
					appendEventLine(eventsPath, event);
				}
				if (!fs.existsSync(agentsPath)) {
					writeAgentsFile(agentsPath, {});
				}
			});
			writeCurrentRoomPointer(ctx.cwd, roomId);

			return {
				content: [{ type: "text", text: `Room ${roomId} ready at ${roomDir}` }],
				details: { roomId, roomDir },
			};
		},
	});
}
