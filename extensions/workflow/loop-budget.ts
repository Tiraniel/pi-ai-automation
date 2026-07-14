// WP4 — loop circuit breakers for the normal (non-ship) delegation cycle.
//
// Two runaway modes are bounded per (plan, phase):
//   1. Spend/time: delegate `usage.cost` is accumulated in a durable sidecar
//      `.pi/workflow-architecture/plans/<planId>.<phase>.budget.json`;
//      exceeding `loopBudget.maxCostUsd` / `maxWallClockMs` blocks further
//      coder delegation and escalates a WP1 BLOCKING operator question
//      ("budget exhausted — continue?"). Answering the question resets the
//      budget window (a fresh window starts; the next exceed asks again).
//   2. Repeated findings: blocking reviewer findings are fingerprinted
//      (role + first N chars, lowercased/whitespace-collapsed); the same
//      fingerprint appearing `maxSameFindingRepeats` times (default 2)
//      escalates a blocking operator question INSTEAD of another silent
//      re-delegate round. Answering clears that fingerprint's count.
//
// The AFK ship has its own durable budget on ShipState (see ship-engine's
// `budget-exhausted` stop condition); this module owns the plan-phase side
// plus the shared pure helpers (fingerprint, budget evaluation, config
// resolution).

import * as fs from "node:fs";
import { writeFileAtomicSync } from "./fs-atomic";
import { getPlanStoragePath } from "./architecture/store";
import type { WorkflowPhaseId } from "./architecture/types";
import type { LoopBudgetConfig } from "./types";
import {
	appendOperatorQuestionToFile,
	readOperatorQuestionsFromFile,
} from "./operator-questions";

export const DEFAULT_MAX_SAME_FINDING_REPEATS = 2;
export const PHASE_BUDGET_VERSION = 1;
/** First N normalized chars of a finding used for the fingerprint. */
export const FINDING_FINGERPRINT_CHARS = 80;

export interface ResolvedLoopBudget {
	maxCostUsd?: number;
	maxWallClockMs?: number;
	maxSameFindingRepeats: number;
}

export function resolveLoopBudgetConfig(config: { loopBudget?: LoopBudgetConfig } | undefined): ResolvedLoopBudget {
	const raw = config?.loopBudget;
	const asPositive = (value: unknown): number | undefined => {
		const n = Number(value);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	};
	return {
		maxCostUsd: asPositive(raw?.maxCostUsd),
		maxWallClockMs: asPositive(raw?.maxWallClockMs),
		maxSameFindingRepeats: asPositive(raw?.maxSameFindingRepeats) ?? DEFAULT_MAX_SAME_FINDING_REPEATS,
	};
}

/** Normalized fingerprint of one blocking review finding: role + first N
 *  chars, lowercased, whitespace collapsed. Deterministic across phrasing
 *  noise like extra spaces/case, NOT across genuinely reworded findings. */
export function normalizeFindingFingerprint(role: string, text: string, chars: number = FINDING_FINGERPRINT_CHARS): string {
	const normalizedRole = String(role ?? "").trim().toLowerCase() || "reviewer";
	const normalizedText = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, chars);
	return `${normalizedRole}:${normalizedText}`;
}

// ---------- Durable per-phase budget state ----------

export interface PhaseBudgetEscalation {
	/** Operator-question id carrying the escalation. */
	questionId: string;
	kind: "cost" | "wall-clock" | "repeated-finding";
	fingerprint?: string;
	at: string;
}

export interface PhaseBudgetState {
	version: typeof PHASE_BUDGET_VERSION;
	planId: string;
	phase: WorkflowPhaseId;
	/** Start of the current budget window (reset when an operator authorizes
	 *  continuation after a cost/wall-clock escalation). */
	windowStartedAt: string;
	costUsdSpent: number;
	findingCounts: Record<string, number>;
	escalations: PhaseBudgetEscalation[];
	updatedAt: string;
}

export function phaseBudgetPathFor(cwd: string, planId: string, phase: WorkflowPhaseId, sessionManager?: any): string {
	const { root } = getPlanStoragePath(cwd, planId, sessionManager);
	return `${root}/${planId}.${phase}.budget.json`;
}

function freshBudgetState(planId: string, phase: WorkflowPhaseId): PhaseBudgetState {
	const now = new Date().toISOString();
	return {
		version: PHASE_BUDGET_VERSION,
		planId,
		phase,
		windowStartedAt: now,
		costUsdSpent: 0,
		findingCounts: {},
		escalations: [],
		updatedAt: now,
	};
}

export function readPhaseBudget(cwd: string, planId: string, phase: WorkflowPhaseId, sessionManager?: any): PhaseBudgetState {
	const file = phaseBudgetPathFor(cwd, planId, phase, sessionManager);
	if (!fs.existsSync(file)) return freshBudgetState(planId, phase);
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PhaseBudgetState>;
		if (!raw || raw.version !== PHASE_BUDGET_VERSION || raw.planId !== planId || raw.phase !== phase) {
			return freshBudgetState(planId, phase);
		}
		return {
			version: PHASE_BUDGET_VERSION,
			planId,
			phase,
			windowStartedAt: typeof raw.windowStartedAt === "string" && raw.windowStartedAt ? raw.windowStartedAt : new Date().toISOString(),
			costUsdSpent: Number.isFinite(Number(raw.costUsdSpent)) && Number(raw.costUsdSpent) >= 0 ? Number(raw.costUsdSpent) : 0,
			findingCounts: typeof raw.findingCounts === "object" && raw.findingCounts !== null ? { ...raw.findingCounts } : {},
			escalations: Array.isArray(raw.escalations) ? raw.escalations.filter((e): e is PhaseBudgetEscalation => Boolean(e && typeof e.questionId === "string")) : [],
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
		};
	} catch {
		// Fail-safe for the SPEND ledger only: a torn budget file resets the
		// window (spend under-count), while escalations are re-derived from
		// the durable operator queue by the gate below.
		return freshBudgetState(planId, phase);
	}
}

export function writePhaseBudget(cwd: string, state: PhaseBudgetState, sessionManager?: any): void {
	const file = phaseBudgetPathFor(cwd, state.planId, state.phase, sessionManager);
	writeFileAtomicSync(file, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

export function accumulatePhaseCost(cwd: string, planId: string, phase: WorkflowPhaseId, costUsd: number, sessionManager?: any): PhaseBudgetState {
	const state = readPhaseBudget(cwd, planId, phase, sessionManager);
	const delta = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
	const next = { ...state, costUsdSpent: state.costUsdSpent + delta };
	writePhaseBudget(cwd, next, sessionManager);
	return next;
}

// ---------- Pure budget evaluation ----------

export interface LoopBudgetEvaluation {
	exceeded: boolean;
	kind?: "cost" | "wall-clock";
	costUsdSpent: number;
	maxCostUsd?: number;
	elapsedMs: number;
	maxWallClockMs?: number;
}

export function evaluateLoopBudget(state: Pick<PhaseBudgetState, "costUsdSpent" | "windowStartedAt">, budget: ResolvedLoopBudget, nowMs: number = Date.now()): LoopBudgetEvaluation {
	const startedMs = Date.parse(state.windowStartedAt);
	const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
	const base: LoopBudgetEvaluation = {
		exceeded: false,
		costUsdSpent: state.costUsdSpent,
		maxCostUsd: budget.maxCostUsd,
		elapsedMs,
		maxWallClockMs: budget.maxWallClockMs,
	};
	if (budget.maxCostUsd !== undefined && state.costUsdSpent > budget.maxCostUsd) {
		return { ...base, exceeded: true, kind: "cost" };
	}
	if (budget.maxWallClockMs !== undefined && elapsedMs > budget.maxWallClockMs) {
		return { ...base, exceeded: true, kind: "wall-clock" };
	}
	return base;
}

// ---------- Delegation gate (escalation via WP1) ----------

export interface LoopBudgetGateResult {
	allowed: boolean;
	reason?: "budget_escalation_pending" | "budget_exhausted";
	questionId?: string;
	text?: string;
	evaluation: LoopBudgetEvaluation;
}

function escalationQuestionText(planId: string, phase: WorkflowPhaseId, evaluation: LoopBudgetEvaluation): string {
	const detail = evaluation.kind === "cost"
		? `cost spent $${evaluation.costUsdSpent.toFixed(2)} exceeds loopBudget.maxCostUsd=$${evaluation.maxCostUsd?.toFixed(2)}`
		: `wall clock ${Math.round(evaluation.elapsedMs / 1000)}s exceeds loopBudget.maxWallClockMs=${evaluation.maxWallClockMs}ms`;
	return `Loop budget exhausted for plan ${planId}/${phase}: ${detail}. Continue delegating? Answering this question resets the budget window; otherwise stop and review the plan.`;
}

/** Called by `delegate_to_coder` before spawning. Fail-closed order:
 *  1. an OPEN budget escalation question blocks;
 *  2. an ANSWERED escalation resets the corresponding budget window /
 *     fingerprint (operator authorized continuation);
 *  3. a (re-)exceeded budget appends a blocking operator question and
 *     blocks. */
export function enforceLoopBudgetBeforeDelegation(
	cwd: string,
	planId: string,
	phase: WorkflowPhaseId,
	budget: ResolvedLoopBudget,
	questionsFile: string,
	sessionManager?: any,
	nowMs: number = Date.now(),
): LoopBudgetGateResult {
	let state = readPhaseBudget(cwd, planId, phase, sessionManager);
	const questionsById = new Map(readOperatorQuestionsFromFile(questionsFile).map((q) => [q.id, q]));
	// Settle prior escalations first.
	const remaining: PhaseBudgetEscalation[] = [];
	let mutated = false;
	for (const escalation of state.escalations) {
		const question = questionsById.get(escalation.questionId);
		if (question && !question.answeredAt) {
			// Still open: delegation stays blocked.
			return {
				allowed: false,
				reason: "budget_escalation_pending",
				questionId: escalation.questionId,
				text: `Loop-budget escalation ${escalation.questionId} (${escalation.kind}) is awaiting the operator's answer; answer it via workflow_answer_question before delegating again.`,
				evaluation: evaluateLoopBudget(state, budget, nowMs),
			};
		}
		// Answered (or the question record is gone): the operator settled it —
		// apply the corresponding reset and drop the escalation.
		mutated = true;
		if (escalation.kind === "repeated-finding" && escalation.fingerprint) {
			const { [escalation.fingerprint]: _cleared, ...rest } = state.findingCounts;
			state = { ...state, findingCounts: rest };
		} else {
			state = { ...state, costUsdSpent: 0, windowStartedAt: new Date(nowMs).toISOString() };
		}
	}
	if (mutated) {
		state = { ...state, escalations: remaining };
		writePhaseBudget(cwd, state, sessionManager);
	}
	const evaluation = evaluateLoopBudget(state, budget, nowMs);
	if (!evaluation.exceeded) return { allowed: true, evaluation };
	const question = appendOperatorQuestionToFile(questionsFile, {
		question: escalationQuestionText(planId, phase, evaluation),
		from: "brain",
		blocking: true,
		options: ["continue (reset budget window)", "stop"],
		recommendedDefault: "stop",
	});
	const next: PhaseBudgetState = {
		...state,
		escalations: [...state.escalations, { questionId: question.id, kind: evaluation.kind!, at: new Date(nowMs).toISOString() }],
	};
	writePhaseBudget(cwd, next, sessionManager);
	return {
		allowed: false,
		reason: "budget_exhausted",
		questionId: question.id,
		text: `${escalationQuestionText(planId, phase, evaluation)} (blocking operator question ${question.id} recorded)`,
		evaluation,
	};
}

// ---------- Repeated-finding breaker ----------

export interface ReviewFindingInput {
	role: string;
	text: string;
}

export interface RecordReviewFindingsResult {
	state: PhaseBudgetState;
	/** Fingerprints that reached the repeat threshold in THIS call. */
	escalated: Array<{ fingerprint: string; count: number; questionId: string }>;
}

/** Record blocking review findings for the phase; a fingerprint reaching
 *  `maxSameFindingRepeats` escalates a blocking operator question instead of
 *  authorizing another silent re-delegate round. Idempotent per threshold:
 *  a fingerprint that already has an escalation on file is not re-asked. */
export function recordReviewFindings(
	cwd: string,
	planId: string,
	phase: WorkflowPhaseId,
	findings: readonly ReviewFindingInput[],
	budget: ResolvedLoopBudget,
	questionsFile: string,
	sessionManager?: any,
): RecordReviewFindingsResult {
	let state = readPhaseBudget(cwd, planId, phase, sessionManager);
	const escalated: RecordReviewFindingsResult["escalated"] = [];
	const alreadyEscalated = new Set(state.escalations.filter((e) => e.kind === "repeated-finding" && e.fingerprint).map((e) => e.fingerprint as string));
	const findingCounts = { ...state.findingCounts };
	const seenThisRound = new Set<string>();
	for (const finding of findings) {
		const fingerprint = normalizeFindingFingerprint(finding.role, finding.text);
		if (!fingerprint.split(":")[1]) continue;
		// One review round counts a fingerprint once, however many reviewers repeat it.
		if (seenThisRound.has(fingerprint)) continue;
		seenThisRound.add(fingerprint);
		findingCounts[fingerprint] = (findingCounts[fingerprint] ?? 0) + 1;
		if (findingCounts[fingerprint] >= budget.maxSameFindingRepeats && !alreadyEscalated.has(fingerprint)) {
			const question = appendOperatorQuestionToFile(questionsFile, {
				question: `Review finding repeated ${findingCounts[fingerprint]}x for plan ${planId}/${phase}: "${finding.text.slice(0, FINDING_FINGERPRINT_CHARS)}" (${finding.role}). The delegate loop is not converging — continue re-delegating, change the plan, or take over?`,
				from: "brain",
				blocking: true,
				options: ["continue re-delegating", "revise the plan", "stop"],
				recommendedDefault: "revise the plan",
			});
			state = { ...state, escalations: [...state.escalations, { questionId: question.id, kind: "repeated-finding", fingerprint, at: new Date().toISOString() }] };
			escalated.push({ fingerprint, count: findingCounts[fingerprint], questionId: question.id });
			alreadyEscalated.add(fingerprint);
		}
	}
	const next = { ...state, findingCounts };
	writePhaseBudget(cwd, next, sessionManager);
	return { state: next, escalated };
}
