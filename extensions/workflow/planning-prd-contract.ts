// WP3 — structured PRD contract (types + normalize + validate, in the style
// of architecture/evidence-matrix.ts), modeled on
// agent-harness/contracts/requirement.schema.json.
//
// The contract lives as `prd.json` next to PRD.md in the planning room and
// is the machine-readable half of the PRD: expected behaviors (B*), edge
// cases (E*), forbidden behaviors (X*), assumptions (A*, each covering a
// question), and open questions (Q*, blocking or not). JSON keys stay
// snake_case to mirror the reference schema byte-for-byte concepts.
//
// Readiness is COMPUTED, never asserted: `computePrdReadiness` requires
// every blocking Q* to be answered (inline `answer` or an answered WP1
// operator-queue record with the same id) and every A*.covers_question to
// reference a CLOSED Q*. `workflow_planning_state` refuses to record
// prd_ready_for_sprint until this computation passes (fail-closed: missing
// or invalid prd.json blocks with an actionable error).
//
// Traceability: acceptance-evidence-matrix rows may carry `criterionId`
// (AC*) and `covers` (B*/X* ids); `validateMatrixCoversForbiddenBehavior`
// requires every X* to be covered by at least one row marked
// `negative: true` (chosen over a new criterionKind for the smaller radius:
// an optional additive field instead of widening a closed set every
// criterionKind consumer switches on).

import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "./fs-atomic";
import { planningStatePathsFor } from "./planning-state";
import { readPlanningCurrentRoomPointer } from "./planning-pointer";
import type { AcceptanceEvidenceMatrixEntry } from "./architecture/types";
import type { OperatorQuestion } from "./operator-questions";

export const PRD_CONTRACT_FILE_NAME = "prd.json";

export const PRD_ID_PATTERNS = {
	expected_behavior: /^B[0-9]+$/,
	edge_cases: /^E[0-9]+$/,
	forbidden_behavior: /^X[0-9]+$/,
	assumptions: /^A[0-9]+$/,
	open_questions: /^Q[0-9]+$/,
} as const;
/** Matrix `covers` entries reference expected (B*) or forbidden (X*) ids. */
export const PRD_COVERS_ID_PATTERN = /^[BX][0-9]+$/;
/** Matrix `criterionId` pattern (AC*). */
export const PRD_CRITERION_ID_PATTERN = /^AC[0-9]+$/;

export interface PrdContractItem {
	id: string;
	description: string;
}

export interface PrdAssumption extends PrdContractItem {
	/** Q* id this assumption stands in for; must reference a CLOSED question. */
	covers_question?: string;
}

export interface PrdOpenQuestion {
	id: string;
	question: string;
	blocking: boolean;
	/** Inline answer; the WP1 operator queue (record with the same id) is the
	 *  other accepted closure channel. */
	answer?: string;
	answeredAt?: string;
}

export interface PrdContract {
	summary: string;
	actor?: string;
	trigger?: string;
	expected_behavior: PrdContractItem[];
	edge_cases: PrdContractItem[];
	forbidden_behavior: PrdContractItem[];
	assumptions: PrdAssumption[];
	open_questions: PrdOpenQuestion[];
	success_path?: string[];
	failure_path?: string[];
}

export type PrdContractIssueCode =
	| "contract_missing" | "contract_unreadable" | "contract_invalid_shape"
	| "summary_missing" | "expected_behavior_missing"
	| "id_pattern_invalid" | "id_duplicate" | "description_missing" | "question_missing"
	| "assumption_question_unknown" | "assumption_question_open"
	| "blocking_question_open"
	| "forbidden_behavior_uncovered" | "covers_unknown_id";

export interface PrdContractIssue {
	code: PrdContractIssueCode;
	message: string;
	id?: string;
}

export interface NormalizePrdContractResult {
	value: PrdContract | undefined;
	issues: PrdContractIssue[];
}

const trim = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function pushIssue(issues: PrdContractIssue[], code: PrdContractIssueCode, message: string, id?: string): void {
	issues.push(id ? { code, message, id } : { code, message });
}

function normalizeStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.map(trim).filter((s) => s.length > 0);
	return out.length > 0 ? out : undefined;
}

function normalizeItemList(
	value: unknown,
	section: keyof typeof PRD_ID_PATTERNS,
	issues: PrdContractIssue[],
	seenIds: Set<string>,
): PrdContractItem[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		pushIssue(issues, "contract_invalid_shape", `${section} must be an array.`);
		return [];
	}
	const out: PrdContractItem[] = [];
	const pattern = PRD_ID_PATTERNS[section];
	value.forEach((raw, index) => {
		if (!isObject(raw)) {
			pushIssue(issues, "contract_invalid_shape", `${section}[${index}] must be an object.`);
			return;
		}
		const id = trim(raw.id);
		if (!pattern.test(id)) {
			pushIssue(issues, "id_pattern_invalid", `${section}[${index}].id ${JSON.stringify(id)} does not match ${pattern}.`, id || undefined);
			return;
		}
		if (seenIds.has(id)) {
			pushIssue(issues, "id_duplicate", `Duplicate PRD contract id: ${id}.`, id);
			return;
		}
		seenIds.add(id);
		const description = trim(raw.description);
		if (!description) {
			pushIssue(issues, "description_missing", `${section} ${id} requires a non-empty description.`, id);
			return;
		}
		out.push({ id, description });
	});
	return out;
}

export function normalizePrdContract(input: unknown): NormalizePrdContractResult {
	const issues: PrdContractIssue[] = [];
	if (!isObject(input)) {
		pushIssue(issues, "contract_invalid_shape", "prd.json root must be a JSON object.");
		return { value: undefined, issues };
	}
	// Accept either the bare contract or the harness-style
	// { business_requirement: {...} } envelope.
	const root = isObject(input.business_requirement) ? input.business_requirement : input;
	const summary = trim(root.summary);
	if (!summary) pushIssue(issues, "summary_missing", "PRD contract requires a non-empty summary.");
	const seenIds = new Set<string>();
	const expected_behavior = normalizeItemList(root.expected_behavior, "expected_behavior", issues, seenIds);
	if (expected_behavior.length === 0) {
		pushIssue(issues, "expected_behavior_missing", "PRD contract requires at least one expected_behavior (B*) entry.");
	}
	const edge_cases = normalizeItemList(root.edge_cases, "edge_cases", issues, seenIds);
	const forbidden_behavior = normalizeItemList(root.forbidden_behavior, "forbidden_behavior", issues, seenIds);

	const assumptions: PrdAssumption[] = [];
	if (root.assumptions !== undefined && root.assumptions !== null) {
		if (!Array.isArray(root.assumptions)) {
			pushIssue(issues, "contract_invalid_shape", "assumptions must be an array.");
		} else {
			root.assumptions.forEach((raw, index) => {
				if (!isObject(raw)) {
					pushIssue(issues, "contract_invalid_shape", `assumptions[${index}] must be an object.`);
					return;
				}
				const id = trim(raw.id);
				if (!PRD_ID_PATTERNS.assumptions.test(id)) {
					pushIssue(issues, "id_pattern_invalid", `assumptions[${index}].id ${JSON.stringify(id)} does not match ${PRD_ID_PATTERNS.assumptions}.`, id || undefined);
					return;
				}
				if (seenIds.has(id)) {
					pushIssue(issues, "id_duplicate", `Duplicate PRD contract id: ${id}.`, id);
					return;
				}
				seenIds.add(id);
				const description = trim(raw.description);
				if (!description) {
					pushIssue(issues, "description_missing", `assumptions ${id} requires a non-empty description.`, id);
					return;
				}
				const entry: PrdAssumption = { id, description };
				const covers = trim(raw.covers_question ?? raw.coversQuestion);
				if (covers) {
					if (!PRD_ID_PATTERNS.open_questions.test(covers)) {
						pushIssue(issues, "id_pattern_invalid", `assumptions ${id}.covers_question ${JSON.stringify(covers)} does not match ${PRD_ID_PATTERNS.open_questions}.`, id);
						return;
					}
					entry.covers_question = covers;
				}
				assumptions.push(entry);
			});
		}
	}

	const open_questions: PrdOpenQuestion[] = [];
	if (root.open_questions !== undefined && root.open_questions !== null) {
		if (!Array.isArray(root.open_questions)) {
			pushIssue(issues, "contract_invalid_shape", "open_questions must be an array.");
		} else {
			root.open_questions.forEach((raw, index) => {
				if (!isObject(raw)) {
					pushIssue(issues, "contract_invalid_shape", `open_questions[${index}] must be an object.`);
					return;
				}
				const id = trim(raw.id);
				if (!PRD_ID_PATTERNS.open_questions.test(id)) {
					pushIssue(issues, "id_pattern_invalid", `open_questions[${index}].id ${JSON.stringify(id)} does not match ${PRD_ID_PATTERNS.open_questions}.`, id || undefined);
					return;
				}
				if (seenIds.has(id)) {
					pushIssue(issues, "id_duplicate", `Duplicate PRD contract id: ${id}.`, id);
					return;
				}
				seenIds.add(id);
				const question = trim(raw.question);
				if (!question) {
					pushIssue(issues, "question_missing", `open_questions ${id} requires a non-empty question.`, id);
					return;
				}
				if (typeof raw.blocking !== "boolean") {
					pushIssue(issues, "contract_invalid_shape", `open_questions ${id} requires an explicit boolean blocking flag.`, id);
					return;
				}
				const entry: PrdOpenQuestion = { id, question, blocking: raw.blocking };
				const answer = trim(raw.answer);
				if (answer) {
					entry.answer = answer;
					entry.answeredAt = trim(raw.answeredAt) || new Date().toISOString();
				}
				open_questions.push(entry);
			});
		}
	}

	// Cross-references are structural: an A* covering an unknown Q* is invalid
	// regardless of answer state (the open/closed distinction is readiness).
	const questionIds = new Set(open_questions.map((q) => q.id));
	for (const assumption of assumptions) {
		if (assumption.covers_question && !questionIds.has(assumption.covers_question)) {
			pushIssue(issues, "assumption_question_unknown", `Assumption ${assumption.id} covers unknown question ${assumption.covers_question}.`, assumption.id);
		}
	}

	if (issues.length > 0) return { value: undefined, issues };
	const value: PrdContract = { summary, expected_behavior, edge_cases, forbidden_behavior, assumptions, open_questions };
	const actor = trim(root.actor);
	if (actor) value.actor = actor;
	const trigger = trim(root.trigger);
	if (trigger) value.trigger = trigger;
	const success_path = normalizeStringList(root.success_path);
	if (success_path) value.success_path = success_path;
	const failure_path = normalizeStringList(root.failure_path);
	if (failure_path) value.failure_path = failure_path;
	return { value, issues };
}

// ---------- Readiness (computed, WP1-integrated) ----------

export interface PrdReadinessResult {
	ready: boolean;
	issues: PrdContractIssue[];
	openBlockingQuestionIds: string[];
	unresolvedAssumptionIds: string[];
}

function questionIsClosed(question: PrdOpenQuestion, operatorAnswers: ReadonlySet<string>): boolean {
	if (question.answer && question.answer.trim()) return true;
	return operatorAnswers.has(question.id);
}

/** Compute ready_for_sprint: every blocking Q* answered (inline or via an
 *  answered WP1 operator-queue record with the same id) and every
 *  A*.covers_question referencing a closed Q*. */
export function computePrdReadiness(
	contract: PrdContract,
	operatorQuestions: readonly OperatorQuestion[] = [],
): PrdReadinessResult {
	const issues: PrdContractIssue[] = [];
	const operatorAnswers = new Set(
		operatorQuestions.filter((q) => q.answeredAt && q.answer).map((q) => q.id),
	);
	const questionsById = new Map(contract.open_questions.map((q) => [q.id, q]));
	const openBlockingQuestionIds: string[] = [];
	for (const question of contract.open_questions) {
		if (!question.blocking) continue;
		if (questionIsClosed(question, operatorAnswers)) continue;
		openBlockingQuestionIds.push(question.id);
		pushIssue(issues, "blocking_question_open", `Blocking question ${question.id} is unanswered: ${question.question}. Answer it via workflow_answer_question (queue id ${question.id}) or record the answer in prd.json.`, question.id);
	}
	const unresolvedAssumptionIds: string[] = [];
	for (const assumption of contract.assumptions) {
		if (!assumption.covers_question) continue;
		const target = questionsById.get(assumption.covers_question);
		if (!target) {
			// normalize already rejects this shape; kept for pre-normalized callers
			unresolvedAssumptionIds.push(assumption.id);
			pushIssue(issues, "assumption_question_unknown", `Assumption ${assumption.id} covers unknown question ${assumption.covers_question}.`, assumption.id);
			continue;
		}
		if (!questionIsClosed(target, operatorAnswers)) {
			unresolvedAssumptionIds.push(assumption.id);
			pushIssue(issues, "assumption_question_open", `Assumption ${assumption.id} covers question ${target.id}, which is still open; an assumption may only stand in for a CLOSED question.`, assumption.id);
		}
	}
	return { ready: issues.length === 0, issues, openBlockingQuestionIds, unresolvedAssumptionIds };
}

// ---------- Matrix traceability (X* -> negative rows) ----------

/** Every forbidden behavior (X*) must be covered by at least one matrix row
 *  that is marked `negative: true` and lists the X* id in `covers`. Also
 *  rejects `covers` entries referencing ids the contract does not declare. */
export function validateMatrixCoversForbiddenBehavior(
	matrix: readonly AcceptanceEvidenceMatrixEntry[],
	contract: PrdContract,
): PrdContractIssue[] {
	const issues: PrdContractIssue[] = [];
	const knownIds = new Set<string>([
		...contract.expected_behavior.map((b) => b.id),
		...contract.forbidden_behavior.map((x) => x.id),
	]);
	const negativeCovered = new Set<string>();
	for (const entry of matrix) {
		for (const covered of entry.covers ?? []) {
			if (!knownIds.has(covered)) {
				pushIssue(issues, "covers_unknown_id", `Matrix row ${entry.criterionId ?? entry.criterion} covers unknown PRD id ${covered}.`, covered);
				continue;
			}
			if (entry.negative === true) negativeCovered.add(covered);
		}
	}
	for (const forbidden of contract.forbidden_behavior) {
		if (negativeCovered.has(forbidden.id)) continue;
		pushIssue(issues, "forbidden_behavior_uncovered", `Forbidden behavior ${forbidden.id} (${forbidden.description}) is not covered by any negative matrix row; add a row with negative: true and covers: ["${forbidden.id}"].`, forbidden.id);
	}
	return issues;
}

// ---------- File IO ----------

export function prdContractPathFor(cwd: string, roomId: string): string {
	const paths = planningStatePathsFor(cwd, roomId);
	return path.join(paths.roomDir, PRD_CONTRACT_FILE_NAME);
}

export interface ReadPrdContractResult {
	contract: PrdContract | undefined;
	exists: boolean;
	issues: PrdContractIssue[];
	file: string;
}

export function readPrdContractFile(cwd: string, roomId: string): ReadPrdContractResult {
	const file = prdContractPathFor(cwd, roomId);
	if (!fs.existsSync(file)) {
		return { contract: undefined, exists: false, file, issues: [{ code: "contract_missing", message: `prd.json is missing at ${path.relative(cwd, file)}; write it via workflow_planning_artifacts action=write_prd_contract.` }] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		return { contract: undefined, exists: true, file, issues: [{ code: "contract_unreadable", message: `prd.json at ${path.relative(cwd, file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.` }] };
	}
	const normalized = normalizePrdContract(raw);
	return { contract: normalized.value, exists: true, file, issues: normalized.issues };
}

export function writePrdContractFile(cwd: string, roomId: string, contract: PrdContract): string {
	const file = prdContractPathFor(cwd, roomId);
	writeFileAtomicSync(file, `${JSON.stringify(contract, null, 2)}\n`);
	return file;
}

export function formatPrdContractIssues(issues: readonly PrdContractIssue[]): string {
	if (issues.length === 0) return "";
	return issues.map((issue) => `[${issue.code}] ${issue.message}${issue.id ? ` (id=${issue.id})` : ""}`).join("; ");
}

// ---------- Ready-plan wiring (consumed by architecture/store.ts) ----------

export interface ReadyPlanPrdCoverageResult {
	/** False when no active planning room / no prd.json is resolvable — the
	 *  prd_ready_for_sprint gate owns contract existence, so plan recording
	 *  does not re-enforce it; it only enforces coverage when a contract IS
	 *  present. */
	checked: boolean;
	roomId?: string;
	issues: PrdContractIssue[];
}

/** For a plan transitioning to (or staying) ready: when the active planning
 *  room carries a prd.json, every X* must be covered by a negative matrix
 *  row. An unreadable/invalid contract fails closed (issues returned). */
export function validateReadyPlanAgainstActivePrdContract(
	cwd: string,
	matrix: readonly AcceptanceEvidenceMatrixEntry[],
): ReadyPlanPrdCoverageResult {
	const roomId = readPlanningCurrentRoomPointer(cwd);
	if (!roomId) return { checked: false, issues: [] };
	let contractRead: ReadPrdContractResult;
	try {
		contractRead = readPrdContractFile(cwd, roomId);
	} catch {
		// invalid room id in the pointer — nothing to enforce here
		return { checked: false, issues: [] };
	}
	if (!contractRead.exists) return { checked: false, roomId, issues: [] };
	if (!contractRead.contract) return { checked: true, roomId, issues: contractRead.issues };
	if (contractRead.contract.forbidden_behavior.length === 0) return { checked: true, roomId, issues: [] };
	return { checked: true, roomId, issues: validateMatrixCoversForbiddenBehavior(matrix, contractRead.contract) };
}
