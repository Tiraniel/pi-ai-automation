import {
	BRAIN_INSTRUCTIONS,
	CODER_INSTRUCTIONS,
	DEFAULT_REVIEWER_SWARM_TARGETS,
	REVIEWER_INSTRUCTIONS,
} from "./prompts";
import type { DeepPlanningConfig, WorkflowConfig } from "./types";

const DEFAULT_DEEP_PLANNING_CONFIG: DeepPlanningConfig = {
	enabled: false,
	plannerCount: 3,
	maxConcurrency: 3,
	rounds: 2,
	roomIdPrefix: "deep-plan",
	planners: [
		{
			id: "planner-1",
			role: "architecture",
			provider: "openai-codex",
			model: "gpt-5.5",
			thinkingLevel: "xhigh",
			instructions:
				"Perform high-level architectural planning: constraints, flow assumptions, API and ownership boundaries, and major options with tradeoffs.",
		},
		{
			id: "planner-2",
			role: "risk",
			provider: "openai-codex",
			model: "gpt-5.5",
			thinkingLevel: "high",
			instructions:
				"Focus on risk, implementation complexity, regressions, rollout safety, and validation strategy for each option.",
		},
		{
			id: "planner-3",
			role: "review",
			provider: "openai-codex",
			model: "gpt-5.5",
			thinkingLevel: "xhigh",
			instructions:
				"Critically review competing proposals, look for blind spots, and synthesize consensus criteria with open risks.",
		},
	],
};

export const DEFAULT_CONFIG: WorkflowConfig = {
	autoApplyBrain: true,
	delegateDisplay: "headless",
	delegatePaneAutoClose: true,
	reviewerSwarm: {
		enabled: true,
		maxConcurrency: 2,
		targets: [...DEFAULT_REVIEWER_SWARM_TARGETS],
	},
	deepPlanning: DEFAULT_DEEP_PLANNING_CONFIG,
	agents: {
		brain: {
			provider: "openai-codex",
			model: "gpt-5.5",
			thinkingLevel: "xhigh",
			instructions: BRAIN_INSTRUCTIONS,
		},
		coder: {
			provider: "openai-codex",
			model: "gpt-5.3-codex",
			thinkingLevel: "medium",
			tools: [
				"read",
				"bash",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
				"room_create",
				"room_job_start",
				"room_send",
				"room_read",
				"room_job_done",
				"room_status",
			],
			includeKarpathyGuidelines: true,
			instructions: CODER_INSTRUCTIONS,
		},
		reviewer: {
			provider: "openai-codex",
			model: "gpt-5.5",
			thinkingLevel: "high",
			tools: [
				"read",
				"bash",
				"grep",
				"find",
				"ls",
				"room_create",
				"room_job_start",
				"room_send",
				"room_read",
				"room_job_done",
				"room_status",
			],
			instructions: REVIEWER_INSTRUCTIONS,
		},
	},
};

export const DEFAULT_REVIEWER_SWARM_CONFIG = {
	enabled: true,
	maxConcurrency: 2,
	targets: [...DEFAULT_REVIEWER_SWARM_TARGETS],
};
