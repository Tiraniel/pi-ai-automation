import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentName } from "../types";
import type { ResolvedRoomContext } from "../rooms";
import { DELEGATE_MANIFEST_DIR } from "./constants";

export type ActivityPhase = "starting" | "active" | "waiting" | "done";

export type DoneCompletionKind = "explicit" | "auto_exit" | "process_exit";
export type DoneSidecarSource = "tool" | "agent_end" | "shell_exit";

/**
 * Canonical done-sidecar evidence envelope for TASK-002.
 *
 * New delegate runs (coder / reviewer / headless) should write structured
 * evidence here, with `coderEvidence` and `reviewerEvidence` as the
 * simple current-run payloads. Optional `warnings` is a list of human-
 * readable warning strings attached to the current completion. Optional
 * `event` lets the tool carry a single canonical EvidenceEvent-like
 * envelope (e.g. `{ kind: "coder_evidence", provenance: "canonical",
 * payload: { ... } }`) for richer downstream projections; the
 * canonical-evidence helper recognizes the simple envelopes here and
 * dispatches on shape.
 *
 * Tiny / non-matrix work may omit this field entirely.
 */
export interface DoneSidecarEvidence {
	coderEvidence?: unknown;
	reviewerEvidence?: unknown;
	warnings?: string[];
	event?: unknown;
}

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
	// TASK-002 HARD-CUT: the only gate-authoritative structured evidence
	// path is the canonical `evidence` envelope below. The previous
	// top-level `coderEvidence` / `reviewerEvidence` fields have been
	// DELETED from the strict flow. The completion tool no longer writes
	// them, the gate no longer reads them, and they are not part of the
	// canonical authority. Callers that still send top-level fields via
	// the completion tool boundary are ignored (no sidecar write, no
	// gate authority).
	//
	// Canonical evidence envelope. New coder / reviewer completions must
	// write structured `evidence.coderEvidence` and / or
	// `evidence.reviewerEvidence` here. The canonical-evidence parser
	// reads this envelope only; legacy / free-form / parseable JSON
	// content on top-level `summary` / `delegateHistory` / etc. is
	// diagnostic only and fails closed on matrix-gated plans.
	evidence?: DoneSidecarEvidence;
	// TASK-002: structured warnings from the delegate, surfaced to gates.
	warnings?: string[];
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

// ---------- TASK-002 canonical evidence pickers (HARD-CUT) ----------
//
// The shared canonical envelope parser lives in
// `extensions/workflow/delegate/canonical-evidence.ts` and reads the
// `done.evidence` envelope only. Deprecated top-level `coderEvidence` /
// `reviewerEvidence` / `summary` / `delegateHistory` fields on the
// sidecar are NOT canonical and are NOT read by the gate. This module
// therefore no longer ships its own ad-hoc picker; the completion gate
// and the reviewer-roles gate both call into the canonical helper so
// they share one canonical authority.

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
