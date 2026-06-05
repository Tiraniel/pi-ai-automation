/**
 * repo_checkpoint tool — append-only evidence queue.
 *
 * Lazily syncs repo on execution, validates input, redacts secrets,
 * computes dedupe key, and inserts into SQLite with INSERT OR IGNORE.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildRuntime } from "../runtime";
import { syncRepo } from "../index/sync";
import { openDb, closeDb } from "../index/db";
import { appendEvidence, markPossiblyStaleEvidence } from "../evidence/queue";
import { loadConfig } from "../config/loader";
import { redactText } from "../security/redaction";

export const repoCheckpointParameters = Type.Object({
	contextVersion: Type.Optional(Type.String({ description: "Index context_version this evidence applies to" })),
	agentId: Type.Optional(Type.String({ description: "Agent identifier (e.g., 'brain', 'coder')" })),
	agentRole: Type.Optional(Type.String({ description: "Agent role in this turn" })),
	agentRunId: Type.Optional(Type.String({ description: "Unique run identifier (session + turn)" })),
	taskId: Type.Optional(Type.String({ description: "Active task identifier, if any" })),
	claim: Type.String({ description: "Short claim about what was done or learned" }),
	evidenceRefs: Type.Optional(Type.Array(Type.String(), { description: "File paths or line refs supporting claim" })),
	testRefs: Type.Optional(Type.Array(Type.String(), { description: "Tests that validate the claim" })),
	reviewRefs: Type.Optional(Type.Array(Type.String(), { description: "Reviews or PR refs" })),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.8 })),
	changedFiles: Type.Optional(Type.Array(Type.String(), { description: "Files modified in this turn" })),
	metadata: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Bounded agent metadata" })),
});

function tryGetSessionFile(ctx: ExtensionContext): string | null {
	try {
		// @ts-expect-error sessionManager may exist on newer Pi versions
		const sm = ctx?.sessionManager;
		if (sm && typeof sm.getSessionFile === "function") {
			return sm.getSessionFile();
		}
	} catch {
		// ignore
	}
	return null;
}

function deriveAgentId(params: any, _ctx: ExtensionContext): string {
	return String(params?.agentId ?? process.env.PI_WORKFLOW_AGENT_ID ?? "unknown");
}

function deriveAgentRole(params: any, _ctx: ExtensionContext): string {
	return String(params?.agentRole ?? process.env.PI_WORKFLOW_AGENT_ROLE ?? "unknown");
}

function deriveAgentRunId(params: any, ctx: ExtensionContext): string {
	return String(
		params?.agentRunId ??
		tryGetSessionFile(ctx) ??
		process.env.PI_SESSION_ID ??
		`${process.pid}-${Date.now()}`,
	);
}

function deriveTaskId(params: any, _ctx: ExtensionContext): string | null {
	const fromParams = params?.taskId;
	if (fromParams) return String(fromParams);
	const fromEnv = process.env.PI_TASK_ID ?? process.env.SPRINT_TASK_ID;
	if (fromEnv) return String(fromEnv);
	return null;
}

export function registerRepoCheckpoint(pi: ExtensionAPI) {
	pi.registerTool({
		name: "repo_checkpoint",
		label: "Repo: Checkpoint",
		description: "Append evidence about the current agent turn to the evidence queue.",
		promptSnippet: "Record evidence about a claim, test result, or decision",
		promptGuidelines: [
			"Use repo_checkpoint to record claims, evidence refs, test refs, and confidence after meaningful work.",
			"repo_checkpoint is append-only; it never overwrites or deletes prior evidence.",
			"Repeated claims within the dedupe window are silently deduplicated.",
		],
		parameters: repoCheckpointParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const rt = buildRuntime(ctx);
			const cfg = loadConfig(rt.repoRoot);
			if (!cfg.enabled) {
				return {
					content: [{ type: "text", text: "repo_checkpoint is disabled for this repository." }],
					details: { enabled: false },
				};
			}

			const eq = cfg.evidenceQueue;
			if (!eq.enabled) {
				return {
					content: [{ type: "text", text: "Evidence queue is disabled in config." }],
					details: { enabled: false },
				};
			}

			// Lazy sync
			const sync = syncRepo(rt.repoRoot, rt.repoKey, rt.cacheDbPath);

			const p = params as any;
			const claim = String(p?.claim ?? "").trim();
			if (!claim) {
				return {
					isError: true,
					content: [{ type: "text", text: "Missing required parameter: claim" }],
				};
			}

			const agentId = deriveAgentId(p, ctx);
			const agentRole = deriveAgentRole(p, ctx);
			const agentRunId = deriveAgentRunId(p, ctx);
			const taskId = deriveTaskId(p, ctx);
			const confidence = Math.max(0, Math.min(1, Number(p?.confidence ?? 0.8)));
			const evidenceRefs = Array.isArray(p?.evidenceRefs) ? p.evidenceRefs.map(String) : [];
			const testRefs = Array.isArray(p?.testRefs) ? p.testRefs.map(String) : [];
			const reviewRefs = Array.isArray(p?.reviewRefs) ? p.reviewRefs.map(String) : [];
			const changedFiles = Array.isArray(p?.changedFiles) ? p.changedFiles.map(String) : [];
			const metadata = (typeof p?.metadata === "object" && p.metadata !== null) ? p.metadata as Record<string, unknown> : null;

			// Determine context version and staleness
			let contextVersion = sync.contextVersion;
			let isStale = 0;
			let staleReason: string | null = null;
			if (p?.contextVersion && String(p.contextVersion) !== sync.contextVersion) {
				contextVersion = String(p.contextVersion);
				isStale = 1;
				staleReason = `context_version mismatch: provided ${contextVersion} vs current ${sync.contextVersion}`;
			}

			// Lazy stale marking of existing evidence
			const handle = openDb(rt.repoKey, rt.repoRoot);
			try {
				markPossiblyStaleEvidence(handle.db, rt.repoKey, sync.contextVersion);
			} finally {
				closeDb(handle);
			}

			const result = appendEvidence(
				{
					repoKey: rt.repoKey,
					repoRoot: rt.repoRoot,
					contextVersion,
					agentId,
					agentRole,
					agentRunId,
					taskId,
					claim,
					evidenceRefs,
					testRefs,
					reviewRefs,
					confidence,
					changedFiles,
					metadata,
					isStale,
					staleReason,
				},
				eq.maxClaimLength,
				eq.maxMetadataSizeBytes,
				eq.dedupeWindowHours,
			);

			// Build redacted output strings (clamp claim to match what was stored)
			const clampedClaim = claim.slice(0, eq.maxClaimLength);
			const redactedClaim = redactText(clampedClaim).text;
			const redactedEvidenceRefs = evidenceRefs.map((r) => redactText(r).text);
			const redactedTestRefs = testRefs.map((r) => redactText(r).text);
			const redactedReviewRefs = reviewRefs.map((r) => redactText(r).text);
			const redactedChangedFiles = changedFiles.map((r) => redactText(r).text);

			const lines = [
				"# repo_checkpoint",
				"",
				"## Result",
				`| Field | Value |`,
				`| --- | --- |`,
				`| recorded | ${result.recorded} |`,
				`| deduplicated | ${result.deduplicated} |`,
				`| context_version | ${result.contextVersion} |`,
				`| recorded_at | ${new Date(result.recordedAt).toISOString()} |`,
				`| stale_warning | ${result.staleWarning} |`,
				`| redacted | ${result.redacted} |`,
				`| evidence_id | ${result.id ?? "n/a"} |`,
				"",
				"## Queue Counts",
				`| Metric | Count |`,
				`| --- | --- |`,
				`| total_evidence | ${result.queueCounts.totalEvidence} |`,
				`| pending_evidence | ${result.queueCounts.pendingEvidence} |`,
				`| stale_evidence | ${result.queueCounts.staleEvidence} |`,
				"",
				"## Claim (redacted)",
				redactedClaim,
				"",
				"## Refs",
				`- evidenceRefs: ${JSON.stringify(redactedEvidenceRefs)}`,
				`- testRefs: ${JSON.stringify(redactedTestRefs)}`,
				`- reviewRefs: ${JSON.stringify(redactedReviewRefs)}`,
				`- changedFiles: ${JSON.stringify(redactedChangedFiles)}`,
			];

			if (result.staleWarning && result.staleReason) {
				lines.push("", `> **Stale warning:** ${result.staleReason}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					recorded: result.recorded,
					deduplicated: result.deduplicated,
					context_version: result.contextVersion,
					recorded_at: result.recordedAt,
					stale_warning: result.staleWarning,
					stale_reason: result.staleReason,
					redacted: result.redacted,
					evidence_id: result.id,
					queue_counts: result.queueCounts,
					claim: redactedClaim,
					evidence_refs: redactedEvidenceRefs,
					test_refs: redactedTestRefs,
					review_refs: redactedReviewRefs,
					changed_files: redactedChangedFiles,
					agent_id: agentId,
					agent_role: agentRole,
					agent_run_id: agentRunId,
					task_id: taskId,
					confidence,
				},
			};
		},
	});
}
