// Workflow delegate runtime — durable cmux placement registry.
//
// The registry is the source of truth for pane-mode delegate placement. It is
// protected by per-group file locks so parallel parent Pi processes converge on
// one cmux pane/workspace per logical room/task group.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentName } from "../types";
import type { ResolvedRoomContext } from "../rooms/types";
import {
	ensureDir,
	getWorkflowRunsRoot,
	nowIso,
} from "../rooms/store";
import {
	ROOM_LOCK_RETRY_BASE_MS,
	ROOM_LOCK_TIMEOUT_MS,
} from "../rooms/types";

export type DelegatePaneClosePolicy =
	| "surface-on-complete"
	| "keep-failed"
	| "keep-all"
	| "close-workspace-when-empty";

export type DelegateSurfaceState = "running" | "completed" | "failed" | "aborted" | "closed" | "stale";

export interface DelegatePlacementSurfaceRecord {
	runId: string;
	agent: AgentName;
	agentId?: string;
	role?: string;
	surfaceRef: string;
	tabTitle: string;
	state: DelegateSurfaceState;
	createdAt: string;
	updatedAt: string;
}

export interface DelegatePlacementStaleRefs {
	workspaceRef?: string;
	paneRef?: string;
	staleAt: string;
	reason: string;
}

export interface DelegatePlacementGroupRecord {
	groupKey: string;
	groupTitle: string;
	workspaceRef?: string;
	paneRef?: string;
	createdAt: string;
	updatedAt: string;
	staleRefs?: DelegatePlacementStaleRefs[];
	surfaces: Record<string, DelegatePlacementSurfaceRecord>;
}

export interface DelegatePlacementRegistry {
	version: 1;
	updatedAt: string;
	groups: Record<string, DelegatePlacementGroupRecord>;
}

export interface CmuxContext {
	workspace?: string;
	pane?: string;
	surface?: string;
}

export interface CreateGroupWorkspaceInput {
	groupKey: string;
	groupTitle: string;
	tabTitle: string;
	sourceSurface?: string;
}

export interface CmuxGroupRefs {
	workspaceRef?: string;
	paneRef?: string;
	surfaceRef: string;
}

export interface CreateSurfaceInGroupInput {
	groupKey: string;
	groupTitle: string;
	tabTitle: string;
	workspaceRef?: string;
	paneRef: string;
}

export interface CmuxSurfaceRef {
	workspaceRef?: string;
	paneRef?: string;
	surfaceRef: string;
}

export interface CmuxDelegateAdapter {
	identify(): CmuxContext | null;
	probeWorkspace(ref: string): boolean;
	probePane(ref: string): boolean;
	probeSurface(ref: string): boolean;
	createGroupWorkspace(input: CreateGroupWorkspaceInput): CmuxGroupRefs | null;
	createSurfaceInGroup(input: CreateSurfaceInGroupInput): CmuxSurfaceRef | null;
	renameSurface(surfaceRef: string, title: string): void;
	closeSurface(surfaceRef: string): void;
}

export interface DelegatePlacementRequest {
	cwd: string;
	runId: string;
	agent: AgentName;
	task: string;
	roomContext?: ResolvedRoomContext;
	groupKey: string;
	groupTitle: string;
	tabTitle: string;
}

export interface DelegatePlacementRefs {
	groupKey: string;
	groupTitle: string;
	workspace?: string;
	pane?: string;
	surface: string;
	registryPath: string;
}

const REGISTRY_DIR = "delegate-layout";
const REGISTRY_FILE = "placement.json";
const LOCK_DIR = "locks";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeLockName(input: string): string {
	const base = input
		.replace(/[^\w.-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 96);
	return base || "group";
}

export function getDelegatePlacementDir(cwd: string): string {
	return path.join(getWorkflowRunsRoot(cwd), REGISTRY_DIR);
}

export function getDelegatePlacementRegistryPath(cwd: string): string {
	return path.join(getDelegatePlacementDir(cwd), REGISTRY_FILE);
}

export function getDelegatePlacementLockPath(cwd: string, groupKey: string): string {
	return path.join(getDelegatePlacementDir(cwd), LOCK_DIR, `${sanitizeLockName(groupKey)}.lock`);
}

export async function withDelegatePlacementLock<T>(
	cwd: string,
	groupKey: string,
	fn: () => Promise<T>,
	timeoutMs: number = ROOM_LOCK_TIMEOUT_MS,
): Promise<T> {
	const lockPath = getDelegatePlacementLockPath(cwd, groupKey);
	ensureDir(path.dirname(lockPath));
	const deadline = Date.now() + timeoutMs;
	let fd: number | undefined;
	while (true) {
		try {
			fd = fs.openSync(lockPath, "wx");
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			if (Date.now() > deadline) throw new Error(`Delegate placement lock timeout: ${lockPath}`);
			await new Promise((r) =>
				setTimeout(r, ROOM_LOCK_RETRY_BASE_MS + Math.random() * ROOM_LOCK_RETRY_BASE_MS),
			);
		}
	}
	try {
		return await fn();
	} finally {
		try {
			if (fd !== undefined) fs.closeSync(fd);
		} catch {
			// ignore
		}
		try {
			fs.unlinkSync(lockPath);
		} catch {
			// ignore
		}
	}
}

export function emptyPlacementRegistry(): DelegatePlacementRegistry {
	return { version: 1, updatedAt: nowIso(), groups: {} };
}

function parseSurfaceRecord(value: unknown): DelegatePlacementSurfaceRecord | undefined {
	if (!isPlainObject(value)) return undefined;
	if (typeof value.runId !== "string" || typeof value.surfaceRef !== "string") return undefined;
	if (typeof value.tabTitle !== "string" || typeof value.agent !== "string") return undefined;
	const now = nowIso();
	return {
		runId: value.runId,
		agent: value.agent as AgentName,
		agentId: typeof value.agentId === "string" ? value.agentId : undefined,
		role: typeof value.role === "string" ? value.role : undefined,
		surfaceRef: value.surfaceRef,
		tabTitle: value.tabTitle,
		state: typeof value.state === "string" ? (value.state as DelegateSurfaceState) : "running",
		createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
	};
}

function parseGroupRecord(value: unknown, fallbackKey: string): DelegatePlacementGroupRecord | undefined {
	if (!isPlainObject(value)) return undefined;
	const groupKey = typeof value.groupKey === "string" && value.groupKey ? value.groupKey : fallbackKey;
	const groupTitle = typeof value.groupTitle === "string" && value.groupTitle ? value.groupTitle : groupKey;
	const now = nowIso();
	const surfaces: Record<string, DelegatePlacementSurfaceRecord> = {};
	if (isPlainObject(value.surfaces)) {
		for (const [runId, surface] of Object.entries(value.surfaces)) {
			const parsed = parseSurfaceRecord(surface);
			if (parsed) surfaces[runId] = parsed;
		}
	}
	const staleRefs = Array.isArray(value.staleRefs)
		? value.staleRefs
			.filter(isPlainObject)
			.map((ref) => ({
				workspaceRef: typeof ref.workspaceRef === "string" ? ref.workspaceRef : undefined,
				paneRef: typeof ref.paneRef === "string" ? ref.paneRef : undefined,
				staleAt: typeof ref.staleAt === "string" ? ref.staleAt : now,
				reason: typeof ref.reason === "string" ? ref.reason : "stale",
			}))
		: undefined;
	return {
		groupKey,
		groupTitle,
		workspaceRef: typeof value.workspaceRef === "string" ? value.workspaceRef : undefined,
		paneRef: typeof value.paneRef === "string" ? value.paneRef : undefined,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
		staleRefs,
		surfaces,
	};
}

export function readPlacementRegistry(cwd: string): DelegatePlacementRegistry {
	const registryPath = getDelegatePlacementRegistryPath(cwd);
	try {
		const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as unknown;
		if (!isPlainObject(parsed) || !isPlainObject(parsed.groups)) return emptyPlacementRegistry();
		const registry = emptyPlacementRegistry();
		registry.updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : registry.updatedAt;
		for (const [groupKey, group] of Object.entries(parsed.groups)) {
			const parsedGroup = parseGroupRecord(group, groupKey);
			if (parsedGroup) registry.groups[groupKey] = parsedGroup;
		}
		return registry;
	} catch {
		return emptyPlacementRegistry();
	}
}

export function writePlacementRegistry(cwd: string, registry: DelegatePlacementRegistry): void {
	const registryPath = getDelegatePlacementRegistryPath(cwd);
	ensureDir(path.dirname(registryPath));
	registry.version = 1;
	registry.updatedAt = nowIso();
	const tmpPath = `${registryPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
	fs.renameSync(tmpPath, registryPath);
}

function addSurfaceRecord(
	group: DelegatePlacementGroupRecord,
	request: DelegatePlacementRequest,
	surfaceRef: string,
): void {
	const now = nowIso();
	group.surfaces[request.runId] = {
		runId: request.runId,
		agent: request.agent,
		agentId: request.roomContext?.agentId,
		role: request.roomContext?.role,
		surfaceRef,
		tabTitle: request.tabTitle,
		state: "running",
		createdAt: now,
		updatedAt: now,
	};
	group.updatedAt = now;
}

function markGroupRefsStale(group: DelegatePlacementGroupRecord, reason: string): void {
	const now = nowIso();
	if (group.workspaceRef || group.paneRef) {
		group.staleRefs = [
			...(group.staleRefs ?? []),
			{
				workspaceRef: group.workspaceRef,
				paneRef: group.paneRef,
				staleAt: now,
				reason,
			},
		];
	}
	for (const surface of Object.values(group.surfaces)) {
		if (surface.state === "running") {
			surface.state = "stale";
			surface.updatedAt = now;
		}
	}
	group.workspaceRef = undefined;
	group.paneRef = undefined;
	group.updatedAt = now;
}

function hasUsableGroupRefs(group: DelegatePlacementGroupRecord | undefined, adapter: CmuxDelegateAdapter): group is DelegatePlacementGroupRecord {
	if (!group?.paneRef) return false;
	if (!adapter.probePane(group.paneRef)) return false;
	return true;
}

function makeGroupRecord(request: DelegatePlacementRequest): DelegatePlacementGroupRecord {
	const now = nowIso();
	return {
		groupKey: request.groupKey,
		groupTitle: request.groupTitle,
		createdAt: now,
		updatedAt: now,
		surfaces: {},
	};
}

function isParentSurfaceRef(surfaceRef: string | undefined, current: CmuxContext | null): boolean {
	const surface = surfaceRef?.trim();
	if (!surface) return false;
	const parent = current?.surface?.trim() || process.env.CMUX_SURFACE_ID?.trim();
	return Boolean(parent && surface === parent);
}

export async function allocateDelegatePlacement(
	request: DelegatePlacementRequest,
	adapter: CmuxDelegateAdapter,
): Promise<DelegatePlacementRefs | null> {
	return withDelegatePlacementLock(request.cwd, request.groupKey, async () => {
		const registry = readPlacementRegistry(request.cwd);
		const current = adapter.identify();
		let group = registry.groups[request.groupKey];
		let createdNewGroupRecord = false;
		if (hasUsableGroupRefs(group, adapter)) {
			const surface = adapter.createSurfaceInGroup({
				groupKey: request.groupKey,
				groupTitle: request.groupTitle,
				tabTitle: request.tabTitle,
				workspaceRef: group.workspaceRef,
				paneRef: group.paneRef,
			});
			if (surface?.surfaceRef && !isParentSurfaceRef(surface.surfaceRef, current)) {
				group.workspaceRef = surface.workspaceRef ?? group.workspaceRef;
				group.paneRef = surface.paneRef ?? group.paneRef;
				addSurfaceRecord(group, request, surface.surfaceRef);
				writePlacementRegistry(request.cwd, registry);
				return {
					groupKey: request.groupKey,
					groupTitle: request.groupTitle,
					workspace: group.workspaceRef,
					pane: group.paneRef,
					surface: surface.surfaceRef,
					registryPath: getDelegatePlacementRegistryPath(request.cwd),
				};
			}
			markGroupRefsStale(group, "create-surface-failed");
		} else if (group?.paneRef || group?.workspaceRef) {
			markGroupRefsStale(group, "probe-failed");
		}

		if (!group) {
			group = makeGroupRecord(request);
			registry.groups[request.groupKey] = group;
			createdNewGroupRecord = true;
		}
		const created = adapter.createGroupWorkspace({
			groupKey: request.groupKey,
			groupTitle: request.groupTitle,
			tabTitle: request.tabTitle,
			sourceSurface: current?.surface ?? process.env.CMUX_SURFACE_ID,
		});
		if (!created?.surfaceRef || isParentSurfaceRef(created.surfaceRef, current)) {
			if (createdNewGroupRecord) delete registry.groups[request.groupKey];
			writePlacementRegistry(request.cwd, registry);
			return null;
		}
		group.groupTitle = request.groupTitle;
		group.workspaceRef = created.workspaceRef;
		group.paneRef = created.paneRef;
		addSurfaceRecord(group, request, created.surfaceRef);
		writePlacementRegistry(request.cwd, registry);
		return {
			groupKey: request.groupKey,
			groupTitle: request.groupTitle,
			workspace: group.workspaceRef,
			pane: group.paneRef,
			surface: created.surfaceRef,
			registryPath: getDelegatePlacementRegistryPath(request.cwd),
		};
	});
}

export async function markDelegatePlacementSurfaceState(
	cwd: string,
	groupKey: string | undefined,
	runId: string,
	state: DelegateSurfaceState,
): Promise<void> {
	if (!groupKey) return;
	await withDelegatePlacementLock(cwd, groupKey, async () => {
		const registry = readPlacementRegistry(cwd);
		const group = registry.groups[groupKey];
		const surface = group?.surfaces?.[runId];
		if (!surface) return;
		surface.state = state;
		surface.updatedAt = nowIso();
		if (group) group.updatedAt = surface.updatedAt;
		writePlacementRegistry(cwd, registry);
	});
}

export function derivePlacementGroupKeyAndTitle(
	roomContext: ResolvedRoomContext | undefined,
	task: string,
): { groupKey: string; groupTitle: string } {
	if (roomContext?.roomId) {
		return { groupKey: `room:${roomContext.roomId}`, groupTitle: roomContext.roomId };
	}
	const taskIdMatch = task.match(/\b([A-Z][A-Z0-9]*-\d+)\b/);
	if (taskIdMatch) {
		return { groupKey: `task:${taskIdMatch[1]}`, groupTitle: taskIdMatch[1] };
	}
	const parent =
		process.env.PI_WORKFLOW_PARENT_RUN_ID?.trim()
		|| process.env.PI_WORKFLOW_RUN_ID?.trim()
		|| process.env.CMUX_SURFACE_ID?.trim()
		|| String(process.ppid || process.pid);
	const safeParent = parent.replace(/[^\w:.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "session";
	return { groupKey: `parent:${safeParent}`, groupTitle: safeParent };
}
