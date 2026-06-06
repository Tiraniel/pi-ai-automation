export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AgentName = "brain" | "coder" | "reviewer";

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

export interface WorkflowConfig {
	autoApplyBrain?: boolean;
	/** Built-in workflow profile id (e.g. "default" or "gonka-hybrid"). */
	profile?: string;
	agents?: Record<string, AgentPreset>;
	reviewerSwarm?: ReviewerSwarmConfig;
	/** Delegate display/transport mode. "headless" (default) runs child delegates as JSON subprocesses.
	 *  "pane" launches them in a visible cmux surface. "auto" uses pane when cmux is available, otherwise headless. */
	delegateDisplay?: "headless" | "pane" | "auto";
	/** When pane mode is used, auto-close the cmux surface/tab when the sub-agent finishes.
	 *  Default: true. Set to false to leave the surface open for inspection. */
	delegatePaneAutoClose?: boolean;
}

export interface LoadedWorkflowConfig {
	config: WorkflowConfig;
	globalPath: string;
	projectPath: string | null;
	projectSettingsPath: string | null;
	projectSettings: Record<string, unknown> | undefined;
	profileId: WorkflowProfileId;
	profileSource: WorkflowProfileSource;
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
	/** Display/transport mode used: "headless" or "pane". */
	display?: string;
	/** cmux surface id when pane mode was used. */
	surface?: string;
	/** Session JSONL file path when pane mode was used. */
	sessionFile?: string;
}

export interface ReviewerTargetResult {
	target: string;
	verdict: "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";
	status: "running" | "completed" | "failed" | "aborted";
	result?: DelegateRunResult;
}
