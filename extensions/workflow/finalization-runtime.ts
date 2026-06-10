#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";

import { resolveSprintPathForStore } from "./architecture/sprint-path";
import { getPlanStoragePath, readArchitecturePlan } from "./architecture/store";
import type { WorkflowArchitecturePlan } from "./architecture/types";
import { DELEGATE_MANIFEST_DIR } from "./delegate/constants";
import type { ReviewerMemo } from "./delegate/reviewer-roles";
import type { DelegateCompletionSource } from "./types";
import { evaluateFinalizationGate, isFinalizationStatus, type FinalizationGateResult, type FinalizationMode } from "./finalization-gate";

interface DoneSidecar {
	done?: boolean;
	summary?: string;
	at?: string;
	exit_code?: number;
	from_exit?: boolean;
	tool?: string;
	completion?: "explicit" | "auto_exit" | "process_exit";
	source?: "tool" | "agent_end" | "shell_exit";
	from_auto_exit?: boolean;
	stop_reason?: string;
	warning?: string;
	coderEvidence?: unknown;
}

interface PaneManifest {
	agent: "coder" | "reviewer";
	state: "running" | "completed" | "failed" | "aborted";
	task: string;
	doneFile: string;
	updatedAt: string;
	startedAt: string;
	done?: {
		completion?: "explicit" | "auto_exit" | "process_exit";
		source?: "tool" | "agent_end" | "shell_exit";
		summary?: string;
	};
}

function readJsonFile<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function parseDoneSidecar(filePath: string): DoneSidecar | undefined {
	const value = readJsonFile<Record<string, unknown>>(filePath);
	if (!value || typeof value !== "object") return undefined;
	return {
		done: typeof value.done === "boolean" ? value.done : undefined,
		summary: typeof value.summary === "string" ? value.summary : undefined,
		at: typeof value.at === "string" ? value.at : undefined,
		exit_code: typeof value.exit_code === "number" ? value.exit_code : undefined,
		from_exit: typeof value.from_exit === "boolean" ? value.from_exit : undefined,
		tool: typeof value.tool === "string" ? value.tool : undefined,
		completion: value.completion === "explicit" || value.completion === "auto_exit" || value.completion === "process_exit"
			? value.completion
			: undefined,
		source: value.source === "tool" || value.source === "agent_end" || value.source === "shell_exit"
			? value.source
			: undefined,
		from_auto_exit: typeof value.from_auto_exit === "boolean" ? value.from_auto_exit : undefined,
		stop_reason: typeof value.stop_reason === "string" ? value.stop_reason : undefined,
		warning: typeof value.warning === "string" ? value.warning : undefined,
		coderEvidence: value.coderEvidence,
	};
}


const WORKFLOW_RUNS_DIR_NAME = "workflow-runs";
const REVIEWER_MEMO_DIR_NAME = "reviewer-memos";
const REVIEWER_MEMO_FILE_EXT = ".md";
const FORBIDDEN_MEMO_PATH_CHARS = /[\\/:*?"<>|\s]+/g;

function workflowRunsRoot(cwd: string): string {
	return path.join(cwd, ".pi", WORKFLOW_RUNS_DIR_NAME);
}

function sanitizeReviewerMemoSegment(value: string | undefined | null, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (!trimmed) return fallback;
	const sanitized = trimmed.replace(FORBIDDEN_MEMO_PATH_CHARS, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || fallback;
}

function buildReviewerMemoPath(cwd: string, planId: string | undefined, phase: string | undefined): string {
	const root = workflowRunsRoot(cwd);
	const safePlan = sanitizeReviewerMemoSegment(planId, "plan");
	const safePhase = sanitizeReviewerMemoSegment(phase, "phase");
	return path.join(root, REVIEWER_MEMO_DIR_NAME, `${safePlan}-${safePhase}${REVIEWER_MEMO_FILE_EXT}`);
}

function readReviewerMemoFile(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

interface EvaluateSprintFinalizationInput {
	cwd: string;
	taskId: string;	requestedStatus: string;	mode?: FinalizationMode;
	finalNote?: string;	finalEvidence?: string;	sessionManager?: any;	planId?: string;
}

interface EvaluateDebugFinalizationInput {
	itemId: string;	requestedStatus: string;	mode?: FinalizationMode;	finalNote?: string;	finalEvidence?: string;	debugChain?: { repeatedInAreaCount?: number; priorFailureCount?: number };
}

type ReviewPhase = "phaseA" | "phaseB";

interface DelegateHistory {
	attempts: Array<{ attempt: number; completionSource: DelegateCompletionSource; status: "completed" | "failed" | "aborted"; finalOutputPreview?: string; at?: string }>;
	autoExitObserved: boolean;
	processExitObserved: boolean;
	missingSidecarObserved: boolean;
	freeFormOnlyObserved: boolean;
	retries: number;
	warnings: string[];
}

interface ManifestRecord {
	manifest: PaneManifest;
	sidecar?: DoneSidecar;
	completionSource: DelegateCompletionSource;
	hasSidecar: boolean;
	attemptStatus: "completed" | "failed" | "aborted";
	hasCoderEvidence: boolean;
	coderEvidence?: unknown;
	at: string;
	preview?: string;
}


function normalizeMode(mode?: FinalizationMode): FinalizationMode {
	return mode === "dry-run" ? "dry-run" : "strict";
}

function trimText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

const normalizeSectionHeading = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

function extractSection(markdown: string, title: string): string {
	const lines = markdown.split(/\r?\n/);
	const target = normalizeSectionHeading(title);
	const sectionHeader = /^##\s+(.+?)\s*$/;
	let start = -1;
	for (let i = 0; i < lines.length; i += 1) {
		const headingMatch = trimText(lines[i]).match(sectionHeader);
		if (headingMatch && normalizeSectionHeading(headingMatch[1] || "") === target) {
			start = i;
			break;
		}
	}
	if (start < 0) return "";
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (sectionHeader.test(lines[i])) { end = i; break; }
	}
	return lines.slice(start + 1, end).join("\n").trim();
}

function firstLine(section: string): string {
	for (const raw of section.split(/\r?\n/)) {
		const value = trimText(raw);
		if (!value) continue;
		if (/^#+\s+/.test(value)) continue;
		return value;
	}
	return "";
}

function isNoopListMarker(value: string): boolean {
	const normalized = trimText(value).toLowerCase();
	if (!normalized) return false;
	const compact = normalized.replace(/^[`*_~\s]+|[`*_~\s]+$/g, "").trim();
	if (!compact) return false;
	return compact === "none" || compact === "(none)" || compact === "_(none)_" || compact === "n/a" || compact === "n\\/a";
}

function parseListSection(section: string): string[] {
	const lines = section.split(/\r?\n/);
	const out: string[] = [];
	for (const line of lines) {
		const value = trimText(line).replace(/^[-*]\s*/, "");
		if (!value) continue;
		if (/^#+\s+/.test(value)) continue;
		if (isNoopListMarker(value)) continue;
		out.push(value);
	}
	return out;
}

function parseReviewerMemoMarkdown(markdown: string, planId: string, phase: ReviewPhase): ReviewerMemo {
	const finalRecommendation = firstLine(extractSection(markdown, "Final recommendation") || markdown) || "UNKNOWN";
	const sectionEntries = (titles: string[]): string[] => [...new Set(titles.flatMap((title) => parseListSection(extractSection(markdown, title))))];
	const changesRequestedSection = sectionEntries(["Changes requested", "Changes requested / blocked", "Blocked", "Changes requested or blocked", "Changes requested/blocked", "Changes-requested"]);
	const unknownOrFailedSection = sectionEntries(["Unknown / failed", "Unknown or failed", "Failed / unknown"]);
	const blockedByFinalRecommendation = /changes requested|blocked|not approved|changes-requested/i.test(finalRecommendation);
	const blockedBySection = changesRequestedSection.length > 0 || unknownOrFailedSection.length > 0;
	const blockedByMemo = blockedByFinalRecommendation || blockedBySection;
	const approved = /approved/i.test(finalRecommendation) && !blockedByMemo;
	const missingRoles = parseListSection(
		extractSection(markdown, "Missing required roles") || extractSection(markdown, "Missing roles"),
	).filter((role): role is ReviewerMemo["missingRequiredRoles"][number] => {
		const validRoles = new Set(["behavior", "implementation", "evidence-test", "regression", "maintainability", "docs-config"]);
		return validRoles.has(role);
	});
	const caveatsLines = parseListSection(
		extractSection(markdown, "Prompt-only caveats") || extractSection(markdown, "Prompt only caveats") || extractSection(markdown, "Prompt-only notes"),
	);
	const promptOnlyCaveats = caveatsLines.length > 0
		? caveatsLines.map((line) => ({
			role: "implementation" as const,
			target: "runtime behavior",
			required: true,
			verdict: "APPROVED" as const,
			effectiveVerdict: "APPROVED" as const,
			provisional: false,
			blockingReasons: [],
			weakEvidence: [],
			unresolvedRisks: [],
			supplementalGoals: [],
			notes: [line],
			promptOnlyCaveats: [line],
		}))
		: [];
	const buildEval = (line: string, verdict: "CHANGES_REQUESTED" | "UNKNOWN") => ({
		role: "implementation" as const,
		target: "finalization",
		required: true,
		verdict,
		effectiveVerdict: verdict,
		provisional: false,
		blockingReasons: [line],
		weakEvidence: [],
		unresolvedRisks: [],
		supplementalGoals: [],
		notes: [line],
		promptOnlyCaveats: [],
	});
	const changesRequested: ReviewerMemo["changesRequested"] = changesRequestedSection.map((line) => buildEval(line, "CHANGES_REQUESTED"));
	if (blockedByFinalRecommendation && changesRequestedSection.length === 0) {
		changesRequested.push(buildEval(finalRecommendation, "CHANGES_REQUESTED"));
	}
	const unknownOrFailed: ReviewerMemo["unknownOrFailed"] = unknownOrFailedSection.map((line) => buildEval(line, "UNKNOWN"));

	return {
		planId,
		phase,
		approved,
		finalRecommendation,
		approvals: [],
		changesRequested,
		weakEvidence: [],
		promptOnlyCaveats,
		unresolvedRisks: [],
		provisionalCaveats: [],
		unknownOrFailed,
		markdown,
		supplementalGoals: [],
		docsConfigInScope: false,
		rolesRequired: [],
		missingRequiredRoles: missingRoles,
	};
}

function readLatestReviewerMemo(cwd: string, planId: string | undefined, plan?: WorkflowArchitecturePlan): ReviewerMemo | undefined {
	if (!planId) return undefined;
	const phaseBStarted = plan?.phases?.phaseB?.status && plan?.phases?.phaseB?.status !== "not_started";
	const firstPhase: ReviewPhase = phaseBStarted ? "phaseB" : "phaseA";
	const readOrder: ReviewPhase[] = [firstPhase, firstPhase === "phaseB" ? "phaseA" : "phaseB"];
	for (const phase of readOrder) {
		const memoPath = buildReviewerMemoPath(cwd, planId, phase);
		const markdown = readReviewerMemoFile(memoPath);
		if (!markdown) continue;
		return parseReviewerMemoMarkdown(trimText(markdown), planId, phase);
	}
	return undefined;
}

function completionSourceFrom(manifest: PaneManifest, sidecar: DoneSidecar | undefined, hasSidecar: boolean): DelegateCompletionSource {
	if (!hasSidecar) return "missing";
	if (sidecar?.completion === "auto_exit") return "auto_exit";
	if (sidecar?.completion === "process_exit") return "process_exit";
	if (sidecar?.from_exit || manifest.done?.source === "shell_exit") return "process_exit";
	if (manifest.done?.source === "agent_end") return "auto_exit";
	if (sidecar?.done === true) return "explicit";
	if (manifest.done?.completion === "auto_exit") return "auto_exit";
	if (manifest.done?.completion === "process_exit") return "process_exit";
	if (manifest.state === "failed" || manifest.state === "aborted") return "process_exit";
	return "explicit";
}

function readMatchingManifests(cwd: string, planId: string | undefined): ManifestRecord[] {
	if (!planId) return [];
	const root = workflowRunsRoot(cwd);
	const manifestDir = path.join(root, DELEGATE_MANIFEST_DIR);
	let manifestFiles: string[] = [];
	try {
		manifestFiles = fs.readdirSync(manifestDir).filter((entry) => entry.endsWith(".json")).map((entry) => path.join(manifestDir, entry));
	} catch {
		return [];
	}
	const expected = `architecture plan ${planId}`.toLowerCase();
	const out: ManifestRecord[] = [];
	for (const file of manifestFiles) {
		let manifest: PaneManifest;
		try {
			manifest = JSON.parse(fs.readFileSync(file, "utf8")) as PaneManifest;
		} catch {
			continue;
		}
		if (manifest.agent !== "coder" && manifest.agent !== "reviewer") continue;
		if (!trimText(manifest.task).toLowerCase().includes(expected)) continue;
		const sidecarPath = trimText(manifest.doneFile);
		const hasSidecar = Boolean(sidecarPath && fs.existsSync(sidecarPath));
		const sidecar = hasSidecar ? parseDoneSidecar(sidecarPath) : undefined;
		const completionSource = completionSourceFrom(manifest, sidecar, hasSidecar);
		const attemptStatus = sidecar?.done === false || manifest.state === "failed" || manifest.state === "aborted"
			? "failed"
			: sidecar?.done === true || manifest.state === "completed"
				? "completed"
				: "aborted";
		const at = trimText(sidecar?.at) || trimText(manifest.updatedAt) || trimText(manifest.startedAt) || new Date().toISOString();
		out.push({
			manifest,
			sidecar,
			completionSource,
			hasSidecar,
			attemptStatus,
			hasCoderEvidence: manifest.agent === "coder" && Boolean(sidecar?.coderEvidence),
			coderEvidence: manifest.agent === "coder" ? sidecar?.coderEvidence : undefined,
			at,
			preview: trimText(sidecar?.summary || sidecar?.warning || manifest.done?.summary),
		});
	}
	out.sort((left, right) => (trimText(right.at) > trimText(left.at) ? 1 : trimText(right.at) < trimText(left.at) ? -1 : 0));
	return out;
}

function mergeManifestHistory(records: ManifestRecord[]): { history: DelegateHistory; source?: DelegateCompletionSource; latestEvidence?: unknown } {
	const history: DelegateHistory = {
		attempts: [],
		autoExitObserved: false,
		processExitObserved: false,
		missingSidecarObserved: false,
		freeFormOnlyObserved: false,
		retries: 0,
		warnings: [],
	};
	let latestEvidence: unknown | undefined;
	let latestSource: DelegateCompletionSource | undefined;
	records.forEach((record, index) => {
		history.attempts.push({
			attempt: index + 1,
			completionSource: record.completionSource,
			status: record.attemptStatus,
			finalOutputPreview: record.preview,
			at: record.at,
		});
		if (record.completionSource === "auto_exit") {
			history.autoExitObserved = true;
			history.warnings.push("Matched auto_exit delegate completion for task finalization evidence.");
			if (record.attemptStatus === "failed" || record.attemptStatus === "aborted") history.retries += 1;
		}
		if (record.completionSource === "process_exit") {
			history.processExitObserved = true;
			history.warnings.push("Matched process_exit delegate completion for task finalization evidence.");
			history.retries += 1;
		}
		if (!record.hasSidecar) {
			history.missingSidecarObserved = true;
			history.warnings.push("Matched delegate run without a done sidecar.");
			history.retries += 1;
		}
		if (record.attemptStatus === "aborted" || record.attemptStatus === "failed") {
			history.warnings.push(`Matched ${record.manifest.agent} manifest with status ${record.attemptStatus}.`);
			history.retries += 1;
		}
		if (record.hasCoderEvidence && latestEvidence === undefined) {
			latestEvidence = record.coderEvidence;
			latestSource = record.completionSource;
		}
	});
	history.warnings = [...new Set(history.warnings)].slice(0, 20);
	return { history, source: latestSource, latestEvidence };
}

function mergeEvidenceWithHistory(evidence: unknown, history: DelegateHistory): unknown {
	if (!evidence || typeof evidence !== "object") {
		return {
			filesChanged: [],
			commandsRun: [],
			criterionCoverage: [],
			knownGaps: [],
			caveats: [],
			delegateHistory: history,
		};
	}
	const existingHistory = (evidence as { delegateHistory?: { attempts?: unknown[]; warnings?: unknown[]; retries?: number; autoExitObserved?: unknown; processExitObserved?: unknown; missingSidecarObserved?: unknown; freeFormOnlyObserved?: unknown } }).delegateHistory;
	return {
		...evidence,
		delegateHistory: {
			...history,
			attempts: [...(existingHistory?.attempts as unknown[] | undefined || []), ...history.attempts],
			warnings: [...(existingHistory?.warnings as unknown[] | undefined || []), ...history.warnings],
			retries: Math.max(Number(existingHistory?.retries ?? 0), history.retries),
			autoExitObserved: Boolean(existingHistory?.autoExitObserved) || history.autoExitObserved,
			processExitObserved: Boolean(existingHistory?.processExitObserved) || history.processExitObserved,
			missingSidecarObserved: Boolean(existingHistory?.missingSidecarObserved) || history.missingSidecarObserved,
			freeFormOnlyObserved: Boolean(existingHistory?.freeFormOnlyObserved) || history.freeFormOnlyObserved,
		},
	};
}
function resolvePlan(cwd: string, taskId: string, sessionManager: any, requestedPlanId?: string): { plan?: WorkflowArchitecturePlan; planId?: string } {
	if (requestedPlanId) {
		try {
			return { plan: readArchitecturePlan(cwd, requestedPlanId, sessionManager) ?? undefined, planId: requestedPlanId };
		} catch {
			return {};
		}
	}
	try {
		const sprintRoot = resolveSprintPathForStore(cwd, sessionManager);
		if (!sprintRoot) return {};
		const storageRoot = getPlanStoragePath(cwd, "task-finalization-lookup", sessionManager).root;
		const relative = path.relative(sprintRoot, storageRoot);
		if (relative.startsWith("..") || path.isAbsolute(relative)) return {};
		if (!fs.existsSync(storageRoot)) return {};
		let best: { plan: WorkflowArchitecturePlan; planId: string } | undefined;
		for (const file of fs.readdirSync(storageRoot).filter((entry) => entry.endsWith(".json"))) {
			const candidateId = path.basename(file, ".json");
			const candidate = readArchitecturePlan(cwd, candidateId, sessionManager);
			if (!candidate || candidate.taskId !== taskId) continue;
			if (!best || candidate.updatedAt > best.plan.updatedAt) best = { plan: candidate, planId: candidate.planId };
		}
		return best ? best : {};
	} catch {
		return {};
	}
}

export function evaluateSprintTaskFinalizationFromDisk(input: EvaluateSprintFinalizationInput): FinalizationGateResult {
	const requestedStatus = trimText(input.requestedStatus);
	const targetTaskId = trimText(input.taskId);
	if (!isFinalizationStatus(requestedStatus)) {
		return evaluateFinalizationGate({
			mode: normalizeMode(input.mode),
			requestedStatus,
			target: { kind: "sprint-task", taskId: targetTaskId, planId: trimText(input.planId) || undefined },
		});
	}
	const resolved = resolvePlan(input.cwd, targetTaskId, input.sessionManager, input.planId);
	const planId = resolved.planId ?? input.planId;
	const manifests = readMatchingManifests(input.cwd, planId);
	const { history, source, latestEvidence } = mergeManifestHistory(manifests);
	const reviewerMemo = readLatestReviewerMemo(input.cwd, planId, resolved.plan);
	const normalized = {
		mode: normalizeMode(input.mode),
		requestedStatus,
		target: { kind: "sprint-task" as const, taskId: targetTaskId, planId },
		plan: resolved.plan,
		coderEvidence: mergeEvidenceWithHistory(latestEvidence, history),
		coderCompletionSource: source,
		coderEvidenceSummary: trimText(input.finalEvidence),
		finalNote: trimText(input.finalNote),
		finalEvidence: trimText(input.finalEvidence),
		reviewerMemo,
	};
	return evaluateFinalizationGate(normalized);
}

export function evaluateDebugFinalization(input: EvaluateDebugFinalizationInput): FinalizationGateResult {
	return evaluateFinalizationGate({
		mode: normalizeMode(input.mode),
		target: { kind: "debug-item", itemId: trimText(input.itemId) },
		requestedStatus: trimText(input.requestedStatus),
		finalNote: trimText(input.finalNote),
		finalEvidence: trimText(input.finalEvidence),
		debugChain: {
			repeatedInAreaCount: Number.isFinite(Number(input.debugChain?.repeatedInAreaCount))
				? Math.max(0, Math.floor(Number(input.debugChain?.repeatedInAreaCount)))
				: undefined,
			priorFailureCount: Number.isFinite(Number(input.debugChain?.priorFailureCount))
				? Math.max(0, Math.floor(Number(input.debugChain?.priorFailureCount)))
				: undefined,
		},
	});
}
