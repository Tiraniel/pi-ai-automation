import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowConfig, WorkflowProfile, WorkflowProfileId } from "./types";

export const GONKA_PROVIDER_NAME = "gonka";
export const GONKA_BROKER_URL_ENV = "GONKA_BROKER_URL";
export const GONKA_BROKER_API_KEY_ENV = "GONKA_BROKER_API_KEY";
export const GONKA_DEFAULT_BROKER_URL = "https://node.gonka.lat/v1";
export const GONKA_DOTENV_PATH = path.join(os.homedir(), ".pi", ".env");
export const GONKA_DOTENV_KEYS = [GONKA_BROKER_URL_ENV, GONKA_BROKER_API_KEY_ENV] as const;

/**
 * Conservative vLLM/OpenAI-compatible broker compat for the current Gonka broker.
 * The broker serves the OpenAI Chat Completions shape but does not implement
 * OpenAI's `store`, `developer` role, `reasoning_effort`, strict tool mode,
 * usage-in-stream, or long cache retention features.
 */
export const GONKA_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens" as const,
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};

export const GONKA_MODEL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const GONKA_MODELS = [
	{
		id: "moonshotai/Kimi-K2.6",
		name: "Kimi K2.6 (Gonka)",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: GONKA_MODEL_COST,
		contextWindow: 200000,
		maxTokens: 16384,
		compat: GONKA_COMPAT,
	},
	{
		id: "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8",
		name: "Qwen3 235B A22B Instruct 2507 (Gonka)",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: GONKA_MODEL_COST,
		contextWindow: 200000,
		maxTokens: 16384,
		compat: GONKA_COMPAT,
	},
	{
		id: "MiniMaxAI/MiniMax-M2.7",
		name: "MiniMax M2.7 (Gonka)",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: GONKA_MODEL_COST,
		contextWindow: 200000,
		maxTokens: 16384,
		compat: GONKA_COMPAT,
	},
];

export const GONKA_HYBRID_PROFILE_ID = "gonka-hybrid" as const;
export const GONKA_HYBRID_PROFILE_ALIAS = "premium-brain-gonka-workers" as const;

export const GONKA_HYBRID_PROFILE_APPLY: Partial<WorkflowConfig> = {
	agents: {
		coder: {
			provider: GONKA_PROVIDER_NAME,
			model: "moonshotai/Kimi-K2.6",
			thinkingLevel: "off",
		},
		reviewer: {
			provider: GONKA_PROVIDER_NAME,
			model: "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8",
			thinkingLevel: "off",
		},
	},
};

export const WORKFLOW_PROFILES: Record<WorkflowProfileId, WorkflowProfile> = {
	"default": { id: "default", label: "default (premium brain + premium coder/reviewer)", apply: {} },
	[GONKA_HYBRID_PROFILE_ID]: {
		id: GONKA_HYBRID_PROFILE_ID,
		label: "Gonka hybrid (premium brain + Gonka coder/reviewer)",
		apply: GONKA_HYBRID_PROFILE_APPLY,
	},
	[GONKA_HYBRID_PROFILE_ALIAS]: {
		id: GONKA_HYBRID_PROFILE_ALIAS,
		label: "Gonka hybrid (alias: premium-brain-gonka-workers)",
		apply: GONKA_HYBRID_PROFILE_APPLY,
	},
};

export function getGonkaBrokerUrl(): string {
	return process.env[GONKA_BROKER_URL_ENV]?.trim() || GONKA_DEFAULT_BROKER_URL;
}

export function getGonkaEnvStatus(): { url: "set" | "default"; apiKey: "set" | "unset" } {
	return {
		url: process.env[GONKA_BROKER_URL_ENV]?.trim() ? "set" : "default",
		apiKey: process.env[GONKA_BROKER_API_KEY_ENV]?.trim() ? "set" : "unset",
	};
}
