import * as fs from "node:fs";
import * as path from "node:path";
import { writePlanningCurrentRoomPointer } from "./planning-pointer";
import { ROOM_DIR_NAME } from "./rooms/types";

export const PLANNING_STATE_FILE_NAME = "planning-state.json";
export const PLANNING_PRD_FILE_NAME = "PRD.md";
export const PLANNING_MEMO_FILE_NAME = "memo.md";
export const PLANNING_STATE_VERSION = 1;
export const PLANNING_ROOM_ID_PATTERN = /^[a-z0-9-]+$/;

export const PLANNING_STATE_NAMES = ["prd_started", "prd_ready_for_sprint", "sprint_confirmed", "implementation_confirmed"] as const;
export type PlanningStateName = (typeof PLANNING_STATE_NAMES)[number];

export const SCOPE_CLASSIFICATIONS = ["tiny_debug", "non_trivial", "expanded_from_tiny"] as const;
export type ScopeClassification = (typeof SCOPE_CLASSIFICATIONS)[number];

export const STAGE_CONFIRMATIONS = ["sprint", "implementation"] as const;
export type StageConfirmation = (typeof STAGE_CONFIRMATIONS)[number];

export const GENERIC_PLANNING_APPROVAL_PHRASES = [
	"approved", "approve", "yes", "ok", "okay", "agree", "agreed", "proceed", "go ahead", "go-ahead",
	"looks good", "sounds good", "good", "fine", "great", "thanks", "lgtm",
] as const;

export const PLANNING_GATE_CODES = [
	"state_missing", "state_unreadable", "scope_missing", "scope_not_non_trivial",
	"prd_not_started", "prd_not_ready_for_sprint", "sprint_not_confirmed", "implementation_not_confirmed",
	"tiny_debug_bypass", "tiny_debug_bypass_disallowed",
	"material_prd_invalidation", "material_architecture_invalidation",
	"approval_classified_as_generic",
	"planning_room_id_invalid",
] as const;
export type PlanningGateCode = (typeof PLANNING_GATE_CODES)[number];

export type PlanningInvalidationKind = "prd_or_scope" | "architecture_or_evidence";

export interface PlanningStateTransition { state: PlanningStateName; value: boolean; at: string; actor: string; source: string; evidence: string; }
export interface PlanningStateArtifactPaths { prd: string; memo: string; }
export interface PlanningInvalidation { kind: PlanningInvalidationKind; reason: string; at: string; actor: string; clearedFlags: PlanningStateName[]; }
export interface PlanningStateRecord {
	version: number; roomId: string; taskId?: string; scopeId?: string;
	scopeClassification: ScopeClassification; materialVersion: string;
	artifactPaths: PlanningStateArtifactPaths;
	states: Record<PlanningStateName, boolean>;
	transitions: PlanningStateTransition[];
	invalidatedBy: PlanningInvalidation | null;
	updatedAt: string;
}
export type PlanningStateReadIssueCode = "state_file_missing" | "state_file_unreadable" | "state_file_invalid_json" | "state_invalid_shape" | "state_version_unsupported";
export interface PlanningStateReadIssue { code: PlanningStateReadIssueCode; message: string; }
export interface PlanningStateReadResult { state: PlanningStateRecord | null; issue?: PlanningStateReadIssue; hadUnknownFields: boolean; }
export interface PlanningGateResult {
	ok: boolean; allowed: boolean; gate: "sprint" | "implementation";
	codes: PlanningGateCode[]; summary: string; missing: PlanningStateName[]; artifactPath?: string;
	details: {
		statePresent: boolean; scopeClassification: ScopeClassification | null;
		flags: Record<PlanningStateName, boolean>; invalidatedBy: PlanningInvalidation | null;
	};
}
export interface PlanningApprovalClassification {
	text: string; normalized: string; isGenericPositive: boolean; hasNegation: boolean;
	mentionsStage: boolean; mentionedStages: StageConfirmation[];
	explicitStageConfirmation: StageConfirmation | null;
}
export interface TransitionMeta { actor: string; source: string; evidence: string; at?: string; }
export interface PlanningStatePaths { roomDir: string; stateFile: string; prdFile: string; memoFile: string; }

export function validatePlanningRoomId(roomId: string): string {
	const normalized = String(roomId ?? "").trim();
	if (!PLANNING_ROOM_ID_PATTERN.test(normalized)) {
		throw new Error(`invalid planning room id: ${roomId}; expected lowercase letters/numbers/hyphens (^[a-z0-9-]+$)`);
	}
	return normalized;
}

export function planningStatePathsFor(cwd: string, roomId: string): PlanningStatePaths {
	const safeRoomId = validatePlanningRoomId(roomId);
	const roomDir = path.join(cwd, ".pi", ROOM_DIR_NAME, safeRoomId);
	return { roomDir, stateFile: path.join(roomDir, PLANNING_STATE_FILE_NAME), prdFile: path.join(roomDir, PLANNING_PRD_FILE_NAME), memoFile: path.join(roomDir, PLANNING_MEMO_FILE_NAME) };
}


const trim = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nowIso = (): string => new Date().toISOString();
const asStateName = (v: unknown): PlanningStateName | null => {
	const t = trim(v);
	return (PLANNING_STATE_NAMES as readonly string[]).includes(t) ? (t as PlanningStateName) : null;
};
const asScope = (v: unknown): ScopeClassification | null => {
	const t = trim(v);
	return (SCOPE_CLASSIFICATIONS as readonly string[]).includes(t) ? (t as ScopeClassification) : null;
};
function cloneFlags(source?: Partial<Record<PlanningStateName, boolean>>): Record<PlanningStateName, boolean> {
	const out: Record<PlanningStateName, boolean> = { prd_started: false, prd_ready_for_sprint: false, sprint_confirmed: false, implementation_confirmed: false };
	if (source) for (const n of PLANNING_STATE_NAMES) out[n] = source[n] === true;
	return out;
}
const defaultArtifactPaths = (cwd: string, roomId: string): PlanningStateArtifactPaths => {
	const p = planningStatePathsFor(cwd, roomId);
	return { prd: path.relative(cwd, p.prdFile), memo: path.relative(cwd, p.memoFile) };
};
function transitionRow(state: PlanningStateName, value: boolean, at: string, meta: { actor: string; source: string; evidence: string }): PlanningStateTransition {
	return { state, value, at, actor: trim(meta.actor) || "unknown", source: trim(meta.source) || "unknown", evidence: trim(meta.evidence) || "" };
}

function parseTransition(item: unknown, index: number, issues: PlanningStateReadIssue[]): PlanningStateTransition | null {
	if (!isObject(item)) { issues.push({ code: "state_invalid_shape", message: `transitions[${index}] must be an object` }); return null; }
	const state = asStateName(item.state);
	if (!state) { issues.push({ code: "state_invalid_shape", message: `transitions[${index}].state is not a known planning state` }); return null; }
	return transitionRow(state, item.value === true, trim(item.at) || nowIso(), { actor: trim(item.actor), source: trim(item.source), evidence: trim(item.evidence) });
}

function parseInvalidation(value: unknown, issues: PlanningStateReadIssue[]): PlanningInvalidation | null {
	if (value === null || value === undefined) return null;
	if (!isObject(value)) { issues.push({ code: "state_invalid_shape", message: "invalidatedBy must be an object or null" }); return null; }
	const kindRaw = trim(value.kind);
	if (kindRaw !== "prd_or_scope" && kindRaw !== "architecture_or_evidence") {
		issues.push({ code: "state_invalid_shape", message: "invalidatedBy.kind must be prd_or_scope or architecture_or_evidence" });
		return null;
	}
	const clearedFlags: PlanningStateName[] = [];
	if (Array.isArray(value.clearedFlags)) for (const e of value.clearedFlags) {
		const n = asStateName(e);
		if (n) clearedFlags.push(n);
	}
	return { kind: kindRaw, reason: trim(value.reason) || "", at: trim(value.at) || nowIso(), actor: trim(value.actor) || "unknown", clearedFlags };
}

const KNOWN_TOP_KEYS = new Set(["version", "roomId", "taskId", "scopeId", "scopeClassification", "materialVersion", "artifactPaths", "states", "transitions", "invalidatedBy", "updatedAt"]);

function normalize(value: unknown, cwd: string, roomId: string) {
	const issues: PlanningStateReadIssue[] = [];
	if (!isObject(value)) { issues.push({ code: "state_invalid_shape", message: "planning-state.json root must be a JSON object" }); return { state: null, issues, unknown: false }; }
	if (value.version !== PLANNING_STATE_VERSION) {
		issues.push({ code: "state_version_unsupported", message: `version ${String(value.version)} is not supported; expected ${PLANNING_STATE_VERSION}` });
		return { state: null, issues, unknown: false };
	}
	const scope = asScope(value.scopeClassification);
	if (!scope) { issues.push({ code: "state_invalid_shape", message: `scopeClassification must be one of: ${SCOPE_CLASSIFICATIONS.join(", ")}` }); return { state: null, issues, unknown: false }; }
	const rawStates = isObject(value.states) ? value.states : null;
	if (!rawStates) { issues.push({ code: "state_invalid_shape", message: "states must be an object" }); return { state: null, issues, unknown: false }; }
	const flags = cloneFlags(rawStates);
	const transitions: PlanningStateTransition[] = [];
	if (Array.isArray(value.transitions)) for (let i = 0; i < value.transitions.length; i += 1) {
		const t = parseTransition(value.transitions[i], i, issues);
		if (t) transitions.push(t);
	}
	const aRaw = isObject(value.artifactPaths) ? value.artifactPaths : null;
	const defaults = defaultArtifactPaths(cwd, roomId);
	const artifactPaths: PlanningStateArtifactPaths = {
		prd: trim(aRaw?.prd) || defaults.prd, memo: trim(aRaw?.memo) || defaults.memo,
	};
	const invalidatedBy = parseInvalidation(value.invalidatedBy, issues);
	const unknown = Object.keys(value).some((k) => !KNOWN_TOP_KEYS.has(k));
	return {
		state: {
			version: PLANNING_STATE_VERSION, roomId: trim(value.roomId) || roomId,
			taskId: trim(value.taskId) || undefined, scopeId: trim(value.scopeId) || trim(value.taskId) || undefined,
			scopeClassification: scope, materialVersion: trim(value.materialVersion) || `${roomId}-v1`,
			artifactPaths, states: flags, transitions, invalidatedBy, updatedAt: trim(value.updatedAt) || nowIso(),
		} as PlanningStateRecord,
		issues, unknown,
	};
}

export function readPlanningState(cwd: string, roomId: string): PlanningStateReadResult {
	const p = planningStatePathsFor(cwd, roomId);
	if (!fs.existsSync(p.stateFile)) {
		return { state: null, issue: { code: "state_file_missing", message: `planning state file missing at ${path.relative(cwd, p.stateFile)}` }, hadUnknownFields: false };
	}
	let raw: unknown;
	try { raw = JSON.parse(fs.readFileSync(p.stateFile, "utf-8")); }
	catch (e) {
		return { state: null, issue: { code: "state_file_invalid_json", message: `planning state file at ${path.relative(cwd, p.stateFile)} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }, hadUnknownFields: false };
	}
	const { state, issues, unknown } = normalize(raw, cwd, roomId);
	if (issues.length > 0) return { state: null, issue: issues[0], hadUnknownFields: unknown };
	return { state, hadUnknownFields: unknown };
}

export function writePlanningState(cwd: string, roomId: string, state: PlanningStateRecord): void {
	const p = planningStatePathsFor(cwd, roomId);
	fs.mkdirSync(p.roomDir, { recursive: true });
	fs.writeFileSync(p.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	writePlanningCurrentRoomPointer(cwd, roomId);
}

export interface CreatePlanningStateInput {
	cwd: string; roomId: string; scopeClassification: ScopeClassification;
	taskId?: string; scopeId?: string; materialVersion?: string;
	artifactPaths?: Partial<PlanningStateArtifactPaths>;
	states?: Partial<Record<PlanningStateName, boolean>>;
	transitions?: PlanningStateTransition[]; invalidatedBy?: PlanningInvalidation | null;
}

export function createPlanningState(input: CreatePlanningStateInput): PlanningStateRecord {
	const p = planningStatePathsFor(input.cwd, input.roomId);
	if (fs.existsSync(p.stateFile)) {
		throw new Error(`planning state already exists at ${path.relative(input.cwd, p.stateFile)}; read before creating`);
	}
	const defaults = defaultArtifactPaths(input.cwd, input.roomId);
	const record: PlanningStateRecord = {
		version: PLANNING_STATE_VERSION, roomId: input.roomId,
		taskId: input.taskId, scopeId: input.scopeId ?? input.taskId,
		scopeClassification: input.scopeClassification,
		materialVersion: input.materialVersion ?? `${input.roomId}-v1`,
		artifactPaths: { prd: input.artifactPaths?.prd ?? defaults.prd, memo: input.artifactPaths?.memo ?? defaults.memo },
		states: cloneFlags(input.states), transitions: input.transitions ?? [],
		invalidatedBy: input.invalidatedBy ?? null, updatedAt: nowIso(),
	};
	writePlanningState(input.cwd, input.roomId, record);
	return record;
}

function applyFlagUpdates(
	state: PlanningStateRecord, updates: Array<{ name: PlanningStateName; value: boolean; meta: TransitionMeta }>,
): PlanningStateRecord {
	const flags = cloneFlags(state.states);
	const transitions = [...state.transitions];
	for (const u of updates) {
		if (flags[u.name] !== u.value) transitions.push(transitionRow(u.name, u.value, u.meta.at || nowIso(), u.meta));
		flags[u.name] = u.value;
	}
	return { ...state, states: flags, transitions, invalidatedBy: null, updatedAt: nowIso() };
}

function readOrThrow(cwd: string, roomId: string, action: string): PlanningStateRecord {
	const r = readPlanningState(cwd, roomId);
	if (!r.state) throw new Error(`cannot ${action}: ${r.issue?.message ?? "state file missing"} at room ${roomId}`);
	return r.state;
}

export function setStateFlag(cwd: string, roomId: string, name: PlanningStateName, value: boolean, meta: TransitionMeta): PlanningStateRecord {
	return setStateFlags(cwd, roomId, [{ name, value, meta }]);
}

export function setStateFlags(cwd: string, roomId: string, updates: Array<{ name: PlanningStateName; value: boolean; meta: TransitionMeta }>): PlanningStateRecord {
	const current = readOrThrow(cwd, roomId, "set planning state flags");
	const next = applyFlagUpdates(current, updates);
	writePlanningState(cwd, roomId, next);
	return next;
}

export interface InvalidateInput extends TransitionMeta { kind: PlanningInvalidationKind; reason: string; }

export function invalidatePlanningState(cwd: string, roomId: string, input: InvalidateInput): PlanningStateRecord {
	const current = readOrThrow(cwd, roomId, "invalidate planning state");
	const cleared: PlanningStateName[] = input.kind === "prd_or_scope"
		? ["prd_ready_for_sprint", "sprint_confirmed", "implementation_confirmed"]
		: ["implementation_confirmed"];
	const at = input.at || nowIso();
	const flags = cloneFlags(current.states);
	for (const c of cleared) flags[c] = false;
	const reasonText = trim(input.reason) || input.kind;
	const invalidMeta = { ...input, evidence: `invalidated: ${reasonText}` };
	const transitions = [...current.transitions];
	for (const c of cleared) transitions.push(transitionRow(c, false, at, invalidMeta));
	const next: PlanningStateRecord = {
		...current, states: flags, transitions,
		invalidatedBy: { kind: input.kind, reason: reasonText, at, actor: trim(input.actor) || "unknown", clearedFlags: cleared },
		updatedAt: at,
	};
	writePlanningState(cwd, roomId, next);
	return next;
}

export function setScopeClassification(
	cwd: string, roomId: string, classification: ScopeClassification, meta: TransitionMeta,
): PlanningStateRecord {
	const current = readOrThrow(cwd, roomId, "set scope classification");
	if (!asScope(classification)) throw new Error(`unknown scope classification: ${classification}`);
	const at = meta.at || nowIso();
	const scopeEvidence = `scope_classification=${classification} ${trim(meta.evidence)}`.trim();
	const wasNonTrivial = current.scopeClassification === "non_trivial";
	if (!wasNonTrivial && (classification === "non_trivial" || classification === "expanded_from_tiny")) {
			const cleared: PlanningStateName[] = ["prd_ready_for_sprint", "sprint_confirmed", "implementation_confirmed"];
		const flags = cloneFlags(current.states);
		for (const c of cleared) flags[c] = false;
		const invalidMeta = { ...meta, evidence: "invalidated: scope promoted to non_trivial; re-confirmation required" };
		const transitions = [...current.transitions, transitionRow("prd_started", flags.prd_started, at, meta)];
		for (const c of cleared) transitions.push(transitionRow(c, false, at, invalidMeta));
		const next: PlanningStateRecord = {
			...current, scopeClassification: classification, states: flags, transitions, updatedAt: at,
			invalidatedBy: { kind: "prd_or_scope", reason: "scope promoted to non_trivial; re-confirmation required", at,
				actor: trim(meta.actor) || "unknown", clearedFlags: cleared },
		};
		writePlanningState(cwd, roomId, next);
		return next;
	}
	const next: PlanningStateRecord = {
		...current, scopeClassification: classification, updatedAt: at,
		transitions: [...current.transitions, transitionRow("prd_started", current.states.prd_started, at, { ...meta, evidence: scopeEvidence })],
	};
	writePlanningState(cwd, roomId, next);
	return next;
}

export const isTinyDebugScope = (s: PlanningStateRecord | null): boolean => s?.scopeClassification === "tiny_debug";
export const isExpandedFromTiny = (s: PlanningStateRecord | null): boolean => s?.scopeClassification === "expanded_from_tiny";
export const isNonTrivialScope = (s: PlanningStateRecord | null): boolean => s?.scopeClassification === "non_trivial" || s?.scopeClassification === "expanded_from_tiny";

const normalizeApproval = (text: string): string => text.trim().toLowerCase().replace(/[!.?,;:]+$/g, "");

function phraseMatches(normalized: string, phrase: string): boolean {
	if (!phrase) return false;
	const escaped = phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
	return new RegExp(`\\b${escaped}\\b`, "i").test(normalized);
}

const STAGE_KEYWORDS: Record<StageConfirmation, string[]> = {
	sprint: [
		"confirm sprint creation", "authorize sprint creation", "start the sprint",
		"create the sprint", "open the sprint", "plan the sprint", "sprint plan",
		"sprint planning", "sprint task", "sprint",
	],
	implementation: [
		"confirm implementation", "authorize implementation", "confirm delegate to coder",
		"authorize delegate to coder", "confirm implementation creation", "authorize implementation creation",
		"delegate to coder", "start coding", "start the implementation", "code it",
		"code change", "go build", "implement", "implementation", "delegate",
	],
};

const STRONG_STAGE_CONFIRMATIONS: Record<StageConfirmation, string[]> = {
	sprint: [
		"confirm sprint creation", "authorize sprint creation",
	],
	implementation: [
		"confirm implementation", "authorize implementation",
		"confirm delegate to coder", "authorize delegate to coder",
		"confirm implementation creation", "authorize implementation creation",
	],
};

const NEGATION_REGEX = /\b(not|cannot|never|without|no)\b|n't\b/i;
function containsNegationMarker(normalized: string): boolean { return NEGATION_REGEX.test(normalized); }

export function isGenericPlanningApproval(text: string): boolean {
	const normalized = normalizeApproval(text);
	if (!normalized) return false;
	return (GENERIC_PLANNING_APPROVAL_PHRASES as readonly string[]).some((p) => phraseMatches(normalized, p));
}

export function classifyPlanningApproval(text: string): PlanningApprovalClassification {
	const normalized = normalizeApproval(text);
	const isGenericPositive = isGenericPlanningApproval(text);
	const hasNegation = containsNegationMarker(normalized);
	const matched = new Set<StageConfirmation>();
	for (const stage of STAGE_CONFIRMATIONS) for (const kw of STAGE_KEYWORDS[stage]) {
		if (phraseMatches(normalized, kw)) { matched.add(stage); break; }
	}
	const mentionedStages = Array.from(matched);
	const strongStage: StageConfirmation | null = hasNegation ? null : (() => {
		for (const stage of STAGE_CONFIRMATIONS) for (const kw of STRONG_STAGE_CONFIRMATIONS[stage]) {
			if (phraseMatches(normalized, kw)) return stage;
		}
		return null;
	})();
	// Fail-closed: ONLY a strong confirmation phrase ("confirm sprint creation",
	// "authorize implementation", …) counts as an explicit stage confirmation.
	// "ok, go build it" / "yes, implement" are stage mentions, not authorization —
	// the gate error text has always promised exactly this.
	const explicit: StageConfirmation | null = strongStage;
	return {
		text, normalized, isGenericPositive, hasNegation, mentionsStage: matched.size > 0, mentionedStages,
		explicitStageConfirmation: explicit,
	};
}

export function isExplicitStageConfirmation(text: string, stage: StageConfirmation): boolean {
	return classifyPlanningApproval(text).explicitStageConfirmation === stage;
}

function gateDetails(state: PlanningStateRecord | null): PlanningGateResult["details"] {
	if (state) return { statePresent: true, scopeClassification: state.scopeClassification, flags: cloneFlags(state.states), invalidatedBy: state.invalidatedBy };
	return { statePresent: false, scopeClassification: null, flags: cloneFlags(), invalidatedBy: null };
}

const missingSummary = (gate: string, missing: PlanningStateName[], a: string | undefined): string => {
	const suffix = a ? ` (see ${a})` : "";
	return `non-trivial ${gate} gate is blocked; missing flags: ${missing.join(", ")}${suffix}`;
};

export function evaluateSprintPlanningGate(
	state: PlanningStateRecord | null,
	options: { allowTinyDebugBypass?: boolean } = {},
): PlanningGateResult {
	const details = gateDetails(state);
	const artifact = state?.artifactPaths.prd;
	if (!state) {
		return { ok: false, allowed: false, gate: "sprint", codes: ["state_missing"],
			summary: `sprint planning gate is blocked: durable planning state is missing${artifact ? ` (expected under ${artifact})` : ""}.`,
			missing: [...PLANNING_STATE_NAMES], artifactPath: artifact, details };
	}
	if (!isNonTrivialScope(state) && !options.allowTinyDebugBypass) {
		return { ok: false, allowed: false, gate: "sprint", codes: ["scope_not_non_trivial"],
			summary: `sprint planning gate is blocked: scopeClassification=${state.scopeClassification} is not non_trivial; tiny-debug work must use the bypass.`,
			missing: [], artifactPath: artifact, details };
	}
	if (options.allowTinyDebugBypass && isTinyDebugScope(state)) {
		if (state.invalidatedBy) {
			return { ok: false, allowed: false, gate: "sprint", codes: ["material_prd_invalidation"],
				summary: `sprint planning gate is blocked: planning state was invalidated (${state.invalidatedBy.kind}: ${state.invalidatedBy.reason}); re-confirmation required.`,
				missing: [], artifactPath: artifact, details };
		}
		return { ok: true, allowed: true, gate: "sprint", codes: ["tiny_debug_bypass"],
			summary: "sprint planning gate allowed via tiny_debug bypass; no PRD/sprint confirmation required.",
			missing: [], artifactPath: artifact, details };
	}
	const codes: PlanningGateCode[] = [];
	const requiredMissing: PlanningStateName[] = [];
	if (!state.states.prd_started) { codes.push("prd_not_started"); requiredMissing.push("prd_started"); }
	if (!state.states.prd_ready_for_sprint) { codes.push("prd_not_ready_for_sprint"); requiredMissing.push("prd_ready_for_sprint"); }
	if (!state.states.sprint_confirmed) { codes.push("sprint_not_confirmed"); requiredMissing.push("sprint_confirmed"); }
	if (state.invalidatedBy) codes.push("material_prd_invalidation");
	const allowed = requiredMissing.length === 0 && !state.invalidatedBy;
	return { ok: allowed, allowed, gate: "sprint", codes,
		summary: allowed
			? "sprint planning gate allowed: PRD started, ready for sprint, and sprint confirmed."
			: state.invalidatedBy
				? `sprint planning gate is blocked: planning state was invalidated (${state.invalidatedBy.kind}: ${state.invalidatedBy.reason}); re-confirmation required.`
				: missingSummary("sprint planning", requiredMissing, artifact),
		missing: requiredMissing, artifactPath: artifact, details };
}

export function evaluateImplementationGate(
	state: PlanningStateRecord | null,
	options: { allowTinyDebugBypass?: boolean } = {},
): PlanningGateResult {
	const details = gateDetails(state);
	const artifact = state?.artifactPaths.prd;
	if (!state) {
		return { ok: false, allowed: false, gate: "implementation", codes: ["state_missing"],
			summary: `implementation gate is blocked: durable planning state is missing${artifact ? ` (expected under ${artifact})` : ""}.`,
			missing: [...PLANNING_STATE_NAMES], artifactPath: artifact, details };
	}
	if (isTinyDebugScope(state)) {
		if (options.allowTinyDebugBypass) {
			if (state.invalidatedBy) {
				return { ok: false, allowed: false, gate: "implementation", codes: ["material_architecture_invalidation"],
					summary: `implementation gate is blocked: planning state was invalidated (${state.invalidatedBy.kind}: ${state.invalidatedBy.reason}); re-confirmation required.`,
					missing: [], artifactPath: artifact, details };
			}
			return { ok: true, allowed: true, gate: "implementation", codes: ["tiny_debug_bypass"],
				summary: "implementation gate allowed via tiny_debug bypass.", missing: [], artifactPath: artifact, details };
		}
		return { ok: false, allowed: false, gate: "implementation", codes: ["tiny_debug_bypass_disallowed"],
			summary: "implementation gate is blocked: caller did not enable the tiny_debug bypass for this call.",
			missing: [], artifactPath: artifact, details };
	}
	if (!isNonTrivialScope(state)) {
		return { ok: false, allowed: false, gate: "implementation", codes: ["scope_not_non_trivial"],
			summary: `implementation gate is blocked: scopeClassification=${state.scopeClassification} is not non_trivial.`,
			missing: [], artifactPath: artifact, details };
	}
	const codes: PlanningGateCode[] = [];
	const missing: PlanningStateName[] = [];
	for (const n of PLANNING_STATE_NAMES) {
		if (state.states[n]) continue;
		missing.push(n);
		codes.push(n === "prd_started" ? "prd_not_started"
			: n === "prd_ready_for_sprint" ? "prd_not_ready_for_sprint"
			: n === "sprint_confirmed" ? "sprint_not_confirmed"
			: "implementation_not_confirmed");
	}
	if (state.invalidatedBy) codes.push("material_architecture_invalidation");
	const allowed = missing.length === 0 && !state.invalidatedBy;
	return { ok: allowed, allowed, gate: "implementation", codes,
		summary: allowed
			? "implementation gate allowed: all four confirmation flags are set for the current material version."
			: state.invalidatedBy
				? `implementation gate is blocked: planning state was invalidated (${state.invalidatedBy.kind}: ${state.invalidatedBy.reason}); re-confirmation required.`
				: missingSummary("implementation", missing, artifact),
		missing, artifactPath: artifact, details };
}

export interface TinyDebugBypassRequest {
	requested: boolean; allowed: boolean; reason: string; scopeClassification: ScopeClassification | null;
}

export function classifyTinyDebugBypass(state: PlanningStateRecord | null, requested: boolean): TinyDebugBypassRequest {
	const scope = state?.scopeClassification ?? null;
	if (!requested) return { requested: false, allowed: false, reason: "no tiny_debug bypass requested", scopeClassification: scope };
	if (scope !== "tiny_debug") {
		return { requested: true, allowed: false, reason: `tiny_debug bypass requested but scopeClassification=${scope ?? "missing"}; only tiny_debug scope can use the bypass`, scopeClassification: scope };
	}
	return { requested: true, allowed: true, reason: "tiny_debug bypass allowed for current scope", scopeClassification: scope };
}

export function stateFileExists(cwd: string, roomId: string): boolean {
	return fs.existsSync(planningStatePathsFor(cwd, roomId).stateFile);
}
