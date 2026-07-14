// Workflow runtime — config/profile/preset/Brain-preset helpers.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 2.
// This module is the thin seam between disk-backed workflow configuration
// (Gonka dotenv, profile resolution, project/global JSON) and the rest of
// the v1 runtime. It owns:
//   - Gonka dotenv loading (loadGonkaEnvFromDefaultDotenv)
//   - Profile selection and merging (loadWorkflowConfig, getWorkflowProfile)
//   - Model/preset label helpers (resolveModelArg, resolveModelLabel,
//     getAgentPreset, formatPreset)
//   - The Brain-preset applier invoked on session_start (applyBrainPreset)
//
// Everything else (delegate spawning, event streaming, cmux, room tools) is
// composition that lives in extensions/brain-workflow.ts and the room
// subsystem.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG } from "../defaults";
import { withSemanticNavigationPromptGuidance } from "../prompts";
import { GONKA_DOTENV_KEYS, GONKA_DOTENV_PATH, WORKFLOW_PROFILES } from "../profiles";
import { adaptV2ResolvedWorkflow } from "./v2-adapter";
import { detectConfigVersion, loadV2Workflow, normalizeSemanticNavigationConfig, normalizeV1Config } from "../config";
import { readDeepPlanningConfig } from "../config/deep-planning.js";
import {
	SEMANTIC_NAVIGATION_MODES,
	SEMANTIC_NAVIGATION_PROVIDERS,
} from "../types";
import type {
	AgentName,
	AgentPreset,
	LoadedWorkflowConfig,
	WorkflowConfig,
	WorkflowProfile,
	WorkflowProfileId,
	WorkflowProfileSource,
	WorkflowConfigSourceInfo,
	WorkflowConfigLoadDiagnostic,
} from "../types";

// ============================================================================
// Gonka dotenv loading
// ============================================================================

function parseGonkaDotenvValue(rawValue: string): string {
	let value = rawValue.trim();
	if (!value) return "";

	const quote = value[0];
	if ((quote === '"' || quote === "'") && value.length > 1) {
		const end = value.lastIndexOf(quote);
		value = end > 0 ? value.slice(1, end) : value.slice(1);
		if (quote === '"') {
			value = value
				.replace(/\\n/g, "\n")
				.replace(/\\r/g, "\r")
				.replace(/\\t/g, "\t")
				.replace(/\\"/g, '"')
				.replace(/\\\\/g, "\\");
		}
		return value;
	}

	const commentStart = value.search(/\s#/);
	if (commentStart >= 0) value = value.slice(0, commentStart).trim();
	return value;
}

export function loadGonkaEnvFromDefaultDotenv(): void {
	let text: string;
	try {
		text = fs.readFileSync(GONKA_DOTENV_PATH, "utf8");
	} catch {
		return;
	}

	for (const rawLine of text.split(/\r?\n/)) {
		let line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("export ")) line = line.slice("export ".length).trim();

		const separator = line.indexOf("=");
		if (separator <= 0) continue;

		const key = line.slice(0, separator).trim();
		if (!GONKA_DOTENV_KEYS.includes(key as (typeof GONKA_DOTENV_KEYS)[number])) continue;
		if (process.env[key]?.trim()) continue;

		const value = parseGonkaDotenvValue(line.slice(separator + 1));
		if (value.trim()) process.env[key] = value;
	}
}

// ============================================================================
// Workflow profile / config helpers
// ============================================================================

function readWorkflowProfileFlagFromArgv(): string | undefined {
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--workflow-profile" && i + 1 < argv.length) {
			const value = argv[i + 1].trim();
			return value || undefined;
		}
		if (arg.startsWith("--workflow-profile=")) {
			const value = arg.slice("--workflow-profile=".length).trim();
			return value || undefined;
		}
	}
	return undefined;
}

function normalizeWorkflowProfileId(value: string | undefined | null): WorkflowProfileId {
	const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (candidate && candidate in WORKFLOW_PROFILES) {
		return candidate as WorkflowProfileId;
	}
	return "default";
}

function hasWorkflowProfileValue(value: string | undefined | null): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function resolveWorkflowProfileSelection(
	cliProfile: string | undefined,
	globalConfig: WorkflowConfig,
	projectConfig: WorkflowConfig,
	localConfig: WorkflowConfig,
): { id: WorkflowProfileId; source: WorkflowProfileSource; selectedFromLocalOverride: boolean } {
	if (hasWorkflowProfileValue(cliProfile)) return { id: normalizeWorkflowProfileId(cliProfile), source: "cli", selectedFromLocalOverride: false };
	if (hasWorkflowProfileValue(localConfig.profile)) {
		return { id: normalizeWorkflowProfileId(localConfig.profile), source: "project", selectedFromLocalOverride: true };
	}
	if (hasWorkflowProfileValue(projectConfig.profile)) {
		return { id: normalizeWorkflowProfileId(projectConfig.profile), source: "project", selectedFromLocalOverride: false };
	}
	if (hasWorkflowProfileValue(globalConfig.profile)) {
		return { id: normalizeWorkflowProfileId(globalConfig.profile), source: "global", selectedFromLocalOverride: false };
	}
	return { id: "default", source: "default", selectedFromLocalOverride: false };
}

export function getWorkflowProfile(id: WorkflowProfileId): WorkflowProfile {
	return WORKFLOW_PROFILES[id] ?? WORKFLOW_PROFILES["default"];
}

function applyWorkflowProfile(config: WorkflowConfig, profileId: WorkflowProfileId): WorkflowConfig {
	return deepMerge(config, getWorkflowProfile(profileId).apply);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeWorkflowDiagnostic(
	scope: WorkflowConfigLoadDiagnostic["scope"],
	severity: WorkflowConfigLoadDiagnostic["severity"],
	code: string,
	message: string,
	source?: string,
): WorkflowConfigLoadDiagnostic {
	return { scope, severity, code, message, source };
}

function dedupeWorkflowDiagnostics(diagnostics: WorkflowConfigLoadDiagnostic[]): WorkflowConfigLoadDiagnostic[] {
	const seen = new Set<string>();
	const out: WorkflowConfigLoadDiagnostic[] = [];
	for (const diag of diagnostics) {
		const signature = `${diag.severity}|${diag.code}|${diag.message}|${diag.source ?? ""}`;
		if (seen.has(signature)) continue;
		seen.add(signature);
		out.push(diag);
	}
	return out;
}

function mapV2Diagnostics(
	scope: WorkflowConfigLoadDiagnostic["scope"],
	diagnostics: { severity: string; code: string; message: string; ref?: { id?: string } }[],
): WorkflowConfigLoadDiagnostic[] {
	return diagnostics.map((diag) => makeWorkflowDiagnostic(scope, diag.severity as WorkflowConfigLoadDiagnostic["severity"], diag.code, diag.message, diag.ref?.id));
}

function hasOwnProperty(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function formatDiagnosticValue(value: unknown): string {
	const formatted = JSON.stringify(value);
	return formatted === undefined ? String(value) : formatted;
}

function hasInvalidSemanticNavigationProvider(record: Record<string, unknown>): boolean {
	if (!hasOwnProperty(record, "provider")) return false;
	const value = record.provider;
	return typeof value !== "string"
		|| !(SEMANTIC_NAVIGATION_PROVIDERS as readonly string[]).includes(value);
}

function hasInvalidSemanticNavigationMode(record: Record<string, unknown>): boolean {
	if (!hasOwnProperty(record, "mode")) return false;
	const value = record.mode;
	return typeof value !== "string"
		|| !(SEMANTIC_NAVIGATION_MODES as readonly string[]).includes(value);
}

function collectSemanticNavigationDiagnostics(
	scope: WorkflowConfigLoadDiagnostic["scope"],
	rawConfig: unknown,
): WorkflowConfigLoadDiagnostic[] {
	if (!isPlainObject(rawConfig) || !isPlainObject(rawConfig.semanticNavigation)) return [];
	const diagnostics: WorkflowConfigLoadDiagnostic[] = [];
	const semanticNavigation = rawConfig.semanticNavigation;
	if (hasInvalidSemanticNavigationProvider(semanticNavigation)) {
		diagnostics.push(makeWorkflowDiagnostic(
			scope,
			"warning",
			"semantic-navigation-provider-unsupported",
			`semanticNavigation.provider ${formatDiagnosticValue(semanticNavigation.provider)} is unsupported; supported provider: serena. Falling back to the default disabled Serena config.`,
			"semanticNavigation.provider",
		));
	}
	if (hasInvalidSemanticNavigationMode(semanticNavigation)) {
		const futureNote = semanticNavigation.mode === "managed" ? " Managed mode is future scope and is not implemented in this MVP." : "";
		diagnostics.push(makeWorkflowDiagnostic(
			scope,
			"warning",
			"semantic-navigation-mode-unsupported",
			`semanticNavigation.mode ${formatDiagnosticValue(semanticNavigation.mode)} is unsupported; supported modes: disabled, external.${futureNote} Falling back to disabled mode.`,
			"semanticNavigation.mode",
		));
	}
	return diagnostics;
}

function normalizeRuntimeSemanticNavigationOverride(raw: unknown): WorkflowConfig["semanticNavigation"] | undefined {
	if (!isPlainObject(raw) || !("semanticNavigation" in raw)) return undefined;
	const semanticNavigation = raw.semanticNavigation;
	if (!isPlainObject(semanticNavigation)) return undefined;
	if (hasInvalidSemanticNavigationProvider(semanticNavigation) || hasInvalidSemanticNavigationMode(semanticNavigation)) {
		return { enabled: false, provider: "serena", mode: "disabled" };
	}
	return normalizeSemanticNavigationConfig(semanticNavigation);
}

function overlayNormalizedSemanticNavigation(raw: unknown, config: WorkflowConfig): WorkflowConfig {
	if (!isPlainObject(raw) || !("semanticNavigation" in raw)) return config;
	const next: WorkflowConfig = { ...config };
	const normalized = normalizeRuntimeSemanticNavigationOverride(raw);
	if (normalized) next.semanticNavigation = normalized;
	else delete next.semanticNavigation;
	return next;
}

function extractV2RuntimeOverrides(rawConfig: unknown): WorkflowConfig {
	const normalized = normalizeV1Config(rawConfig);
	if (!normalized) return {};
	const runtime: WorkflowConfig = {};
	if (normalized.autoApplyBrain !== undefined) runtime.autoApplyBrain = normalized.autoApplyBrain;
	if (normalized.profile !== undefined) runtime.profile = normalized.profile;
	if (normalized.reviewerSwarm !== undefined) {
		const reviewerSwarm: WorkflowConfig["reviewerSwarm"] = {};
		if (normalized.reviewerSwarm.enabled !== undefined) reviewerSwarm.enabled = normalized.reviewerSwarm.enabled;
		if (normalized.reviewerSwarm.maxConcurrency !== undefined) reviewerSwarm.maxConcurrency = normalized.reviewerSwarm.maxConcurrency;
		if (reviewerSwarm.enabled !== undefined || reviewerSwarm.maxConcurrency !== undefined) {
			runtime.reviewerSwarm = reviewerSwarm;
		}
	}
	if (normalized.delegateDisplay !== undefined) runtime.delegateDisplay = normalized.delegateDisplay;
	if (normalized.delegatePaneAutoClose !== undefined) runtime.delegatePaneAutoClose = normalized.delegatePaneAutoClose;
	if (normalized.delegateFallbacks !== undefined) runtime.delegateFallbacks = normalized.delegateFallbacks;
	if (normalized.evidence !== undefined) runtime.evidence = normalized.evidence;
	if (normalized.loopBudget !== undefined) runtime.loopBudget = normalized.loopBudget;
	const semanticNavigation = normalizeRuntimeSemanticNavigationOverride(rawConfig);
	if (semanticNavigation !== undefined) runtime.semanticNavigation = semanticNavigation;
	return runtime;
}

function ensureV1Config(value: unknown): WorkflowConfig {
	if (isPlainObject(value)) return value as WorkflowConfig;
	return {};
}

function loadV2WorkflowConfig(scope: "global" | "project", filePath: string): {
	config: WorkflowConfig;
	source: WorkflowConfigSourceInfo;
	diagnostics: WorkflowConfigLoadDiagnostic[];
} {
	let sourceDiagnostics: WorkflowConfigLoadDiagnostic[] = [];
	const source: WorkflowConfigSourceInfo = {
		scope,
		path: filePath,
		exists: false,
		format: "v1",
		selected: false,
		diagnostics: sourceDiagnostics,
	};
	if (!fs.existsSync(filePath)) {
		return { config: {}, source, diagnostics: sourceDiagnostics };
	}
	source.exists = true;
	try {
		const fileText = fs.readFileSync(filePath, "utf-8");
		const raw = JSON.parse(fileText) as unknown;
		sourceDiagnostics.push(...collectSemanticNavigationDiagnostics(scope, raw));
		source.version = detectConfigVersion(raw) || 1;
		source.format = source.version === 2 ? "v2" : "v1";

		if (source.version === 2) {
			const loadedWorkflow = loadV2Workflow(filePath);
			sourceDiagnostics.push(...mapV2Diagnostics(scope, loadedWorkflow.diagnostics));
			if (loadedWorkflow.sourceMeta) {
				source.managedBy = loadedWorkflow.sourceMeta.managedBy;
				source.managedVersion = loadedWorkflow.sourceMeta.managedVersion;
			}
			if (!loadedWorkflow.workflow || !loadedWorkflow.resolved) {
				if (!sourceDiagnostics.some((item) => item.severity === "error")) {
					sourceDiagnostics.push(
						makeWorkflowDiagnostic(scope, "error", "workflow-unresolved", "V2 workflow could not be resolved."),
					);
				}
				return { config: {}, source, diagnostics: sourceDiagnostics };
			}
			const adapted = adaptV2ResolvedWorkflow(
				loadedWorkflow.resolved,
				{ scope, path: filePath },
				loadedWorkflow.diagnostics,
				loadedWorkflow.sourceMeta,
				loadedWorkflow.catalogs,
			);
			source.version = adapted.source.version;
			if (adapted.source.managedBy) source.managedBy = adapted.source.managedBy;
			if (adapted.source.managedVersion) source.managedVersion = adapted.source.managedVersion;
			sourceDiagnostics = dedupeWorkflowDiagnostics([
				...sourceDiagnostics,
				...adapted.diagnostics.map((diag) =>
					makeWorkflowDiagnostic(scope, diag.severity as WorkflowConfigLoadDiagnostic["severity"], diag.code, diag.message, diag.ref?.id),
				),
			]);
			source.diagnostics = sourceDiagnostics;
			const runtimeOverrides = extractV2RuntimeOverrides(raw);
			return {
				config: deepMerge(adapted.config, runtimeOverrides),
				source,
				diagnostics: sourceDiagnostics,
			};
		}

		let config = ensureV1Config(raw);
		config = overlayNormalizedSemanticNavigation(raw, config);
		if (isPlainObject(raw)) {
			const deepPlanning = readDeepPlanningConfig(raw);
			if (deepPlanning) {
				config.deepPlanning = deepPlanning;
			}
		}
		return { config, source, diagnostics: sourceDiagnostics };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		sourceDiagnostics.push(makeWorkflowDiagnostic(scope, "error", "workflow-read-failed", message));
		return { config: {}, source, diagnostics: sourceDiagnostics };
	}
}

// Private: the config merge ladder is an implementation detail of this
// module. Callers get merged config through loadWorkflowConfig, never by
// reusing the merge primitive.
function deepMerge<T>(base: T, override: unknown): T {
	if (override === undefined) return base;
	if (Array.isArray(base) || Array.isArray(override)) return override as T;
	if (!isPlainObject(base) || !isPlainObject(override)) return override as T;

	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		result[key] = key in result ? deepMerge(result[key], value) : value;
	}
	return result as T;
}

function readJsonFile<T = Record<string, unknown>>(filePath: string): T | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch (error) {
		console.error(`[brain-workflow] Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function findNearestFile(cwd: string, relativePath: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, relativePath);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function hasRuntimeConfigFields(config: WorkflowConfig): boolean {
	const hasAgents = Boolean(config.agents && Object.keys(config.agents).length > 0);
	const hasReviewerSwarm = Boolean(config.reviewerSwarm && Object.keys(config.reviewerSwarm).length > 0);
	const hasDeepPlanning = Boolean(config.deepPlanning && Object.keys(config.deepPlanning).length > 0);
	const hasSemanticNavigation = Boolean(config.semanticNavigation && Object.keys(config.semanticNavigation).length > 0);
	return Boolean(
		config.profile
		|| config.delegateDisplay
		|| config.delegatePaneAutoClose !== undefined
		|| hasReviewerSwarm
		|| hasDeepPlanning
		|| hasSemanticNavigation
		|| hasAgents,
	);
}

export function loadWorkflowConfig(cwd: string, options?: { cliProfile?: string }): LoadedWorkflowConfig {
	const globalPath = path.join(getAgentDir(), "workflow.json");
	const projectPath = findNearestFile(cwd, path.join(".pi", "workflow.json"));
	const projectOverridePath = findNearestFile(cwd, path.join(".pi", "workflow.local.json"));
	const projectSettingsPath = findNearestFile(cwd, path.join(".pi", "settings.json"));

	const globalLoaded = loadV2WorkflowConfig("global", globalPath);
	const projectLoaded = projectPath ? loadV2WorkflowConfig("project", projectPath) : undefined;
	const projectOverrideLoaded = projectOverridePath ? loadV2WorkflowConfig("project", projectOverridePath) : undefined;

	const globalConfig = globalLoaded.config;
	const projectConfig = projectLoaded?.config ?? {};
	const projectOverrideConfig = projectOverrideLoaded?.config ?? {};
	const projectSettings = projectSettingsPath ? readJsonFile<Record<string, unknown>>(projectSettingsPath) : undefined;

	const cliProfile = options?.cliProfile ?? readWorkflowProfileFlagFromArgv();
	const profileSelection = resolveWorkflowProfileSelection(cliProfile, globalConfig, projectConfig, projectOverrideConfig);
	const { id: profileId, source: profileSource, selectedFromLocalOverride } = profileSelection;

	let config = DEFAULT_CONFIG;
	if (profileSource === "global") config = applyWorkflowProfile(config, profileId);
	config = deepMerge(config, globalConfig);
	if (profileSource === "project" && !selectedFromLocalOverride) config = applyWorkflowProfile(config, profileId);
	config = deepMerge(config, projectConfig);
	if (profileSource === "project" && selectedFromLocalOverride) config = applyWorkflowProfile(config, profileId);
	config = deepMerge(config, projectOverrideConfig);
	if (profileSource === "cli") config = applyWorkflowProfile(config, profileId);

	const allSources: WorkflowConfigSourceInfo[] = [
		globalLoaded.source,
		...(projectLoaded ? [projectLoaded.source] : []),
		...(projectOverrideLoaded ? [projectOverrideLoaded.source] : []),
	];
	for (const source of allSources) {
		source.selected = source.scope === "global"
			? profileSource === "global" || profileSource === "default"
			: source.path === projectOverridePath
				? hasRuntimeConfigFields(projectOverrideConfig)
				: source.path === projectPath && profileSource === "project" && !selectedFromLocalOverride;
	}

	const configDiagnostics: WorkflowConfigLoadDiagnostic[] = [
		...globalLoaded.diagnostics,
		...(projectLoaded ? projectLoaded.diagnostics : []),
		...(projectOverrideLoaded ? projectOverrideLoaded.diagnostics : []),
	];

	return {
		config,
		globalPath,
		projectPath,
		projectOverridePath,
		projectSettingsPath,
		projectSettings,
		profileId,
		profileSource,
		sources: allSources,
		configDiagnostics,
	};
}

// ============================================================================
// Model / preset helpers
// ============================================================================

export function resolveModelArg(preset: AgentPreset): string | undefined {
	if (!preset.model) return undefined;
	if (!preset.provider) return preset.model;
	const providerPrefix = `${preset.provider}/`;
	if (preset.model.toLowerCase().startsWith(providerPrefix.toLowerCase())) return preset.model;
	// Always prefer provider/model so OpenAI-compatible broker model ids that
	// already contain a slash (e.g. gonka/moonshotai/Kimi-K2.6) still resolve
	// to the right provider when launched as a child delegate.
	return `${preset.provider}/${preset.model}`;
}

export function resolveModelLabel(preset: AgentPreset): string {
	const model = resolveModelArg(preset) ?? "default";
	return preset.thinkingLevel ? `${model}:${preset.thinkingLevel}` : model;
}

export function getAgentPreset(config: WorkflowConfig, agent: AgentName): AgentPreset {
	const preset = config.agents?.[agent] ?? DEFAULT_CONFIG.agents![agent];
	return withSemanticNavigationPromptGuidance(preset, agent, config.semanticNavigation);
}

export function formatPreset(agent: AgentName, preset: AgentPreset): string {
	return `${agent}: ${resolveModelLabel(preset)}${preset.tools ? ` tools=${preset.tools.join(",")}` : ""}`;
}

// ============================================================================
// Brain preset
// ============================================================================

function hasCliFlag(flagNames: string[]): boolean {
	const argv = process.argv.slice(2);
	return argv.some((arg) => flagNames.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

function projectSettingHas(projectSettings: Record<string, unknown> | undefined, keys: string[]): boolean {
	return Boolean(projectSettings && keys.some((key) => Object.prototype.hasOwnProperty.call(projectSettings, key)));
}

export async function applyBrainPreset(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (process.env.PI_WORKFLOW_CHILD === "1") return;
	const cliProfile = pi.getFlag("workflow-profile") as string | undefined;
	const loaded = loadWorkflowConfig(ctx.cwd, { cliProfile });
	if (loaded.config.autoApplyBrain === false) return;

	const brain = getAgentPreset(loaded.config, "brain");
	const projectOverridesWorkflow = Boolean(loaded.projectPath || loaded.projectOverridePath);
	const explicitModel = hasCliFlag(["--model", "--provider"]);
	const explicitThinking = hasCliFlag(["--thinking"]);
	const projectSettingsHasModel = projectSettingHas(loaded.projectSettings, ["defaultProvider", "defaultModel"]);
	const projectSettingsHasThinking = projectSettingHas(loaded.projectSettings, ["defaultThinkingLevel"]);

	if (!explicitModel && (projectOverridesWorkflow || !projectSettingsHasModel) && brain.provider && brain.model) {
		const model = ctx.modelRegistry.find(brain.provider, brain.model);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) ctx.ui.notify(`Brain workflow: no auth for ${brain.provider}/${brain.model}`, "warning");
		} else {
			ctx.ui.notify(`Brain workflow: model not found: ${brain.provider}/${brain.model}`, "warning");
		}
	}

	if (!explicitThinking && (projectOverridesWorkflow || !projectSettingsHasThinking) && brain.thinkingLevel) {
		pi.setThinkingLevel(brain.thinkingLevel);
	}

	ctx.ui.setStatus("workflow", ctx.ui.theme.fg("accent", "brain→coder→reviewer"));
}
