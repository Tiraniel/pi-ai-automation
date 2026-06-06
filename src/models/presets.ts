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

function clampPreset(p: ModelPreset): ModelPreset {
	return {
		...p,
		temperature: p.temperature === undefined ? undefined : Math.max(0, Math.min(2, p.temperature)),
		maxTokens: p.maxTokens === undefined ? undefined : Math.max(1, Math.floor(p.maxTokens)),
		budgetMs: p.budgetMs === undefined ? undefined : Math.max(1000, Math.floor(p.budgetMs)),
		budgetTokens: p.budgetTokens === undefined ? undefined : Math.max(1000, Math.floor(p.budgetTokens)),
		fallbackBehavior: ["error", "skip", "degrade"].includes(p.fallbackBehavior) ? p.fallbackBehavior : "skip",
		enabled: !!p.enabled,
	};
}

function mergePreset(base: ModelPreset, override: Partial<ModelPreset>): ModelPreset {
	return clampPreset({
		...base,
		...override,
		name: override.name ?? base.name,
		fallbackBehavior: override.fallbackBehavior ?? base.fallbackBehavior,
		enabled: override.enabled !== undefined ? override.enabled : base.enabled,
	});
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
 * Resolve a preset by name, merging built-in defaults with user overrides.
 * Unknown preset names are accepted if they have a name in overrides.
 */
export function resolvePreset(name: string, overrides?: Record<string, Partial<ModelPreset>>): ModelPreset | undefined {
	const builtIn = BUILT_IN_PRESETS[name];
	const override = overrides?.[name];
	if (!builtIn) {
		if (override && typeof override.name === "string" && override.name) {
			return clampPreset({
				name: override.name,
				description: override.description ?? "",
				enabled: false,
				fallbackBehavior: "skip",
				...override,
			} as ModelPreset);
		}
		return undefined;
	}
	if (!override) return builtIn;
	return mergePreset(builtIn, override);
}

/**
 * Resolve all presets: built-ins merged with overrides, plus any unknown presets from overrides.
 */
export function resolveAllPresets(overrides?: Record<string, Partial<ModelPreset>>): Record<string, ModelPreset> {
	const result: Record<string, ModelPreset> = {};
	for (const [name, preset] of Object.entries(BUILT_IN_PRESETS)) {
		result[name] = resolvePreset(name, overrides) ?? preset;
	}
	if (overrides) {
		for (const [name, override] of Object.entries(overrides)) {
			if (!result[name]) {
				const resolved = resolvePreset(name, overrides);
				if (resolved) result[name] = resolved;
			}
		}
	}
	return result;
}
