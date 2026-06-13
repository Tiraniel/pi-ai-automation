import {
	BRAIN_INSTRUCTIONS,
	CODER_INSTRUCTIONS,
	DEFAULT_REVIEWER_SWARM_TARGETS,
	REVIEWER_INSTRUCTIONS,
} from "./prompts";
import type { DeepPlanningConfig, WorkflowConfig } from "./types";

const DEFAULT_DEEP_PLANNING_CONFIG: DeepPlanningConfig = {
	enabled: false,
	plannerCount: 2,
	maxConcurrency: 2,
	rounds: 2,
	roomIdPrefix: "deep-plan",
	planners: [
		{
			id: "pr-agent-1",
			role: "product-requirements",
			provider: "openai-codex",
			model: "gpt-5.5",
			thinkingLevel: "xhigh",
			instructions:
				"You are a Product Requirements agent. In a bounded grill-me discussion with one other PR agent, ask at most one highest-value question per round with a recommended answer. Inspect the codebase (read, grep, find, ls) before asking when possible. Update the shared PRD with resolved decisions and open questions. Do not produce implementation plans or code. Final output must include: PRD draft, resolved decisions, unresolved user questions, options, risks, ready_for_sprint: yes|no.",
		},
		{
			id: "pr-agent-2",
			role: "product-requirements",
			provider: "openai-codex",
			model: "gpt-5.5",
			thinkingLevel: "xhigh",
			instructions:
				"You are a Product Requirements agent. In a bounded grill-me discussion with one other PR agent, ask at most one highest-value question per round with a recommended answer. Inspect the codebase (read, grep, find, ls) before asking when possible. Update the shared PRD with resolved decisions and open questions. Do not produce implementation plans or code. Final output must include: PRD draft, resolved decisions, unresolved user questions, options, risks, ready_for_sprint: yes|no.",
		},
	],
};

export const DEFAULT_CONFIG: WorkflowConfig = {
	autoApplyBrain: true,
	delegateDisplay: "headless",
	delegatePaneAutoClose: true,
	semanticNavigation: {
		enabled: false,
		provider: "serena",
		mode: "disabled",
		fallbackToBuiltinTools: true,
		roles: {
			brain: "readonly",
			coder: "edit",
			reviewer: "readonly",
		},
		serenaReadonlyTools: [],
		serenaEditTools: [],
		serenaProjectTools: [],
	},
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
