/**
 * Hard-coded defaults for pi-ai-automation-memory.
 * Future TASK-003+ will load .pi/repo-memory.json overrides.
 */

export const DEFAULT_CACHE_BASE = "~/.pi/agent/repo-memory";

export const DEFAULT_AUTO_BRIEF_ENABLED = true;
export const DEFAULT_AUTO_BRIEF_MAX_TOKENS = 4000;
export const DEFAULT_AUTO_BRIEF_MIN_INTERVAL_MS = 30000;

export const DEFAULT_TOOLS = {
	repo_context: { maxFiles: 30, maxTokens: 8000 },
	repo_health_report: { maxFindings: 20, includeGanttDefault: false, forceRefreshDefault: false },
} as const;

export const DEFAULT_KEEPER = {
	enabled: true,
	leaseDurationMs: 300000,
	maxRunTimeMs: 30000,
	maxTokensPerRun: 50000,
	batchSize: 10,
	runOnAgentEnd: true,
	fileCardPriority: ["missing", "stale", "fresh"] as string[],
} as const;

export const DEFAULT_INTEGRITY = {
	enabled: true,
	maxAgeMs: 3600000,
	principles: [] as string[],
	defaultCategories: [
		"test_coverage",
		"type_safety",
		"doc_freshness",
		"dependency_risk",
		"architectural_drift",
		"security",
	] as string[],
} as const;

export const DEFAULT_EVIDENCE_QUEUE = {
	enabled: true,
	maxClaimLength: 500,
	maxMetadataSizeBytes: 4096,
	dedupeWindowHours: 168,
} as const;

export const DEFAULT_OUTPUT_TRUNCATION_LIMIT_BYTES = 50000;
export const DEFAULT_OUTPUT_TRUNCATION_LIMIT_LINES = 2000;

export const DEFAULT_SECURITY = {
	redactionEnabled: true,
	secretExclusions: [] as string[],
	allowSecretFilesInIndex: false,
} as const;

export const DEFAULT_SCOUT = {
	enabled: false,
	runOnAgentEnd: false,
	maxFilesPerRun: 50,
	maxFindingsPerRun: 20,
	maxTokensPerRun: 32000,
	presets: ["scout_broad"] as string[],
} as const;
