import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type AgentName = "brain" | "coder" | "reviewer";

interface AgentPreset {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	instructions?: string;
	includeKarpathyGuidelines?: boolean;
}

interface WorkflowConfig {
	autoApplyBrain?: boolean;
	agents?: Record<string, AgentPreset>;
}

interface LoadedWorkflowConfig {
	config: WorkflowConfig;
	globalPath: string;
	projectPath: string | null;
	projectSettingsPath: string | null;
	projectSettings: Record<string, unknown> | undefined;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface DelegateProgressItem {
	at: number;
	type: "status" | "tool_start" | "tool_update" | "tool_end" | "assistant" | "error";
	text: string;
}

interface DelegateRunResult {
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
	aborted?: boolean;
	status?: string;
	activeTools?: Array<{ id: string; name: string }>;
	progress?: DelegateProgressItem[];
	finalOutput?: string;
}

const DEFAULT_CONFIG: WorkflowConfig = {
	autoApplyBrain: true,
	agents: {
		brain: {
			provider: "openai-codex",
			model: "gpt-5.5",
			thinkingLevel: "xhigh",
			instructions: `You are Brain in a three-agent Pi workflow: brain -> coder -> reviewer.

Role:
- Own task understanding, architecture, planning, decomposition, and final user-facing synthesis.
- Delegate hands-on implementation to coder with delegate_to_coder.
- Delegate independent verification to reviewer with delegate_to_reviewer.

Default development cycle:
1. Clarify the goal and inspect enough context yourself.
2. Send coder a self-contained implementation task with relevant files, constraints, and expected checks.
3. Send reviewer a self-contained review task after coder finishes.
4. If reviewer requests changes, send focused fixes back to coder, then review again.
5. Finish with a concise summary of changes, tests/checks, and remaining risks.

Use delegation for non-trivial code changes. For tiny read-only or administrative tasks, you may handle them directly.`,
		},
		coder: {
			provider: "openai-codex",
			model: "gpt-5.3-codex",
			thinkingLevel: "medium",
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			includeKarpathyGuidelines: true,
			instructions: `You are Coder, the hands-on implementation agent in a Pi brain -> coder -> reviewer workflow.

Responsibilities:
- Make focused, correct code changes in the current working directory.
- Follow project instructions and existing conventions.
- Read before editing; prefer surgical edits for existing files.
- Keep scope tight: do exactly what Brain asked, no unrelated cleanup.
- Run relevant tests, type checks, linters, or targeted commands when practical.

Return a concise handoff including: files changed, what changed, checks run and results, blockers/risks.`,
		},
		reviewer: {
			provider: "openai-codex",
			model: "gpt-5.5",
			thinkingLevel: "high",
			tools: ["read", "bash", "grep", "find", "ls"],
			instructions: `You are Reviewer, the independent review agent in a Pi brain -> coder -> reviewer workflow.

Responsibilities:
- Review the implementation for correctness, regressions, edge cases, security, performance, and maintainability.
- Treat the workspace as read-only: do not edit or write files.
- Inspect diffs, relevant files, and test output. Run read-only commands/tests when useful.
- Be specific and actionable.

Return one of:
- APPROVED: with brief rationale and any non-blocking notes.
- CHANGES_REQUESTED: with prioritized issues, file paths/lines when possible, and concrete fixes.`,
		},
	},
};

const KARPATHY_GUIDELINES_PROMPT = `# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
\`\`\`
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
\`\`\`

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
`;

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PROGRESS_ITEMS = 80;
const MAX_PROGRESS_TEXT = 240;
const MAX_RENDERED_PROGRESS = 14;
const MAX_TASK_PREVIEW = 140;
const MAX_FINAL_OUTPUT_PREVIEW = 500;
const MAX_TOOL_UPDATE_PREVIEW = 180;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
	if (override === undefined) return base;
	if (Array.isArray(base) || Array.isArray(override)) return override as T;
	if (!isPlainObject(base) || !isPlainObject(override)) return override as T;

	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		result[key] = key in result ? deepMerge(result[key], value) : value;
	}
	return result as T;
}

function readJsonFile<T = Record<string, unknown>>(filePath: string): T | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch (error) {
		console.error(`[brain-workflow] Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function findNearestFile(cwd: string, relativePath: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, relativePath);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function loadWorkflowConfig(cwd: string): LoadedWorkflowConfig {
	const globalPath = path.join(getAgentDir(), "workflow.json");
	const projectPath = findNearestFile(cwd, path.join(".pi", "workflow.json"));
	const projectSettingsPath = findNearestFile(cwd, path.join(".pi", "settings.json"));

	const globalConfig = readJsonFile<WorkflowConfig>(globalPath) ?? {};
	const projectConfig = projectPath ? (readJsonFile<WorkflowConfig>(projectPath) ?? {}) : {};
	const projectSettings = projectSettingsPath ? readJsonFile<Record<string, unknown>>(projectSettingsPath) : undefined;

	return {
		config: deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig),
		globalPath,
		projectPath,
		projectSettingsPath,
		projectSettings,
	};
}

function hasCliFlag(flagNames: string[]): boolean {
	const argv = process.argv.slice(2);
	return argv.some((arg) => flagNames.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

function projectSettingHas(projectSettings: Record<string, unknown> | undefined, keys: string[]): boolean {
	return Boolean(projectSettings && keys.some((key) => Object.prototype.hasOwnProperty.call(projectSettings, key)));
}

function resolveModelArg(preset: AgentPreset): string | undefined {
	if (!preset.model) return undefined;
	if (preset.model.includes("/")) return preset.model;
	return preset.provider ? `${preset.provider}/${preset.model}` : preset.model;
}

function resolveModelLabel(preset: AgentPreset): string {
	const model = resolveModelArg(preset) ?? "default";
	return preset.thinkingLevel ? `${model}:${preset.thinkingLevel}` : model;
}

function getAgentPreset(config: WorkflowConfig, agent: AgentName): AgentPreset {
	return config.agents?.[agent] ?? DEFAULT_CONFIG.agents![agent];
}

function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n");
		if (text.trim()) return text.trim();
	}
	return "";
}

function extractMessageText(message: Message | undefined): string {
	const msg = message as any;
	if (!msg || !Array.isArray(msg.content)) return "";
	return msg.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function truncateText(text: string, max = MAX_PROGRESS_TEXT): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}

function isFailed(result: DelegateRunResult): boolean {
	return result.aborted || result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function normalizeFinalStatus(result: Pick<DelegateRunResult, "aborted" | "stopReason" | "exitCode">): "failed" | "aborted" | "completed" {
	if (result.aborted || result.stopReason === "aborted") return "aborted";
	if (result.exitCode !== 0 || result.stopReason === "error") return "failed";
	return "completed";
}

function extractToolUpdatePreview(partialResult: unknown): string {
	if (typeof partialResult === "string") return truncateText(partialResult, MAX_TOOL_UPDATE_PREVIEW);
	if (!isPlainObject(partialResult)) return "";

	const candidates: unknown[] = [];
	const content = partialResult.content;
	if (typeof content === "string") candidates.push(content);
	if (Array.isArray(content)) {
		for (const item of content) {
			if (typeof item === "string") candidates.push(item);
			else if (isPlainObject(item) && typeof item.text === "string") candidates.push(item.text);
		}
	}
	if (typeof partialResult.output === "string") candidates.push(partialResult.output);
	if (typeof partialResult.stdout === "string") candidates.push(partialResult.stdout);
	if (typeof partialResult.stderr === "string") candidates.push(partialResult.stderr);
	if (typeof partialResult.summary === "string") candidates.push(partialResult.summary);
	if (isPlainObject(partialResult.details) && typeof partialResult.details.summary === "string") {
		candidates.push(partialResult.details.summary);
	}

	for (const candidate of candidates) {
		const text = truncateText(String(candidate), MAX_TOOL_UPDATE_PREVIEW);
		if (text) return text;
	}
	return "";
}

function appendCapped(current: string, next: string, maxBytes: number): string {
	const combined = current + next;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
	let trimmed = combined.slice(-maxBytes);
	while (Buffer.byteLength(trimmed, "utf8") > maxBytes) trimmed = trimmed.slice(1);
	return trimmed;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

async function writeSystemPromptFile(agent: string, text: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-"));
	const safeAgent = agent.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `${safeAgent}-system.md`);
	await fs.promises.writeFile(filePath, text, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

async function removeTempPrompt(dir: string | null, filePath: string | null): Promise<void> {
	if (filePath) {
		try {
			await fs.promises.unlink(filePath);
		} catch {
			// ignore
		}
	}
	if (dir) {
		try {
			await fs.promises.rmdir(dir);
		} catch {
			// ignore
		}
	}
}

function buildAgentSystemPrompt(agent: AgentName, preset: AgentPreset): string {
	const configured = preset.instructions?.trim() ?? "";
	const includeKarpathyGuidelines = agent === "coder" ? preset.includeKarpathyGuidelines !== false : false;
	const footer = `You are running as ${agent} in the Pi brain -> coder -> reviewer workflow.
Work only in the current working directory. Follow all project context files loaded by Pi.
Return concise handoff output for Brain.`;

	const sections = [configured];
	if (includeKarpathyGuidelines) {
		sections.push(KARPATHY_GUIDELINES_PROMPT.trim());
	}
	sections.push(footer);

	return sections.filter((part) => part && part.trim()).join("\n\n");
}

async function runDelegateAgent(
	ctx: ExtensionContext,
	agent: AgentName,
	task: string,
	requestedCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
): Promise<DelegateRunResult> {
	const loaded = loadWorkflowConfig(ctx.cwd);
	const preset = getAgentPreset(loaded.config, agent);
	const cwd = requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd;
	const modelArg = resolveModelArg(preset);
	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	const messages: Message[] = [];

	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let stderr = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let aborted = false;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (modelArg) args.push("--model", modelArg);
	if (preset.thinkingLevel) args.push("--thinking", preset.thinkingLevel);
	if (preset.tools) {
		if (preset.tools.length > 0) args.push("--tools", preset.tools.join(","));
		else args.push("--no-tools");
	}

	const systemPrompt = buildAgentSystemPrompt(agent, preset);
	if (systemPrompt.trim()) {
		const tmp = await writeSystemPromptFile(agent, systemPrompt);
		tmpDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);
	}

	args.push(`Task from Brain to ${agent}:\n\n${task}`);

	const progress: DelegateProgressItem[] = [];
	const activeTools = new Map<string, { name: string }>();
	let status = "starting";
	let lastAssistantPreview = "";
	let lastAssistantEmitAt = 0;

	const pushProgress = (item: DelegateProgressItem) => {
		progress.push(item);
		if (progress.length > MAX_PROGRESS_ITEMS) progress.splice(0, progress.length - MAX_PROGRESS_ITEMS);
	};

	const emitUpdate = () => {
		const output = getFinalAssistantText(messages);
		const finalOutputPreview = truncateText(output, MAX_FINAL_OUTPUT_PREVIEW);
		onUpdate?.({
			content: [{ type: "text", text: finalOutputPreview || `${agent} ${status}...` }],
			details: {
				agent,
				taskPreview: truncateText(task, MAX_TASK_PREVIEW),
				cwd,
				model: resolveModelLabel(preset),
				usage,
				status,
				activeTools: Array.from(activeTools.entries()).map(([id, t]) => ({ id, name: t.name })),
				progress,
				finalOutputPreview,
			},
		});
	};

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_WORKFLOW_CHILD: "1",
					PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? "1",
				},
			});

			let stdoutBuffer = "";
			let killTimer: NodeJS.Timeout | undefined;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				const now = Date.now();
				switch (event.type) {
					case "turn_start": {
						status = `turn ${Number(event.turnIndex ?? usage.turns + 1)} running`;
						pushProgress({ at: now, type: "status", text: status });
						emitUpdate();
						break;
					}
					case "turn_end": {
						status = "turn complete";
						pushProgress({ at: now, type: "status", text: status });
						emitUpdate();
						break;
					}
					case "tool_execution_start": {
						const name = String(event.toolName ?? "tool");
						const id = String(event.toolCallId ?? `${name}-${now}`);
						activeTools.set(id, { name });
						status = `${name} running`;
						pushProgress({ at: now, type: "tool_start", text: `→ ${name}` });
						emitUpdate();
						break;
					}
					case "tool_execution_update": {
						const name = String(event.toolName ?? "tool");
						const details = extractToolUpdatePreview(event.partialResult);
						pushProgress({ at: now, type: "tool_update", text: `… ${name}${details ? ` ${details}` : ""}` });
						emitUpdate();
						break;
					}
					case "tool_execution_end": {
						const name = String(event.toolName ?? "tool");
						const id = String(event.toolCallId ?? "");
						if (id) activeTools.delete(id);
						const ok = !event.isError;
						pushProgress({ at: now, type: ok ? "tool_end" : "error", text: `${ok ? "✓" : "✗"} ${name}` });
						status = ok ? "tool complete" : "tool failed";
						emitUpdate();
						break;
					}
					case "message_update": {
						const text = truncateText(extractMessageText(event.message as Message));
						if (!text) break;
						const shouldEmit =
							text !== lastAssistantPreview &&
							(text.length - lastAssistantPreview.length >= 40 || now - lastAssistantEmitAt > 400);
						if (shouldEmit) {
							lastAssistantPreview = text;
							lastAssistantEmitAt = now;
							pushProgress({ at: now, type: "assistant", text: truncateText(`💬 ${text}`) });
							emitUpdate();
						}
						break;
					}
					case "message_end": {
						if (!event.message) break;
						const msg = event.message as Message;
						messages.push(msg);

						const asAny = msg as any;
						if (asAny.role === "assistant") {
							usage.turns++;
							if (asAny.usage) {
								usage.input += asAny.usage.input || 0;
								usage.output += asAny.usage.output || 0;
								usage.cacheRead += asAny.usage.cacheRead || 0;
								usage.cacheWrite += asAny.usage.cacheWrite || 0;
								usage.cost += asAny.usage.cost?.total || 0;
								usage.contextTokens = asAny.usage.totalTokens || usage.contextTokens;
							}
							if (asAny.stopReason) stopReason = asAny.stopReason;
							if (asAny.errorMessage) errorMessage = asAny.errorMessage;
							const assistantText = extractMessageText(msg);
							if (assistantText) pushProgress({ at: now, type: "assistant", text: `💬 ${truncateText(assistantText)}` });
						}
						emitUpdate();
						break;
					}
					case "tool_result_end": {
						if (event.message) messages.push(event.message as Message);
						emitUpdate();
						break;
					}
					case "agent_end": {
						status = aborted ? "aborted" : "completed";
						pushProgress({ at: now, type: "status", text: status });
						emitUpdate();
						break;
					}
					default: {
						if (typeof event.type === "string" && (event.type.startsWith("auto_retry") || event.type.startsWith("compaction"))) {
							pushProgress({ at: now, type: "status", text: truncateText(event.type) });
							emitUpdate();
						}
					}
				}
			};

			proc.stdout.on("data", (chunk) => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (chunk) => {
				stderr = appendCapped(stderr, chunk.toString(), MAX_STDERR_BYTES);
			});

			proc.on("close", (code) => {
				if (killTimer) clearTimeout(killTimer);
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				stderr = appendCapped(stderr, String(error), MAX_STDERR_BYTES);
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					aborted = true;
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		const finalStatus = normalizeFinalStatus({ aborted, stopReason, exitCode });
		return {
			agent,
			task,
			cwd,
			model: resolveModelLabel(preset),
			thinkingLevel: preset.thinkingLevel,
			exitCode,
			messages,
			stderr,
			usage,
			stopReason,
			errorMessage,
			aborted,
			status: finalStatus,
			activeTools: Array.from(activeTools.entries()).map(([id, t]) => ({ id, name: t.name })),
			progress,
			finalOutput: getFinalAssistantText(messages),
		};
	} finally {
		await removeTempPrompt(tmpDir, tmpPromptPath);
	}
}

function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`in:${usage.input}`);
	if (usage.output) parts.push(`out:${usage.output}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(", ");
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
		],
		parameters: Type.Object({
			task: Type.String({ description: `Self-contained task for ${agent}` }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the delegated Pi process; defaults to current cwd" })),
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
			const icon = isPartial ? "…" : failed ? "✗" : "✓";
			const recent = progress.slice(-(expanded ? MAX_RENDERED_PROGRESS : 5));
			const lines = recent.map((p) => p.text);
			const usageText = details.usage ? formatUsage(details.usage) : "";
			const taskText = details.task ?? (details as { taskPreview?: string }).taskPreview;
			const output = details.finalOutput || (result?.content?.[0]?.type === "text" ? result.content[0].text : "");

			if (!expanded) {
				let text = `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", agent)} ${theme.fg("muted", `[${status}]`)} ${theme.fg("muted", icon)}`;
				if (lines.length) text += `\n${lines.map((line) => theme.fg("toolOutput", truncateText(line))).join("\n")}`;
				if ((details.progress?.length ?? 0) > lines.length) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(`${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", agent)} ${theme.fg("muted", `[${status}]`)} ${icon}`, 0, 0));
			if (taskText) container.addChild(new Text(theme.fg("dim", `task: ${taskText}`), 0, 0));
			if (details.model || details.cwd) {
				container.addChild(new Text(theme.fg("dim", `model: ${details.model ?? "default"}  cwd: ${details.cwd ?? ""}`), 0, 0));
			}
			container.addChild(new Spacer(1));
			for (const line of lines) container.addChild(new Text(theme.fg("toolOutput", line), 0, 0));
			if (usageText) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageText), 0, 0));
			}
			if (output) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
			}
			return container;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = String((params as any).task ?? "").trim();
			if (!task) {
				return { content: [{ type: "text", text: "Missing task." }], isError: true };
			}

			const result = await runDelegateAgent(ctx, agent, task, (params as any).cwd, signal, onUpdate);
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

async function applyBrainPreset(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (process.env.PI_WORKFLOW_CHILD === "1") return;
	const loaded = loadWorkflowConfig(ctx.cwd);
	if (loaded.config.autoApplyBrain === false) return;

	const brain = getAgentPreset(loaded.config, "brain");
	const projectOverridesWorkflow = Boolean(loaded.projectPath);
	const explicitModel = hasCliFlag(["--model", "--provider"]);
	const explicitThinking = hasCliFlag(["--thinking"]);
	const projectSettingsHasModel = projectSettingHas(loaded.projectSettings, ["defaultProvider", "defaultModel"]);
	const projectSettingsHasThinking = projectSettingHas(loaded.projectSettings, ["defaultThinkingLevel"]);

	if (!explicitModel && (projectOverridesWorkflow || !projectSettingsHasModel) && brain.provider && brain.model) {
		const model = ctx.modelRegistry.find(brain.provider, brain.model);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) ctx.ui.notify(`Brain workflow: no auth for ${brain.provider}/${brain.model}`, "warning");
		} else {
			ctx.ui.notify(`Brain workflow: model not found: ${brain.provider}/${brain.model}`, "warning");
		}
	}

	if (!explicitThinking && (projectOverridesWorkflow || !projectSettingsHasThinking) && brain.thinkingLevel) {
		pi.setThinkingLevel(brain.thinkingLevel);
	}

	ctx.ui.setStatus("workflow", ctx.ui.theme.fg("accent", "brain→coder→reviewer"));
}

function formatPreset(agent: AgentName, preset: AgentPreset): string {
	return `${agent}: ${resolveModelLabel(preset)}${preset.tools ? ` tools=${preset.tools.join(",")}` : ""}`;
}

export default function brainWorkflow(pi: ExtensionAPI) {
	pi.registerFlag("workflow-agent", {
		description: "Workflow agent for this process: brain or none",
		type: "string",
	});

	makeDelegateTool(pi, "coder");
	makeDelegateTool(pi, "reviewer");

	pi.registerCommand("workflow", {
		description: "Show effective brain/coder/reviewer workflow presets",
		handler: async (_args, ctx) => {
			const loaded = loadWorkflowConfig(ctx.cwd);
			const lines = [
				"Pi workflow: brain -> coder -> reviewer",
				`global: ${loaded.globalPath}`,
				`project override: ${loaded.projectPath ?? "(none)"}`,
				"",
				formatPreset("brain", getAgentPreset(loaded.config, "brain")),
				formatPreset("coder", getAgentPreset(loaded.config, "coder")),
				formatPreset("reviewer", getAgentPreset(loaded.config, "reviewer")),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("workflow-agent") === "none") return;
		await applyBrainPreset(pi, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (process.env.PI_WORKFLOW_CHILD === "1") return;
		if (pi.getFlag("workflow-agent") === "none") return;

		const loaded = loadWorkflowConfig(ctx.cwd);
		const brain = getAgentPreset(loaded.config, "brain");
		if (!brain.instructions?.trim()) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${brain.instructions.trim()}`,
		};
	});
}
