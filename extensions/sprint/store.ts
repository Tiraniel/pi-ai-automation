// Sprint subsystem — fs/domain/session-binding/heuristic helpers.
// Extracted from extensions/sprint-system.ts as part of TASK-018 Slice 4.
//
// This module owns the on-disk substrate: file reads/writes, sprint/task
// lifecycle, sprint.json/current.json normalization, task frontmatter
// parsing, session binding reads, the global auto-create mode, and the
// lightweight UI/heuristic helpers used by the command and the
// before_agent_start hook. UI prompt text builders live in ./prompt so
// the sprint command/hook bodies stay readable; command/tool/hook
// registration lives in ./command, ./tools, and ./hooks respectively.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_CONFIG,
	SPRINT_BINDING_CUSTOM_TYPE,
	SPRINTS_DIR,
	type AutoCreateMode,
	type SessionBinding,
	type SprintConfig,
	type SprintCurrent,
} from "./types";

// ============================================================================
// Misc helpers
// ============================================================================

export function nowIso(): string {
	return new Date().toISOString();
}

export function safeSlug(input: string): string {
	const s = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return s || "sprint";
}

export function sprintIdFromName(name: string): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `SPR-${y}-${m}-${day}-${safeSlug(name)}`;
}

// ============================================================================
// fs helpers
// ============================================================================

export function readJson<T>(filePath: string): T | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return null;
	}
}

export function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function ensureFile(filePath: string, content: string): void {
	if (fs.existsSync(filePath)) return;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

export function appendFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, content, "utf8");
}

export function rootPaths(cwd: string): {
	root: string;
	sprintsRoot: string;
	configPath: string;
	currentPath: string;
} {
	const root = cwd;
	const sprintsRoot = path.join(root, SPRINTS_DIR);
	return {
		root,
		sprintsRoot,
		configPath: path.join(sprintsRoot, "config.json"),
		currentPath: path.join(sprintsRoot, "current.json"),
	};
}

export function ensurePrivateGitExclusion(root: string, useGitignore: boolean): void {
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

// ============================================================================
// Sprint lifecycle
// ============================================================================

export function initSprints(cwd: string, options?: { isPrivate?: boolean; gitignore?: boolean }): void {
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

export function createSprint(cwd: string, name: string): { sprintId: string; sprintPath: string } {
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

// ============================================================================
// current.json / pointer normalization
// ============================================================================

export function loadCurrent(cwd: string): SprintCurrent | null {
	const { currentPath } = rootPaths(cwd);
	return readJson<SprintCurrent>(currentPath);
}

export function saveCurrent(cwd: string, current: SprintCurrent): void {
	writeJson(rootPaths(cwd).currentPath, current);
}

export function normalizeActiveSprintPath(
	cwd: string,
	candidate: string,
	requireSprintJson = true,
): { relativePath: string; absolutePath: string } {
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

export function activeSprintAbs(cwd: string): string | null {
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

export function normalizeActiveTaskPath(
	cwd: string,
	candidate: string,
	sprintAbs: string,
): { relativePath: string; absolutePath: string } {
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

// ============================================================================
// Task frontmatter helpers
// ============================================================================

export function parseTaskFile(filePath: string): { frontmatter: Record<string, unknown>; body: string } {
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

export function writeTaskFile(filePath: string, frontmatter: Record<string, unknown>, body: string): void {
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v == null ? "" : String(v)}`)
		.join("\n");
	fs.writeFileSync(filePath, `---\n${fm}\n---\n${body}`, "utf8");
}

export function nextTaskId(sprintPath: string): string {
	const tasksDir = path.join(sprintPath, "tasks");
	if (!fs.existsSync(tasksDir)) return "TASK-001";
	const ids = fs
		.readdirSync(tasksDir)
		.map((f) => f.match(/^TASK-(\d+)-/)?.[1])
		.filter(Boolean)
		.map((n) => Number(n));
	const n = ids.length ? Math.max(...ids) + 1 : 1;
	return `TASK-${String(n).padStart(3, "0")}`;
}

// ============================================================================
// Session binding
// ============================================================================

export function readSessionBinding(sessionManager: any): SessionBinding | null {
	try {
		if (!sessionManager) return null;
		// Prefer entries on the current branch (getBranch) over all entries
		// (getEntries) so a sprintBinding custom entry from an abandoned branch
		// cannot override the current branch's binding.
		const entries: any[] = typeof sessionManager.getBranch === "function"
			? (sessionManager.getBranch.call(sessionManager) as any[])
			: typeof sessionManager.getEntries === "function"
				? (sessionManager.getEntries.call(sessionManager) as any[])
				: [];
		if (!entries.length) return null;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e && e.type === "custom" && e.customType === SPRINT_BINDING_CUSTOM_TYPE && e.data) {
				const data = e.data as SessionBinding;
				if (data && typeof data.sprintPath === "string" && typeof data.taskPath === "string" && typeof data.taskId === "string") {
					return data;
				}
			}
		}
	} catch {
		// ignore
	}
	return null;
}

export function resolveSprintAbs(cwd: string, sessionManager?: any): string | null {
	const binding = sessionManager ? readSessionBinding(sessionManager) : null;
	if (binding?.sprintPath) {
		try {
			return normalizeActiveSprintPath(cwd, binding.sprintPath, true).absolutePath;
		} catch {
			// fall through to global pointer
		}
	}
	return activeSprintAbs(cwd);
}

export function findTaskFileInSprint(
	sprintAbs: string,
	taskId: string,
): { file: string; frontmatter: Record<string, unknown> } | null {
	const tasksDir = path.join(sprintAbs, "tasks");
	if (!fs.existsSync(tasksDir)) return null;
	const match = fs.readdirSync(tasksDir).find((f) => f.startsWith(`${taskId}-`));
	if (!match) return null;
	const file = path.join(tasksDir, match);
	const parsed = parseTaskFile(file);
	return { file, frontmatter: parsed.frontmatter };
}

// ============================================================================
// Epics and tasks
// ============================================================================

export function nextEpicId(cwd: string): string {
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

export function createEpic(cwd: string, title: string, extra?: Record<string, unknown>): { epicId: string; epicPath: string } {
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

export function createTask(cwd: string, title: string, extra?: Record<string, unknown>): { id: string; filePath: string } {
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

export function setActiveTask(cwd: string, taskId: string): string {
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

export function appendProgress(cwd: string, message: string, sessionManager?: any): void {
	const sprintPath = resolveSprintAbs(cwd, sessionManager);
	if (!sprintPath) throw new Error("No active sprint.");
	appendFile(path.join(sprintPath, "PROGRESS.md"), `- ${nowIso()} ${message}\n`);
}

export function updateTaskStatus(
	cwd: string,
	taskId: string,
	status: string,
	note?: string,
	sessionManager?: any,
	boundTaskPath?: string,
): string {
	const sprintPath = resolveSprintAbs(cwd, sessionManager);
	if (!sprintPath) throw new Error("No active sprint.");
	let filePath: string;
	if (boundTaskPath) {
		filePath = path.resolve(cwd, boundTaskPath);
		if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
			throw new Error(`Bound task file not found: ${boundTaskPath}`);
		}
		const tasksDir = path.join(sprintPath, "tasks");
		const rel = path.relative(tasksDir, filePath);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(`Bound task path is not under the active sprint tasks directory: ${boundTaskPath}`);
		}
	} else {
		const tasks = fs.readdirSync(path.join(sprintPath, "tasks"));
		const match = tasks.find((f) => f.startsWith(`${taskId}-`));
		if (!match) throw new Error(`Task not found: ${taskId}`);
		filePath = path.join(sprintPath, "tasks", match);
	}
	const parsed = parseTaskFile(filePath);
	parsed.frontmatter.status = status;
	parsed.frontmatter.updatedAt = nowIso();
	if (status === "done") parsed.frontmatter.completedAt = nowIso();
	let body = parsed.body;
	if (note) body = `${body.trimEnd()}\n- ${nowIso()} ${note}\n`;
	writeTaskFile(filePath, parsed.frontmatter, body);
	appendProgress(cwd, `task ${taskId} -> ${status}${note ? ` (${note})` : ""}`, sessionManager);
	return filePath;
}

// ============================================================================
// Heuristics / UI helpers
// ============================================================================

export function getGlobalAutoCreate(): AutoCreateMode {
	const p = path.join(os.homedir(), ".pi", "agent", "sprints.json");
	const cfg = readJson<{ autoCreate?: AutoCreateMode }>(p);
	const mode = cfg?.autoCreate;
	if (mode === "always" || mode === "ask" || mode === "never") return mode;
	return "ask";
}

export function isNonTrivialPrompt(text: string): boolean {
	const t = text.toLowerCase();
	if (/^\s*\/sprint\b/.test(t)) return false;
	if (t.length > 60) return true;
	return /(implement|fix|add|update|refactor|build|create|feature|bug|sprint)/.test(t);
}

export function deriveSprintName(prompt: string): string {
	const cleaned = prompt.replace(/\s+/g, " ").trim();
	if (!cleaned) return "general-work";
	return cleaned.slice(0, 50);
}

export function parseArgs(rawArgs: unknown): string[] {
	if (Array.isArray(rawArgs)) return rawArgs.map((v) => String(v));
	if (typeof rawArgs === "string") return rawArgs.split(/\s+/).filter(Boolean);
	return [];
}

export async function askUi(ui: any, title: string, message: string): Promise<boolean> {
	if (typeof ui?.confirm === "function") return Boolean(await ui.confirm(title, message));
	if (typeof ui?.askConfirm === "function") return Boolean(await ui.askConfirm(message));
	return false;
}

export async function askUiInput(ui: any, title: string, placeholder: string): Promise<string> {
	if (typeof ui?.input === "function") return String((await ui.input(title, placeholder)) ?? "");
	if (typeof ui?.prompt === "function") return String((await ui.prompt(title)) ?? "");
	return "";
}
