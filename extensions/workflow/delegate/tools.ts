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

import * as path from "node:path";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { DelegateRunResult, UsageStats } from "../types";
import { resolveRoomContextFromDelegateParams, type ResolvedRoomContext } from "../rooms";
import { loadWorkflowConfig } from "../runtime/config";
import { MAX_RENDERED_PROGRESS, MAX_TASK_PREVIEW } from "./constants";
import {
	formatDelegateProgressLine,
	formatUsage,
	getFinalAssistantText,
	isFailed,
	normalizeFinalStatus,
	truncateText,
} from "./messages";
import { runDelegateAgent } from "./runner";
import { resolveReviewerSwarmConfig, runReviewerSwarm } from "./swarm";

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
			const output = details.finalOutput || (result?.content?.[0]?.type === "text" ? result.content[0].text : "");
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
					const singleTask = goals?.length ? `${task}\n\nReview goals:\n${goals.map((goal: string) => `- ${goal}`).join("\n")}` : task;
					const result = await runDelegateAgent(ctx, "reviewer", singleTask, requestedCwd, signal, onUpdate, roomContext);
					const finalOutput = getFinalAssistantText(result.messages) || result.errorMessage || result.stderr || "(no output)";
					const status = normalizeFinalStatus(result);
					const usageText = formatUsage(result.usage);
					return {
						content: [{ type: "text", text: `[reviewer] ${status}${usageText ? ` (${usageText})` : ""}\n\n${finalOutput}` }],
						details: result,
						isError: status !== "completed",
					};
				}

				const swarm = await runReviewerSwarm(ctx, task, requestedCwd, goals, signal, onUpdate, roomContext);
				const lines = swarm.results.map((item, index) => {
					const detail = item.result?.finalOutput || item.result?.errorMessage || item.result?.stderr || "(no output)";
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
				const finalOutput = lines.join("\n\n");
				const status = swarm.aborted ? "aborted" : swarm.failed ? "failed" : "completed";
				return {
					content: [{ type: "text", text: `[reviewer] ${status}\n\n${finalOutput}` }],
					details: {
						agent: "reviewer",
						task,
						cwd: requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd,
						status,
						swarm: swarm.results,
						progress: swarm.results.map((item, index) => ({ at: Date.now(), type: "status", text: `[${index + 1}] ${item.target} ${item.verdict} (${item.status})` })),
						usage,
						exitCode: swarm.failed ? 1 : 0,
						finalOutput,
					},
					isError: swarm.failed,
				};
			}

			const result = await runDelegateAgent(ctx, agent, task, requestedCwd, signal, onUpdate, roomContext);
			const finalOutput = getFinalAssistantText(result.messages) || result.errorMessage || result.stderr || "(no output)";
			const status = normalizeFinalStatus(result);
			const failed = status !== "completed";
			const usageText = formatUsage(result.usage);

			return {
				content: [
					{
						type: "text",
						text: `[${agent}] ${status}${usageText ? ` (${usageText})` : ""}\n\n${finalOutput}`,
					},
				],
				details: result,
				isError: failed,
			};
		},
	});
}

export function registerDelegateTools(pi: ExtensionAPI): void {
	makeDelegateTool(pi, "coder");
	makeDelegateTool(pi, "reviewer");
}
