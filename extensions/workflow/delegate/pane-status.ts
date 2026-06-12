import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentName } from "../types";
import type { ResolvedRoomContext } from "../rooms";
import { DELEGATE_MANIFEST_DIR } from "./constants";

export type ActivityPhase = "starting" | "active" | "waiting" | "done";

export type DoneCompletionKind = "explicit" | "auto_exit" | "process_exit";
export type DoneSidecarSource = "tool" | "agent_end" | "shell_exit";

export interface DoneSidecar {
	done?: boolean;
	summary?: string;
	at?: string;
	exit_code?: number;
	from_exit?: boolean;
	tool?: string;
	completion?: DoneCompletionKind;
	source?: DoneSidecarSource;
	from_auto_exit?: boolean;
	stop_reason?: string;
	warning?: string;
	// TASK-003 Phase B: optional structured coder completion evidence. The
	// parent completion-evidence-gate reads this field via the done sidecar
	// parser and feeds it to the matrix-gated evaluator. Backward-compat:
	// tiny / non-matrix coder work may omit this field and complete normally.
	coderEvidence?: unknown;
}

export interface ActivitySidecar {
	version: number;
	runId: string;
	phase?: ActivityPhase;
	lastEvent?: string;
	updatedAt?: number;
}

export interface PaneManifest {
	manifestVersion: 1;
	runId: string;
	startedAt: string;
	updatedAt: string;
	cwd: string;
	agent: AgentName;
	task: string;
	taskPreview: string;
	groupKey: string;
	groupTitle: string;
	tabTitle: string;
	roomContext?: Pick<ResolvedRoomContext, "roomId" | "agentId" | "role">;
	surface?: string;
	workspace?: string;
	pane?: string;
	sessionFile: string;
	stderrFile: string;
	doneFile: string;
	activityFile: string;
	state: "running" | "completed" | "failed" | "aborted";
	latestEvent?: string;
	activity?: ActivitySidecar;
	done?: DoneSidecar;
	exitCode?: number;
}

export function manifestPathFromRunRoot(runRoot: string, runId: string): string {
	return path.join(runRoot, DELEGATE_MANIFEST_DIR, `${runId}.json`);
}

function readJsonFile<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function parseDoneSidecar(filePath: string): DoneSidecar | undefined {
	const value = readJsonFile<DoneSidecar>(filePath);
	if (!value || typeof value !== "object" || value === null) return undefined;
	return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function parseActivitySidecar(filePath: string, runId: string): ActivitySidecar | undefined {
	const value = readJsonFile<ActivitySidecar>(filePath);
	if (!value || !isPlainRecord(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.runId === "string" && record.runId !== runId) return undefined;
	const version = Number(record.version);
	const rawUpdatedAt = typeof record.updatedAt === "number" ? record.updatedAt : Number.NaN;
	return {
		version: Number.isFinite(version) && version > 0 ? version : 1,
		runId,
		phase: typeof record.phase === "string" ? (record.phase as ActivityPhase) : "waiting",
		lastEvent: typeof record.lastEvent === "string" ? record.lastEvent : "status",
		updatedAt: Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : Date.now(),
	};
}

export async function writeActivitySidecar(filePath: string, payload: ActivitySidecar): Promise<void> {
	try {
		await fs.promises.writeFile(filePath, JSON.stringify(payload) + "\n", "utf8");
	} catch {
		// best effort
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

export function buildManifest(base: Omit<PaneManifest, "manifestVersion" | "startedAt" | "updatedAt" | "state">): PaneManifest {
	const startedAt = nowIso();
	return {
		manifestVersion: 1,
		startedAt,
		updatedAt: startedAt,
		state: "running",
		...base,
	};
}

export async function writeManifest(filePath: string, manifest: PaneManifest): Promise<void> {
	try {
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.writeFile(filePath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
	} catch {
		// Manifest writes are best effort for visibility only.
	}
}

export function makeActivityPayload(runId: string, phase: ActivityPhase, lastEvent: string, updatedAt: number = Date.now()): ActivitySidecar {
	return {
		version: 1,
		runId,
		phase,
		lastEvent,
		updatedAt,
	};
}
