import {
	BRAIN_INSTRUCTIONS,
	CODER_INSTRUCTIONS,
	DEFAULT_REVIEWER_SWARM_TARGETS,
	REVIEWER_INSTRUCTIONS,
} from "./prompts";
import type { WorkflowConfig } from "./types";

export const DEFAULT_CONFIG: WorkflowConfig = {
	autoApplyBrain: true,
	delegateDisplay: "headless",
	delegatePaneAutoClose: true,
	reviewerSwarm: {
		enabled: true,
		maxConcurrency: 2,
		targets: [...DEFAULT_REVIEWER_SWARM_TARGETS],
	},
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
