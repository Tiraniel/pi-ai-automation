// Sprint subsystem — debug/hotfix lane domain helpers.
// This module intentionally stays isolated from command/tool/prompt/hook wiring.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	appendFile as appendLaneLogLine,
	createTask,
	ensureFile,
	initSprints,
	nowIso,
	parseTaskFile,
	rootPaths,
	safeSlug,
	writeTaskFile,
} from "./store";
import {
	type DebugLaneHistoryItem,
	evaluateDebugLaneEscalation,
	inferDebugFeatureArea,
	buildDebugPromotionAppendix,
	type DebugEscalationInput,
	type DebugEscalationResult,
	type DebugEscalationRules,
} from "./debug-escalation";

export type DebugItemStatus = "open" | "done" | "promoted";

export type DebugItem = {
	id: string;
	title: string;
	status: DebugItemStatus;
	createdAt: string;
	updatedAt?: string;
	completedAt?: string;
	promotedTaskId?: string;
	promotedTaskPath?: string;
	filePath: string;
	notePreview?: string;
};

export type DebugPromotionOptions = {
	title?: string;
	note?: string;
	escalation?: DebugEscalationResult;
};

export type DebugLaneSummary = {
	path: string;
	exists: boolean;
	openCount: number;
	doneCount: number;
	promotedCount: number;
	latest: DebugItem[];
};

export type DebugEscalationFromDebugItemInput = Omit<DebugEscalationInput, "itemTitle" | "itemBody" | "featureArea" | "history" | "repeatedSameAreaFixCount"> & {
	itemTitle?: string;	itemBody?: string;	featureArea?: string;	area?: string;	evidenceText?: string;	filesChanged?: number;	locChanged?: number;	behaviorPaths?: number;	stateMachineOrArchitectureChange?: boolean;	reviewerBehaviorEvidenceMissing?: boolean;	rules?: Partial<DebugEscalationRules>;
};

export function readDebugLaneHistory(cwd: string): DebugLaneHistoryItem[] {
	const { itemsPath } = debugPaths(cwd);
	if (!fs.existsSync(itemsPath)) return [];
	const files = fs.readdirSync(itemsPath).filter((file) => /^DBG-\d+-.+\.md$/.test(file)).sort();
	const items: DebugLaneHistoryItem[] = [];
	for (const file of files) {
		try {
			const item = readDebugItemWithBody(path.join(itemsPath, file));
			items.push({
				id: item.id,
				title: item.title,
				status: item.status,
				body: item.body,
			});
		} catch {
			continue;
		}
	}
	return items;
}

const STATE_MACHINE_OR_ARCHITECTURE_HINT_RE = /\b(state\s*-?\s*machine|schema|persistence|architecture|refactor|redesign)\b/i;
const NAVIGATION_WITH_STRUCTURAL_CONTEXT_HINT_RE = /\b(state\s*-?\s*machine|schema|persistence|architecture|refactor|redesign)\b/i;
const REVIEWER_EVIDENCE_MISSING_PHRASES = [
	"missing behavior evidence",
	"behavior evidence missing",
	"missing evidence",
	"no behavior evidence",
	"without behavior evidence",
	"without validation",
	"reviewer says behavior evidence missing",
];

function inferStateMachineOrArchitectureFromText(value: string): boolean {
	const normalized = String(value || "").toLowerCase();
	if (!normalized) return false;
	if (STATE_MACHINE_OR_ARCHITECTURE_HINT_RE.test(normalized)) return true;
	const chunks = normalized.split(/[.?!;\n\r]+/);
	for (const chunk of chunks) {
		if (!/\bnavigation\b/.test(chunk)) continue;
		if (NAVIGATION_WITH_STRUCTURAL_CONTEXT_HINT_RE.test(chunk)) return true;
	}
	return false;
}

function inferReviewerEvidenceMissingFromEvidenceText(value: string): boolean {
	const text = String(value || "").toLowerCase().trim();
	if (!text) return false;
	return REVIEWER_EVIDENCE_MISSING_PHRASES.some((phrase) => text.includes(phrase));
}

export function evaluateDebugLaneEscalationFromDisk(cwd: string, input: DebugEscalationFromDebugItemInput): DebugEscalationResult {
	const itemId = String(input.itemId || "").trim().toUpperCase();
	if (!itemId) throw new Error("Missing debug item id.");
	const current = readDebugItemWithBody(resolveItemPath(cwd, itemId));
	const rawEvidence = typeof input.evidenceText === "string" ? input.evidenceText : "";
	const itemTitle = String(input.itemTitle || current.title);
	const itemBody = String(input.itemBody || current.body);
	const explicitFeatureArea = input.area || input.featureArea;
	const featureArea = explicitFeatureArea ? explicitFeatureArea.trim() : inferDebugFeatureArea(itemTitle, itemBody);
	const stateMachineOrArchitectureChange = input.stateMachineOrArchitectureChange === undefined
		? inferStateMachineOrArchitectureFromText(`${itemTitle}
${itemBody}
${rawEvidence}`)
		: input.stateMachineOrArchitectureChange;
	const reviewerBehaviorEvidenceMissing = input.reviewerBehaviorEvidenceMissing === undefined
		? inferReviewerEvidenceMissingFromEvidenceText(rawEvidence)
		: input.reviewerBehaviorEvidenceMissing;
	const history = readDebugLaneHistory(cwd);
	return evaluateDebugLaneEscalation({
		itemId: current.id,
		itemTitle,
		itemBody,
		featureArea,
		filesChanged: input.filesChanged,
		locChanged: input.locChanged,
		behaviorPaths: input.behaviorPaths,
		stateMachineOrArchitectureChange,
		reviewerBehaviorEvidenceMissing,
		history,
		rules: input.rules,
	});
}

const DEBUG_DIR = "debug";
const ITEMS_DIR = "items";
const LOG_FILE = "LOG.md";
const README_FILE = "README.md";

function debugPaths(cwd: string) {
	const { sprintsRoot } = rootPaths(cwd);
	const lanePath = path.join(sprintsRoot, DEBUG_DIR);
	return {
		lanePath,
		itemsPath: path.join(lanePath, ITEMS_DIR),
		logPath: path.join(lanePath, LOG_FILE),
		readmePath: path.join(lanePath, README_FILE),
	};
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: raw };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const idx = trimmed.indexOf(":");
		if (idx <= 0) continue;
		frontmatter[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
	}
	return { frontmatter, body: match[2] };
}

function parseStatus(value: unknown, filePath = "<unknown>"): DebugItemStatus {
	const normalized = String(value || "").trim();
	if (normalized === "open" || normalized === "done" || normalized === "promoted") return normalized;
	throw new Error(`Invalid persisted debug lane status "${value}" in ${filePath}.`);
}

function textFromFrontmatter(filePath: string): { frontmatter: Record<string, string>; body: string } {
	return parseFrontmatter(fs.readFileSync(filePath, "utf8"));
}

const DEBUG_TITLE_INVALID_CHARS = /[\u0000-\u001F\u007F]/;

function notePreviewFromBody(body: string): string | undefined {
	const marker = "## Notes";
	const markerIndex = body.indexOf(marker);
	if (markerIndex < 0) return undefined;
	const notes = body.slice(markerIndex + marker.length).split(/\r?\n/);
	for (const line of notes) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("-")) return trimmed.replace(/^-\s*/, "").trim();
		return trimmed;
	}
	return undefined;
}

function validateDebugTitle(rawTitle: string, label = "title"): string {
	const raw = String(rawTitle || "");
	if (DEBUG_TITLE_INVALID_CHARS.test(raw)) {
		throw new Error(`Debug lane ${label} contains invalid control characters or newlines.`);
	}
	const trimmed = raw.trim();
	if (!trimmed) throw new Error(`Missing debug lane ${label}.`);
	return trimmed;
}

type DebugItemWithBody = DebugItem & { body: string };

function readDebugItemWithBody(filePath: string): DebugItemWithBody {
	if (!fs.existsSync(filePath)) throw new Error(`Debug lane item not found: ${filePath}`);
	const { frontmatter, body } = textFromFrontmatter(filePath);
	const id = String(frontmatter.id || "").trim();
	if (!id) throw new Error(`Debug lane item missing id: ${path.basename(filePath)}`);
	if (!/^DBG-\d+$/.test(id)) throw new Error(`Invalid debug item id: ${id}`);
	const title = String(frontmatter.title || "").trim();
	if (!title) throw new Error(`Debug lane item missing title: ${path.basename(filePath)}`);
	const createdAt = String(frontmatter.createdAt || "");
	if (!createdAt) throw new Error(`Debug lane item missing createdAt: ${id}`);
	const parsed: DebugItemWithBody = {
		id,
		title,
		status: parseStatus(frontmatter.status, filePath),
		createdAt,
		updatedAt: frontmatter.updatedAt ? String(frontmatter.updatedAt) : undefined,
		completedAt: frontmatter.completedAt ? String(frontmatter.completedAt) : undefined,
		promotedTaskId: frontmatter.promotedTaskId ? String(frontmatter.promotedTaskId) : undefined,
		promotedTaskPath: frontmatter.promotedTaskPath ? String(frontmatter.promotedTaskPath) : undefined,
		filePath,
		notePreview: notePreviewFromBody(body),
		body,
	};
	return parsed;
}

function readDebugItem(filePath: string): DebugItem {
	const parsed = readDebugItemWithBody(filePath);
	// Keep public shape without body.
	return {
		id: parsed.id,
		title: parsed.title,
		status: parsed.status,
		createdAt: parsed.createdAt,
		updatedAt: parsed.updatedAt,
		completedAt: parsed.completedAt,
		promotedTaskId: parsed.promotedTaskId,
		promotedTaskPath: parsed.promotedTaskPath,
		filePath,
		notePreview: parsed.notePreview,
	};
}

function writeDebugItem(filePath: string, frontmatter: Record<string, unknown>, body: string): void {
	const content = `---\n${Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v == null ? "" : String(v)}`)
		.join("\n")}\n---\n${body}`;
	fs.writeFileSync(filePath, content, "utf8");
}

function noteLinesBody(body: string): string[] {
	return body.split(/\r?\n/).map((line) => line.trimEnd());
}

function appendNotes(body: string, noteLine: string): string {
	const existing = body.trimEnd();
	if (existing.includes("## Notes")) {
		return `${existing}\n- ${noteLine}\n`;
	}
	return `${existing}\n\n## Notes\n- ${noteLine}\n`;
}

function ensureLane(cwd: string): { lanePath: string; itemsPath: string; logPath: string; readmePath: string } {
	initSprints(cwd);
	const paths = debugPaths(cwd);
	fs.mkdirSync(paths.itemsPath, { recursive: true });
	ensureFile(paths.readmePath, "# .sprints/debug\n\nProject-local lightweight debug/hotfix lane.\n");
	ensureFile(paths.logPath, "# Debug Lane Log\n");
	return paths;
}

function nextItemId(itemsPath: string): string {
	if (!fs.existsSync(itemsPath)) return "DBG-001";
	const ids = fs
		.readdirSync(itemsPath)
		.map((file) => file.match(/^DBG-(\d+)-/))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.map((match) => Number(match[1]))
		.filter((n) => Number.isFinite(n));
	const next = ids.length ? Math.max(...ids) + 1 : 1;
	return `DBG-${String(next).padStart(3, "0")}`;
}

function resolveItemPath(cwd: string, itemId: string): string {
	const id = String(itemId || "").trim().toUpperCase();
	if (!id) throw new Error("Missing debug item id.");
	if (!/^DBG-\d+$/.test(id)) throw new Error(`Invalid debug item id: ${itemId}`);
	const { itemsPath } = debugPaths(cwd);
	if (!fs.existsSync(itemsPath)) throw new Error(`Debug lane item not found: ${id}`);
	const match = fs.readdirSync(itemsPath).find((file) => file.startsWith(`${id}-`) && file.endsWith(".md"));
	if (!match) throw new Error(`Debug lane item not found: ${id}`);
	return path.join(itemsPath, match);
}

function appendToLog(cwd: string, message: string): void {
	const { logPath } = ensureLane(cwd);
	appendLaneLogLine(logPath, `- ${nowIso()} ${message}\n`);
}

export function ensureDebugLane(cwd: string): { lanePath: string; itemsPath: string; logPath: string } {
	const { lanePath, itemsPath, logPath } = ensureLane(cwd);
	return { lanePath, itemsPath, logPath };
}

export function readDebugLaneSummary(cwd: string, limit = 5): DebugLaneSummary {
	const { lanePath, itemsPath } = debugPaths(cwd);
	if (!fs.existsSync(lanePath)) {
		return {
			path: lanePath,
			exists: false,
			openCount: 0,
			doneCount: 0,
			promotedCount: 0,
			latest: [],
		};
	}
	if (!fs.existsSync(itemsPath)) {
		return {
			path: lanePath,
			exists: true,
			openCount: 0,
			doneCount: 0,
			promotedCount: 0,
			latest: [],
		};
	}
	const files = fs
		.readdirSync(itemsPath)
		.filter((file) => /^DBG-\d+-.+\.md$/.test(file))
		.sort((a, b) => a.localeCompare(b));
	const items: DebugItem[] = [];
	for (const file of files) {
		try {
			const parsed = readDebugItem(path.join(itemsPath, file));
			items.push(parsed);
		} catch {
			continue;
		}
	}
	items.sort((a, b) => {
		const aAt = a.updatedAt || a.createdAt;
		const bAt = b.updatedAt || b.createdAt;
		if (aAt !== bAt) return bAt.localeCompare(aAt);
		const aNum = Number(a.id.slice(4));
		const bNum = Number(b.id.slice(4));
		if (aNum !== bNum) return bNum - aNum;
		return path.basename(a.filePath).localeCompare(path.basename(b.filePath));
	});
	const summary: DebugLaneSummary = {
		path: lanePath,
		exists: true,
		openCount: 0,
		doneCount: 0,
		promotedCount: 0,
		latest: [],
	};
	for (const item of items) {
		if (item.status === "open") summary.openCount += 1;
		if (item.status === "done") summary.doneCount += 1;
		if (item.status === "promoted") summary.promotedCount += 1;
	}
	const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 5;
	summary.latest = items.slice(0, safeLimit);
	return summary;
}

function buildBody(summary: string, notes: string[]): string {
	let body = `## Summary\n${summary}\n\n## Notes\n`;
	if (notes.length) {
		for (const note of notes) {
			body = appendNotes(body, note);
		}
	}
	return body;
}

export function createDebugItem(cwd: string, title: string, note?: string): DebugItem {
	const cleanTitle = validateDebugTitle(title);
	const { itemsPath } = ensureLane(cwd);
	const id = nextItemId(itemsPath);
	const filePath = path.join(itemsPath, `${id}-${safeSlug(cleanTitle)}.md`);
	const now = nowIso();
	const frontmatter: Record<string, unknown> = {
		id,
		title: cleanTitle,
		status: "open",
		createdAt: now,
		updatedAt: now,
	};
	const notes = note ? [`${now} ${note}`] : [];
	const body = buildBody(cleanTitle, notes);
	writeDebugItem(filePath, frontmatter, body);
	appendToLog(cwd, `debug item created ${id}`);
	return readDebugItem(filePath);
}

export function appendDebugNote(cwd: string, itemId: string, note: string): DebugItem {
	const cleanNote = String(note || "").trim();
	if (!cleanNote) throw new Error("Missing debug note.");
	const filePath = resolveItemPath(cwd, itemId);
	const current = readDebugItemWithBody(filePath);
	if (current.status === "promoted") throw new Error(`Cannot add notes to promoted item: ${current.id}`);
	const now = nowIso();
	const frontmatter: Record<string, unknown> = {
		id: current.id,
		title: current.title,
		status: current.status,
		createdAt: current.createdAt,
		updatedAt: now,
		promotedTaskId: current.promotedTaskId,
		promotedTaskPath: current.promotedTaskPath,
	};
	if (current.completedAt) frontmatter.completedAt = current.completedAt;
	const body = appendNotes(noteLinesBody(current.body).join("\n"), `${now} ${cleanNote}`);
	writeDebugItem(filePath, frontmatter, body);
	appendToLog(cwd, `debug note appended to ${current.id}`);
	return readDebugItem(filePath);
}

export function completeDebugItem(cwd: string, itemId: string, evidence?: string): DebugItem {
	const filePath = resolveItemPath(cwd, itemId);
	const current = readDebugItemWithBody(filePath);
	if (current.status === "promoted") throw new Error(`Cannot complete promoted item: ${current.id}`);
	const now = nowIso();
	const frontmatter: Record<string, unknown> = {
		id: current.id,
		title: current.title,
		status: "done",
		createdAt: current.createdAt,
		updatedAt: now,
		completedAt: now,
		promotedTaskId: current.promotedTaskId,
		promotedTaskPath: current.promotedTaskPath,
	};
	let body = noteLinesBody(current.body).join("\n");
	if (evidence && String(evidence).trim()) body = appendNotes(body, `${now} evidence: ${String(evidence).trim()}`);
	writeDebugItem(filePath, frontmatter, body);
	appendToLog(cwd, `debug item completed ${current.id}`);
	return readDebugItem(filePath);
}

export function promoteDebugItem(
	cwd: string,
	itemId: string,
	options?: DebugPromotionOptions,
): { item: DebugItem; task: { id: string; filePath: string } } {
	const filePath = resolveItemPath(cwd, itemId);
	const current = readDebugItemWithBody(filePath);
	if (current.status === "promoted") throw new Error(`Debug item already promoted: ${current.id}`);
	const taskTitle = options?.title ? validateDebugTitle(options.title, "promote title") : `Debug: ${current.title}`;
	const promotionNote = options?.note?.trim() || `Promoted from debug lane item ${current.id} for full-task treatment.`;
	const task = createTask(cwd, taskTitle, {
		humanSummary: `Promoted from debug lane item ${current.id}`,
		aiContext: promotionNote,
	});
	const appendix = buildDebugPromotionAppendix({
		itemId: current.id,
		itemTitle: current.title,
		itemStatus: current.status,
		itemBody: noteLinesBody(current.body).join("\n"),
		featureArea: options?.escalation?.featureArea,
		promotionNote,
		escalation: options?.escalation,
	});
	const taskFile = parseTaskFile(task.filePath);
	taskFile.body = `${taskFile.body.trimEnd()}\n\n${appendix.contextSection}\n\n${appendix.acceptanceSection}\n`;
	writeTaskFile(task.filePath, taskFile.frontmatter, taskFile.body);
	const now = nowIso();
	const frontmatter: Record<string, unknown> = {
		id: current.id,
		title: current.title,
		status: "promoted",
		createdAt: current.createdAt,
		updatedAt: now,
		promotedTaskId: task.id,
		promotedTaskPath: path.relative(cwd, task.filePath),
	};
	if (current.completedAt) frontmatter.completedAt = current.completedAt;
	const body = appendNotes(noteLinesBody(current.body).join("\n"), `${now} promoted to ${task.id}`);
	writeDebugItem(filePath, frontmatter, body);
	appendToLog(cwd, `debug item promoted ${current.id} -> ${task.id}`);
	return { item: readDebugItem(filePath), task };
}
