import * as fs from "node:fs";
import * as path from "node:path";

export const PLANNING_CURRENT_ROOM_POINTER = "planning-current.json";
export const WORKFLOW_CURRENT_ROOM_POINTER = "current.json";

const ROOM_DIR_NAME = "workflow-runs";
const PLANNING_STATE_FILE_NAME = "planning-state.json";

const workflowRunsRoot = (cwd: string): string => path.join(cwd, ".pi", ROOM_DIR_NAME);
const pointerPath = (cwd: string, fileName: string): string => path.join(workflowRunsRoot(cwd), fileName);

export interface PlanningPointerReadResult {
	exists: boolean;
	roomId: string | null;
	issue?: string;
}

function readPointerValue(filePath: string): PlanningPointerReadResult {
	if (!fs.existsSync(filePath)) return { exists: false, roomId: null };
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { roomId?: unknown };
		const roomId = typeof raw?.roomId === "string" ? raw.roomId.trim() : "";
		if (!roomId) {
			return { exists: true, roomId: null, issue: "planning room pointer exists but roomId is missing or empty" };
		}
		return { exists: true, roomId };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { exists: true, roomId: null, issue: `planning room pointer is invalid JSON: ${message}` };
	}
}

export const planningCurrentRoomPointerPath = (cwd: string): string => pointerPath(cwd, PLANNING_CURRENT_ROOM_POINTER);
export const workflowCurrentRoomPointerPath = (cwd: string): string => pointerPath(cwd, WORKFLOW_CURRENT_ROOM_POINTER);

export function readPlanningCurrentRoomPointer(cwd: string): string | null {
	const result = readPointerValue(planningCurrentRoomPointerPath(cwd));
	return result.exists ? result.roomId : null;
}

export function readPlanningCurrentRoomPointerResult(cwd: string): PlanningPointerReadResult {
	return readPointerValue(planningCurrentRoomPointerPath(cwd));
}

export function readWorkflowCurrentRoomPointer(cwd: string): string | null {
	return readPointerValue(workflowCurrentRoomPointerPath(cwd)).roomId;
}

export function writePlanningCurrentRoomPointer(cwd: string, roomId: string): void {
	const normalized = String(roomId ?? "").trim();
	if (!normalized) throw new Error("invalid planning room id: cannot write empty planning room id");
	fs.mkdirSync(workflowRunsRoot(cwd), { recursive: true });
	fs.writeFileSync(
		planningCurrentRoomPointerPath(cwd),
		JSON.stringify({ roomId: normalized, updatedAt: new Date().toISOString() }, null, 2) + "\n",
		"utf-8",
	);
}

export function planningStateFilePath(cwd: string, roomId: string): string {
	return path.join(workflowRunsRoot(cwd), roomId, PLANNING_STATE_FILE_NAME);
}

export function planningRoomHasStateFile(cwd: string, roomId: string): boolean {
	if (!roomId) return false;
	return fs.existsSync(planningStateFilePath(cwd, roomId));
}
