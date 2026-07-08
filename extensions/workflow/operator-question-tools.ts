// WP1 — AI-facing tools for the operator escalation channel
// (`extensions/workflow/operator-questions.ts` owns the durable queue).
//
// Parent session (Brain): `workflow_ask_operator`, `workflow_answer_question`,
// and the read-only `workflow_operator_questions` list. The queue scope is
// resolved from an explicit roomId param, the active planning-room pointer,
// the active workflow-room pointer, or the default `operator` room.
//
// Delegate child sessions: like the done-tools, the parent exports
// `PI_WORKFLOW_QUESTIONS_FILE` (absolute questions.jsonl path) before
// launching a delegate; when that env var is present, ONLY the ask tool is
// registered and it appends directly to the exported file — a delegate can
// escalate but never answers its own questions.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	appendOperatorQuestionToFile,
	answerOperatorQuestionInFile,
	listOpenBlockingQuestionsInFile,
	operatorQuestionsPathForRoom,
	readOperatorQuestionsFromFile,
	DEFAULT_OPERATOR_QUESTIONS_ROOM_ID,
	OPERATOR_QUESTIONS_FILE_ENV_VAR,
	type OperatorQuestion,
} from "./operator-questions";
import { readPlanningCurrentRoomPointer, readWorkflowCurrentRoomPointer } from "./planning-pointer";
import { ROOM_ENV_AGENT_ID, ROOM_ENV_AGENT_ROLE, sanitizeRoomId } from "./rooms";

function okText(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function errText(text: string, details: Record<string, unknown> = {}) {
	return { isError: true, content: [{ type: "text" as const, text }], details };
}

function trim(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

interface ResolvedQuestionScope {
	roomId: string;
	file: string;
	source: "params" | "planningPointer" | "workflowPointer" | "default";
}

function resolveQuestionScope(cwd: string, explicitRoomId: unknown): ResolvedQuestionScope {
	const fromParams = trim(explicitRoomId);
	if (fromParams) {
		const roomId = sanitizeRoomId(fromParams);
		return { roomId, file: operatorQuestionsPathForRoom(cwd, roomId), source: "params" };
	}
	const planningRoom = readPlanningCurrentRoomPointer(cwd);
	if (planningRoom) {
		const roomId = sanitizeRoomId(planningRoom);
		return { roomId, file: operatorQuestionsPathForRoom(cwd, roomId), source: "planningPointer" };
	}
	const workflowRoom = readWorkflowCurrentRoomPointer(cwd);
	if (workflowRoom) {
		const roomId = sanitizeRoomId(workflowRoom);
		return { roomId, file: operatorQuestionsPathForRoom(cwd, roomId), source: "workflowPointer" };
	}
	return {
		roomId: DEFAULT_OPERATOR_QUESTIONS_ROOM_ID,
		file: operatorQuestionsPathForRoom(cwd, DEFAULT_OPERATOR_QUESTIONS_ROOM_ID),
		source: "default",
	};
}

function formatQuestionLine(question: OperatorQuestion): string {
	const status = question.answeredAt ? `answered ${question.answeredAt}` : question.blocking ? "OPEN blocking" : "open";
	const options = question.options?.length ? ` options=[${question.options.join(" | ")}]` : "";
	const recommended = question.recommendedDefault ? ` recommended=${question.recommendedDefault}` : "";
	const answer = question.answer ? `\n  answer: ${question.answer}` : "";
	return `- [${status}] ${question.id} (from ${question.from}): ${question.question}${options}${recommended}${answer}`;
}

const ASK_PARAMETERS = Type.Object({
	question: Type.String({ minLength: 1, description: "The question for the operator. Be specific; include the context needed to answer without re-reading the whole task." }),
	blocking: Type.Optional(Type.Boolean({ description: "true (default) when work cannot safely proceed without the answer. Blocking questions gate prd_ready_for_sprint, finalization, and AFK delivery_complete until answered." })),
	options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional closed answer options." })),
	recommendedDefault: Type.Optional(Type.String({ description: "The answer you would pick if the operator stays silent; always include one when options are given." })),
	from: Type.Optional(Type.String({ description: "Actor asking the question; defaults to 'brain' (parent) or the delegate agent id (child)." })),
});

function registerChildAskTool(pi: ExtensionAPI, questionsFile: string): void {
	pi.registerTool({
		name: "workflow_ask_operator",
		label: "Ask Operator",
		description: "Record a durable question for the human operator in the parent workflow's question queue. Blocking questions stop finalization/delivery until answered by the operator (or Brain) via workflow_answer_question.",
		promptSnippet: "Escalate a blocking uncertainty to the human operator.",
		promptGuidelines: [
			"Use workflow_ask_operator when an ambiguity, unsafe assumption, or missing decision blocks your delegated task and Brain's task text does not resolve it.",
			"Set blocking=true only when you cannot safely proceed; include options and a recommendedDefault so the operator can answer quickly.",
			"After asking a blocking question, finish your current task honestly (report the open question as a known gap) — do not guess.",
		],
		parameters: ASK_PARAMETERS,
		execute: async (_id: string, params: any) => {
			const from = trim(params?.from)
				|| trim(process.env[ROOM_ENV_AGENT_ID])
				|| trim(process.env[ROOM_ENV_AGENT_ROLE])
				|| "delegate";
			try {
				const record = appendOperatorQuestionToFile(questionsFile, {
					question: trim(params?.question),
					blocking: params?.blocking !== false,
					options: Array.isArray(params?.options) ? params.options : undefined,
					recommendedDefault: trim(params?.recommendedDefault) || undefined,
					from,
				});
				return okText(
					`Recorded ${record.blocking ? "blocking " : ""}operator question ${record.id}. The operator answers via workflow_answer_question in the parent session.`,
					{ question: record, file: questionsFile },
				);
			} catch (error) {
				return errText(error instanceof Error ? error.message : String(error), { file: questionsFile });
			}
		},
	});
}

const SCOPE_PARAM = Type.Optional(Type.String({ description: "Question-queue room id. Defaults to the active planning room, then the active workflow room, then the shared 'operator' room." }));

export function registerOperatorQuestionTools(pi: ExtensionAPI): void {
	const childFile = trim(process.env[OPERATOR_QUESTIONS_FILE_ENV_VAR]);
	if (childFile) {
		registerChildAskTool(pi, childFile);
		return;
	}

	pi.registerTool({
		name: "workflow_ask_operator",
		label: "Ask Operator",
		description: "Record a durable question for the human operator under `.pi/workflow-runs/<room>/questions.jsonl`. An unanswered blocking question blocks prd_ready_for_sprint, task finalization, and AFK ship delivery_complete until answered via workflow_answer_question.",
		promptSnippet: "Escalate a blocking uncertainty to the human operator.",
		promptGuidelines: [
			"Use workflow_ask_operator instead of stalling on chat when an ambiguity, unsafe assumption, or missing decision blocks progress and the operator is not actively responding.",
			"Set blocking=true only when work cannot safely proceed without the answer; non-blocking questions are advisory and never gate progress.",
			"Always include options and a recommendedDefault when the answer space is enumerable — the operator should be able to answer in one line.",
		],
		parameters: Type.Object({ ...ASK_PARAMETERS.properties, roomId: SCOPE_PARAM }),
		execute: async (_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
			const scope = resolveQuestionScope(ctx.cwd, params?.roomId);
			try {
				const record = appendOperatorQuestionToFile(scope.file, {
					question: trim(params?.question),
					blocking: params?.blocking !== false,
					options: Array.isArray(params?.options) ? params.options : undefined,
					recommendedDefault: trim(params?.recommendedDefault) || undefined,
					from: trim(params?.from) || "brain",
				});
				if (record.blocking && typeof ctx?.ui?.notify === "function") {
					ctx.ui.notify(`Blocking operator question ${record.id} (room ${scope.roomId}): ${record.question}`, "warning");
				}
				const open = listOpenBlockingQuestionsInFile(scope.file);
				return okText(
					`Recorded ${record.blocking ? "blocking " : ""}operator question ${record.id} in room ${scope.roomId}. Open blocking questions in this room: ${open.length}.`,
					{ question: record, roomId: scope.roomId, roomSource: scope.source, file: scope.file, openBlockingCount: open.length },
				);
			} catch (error) {
				return errText(error instanceof Error ? error.message : String(error), { roomId: scope.roomId, file: scope.file });
			}
		},
	});

	pi.registerTool({
		name: "workflow_answer_question",
		label: "Answer Operator Question",
		description: "Record the operator's (or Brain's, when relaying an explicit operator decision) answer to a queued operator question. Answering the last open blocking question unblocks prd_ready_for_sprint / finalization / AFK delivery.",
		promptSnippet: "Record the operator's answer to a queued question.",
		promptGuidelines: [
			"Use workflow_answer_question with the question id from workflow_operator_questions (or from the gate error text).",
			"Only record answers the operator actually gave; Brain must not invent answers to unblock its own gates.",
		],
		parameters: Type.Object({
			id: Type.String({ minLength: 1, description: "Question id (e.g. q-...)." }),
			answer: Type.String({ minLength: 1, description: "The operator's answer." }),
			answeredBy: Type.Optional(Type.String({ description: "Who answered; defaults to 'operator'." })),
			roomId: SCOPE_PARAM,
		}),
		execute: async (_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
			const scope = resolveQuestionScope(ctx.cwd, params?.roomId);
			try {
				const record = answerOperatorQuestionInFile(scope.file, trim(params?.id), trim(params?.answer), trim(params?.answeredBy) || "operator");
				const open = listOpenBlockingQuestionsInFile(scope.file);
				return okText(
					`Recorded answer for ${record.id} in room ${scope.roomId}. Open blocking questions remaining in this room: ${open.length}.`,
					{ question: record, roomId: scope.roomId, file: scope.file, openBlockingCount: open.length },
				);
			} catch (error) {
				return errText(error instanceof Error ? error.message : String(error), { roomId: scope.roomId, file: scope.file });
			}
		},
	});

	pi.registerTool({
		name: "workflow_operator_questions",
		label: "Operator Questions",
		description: "List queued operator questions for a room (open blocking first). Read-only.",
		promptSnippet: "List queued operator questions.",
		promptGuidelines: [
			"Use workflow_operator_questions to enumerate open questions (and their ids) before answering or when a gate reports operator_question_pending.",
		],
		parameters: Type.Object({
			roomId: SCOPE_PARAM,
			includeAnswered: Type.Optional(Type.Boolean({ description: "Include answered questions (default false)." })),
		}),
		execute: async (_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
			const scope = resolveQuestionScope(ctx.cwd, params?.roomId);
			const all = readOperatorQuestionsFromFile(scope.file);
			const includeAnswered = params?.includeAnswered === true;
			const visible = includeAnswered ? all : all.filter((q) => !q.answeredAt);
			const sorted = [...visible].sort((a, b) => Number(b.blocking && !b.answeredAt) - Number(a.blocking && !a.answeredAt));
			const openBlocking = all.filter((q) => q.blocking && !q.answeredAt).length;
			const lines = sorted.length ? sorted.map(formatQuestionLine) : ["(no questions)"];
			return okText(
				`Operator questions for room ${scope.roomId} (open blocking: ${openBlocking}):\n${lines.join("\n")}`,
				{ roomId: scope.roomId, roomSource: scope.source, file: scope.file, questions: sorted, openBlockingCount: openBlocking },
			);
		},
	});
}
