// Workflow delegate runtime — reviewer swarm config and parallel runner.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// This module owns the reviewer-swarm identity: a small config-resolver,
// the verdict parser used to score reviewer output, the goal-task builder
// that prefixes a reviewer task with the assigned goal, and the bounded-
// concurrency runner that fans out to the headless/pane delegate runner.
// `runReviewerSwarm` calls into `./runner` for each target, so this module
// is the *one* place where delegate.ts cross-imports the runner module.
//
// TASK-004 Phase B: when an architecture plan/phase review context is
// supplied AND the plan has acceptanceEvidenceMatrix rows, the swarm runs
// in role mode: role targets are derived from the matrix + default role
// policy, each reviewer task is built via `buildReviewerRoleTask`, and
// results are evaluated with `evaluateReviewerResult`. The legacy
// configured-target / explicit-goal path is preserved for callers that
// pass no review context or whose plan has no matrix rows; the legacy
// `buildReviewerGoalTask` no longer uses the forbidden `code-only` label.

import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowArchitecturePlan } from "../architecture/types";
import { DEFAULT_CONFIG } from "../defaults";
import type {
	AgentPreset,
	ReviewerSwarmConfig,
	ReviewerTargetResult,
	WorkflowConfig,
} from "../types";
import { loadWorkflowConfig } from "../runtime/config";
import { appendAgentIdSuffix, type ResolvedRoomContext } from "../rooms";
import { MAX_RENDERED_PROGRESS, MAX_TASK_PREVIEW } from "./constants";
import { normalizeFinalStatus, truncateText } from "./messages";
import {
	buildReviewerMemoForResults,
	buildReviewerRoleTask,
	deriveReviewerRoleTargets,
	toReviewerTargetResult,
	type ReviewerEvaluation,
	type ReviewerMemo,
	type ReviewerResultLike,
	type ReviewerRolePlanShape,
	type ReviewerRoleTarget,
} from "./reviewer-roles";
import { writeReviewerMemoFile } from "./reviewer-memo-file";
import { parseReviewerVerdict } from "../reviewer-protocol";
import { runDelegateAgent } from "./runner";

export function resolveReviewerSwarmConfig(config: WorkflowConfig): Required<ReviewerSwarmConfig> {
	// ReviewerSwarmConfig is flat, and every field is re-validated below, so a
	// shallow merge suffices — no reach into runtime/config's merge internals.
	const merged: ReviewerSwarmConfig = { ...(DEFAULT_CONFIG.reviewerSwarm ?? {}), ...(config.reviewerSwarm ?? {}) };
	const targets = Array.isArray(merged.targets) ? merged.targets.filter((target): target is string => typeof target === "string" && target.trim().length > 0) : [];
	return {
		enabled: merged.enabled !== false,
		maxConcurrency: Math.max(1, Number(merged.maxConcurrency ?? 2) || 2),
		targets: targets.length ? targets : [...(DEFAULT_CONFIG.reviewerSwarm?.targets ?? [])],
	};
}

/**
 * Optional review context forwarded by `delegate_to_reviewer`. When the
 * plan carries `acceptanceEvidenceMatrix` rows, the swarm enters role
 * mode (matrix-derived roles, fail-closed role evaluation, durable memo).
 * When `plan` is absent or the matrix is empty, the swarm stays in
 * legacy mode (configured or explicit-goal targets) but the per-target
 * task no longer uses the forbidden `code-only` label.
 */
export interface ReviewerSwarmReviewContext {
	plan: WorkflowArchitecturePlan | ReviewerRolePlanShape | null | undefined;
	phase?: string;
}

/** Role-mode runtime state, kept on the swarm for the duration of the run. */
interface RoleModeState {
	targets: ReviewerRoleTarget[];
	supplementalGoals: string[];
	docsConfigInScope: boolean;
	rolesRequired: string[];
	derivedGoals: string[];
}

/** Detect whether a plan shape has matrix rows that trigger role mode. */
export function isMatrixGatedPlan(plan: ReviewerSwarmReviewContext["plan"]): boolean {
	return Boolean(plan && Array.isArray(plan.acceptanceEvidenceMatrix) && plan.acceptanceEvidenceMatrix.length > 0);
}

export function buildReviewerGoalTask(task: string, goal: string): string {
	// TASK-004 Phase B: drop the forbidden `code-only` label; the goal
	// framing is now role/quality-check oriented and identical to the
	// role-mode prompt scaffolding.
	return `${task}\n\nAssigned review goal:\n- ${goal}\n\nReviewer checks should focus on implementation diffs, behavior, validation evidence, and the assigned review goal.\nStart your response with APPROVED or CHANGES_REQUESTED as the first token — plain text, no markdown decoration around the word.`;
}

export async function runReviewerSwarm(
	ctx: ExtensionContext,
	task: string,
	requestedCwd: string | undefined,
	goals: string[] | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	roomContext?: ResolvedRoomContext,
	presetOverride?: AgentPreset,
	reviewContext?: ReviewerSwarmReviewContext,
): Promise<{
	results: ReviewerTargetResult[];
	failed: boolean;
	aborted: boolean;
	roleMode: boolean;
	evaluations: ReviewerEvaluation[];
	memo: ReviewerMemo | undefined;
	memoPath: string | undefined;
	rolesRequired: string[];
	supplementalGoals: string[];
	docsConfigInScope: boolean;
	derivedGoals: string[];
}> {
	const swarm = resolveReviewerSwarmConfig(loadWorkflowConfig(ctx.cwd).config);

	// Resolve role mode: only when a plan with matrix rows is supplied.
	const roleMode = isMatrixGatedPlan(reviewContext?.plan);
	let roleState: RoleModeState | undefined;
	let queue: string[];
	if (roleMode && reviewContext?.plan) {
		const derivation = deriveReviewerRoleTargets(reviewContext.plan, { goals: goals ?? undefined });
		roleState = {
			targets: derivation.targets,
			supplementalGoals: derivation.supplementalGoals,
			docsConfigInScope: derivation.docsConfigInScope,
			rolesRequired: [...derivation.rolesRequired],
			derivedGoals: derivation.targets.map((t) => t.target),
		};
		queue = roleState.derivedGoals;
	} else {
		// Legacy / no-matrix path: use configured or explicit-goal targets.
		// `code-only` wording is no longer emitted; explicit `goals` are
		// still honored verbatim when supplied.
		const legacyTargets = goals && goals.length ? goals : swarm.targets;
		queue = legacyTargets.map((target) => target.trim()).filter(Boolean);
	}

	const results: ReviewerTargetResult[] = queue.map((target) => ({ target, verdict: "UNKNOWN", status: "running" }));
	let cursor = 0;
	let aborted = false;

	const emit = () => {
		const completed = results.filter((item) => item.status !== "running").length;
		const lines = results.map((item, i) => `${item.status === "running" ? "…" : item.status === "completed" ? "✓" : "✗"} [${i + 1}] ${item.target} (${item.verdict})`);
		onUpdate?.({
			content: [{ type: "text", text: `reviewer swarm ${completed}/${results.length}` }],
			details: {
				agent: "reviewer",
				status: completed === results.length ? "completed" : aborted ? "aborted" : "running",
				progress: lines.slice(-MAX_RENDERED_PROGRESS).map((line) => ({ at: Date.now(), type: "status", text: line })),
				taskPreview: truncateText(task, MAX_TASK_PREVIEW),
				cwd: requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd,
				targets: results,
			},
		});
	};

	const markPendingAborted = () => {
		for (let i = 0; i < results.length; i++) {
			if (results[i].status === "running" && !results[i].result) {
				results[i] = { ...results[i], status: "aborted", verdict: "UNKNOWN" };
			}
		}
	};

	emit();
	const baseRoomAgentId = roomContext?.agentId;
	const worker = async () => {
		while (cursor < queue.length) {
			if (signal?.aborted) {
				aborted = true;
				markPendingAborted();
				emit();
				return;
			}
			const index = cursor;
			cursor++;
			const target = queue[index];
			emit();
			// When running with room context, give each parallel reviewer a unique agentId
			// so they don't share a single read cursor / status row. Reserve suffix space
			// before child-side sanitization/truncation.
			const perReviewerContext: ResolvedRoomContext | undefined = roomContext
				? { ...roomContext, agentId: appendAgentIdSuffix(baseRoomAgentId ?? "reviewer", String(index + 1)) }
				: roomContext;
			// Build the per-target task: role mode uses the role-aware builder;
			// legacy mode uses the configured-target builder (no `code-only`).
			const reviewerTask = roleState && roleState.targets[index]
				? buildReviewerRoleTask(task, roleState.targets[index])
				: buildReviewerGoalTask(task, target);
			const result = await runDelegateAgent(ctx, "reviewer", reviewerTask, requestedCwd, signal, undefined, perReviewerContext, presetOverride);
			if (result.aborted || signal?.aborted) aborted = true;
			const verdict = parseReviewerVerdict(result.finalOutput ?? "");
			results[index] = {
				target,
				verdict,
				status: normalizeFinalStatus(result),
				result,
			};
			emit();
			if (aborted) {
				markPendingAborted();
				emit();
				return;
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(swarm.maxConcurrency, queue.length) }, () => worker()));
	if (signal?.aborted) aborted = true;
	if (aborted) markPendingAborted();

	// ----- Role mode: evaluate, populate metadata, build & write memo -----
	let memo: ReviewerMemo | undefined;
	let memoPath: string | undefined;
	let evaluations: ReviewerEvaluation[] = [];
	let derivedGoals: string[] = [];
	let rolesRequired: string[] = [];
	let supplementalGoals: string[] = [];
	let docsConfigInScope = false;

	if (roleState && reviewContext?.plan) {
		const resultLikes: ReviewerResultLike[] = results.map((r) => ({
			verdict: r.verdict,
			finalOutput: r.result?.finalOutput ?? "",
			completionSource: r.result?.completionSource,
			completionWarning: r.result?.completionWarning,
			status: r.status,
			details: (r.result as unknown as { details?: Record<string, unknown> } | undefined)?.details,
		}));
		// Use the canonical helper so synthetic and runtime paths share one
		// derivation/evaluation path. Pass `goals` so the consolidated memo
		// preserves the caller's supplemental goals instead of re-deriving
		// an empty list from the plan shape.
		const { memo: builtMemo, evaluations: builtEvals } = buildReviewerMemoForResults(
			reviewContext.plan,
			reviewContext.phase,
			resultLikes,
			{ goals: goals ?? undefined },
		);
		memo = builtMemo;
		evaluations = builtEvals;
		derivedGoals = roleState.derivedGoals;
		rolesRequired = [...builtMemo.rolesRequired];
		supplementalGoals = builtMemo.supplementalGoals;
		docsConfigInScope = builtMemo.docsConfigInScope;
		// Persist memo to disk for Brain/operator review, plus the structured
		// JSON sidecar finalization reads back (no markdown re-parsing).
		memoPath = writeReviewerMemoFile(ctx.cwd, reviewContext.plan?.planId, reviewContext.phase, builtMemo.markdown, builtMemo) ?? undefined;
		// Re-stamp the per-result `ReviewerTargetResult` with role metadata so
		// downstream tools can surface effective verdict / blockers without
		// re-deriving the role state.
		for (let i = 0; i < results.length; i += 1) {
			const roleTarget = roleState.targets[i];
			const evaluation = builtEvals[i];
			if (!roleTarget || !evaluation) continue;
			results[i] = toReviewerTargetResult(roleTarget, evaluation, results[i].result);
		}
	}

	// Compute `failed`:
	//   - role mode: required role with effectiveVerdict !== APPROVED, is
	//     provisional, has blocking reasons, or is missing => fail-closed.
	//     Also fail-closed when the role-mode memo exists but was not
	//     durably written (memoPath === undefined), so a transient disk
	//     failure can never silently pass final approval.
	//   - legacy mode: any result with status !== "completed" or verdict
	//     !== "APPROVED" => failed.
	let failed: boolean;
	if (roleState) {
		failed = results.some((item) => {
			if (item.required !== true) return false;
			if (item.status !== "completed") return true;
			const eff = item.effectiveVerdict ?? item.verdict;
			if (eff !== "APPROVED") return true;
			if (item.provisional === true) return true;
			if ((item.blockingReasons?.length ?? 0) > 0) return true;
			return false;
		});
		if (memo && memo.missingRequiredRoles.length > 0) failed = true;
		if (memo && memoPath === undefined) failed = true;
	} else {
		failed = results.some((item) => item.status !== "completed" || item.verdict !== "APPROVED");
	}

	return {
		results,
		failed,
		aborted,
		roleMode,
		evaluations,
		memo,
		memoPath,
		rolesRequired,
		supplementalGoals,
		docsConfigInScope,
		derivedGoals,
	};
}
