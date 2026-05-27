import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AutoCreateMode = "always" | "ask" | "never";

type SprintConfig = {
	version: number;
	visibility: "committed" | "private";
	autoCreate: AutoCreateMode;
	defaultTracker: "linear";
	linear: { enabled: boolean; teamKey: string | null; projectId: string | null };
};

type SprintCurrent = {
	activeSprintPath: string | null;
	activeTaskPath: string | null;
	updatedAt: string;
};

const SPRINTS_DIR = ".sprints";
const DECLINED_CWDS = new Set<string>();

const DEFAULT_CONFIG: SprintConfig = {
	version: 1,
	visibility: "committed",
	autoCreate: "ask",
	defaultTracker: "linear",
	linear: { enabled: false, teamKey: null, projectId: null },
};

function nowIso() {
	return new Date().toISOString();
}

function safeSlug(input: string): string {
	const s = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return s || "sprint";
}

function sprintIdFromName(name: string): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `SPR-${y}-${m}-${day}-${safeSlug(name)}`;
}

function readJson<T>(filePath: string): T | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return null;
	}
}

function writeJson(filePath: string, value: unknown) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureFile(filePath: string, content: string) {
	if (fs.existsSync(filePath)) return;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

function appendFile(filePath: string, content: string) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, content, "utf8");
}

function rootPaths(cwd: string) {
	const root = cwd;
	const sprintsRoot = path.join(root, SPRINTS_DIR);
	return {
		root,
		sprintsRoot,
		configPath: path.join(sprintsRoot, "config.json"),
		currentPath: path.join(sprintsRoot, "current.json"),
	};
}

function ensurePrivateGitExclusion(root: string, useGitignore: boolean) {
	const sprintsPattern = `${SPRINTS_DIR}/`;
	if (useGitignore) {
		const gitignore = path.join(root, ".gitignore");
		const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
		if (!existing.split(/\r?\n/).includes(sprintsPattern)) {
			const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
			fs.writeFileSync(gitignore, `${existing}${prefix}${sprintsPattern}\n`, "utf8");
		}
		return;
	}
	let excludePath: string;
	try {
		const rawExcludePath = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		excludePath = path.isAbsolute(rawExcludePath) ? rawExcludePath : path.resolve(root, rawExcludePath);
	} catch {
		throw new Error("--private requires a git repository unless --gitignore is used.");
	}
	fs.mkdirSync(path.dirname(excludePath), { recursive: true });
	const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
	if (!existing.split(/\r?\n/).includes(sprintsPattern)) {
		const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
		fs.writeFileSync(excludePath, `${existing}${prefix}${sprintsPattern}\n`, "utf8");
	}
}

function initSprints(cwd: string, options?: { isPrivate?: boolean; gitignore?: boolean }) {
	const { sprintsRoot, configPath, currentPath, root } = rootPaths(cwd);
	if (options?.isPrivate && !options.gitignore) ensurePrivateGitExclusion(root, false);
	fs.mkdirSync(path.join(sprintsRoot, "epics"), { recursive: true });
	fs.mkdirSync(path.join(sprintsRoot, "sprints"), { recursive: true });
	ensureFile(
		path.join(sprintsRoot, "README.md"),
		"# .sprints\n\nAI sprint navigation substrate. This is project-local execution context, not a human tracker.\n",
	);
	const config = readJson<SprintConfig>(configPath) ?? JSON.parse(JSON.stringify(DEFAULT_CONFIG));
	if (options?.isPrivate) config.visibility = "private";
	writeJson(configPath, config);
	if (!fs.existsSync(currentPath)) {
		writeJson(currentPath, { activeSprintPath: null, activeTaskPath: null, updatedAt: nowIso() } satisfies SprintCurrent);
	}
	if (options?.isPrivate && options.gitignore) ensurePrivateGitExclusion(root, true);
}

function createSprint(cwd: string, name: string) {
	initSprints(cwd);
	const { sprintsRoot, currentPath } = rootPaths(cwd);
	const sprintId = sprintIdFromName(name);
	const sprintPath = path.join(sprintsRoot, "sprints", sprintId);
	fs.mkdirSync(sprintPath, { recursive: true });
	fs.mkdirSync(path.join(sprintPath, "tasks"), { recursive: true });
	fs.mkdirSync(path.join(sprintPath, "progression"), { recursive: true });
	fs.mkdirSync(path.join(sprintPath, "reviews"), { recursive: true });
	fs.mkdirSync(path.join(sprintPath, "artifacts"), { recursive: true });
	fs.mkdirSync(path.join(sprintPath, "sync"), { recursive: true });
	ensureFile(path.join(sprintPath, "README.md"), `# ${sprintId}\n\n${name}\n`);
	ensureFile(path.join(sprintPath, "PR.md"), "# PR Notes\n");
	ensureFile(path.join(sprintPath, "PROGRESS.md"), `# Progress\n\n- ${nowIso()} sprint created\n`);
	ensureFile(path.join(sprintPath, "DECISIONS.md"), "# Decisions\n");
	ensureFile(path.join(sprintPath, "RISKS.md"), "# Risks\n");
	ensureFile(
		path.join(sprintPath, "sprint.json"),
		`${JSON.stringify({ id: sprintId, name, createdAt: nowIso(), status: "active" }, null, 2)}\n`,
	);
	ensureFile(path.join(sprintPath, "progression", "00-intake.md"), "# Intake\n");
	ensureFile(path.join(sprintPath, "progression", "10-plan.md"), "# Plan\n");
	ensureFile(path.join(sprintPath, "progression", "20-implementation.md"), "# Implementation\n");
	ensureFile(path.join(sprintPath, "progression", "30-review.md"), "# Review\n");
	ensureFile(path.join(sprintPath, "progression", "40-validation.md"), "# Validation\n");
	ensureFile(path.join(sprintPath, "progression", "50-release.md"), "# Release\n");
	ensureFile(
		path.join(sprintPath, "sync", "linear.json"),
		`${JSON.stringify({ enabled: false, externalId: null, url: null, lastSyncAt: null }, null, 2)}\n`,
	);
	const normalized = normalizeActiveSprintPath(cwd, path.relative(cwd, sprintPath));
	writeJson(currentPath, { activeSprintPath: normalized.relativePath, activeTaskPath: null, updatedAt: nowIso() } satisfies SprintCurrent);
	return { sprintId, sprintPath };
}

function loadCurrent(cwd: string): SprintCurrent | null {
	const { currentPath } = rootPaths(cwd);
	return readJson<SprintCurrent>(currentPath);
}

function saveCurrent(cwd: string, current: SprintCurrent) {
	writeJson(rootPaths(cwd).currentPath, current);
}

function normalizeActiveSprintPath(cwd: string, candidate: string, requireSprintJson = true): { relativePath: string; absolutePath: string } {
	const raw = String(candidate || "").trim();
	if (!raw) throw new Error("Active sprint path is empty.");
	if (path.isAbsolute(raw)) throw new Error("Active sprint path must be relative.");
	const sprintBaseAbs = path.resolve(rootPaths(cwd).sprintsRoot, "sprints");
	const candidateAbs = path.resolve(cwd, raw);
	const rel = path.relative(sprintBaseAbs, candidateAbs);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error("Active sprint path must resolve under .sprints/sprints.");
	}
	if (requireSprintJson && !fs.existsSync(path.join(candidateAbs, "sprint.json"))) {
		throw new Error("Active sprint path must contain sprint.json.");
	}
	return { relativePath: path.relative(cwd, candidateAbs), absolutePath: candidateAbs };
}

function activeSprintAbs(cwd: string): string | null {
	const current = loadCurrent(cwd);
	if (!current?.activeSprintPath) return null;
	const normalized = normalizeActiveSprintPath(cwd, current.activeSprintPath);
	if (normalized.relativePath !== current.activeSprintPath) {
		current.activeSprintPath = normalized.relativePath;
		current.updatedAt = nowIso();
		saveCurrent(cwd, current);
	}
	return normalized.absolutePath;
}

function normalizeActiveTaskPath(cwd: string, candidate: string, sprintAbs: string): { relativePath: string; absolutePath: string } {
	const raw = String(candidate || "").trim();
	if (!raw) throw new Error("Active task path is empty.");
	if (path.isAbsolute(raw)) throw new Error("Active task path must be relative.");
	const tasksBaseAbs = path.resolve(sprintAbs, "tasks");
	const candidateAbs = path.resolve(cwd, raw);
	const rel = path.relative(tasksBaseAbs, candidateAbs);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error("Active task path must resolve under the active sprint tasks directory.");
	}
	if (!fs.existsSync(candidateAbs) || !fs.statSync(candidateAbs).isFile()) {
		throw new Error("Active task path must point to an existing task file.");
	}
	return { relativePath: path.relative(cwd, candidateAbs), absolutePath: candidateAbs };
}

function parseTaskFile(filePath: string): { frontmatter: Record<string, unknown>; body: string } {
	const raw = fs.readFileSync(filePath, "utf8");
	const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!m) return { frontmatter: {}, body: raw };
	const frontmatter: Record<string, unknown> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { frontmatter, body: m[2] };
}

function writeTaskFile(filePath: string, frontmatter: Record<string, unknown>, body: string) {
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v == null ? "" : String(v)}`)
		.join("\n");
	fs.writeFileSync(filePath, `---\n${fm}\n---\n${body}`, "utf8");
}

function nextTaskId(sprintPath: string): string {
	const tasksDir = path.join(sprintPath, "tasks");
	if (!fs.existsSync(tasksDir)) return "TASK-001";
	const ids = fs
		.readdirSync(tasksDir)
		.map((f) => f.match(/^TASK-(\d+)\./)?.[1])
		.filter(Boolean)
		.map((n) => Number(n));
	const n = ids.length ? Math.max(...ids) + 1 : 1;
	return `TASK-${String(n).padStart(3, "0")}`;
}

function nextEpicId(cwd: string): string {
	const epicsDir = path.join(rootPaths(cwd).sprintsRoot, "epics");
	if (!fs.existsSync(epicsDir)) return "EPIC-001";
	const ids = fs
		.readdirSync(epicsDir)
		.map((f) => f.match(/^EPIC-(\d+)-/)?.[1])
		.filter(Boolean)
		.map((n) => Number(n));
	const n = ids.length ? Math.max(...ids) + 1 : 1;
	return `EPIC-${String(n).padStart(3, "0")}`;
}

function createEpic(cwd: string, title: string, extra?: Record<string, unknown>) {
	initSprints(cwd);
	const epicId = nextEpicId(cwd);
	const epicPath = path.join(rootPaths(cwd).sprintsRoot, "epics", `${epicId}-${safeSlug(title)}`);
	fs.mkdirSync(epicPath, { recursive: true });
	const humanSummary = String(extra?.humanSummary ?? "");
	const aiContext = String(extra?.aiContext ?? "");
	ensureFile(path.join(epicPath, "README.md"), `# ${epicId}: ${title}\n\n## Human Summary\n${humanSummary}\n\n## AI Context\n${aiContext}\n`);
	ensureFile(path.join(epicPath, "decisions.md"), "# Decisions\n");
	ensureFile(path.join(epicPath, "acceptance.md"), "# Acceptance\n");
	return { epicId, epicPath };
}

function createTask(cwd: string, title: string, extra?: Record<string, unknown>) {
	const sprintPath = activeSprintAbs(cwd);
	if (!sprintPath) throw new Error("No active sprint. Create one with /sprint new <name>.");
	const id = nextTaskId(sprintPath);
	const slug = safeSlug(title);
	const filePath = path.join(sprintPath, "tasks", `${id}-${slug}.md`);
	const fm: Record<string, unknown> = {
		id,
		title,
		status: "todo",
		createdAt: nowIso(),
		...extra,
	};
	const body = `\n## Human Summary\n${extra?.humanSummary ?? ""}\n\n## AI Context\n${extra?.aiContext ?? ""}\n\n## Acceptance Criteria\n${extra?.acceptanceCriteria ?? ""}\n\n## Notes\n`;
	writeTaskFile(filePath, fm, body);
	const current = loadCurrent(cwd);
	if (current) {
		if (!current.activeTaskPath) current.activeTaskPath = path.relative(cwd, filePath);
		current.updatedAt = nowIso();
		saveCurrent(cwd, current);
	}
	appendProgress(cwd, `task created ${id}: ${title}`);
	return { id, filePath };
}

function setActiveTask(cwd: string, taskId: string) {
	const sprintPath = activeSprintAbs(cwd);
	if (!sprintPath) throw new Error("No active sprint.");
	const tasks = fs.readdirSync(path.join(sprintPath, "tasks"));
	const match = tasks.find((f) => f.startsWith(`${taskId}-`));
	if (!match) throw new Error(`Task not found: ${taskId}`);
	const full = path.join(sprintPath, "tasks", match);
	const current = loadCurrent(cwd);
	if (!current) throw new Error("Sprint current.json missing");
	current.activeTaskPath = path.relative(cwd, full);
	current.updatedAt = nowIso();
	saveCurrent(cwd, current);
	return full;
}

function appendProgress(cwd: string, message: string) {
	const sprintPath = activeSprintAbs(cwd);
	if (!sprintPath) throw new Error("No active sprint.");
	appendFile(path.join(sprintPath, "PROGRESS.md"), `- ${nowIso()} ${message}\n`);
}

function updateTaskStatus(cwd: string, taskId: string, status: string, note?: string) {
	const sprintPath = activeSprintAbs(cwd);
	if (!sprintPath) throw new Error("No active sprint.");
	const tasks = fs.readdirSync(path.join(sprintPath, "tasks"));
	const match = tasks.find((f) => f.startsWith(`${taskId}-`));
	if (!match) throw new Error(`Task not found: ${taskId}`);
	const filePath = path.join(sprintPath, "tasks", match);
	const parsed = parseTaskFile(filePath);
	parsed.frontmatter.status = status;
	parsed.frontmatter.updatedAt = nowIso();
	if (status === "done") parsed.frontmatter.completedAt = nowIso();
	let body = parsed.body;
	if (note) body = `${body.trimEnd()}\n- ${nowIso()} ${note}\n`;
	writeTaskFile(filePath, parsed.frontmatter, body);
	appendProgress(cwd, `task ${taskId} -> ${status}${note ? ` (${note})` : ""}`);
	return filePath;
}

function getGlobalAutoCreate(): AutoCreateMode {
	const p = path.join(os.homedir(), ".pi", "agent", "sprints.json");
	const cfg = readJson<{ autoCreate?: AutoCreateMode }>(p);
	const mode = cfg?.autoCreate;
	if (mode === "always" || mode === "ask" || mode === "never") return mode;
	return "ask";
}

function isNonTrivialPrompt(text: string): boolean {
	const t = text.toLowerCase();
	if (/^\s*\/sprint\b/.test(t)) return false;
	if (t.length > 60) return true;
	return /(implement|fix|add|update|refactor|build|create|feature|bug|sprint)/.test(t);
}

function deriveSprintName(prompt: string): string {
	const cleaned = prompt.replace(/\s+/g, " ").trim();
	if (!cleaned) return "general-work";
	return cleaned.slice(0, 50);
}

function parseArgs(rawArgs: unknown): string[] {
	if (Array.isArray(rawArgs)) return rawArgs.map((v) => String(v));
	if (typeof rawArgs === "string") return rawArgs.split(/\s+/).filter(Boolean);
	return [];
}

function sprintPointerText(current: SprintCurrent): string {
	return [
		"Sprint system active.",
		`Active sprint path: ${current.activeSprintPath}`,
		`Active task path: ${current.activeTaskPath ?? "(none)"}`,
		"Before non-trivial implementation, read sprint/task context. Keep PROGRESS/task evidence updated.",
	].join("\n");
}

async function askUi(ui: any, title: string, message: string): Promise<boolean> {
	if (typeof ui?.confirm === "function") return Boolean(await ui.confirm(title, message));
	if (typeof ui?.askConfirm === "function") return Boolean(await ui.askConfirm(message));
	return false;
}

async function askUiInput(ui: any, title: string, placeholder: string): Promise<string> {
	if (typeof ui?.input === "function") return String((await ui.input(title, placeholder)) ?? "");
	if (typeof ui?.prompt === "function") return String((await ui.prompt(title)) ?? "");
	return "";
}

export default function sprintSystem(pi: ExtensionAPI) {
	pi.registerCommand("sprint", {
		description: "Manage .sprints sprint substrate",
		handler: async (rawArgs, ctx) => {
			const args = parseArgs(rawArgs);
			const sub = args[0];
			try {
				if (sub === "init") {
					const isPrivate = args.includes("--private");
					const gitignore = args.includes("--gitignore");
					initSprints(ctx.cwd, { isPrivate, gitignore });
					ctx.ui.notify(`Sprint system initialized at ${path.join(ctx.cwd, SPRINTS_DIR)}`, "info");
					return;
				}
				if (sub === "new") {
					const name = args.slice(1).join(" ").trim();
					if (!name) throw new Error("Usage: /sprint new <name>");
					const created = createSprint(ctx.cwd, name);
					ctx.ui.notify(`Active sprint: ${created.sprintId}`, "info");
					return;
				}
				if (sub === "status") {
					const p = rootPaths(ctx.cwd);
					const current = loadCurrent(ctx.cwd);
					ctx.ui.notify(
						[
							`.sprints: ${p.sprintsRoot}`,
							`active sprint: ${current?.activeSprintPath ?? "(none)"}`,
							`active task: ${current?.activeTaskPath ?? "(none)"}`,
						].join("\n"),
						"info",
					);
					return;
				}
				if (sub === "task" && args[1] === "add") {
					const title = args.slice(2).join(" ").trim();
					if (!title) throw new Error("Usage: /sprint task add <title>");
					const t = createTask(ctx.cwd, title);
					ctx.ui.notify(`Created ${t.id}`, "info");
					return;
				}
				if (sub === "task" && args[1] === "active") {
					const id = args[2];
					if (!id) throw new Error("Usage: /sprint task active <TASK-ID>");
					const file = setActiveTask(ctx.cwd, id);
					ctx.ui.notify(`Active task: ${path.relative(ctx.cwd, file)}`, "info");
					return;
				}
				if (sub === "task" && args[1] === "done") {
					const id = args[2];
					if (!id) throw new Error("Usage: /sprint task done <TASK-ID>");
					updateTaskStatus(ctx.cwd, id, "done", "marked done");
					ctx.ui.notify(`Done: ${id}`, "info");
					return;
				}
				if (sub === "epic" && args[1] === "add") {
					const title = args.slice(2).join(" ").trim();
					if (!title) throw new Error("Usage: /sprint epic add <title>");
					const epic = createEpic(ctx.cwd, title);
					ctx.ui.notify(`Created epic ${epic.epicId}`, "info");
					return;
				}
				if (sub === "log") {
					const msg = args.slice(1).join(" ").trim();
					if (!msg) throw new Error("Usage: /sprint log <message>");
					appendProgress(ctx.cwd, msg);
					ctx.ui.notify("Progress logged", "info");
					return;
				}
				ctx.ui.notify(
					"Usage: /sprint init [--private] [--gitignore] | new <name> | status | task add <title> | task active <TASK-ID> | task done <TASK-ID> | epic add <title> | log <message>",
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "sprint_read_context",
		label: "Sprint: Read Context",
		description: "Read active sprint config/current/task pointers with brief snippets.",
		promptSnippet: "Read sprint context before planning or coding.",
		promptGuidelines: ["Use sprint_read_context first when sprint pointers exist or sprint state is unclear."],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const paths = rootPaths(cwd);
			const config = readJson<SprintConfig>(paths.configPath);
			const current = readJson<SprintCurrent>(paths.currentPath);
			let sprintPath: string | null = null;
			let taskPath: string | null = null;
			if (current?.activeSprintPath) {
				try {
					sprintPath = normalizeActiveSprintPath(cwd, current.activeSprintPath).absolutePath;
					if (current.activeTaskPath) taskPath = normalizeActiveTaskPath(cwd, current.activeTaskPath, sprintPath).absolutePath;
				} catch {
					sprintPath = null;
					taskPath = null;
				}
			}
			const sprintReadme = sprintPath && fs.existsSync(path.join(sprintPath, "README.md")) ? fs.readFileSync(path.join(sprintPath, "README.md"), "utf8").slice(0, 400) : "";
			const taskHead = taskPath && fs.existsSync(taskPath) ? fs.readFileSync(taskPath, "utf8").slice(0, 400) : "";
			return {
				content: [{ type: "text", text: JSON.stringify({ config, current, sprintPath: sprintPath ? path.relative(cwd, sprintPath) : null, taskPath: taskPath ? path.relative(cwd, taskPath) : null, sprintReadme, taskHead }) }],
			};
		},
	});

	pi.registerTool({
		name: "sprint_create",
		label: "Sprint: Create Sprint",
		description: "Initialize sprint system if needed and create+activate a sprint.",
		promptSnippet: "Create a sprint when non-trivial work starts without one.",
		promptGuidelines: ["Use sprint_create when there is no active sprint and work should be tracked in .sprints."],
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const name = String((params as any).name || "").trim();
			if (!name) return { isError: true, content: [{ type: "text", text: "Missing name" }] };
			const created = createSprint(cwd, name);
			return { content: [{ type: "text", text: `Created ${path.relative(cwd, created.sprintPath)}` }] };
		},
	});

	pi.registerTool({
		name: "sprint_create_task",
		label: "Sprint: Create Task",
		description: "Create task in active sprint.",
		promptSnippet: "Create a task for concrete implementation work.",
		promptGuidelines: ["Use sprint_create_task for scoped units of work inside the active sprint."],
		parameters: Type.Object({
			title: Type.String(),
			humanSummary: Type.Optional(Type.String()),
			aiContext: Type.Optional(Type.String()),
			acceptanceCriteria: Type.Optional(Type.String()),
			epic: Type.Optional(Type.String()),
			priority: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as any;
			const title = String(p.title || "").trim();
			if (!title) return { isError: true, content: [{ type: "text", text: "Missing title" }] };
			const created = createTask(ctx.cwd, title, {
				humanSummary: p.humanSummary,
				aiContext: p.aiContext,
				acceptanceCriteria: p.acceptanceCriteria,
				epic: p.epic,
				priority: p.priority,
			});
			return { content: [{ type: "text", text: `Created task ${created.id}` }] };
		},
	});

	pi.registerTool({
		name: "sprint_create_epic",
		label: "Sprint: Create Epic",
		description: "Create an epic under .sprints/epics.",
		promptSnippet: "Create an epic for larger multi-task initiative context.",
		promptGuidelines: ["Use sprint_create_epic when work spans multiple tasks and needs durable shared context."],
		parameters: Type.Object({
			title: Type.String(),
			humanSummary: Type.Optional(Type.String()),
			aiContext: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as any;
			const title = String(p.title || "").trim();
			if (!title) return { isError: true, content: [{ type: "text", text: "Missing title" }] };
			const epic = createEpic(ctx.cwd, title, { humanSummary: p.humanSummary, aiContext: p.aiContext });
			return { content: [{ type: "text", text: `Created epic ${epic.epicId} at ${path.relative(ctx.cwd, epic.epicPath)}` }] };
		},
	});

	pi.registerTool({
		name: "sprint_set_active",
		label: "Sprint: Set Active",
		description: "Set active sprint/task pointer.",
		promptSnippet: "Update active sprint/task pointers.",
		promptGuidelines: ["Use sprint_set_active to update pointers; if both sprintPath and taskId are provided, switch sprint first, then resolve task in that sprint."],
		parameters: Type.Object({ sprintPath: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const p = params as any;
			let sprintPathText: string | null = null;
			let taskPathText: string | null = null;
			if (p.sprintPath) {
				const current = loadCurrent(cwd) ?? { activeSprintPath: null, activeTaskPath: null, updatedAt: nowIso() };
				const normalized = normalizeActiveSprintPath(cwd, String(p.sprintPath));
				current.activeSprintPath = normalized.relativePath;
				if (!p.taskId) current.activeTaskPath = null;
				current.updatedAt = nowIso();
				saveCurrent(cwd, current);
				sprintPathText = current.activeSprintPath;
			}
			if (p.taskId) {
				const taskFile = setActiveTask(cwd, String(p.taskId));
				taskPathText = path.relative(cwd, taskFile);
			}
			const latest = loadCurrent(cwd);
			return {
				content: [
					{ type: "text", text: `Active pointers updated (sprint=${latest?.activeSprintPath ?? sprintPathText ?? "(unchanged)"}, task=${latest?.activeTaskPath ?? taskPathText ?? "(unchanged)"})` },
				],
			};
		},
	});

	pi.registerTool({
		name: "sprint_update_task",
		label: "Sprint: Update Task",
		description: "Update task status and append task notes/evidence.",
		promptSnippet: "Update task status during implementation progress.",
		promptGuidelines: ["Use sprint_update_task to move task state and attach concise evidence notes."],
		parameters: Type.Object({ taskId: Type.String(), status: Type.Optional(Type.String()), note: Type.Optional(Type.String()) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as any;
			const taskId = String(p.taskId || "").trim();
			if (!taskId) return { isError: true, content: [{ type: "text", text: "Missing taskId" }] };
			const status = p.status ? String(p.status) : "in_progress";
			const file = updateTaskStatus(ctx.cwd, taskId, status, p.note ? String(p.note) : undefined);
			return { content: [{ type: "text", text: `Updated ${path.basename(file)}` }] };
		},
	});

	pi.registerTool({
		name: "sprint_log_progress",
		label: "Sprint: Log Progress",
		description: "Append message to active sprint PROGRESS.md.",
		promptSnippet: "Log notable sprint progress milestones.",
		promptGuidelines: ["Use sprint_log_progress after meaningful changes, checks, or decisions."],
		parameters: Type.Object({ message: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const msg = String((params as any).message || "").trim();
			if (!msg) return { isError: true, content: [{ type: "text", text: "Missing message" }] };
			appendProgress(ctx.cwd, msg);
			return { content: [{ type: "text", text: "Logged" }] };
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = loadCurrent(ctx.cwd);
		if (current?.activeSprintPath) {
			try {
				const normalized = normalizeActiveSprintPath(ctx.cwd, current.activeSprintPath);
				if (normalized.relativePath !== current.activeSprintPath) {
					current.activeSprintPath = normalized.relativePath;
					current.updatedAt = nowIso();
				}
				if (current.activeTaskPath) {
					const normalizedTask = normalizeActiveTaskPath(ctx.cwd, current.activeTaskPath, normalized.absolutePath);
					if (normalizedTask.relativePath !== current.activeTaskPath) {
						current.activeTaskPath = normalizedTask.relativePath;
						current.updatedAt = nowIso();
					}
				}
				saveCurrent(ctx.cwd, current);
				return { systemPrompt: `${event.systemPrompt}\n\n${sprintPointerText(current)}` };
			} catch {
				// Ignore invalid active sprint pointer.
			}
		}

		if (process.env.PI_WORKFLOW_CHILD === "1") return;
		if (DECLINED_CWDS.has(ctx.cwd)) return;
		const prompt = String((event as any)?.prompt ?? "");
		if (!isNonTrivialPrompt(prompt)) return;
		const mode = getGlobalAutoCreate();
		if (mode === "never") return;
		if (mode === "always") {
			const created = createSprint(ctx.cwd, deriveSprintName(prompt));
			ctx.ui.notify(`Auto-created sprint ${created.sprintId}`, "info");
			const createdCurrent = loadCurrent(ctx.cwd);
			if (createdCurrent?.activeSprintPath) {
				try {
					normalizeActiveSprintPath(ctx.cwd, createdCurrent.activeSprintPath);
					return { systemPrompt: `${event.systemPrompt}\n\n${sprintPointerText(createdCurrent)}` };
				} catch {
					return;
				}
			}
			return;
		}
		const accepted = await askUi((ctx as any).ui, "Sprint bootstrap", "No active sprint found. Create one now?");
		if (!accepted) {
			DECLINED_CWDS.add(ctx.cwd);
			return;
		}
		const inputName = (await askUiInput((ctx as any).ui, "Sprint name", "Optional: short sprint title")).trim();
		const created = createSprint(ctx.cwd, inputName || deriveSprintName(prompt));
		ctx.ui.notify(`Created sprint ${created.sprintId}`, "info");
		const createdCurrent = loadCurrent(ctx.cwd);
		if (createdCurrent?.activeSprintPath) {
			try {
				normalizeActiveSprintPath(ctx.cwd, createdCurrent.activeSprintPath);
				return { systemPrompt: `${event.systemPrompt}\n\n${sprintPointerText(createdCurrent)}` };
			} catch {
				return;
			}
		}
	});
}
