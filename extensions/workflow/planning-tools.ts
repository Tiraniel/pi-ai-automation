// TASK-006 Phase B — PRD-first planning AI tool registration.
// One composite tool (`workflow_planning_state`) handles all CRUD /
// transitions / classification / invalidation against
// `.pi/workflow-runs/<planning-room>/planning-state.json`, plus a sibling
// tool (`workflow_planning_artifacts`) for the adjacent PRD.md / memo.md
// artifact text. Both are pure thin shells over the Phase A planning-state
// helpers — no business logic lives here.

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PLANNING_STATE_NAMES,
	PLANNING_STATE_VERSION,
	PlanningInvalidationKind,
	PlanningStateName,
	PlanningStateRecord,
	ScopeClassification,
	StageConfirmation,
	TransitionMeta,
	classifyPlanningApproval,
	classifyTinyDebugBypass,
	createPlanningState,
	invalidatePlanningState,
	isExplicitStageConfirmation,
	planningStatePathsFor,
	readPlanningState,
	setScopeClassification,
	setStateFlag,
	setStateFlags,
	stateFileExists,
	validatePlanningRoomId,
} from "./planning-state";
import {
	planningRoomHasStateFile,
	planningCurrentRoomPointerPath,
	readPlanningCurrentRoomPointer,
	readPlanningCurrentRoomPointerResult,
	readWorkflowCurrentRoomPointer,
} from "./planning-pointer";
import { evaluateSprintGateForCwd, evaluateImplementationGateForCwd } from "./planning-gate-runtime";

const STATE_NAMES = PLANNING_STATE_NAMES;

function textResult(text: string, isError = false, details?: Record<string, unknown>): any {
	const payload: { content: Array<{ type: "text"; text: string }>; isError?: true; details?: Record<string, unknown> } = {
		content: [{ type: "text", text }],
	};
	if (isError) payload.isError = true;
	if (details) payload.details = details;
	return payload;
}

function trimString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asStateName(value: unknown): PlanningStateName | null {
	const t = trimString(value);
	return (STATE_NAMES as readonly string[]).includes(t) ? (t as PlanningStateName) : null;
}

function asScope(value: unknown): ScopeClassification | null {
	const t = trimString(value);
	return t === "tiny_debug" || t === "non_trivial" || t === "expanded_from_tiny" ? t : null;
}

function asStage(value: unknown): StageConfirmation | null {
	const t = trimString(value).toLowerCase();
	return t === "sprint" || t === "implementation" ? t : null;
}

function asInvalidationKind(value: unknown): PlanningInvalidationKind | null {
	const t = trimString(value);
	return t === "prd_or_scope" || t === "architecture_or_evidence" ? t : null;
}

function asTransitionMeta(params: any): TransitionMeta {
	return {
		actor: trimString(params?.actor) || "brain",
		source: trimString(params?.source) || "workflow_planning_state",
		evidence: trimString(params?.evidence) || "Brain planning tool call",
		at: trimString(params?.at) || undefined,
	};
}

function relativeFromCwd(cwd: string, target: string): string {
	try {
		const rel = path.relative(cwd, target);
		return rel && !rel.startsWith("..") ? rel : target;
	} catch {
		return target;
	}
}

type PlanningToolAction = "create" | "evaluate_gates" | "read" | "set_flag" | "set_scope_classification" | "invalidate" | "artifacts";

function resolveRoomForTool(
	cwd: string,
	params: any,
	action: PlanningToolAction = "read",
): { roomId: string; source: "params" | "activePointer" } {
	const explicit = trimString(params?.roomId ?? params?.planningRoomId);
	if (explicit) return { roomId: validatePlanningRoomId(explicit), source: "params" };

	if (action === "create") {
		const workflowPointer = readWorkflowCurrentRoomPointer(cwd);
		if (workflowPointer) {
			const roomId = validatePlanningRoomId(workflowPointer);
			return { roomId, source: "activePointer" };
		}
		const fromPlanningPointer = readPlanningCurrentRoomPointer(cwd);
		if (fromPlanningPointer) {
			const roomId = validatePlanningRoomId(fromPlanningPointer);
			return { roomId, source: "activePointer" };
		}
		throw new Error(
			`No planningRoomId provided and no valid room id resolved; pass { roomId } explicitly or set the workflow room current pointer before create.`,
		);
	}

	const fromPlanningPointer = readPlanningCurrentRoomPointerResult(cwd);
	if (fromPlanningPointer.exists) {
		if (!fromPlanningPointer.roomId) {
			throw new Error(
				`No planningRoomId provided and active planning-room pointer at ${planningCurrentRoomPointerPath(cwd)} is invalid: ${fromPlanningPointer.issue ?? "missing roomId"}.`,
			);
		}
		try {
			const roomId = validatePlanningRoomId(fromPlanningPointer.roomId);
			if (planningRoomHasStateFile(cwd, roomId)) return { roomId, source: "activePointer" };
		} catch (error) {
			const issue = error instanceof Error ? error.message : String(error);
			throw new Error(`No planningRoomId provided and active planning-room pointer at ${planningCurrentRoomPointerPath(cwd)} is invalid: ${issue}`);
		}
	}

	const workflowPointer = readWorkflowCurrentRoomPointer(cwd);
	if (workflowPointer) {
		try {
			const roomId = validatePlanningRoomId(workflowPointer);
			if (stateFileExists(cwd, roomId)) return { roomId, source: "activePointer" };
		} catch (error) {
			throw new Error("No planningRoomId provided and active workflow-room pointer at .pi/workflow-runs/current.json is invalid.");
		}
	}
	throw new Error(
		`No planningRoomId provided and no active planning-room pointer at .pi/workflow-runs/planning-current.json (or workflow-room fallback); pass { roomId } explicitly or call room_create first.`,
	);
}
function readStateByParams(
	cwd: string,
	params: any,
	action: PlanningToolAction = "read",
): { state: PlanningStateRecord | null; roomId: string; source: "params" | "activePointer"; issue?: string; } {
	const resolved = resolveRoomForTool(cwd, params, action);
	const result = readPlanningState(cwd, resolved.roomId);
	return {
		state: result.state,
		roomId: resolved.roomId,
		source: resolved.source,
		issue: result.state ? undefined : (result.issue?.message ?? "planning state file missing"),
	};
}

export function registerPlanningTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "workflow_planning_state",
		label: "Planning State (PRD-first)",
		description:
			"Read, create, and update the durable PRD-first planning state for a planning room under `.pi/workflow-runs/<roomId>/planning-state.json`. Tracks `prd_started`, `prd_ready_for_sprint`, `sprint_confirmed`, and `implementation_confirmed`, plus scope classification and material invalidation. Use this tool during PRD-first planning BEFORE sprint creation or `delegate_to_coder`; sprint/implementation gates read this state. Generic 'approved'/'yes'/'ok' text does NOT set sprint or implementation confirmation — only explicit stage-keyword phrases (e.g. 'confirm sprint creation', 'confirm implementation') advance those flags. Use `workflow_planning_artifacts` to write the adjacent PRD.md / memo.md text.",
		promptSnippet: "Record and read durable PRD-first planning state.",
		promptGuidelines: [
			"Call workflow_planning_state.action=read first to inspect the current planning state for a room before creating a new one.",
			"For non-trivial work: action=create with scopeClassification='non_trivial', then action=set_flag to record prd_started / prd_ready_for_sprint / sprint_confirmed in staged order. Recording sprint_confirmed or implementation_confirmed requires the user to issue an explicit stage confirmation; if the provided text is generic (e.g. 'approved'), the tool returns isError with code approval_classified_as_generic and does NOT set the flag.",
			"For tiny debug: action=create with scopeClassification='tiny_debug'; add/note/done are intentionally ungated, while promotion or scope expansion re-triggers PRD/sprint/implementation gate checks.",
			"Material PRD/scope changes should call action=invalidate with kind='prd_or_scope'; material architecture/evidence changes should call action=invalidate with kind='architecture_or_evidence' to clear implementation_confirmed.",
			"Pass roomId explicitly when the active planning-room pointer is not yet set; for create, legacy compatibility first uses workflow-room current as a fallback target, while non-create actions prefer the dedicated planning-room pointer and only fall back to workflow-room current when planning state already exists there."
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("read"),
				Type.Literal("create"),
				Type.Literal("set_flag"),
				Type.Literal("set_scope_classification"),
				Type.Literal("invalidate"),
				Type.Literal("evaluate_gates"),
			]),
			roomId: Type.Optional(Type.String({ description: "Planning room id. For action=create, falls back to legacy workflow current at .pi/workflow-runs/current.json first; non-create actions prefer the dedicated planning pointer at .pi/workflow-runs/planning-current.json, then fallback to .pi/workflow-runs/current.json when planning state already exists there." })),

			taskId: Type.Optional(Type.String()),
			scopeId: Type.Optional(Type.String()),
			scopeClassification: Type.Optional(Type.Union([Type.Literal("tiny_debug"), Type.Literal("non_trivial"), Type.Literal("expanded_from_tiny")])),
			materialVersion: Type.Optional(Type.String()),
			artifactPathPrd: Type.Optional(Type.String()),
			artifactPathMemo: Type.Optional(Type.String()),
			state: Type.Optional(Type.Union(STATE_NAMES.map((name) => Type.Literal(name)))),
			value: Type.Optional(Type.Boolean()),
			approvalText: Type.Optional(Type.String({ description: "Raw user text to classify when recording sprint_confirmed / implementation_confirmed. If the text is generic (e.g. 'approved'), the tool returns isError with code approval_classified_as_generic." })),
			states: Type.Optional(Type.Array(Type.Union(STATE_NAMES.map((name) => Type.Literal(name))))),
			invalidKind: Type.Optional(Type.Union([Type.Literal("prd_or_scope"), Type.Literal("architecture_or_evidence")])),
			reason: Type.Optional(Type.String()),
			actor: Type.Optional(Type.String()),
			source: Type.Optional(Type.String()),
			evidence: Type.Optional(Type.String()),
			at: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const action = trimString((params as any).action).toLowerCase();
			if (!action) return textResult("Missing action. Use read|create|set_flag|set_scope_classification|invalidate|evaluate_gates.", true);
			const meta = asTransitionMeta(params);

			if (action === "read") {
				let resolved: { state: PlanningStateRecord | null; roomId: string; source: "params" | "activePointer"; issue?: string };
				try {
					resolved = readStateByParams(cwd, params, "read");
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), true, { reason: "no_room_resolved" });
				}
				if (!resolved.state) {
					return textResult(
						`No planning state for room ${resolved.roomId}: ${resolved.issue ?? "file missing"}`,
						true,
						{
							reason: "state_missing",
							roomId: resolved.roomId,
							roomSource: resolved.source,
							stateFile: planningStatePathsFor(cwd, resolved.roomId).stateFile,
						},
					);
				}
				return textResult(
					`planning state for room ${resolved.roomId}`,
					false,
					{ roomId: resolved.roomId, roomSource: resolved.source, state: resolved.state },
				);
			}

			if (action === "create") {
				let resolved: { roomId: string; source: "params" | "activePointer" };
				try {
					resolved = resolveRoomForTool(cwd, params, "create");
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), true, { reason: "no_room_resolved" });
				}
				const scope = asScope((params as any).scopeClassification);
				if (!scope) {
					return textResult(
						"Missing or invalid scopeClassification. Use one of: tiny_debug, non_trivial, expanded_from_tiny.",
						true,
						{ reason: "invalid_scope_classification" },
					);
				}
				if (stateFileExists(cwd, resolved.roomId)) {
					return textResult(
						`Planning state already exists for room ${resolved.roomId}; use action=read or set_flag/set_scope_classification instead.`,
						true,
						{ reason: "state_already_exists", roomId: resolved.roomId, stateFile: planningStatePathsFor(cwd, resolved.roomId).stateFile },
					);
				}
				const taskId = trimString((params as any).taskId) || undefined;
				const scopeId = trimString((params as any).scopeId) || taskId;
				const materialVersion = trimString((params as any).materialVersion) || undefined;
				const artifactPaths = {
					prd: trimString((params as any).artifactPathPrd) || undefined,
					memo: trimString((params as any).artifactPathMemo) || undefined,
				};
				try {
					const record = createPlanningState({
						cwd, roomId: resolved.roomId, scopeClassification: scope,
						taskId, scopeId, materialVersion,
						artifactPaths: artifactPaths.prd || artifactPaths.memo
							? { prd: artifactPaths.prd, memo: artifactPaths.memo }
							: undefined,
					});
					return textResult(
						`Created planning state for room ${resolved.roomId} (scope=${scope}).`,
						false,
						{ roomId: resolved.roomId, roomSource: resolved.source, state: record, version: PLANNING_STATE_VERSION },
					);
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), true, { reason: "create_failed" });
				}
			}

			if (action === "set_flag") {
				let resolved: { state: PlanningStateRecord | null; roomId: string; source: "params" | "activePointer"; issue?: string };
				try {
					resolved = readStateByParams(cwd, params, "set_flag");
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), true, { reason: "no_room_resolved" });
				}
				if (!resolved.state) {
					return textResult(
						`No planning state for room ${resolved.roomId}: ${resolved.issue ?? "file missing"}; call action=create first.`,
						true,
						{ reason: "state_missing", roomId: resolved.roomId },
					);
				}
				const statesToSet = Array.isArray((params as any).states) ? (params as any).states : (params as any).state ? [(params as any).state] : [];
				if (statesToSet.length === 0) {
					return textResult(
						"Missing state(s). Pass either { state, value } or { states: [name, ...] }.",
						true,
						{ reason: "missing_state" },
					);
				}
				const updates: Array<{ name: PlanningStateName; value: boolean; meta: TransitionMeta }> = [];
				const seen = new Set<PlanningStateName>();
				for (const raw of statesToSet) {
					const name = asStateName(raw);
					if (!name) return textResult(`Unknown planning state name: ${String(raw)}`, true, { reason: "invalid_state_name", valid: STATE_NAMES });
					if (seen.has(name)) continue;
					seen.add(name);
					let value: boolean;
					if (Array.isArray((params as any).states)) {
						const idx = (params as any).states.indexOf(raw);
						const providedValue = (params as any).values?.[idx];
						value = typeof providedValue === "boolean" ? providedValue : true;
					} else {
						value = typeof (params as any).value === "boolean" ? (params as any).value : true;
					}
					// Confirmation flags must come from an explicit stage-keyword phrase.
					if ((name === "sprint_confirmed" || name === "implementation_confirmed") && value === true) {
						const stage: StageConfirmation = name === "sprint_confirmed" ? "sprint" : "implementation";
						const text = trimString((params as any).approvalText);
						if (!text) {
							return textResult(
								`Recording ${name}=true requires approvalText. Pass the user's explicit stage-keyword phrase (e.g. 'confirm ${stage} creation' / 'confirm implementation'). Generic 'approved/yes/ok' text must NOT advance this flag.`,
								true,
								{ reason: "approval_text_missing", state: name, expectedStage: stage },
							);
						}
						if (!isExplicitStageConfirmation(text, stage)) {
							const classification = classifyPlanningApproval(text);
							return textResult(
								`Refused to record ${name}=true: approvalText='${text}' is not an explicit ${stage} confirmation (codes: approval_classified_as_generic). Generic positive planning replies must NOT set sprint or implementation confirmation; ask the user for an explicit stage-keyword phrase.`,
								true,
								{ reason: "approval_classified_as_generic", state: name, expectedStage: stage, classification, providedText: text },
							);
						}
					}
					updates.push({ name, value, meta });
				}
				try {
					const next = updates.length === 1
						? setStateFlag(cwd, resolved.roomId, updates[0].name, updates[0].value, updates[0].meta)
						: setStateFlags(cwd, resolved.roomId, updates);
					return textResult(
						`Updated planning state for room ${resolved.roomId}.`,
						false,
						{ roomId: resolved.roomId, roomSource: resolved.source, updatedStates: updates.map((u) => u.name), state: next },
					);
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), true, { reason: "set_flag_failed" });
				}
			}

			if (action === "set_scope_classification") {
				let resolved: { state: PlanningStateRecord | null; roomId: string; source: "params" | "activePointer"; issue?: string };
				try {
					resolved = readStateByParams(cwd, params, "set_scope_classification");
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), true, { reason: "no_room_resolved" });
				}
				if (!resolved.state) {
					return textResult(
						`No planning state for room ${resolved.roomId}: ${resolved.issue ?? "file missing"}; call action=create first.`,
						true,
						{ reason: "state_missing", roomId: resolved.roomId },
					);
				}
				const scope = asScope((params as any).scopeClassification);
				if (!scope) return textResult("Missing or invalid scopeClassification.", true, { reason: "invalid_scope_classification" });
				try {
					const next = setScopeClassification(cwd, resolved.roomId, scope, meta);
					return textResult(
						`Set scopeClassification=${scope} for room ${resolved.roomId}.`,
						false,
						{ roomId: resolved.roomId, roomSource: resolved.source, state: next, classification: classifyTinyDebugBypass(next, scope === "tiny_debug") },
					);
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), true, { reason: "set_scope_failed" });
				}
			}

			if (action === "invalidate") {
				let resolved: { state: PlanningStateRecord | null; roomId: string; source: "params" | "activePointer"; issue?: string };
				try {
					resolved = readStateByParams(cwd, params, "invalidate");
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), true, { reason: "no_room_resolved" });
				}
				if (!resolved.state) {
					return textResult(
						`No planning state for room ${resolved.roomId}: ${resolved.issue ?? "file missing"}; call action=create first.`,
						true,
						{ reason: "state_missing", roomId: resolved.roomId },
					);
				}
				const kind = asInvalidationKind((params as any).invalidKind);
				if (!kind) return textResult("Missing or invalid invalidKind. Use prd_or_scope or architecture_or_evidence.", true, { reason: "invalid_invalid_kind" });
				const reason = trimString((params as any).reason) || `${kind} invalidation`;
				try {
					const next = invalidatePlanningState(cwd, resolved.roomId, { kind, reason, ...meta });
					return textResult(
						`Invalidated room ${resolved.roomId} (${kind}).`,
						false,
						{ roomId: resolved.roomId, roomSource: resolved.source, state: next },
					);
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), true, { reason: "invalidate_failed" });
				}
			}

			if (action === "evaluate_gates") {
				const sprint = evaluateSprintGateForCwd(cwd, (params as any).roomId);
				const impl = evaluateImplementationGateForCwd(cwd, (params as any).roomId);
				return textResult(
					`sprint.allowed=${sprint.allowed}; implementation.allowed=${impl.allowed}`,
					false,
					{ sprint, implementation: impl },
				);
			}

			return textResult(`Unknown action: ${action}`, true, { reason: "unknown_action" });
		},
	});

	pi.registerTool({
		name: "workflow_planning_artifacts",
		label: "Planning Artifacts (PRD/Memo)",
		description:
			"Read or write the adjacent PRD.md and memo.md artifacts that live next to a planning room's `planning-state.json`. PRD-first planning requires these artifacts; runtime gates cite their paths in blocker messages. Use this tool to draft / update the PRD draft (problem/background, goals, non-goals, acceptance criteria, ready_for_sprint) and the planning memo (Brain synthesis, resolved decisions, risks).",
		promptSnippet: "Maintain the PRD.md and memo.md artifacts alongside planning-state.json.",
		promptGuidelines: [
			"Call workflow_planning_artifacts.action=read first to inspect existing PRD/memo content before overwriting.",
			"action=write_prd and action=write_memo only update artifact text; they do NOT change the four confirmation flags. Call workflow_planning_state to record flag transitions.",
			"PRD draft should declare ready_for_sprint: yes|no near the end; that string is the source of truth Brain uses to set prd_ready_for_sprint.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("read"), Type.Literal("write_prd"), Type.Literal("write_memo")]),
			roomId: Type.Optional(Type.String()),
			planningRoomId: Type.Optional(Type.String()),
			content: Type.Optional(Type.String({ description: "Full markdown content to write for the artifact." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			let resolved: { roomId: string; source: "params" | "activePointer" };
			try {
				resolved = resolveRoomForTool(cwd, params, "artifacts");
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error), true, { reason: "no_room_resolved" });
			}
			const paths = planningStatePathsFor(cwd, resolved.roomId);
			const action = trimString((params as any).action).toLowerCase();
			if (action === "read") {
				const prdExists = fs.existsSync(paths.prdFile);
				const memoExists = fs.existsSync(paths.memoFile);
				const prd = prdExists ? fs.readFileSync(paths.prdFile, "utf-8") : null;
				const memo = memoExists ? fs.readFileSync(paths.memoFile, "utf-8") : null;
				return textResult(
					`PRD=${prdExists ? "present" : "missing"} memo=${memoExists ? "present" : "missing"} for room ${resolved.roomId}`,
					false,
					{ roomId: resolved.roomId, prdPath: relativeFromCwd(cwd, paths.prdFile), memoPath: relativeFromCwd(cwd, paths.memoFile), prd, memo },
				);
			}
			if (action === "write_prd" || action === "write_memo") {
				const content = trimString((params as any).content);
				if (!content) return textResult(`Missing content for action=${action}.`, true, { reason: "missing_content" });
				const target = action === "write_prd" ? paths.prdFile : paths.memoFile;
				fs.mkdirSync(paths.roomDir, { recursive: true });
				fs.writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
				return textResult(
					`Wrote ${action} for room ${resolved.roomId}: ${relativeFromCwd(cwd, target)}`,
					false,
					{ roomId: resolved.roomId, path: relativeFromCwd(cwd, target) },
				);
			}
			return textResult(`Unknown action: ${action}`, true, { reason: "unknown_action" });
		},
	});
}
