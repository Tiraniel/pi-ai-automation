/**
 * Provider-agnostic model preset definitions.
 * Stubs for future TASK-009 implementation.
 *
 * Presets describe how to invoke an LLM for a specific memory task
 * without hard-coding to any single provider (Gonka, OpenAI, etc.).
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelPreset {
	name: string;
	description: string;
	providerHint?: string;
	modelHint?: string;
	temperature?: number;
	maxTokens?: number;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: string;
	enabled: boolean;
	budgetMs?: number;
	budgetTokens?: number;
	fallbackBehavior: "error" | "skip" | "degrade";
}

export const BUILT_IN_PRESETS: Record<string, ModelPreset> = {
	index_keeper: {
		name: "index_keeper",
		description: "Generate or update file cards in the deterministic index",
		enabled: true,
		temperature: 0.2,
		budgetMs: 30000,
		budgetTokens: 16000,
		fallbackBehavior: "skip",
	},
	scout_broad: {
		name: "scout_broad",
		description: "Cross-file pattern scan and TODO finder",
		enabled: false,
		temperature: 0.2,
		budgetMs: 60000,
		budgetTokens: 32000,
		fallbackBehavior: "skip",
	},
	scout_deep: {
		name: "scout_deep",
		description: "Deep architectural analysis across the repo",
		enabled: false,
		temperature: 0.2,
		budgetMs: 120000,
		budgetTokens: 64000,
		fallbackBehavior: "skip",
	},
	integrity_keeper: {
		name: "integrity_keeper",
		description: "Generate ranked health findings",
		enabled: true,
		temperature: 0.2,
		budgetMs: 60000,
		budgetTokens: 32000,
		fallbackBehavior: "skip",
	},
};

/**
 * Resolve a preset by name. Returns undefined if not found.
 * Future TASK-009 will merge user config overrides here.
 */
export function resolvePreset(name: string): ModelPreset | undefined {
	return BUILT_IN_PRESETS[name];
}
