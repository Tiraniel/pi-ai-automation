// Workflow delegate runtime — reviewer memo file helper.
// Extracted from `delegate/tools.ts` as part of TASK-004 Phase B so the
// tools module stays under the repo LOC quality bar. This module owns:
//   - reviewer-memo path resolution under `.pi/workflow-runs/reviewer-memos/`
//   - sanitized, deterministic filename derivation from planId/phase
//   - memo markdown disk write
//   - load/read-back for the integration smoke
//   - consolidated final-output / detail shaping for the delegate tool,
//     including a structural `reviewerMemo` summary that downstream
//     consumers (Brain, the integration smoke) can inspect without
//     re-walking the swarm results.

import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../fs-atomic";
import { getWorkflowRunsRoot } from "../rooms";
import type { UsageStats } from "../types";
import type { ReviewerMemo } from "./reviewer-roles";
import type { ReviewerTargetResult } from "../types";

/** Directory under the workflow-runs root where reviewer memos are stored. */
export const REVIEWER_MEMO_DIRNAME = "reviewer-memos";

/** Filename suffix used in error/fallback paths. */
export const REVIEWER_MEMO_FILE_EXT = ".md";

/** Reserved path characters that must be replaced when sanitizing inputs. */
const FORBIDDEN_PATH_CHARS = /[\\/:*?"<>|\s]+/g;

/**
 * Sanitize a planId/phase so it is safe to embed in a deterministic filename.
 * Preserves alphanumerics, dot, underscore, and dash; replaces any other
 * run of characters with a single dash. Empty inputs return a placeholder.
 */
export function sanitizeMemoFileSegment(value: string | undefined | null, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (!trimmed) return fallback;
	const sanitized = trimmed.replace(FORBIDDEN_PATH_CHARS, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || fallback;
}

/** Build the absolute path for a reviewer memo for a given plan/phase. */
export function buildReviewerMemoPath(
	cwd: string,
	planId: string | undefined,
	phase: string | undefined,
): { dir: string; file: string } {
	const root = getWorkflowRunsRoot(cwd);
	const dir = path.join(root, REVIEWER_MEMO_DIRNAME);
	const safePlan = sanitizeMemoFileSegment(planId, "plan");
	const safePhase = sanitizeMemoFileSegment(phase, "phase");
	const file = path.join(dir, `${safePlan}-${safePhase}${REVIEWER_MEMO_FILE_EXT}`);
	return { dir, file };
}

/**
 * Ensure the reviewer-memo directory exists and write the markdown payload.
 * Returns the absolute file path on success, or `undefined` when the write
 * fails. Errors are intentionally swallowed (logged to stderr) so a memo
 * write failure never breaks the reviewer swarm result; callers should
 * treat `undefined` as "memo not durable" and surface that in the tool
 * output.
 */
export function writeReviewerMemoFile(
	cwd: string,
	planId: string | undefined,
	phase: string | undefined,
	markdown: string,
	memo?: ReviewerMemo,
): string | undefined {
	const { file } = buildReviewerMemoPath(cwd, planId, phase);
	try {
		writeFileAtomicSync(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[reviewer-memo] failed to write memo file ${file}: ${message}\n`);
		return undefined;
	}
	// Structured sidecar: finalization reads THIS (single source of truth),
	// not a regex re-parse of the markdown. Markdown stays the human artifact.
	if (memo) {
		const sidecar = reviewerMemoSidecarPath(file);
		try {
			writeFileAtomicSync(sidecar, `${JSON.stringify({ version: 1, memo }, null, 2)}\n`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[reviewer-memo] failed to write memo sidecar ${sidecar}: ${message}\n`);
			// Markdown memo is durable; consumers fall back to parsing it.
		}
	}
	return file;
}

/** Path of the structured JSON sidecar next to a memo markdown file. */
export function reviewerMemoSidecarPath(memoFile: string): string {
	return memoFile.replace(/\.md$/, ".json");
}

/** Read the structured memo sidecar; `undefined` when missing or malformed. */
export function readReviewerMemoSidecar(memoFile: string): ReviewerMemo | undefined {
	try {
		const raw = fs.readFileSync(reviewerMemoSidecarPath(memoFile), "utf8");
		const parsed = JSON.parse(raw) as { version?: number; memo?: ReviewerMemo };
		const memo = parsed?.memo;
		if (memo && typeof memo === "object" && Array.isArray(memo.rolesRequired) && typeof memo.approved === "boolean") {
			return memo;
		}
	} catch {
		// fall through — caller falls back to markdown parsing
	}
	return undefined;
}

/** Read a reviewer memo from disk; returns `undefined` if the file is missing. */
export function readReviewerMemoFile(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

// ---------- Tool output / detail shaping ----------

/**
 * Build the per-target `progress` lines used in the reviewer tool
 * `details.progress` field. Mirrors the format the legacy single-path
 * swarm emitted so existing consumer code keeps working.
 */
export function formatReviewerProgressLines(results: ReadonlyArray<ReviewerTargetResult>): Array<{ at: number; type: "status"; text: string }> {
	return results.map((item, index) => ({ at: Date.now(), type: "status", text: `[${index + 1}] ${item.target} ${item.verdict} (${item.status})` }));
}

/**
 * Compute the reviewer tool's `status` string from a swarm result. The
 * precedence is `aborted` > `failed` > `completed` because aborted
 * always means the parent signal fired, regardless of whether any
 * target had already failed.
 */
export function resolveReviewerSwarmStatus(swarm: { aborted: boolean; failed: boolean }): "aborted" | "failed" | "completed" {
	if (swarm.aborted) return "aborted";
	if (swarm.failed) return "failed";
	return "completed";
}

/**
 * Build the per-target raw-output lines used in the tool result's
 * `## Raw reviewer outputs` appendix. Each line carries the target id,
 * verdict/status, and the underlying delegate finalOutput (or a
 * placeholder when the underlying delegate produced nothing).
 */
export function formatReviewerRawOutputLines(results: ReadonlyArray<ReviewerTargetResult>): string[] {
	return results.map((item, index) => {
		const detail = (item as { result?: { finalOutput?: string; stderr?: string; errorMessage?: string } }).result
			? ((item as { result: { finalOutput?: string; stderr?: string; errorMessage?: string } }).result.finalOutput
				|| (item as { result: { finalOutput?: string; stderr?: string; errorMessage?: string } }).result.errorMessage
				|| (item as { result: { finalOutput?: string; stderr?: string; errorMessage?: string } }).result.stderr
				|| "(no output)")
			: "(no output)";
		return `[${index + 1}] ${item.target}\n${item.verdict} (${item.status})\n${detail}`;
	});
}

/**
 * Aggregate `UsageStats` across a reviewer swarm's `results`. Skips
 * results with no `result` payload (which only happens for queue slots
 * that were never executed). `contextTokens` is the max across results
 * (per-result context windows are not additive).
 */
export function aggregateSwarmUsage(results: ReadonlyArray<ReviewerTargetResult>): UsageStats {
	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	for (const item of results) {
		const resultUsage = (item as { result?: { usage?: UsageStats } }).result?.usage;
		if (!resultUsage) continue;
		usage.input += resultUsage.input;
		usage.output += resultUsage.output;
		usage.cacheRead += resultUsage.cacheRead;
		usage.cacheWrite += resultUsage.cacheWrite;
		usage.cost += resultUsage.cost;
		usage.contextTokens = Math.max(usage.contextTokens, resultUsage.contextTokens);
		usage.turns += resultUsage.turns;
	}
	return usage;
}

/**
 * Build the user-facing `finalOutput` text for the reviewer tool result.
 * When a role-mode memo is present, the memo header + memo body come first
 * (operator reads the consolidated memo before the per-target outputs),
 * followed by a `## Raw reviewer outputs` appendix. Without a memo, the
 * output is the legacy single-line status header.
 *
 * `memoWriteFailed` overrides the rendered "Memo decision" so a durably-
 * lost memo cannot be presented as "approved" in the human-readable tool
 * output. The decision text falls back to "blocked (memo write failed)"
 * when the caller has already detected the failure and passed the flag
 * in. The `effectiveStatus` is the source of truth and is rendered as
 * the leading `[reviewer] <status>` token.
 */
export function buildReviewerFinalOutput(input: {
	status: string;
	memo?: ReviewerMemo;
	memoPath?: string;
	rawOutputLines: string[];
	memoWriteFailed?: boolean;
}): string {
	const { status, memo, memoPath, rawOutputLines, memoWriteFailed } = input;
	const rawAppendix = rawOutputLines.length > 0 ? `\n\n## Raw reviewer outputs\n\n${rawOutputLines.join("\n\n")}` : "";
	const decisionText = memoWriteFailed
		? "blocked (memo write failed)"
		: (memo?.approved ? "approved" : "blocked");
	const header = memo
		? `[reviewer] ${status}\n\nReviewer memo written to: ${memoPath ?? "(memo write failed)"}\nMemo decision: ${decisionText}\n${memo.finalRecommendation}`
		: `[reviewer] ${status}`;
	const body = memo ? `\n\n${memo.markdown}` : "";
	return `${header}${body}${rawAppendix}`;
}

/**
 * Project a `ReviewerMemo` onto a small structural summary suitable for
 * the delegate tool's `details.reviewerMemo` field. Keeps the markdown
 * payload (so Brain can render the full memo) and condenses role buckets
 * to `{ role, verdict, provisional, ... }` shapes that are easy for
 * downstream tooling to inspect without re-walking the swarm results.
 */
export function summarizeReviewerMemo(memo: ReviewerMemo | undefined): Record<string, unknown> | undefined {
	if (!memo) return undefined;
	const bucket = (entries: ReadonlyArray<{ role: string; effectiveVerdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN"; provisional: boolean; blockingReasons: string[] }>, extra?: Record<string, unknown>) =>
		entries.map((e) => ({ role: e.role, verdict: e.effectiveVerdict, provisional: e.provisional, blockingReasons: e.blockingReasons, ...(extra ?? {}) }));
	return {
		planId: memo.planId,
		phase: memo.phase,
		approved: memo.approved,
		finalRecommendation: memo.finalRecommendation,
		markdown: memo.markdown,
		missingRequiredRoles: memo.missingRequiredRoles,
		rolesRequired: memo.rolesRequired,
		supplementalGoals: memo.supplementalGoals,
		docsConfigInScope: memo.docsConfigInScope,
		approvals: bucket(memo.approvals),
		changesRequested: bucket(memo.changesRequested),
		weakEvidence: memo.weakEvidence.map((e) => ({ role: e.role, weakEvidence: e.weakEvidence })),
		promptOnlyCaveats: memo.promptOnlyCaveats.map((e) => ({ role: e.role, promptOnlyCaveats: e.promptOnlyCaveats })),
		unresolvedRisks: memo.unresolvedRisks.map((e) => ({ role: e.role, unresolvedRisks: e.unresolvedRisks })),
		provisionalCaveats: memo.provisionalCaveats.map((e) => ({ role: e.role, provisional: e.provisional })),
	};
}

/**
 * Minimal shape the reviewer tool needs to render its result block. The
 * helper accepts a `runReviewerSwarm` result plus the architecture-gate
 * fields and produces the canonical `{ content, details, isError }`
 * shape with role-mode metadata, the consolidated memo, and the
 * aggregated usage / progress.
 */
export interface ReviewerToolResultInput {
	delegatedTask: string;
	requestedCwd: string | undefined;
	baseCwd: string;
	planId: string;
	phase: string;
	swarm: {
		results: ReadonlyArray<ReviewerTargetResult>;
		failed: boolean;
		aborted: boolean;
		roleMode: boolean;
		evaluations: ReadonlyArray<unknown>;
		memo?: ReviewerMemo;
		memoPath?: string;
		rolesRequired: ReadonlyArray<string>;
		supplementalGoals: ReadonlyArray<string>;
		docsConfigInScope: boolean;
		derivedGoals: ReadonlyArray<string>;
	};
	reviewerUpdate: unknown;
}

/** Build the `delegate_to_reviewer` tool result from a swarm run. */
export function buildReviewerToolResult(input: ReviewerToolResultInput): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError: boolean } {
	const { delegatedTask, requestedCwd, baseCwd, planId, phase, swarm, reviewerUpdate } = input;
	const lines = formatReviewerRawOutputLines(swarm.results);
	const usage = aggregateSwarmUsage(swarm.results);
	const status = resolveReviewerSwarmStatus(swarm);
	const memo = swarm.memo;
	const memoPath = swarm.memoPath;
	// Fail-closed defense: a role-mode run that produced a memo but did NOT
	// durably write it (memoPath === undefined) must surface as a failure so
	// callers (Brain, the integration smoke) never see a passing approval
	// when the durable artifact was lost.
	const memoWriteFailed = Boolean(memo) && memoPath === undefined;
	// A failed durable phase update is a hard error even when the review
	// itself completed: the plan on disk did not advance.
	const phaseUpdateFailed = Boolean(reviewerUpdate);
	const effectiveStatus = memoWriteFailed || phaseUpdateFailed ? "failed" : status;
	const finalOutput = buildReviewerFinalOutput({ status: effectiveStatus, memo, memoPath, rawOutputLines: lines, memoWriteFailed });
	return {
		content: [{ type: "text", text: finalOutput }],
		details: {
			agent: "reviewer",
			task: delegatedTask,
			cwd: requestedCwd ? path.resolve(baseCwd, requestedCwd) : baseCwd,
			status: effectiveStatus,
			swarm: swarm.results,
			progress: formatReviewerProgressLines(swarm.results),
			usage,
			exitCode: swarm.failed || memoWriteFailed ? 1 : 0,
			finalOutput,
			planId,
			phase,
			roleMode: swarm.roleMode,
			rolesRequired: swarm.rolesRequired,
			supplementalGoals: swarm.supplementalGoals,
			docsConfigInScope: swarm.docsConfigInScope,
			derivedGoals: swarm.derivedGoals,
			reviewerMemoPath: memoPath,
			reviewerMemo: summarizeReviewerMemo(memo),
			evaluations: swarm.evaluations,
			architectureGatePlanUpdateError: reviewerUpdate,
		},
		isError: effectiveStatus !== "completed",
	};
}
