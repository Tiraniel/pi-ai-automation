/**
 * Hybrid keeper scheduler for pi-ai-automation-memory.
 *
 * Single-writer safety via keeper_leases table.
 * Evidence batches claimed with short-term leases; expired leases are reclaimable.
 * Card generation is deterministic (no LLM/provider yet — TASK-009).
 * Budgeted by maxRunTimeMs and maxTokensPerRun.
 *
 * This file is the public entry point. It composes the helper modules:
 *   - ./types    — public interfaces (KeeperLease, KeeperRunOptions, etc.)
 *   - ./leases   — process/lease/time helpers (acquire/release/refresh/now)
 *   - ./cards    — card/evidence helper logic (generate/select/write)
 *
 * All public symbols and the import surface (`./keeper/scheduler`) are
 * preserved for downstream consumers (src/index.ts).
 */

import { openDb, closeDb } from "../index/db";
import {
	claimEvidenceBatch,
	getPendingEvidenceCount,
	getProcessingEvidenceCount,
} from "../evidence/queue";
import { resolvePreset } from "../models/presets";
import { errorMessage } from "../util/errors";
import type {
	GeneratedCard,
	KeeperPlan,
	KeeperPlanInput,
	KeeperRunOptions,
	KeeperRunResult,
} from "./types";
import { acquireLease, makeLeaseHolder, nowMs, releaseLease } from "./leases";
import {
	generateDeterministicCard,
	selectFilesToCard,
	writeCardsAndEvidence,
} from "./cards";

export type {
	KeeperLease,
	KeeperRunOptions,
	KeeperRunResult,
	KeeperPlanInput,
	KeeperPlan,
} from "./types";
export { isLeaseHeld, acquireLease, releaseLease } from "./leases";

function getActiveAgentCount(options: KeeperRunOptions): number {
	if (typeof options.activeAgentCount === "number" && Number.isFinite(options.activeAgentCount)) {
		return Math.max(1, Math.min(10, Math.floor(options.activeAgentCount)));
	}
	const env = Number(
		process.env.PI_WORKFLOW_ACTIVE_AGENT_COUNT ?? process.env.PI_ACTIVE_AGENT_COUNT ?? 1,
	);
	return Math.max(1, Math.min(10, Number.isFinite(env) ? Math.floor(env) : 1));
}

export function planKeeperRun(input: KeeperPlanInput): KeeperPlan {
	const backlog = input.pendingEvidenceCount + input.cardBacklogCount;
	if (backlog <= 0) {
		return {
			run: false,
			pressure: "idle",
			effectiveBatchSize: input.batchSize,
			effectiveMaxRunTimeMs: input.maxRunTimeMs,
		};
	}
	const high =
		input.activeAgentCount >= 4 ||
		backlog >= input.batchSize * 4 ||
		input.processingEvidenceCount >= input.batchSize;
	if (high) {
		return {
			run: true,
			pressure: "high",
			effectiveBatchSize: Math.min(Math.max(input.batchSize * 2, input.batchSize), 50),
			effectiveMaxRunTimeMs: Math.min(input.maxRunTimeMs, 15000),
		};
	}
	return {
		run: true,
		pressure: "normal",
		effectiveBatchSize: input.batchSize,
		effectiveMaxRunTimeMs: input.maxRunTimeMs,
	};
}

/**
 * Run one unit of keeper work.
 *
 * Flow: acquire lease → claim evidence batch → read DB rows → close DB →
 * generate cards (deterministic, bounded) → reopen DB → write cards + mark evidence → release lease.
 */
export async function runKeeperUnit(options: KeeperRunOptions): Promise<KeeperRunResult> {
	const startTime = nowMs();
	const presetName = options.modelPresetName ?? "index_keeper";
	const preset = resolvePreset(presetName, options.modelPresetOverrides);
	if (preset && !preset.enabled) {
		return {
			didWork: false,
			message: `Keeper preset '${presetName}' is disabled; skipped.`,
			cardsGenerated: 0,
			evidenceProcessed: 0,
			tokensUsed: 0,
			elapsedMs: nowMs() - startTime,
		};
	}
	const budgetMs = Math.min(options.maxRunTimeMs, preset?.budgetMs ?? options.maxRunTimeMs);
	const budgetTokens = Math.min(options.maxTokensPerRun, preset?.budgetTokens ?? options.maxTokensPerRun);
	let tokenBudgetRemaining = budgetTokens;

	// 1. Acquire lease
	const lease = acquireLease(options.repoKey, options.repoRoot, options.leaseDurationMs);
	if (!lease) {
		return {
			didWork: false,
			message: "Keeper lease held by another process; skipped.",
			cardsGenerated: 0,
			evidenceProcessed: 0,
			tokensUsed: 0,
			elapsedMs: nowMs() - startTime,
		};
	}

	let handle = openDb(options.repoKey, options.repoRoot);
	const db = handle.db;

	try {
		// 2. Plan run based on pressure BEFORE claiming batch
		const activeAgentCount = getActiveAgentCount(options);
		const pendingCount = getPendingEvidenceCount(db, options.repoKey);
		const processingCount = getProcessingEvidenceCount(db, options.repoKey);
		const cardBacklogRow = db.prepare(
			`SELECT COUNT(*) as c FROM files
			 WHERE repo_key = ? AND is_deleted = 0 AND is_secret = 0 AND is_generated = 0
				 AND (card_freshness = 'missing' OR card_freshness = 'stale' OR card_freshness IS NULL)`
		).get(options.repoKey) as { c: number } | undefined;
		const cardBacklogCount = Number(cardBacklogRow?.c ?? 0);

		const plan = planKeeperRun({
			activeAgentCount,
			pendingEvidenceCount: pendingCount,
			processingEvidenceCount: processingCount,
			cardBacklogCount,
			batchSize: options.batchSize,
			maxRunTimeMs: budgetMs,
		});

		if (!plan.run) {
			return {
				didWork: false,
				message: `Keeper idle (pressure=${plan.pressure}, backlog=${pendingCount + cardBacklogCount}).`,
				cardsGenerated: 0,
				evidenceProcessed: 0,
				tokensUsed: 0,
				elapsedMs: nowMs() - startTime,
			};
		}

		const deadline = startTime + plan.effectiveMaxRunTimeMs;

		// 3. Claim evidence batch using effective size
		const batch = claimEvidenceBatch(db, options.repoKey, plan.effectiveBatchSize, options.leaseDurationMs);
		const evidenceRows = batch.claimed;

		// 4. Select files to card using effective size
		const filesToCard = selectFilesToCard(db, options.repoKey, evidenceRows, plan.effectiveBatchSize);

		// 5. Read file data we need before closing DB
		const fileDataForCards = filesToCard.map((f) => ({ ...f }));
		const evidenceDataForCards = evidenceRows.map((e) => ({ ...e }));

		// 6. Close DB before generation
		closeDb(handle);
		handle = null as any;

		// 7. Generate cards deterministically (no LLM / no DB lock)
		const cards: GeneratedCard[] = [];
		const workerId = makeLeaseHolder();
		const modelPreset = presetName;

		for (const file of fileDataForCards) {
			if (nowMs() > deadline) break;
			const card = generateDeterministicCard(
				file,
				evidenceDataForCards,
				options.repoRoot,
				options.contextVersion,
				workerId,
				modelPreset,
				tokenBudgetRemaining,
			);
			if (card.tokenBudget > tokenBudgetRemaining) break;
			tokenBudgetRemaining -= card.tokenBudget;
			cards.push(card);
		}

		// 8. Reopen DB and write
		handle = openDb(options.repoKey, options.repoRoot);
		const db2 = handle.db;

		const { cardsWritten, evidenceProcessed } = writeCardsAndEvidence(
			db2,
			options.repoKey,
			cards,
			evidenceDataForCards.map((e) => e.id),
			lease,
			options.leaseDurationMs,
			batch.leaseHolder,
		);

		// 9. Update last_keeper_run_at
		db2.prepare(
			`UPDATE repo_meta SET last_keeper_run_at = ? WHERE repo_key = ?`
		).run(Date.now(), options.repoKey);

		const elapsed = nowMs() - startTime;

		return {
			didWork: cardsWritten > 0 || evidenceProcessed > 0,
			message: `Keeper processed ${evidenceProcessed} evidence, generated ${cardsWritten} cards (pressure=${plan.pressure}, effectiveBatch=${plan.effectiveBatchSize}).`,
			cardsGenerated: cardsWritten,
			evidenceProcessed,
			tokensUsed: options.maxTokensPerRun - tokenBudgetRemaining,
			elapsedMs: elapsed,
		};
	} catch (err) {
		return {
			didWork: false,
			message: `Keeper error: ${errorMessage(err)}`,
			cardsGenerated: 0,
			evidenceProcessed: 0,
			tokensUsed: 0,
			elapsedMs: nowMs() - startTime,
		};
	} finally {
		if (handle) closeDb(handle);
		releaseLease(lease);
	}
}

/**
 * Adaptive schedule: decide whether to run keeper now based on queue pressure.
 * Returns suggested batch size and whether to run.
 */
export function shouldRunKeeper(
	pendingCount: number,
	processingCount: number,
	batchSize: number,
): { run: boolean; suggestedBatchSize: number } {
	const totalActive = pendingCount + processingCount;
	if (totalActive === 0) return { run: false, suggestedBatchSize: batchSize };

	// High pressure: larger batches, but still bounded
	if (totalActive > batchSize * 4) {
		return { run: true, suggestedBatchSize: Math.min(batchSize * 2, 50) };
	}
	// Normal: standard batch
	if (totalActive >= 1) {
		return { run: true, suggestedBatchSize: batchSize };
	}
	return { run: false, suggestedBatchSize: batchSize };
}
