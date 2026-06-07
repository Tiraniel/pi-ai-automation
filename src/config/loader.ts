/**
 * Lazy config loader for .pi/repo-memory.json
 * Reads disk only when called; never at import time.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_AUTO_BRIEF_ENABLED,
	DEFAULT_AUTO_BRIEF_MAX_TOKENS,
	DEFAULT_AUTO_BRIEF_MIN_INTERVAL_MS,
	DEFAULT_TOOLS,
	DEFAULT_INTEGRITY,
	DEFAULT_OUTPUT_TRUNCATION_LIMIT_BYTES,
	DEFAULT_OUTPUT_TRUNCATION_LIMIT_LINES,
	DEFAULT_EVIDENCE_QUEUE,
	DEFAULT_KEEPER,
	DEFAULT_SCOUT,
} from "./defaults";
import type { ModelPreset } from "../models/presets";
import { errorMessage } from "../util/errors";

export interface RepoMemoryConfig {
	enabled: boolean;
	tools: {
		repo_context: {
			maxFiles: number;
			maxTokens: number;
			includeExcerpts: boolean;
		};
		repo_health_report: {
			maxFindings: number;
			includeGanttDefault: boolean;
			forceRefreshDefault: boolean;
		};
	};
	autoBrief: {
		enabled: boolean;
		maxTokens: number;
		minIntervalMs: number;
		includeCards: boolean;
		includeEvidence: boolean;
	};
	integrity: {
		principles: string[];
		enabled: boolean;
		maxAgeMs: number;
		defaultCategories: string[];
	};
	output: {
		defaultTruncationLimitBytes: number;
		defaultTruncationLimitLines: number;
	};
	evidenceQueue: {
		enabled: boolean;
		maxClaimLength: number;
		maxMetadataSizeBytes: number;
		dedupeWindowHours: number;
	};
	warnings: string[];
	keeper: {
		enabled: boolean;
		leaseDurationMs: number;
		maxRunTimeMs: number;
		maxTokensPerRun: number;
		batchSize: number;
		runOnAgentEnd: boolean;
		fileCardPriority: string[];
	};
	modelPresets: Record<string, Partial<ModelPreset>>;
	scouts: {
		enabled: boolean;
		runOnAgentEnd: boolean;
		maxFilesPerRun: number;
		maxFindingsPerRun: number;
		maxTokensPerRun: number;
		presets: string[];
	};
}

export function loadConfig(repoRoot: string): RepoMemoryConfig {
	const warnings: string[] = [];
	let raw: unknown = {};

	try {
		const configPath = path.join(repoRoot, ".pi", "repo-memory.json");
		if (fs.existsSync(configPath)) {
			const content = fs.readFileSync(configPath, "utf-8");
			raw = JSON.parse(content);
		}
	} catch (err) {
		warnings.push(`Config read/parse error: ${errorMessage(err)}`);
	}

	const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

	function num(v: unknown, fallback: number, min?: number, max?: number): number {
		const n = typeof v === "number" && !Number.isNaN(v) ? v : fallback;
		if (min !== undefined && n < min) return min;
		if (max !== undefined && n > max) return max;
		return n;
	}

	function bool(v: unknown, fallback: boolean): boolean {
		return typeof v === "boolean" ? v : fallback;
	}

	function arrStr(v: unknown): string[] {
		if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
		return [];
	}

	const toolsSrc = (src.tools ?? {}) as Record<string, unknown>;
	const repoContextSrc = (toolsSrc.repo_context ?? {}) as Record<string, unknown>;
	const repoHealthSrc = (toolsSrc.repo_health_report ?? {}) as Record<string, unknown>;

	const autoBriefSrc = (src.autoBrief ?? {}) as Record<string, unknown>;

	const integritySrc = (src.integrity ?? {}) as Record<string, unknown>;

	const outputSrc = (src.output ?? {}) as Record<string, unknown>;
	const evidenceQueueSrc = (src.evidenceQueue ?? {}) as Record<string, unknown>;
	const keeperSrc = (src.keeper ?? {}) as Record<string, unknown>;
	const modelPresetsSrc = (src.modelPresets ?? {}) as Record<string, unknown>;
	const scoutsSrc = (src.scouts ?? {}) as Record<string, unknown>;

	function parsePresetOverrides(raw: Record<string, unknown>): Record<string, Partial<ModelPreset>> {
		const out: Record<string, Partial<ModelPreset>> = {};
		for (const [key, val] of Object.entries(raw)) {
			if (val && typeof val === "object") {
				const v = val as Record<string, unknown>;
				const preset: Partial<ModelPreset> = { name: key };
				if (typeof v.description === "string") preset.description = v.description;
				if (typeof v.providerHint === "string") preset.providerHint = v.providerHint;
				if (typeof v.modelHint === "string") preset.modelHint = v.modelHint;
				if (typeof v.temperature === "number") preset.temperature = v.temperature;
				if (typeof v.maxTokens === "number") preset.maxTokens = v.maxTokens;
				if (typeof v.thinkingLevel === "string") preset.thinkingLevel = v.thinkingLevel as ModelPreset["thinkingLevel"];
				if (typeof v.systemPrompt === "string") preset.systemPrompt = v.systemPrompt;
				if (typeof v.enabled === "boolean") preset.enabled = v.enabled;
				if (typeof v.budgetMs === "number") preset.budgetMs = v.budgetMs;
				if (typeof v.budgetTokens === "number") preset.budgetTokens = v.budgetTokens;
				if (typeof v.fallbackBehavior === "string") preset.fallbackBehavior = v.fallbackBehavior as ModelPreset["fallbackBehavior"];
				out[key] = preset;
			}
		}
		return out;
	}

	return {
		enabled: bool(src.enabled, true),
		tools: {
			repo_context: {
				maxFiles: num(repoContextSrc.maxFiles, DEFAULT_TOOLS.repo_context.maxFiles, 1, 100),
				maxTokens: num(repoContextSrc.maxTokens, DEFAULT_TOOLS.repo_context.maxTokens, 100, 100000),
				includeExcerpts: bool(repoContextSrc.includeExcerpts, DEFAULT_TOOLS.repo_context.includeExcerpts),
			},
			repo_health_report: {
				maxFindings: num(repoHealthSrc.maxFindings, DEFAULT_TOOLS.repo_health_report.maxFindings, 1, 1000),
				includeGanttDefault: bool(repoHealthSrc.includeGanttDefault, DEFAULT_TOOLS.repo_health_report.includeGanttDefault),
				forceRefreshDefault: bool(repoHealthSrc.forceRefreshDefault, DEFAULT_TOOLS.repo_health_report.forceRefreshDefault),
			},
		},
		autoBrief: {
			enabled: bool(autoBriefSrc.enabled, DEFAULT_AUTO_BRIEF_ENABLED),
			maxTokens: num(autoBriefSrc.maxTokens, DEFAULT_AUTO_BRIEF_MAX_TOKENS, 100, 50000),
			minIntervalMs: num(autoBriefSrc.minIntervalMs, DEFAULT_AUTO_BRIEF_MIN_INTERVAL_MS, 0, 86400000),
			includeCards: bool(autoBriefSrc.includeCards, false),
			includeEvidence: bool(autoBriefSrc.includeEvidence, false),
		},
		integrity: {
			principles: arrStr(integritySrc.principles).length > 0
				? arrStr(integritySrc.principles)
				: DEFAULT_INTEGRITY.principles,
			enabled: bool(integritySrc.enabled, DEFAULT_INTEGRITY.enabled),
			maxAgeMs: num(integritySrc.maxAgeMs, DEFAULT_INTEGRITY.maxAgeMs, 0, 86400000),
			defaultCategories: arrStr(integritySrc.defaultCategories).length > 0
				? arrStr(integritySrc.defaultCategories)
				: DEFAULT_INTEGRITY.defaultCategories,
		},
		output: {
			defaultTruncationLimitBytes: num(
				outputSrc.defaultTruncationLimitBytes,
				DEFAULT_OUTPUT_TRUNCATION_LIMIT_BYTES,
				1024,
				10_000_000,
			),
			defaultTruncationLimitLines: num(
				outputSrc.defaultTruncationLimitLines,
				DEFAULT_OUTPUT_TRUNCATION_LIMIT_LINES,
				10,
				100_000,
			),
		},
		evidenceQueue: {
			enabled: bool(evidenceQueueSrc.enabled, DEFAULT_EVIDENCE_QUEUE.enabled),
			maxClaimLength: num(evidenceQueueSrc.maxClaimLength, DEFAULT_EVIDENCE_QUEUE.maxClaimLength, 1, 10000),
			maxMetadataSizeBytes: num(evidenceQueueSrc.maxMetadataSizeBytes, DEFAULT_EVIDENCE_QUEUE.maxMetadataSizeBytes, 128, 1_000_000),
			dedupeWindowHours: num(evidenceQueueSrc.dedupeWindowHours, DEFAULT_EVIDENCE_QUEUE.dedupeWindowHours, 1, 8760),
		},
		keeper: {
			enabled: bool(keeperSrc.enabled, DEFAULT_KEEPER.enabled),
			leaseDurationMs: num(keeperSrc.leaseDurationMs, DEFAULT_KEEPER.leaseDurationMs, 1000, 3600000),
			maxRunTimeMs: num(keeperSrc.maxRunTimeMs, DEFAULT_KEEPER.maxRunTimeMs, 1000, 600000),
			maxTokensPerRun: num(keeperSrc.maxTokensPerRun, DEFAULT_KEEPER.maxTokensPerRun, 1000, 500000),
			batchSize: num(keeperSrc.batchSize, DEFAULT_KEEPER.batchSize, 1, 500),
			runOnAgentEnd: bool(keeperSrc.runOnAgentEnd, DEFAULT_KEEPER.runOnAgentEnd),
			fileCardPriority: arrStr(keeperSrc.fileCardPriority).length > 0
				? arrStr(keeperSrc.fileCardPriority)
				: DEFAULT_KEEPER.fileCardPriority,
		},
		modelPresets: parsePresetOverrides(modelPresetsSrc),
		scouts: {
			enabled: bool(scoutsSrc.enabled, DEFAULT_SCOUT.enabled),
			runOnAgentEnd: bool(scoutsSrc.runOnAgentEnd, DEFAULT_SCOUT.runOnAgentEnd),
			maxFilesPerRun: num(scoutsSrc.maxFilesPerRun, DEFAULT_SCOUT.maxFilesPerRun, 1, 1000),
			maxFindingsPerRun: num(scoutsSrc.maxFindingsPerRun, DEFAULT_SCOUT.maxFindingsPerRun, 1, 1000),
			maxTokensPerRun: num(scoutsSrc.maxTokensPerRun, DEFAULT_SCOUT.maxTokensPerRun, 1000, 500000),
			presets: arrStr(scoutsSrc.presets).length > 0 ? arrStr(scoutsSrc.presets) : DEFAULT_SCOUT.presets,
		},
		warnings,
	};
}
