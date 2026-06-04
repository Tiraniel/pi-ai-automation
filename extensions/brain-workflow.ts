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

interface ReviewerSwarmConfig {
	enabled?: boolean;
	maxConcurrency?: number;
	targets?: string[];
}

interface WorkflowConfig {
	autoApplyBrain?: boolean;
	agents?: Record<string, AgentPreset>;
	reviewerSwarm?: ReviewerSwarmConfig;
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

interface ReviewerTargetResult {
	target: string;
	verdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";
	status: "running" | "completed" | "failed" | "aborted";
	result?: DelegateRunResult;
}

const DEFAULT_CONFIG: WorkflowConfig = {
	autoApplyBrain: true,
	reviewerSwarm: {
		enabled: true,
		maxConcurrency: 2,
		targets: [
			"Requirements and acceptance criteria coverage",
			"Correctness and regression risks",
			"Tests and validation quality",
			"Security, performance, and maintainability",
		],
	},
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
3. Send reviewer a self-contained review task after coder finishes. Prefer delegate_to_reviewer goals that map to acceptance criteria (one goal per target review).
4. If reviewer requests changes, send focused fixes back to coder, then review again.
5. Finish with a concise summary of changes, tests/checks, and remaining risks.

Sprint task session flow (default for concrete sprint-tracked tasks):
- For concrete tasks tracked under .sprints/, the project supports one dedicated Pi session per task via the sprint-system extension.
- Only the /sprint task start <TASK-ID> --auto-run slash command performs the actual session switch (it is the only path that can call ctx.newSession). Invoke it directly when you can issue slash commands.
- If you cannot issue a slash command, call the sprint_start_task_session tool to present the prepared /sprint task start <TASK-ID> --auto-run command to the user (it places the command in the editor and notifies the user), then stop and wait for the user to run it. The tool itself does NOT switch sessions; it only prepares/presents the command.
- Do the slash command (or tool call to present it) before implementation when the current Pi session is not already pinned to the target task.
- If the current session is already pinned to the target task, proceed normally without re-binding.
- Use \`sprint_read_context\` to confirm the pinned task and \`sprint_get_session_binding\` if you need to inspect the binding.
- Once bound, treat that session as scoped to a single task. Do not switch tasks mid-session; rely on sprint_update_task and sprint_log_progress to record progress for that task. \`sprint_update_task\` will refuse to update a taskId that does not match the bound task.

Use delegation for non-trivial code changes. For tiny read-only or administrative tasks, you may handle them directly.

Workflow rooms (async coordination between delegated sub-agents):
- For multi-agent jobs (e.g. backend + frontend, or planner + implementer) call room_create({ roomId, title }) first to allocate a durable room under .pi/workflow-runs/<roomId>/.
- Pass \`room: { roomId, agentId?, role? }\` on delegate_to_coder/delegate_to_reviewer so the sub-agent receives PI_WORKFLOW_ROOM_ID/AGENT_ID/AGENT_ROLE env vars and a room-communication block in its system prompt.
- The room is a durable async queue (events.jsonl with monotonic seq) — there is no real-time interruption. Sub-agents will read queued messages at job_start/job_done checkpoints.
- Use room_status to inspect the room and use room_send to publish assumptions/contracts/decisions for the sub-agents to read. The default room guard for the sub-agent is set on room_job_done (refuses if there are unread relevant messages).
- If a sub-agent returns and reports issues, call room_send with the topic and then room_status to confirm before re-delegating.
		`.trim(),
		},
		coder: {
			provider: "openai-codex",
			model: "gpt-5.3-codex",
			thinkingLevel: "medium",
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "room_create", "room_job_start", "room_send", "room_read", "room_job_done", "room_status"],
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
			tools: ["read", "bash", "grep", "find", "ls", "room_create", "room_job_start", "room_send", "room_read", "room_job_done", "room_status"],
			instructions: `You are Reviewer, the independent review agent in a Pi brain -> coder -> reviewer workflow.

Responsibilities:
- Review the implementation for correctness, regressions, edge cases, security, performance, and maintainability.
- Treat the workspace as read-only: do not edit or write files.
- Inspect diffs, relevant files, and test output. Run read-only commands/tests when useful.
- Be specific and actionable.

Return one of:
- APPROVED: with brief rationale and any non-blocking notes.
- CHANGES_REQUESTED: with prioritized issues, file paths/lines when possible, and concrete fixes.

If Brain assigns a specific review goal/target, focus only on that goal and put APPROVED or CHANGES_REQUESTED as the first token in your response.`,
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

function parseReviewerVerdict(text: string): "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN" {
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

function resolveReviewerSwarmConfig(config: WorkflowConfig): Required<ReviewerSwarmConfig> {
	const merged = deepMerge(DEFAULT_CONFIG.reviewerSwarm ?? {}, config.reviewerSwarm ?? {});
	const targets = Array.isArray(merged.targets) ? merged.targets.filter((target): target is string => typeof target === "string" && target.trim().length > 0) : [];
	return {
		enabled: merged.enabled !== false,
		maxConcurrency: Math.max(1, Number(merged.maxConcurrency ?? 2) || 2),
		targets: targets.length ? targets : [...(DEFAULT_CONFIG.reviewerSwarm?.targets ?? [])],
	};
}

function buildReviewerGoalTask(task: string, goal: string): string {
	return `${task}\n\nAssigned review goal:\n- ${goal}\n\nFocus strictly on this goal. Start your response with APPROVED or CHANGES_REQUESTED.`;
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

function resolveChildExtensionSource(source: string, parentCwd: string): string {
	const expanded = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
	if (path.isAbsolute(expanded)) return expanded;
	const abs = path.resolve(parentCwd, expanded);
	if (fs.existsSync(abs)) return abs;
	return source;
}

function getInheritedExtensionArgs(parentCwd: string): string[] {
	const argv = process.argv.slice(2);
	const inherited: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--no-extensions" || arg === "-ne") {
			inherited.push("--no-extensions");
			continue;
		}
		if (arg === "-e" || arg === "--extension") {
			const source = argv[i + 1];
			if (source) {
				inherited.push(arg, resolveChildExtensionSource(source, parentCwd));
				i++;
			}
			continue;
		}
		if (arg.startsWith("--extension=")) {
			const source = arg.slice("--extension=".length);
			inherited.push("--extension", resolveChildExtensionSource(source, parentCwd));
		}
	}
	return inherited;
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

function buildAgentSystemPrompt(agent: AgentName, preset: AgentPreset, roomContext?: ResolvedRoomContext): string {
	const configured = preset.instructions?.trim() ?? "";
	const includeKarpathyGuidelines = agent === "coder" ? preset.includeKarpathyGuidelines !== false : false;
	const footer = `You are running as ${agent} in the Pi brain -> coder -> reviewer workflow.
Work only in the current working directory. Follow all project context files loaded by Pi.
Return concise handoff output for Brain.`;

	const sections = [configured];
	if (roomContext) {
		sections.push(buildRoomCommunicationBlock(agent, roomContext));
	}
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
	roomContext?: ResolvedRoomContext,
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
	args.push(...getInheritedExtensionArgs(ctx.cwd));
	if (modelArg) args.push("--model", modelArg);
	if (preset.thinkingLevel) args.push("--thinking", preset.thinkingLevel);
	if (preset.tools) {
		let effectiveTools = preset.tools;
		if (roomContext) {
			const seen = new Set(preset.tools);
			effectiveTools = preset.tools.slice();
			for (const name of ROOM_TOOL_NAMES) {
				if (!seen.has(name)) {
					effectiveTools.push(name);
					seen.add(name);
				}
			}
		}
		if (effectiveTools.length > 0) args.push("--tools", effectiveTools.join(","));
		else args.push("--no-tools");
	}

	const systemPrompt = buildAgentSystemPrompt(agent, preset, roomContext);
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
			const childEnv: NodeJS.ProcessEnv = {
				...process.env,
				PI_WORKFLOW_CHILD: "1",
				PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? "1",
			};
			// Delegates without explicit room context must not inherit a parent/nested
			// room. Scrub room env first, then add it back only for room-enabled runs.
			delete childEnv[ROOM_ENV_ROOM_ROOT];
			delete childEnv[ROOM_ENV_ROOM_ID];
			delete childEnv[ROOM_ENV_AGENT_ID];
			delete childEnv[ROOM_ENV_AGENT_ROLE];
			if (roomContext) {
				// Point room-enabled children at the parent's workflow-runs root so a
				// delegated child with a sub-cwd still shares the same room store.
				childEnv[ROOM_ENV_ROOM_ROOT] = getWorkflowRunsRoot(ctx.cwd);
				childEnv[ROOM_ENV_ROOM_ID] = roomContext.roomId;
				childEnv[ROOM_ENV_AGENT_ID] = roomContext.agentId;
				childEnv[ROOM_ENV_AGENT_ROLE] = roomContext.role;
			}
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
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

async function runReviewerSwarm(
	ctx: ExtensionContext,
	task: string,
	requestedCwd: string | undefined,
	goals: string[] | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	roomContext?: ResolvedRoomContext,
): Promise<{ results: ReviewerTargetResult[]; failed: boolean; aborted: boolean }> {
	const loaded = loadWorkflowConfig(ctx.cwd);
	const swarm = resolveReviewerSwarmConfig(loaded.config);
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
			const result = await runDelegateAgent(ctx, "reviewer", buildReviewerGoalTask(task, target), requestedCwd, signal, undefined, perReviewerContext);
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

function getDelegateFailureReason(toolName: string, result: any): string | null {
	if (!result || typeof result !== "object") return null;
	const details = (result as any).details;

	if (toolName === "delegate_to_reviewer") {
		if (details?.status === "failed" || details?.status === "aborted") return String(details.status);
		if (Array.isArray(details?.swarm)) {
			const failedItem = details.swarm.find(
				(item: any) => item?.status !== "completed" || item?.verdict === "CHANGES_REQUESTED" || item?.verdict === "UNKNOWN",
			);
			if (failedItem) return `swarm:${failedItem.status ?? "failed"}:${failedItem.verdict ?? "UNKNOWN"}`;
		}
	}

	if (details && typeof details === "object") {
		if (typeof details.status === "string" && details.status !== "completed") return `status:${details.status}`;
		if (typeof details.exitCode === "number" && details.exitCode !== 0) return `exitCode:${details.exitCode}`;
		if (details.aborted === true) return "aborted";
	}

	return null;
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
			...(agent === "reviewer" ? ["Pass explicit goals whenever possible so each reviewer target validates one acceptance criterion."] : []),
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

// --- Workflow Rooms (v1: durable async coordination) -------------------------

const ROOM_DIR_NAME = "workflow-runs";
const ROOM_LOCK_TIMEOUT_MS = 5000;
const ROOM_LOCK_RETRY_BASE_MS = 25;
const ROOM_DEFAULT_AGENT_ID = "agent";
const ROOM_ENV_ROOM_ID = "PI_WORKFLOW_ROOM_ID";
const ROOM_ENV_AGENT_ID = "PI_WORKFLOW_AGENT_ID";
const ROOM_ENV_AGENT_ROLE = "PI_WORKFLOW_AGENT_ROLE";
const ROOM_ENV_ROOM_ROOT = "PI_WORKFLOW_ROOM_ROOT";
const ROOM_BRAIN_AGENT_ID = "brain";
const ROOM_TOOL_NAMES = ["room_create", "room_job_start", "room_send", "room_read", "room_job_done", "room_status"] as const;
const ROOM_ID_MAX = 64;
const AGENT_ID_MAX = 64;
const ROLE_MAX = 32;
const ROOM_READ_DEFAULT_LIMIT = 200;
const ROOM_UNREAD_PREVIEW_MAX = 5;
const ROOM_BODY_PREVIEW = 240;

type RoomEventType = "room_created" | "job_start" | "message" | "job_done";

interface RoomEvent {
	seq: number;
	roomId: string;
	type: RoomEventType;
	from?: string;
	to?: string;
	topic?: string;
	body?: string;
	jobId?: string;
	summary?: string;
	owns?: string[];
	filesChanged?: string[];
	testsRun?: string[];
	createdAt: string;
	[key: string]: unknown;
}

interface RoomAgentState {
	agentId: string;
	role: string;
	status: "active" | "done" | "aborted";
	lastReadSeq: number;
	updatedAt: string;
}

interface ResolvedRoomContext {
	roomId: string;
	agentId: string;
	role: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function sanitizeRoomId(input: string): string {
	const base = String(input ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, ROOM_ID_MAX);
	return base || "room";
}

function sanitizeAgentId(input: string): string {
	const base = String(input ?? "")
		.trim()
		.replace(/[^\w.-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, AGENT_ID_MAX);
	return base || ROOM_DEFAULT_AGENT_ID;
}

function appendAgentIdSuffix(base: string, suffix: string): string {
	const cleanSuffix = sanitizeAgentId(suffix);
	const maxBase = Math.max(1, AGENT_ID_MAX - cleanSuffix.length - 1);
	const cleanBase = sanitizeAgentId(base).slice(0, maxBase).replace(/[._-]+$/g, "") || ROOM_DEFAULT_AGENT_ID;
	return sanitizeAgentId(`${cleanBase}-${cleanSuffix}`);
}

function sanitizeRole(input: string): string {
	const base = String(input ?? "")
		.trim()
		.replace(/[^\w.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, ROLE_MAX);
	return base || ROOM_DEFAULT_AGENT_ID;
}

function generateRoomId(): string {
	const stamp = new Date()
		.toISOString()
		.replace(/[-:.TZ]/g, "")
		.slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 8);
	return `room-${stamp}-${rand}`;
}

function getWorkflowRunsRoot(cwd: string): string {
	const fromEnv = process.env[ROOM_ENV_ROOM_ROOT];
	if (fromEnv && fromEnv.trim()) return fromEnv;
	return path.join(cwd, ".pi", ROOM_DIR_NAME);
}

function getRoomDir(cwd: string, roomId: string): string {
	return path.join(getWorkflowRunsRoot(cwd), roomId);
}

function getRoomCurrentPointerPath(cwd: string): string {
	return path.join(getWorkflowRunsRoot(cwd), "current.json");
}

function getRoomEventsPath(cwd: string, roomId: string): string {
	return path.join(getRoomDir(cwd, roomId), "events.jsonl");
}

function getRoomAgentsPath(cwd: string, roomId: string): string {
	return path.join(getRoomDir(cwd, roomId), "agents.json");
}

function getRoomLockPath(cwd: string, roomId: string): string {
	return path.join(getRoomDir(cwd, roomId), ".lock");
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

async function withRoomLock<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = ROOM_LOCK_TIMEOUT_MS): Promise<T> {
	ensureDir(path.dirname(lockPath));
	const deadline = Date.now() + timeoutMs;
	let fd: number | undefined;
	while (true) {
		try {
			fd = fs.openSync(lockPath, "wx");
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			if (Date.now() > deadline) throw new Error(`Room lock timeout: ${lockPath}`);
			await new Promise((r) => setTimeout(r, ROOM_LOCK_RETRY_BASE_MS + Math.random() * ROOM_LOCK_RETRY_BASE_MS));
		}
	}
	try {
		return await fn();
	} finally {
		try {
			if (fd !== undefined) fs.closeSync(fd);
		} catch {
			// ignore
		}
		try {
			fs.unlinkSync(lockPath);
		} catch {
			// ignore
		}
	}
}

function readEventsFile(eventsPath: string): RoomEvent[] {
	if (!fs.existsSync(eventsPath)) return [];
	const text = fs.readFileSync(eventsPath, "utf-8");
	if (!text.trim()) return [];
	const events: RoomEvent[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as RoomEvent);
		} catch {
			// skip malformed line
		}
	}
	return events;
}

function nextSeq(events: RoomEvent[]): number {
	let max = 0;
	for (const e of events) if (typeof e.seq === "number" && e.seq > max) max = e.seq;
	return max + 1;
}

function readAgentsFile(agentsPath: string): Record<string, RoomAgentState> {
	if (!fs.existsSync(agentsPath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
		return isPlainObject(parsed) ? (parsed as Record<string, RoomAgentState>) : {};
	} catch {
		return {};
	}
}

function writeAgentsFile(agentsPath: string, agents: Record<string, RoomAgentState>): void {
	fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2) + "\n", "utf-8");
}

function readCurrentRoomPointer(cwd: string): string | undefined {
	const data = readJsonFile<{ roomId?: string }>(getRoomCurrentPointerPath(cwd));
	const candidate = typeof data?.roomId === "string" ? data.roomId : "";
	return candidate ? sanitizeRoomId(candidate) : undefined;
}

function writeCurrentRoomPointer(cwd: string, roomId: string): void {
	ensureDir(getWorkflowRunsRoot(cwd));
	fs.writeFileSync(
		getRoomCurrentPointerPath(cwd),
		JSON.stringify({ roomId, updatedAt: nowIso() }, null, 2) + "\n",
		"utf-8",
	);
}

function appendEventLine(eventsPath: string, event: RoomEvent): void {
	fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf-8");
}

function isMessageRelevantTo(event: RoomEvent, agentId: string): boolean {
	if (event.type !== "message") return false;
	if (event.from && event.from === agentId) return false;
	const to = event.to;
	if (!to) return true;
	return to === agentId;
}

function resolveRoomIdFromParamsOrEnv(params: { roomId?: unknown }, cwd: string): string {
	const fromParams = typeof params.roomId === "string" ? sanitizeRoomId(params.roomId) : "";
	if (fromParams) return fromParams;
	const fromEnv = process.env[ROOM_ENV_ROOM_ID] ? sanitizeRoomId(process.env[ROOM_ENV_ROOM_ID] ?? "") : "";
	if (fromEnv) return fromEnv;
	if (process.env.PI_WORKFLOW_CHILD === "1") {
		throw new Error(`roomId required in child sessions: pass it explicitly or delegate with room context so ${ROOM_ENV_ROOM_ID} is set`);
	}
	const current = readCurrentRoomPointer(cwd);
	if (current) return current;
	throw new Error(`roomId required: pass it explicitly, set ${ROOM_ENV_ROOM_ID} env var, or call room_create first`);
}

function resolveAgentIdFromParamsOrEnv(params: { agentId?: unknown }): string {
	const fromParams = typeof params.agentId === "string" ? sanitizeAgentId(params.agentId) : "";
	if (fromParams && fromParams !== ROOM_DEFAULT_AGENT_ID) return fromParams;
	const fromEnv = process.env[ROOM_ENV_AGENT_ID] ? sanitizeAgentId(process.env[ROOM_ENV_AGENT_ID] ?? "") : "";
	if (fromEnv && fromEnv !== ROOM_DEFAULT_AGENT_ID) return fromEnv;
	if (process.env.PI_WORKFLOW_CHILD !== "1") {
		return ROOM_BRAIN_AGENT_ID;
	}
	throw new Error(`agentId required: pass it explicitly or set ${ROOM_ENV_AGENT_ID} env var`);
}

function resolveRoleFromParamsOrEnv(params: { role?: unknown }, fallbackAgentId: string): string {
	const fromParams = typeof params.role === "string" ? sanitizeRole(params.role) : "";
	if (fromParams && fromParams !== ROOM_DEFAULT_AGENT_ID) return fromParams;
	const fromEnv = process.env[ROOM_ENV_AGENT_ROLE] ? sanitizeRole(process.env[ROOM_ENV_AGENT_ROLE] ?? "") : "";
	if (fromEnv && fromEnv !== ROOM_DEFAULT_AGENT_ID) return fromEnv;
	return fallbackAgentId;
}

function resolveRoomContextFromDelegateParams(agent: AgentName, params: { roomId?: unknown; agentId?: unknown; role?: unknown }, cwd: string): ResolvedRoomContext {
	const fromParams = typeof params.roomId === "string" && params.roomId.trim() ? sanitizeRoomId(params.roomId) : "";
	let roomId = fromParams;
	if (!roomId && process.env[ROOM_ENV_ROOM_ID]) roomId = sanitizeRoomId(process.env[ROOM_ENV_ROOM_ID] ?? "");
	if (!roomId && process.env.PI_WORKFLOW_CHILD === "1") {
		throw new Error(`delegate.${agent} called with room context in a child session but no explicit roomId/env is set; pass room.roomId or set ${ROOM_ENV_ROOM_ID}`);
	}
	if (!roomId) roomId = readCurrentRoomPointer(cwd) ?? "";
	if (!roomId) {
		throw new Error(`delegate.${agent} called with room context but no roomId is set; pass room.roomId, set ${ROOM_ENV_ROOM_ID}, or call room_create first`);
	}
	const defaultAgentId = agent;
	const agentId = typeof params.agentId === "string" && params.agentId.trim()
		? sanitizeAgentId(params.agentId)
		: (process.env[ROOM_ENV_AGENT_ID] ? sanitizeAgentId(process.env[ROOM_ENV_AGENT_ID] ?? "") : defaultAgentId);
	const role = typeof params.role === "string" && params.role.trim()
		? sanitizeRole(params.role)
		: (process.env[ROOM_ENV_AGENT_ROLE] ? sanitizeRole(process.env[ROOM_ENV_AGENT_ROLE] ?? "") : defaultAgentId);
	return { roomId, agentId, role };
}

function buildRoomCommunicationBlock(agent: AgentName, room: ResolvedRoomContext): string {
	return `## Workflow Room Communication (v1, durable async)

You are running as ${room.agentId} (role: ${room.role}, sub-agent of ${agent}) inside workflow room "${room.roomId}".

Room context is provided via env vars (${ROOM_ENV_ROOM_ID}, ${ROOM_ENV_AGENT_ID}, ${ROOM_ENV_AGENT_ROLE}) and may be overridden via tool params. The room is a durable async coordination queue persisted under .pi/${ROOM_DIR_NAME}/${room.roomId}/. Treat it as an audit log; do not rely on real-time interruption.

Required checkpoint flow at job boundaries:
1. Call room_job_start({ jobId, summary, owns }) BEFORE doing meaningful work to register yourself, your jobId, and your scope/ownership so other agents can see you.
2. Use room_send({ to?, topic, message }) for assumptions, contracts, blockers, and decisions. Bodies must be self-contained and specific. Omit 'to' to broadcast; set it to another agentId to direct a message.
3. Call room_read({ markRead: true }) AFTER heavy work and BEFORE finalizing to pick up queued messages from other agents.
4. Call room_job_done({ jobId, summary, filesChanged, testsRun }) when finished. If it returns an error listing unread relevant messages, address them (use room_send to reply/resolve or update your job), then retry room_job_done.
5. Do not silently change shared contracts (public APIs, file ownership boundaries, schema, dependencies). If you must, announce it via room_send first and wait for acknowledgment if other agents depend on it.

Storage layout: events.jsonl (append-only, monotonic seq) and agents.json (per-agent read cursor and status). Use the same jobId across all room_* calls within a single delegated job so other agents can correlate.

If roomId, agentId, or role is missing from both params and env, call room_status or stop and report back to Brain.`;
}

function previewEvent(event: RoomEvent): string {
	const base = `#${event.seq} ${event.type}${event.from ? ` from=${event.from}` : ""}${event.to ? ` to=${event.to}` : ""}${event.topic ? ` [${event.topic}]` : ""}`;
	const body = typeof event.body === "string" ? truncateText(event.body, ROOM_BODY_PREVIEW) : "";
	return body ? `${base}\n${body}` : base;
}

function textResult(text: string, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

function makeRoomTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "room_create",
		label: "Create Workflow Room",
		description: "Create or re-activate a durable workflow room under .pi/workflow-runs/<roomId>/. Sets it as the active room for subsequent room_* calls in this session. Pass a stable roomId when you want to share a room across delegated agents; otherwise one is generated.",
		promptSnippet: "Create a durable workflow room and mark it as active.",
		promptGuidelines: [
			"Call room_create before delegating agents that need to coordinate via room tools.",
			"Pass a stable roomId (lowercase letters, digits, hyphens) so it can be referenced later; otherwise one is generated.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String({ description: "Stable room id. Lowercase letters, digits, and hyphens. Auto-generated if omitted." })),
			title: Type.Optional(Type.String({ description: "Human-readable title for this room" })),
		}),
		renderCall(args: any, theme) {
			const id = args?.roomId ? sanitizeRoomId(String(args.roomId)) : "(auto)";
			const title = args?.title ? String(args.title) : "";
			const head = `${theme.fg("toolTitle", theme.bold("room_create"))} ${theme.fg("accent", id)}`;
			return new Text(title ? `${head} ${theme.fg("muted", `— ${truncateText(title, 80)}`)}` : head, 0, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requested = params?.roomId ? sanitizeRoomId(String(params.roomId)) : "";
			const roomId = requested || generateRoomId();
			const roomDir = getRoomDir(ctx.cwd, roomId);
			const lockPath = getRoomLockPath(ctx.cwd, roomId);
			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);

			ensureDir(roomDir);
			await withRoomLock(lockPath, async () => {
				if (!fs.existsSync(eventsPath)) {
					const event: RoomEvent = {
						seq: 1,
						roomId,
						type: "room_created",
						from: "brain",
						topic: String(params?.title ?? "").trim() || undefined,
						body: String(params?.title ?? "").trim() || undefined,
						createdAt: nowIso(),
					};
					appendEventLine(eventsPath, event);
				}
				if (!fs.existsSync(agentsPath)) {
					writeAgentsFile(agentsPath, {});
				}
			});
			writeCurrentRoomPointer(ctx.cwd, roomId);

			return {
				content: [{ type: "text", text: `Room ${roomId} ready at ${roomDir}` }],
				details: { roomId, roomDir },
			};
		},
	});

	pi.registerTool({
		name: "room_job_start",
		label: "Workflow Room Job Start",
		description: "Register a new job for an agent in the active room. Records jobId, summary, and optional file ownership so other agents can see scope. Must be called before room_send/room_read/room_job_done for the same job.",
		promptSnippet: "Register a job in the active workflow room.",
		promptGuidelines: [
			"Call room_job_start before doing meaningful work when room context is active.",
			"Use a stable jobId so other agents and your later room_job_done can reference this job.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			jobId: Type.String({ description: "Job identifier (e.g. 'backend-auth', 'reviewer-tests')" }),
			summary: Type.Optional(Type.String({ description: "One-line summary of the job" })),
			owns: Type.Optional(Type.Array(Type.String(), { description: "File paths or globs this job owns; advisory to avoid conflicts" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roomId = resolveRoomIdFromParamsOrEnv(params ?? {}, ctx.cwd);
			const agentId = resolveAgentIdFromParamsOrEnv(params ?? {});
			const role = resolveRoleFromParamsOrEnv(params ?? {}, agentId);
			const jobId = String(params?.jobId ?? "").trim();
			if (!jobId) return textResult("Missing jobId", true);
			const summary = typeof params?.summary === "string" ? params.summary.trim() : undefined;
			const owns = Array.isArray(params?.owns)
				? (params!.owns as unknown[]).map((v) => String(v)).filter((v) => v.length > 0)
				: undefined;

			const roomDir = getRoomDir(ctx.cwd, roomId);
			if (!fs.existsSync(roomDir)) return textResult(`Room not found: ${roomId}. Call room_create first.`, true);
			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);
			const lockPath = getRoomLockPath(ctx.cwd, roomId);

			let appendedSeq = 0;
			await withRoomLock(lockPath, async () => {
				const events = readEventsFile(eventsPath);
				const event: RoomEvent = {
					seq: nextSeq(events),
					roomId,
					type: "job_start",
					from: agentId,
					jobId,
					summary,
					owns,
					createdAt: nowIso(),
				};
				appendEventLine(eventsPath, event);
				appendedSeq = event.seq;

				const agents = readAgentsFile(agentsPath);
				const existing = agents[agentId];
				agents[agentId] = {
					agentId,
					role,
					status: "active",
					lastReadSeq: existing?.lastReadSeq ?? 0,
					updatedAt: nowIso(),
				};
				writeAgentsFile(agentsPath, agents);
			});

			return {
				content: [{ type: "text", text: `job_start seq=${appendedSeq} room=${roomId} agent=${agentId} role=${role} jobId=${jobId}` }],
				details: { roomId, agentId, role, jobId, seq: appendedSeq },
			};
		},
	});

	pi.registerTool({
		name: "room_send",
		label: "Workflow Room Send",
		description: "Append a message to the active room. Omit 'to' to broadcast; set 'to' to a specific agentId to direct it. Messages persist under .pi/workflow-runs/<roomId>/events.jsonl.",
		promptSnippet: "Send a message into the active workflow room.",
		promptGuidelines: [
			"Use room_send for assumptions, contracts, blockers, and decisions that other agents need to see.",
			"Omit 'to' for broadcast; set 'to' to a specific agentId to direct a message.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			to: Type.Optional(Type.String({ description: "Target agentId; omit to broadcast" })),
			topic: Type.Optional(Type.String({ description: "Short topic label" })),
			message: Type.String({ description: "Message body" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roomId = resolveRoomIdFromParamsOrEnv(params ?? {}, ctx.cwd);
			const agentId = resolveAgentIdFromParamsOrEnv(params ?? {});
			const role = resolveRoleFromParamsOrEnv(params ?? {}, agentId);
			const message = String(params?.message ?? "").trim();
			if (!message) return textResult("Missing message", true);
			const to = typeof params?.to === "string" && params.to.trim() ? params.to.trim() : undefined;
			const topic = typeof params?.topic === "string" && params.topic.trim() ? params.topic.trim() : undefined;

			const roomDir = getRoomDir(ctx.cwd, roomId);
			if (!fs.existsSync(roomDir)) return textResult(`Room not found: ${roomId}. Call room_create first.`, true);
			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);
			const lockPath = getRoomLockPath(ctx.cwd, roomId);

			let appendedSeq = 0;
			await withRoomLock(lockPath, async () => {
				const events = readEventsFile(eventsPath);
				const event: RoomEvent = {
					seq: nextSeq(events),
					roomId,
					type: "message",
					from: agentId,
					to,
					topic,
					body: message,
					createdAt: nowIso(),
				};
				appendEventLine(eventsPath, event);
				appendedSeq = event.seq;

				const agents = readAgentsFile(agentsPath);
				const existing = agents[agentId];
				agents[agentId] = {
					agentId,
					role,
					status: existing?.status ?? "active",
					lastReadSeq: existing?.lastReadSeq ?? 0,
					updatedAt: nowIso(),
				};
				writeAgentsFile(agentsPath, agents);
			});

			return {
				content: [{ type: "text", text: `message seq=${appendedSeq} room=${roomId} from=${agentId}${to ? ` to=${to}` : " (broadcast)"}${topic ? ` [${topic}]` : ""}` }],
				details: { roomId, agentId, to, topic, seq: appendedSeq },
			};
		},
	});

	pi.registerTool({
		name: "room_read",
		label: "Workflow Room Read",
		description: "Read events from the active room after the given cursor. By default also advances the calling agent's lastReadSeq so subsequent room_job_done guards treat those events as read.",
		promptSnippet: "Read queued room events after a cursor.",
		promptGuidelines: [
			"Call room_read after heavy work and before finalizing to catch messages from other agents.",
			"Use markRead=true (default) so room_job_done doesn't reject on already-seen messages.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			afterSeq: Type.Optional(Type.Number({ description: "Return events with seq > afterSeq; defaults to the agent's lastReadSeq" })),
			markRead: Type.Optional(Type.Boolean({ description: "If true, advance the agent's lastReadSeq to the latest seq returned. Default: true." })),
			limit: Type.Optional(Type.Number({ description: `Maximum events to return. Default: ${ROOM_READ_DEFAULT_LIMIT}` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roomId = resolveRoomIdFromParamsOrEnv(params ?? {}, ctx.cwd);
			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);
			const lockPath = getRoomLockPath(ctx.cwd, roomId);
			if (!fs.existsSync(eventsPath)) return textResult(`Room not found or empty: ${roomId}. Call room_create first.`, true);

			const agentId = resolveAgentIdFromParamsOrEnv(params ?? {});
			const role = resolveRoleFromParamsOrEnv(params ?? {}, agentId);
			const markRead = params?.markRead !== false;
			const limit = Math.max(1, Math.min(2000, Number(params?.limit ?? ROOM_READ_DEFAULT_LIMIT) || ROOM_READ_DEFAULT_LIMIT));

			let cursor = 0;
			let returnedEvents: RoomEvent[] = [];
			let unreadRelevant = 0;
			let latestSeq = 0;
			let latestAvailableSeq = 0;
			let hasMore = false;
			let markReadSkippedAhead = false;
			let agentLastRead = 0;
			let agentStatus: RoomAgentState["status"] | undefined;

			await withRoomLock(lockPath, async () => {
				const events = readEventsFile(eventsPath);
				const agents = readAgentsFile(agentsPath);
				const existing = agents[agentId];
				agentLastRead = existing?.lastReadSeq ?? 0;
				agentStatus = existing?.status;
				const requestedAfter = typeof params?.afterSeq === "number" ? Math.max(0, Math.floor(params.afterSeq)) : agentLastRead;
				cursor = requestedAfter;
				const filtered = events.filter((e) => e.seq > cursor);
				returnedEvents = filtered.slice(0, limit);
				hasMore = filtered.length > returnedEvents.length;
				// latestSeq = max seq among RETURNED events (used to advance lastReadSeq).
				for (const e of returnedEvents) if (e.seq > latestSeq) latestSeq = e.seq;
				// latestAvailableSeq = max seq among ALL events after the cursor (for display / hasMore).
				for (const e of filtered) if (e.seq > latestAvailableSeq) latestAvailableSeq = e.seq;
				// unreadRelevant = count of relevant messages after the agent's actual lastReadSeq,
				// not just after the (potentially manually supplied) cursor. When markRead=true,
				// report the post-read count so agents can trust it before room_job_done.
				const countUnreadRelevant = (afterSeq: number) => events.filter((e) => e.seq > afterSeq && isMessageRelevantTo(e, agentId)).length;
				unreadRelevant = countUnreadRelevant(agentLastRead);

				if (markRead && requestedAfter > agentLastRead) {
					markReadSkippedAhead = true;
					return;
				}

				if (markRead) {
					const newLastRead = Math.max(agentLastRead, latestSeq);
					agents[agentId] = {
						agentId,
						role,
						status: existing?.status ?? "active",
						lastReadSeq: newLastRead,
						updatedAt: nowIso(),
					};
					writeAgentsFile(agentsPath, agents);
					agentLastRead = newLastRead;
					unreadRelevant = countUnreadRelevant(agentLastRead);
				}
			});

			if (markReadSkippedAhead) {
				return {
					content: [{
						type: "text",
						text: `Refused: markRead=true with afterSeq=${cursor} would skip this agent's stored lastReadSeq=${agentLastRead}. Call room_read without afterSeq to advance the cursor safely, or use markRead=false for a lookahead read.`,
					}],
					details: { roomId, agentId, afterSeq: cursor, lastReadSeq: agentLastRead, latestAvailableSeq, hasMore },
					isError: true,
				};
			}

			const lines = returnedEvents.map(previewEvent);
			const summaryLine = `room=${roomId} afterSeq=${cursor} returned=${returnedEvents.length} latestSeq=${latestSeq} latestAvailableSeq=${latestAvailableSeq} hasMore=${hasMore} unreadRelevant=${unreadRelevant}`;
			const text = lines.length
				? `${summaryLine}\n` + lines.join("\n")
				: `${summaryLine} (no events)`;
			return {
				content: [{ type: "text", text }],
				details: {
					roomId,
					agentId,
					afterSeq: cursor,
					markRead,
					limit,
					returnedCount: returnedEvents.length,
					events: returnedEvents,
					latestSeq,
					latestAvailableSeq,
					hasMore,
					lastReadSeq: agentLastRead,
					unreadRelevant,
					agentStatus,
				},
			};
		},
	});

	pi.registerTool({
		name: "room_job_done",
		label: "Workflow Room Job Done",
		description: "Mark a job as done in the active room. By default refuses with isError if there are unread messages relevant to the calling agent; pass allowUnread=true to override and return previews of those messages.",
		promptSnippet: "Mark a job done in the active workflow room.",
		promptGuidelines: [
			"Call room_job_done only after you have called room_read and addressed any queued messages relevant to you.",
			"If room_job_done returns an error listing unread messages, read them, act on them, and retry.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			jobId: Type.String({ description: "Job identifier matching the prior room_job_start" }),
			summary: Type.Optional(Type.String()),
			filesChanged: Type.Optional(Type.Array(Type.String())),
			testsRun: Type.Optional(Type.Array(Type.String())),
			allowUnread: Type.Optional(Type.Boolean({ description: "Override the unread-message guard" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roomId = resolveRoomIdFromParamsOrEnv(params ?? {}, ctx.cwd);
			const agentId = resolveAgentIdFromParamsOrEnv(params ?? {});
			const role = resolveRoleFromParamsOrEnv(params ?? {}, agentId);
			const jobId = String(params?.jobId ?? "").trim();
			if (!jobId) return textResult("Missing jobId", true);
			const allowUnread = params?.allowUnread === true;
			const summary = typeof params?.summary === "string" ? params.summary.trim() : undefined;
			const filesChanged = Array.isArray(params?.filesChanged)
				? (params!.filesChanged as unknown[]).map((v) => String(v)).filter((v) => v.length > 0)
				: undefined;
			const testsRun = Array.isArray(params?.testsRun)
				? (params!.testsRun as unknown[]).map((v) => String(v)).filter((v) => v.length > 0)
				: undefined;

			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);
			const lockPath = getRoomLockPath(ctx.cwd, roomId);
			if (!fs.existsSync(eventsPath)) return textResult(`Room not found: ${roomId}. Call room_create first.`, true);

			let unread: RoomEvent[] = [];
			let appendedSeq = 0;

			await withRoomLock(lockPath, async () => {
				const events = readEventsFile(eventsPath);
				const agents = readAgentsFile(agentsPath);
				const existing = agents[agentId];
				const lastRead = existing?.lastReadSeq ?? 0;
				unread = events.filter((e) => e.seq > lastRead && isMessageRelevantTo(e, agentId));

				if (unread.length > 0 && !allowUnread) {
					return; // do not append
				}

				const event: RoomEvent = {
					seq: nextSeq(events),
					roomId,
					type: "job_done",
					from: agentId,
					jobId,
					summary,
					filesChanged,
					testsRun,
					createdAt: nowIso(),
				};
				appendEventLine(eventsPath, event);
				appendedSeq = event.seq;

				agents[agentId] = {
					agentId,
					role,
					status: "done",
					lastReadSeq: existing?.lastReadSeq ?? 0,
					updatedAt: nowIso(),
				};
				writeAgentsFile(agentsPath, agents);
			});

			if (unread.length > 0 && !allowUnread) {
				const previews = unread.slice(0, ROOM_UNREAD_PREVIEW_MAX).map(previewEvent);
				return {
					content: [{
						type: "text",
						text: `Refused: ${unread.length} unread relevant message(s) for ${agentId} in room ${roomId}. Read them via room_read, act on them, then retry. Pass allowUnread=true to override.\n` + previews.join("\n"),
					}],
					details: { roomId, agentId, jobId, unreadCount: unread.length, unread: unread.slice(0, ROOM_UNREAD_PREVIEW_MAX) },
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: `job_done seq=${appendedSeq} room=${roomId} agent=${agentId} jobId=${jobId}${allowUnread ? " (allowUnread)" : ""}` }],
				details: { roomId, agentId, jobId, seq: appendedSeq, allowUnread, unreadOverridden: unread.length },
			};
		},
	});

	pi.registerTool({
		name: "room_status",
		label: "Workflow Room Status",
		description: "Summarize the active room: latest seq, agents, and (when agentId is known) the number of unread messages relevant to that agent.",
		promptSnippet: "Summarize the active workflow room.",
		promptGuidelines: [
			"Use room_status to inspect what other agents have done and what is queued for you.",
		],
		parameters: Type.Object({
			roomId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roomId = resolveRoomIdFromParamsOrEnv(params ?? {}, ctx.cwd);
			const eventsPath = getRoomEventsPath(ctx.cwd, roomId);
			const agentsPath = getRoomAgentsPath(ctx.cwd, roomId);
			if (!fs.existsSync(eventsPath)) return textResult(`Room not found: ${roomId}. Call room_create first.`, true);
			const events = readEventsFile(eventsPath);
			const agents = readAgentsFile(agentsPath);
			let latestSeq = 0;
			for (const e of events) if (e.seq > latestSeq) latestSeq = e.seq;

			let callerSummary: { agentId: string; lastReadSeq: number; unreadRelevant: number; status?: string } | null = null;
			let callerAgentId: string | null = null;
			try {
				callerAgentId = resolveAgentIdFromParamsOrEnv(params ?? {});
			} catch {
				callerAgentId = null;
			}
			if (callerAgentId) {
				const state = agents[callerAgentId];
				const lastRead = state?.lastReadSeq ?? 0;
				const unreadRelevant = events.filter((e) => e.seq > lastRead && isMessageRelevantTo(e, callerAgentId)).length;
				callerSummary = { agentId: callerAgentId, lastReadSeq: lastRead, unreadRelevant, status: state?.status };
			}

			const agentList = Object.values(agents).map((a) => `${a.agentId} (role=${a.role}, status=${a.status}, lastReadSeq=${a.lastReadSeq})`);
			const lines = [
				`room=${roomId} events=${events.length} latestSeq=${latestSeq}`,
				`agents (${agentList.length}): ${agentList.length ? agentList.join("; ") : "(none)"}`,
			];
			if (callerSummary) {
				lines.push(`you (${callerSummary.agentId}): lastReadSeq=${callerSummary.lastReadSeq} unreadRelevant=${callerSummary.unreadRelevant} status=${callerSummary.status ?? "unknown"}`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { roomId, latestSeq, events: events.length, agents, caller: callerSummary },
			};
		},
	});
}

export default function brainWorkflow(pi: ExtensionAPI) {
	pi.registerFlag("workflow-agent", {
		description: "Workflow agent for this process: brain or none",
		type: "string",
	});

	makeDelegateTool(pi, "coder");
	makeDelegateTool(pi, "reviewer");

	makeRoomTools(pi);

	pi.registerCommand("workflow", {
		description: "Show effective brain/coder/reviewer workflow presets",
		handler: async (_args, ctx) => {
			const loaded = loadWorkflowConfig(ctx.cwd);
			const reviewerSwarm = resolveReviewerSwarmConfig(loaded.config);
			const lines = [
				"Pi workflow: brain -> coder -> reviewer",
				`global: ${loaded.globalPath}`,
				`project override: ${loaded.projectPath ?? "(none)"}`,
				"",
				formatPreset("brain", getAgentPreset(loaded.config, "brain")),
				formatPreset("coder", getAgentPreset(loaded.config, "coder")),
				formatPreset("reviewer", getAgentPreset(loaded.config, "reviewer")),
				`reviewerSwarm: enabled=${reviewerSwarm.enabled} maxConcurrency=${reviewerSwarm.maxConcurrency}`,
				`reviewerSwarm targets: ${reviewerSwarm.targets.join(" | ")}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("tool_result", async (event) => {
		const raw = event as any;
		const toolName = String(raw.toolName ?? "");
		if (toolName !== "delegate_to_coder" && toolName !== "delegate_to_reviewer") return;
		const failure = getDelegateFailureReason(toolName, { details: raw.details });
		if (!failure || raw.isError === true) return;
		return { isError: true };
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
