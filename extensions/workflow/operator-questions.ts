// WP1 — operator escalation channel: a durable question queue under
// `.pi/workflow-runs/<room|run>/questions.jsonl`.
//
// The queue is append-only JSONL: every line is a self-contained
// OperatorQuestion record; answering appends a NEW line with the same `id`
// and the answer fields filled, and the reader merges by id (last parsable
// line wins). Appending line-by-line is deliberate — the reader tolerates a
// truncated tail line (a torn append is skipped, never a crash), so no
// read-modify-write lock is needed for asks from concurrent delegates.
//
// Ownership: this module owns the file format, the env-var name used for
// delegate child registration, and the cwd-wide open-blocking scan consumed
// by the finalization gate. Tool registration lives in
// `operator-question-tools.ts`; ship/planning integrations read through the
// helpers here.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getWorkflowRunsRoot, sanitizeRoomId } from "./rooms";

export const OPERATOR_QUESTIONS_FILE_NAME = "questions.jsonl";
/** Absolute questions.jsonl path exported to delegate children (the parent
 *  sets it in buildChildEnv, like the done-tools env var). When set, only
 *  the child ask tool is registered. */
export const OPERATOR_QUESTIONS_FILE_ENV_VAR = "PI_WORKFLOW_QUESTIONS_FILE";
/** Fallback scope when no planning/workflow room is resolvable: questions
 *  land in `.pi/workflow-runs/operator/questions.jsonl`. */
export const DEFAULT_OPERATOR_QUESTIONS_ROOM_ID = "operator";
/** Bound for the cwd-wide questions scan (dirs inspected per level). */
const MAX_QUESTION_DIR_SCAN = 500;

export interface OperatorQuestion {
	id: string;
	at: string;
	from: string;
	question: string;
	options?: string[];
	recommendedDefault?: string;
	blocking: boolean;
	answeredAt?: string;
	answer?: string;
	answeredBy?: string;
}

export interface AskOperatorQuestionInput {
	question: string;
	from: string;
	blocking: boolean;
	options?: string[];
	recommendedDefault?: string;
	/** Explicit id override (tests / idempotent retries). */
	id?: string;
}

export function operatorQuestionsPathForRoom(cwd: string, roomId: string): string {
	return path.join(getWorkflowRunsRoot(cwd), sanitizeRoomId(roomId), OPERATOR_QUESTIONS_FILE_NAME);
}

export function newOperatorQuestionId(): string {
	return `q-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

const trim = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function parseQuestionLine(line: string): OperatorQuestion | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const id = trim(record.id);
	const question = trim(record.question);
	if (!id || !question) return null;
	const out: OperatorQuestion = {
		id,
		at: trim(record.at) || new Date().toISOString(),
		from: trim(record.from) || "unknown",
		question,
		blocking: record.blocking === true,
	};
	if (Array.isArray(record.options)) {
		const options = record.options.map(trim).filter((o) => o.length > 0);
		if (options.length > 0) out.options = options;
	}
	const recommendedDefault = trim(record.recommendedDefault);
	if (recommendedDefault) out.recommendedDefault = recommendedDefault;
	const answer = trim(record.answer);
	const answeredAt = trim(record.answeredAt);
	if (answer || answeredAt) {
		out.answer = answer || undefined;
		out.answeredAt = answeredAt || new Date().toISOString();
		const answeredBy = trim(record.answeredBy);
		if (answeredBy) out.answeredBy = answeredBy;
	}
	return out;
}

/** Read and merge the queue: one record per id, last parsable line wins.
 *  A missing file is an empty queue; an unparsable (torn) line is skipped. */
export function readOperatorQuestionsFromFile(file: string): OperatorQuestion[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const byId = new Map<string, OperatorQuestion>();
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const record = parseQuestionLine(line);
		if (!record) continue;
		const existing = byId.get(record.id);
		if (existing) {
			// Preserve the original ask metadata when an answer line re-emits
			// the record; later fields win for everything that is set.
			byId.delete(record.id);
			byId.set(record.id, { ...existing, ...record });
		} else {
			byId.set(record.id, record);
		}
	}
	return [...byId.values()];
}

function appendLine(file: string, record: OperatorQuestion): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// Self-heal after a torn tail: if a previous append was cut off before its
	// trailing newline, start a fresh line so the new record stays parsable
	// instead of gluing onto the truncated fragment.
	let needsLeadingNewline = false;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const stat = fs.fstatSync(fd);
			if (stat.size > 0) {
				const tail = Buffer.alloc(1);
				fs.readSync(fd, tail, 0, 1, stat.size - 1);
				needsLeadingNewline = tail[0] !== 0x0a;
			}
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// missing file: plain append below creates it
	}
	fs.appendFileSync(file, `${needsLeadingNewline ? "\n" : ""}${JSON.stringify(record)}\n`, "utf8");
}

export function appendOperatorQuestionToFile(file: string, input: AskOperatorQuestionInput): OperatorQuestion {
	const question = trim(input.question);
	if (!question) throw new Error("operator question text must not be empty.");
	const record: OperatorQuestion = {
		id: trim(input.id) || newOperatorQuestionId(),
		at: new Date().toISOString(),
		from: trim(input.from) || "unknown",
		question,
		blocking: input.blocking === true,
	};
	const options = (input.options ?? []).map(trim).filter((o) => o.length > 0);
	if (options.length > 0) record.options = options;
	const recommendedDefault = trim(input.recommendedDefault);
	if (recommendedDefault) record.recommendedDefault = recommendedDefault;
	appendLine(file, record);
	return record;
}

export function answerOperatorQuestionInFile(
	file: string,
	id: string,
	answer: string,
	answeredBy?: string,
): OperatorQuestion {
	const targetId = trim(id);
	const answerText = trim(answer);
	if (!targetId) throw new Error("operator question id is required to record an answer.");
	if (!answerText) throw new Error("operator question answer must not be empty.");
	const existing = readOperatorQuestionsFromFile(file).find((q) => q.id === targetId);
	if (!existing) {
		throw new Error(`operator question ${targetId} not found in ${file}.`);
	}
	if (existing.answeredAt) {
		throw new Error(`operator question ${targetId} is already answered (at ${existing.answeredAt}); ask a new question instead of overwriting the answer.`);
	}
	const answered: OperatorQuestion = {
		...existing,
		answer: answerText,
		answeredAt: new Date().toISOString(),
		...(trim(answeredBy) ? { answeredBy: trim(answeredBy) } : {}),
	};
	appendLine(file, answered);
	return answered;
}

export function listOpenBlockingQuestionsInFile(file: string): OperatorQuestion[] {
	return readOperatorQuestionsFromFile(file).filter((q) => q.blocking && !q.answeredAt);
}

export interface ScopedOperatorQuestion extends OperatorQuestion {
	/** Path of the questions file relative to the workflow-runs root. */
	scope: string;
	/** Absolute questions.jsonl path (for answering from gate error text). */
	file: string;
}

/** Cwd-wide open-blocking scan: any unanswered blocking question anywhere
 *  under `.pi/workflow-runs/` (rooms at one level, nested run dirs such as
 *  `afk-ship/<runId>/` at two levels) is a durable stop signal consumed by
 *  the finalization gate. The scan is bounded per directory level. */
export function listOpenBlockingQuestionsForCwd(cwd: string): ScopedOperatorQuestion[] {
	const root = getWorkflowRunsRoot(cwd);
	const files: string[] = [];
	const collectDir = (dir: string, depthLeft: number): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		let scanned = 0;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (scanned >= MAX_QUESTION_DIR_SCAN) break;
			scanned += 1;
			const child = path.join(dir, entry.name);
			const candidate = path.join(child, OPERATOR_QUESTIONS_FILE_NAME);
			if (fs.existsSync(candidate)) files.push(candidate);
			if (depthLeft > 0) collectDir(child, depthLeft - 1);
		}
	};
	collectDir(root, 1);
	const out: ScopedOperatorQuestion[] = [];
	for (const file of files) {
		const scope = path.relative(root, path.dirname(file)).split(path.sep).join("/");
		for (const question of listOpenBlockingQuestionsInFile(file)) {
			out.push({ ...question, scope, file });
		}
	}
	return out;
}
