/**
 * Shared types for the keeper scheduler subsystem.
 *
 * Extracted from scheduler.ts to keep each module under the project 500-LOC
 * budget. Behavior, fields, and ordering are preserved. The internal
 * `FileToCard` / `GeneratedCard` types are exported so the cards helper module
 * can use them without duplicating shape definitions.
 */

import type { ModelPreset } from "../models/presets";

export interface KeeperLease {
	repoKey: string;
	leaseHolder: string;
	leasedAt: number;
	expiresAt: number;
}

export interface KeeperRunOptions {
	repoKey: string;
	repoRoot: string;
	maxRunTimeMs: number;
	maxTokensPerRun: number;
	batchSize: number;
	leaseDurationMs: number;
	contextVersion: string;
	activeAgentCount?: number;
	modelPresetName?: string;
	modelPresetOverrides?: Record<string, Partial<ModelPreset>>;
}

export interface KeeperRunResult {
	didWork: boolean;
	message: string;
	cardsGenerated: number;
	evidenceProcessed: number;
	tokensUsed: number;
	elapsedMs: number;
}

export interface KeeperPlanInput {
	activeAgentCount: number;
	pendingEvidenceCount: number;
	processingEvidenceCount: number;
	cardBacklogCount: number;
	batchSize: number;
	maxRunTimeMs: number;
}

export interface KeeperPlan {
	run: boolean;
	pressure: "idle" | "normal" | "high";
	effectiveBatchSize: number;
	effectiveMaxRunTimeMs: number;
}

export interface FileToCard {
	id: number;
	relative_path: string;
	absolute_path: string;
	content_hash: string;
	card_freshness: string | null;
	language: string | null;
	imports_hash: string | null;
}

export interface GeneratedCard {
	fileId: number;
	relativePath: string;
	content: string;
	sourceHash: string;
	contextVersion: string;
	refs: string[];
	excerpts: string[];
	confidence: number;
	workerId: string;
	modelPreset: string;
	tokenBudget: number;
	staleReason: string | null;
}
