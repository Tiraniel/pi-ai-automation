// Workflow delegate runtime — reviewer swarm config and parallel runner.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// This module owns the reviewer-swarm identity: a small config-resolver,
// the verdict parser used to score reviewer output, the goal-task builder
// that prefixes a reviewer task with the assigned goal, and the bounded-
// concurrency runner that fans out to the headless/pane delegate runner.
// `runReviewerSwarm` calls into `./runner` for each target, so this module
// is the *one* place where delegate.ts cross-imports the runner module.

import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../defaults";
import type {
	AgentPreset,
	ReviewerSwarmConfig,
	ReviewerTargetResult,
	WorkflowConfig,
} from "../types";
import { deepMerge, loadWorkflowConfig } from "../runtime/config";
import { appendAgentIdSuffix, type ResolvedRoomContext } from "../rooms";
import { MAX_RENDERED_PROGRESS, MAX_TASK_PREVIEW } from "./constants";
import { normalizeFinalStatus, truncateText } from "./messages";
import { runDelegateAgent } from "./runner";

export function parseReviewerVerdict(text: string): "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN" {
	const normalized = text.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const token = trimmed.split(/\s+/)[0]?.toUpperCase() ?? "";
		if (token === "APPROVED") return "APPROVED";
		if (/^CHANGES[_\s-]?REQUESTED$/.test(token) || token === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
		if (/^CHANGES[_\s-]?REQUESTED$/.test(trimmed.toUpperCase())) return "CHANGES_REQUESTED";
		break;
	}

	const upper = normalized.toUpperCase();
	const approvedIndex = upper.search(/\bAPPROVED\b/);
	const changesIndex = upper.search(/\bCHANGES[_\s-]?REQUESTED\b/);
	if (approvedIndex >= 0 && (changesIndex < 0 || approvedIndex < changesIndex)) return "APPROVED";
	if (changesIndex >= 0) return "CHANGES_REQUESTED";
	return "UNKNOWN";
}

export function resolveReviewerSwarmConfig(config: WorkflowConfig): Required<ReviewerSwarmConfig> {
	const merged = deepMerge(DEFAULT_CONFIG.reviewerSwarm ?? {}, config.reviewerSwarm ?? {});
	const targets = Array.isArray(merged.targets) ? merged.targets.filter((target): target is string => typeof target === "string" && target.trim().length > 0) : [];
	return {
		enabled: merged.enabled !== false,
		maxConcurrency: Math.max(1, Number(merged.maxConcurrency ?? 2) || 2),
		targets: targets.length ? targets : [...(DEFAULT_CONFIG.reviewerSwarm?.targets ?? [])],
	};
}

export function buildReviewerGoalTask(task: string, goal: string): string {
	return `${task}\n\nAssigned review goal (code-only):\n- ${goal}\n\nReviewer checks should focus on implementation diffs, behavior, and validation evidence only.\nThe architecture/phase plan is context for intended behavior and scope, not a plan-quality rubric.\nDo not validate or critique Brain-owned plan quality.\nStart your response with APPROVED or CHANGES_REQUESTED.`;
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
): Promise<{ results: ReviewerTargetResult[]; failed: boolean; aborted: boolean }> {
	const swarm = resolveReviewerSwarmConfig(loadWorkflowConfig(ctx.cwd).config);
	const targets = goals && goals.length ? goals : swarm.targets;
	const queue = targets.map((target) => target.trim()).filter(Boolean);
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
			const result = await runDelegateAgent(ctx, "reviewer", buildReviewerGoalTask(task, target), requestedCwd, signal, undefined, perReviewerContext, presetOverride);
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
	const failed = results.some((item) => item.status !== "completed" || item.verdict !== "APPROVED");
	return { results, failed, aborted };
}
