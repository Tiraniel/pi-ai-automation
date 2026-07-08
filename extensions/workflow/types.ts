import type { ReviewerVerdict } from "./reviewer-protocol";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
/** Closed set of v1 thinking levels. Mirrors `ThinkingLevel`; exported as a
 *  readonly tuple so v2 normalizers can check membership without repeating
 *  the union. Kept in sync with `ThinkingLevel` above. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
export type AgentName = "brain" | "coder" | "reviewer";
export type SemanticNavigationProvider = "serena";
export const SEMANTIC_NAVIGATION_PROVIDERS: readonly SemanticNavigationProvider[] = ["serena"] as const;
export type SemanticNavigationMode = "disabled" | "external";
export const SEMANTIC_NAVIGATION_MODES: readonly SemanticNavigationMode[] = ["disabled", "external"] as const;
export type SemanticNavigationRoleAccess = "off" | "readonly" | "edit";
export const SEMANTIC_NAVIGATION_ROLE_ACCESS: readonly SemanticNavigationRoleAccess[] = ["off", "readonly", "edit"] as const;
export type SemanticNavigationRolePolicy = Partial<Record<AgentName, SemanticNavigationRoleAccess>>;

export interface SemanticNavigationConfig {
	enabled?: boolean;
	provider?: SemanticNavigationProvider;
	mode?: SemanticNavigationMode;
	fallbackToBuiltinTools?: boolean;
	roles?: SemanticNavigationRolePolicy;
	serenaReadonlyTools?: string[];
	serenaEditTools?: string[];
	serenaProjectTools?: string[];
}
export type DelegateAgentName = "coder" | "reviewer";
/** v2 alias for `AgentName`. The two are structurally identical; v2 code
 *  uses `AgentRole` for clarity while v1 callers keep using `AgentName`. */
export type AgentRole = AgentName;
/** Closed set of agent roles (brain / coder / reviewer). Mirrors
 *  `AgentName`/`AgentRole`; exported as a readonly tuple for v2 normalizers. */
export const AGENT_ROLES: readonly AgentRole[] = [
	"brain",
	"coder",
	"reviewer",
] as const;
/** Closed set of delegate display/transport modes used by v1
 *  `WorkflowConfig.delegateDisplay`. v2 code reuses this type so the v1
 *  field shape stays compatible with v2 catalog entries. */
export type DelegateDisplayMode = "headless" | "pane" | "auto";
export const DELEGATE_DISPLAY_MODES: readonly DelegateDisplayMode[] = [
	"headless",
	"pane",
	"auto",
] as const;
/** v2 flow direction. The v2 workflow file carries a `direction` field;
 *  v1 has no equivalent (the v1 loader always runs sequentially). */
export type FlowDirection = "sequential" | "iterative" | "free";
export const FLOW_DIRECTIONS: readonly FlowDirection[] = [
	"sequential",
	"iterative",
	"free",
] as const;
/** Quality-gate kinds. `review-goal` gates compose the v2 reviewer-swarm
 *  identity; `checks` and `command` gates are non-swarm checks. */
export type QualityGateKind = "checks" | "review-goal" | "command";
export const QUALITY_GATE_KINDS: readonly QualityGateKind[] = [
	"checks",
	"review-goal",
	"command",
] as const;
/** Stable v2 config-format version. v1 files do not carry a version field;
 *  v2 files MUST set `version: 2` and the v2 normalizer rejects anything
 *  else. */
export const WORKFLOW_CONFIG_VERSION = 2 as const;

export interface AgentPreset {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	instructions?: string;
	includeKarpathyGuidelines?: boolean;
}

export interface ReviewerSwarmConfig {
	enabled?: boolean;
	maxConcurrency?: number;
	targets?: string[];
}

export interface DeepPlanningPlannerConfig {
	id?: string;
	role?: string;
	provider?: string;
	model?: string;
	modelPreset?: string;
	thinkingLevel?: ThinkingLevel;
	instructions?: string;
}

export interface DeepPlanningConfig {
	enabled?: boolean;
	plannerCount?: number;
	maxConcurrency?: number;
	rounds?: number;
	roomIdPrefix?: string;
	planners?: DeepPlanningPlannerConfig[];
	/** WP3: run an adversarial verifier round after the planner rounds
	 *  (ambiguities / untestable requirements / failure-path holes). Its
	 *  questions land in the room's operator-question queue as non-blocking.
	 *  Default: true. */
	verifier?: boolean;
}

export interface DelegateFallbacksConfig {
	coder?: AgentPreset;
	reviewer?: AgentPreset;
}

/** Re-run mode for the coder evidence verification gate (WP2 / G9).
 *  "required" (default) re-runs claimed-passed runnable evidence commands at
 *  the phase-advancement boundary; "off" disables the re-run (the diff check
 *  stays on). */
export type EvidenceRerunMode = "off" | "required";
export const EVIDENCE_RERUN_MODES: readonly EvidenceRerunMode[] = ["off", "required"] as const;

export interface EvidenceVerificationConfig {
	rerun?: EvidenceRerunMode;
	/** Command prefixes the gate is allowed to re-run (word-boundary prefix
	 *  match). Defaults are owned by
	 *  `delegate/evidence-verification.ts` (`DEFAULT_EVIDENCE_RERUN_ALLOWLIST`). */
	rerunAllowlist?: string[];
}

export interface WorkflowConfig {
	autoApplyBrain?: boolean;
	/** Built-in workflow profile id (e.g. "default" or "gonka-hybrid"). */
	profile?: string;
	agents?: Record<string, AgentPreset>;
	reviewerSwarm?: ReviewerSwarmConfig;
	deepPlanning?: DeepPlanningConfig;
	/** Delegate display/transport mode. "headless" (default) runs child delegates as JSON subprocesses.
	 *  "pane" launches them in a visible cmux surface. "auto" uses pane when cmux is available, otherwise headless. */
	delegateDisplay?: DelegateDisplayMode;
	/** When pane mode is used, auto-close the cmux surface/tab when the sub-agent finishes.
	 *  Default: true. Set to false to leave the surface open for inspection. */
	delegatePaneAutoClose?: boolean;
	/** Optional fallback model overrides used when a coder/reviewer delegate's primary model is unavailable. */
	delegateFallbacks?: DelegateFallbacksConfig;
	/** Optional semantic code navigation backend config. Disabled by default. */
	semanticNavigation?: SemanticNavigationConfig;
	/** Coder evidence verification (diff check + command re-run) policy. */
	evidence?: EvidenceVerificationConfig;
}

/** v1 aliases used by the v2 normalizer. The v1 shape is intentionally
 *  identical to the unprefixed types above, so the v1 -> v2 migration can
 *  pass v1 values to v2 helpers without structural conversion. */
export type V1AgentPreset = AgentPreset;
export type V1ReviewerSwarmConfig = ReviewerSwarmConfig;
export type V1WorkflowConfig = WorkflowConfig;

export interface WorkflowConfigLoadDiagnostic {
	scope: "global" | "project";
	severity: V2Diagnostic["severity"] | "info";
	code: string;
	message: string;
	source?: string;
}

export interface WorkflowConfigSourceInfo {
	scope: "global" | "project";
	path: string;
	exists: boolean;
	format: "v1" | "v2";
	version?: number;
	managedBy?: string;
	managedVersion?: string;
	diagnostics?: WorkflowConfigLoadDiagnostic[];
	selected: boolean;
}

export interface LoadedWorkflowConfig {
	config: WorkflowConfig;
	globalPath: string;
	projectPath: string | null;
	projectOverridePath: string | null;
	projectSettingsPath: string | null;
	projectSettings: Record<string, unknown> | undefined;
	profileId: WorkflowProfileId;
	profileSource: WorkflowProfileSource;
	sources: WorkflowConfigSourceInfo[];
	configDiagnostics: WorkflowConfigLoadDiagnostic[];
}

export type WorkflowProfileId = "default" | "gonka-hybrid" | "premium-brain-gonka-workers";
export type WorkflowProfileSource = "default" | "global" | "project" | "cli";

export interface WorkflowProfile {
	id: WorkflowProfileId;
	label: string;
	apply: Partial<WorkflowConfig>;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface DelegateProgressItem {
	at: number;
	type: "status" | "tool_start" | "tool_update" | "tool_end" | "assistant" | "thinking" | "error";
	text: string;
}

export type DelegateCompletionSource = "explicit" | "auto_exit" | "process_exit" | "missing" | "legacy";

export interface DelegateRunResult {
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	exitCode: number;
	messages: import("@earendil-works/pi-ai").Message[];
	stderr: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
	aborted?: boolean;
	status?: string;
	activeTools?: Array<{ id: string; name: string }>;
	progress?: DelegateProgressItem[];
	finalOutput?: string;
	thinkingChars?: number;
	completionSource?: DelegateCompletionSource;
	completionWarning?: string;
	/** Display/transport mode used: "headless" or "pane". */
	display?: string;
	/** cmux surface id when pane mode was used. */
	surface?: string;
	/** Session JSONL file path when pane mode was used. */
	sessionFile?: string;
	/** stderr file path written by the pane transport (when running in pane mode). */
	stderrFile?: string;
	/** Parent-visible manifest/run identifier for pane-mode status tooling. */
	runId?: string;
	/** Sidecar file paths used by pane-mode completion/liveness tracking. */
	doneFile?: string;
	activityFile?: string;
	manifestFile?: string;
	activityState?: "starting" | "active" | "waiting" | "done";
}

export interface ReviewerTargetResult {
	target: string;
	verdict: ReviewerVerdict;
	status: "running" | "completed" | "failed" | "aborted";
	result?: DelegateRunResult;
	// TASK-004 Phase A: role-based quality review metadata. All fields are
	// optional to keep v1 callers (e.g. legacy swarm targets) backward
	// compatible. Phase B wiring populates these; Phase A helper modules
	// emit them on synthetic results.
	/** Role id this target was derived for (e.g. "behavior", "docs-config"). */
	role?: string;
	/** True when the matrix/default role set requires this target. */
	required?: boolean;
	/** Effective verdict after role-aware evaluation (downgrades/blockers). */
	effectiveVerdict?: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";
	/** True when the role's review is provisional and must not satisfy final approval. */
	provisional?: boolean;
	/** Reasons this target blocks final approval, even if verdict === APPROVED. */
	blockingReasons?: string[];
	/** Criteria/evidence the role's review found weak or unsupported. */
	weakEvidence?: string[];
	/** Prompt-only mitigation caveats surfaced by the evaluator. */
	promptOnlyCaveats?: string[];
	/** Unresolved risks the role flagged for Brain to address. */
	unresolvedRisks?: string[];
	/** Reference to the matrix entry/role target descriptor driving this evaluation. */
	roleTarget?: unknown;
}

// ---------- v2 catalog shapes (Slice 1, see docs/workflow-config-v2.md) ----------

export interface V2ModelPreset {
	id: string;
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface V2ModelPresetsCatalog {
	version: typeof WORKFLOW_CONFIG_VERSION;
	presets: V2ModelPreset[];
}

export interface V2ToolProfile {
	id: string;
	tools: string[];
	includeKarpathyGuidelines?: boolean;
}

export interface V2ToolProfilesCatalog {
	version: typeof WORKFLOW_CONFIG_VERSION;
	profiles: V2ToolProfile[];
}

export interface V2PromptPackRefEntry {
	id: string;
	/** Optional filesystem path relative to the catalog. Loading is a loader
	 *  concern; slice 1 does not load it. */
	path?: string;
	/** Optional inline snippet, primarily for short transportable prompts. */
	inline?: string;
	description?: string;
}

export interface V2PromptPacksCatalog {
	version: typeof WORKFLOW_CONFIG_VERSION;
	packs: V2PromptPackRefEntry[];
}

export interface V2QualityGate {
	id: string;
	description?: string;
	kind?: QualityGateKind;
	command?: string;
}

export interface V2QualityGatesCatalog {
	version: typeof WORKFLOW_CONFIG_VERSION;
	gates: V2QualityGate[];
}

/**
 * One logical agent identity. The agent composes a model preset, a tool
 * profile, prompt packs, and quality gates by reference. The `overrides`
 * block is a small escape hatch for callers that need to inline a one-off
 * value without registering a new catalog entry. The v1 -> v2 migration
 * populates `overrides` from the legacy v1 `agents.<role>` fields, so the
 * conversion is lossless.
 */
export interface V2AgentCatalogEntry {
	id: string;
	role: AgentRole;
	modelPreset?: string;
	toolProfile?: string;
	promptPacks?: string[];
	qualityGates?: string[];
	overrides?: {
		provider?: string;
		model?: string;
		thinkingLevel?: ThinkingLevel;
		tools?: string[];
		instructions?: string;
		includeKarpathyGuidelines?: boolean;
	};
}

export interface V2AgentCatalog {
	version: typeof WORKFLOW_CONFIG_VERSION;
	agents: V2AgentCatalogEntry[];
}

// ---------- v2 workflow shape ----------

export interface V2FlowStep {
	role: AgentRole;
	/** Optional step id; required only if multiple steps reference the same role. */
	id?: string;
}

export interface V2RoleBinding {
	role: AgentRole;
	/** Catalog agent id this role resolves to. */
	agent: string;
}

export interface V2WorkflowReferences {
	agentCatalog?: string;
	modelPresets?: string;
	toolProfiles?: string;
	promptPacks?: string;
	qualityGates?: string;
}

export interface V2WorkflowMeta {
	name?: string;
	description?: string;
	/**
	 * Roles Brain is allowed to orchestrate in this flow. Defaults to
	 * `[...AGENT_ROLES]` when omitted. A flow step that references a role
	 * outside this set is reported as a diagnostic by the resolver;
	 * enforcement at delegation time is a follow-up slice.
	 */
	activeAgents?: AgentRole[];
}

export interface V2Workflow {
	version: typeof WORKFLOW_CONFIG_VERSION;
	meta?: V2WorkflowMeta;
	direction?: FlowDirection;
	flow: V2FlowStep[];
	roles: V2RoleBinding[];
	references?: V2WorkflowReferences;
	deepPlanning?: DeepPlanningConfig;
}

// ---------- resolved result shapes ----------

export type ResolutionSource =
	| "preset"
	| "profile"
	| "pack"
	| "catalog"
	| "override"
	| "fallback"
	| "missing";

export interface V2ResolvedModel {
	preset?: V2ModelPreset;
	/**
	 * Provider id. Absent when no provider could be resolved (no preset,
	 * no override, or a malformed override). Callers MUST check
	 * `provider`/`model` presence before use; `source` indicates the
	 * resolution outcome.
	 */
	provider?: string;
	/** Model id. See `provider` for absence semantics. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	source: ResolutionSource;
}

export interface V2ResolvedTools {
	profile?: V2ToolProfile;
	tools: string[];
	includeKarpathyGuidelines?: boolean;
	source: ResolutionSource;
}

export interface V2ResolvedPrompt {
	pack?: V2PromptPackRefEntry;
	/** Resolved text when an inline snippet or override is present. */
	text?: string;
	source: ResolutionSource;
}

export interface V2ResolvedQualityGate {
	gate?: V2QualityGate;
	source: ResolutionSource;
}

export interface V2ResolvedRoleIdentity {
	role: AgentRole;
	binding: V2RoleBinding;
	agent: V2AgentCatalogEntry;
	model: V2ResolvedModel;
	tools: V2ResolvedTools;
	prompts: V2ResolvedPrompt[];
	qualityGates: V2ResolvedQualityGate[];
}

/**
 * Derived reviewer-swarm identity. The reviewer swarm has no runtime
 * settings on the v2 workflow; the workflow file is purely high-level
 * orchestration. Goals are derived from the resolved reviewer role
 * identity: every resolved quality gate whose catalog gate has
 * `kind === "review-goal"` becomes a reviewer-swarm sub-identity.
 *
 * `goalIds` is the catalog-id projection of `goals`, exposed for callers
 * that need the string form (e.g. logging, delegation target names).
 */
export interface V2ReviewerSwarmResolved {
	goals: V2ResolvedQualityGate[];
	goalIds: string[];
}

export interface V2Diagnostic {
	severity: "info" | "warning" | "error";
	code: string;
	message: string;
	ref?: {
		type:
			| "workflow"
			| "agent"
			| "role-binding"
			| "flow-step"
			| "model-preset"
			| "tool-profile"
			| "prompt-pack"
			| "quality-gate"
			| "reviewer-goal"
			| "active-agents";
		id?: string;
		role?: AgentRole;
	};
}

export interface V2ResolvedWorkflow {
	workflow: V2Workflow;
	activeAgents: AgentRole[];
	direction: FlowDirection;
	flow: V2FlowStep[];
	roles: V2ResolvedRoleIdentity[];
	reviewerSwarm: V2ReviewerSwarmResolved;
	diagnostics: V2Diagnostic[];
}

// ---------- catalog input bundle (slice 1: in-memory) ----------

/**
 * In-memory bundle of catalogs passed to the resolver. Slice 1 deliberately
 * does NOT define a file loader. Follow-up slices can add a thin loader that
 * reads JSON from disk, runs it through the v2 normalizers, and feeds the
 * result into `resolveWorkflow`.
 */
export interface V2CatalogBundle {
	agentCatalog?: V2AgentCatalog;
	modelPresets?: V2ModelPresetsCatalog;
	toolProfiles?: V2ToolProfilesCatalog;
	promptPacks?: V2PromptPacksCatalog;
	qualityGates?: V2QualityGatesCatalog;
}
