// Workflow delegate runtime — `delegate_to_coder` / `delegate_to_reviewer` tools.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// `registerDelegateTools(pi)` registers the two public delegation tools
// used by Brain. Each tool is a thin wrapper around `runDelegateAgent` (for
// `coder`) or `runReviewerSwarm` (for `reviewer` when the swarm is enabled),
// so the tool body is just parameter validation, swarm dispatch, and result
// formatting. The render/renderResult bodies are kept inline because they
// share the same delegate progress shape; the actual progress formatting
// helpers are imported from `./messages`.

import * as fs from "node:fs";
import * as path from "node:path";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { DelegateRunResult, UsageStats } from "../types";
import { getWorkflowRunsRoot, resolveRoomContextFromDelegateParams, type ResolvedRoomContext } from "../rooms";
import { loadWorkflowConfig } from "../runtime/config";
import {
	DELEGATE_MANIFEST_DIR,
	DELEGATE_PANE_ACTIVITY_STALE_MS,
	DELEGATE_STATUS_LIMIT_DEFAULT,
	MAX_RENDERED_PROGRESS,
	MAX_TASK_PREVIEW,
} from "./constants";
import {
	markArchitecturePhaseUpdate,
	resolveArchitectureContext,
} from "./architecture-gate";
import {
	formatDelegateProgressLine,
	formatUsage,
	getFinalAssistantText,
	isFailed,
	normalizeFinalStatus,
	truncateText,
} from "./messages";
import { runDelegateAgent } from "./runner";
import { parseReviewerVerdict, resolveReviewerSwarmConfig, runReviewerSwarm } from "./swarm";

interface DelegateManifest {
	manifestVersion: number;
	runId: string;
	startedAt?: string;
	updatedAt?: string;
	agent: string;
	task: string;
	taskPreview?: string;
	groupKey?: string;
	tabTitle?: string;
	surface?: string;
	state?: "running" | "completed" | "failed" | "aborted";
	exitCode?: number;
	latestEvent?: string;
	activity?: {
		version?: number;
		phase?: "starting" | "active" | "waiting" | "done";
		lastEvent?: string;
		updatedAt?: number;
	};
	roomContext?: {
		roomId?: string;
		agentId?: string;
		role?: string;
	};
}

function getToolResultText(result: any): string {
	return (
		result?.finalOutput
		|| getFinalAssistantText((result as { messages?: unknown[] }).messages as any)
		|| (typeof result?.errorMessage === "string" ? result.errorMessage : "")
		|| (typeof result?.stderr === "string" ? result.stderr : "")
		|| "(no output)"
	);
}

function safeReadManifest(filePath: string): DelegateManifest | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as DelegateManifest;
		if (!parsed || typeof parsed !== "object" || typeof parsed.runId !== "string") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function formatManifestLine(manifest: DelegateManifest): string {
	const updated = manifest.updatedAt || manifest.startedAt || new Date().toISOString();
	const updatedText = (() => {
		try {
			return new Date(updated).toISOString();
		} catch {
			return String(updated);
		}
	})();
	const preview = manifest.taskPreview || manifest.task || "";
	const room = manifest.roomContext?.roomId ? ` room=${manifest.roomContext.roomId}` : "";
	const activityText = manifest.activity
		? `${manifest.activity.phase ?? "waiting"}${manifest.activity.lastEvent ? `:${manifest.activity.lastEvent}` : ""}`
		: "n/a";
	const activityAgeMs = manifest.activity?.updatedAt ? Date.now() - manifest.activity.updatedAt : undefined;
	const ageText = typeof activityAgeMs === "number" ? ` age=${Math.max(0, Math.floor(activityAgeMs / 1000))}s${activityAgeMs > DELEGATE_PANE_ACTIVITY_STALE_MS ? " STALE" : ""}` : "";
	const activity = `${activityText}${ageText}`;
	return `${manifest.runId} ${manifest.state ?? "running"} ${manifest.agent || "agent"} ${manifest.exitCode !== undefined ? `exit=${manifest.exitCode}` : ""} ${manifest.tabTitle ?? ""} @ ${updatedText}${room}\n  task: ${preview}\n  surface: ${manifest.surface || "-"} activity: ${activity}`;
}

function registerDelegateStatusTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "workflow_delegate_status",
		label: "Delegate Status",
		description: "List parent-visible pane delegate run manifests for the most recent delegated executions.",
		promptSnippet: "Check active/completed pane delegates and their activity.",
		promptGuidelines: [
			"Use this when a pane delegate appears stuck or before taking action to inspect recent delegation progress.",
		],
		parameters: Type.Object({
			runId: Type.Optional(Type.String({ description: "Optional exact runId to filter" })),
			roomId: Type.Optional(Type.String({ description: "Optional room id filter" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum entries returned (defaults to ${DELEGATE_STATUS_LIMIT_DEFAULT}).` })),
		}),
		renderResult(result: any) {
			const output = String(result?.content?.[0]?.text ?? "");
			return new Text(output);
		},
		execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
			const runIdFilter = typeof params?.runId === "string" ? params.runId.trim() : "";
			const roomIdFilter = typeof params?.roomId === "string" ? params.roomId.trim() : "";
			const configuredLimit = Number.isFinite(Number(params?.limit)) ? Number(params.limit) : DELEGATE_STATUS_LIMIT_DEFAULT;
			const limit = Math.max(1, Math.min(200, configuredLimit));
			const root = getWorkflowRunsRoot(typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd());
			const manifestDir = path.join(root, DELEGATE_MANIFEST_DIR);
			let manifestFiles: string[] = [];
			try {
				manifestFiles = (await fs.promises.readdir(manifestDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
			} catch {
				manifestFiles = [];
			}

			const manifests: DelegateManifest[] = [];
			for (const name of manifestFiles) {
				const manifest = safeReadManifest(path.join(manifestDir, name));
				if (!manifest) continue;
				if (runIdFilter && manifest.runId !== runIdFilter) continue;
				if (roomIdFilter && manifest.roomContext?.roomId !== roomIdFilter) continue;
				manifests.push(manifest);
			}

			manifests.sort((a, b) => {
				const ad = new Date(a.updatedAt || a.startedAt || 0).getTime() || 0;
				const bd = new Date(b.updatedAt || b.startedAt || 0).getTime() || 0;
				return bd - ad;
			});

			if (!runIdFilter) {
				manifests.splice(limit);
			}
			if (manifests.length > limit) {
				manifests.length = limit;
			}

			if (manifests.length === 0) {
				return {
					content: [{ type: "text", text: `No delegate manifests found under ${manifestDir}` }],
					details: { count: 0, items: [] },
				};
			}

			const lines = manifests.map(formatManifestLine);
			const statusSummary = runIdFilter
				? `Showing delegate manifest for ${runIdFilter}`
				: `Showing ${manifests.length} most recent delegate manifest(s)`;
			const output = `${statusSummary}:\n${lines.join("\n\n")}`;
			return {
				content: [{ type: "text", text: output }],
				details: {
					count: manifests.length,
					items: manifests,
				},
			};
		},
	});
}

function makeDelegateTool(pi: ExtensionAPI, agent: "coder" | "reviewer") {
	const toolName = agent === "coder" ? "delegate_to_coder" : "delegate_to_reviewer";
	const label = agent === "coder" ? "Delegate to Coder" : "Delegate to Reviewer";
	const role = agent === "coder" ? "hands-on implementation" : "independent review";

	pi.registerTool({
		name: toolName,
		label,
		description: `Delegate a self-contained ${role} task to the ${agent} agent using its configured workflow preset. Project .pi/workflow.json overrides global presets.`,
		promptSnippet: `Delegate ${role} work to the ${agent} subagent`,
		promptGuidelines: [
			`Use ${toolName} when Brain needs ${role} in the brain -> coder -> reviewer workflow.`,
			`Tasks passed to ${toolName} must be self-contained: include goal, relevant files/context, constraints, and expected output.`,
			...(agent === "reviewer" ? ["Pass explicit goals whenever possible so each reviewer target validates one acceptance criterion."] : []),
			`If this delegation fails or returns CHANGES_REQUESTED, do NOT take over code edits/fixes yourself. Re-delegate a focused fix to coder (or a room worker) and then re-review. Brain may do read-only diagnosis/planning/admin only, and direct edits are limited to tiny non-code/admin cases.`,
		],
		parameters: Type.Object({
			task: Type.String({ description: `Self-contained task for ${agent}` }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the delegated Pi process; defaults to current cwd" })),
			architecture: Type.Object({
				planId: Type.String({ description: "Architecture plan id from workflow_record_architecture_plan." }),
				phase: Type.Union([Type.Literal("phaseA"), Type.Literal("phaseB")]),
			}, { description: "Required runtime architecture gate context." }),
			room: Type.Optional(Type.Object({
				roomId: Type.Optional(Type.String({ description: "Workflow room id; falls back to PI_WORKFLOW_ROOM_ID env or the active room from .pi/workflow-runs/current.json" })),
				agentId: Type.Optional(Type.String({ description: "Agent id within the room; defaults to the agent name (coder or reviewer) or PI_WORKFLOW_AGENT_ID env" })),
				role: Type.Optional(Type.String({ description: "Agent role label (e.g. 'backend', 'frontend', 'planner'); defaults to PI_WORKFLOW_AGENT_ROLE env or the agent name" })),
			}, { description: "Optional workflow room context. When set, the delegated sub-agent receives PI_WORKFLOW_ROOM_ID/AGENT_ID/AGENT_ROLE env vars and a communication block in its system prompt." })),
			...(agent === "reviewer"
				? { goals: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional review goals/acceptance criteria. When reviewer swarm is enabled, one reviewer runs per goal." })) }
				: {}),
		}),
		renderCall(args: any, theme) {
			const task = truncateText(String(args?.task ?? ""), MAX_TASK_PREVIEW) || "(no task)";
			return new Text(
				`${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", agent)}\n${theme.fg("dim", task)}`,
				0,
				0,
			);
		},
		renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial?: boolean }, theme, context: { isError?: boolean } = {}) {
			const details = (result?.details ?? {}) as Partial<DelegateRunResult>;
			const progress = details.progress ?? [];
			const derivedFailed = typeof details.exitCode === "number" ? isFailed(details as DelegateRunResult) : false;
			const failed = Boolean(context.isError ?? result?.isError ?? derivedFailed);
			const status = details.status ?? (isPartial ? "running" : failed ? "failed" : "completed");
			const statusColor = isPartial ? "warning" : failed ? "error" : "success";
			const icon = isPartial ? "…" : failed ? "✗" : "✓";
			const recent = progress.slice(-(expanded ? MAX_RENDERED_PROGRESS : 5));
			const usageText = details.usage ? formatUsage(details.usage) : "";
			const taskText = details.task ?? (details as { taskPreview?: string }).taskPreview;
			const output = getToolResultText(result);
			const thinkingChars = (details as any).thinkingChars ?? 0;

			if (!expanded) {
				let text = `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", agent)} ${theme.fg(statusColor, `[${status}]`)} ${theme.fg(statusColor, icon)}`;
				if (taskText) text += `\n${theme.fg("dim", truncateText(taskText))}`;
				if (recent.length) {
					text += `\n${recent.map((p) => formatDelegateProgressLine(p, theme)).join("\n")}`;
				}
				if (thinkingChars > 0) {
					text += `\n${theme.fg("thinkingText", `  thinking… (${thinkingChars} chars)`)}`;
				}
				if ((details.progress?.length ?? 0) > recent.length) {
					text += `\n${theme.fg("muted", "  (Ctrl+O to expand)")}`;
				}
				return new Text(text, 0, 0);
			}

			const container = new Container();

			// Header: tool name + agent + status
			container.addChild(new Text(
				`${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", agent)} ${theme.fg(statusColor, `[${status}]`)} ${theme.fg(statusColor, icon)}`,
				0, 0,
			));

			// Task preview
			if (taskText) {
				container.addChild(new Text(theme.fg("dim", `task: ${truncateText(taskText, MAX_TASK_PREVIEW)}`), 0, 0));
			}

			// Model / cwd / usage line
			const metaParts: string[] = [];
			if (details.model) metaParts.push(`model: ${details.model}`);
			if (details.cwd) metaParts.push(`cwd: ${details.cwd}`);
			if (usageText) metaParts.push(usageText);
			if (metaParts.length) {
				container.addChild(new Text(theme.fg("dim", metaParts.join("  ")), 0, 0));
			}

			// Active tools
			if (details.activeTools && details.activeTools.length > 0) {
				const toolNames = details.activeTools.map((t) => t.name).join(", ");
				container.addChild(new Text(theme.fg("warning", `active: ${toolNames}`), 0, 0));
			}

			// Thinking indicator
			if (thinkingChars > 0) {
				container.addChild(new Text(theme.fg("thinkingText", `thinking… (${thinkingChars} chars hidden)`), 0, 0));
			}

			// Progress section
			if (recent.length) {
				container.addChild(new Spacer(1));
				const statusItems = recent.filter((p) => p.type === "status");
				const toolItems = recent.filter((p) => p.type === "tool_start" || p.type === "tool_update" || p.type === "tool_end" || p.type === "error");
				const assistantItems = recent.filter((p) => p.type === "assistant");
				const thinkingItems = recent.filter((p) => p.type === "thinking");

				if (statusItems.length) {
					container.addChild(new Text(theme.fg("dim", "status:"), 0, 0));
					for (const item of statusItems.slice(-4)) {
						container.addChild(new Text(formatDelegateProgressLine(item, theme), 0, 0));
					}
				}
				if (toolItems.length) {
					if (statusItems.length) container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", "tools:"), 0, 0));
					for (const item of toolItems.slice(-6)) {
						container.addChild(new Text(formatDelegateProgressLine(item, theme), 0, 0));
					}
				}
				if (thinkingItems.length) {
					if (toolItems.length || statusItems.length) container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", "thinking:"), 0, 0));
					for (const item of thinkingItems.slice(-3)) {
						container.addChild(new Text(formatDelegateProgressLine(item, theme), 0, 0));
					}
				}
				if (assistantItems.length) {
					if (toolItems.length || statusItems.length || thinkingItems.length) container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", "output:"), 0, 0));
					for (const item of assistantItems.slice(-4)) {
						container.addChild(new Text(formatDelegateProgressLine(item, theme), 0, 0));
					}
				}
			}

			// Final output
			if (output) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
			}

			return container;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = String((params as any).task ?? "").trim();
			const requestedCwd = (params as any).cwd;
			if (!task) {
				return {
					content: [{ type: "text", text: "Missing task." }],
					details: { agent, status: "failed", task, cwd: requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd },
					isError: true,
				};
			}

			const architecture = resolveArchitectureContext(ctx.cwd, task, (params as any).architecture, agent, (ctx as any).sessionManager);
			if (!architecture.ok) {
				return {
					isError: true,
					content: [{ type: "text", text: architecture.text }],
					details: architecture.details,
				};
			}
			const delegatedTask = architecture.delegatedTask;
			const architectureRequirement = architecture.requirement;

			let roomContext: ResolvedRoomContext | undefined;
			if ((params as any).room && typeof (params as any).room === "object") {
				try {
					roomContext = resolveRoomContextFromDelegateParams(agent, (params as any).room, ctx.cwd);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `Invalid room context: ${message}` }],
						details: { agent, status: "failed", task, room: (params as any).room },
						isError: true,
					};
				}
			}
			if (agent === "reviewer") {
				const goals = Array.isArray((params as any).goals)
					? (params as any).goals.map((goal: unknown) => String(goal).trim()).filter((goal: string) => goal.length > 0)
					: undefined;
				const swarmConfig = resolveReviewerSwarmConfig(loadWorkflowConfig(ctx.cwd).config);
				if (!swarmConfig.enabled) {
					const singleTask = goals?.length
						? `${delegatedTask}\n\nReview goals:\n${goals.map((goal: string) => `- ${goal}`).join("\n")}`
						: delegatedTask;
					const result = await runDelegateAgent(ctx, "reviewer", singleTask, requestedCwd, signal, onUpdate, roomContext);
					const status = normalizeFinalStatus(result);
					const finalOutput = getToolResultText(result);
					const verdict = parseReviewerVerdict(finalOutput);
					const phaseStatus = verdict === "CHANGES_REQUESTED" || status !== "completed" ? "changes_requested" : "review_approved";
					const reviewerUpdate = markArchitecturePhaseUpdate(
						ctx.cwd,
						architectureRequirement,
						phaseStatus,
						`Delegation ${agent} returned ${status}`,
						(ctx as any).sessionManager,
					);
					const usageText = formatUsage(result.usage);
					const details = {
						...result,
						task: delegatedTask,
						planId: architectureRequirement.planId,
						phase: architectureRequirement.phase,
						architectureGatePlanUpdateError: reviewerUpdate,
					};
					const isReviewFailing = verdict === "CHANGES_REQUESTED" || status !== "completed";
					return {
						content: [{ type: "text", text: `[reviewer] ${status}${usageText ? ` (${usageText})` : ""}\n\n${finalOutput}` }],
						details,
						isError: isReviewFailing,
					};
				}

				const swarm = await runReviewerSwarm(ctx, delegatedTask, requestedCwd, goals, signal, onUpdate, roomContext);
				const lines = swarm.results.map((item, index) => {
					const detail = item.result ? getToolResultText(item.result) : "(no output)";
					return `[${index + 1}] ${item.target}\n${item.verdict} (${item.status})\n${detail}`;
				});
				const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
				for (const item of swarm.results) {
					if (!item.result) continue;
					usage.input += item.result.usage.input;
					usage.output += item.result.usage.output;
					usage.cacheRead += item.result.usage.cacheRead;
					usage.cacheWrite += item.result.usage.cacheWrite;
					usage.cost += item.result.usage.cost;
					usage.contextTokens = Math.max(usage.contextTokens, item.result.usage.contextTokens);
					usage.turns += item.result.usage.turns;
				}
				const hasChangesRequested = swarm.results.some((item) => item.verdict === "CHANGES_REQUESTED");
				const status = swarm.aborted ? "aborted" : swarm.failed ? "failed" : "completed";
				const reviewerUpdate = markArchitecturePhaseUpdate(
					ctx.cwd,
					architectureRequirement,
					status === "completed" && !hasChangesRequested ? "review_approved" : "changes_requested",
					`Delegation ${agent} returned ${status}`,
					(ctx as any).sessionManager,
				);
				const finalOutput = lines.join("\n\n");
				return {
					content: [{ type: "text", text: `[reviewer] ${status}\n\n${finalOutput}` }],
					details: {
						agent: "reviewer",
						task: delegatedTask,
						cwd: requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd,
						status,
						swarm: swarm.results,
						progress: swarm.results.map((item, index) => ({ at: Date.now(), type: "status", text: `[${index + 1}] ${item.target} ${item.verdict} (${item.status})` })),
						usage,
						exitCode: swarm.failed ? 1 : 0,
						finalOutput,
						planId: architectureRequirement.planId,
						phase: architectureRequirement.phase,
						architectureGatePlanUpdateError: reviewerUpdate,
					},
					isError: status !== "completed",
				};
			}

			const result = await runDelegateAgent(ctx, agent, delegatedTask, requestedCwd, signal, onUpdate, roomContext);
			const status = normalizeFinalStatus(result);
			const finalOutput = getToolResultText(result);
			const failed = status !== "completed";
			const usageText = formatUsage(result.usage);
			const coderUpdate = failed
				? undefined
				: markArchitecturePhaseUpdate(
						ctx.cwd,
						architectureRequirement,
						"coder_completed",
						`Delegation ${agent} returned ${status}`,
						(ctx as any).sessionManager,
					);
			return {
				content: [{ type: "text", text: `[${agent}] ${status}${usageText ? ` (${usageText})` : ""}\n\n${finalOutput}` }],
				details: {
					...result,
					task: delegatedTask,
					planId: architectureRequirement.planId,
					phase: architectureRequirement.phase,
					architectureGatePlanUpdateError: coderUpdate,
				},
				isError: failed,
			};
		},
	});
}

export function registerDelegateTools(pi: ExtensionAPI): void {
	makeDelegateTool(pi, "coder");
	makeDelegateTool(pi, "reviewer");
	registerDelegateStatusTool(pi);
}
