import * as fs from "node:fs";
import * as path from "node:path";

import { type ExtensionContext, DynamicBorder, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
	type SettingItem,
	SettingsList,
} from "@earendil-works/pi-tui";

import {
	AGENT_ROLES,
	type AgentName,
	DELEGATE_DISPLAY_MODES,
	type DelegateDisplayMode,
	type LoadedWorkflowConfig,
	type ThinkingLevel,
	THINKING_LEVELS,
	type WorkflowConfig,
} from "./types";
import { getAgentPreset, loadWorkflowConfig } from "./runtime/config";

export const WORKFLOW_LOCAL_CONFIG_PATH = ".pi/workflow.local.json";

export function getFriendlyProfileLabel(profileId: string): string {
	const normalized = profileId.trim().toLowerCase();
	if (normalized === "default" || normalized === "") return "default";
	if (normalized === "gonka-hybrid" || normalized === "premium-brain-gonka-workers") return "gonka";
	return normalized;
}

export function formatModelReference(provider: string, model: string): string {
	const safeProvider = provider.trim();
	const safeModel = model.trim();
	if (!safeProvider) return safeModel;
	if (!safeModel) return `${safeProvider}/`;
	return `${safeProvider}/${safeModel}`;
}

export function parseModelReference(value: string): { provider: string; model: string } | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return {
		provider: trimmed.slice(0, slash),
		model: trimmed.slice(slash + 1),
	};
}

function readJsonFile<T = unknown>(filePath: string): T | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function hasObjectProperty(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProjectRoleOverrideFile(pathName: string | null | undefined): boolean {
	if (!pathName) return false;
	const raw = readJsonFile<Record<string, unknown>>(pathName);
	if (!hasObjectProperty(raw)) return false;
	const agents = (raw as { agents?: unknown }).agents;
	if (!hasObjectProperty(agents)) return false;
	const roleKeys = Object.keys(agents);
	const targetRoles = new Set<string>(AGENT_ROLES);
	for (const role of roleKeys) {
		if (targetRoles.has(role)) return true;
	}
	return false;
}

export function getWorkflowStatusLabel(loaded: LoadedWorkflowConfig): string {
	const profileLabel = getFriendlyProfileLabel(loaded.profileId);
	const warning = loaded.configDiagnostics.some((diagnostic) => diagnostic.severity === "warning" || diagnostic.severity === "error");

	if (loaded.profileSource === "cli") {
		return `wf: cli:${profileLabel}${warning ? " ⚠" : ""}`;
	}

	if (hasProjectRoleOverrideFile(loaded.projectOverridePath) && loaded.projectOverridePath && loaded.projectOverridePath.endsWith(WORKFLOW_LOCAL_CONFIG_PATH)) {
		return `wf: custom/project${warning ? " ⚠" : ""}`;
	}

	return `wf: ${profileLabel}${warning ? " ⚠" : ""}`;
}

export function setWorkflowStatusFromConfig(ctx: ExtensionContext, loaded: LoadedWorkflowConfig): void {
	const warning = loaded.configDiagnostics.some((diagnostic) => diagnostic.severity === "warning" || diagnostic.severity === "error");
	const color = warning ? "warning" : "accent";
	ctx.ui.setStatus("workflow", ctx.ui.theme.fg(color, getWorkflowStatusLabel(loaded)));
}

interface WorkflowLocalChoiceState {
	profile: "default" | "gonka" | "custom";
	agents: Record<AgentName, { model: string; thinking: ThinkingLevel | "default" }>;
	delegateDisplay: DelegateDisplayMode;
	delegatePaneAutoClose: "true" | "false";
	reviewerSwarmEnabled: "true" | "false";
	deepPlanningEnabled: "true" | "false";
}

function buildModelChoices(ctx: ExtensionContext): string[] {
	const choices = new Set<string>(["default"]);
	for (const model of ctx.modelRegistry.getAvailable()) {
		if (!model.provider || !model.id) continue;
		choices.add(formatModelReference(model.provider, model.id));
	}
	const all = [...choices];
	all.sort((a, b) => a.localeCompare(b));
	return all;
}

function buildInitialState(loaded: LoadedWorkflowConfig, modelChoices: string[]): WorkflowLocalChoiceState {
	const state: WorkflowLocalChoiceState = {
		profile: "default",
		agents: {
			brain: {
				model: "default",
				thinking: "default",
			},
			coder: {
				model: "default",
				thinking: "default",
			},
			reviewer: {
				model: "default",
				thinking: "default",
			},
		},
		delegateDisplay: loaded.config.delegateDisplay ?? "headless",
		delegatePaneAutoClose: loaded.config.delegatePaneAutoClose === false ? "false" : "true",
		reviewerSwarmEnabled: loaded.config.reviewerSwarm?.enabled === false ? "false" : "true",
		deepPlanningEnabled: loaded.config.deepPlanning?.enabled === true ? "true" : "false",
	};

	const availableModelChoices = new Set(modelChoices);
	for (const role of AGENT_ROLES) {
		const preset = getAgentPreset(loaded.config, role);
		if (preset.provider && preset.model) {
			state.agents[role].model = formatModelReference(preset.provider, preset.model);
		}
		if (!availableModelChoices.has(state.agents[role].model)) {
			state.agents[role].model = "default";
		}
		if (preset.thinkingLevel) {
			state.agents[role].thinking = preset.thinkingLevel;
		}
	}

	return state;
}

export function normalizeStateForAvailableModels(
	state: WorkflowLocalChoiceState,
	modelChoices: string[],
): WorkflowLocalChoiceState {
	const availableModelChoices = new Set(modelChoices);
	const normalized: WorkflowLocalChoiceState = {
		...state,
		agents: {
			brain: { ...state.agents.brain },
			coder: { ...state.agents.coder },
			reviewer: { ...state.agents.reviewer },
		},
	};

	for (const role of AGENT_ROLES) {
		if (normalized.agents[role].model !== "default" && !availableModelChoices.has(normalized.agents[role].model)) {
			normalized.agents[role].model = "default";
		}
	}

	return normalized;
}

function buildSettingItems(
	state: WorkflowLocalChoiceState,
	modelChoices: string[],
	showPerRole: boolean,
): SettingItem[] {
	const settingsItems: SettingItem[] = [];
	if (showPerRole) {
		for (const role of AGENT_ROLES) {
			const allModelChoices = new Set<string>(modelChoices);
			const currentModel = allModelChoices.has(state.agents[role].model) ? state.agents[role].model : "default";
			settingsItems.push({
				id: `${role}:model`,
				label: `${role} model`,
				currentValue: currentModel,
				values: [...allModelChoices].sort(),
				description: "Provider/model for delegate runtime selection",
			});

			const currentThinking = state.agents[role].thinking;
			settingsItems.push({
				id: `${role}:thinking`,
				label: `${role} thinking`,
				description: "Thinking level for delegate runtime",
				currentValue: currentThinking,
				values: ["default", ...THINKING_LEVELS],
			});
		}
	}

	settingsItems.push(
		{
			id: "delegateDisplay",
			label: "Delegate display",
			description: "How delegate sessions are shown",
			currentValue: state.delegateDisplay,
			values: [...DELEGATE_DISPLAY_MODES],
		},
		{
			id: "delegatePaneAutoClose",
			label: "Close delegate panes",
			currentValue: state.delegatePaneAutoClose,
			description: "Auto-close delegate panes after completion",
			values: ["true", "false"],
		},
		{
			id: "reviewerSwarm.enabled",
			label: "Reviewer swarm enabled",
			description: "Run reviewer swarm in parallel",
			currentValue: state.reviewerSwarmEnabled,
			values: ["true", "false"],
		},
		{
			id: "deepPlanning.enabled",
			label: "Deep planning enabled",
			description: "Enable deep planning for this workflow",
			currentValue: state.deepPlanningEnabled,
			values: ["true", "false"],
		},
	);

	return settingsItems;
}

function parseBool(value: string): boolean {
	return value === "true";
}

function normalizeOverrideConfig(state: WorkflowLocalChoiceState, profileChoice: "default" | "gonka" | "custom"): WorkflowConfig {
	const override: WorkflowConfig = {};

	if (profileChoice === "default") {
		override.profile = "default";
	}
	if (profileChoice === "gonka") {
		override.profile = "gonka-hybrid";
	}

	override.delegateDisplay = state.delegateDisplay;
	override.delegatePaneAutoClose = parseBool(state.delegatePaneAutoClose);
	override.reviewerSwarm = { enabled: parseBool(state.reviewerSwarmEnabled) };
	override.deepPlanning = { enabled: parseBool(state.deepPlanningEnabled) };

	if (profileChoice === "custom") {
		const agents: WorkflowConfig["agents"] = {};
		for (const role of AGENT_ROLES) {
			const roleState = state.agents[role];
			const overrideRole: {
				provider?: string;
				model?: string;
				thinkingLevel?: ThinkingLevel;
			} = {};
			if (roleState.model !== "default") {
				const parsed = parseModelReference(roleState.model);
				if (parsed) {
					overrideRole.provider = parsed.provider;
					overrideRole.model = parsed.model;
				}
			}
			if (roleState.thinking !== "default") {
				overrideRole.thinkingLevel = roleState.thinking;
			}
			if (Object.keys(overrideRole).length > 0) {
				agents[role] = overrideRole;
			}
		}
		if (Object.keys(agents ?? {}).length > 0) {
			override.agents = agents;
		}
	}

	return override;
}

function hasAnyLocalRuntimeField(payload: WorkflowConfig): boolean {
	return Boolean(
		payload.profile
			|| payload.delegateDisplay
			|| payload.delegatePaneAutoClose !== undefined
			|| payload.reviewerSwarm
			|| payload.deepPlanning
			|| payload.agents,
	);
}

function asProfileLabel(profile: "default" | "gonka" | "custom"): string {
	if (profile === "default") return "Default";
	if (profile === "gonka") return "Gonka";
	return "Custom per-role";
}

function formatRuntimeResultText(resultPath: string | undefined): string {
	if (!resultPath) return "(not written)";
	return path.relative(process.cwd(), resultPath) || path.basename(resultPath);
}

export async function showWorkflowConfigure(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Workflow configuration needs interactive UI (TUI mode only).", "warning");
		return;
	}

	const loaded = loadWorkflowConfig(ctx.cwd);
	const modelChoices = buildModelChoices(ctx);
	const hasRuntimeModels = modelChoices.length > 1;

	const profileChoice = await ctx.ui.custom<"default" | "gonka" | "custom" | null>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Configure workflow profile")), 1, 0));

		const items: SelectItem[] = [
			{ value: "default", label: "Default", description: "Use built-in default profile" },
			{ value: "gonka", label: "Gonka", description: "Use gonka-hybrid profile" },
			{ value: "custom", label: "Custom per-role", description: "Choose per-role models and runtime knobs" },
			{ value: "cancel", label: "Cancel", description: "Keep current workflow" },
		];

		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme(), {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 30,
		});
		selectList.onSelect = (item) =>
			done(item.value === "cancel" ? null : (item.value as "default" | "gonka" | "custom"));
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (input: string) => {
				selectList.handleInput(input);
				_tui.requestRender();
			},
		};
	});

	if (profileChoice === null || profileChoice === undefined) {
		return;
	}

	if (profileChoice === "custom" && !hasRuntimeModels) {
		ctx.ui.notify("No available models are configured in the current context; cannot edit custom workflow models.", "warning");
		return;
	}

	const initialState = buildInitialState(loaded, modelChoices);
	const settingsResult = await ctx.ui.custom<WorkflowLocalChoiceState | null>((tui, theme, _kb, done) => {
		const state = { ...initialState } as WorkflowLocalChoiceState;
		state.profile = profileChoice;
		const items = buildSettingItems(state, modelChoices, profileChoice === "custom");
		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 16),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "delegateDisplay":
						state.delegateDisplay = newValue as DelegateDisplayMode;
						break;
					case "delegatePaneAutoClose":
						state.delegatePaneAutoClose = newValue as "true" | "false";
						break;
					case "reviewerSwarm.enabled":
						state.reviewerSwarmEnabled = newValue as "true" | "false";
						break;
					case "deepPlanning.enabled":
						state.deepPlanningEnabled = newValue as "true" | "false";
						break;
					default: {
						const [role, scope] = id.split(":") as [AgentName, "model" | "thinking"];
						if (scope === "model") {
							state.agents[role].model = newValue;
						} else if (scope === "thinking") {
							state.agents[role].thinking = newValue as ThinkingLevel | "default";
						}
					}
				}
			},
			() => done(state),
			{ enableSearch: true },
		);

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`Configure workflow: ${asProfileLabel(profileChoice)}`)), 1, 0));
		container.addChild(settingsList);
		container.addChild(new Text(theme.fg("dim", "Use arrows to select, ←/→ or Enter to change, Esc to save"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => {
				container.invalidate();
				settingsList.invalidate();
			},
			handleInput: (input: string) => {
				settingsList.handleInput(input);
				tui.requestRender();
			},
		};
	});

	if (!settingsResult) {
		return;
	}

	const normalizedSettings = normalizeStateForAvailableModels(settingsResult, modelChoices);
	const override = normalizeOverrideConfig(normalizedSettings, profileChoice);
	if (!hasAnyLocalRuntimeField(override)) {
		ctx.ui.notify("No workflow override changes were selected.", "warning");
		return;
	}

	try {
		const savedPath = writeWorkflowLocalOverride(ctx.cwd, override);
		ctx.ui.notify(`Saved workflow override to ${formatRuntimeResultText(savedPath)}`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed to save workflow override: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export function writeWorkflowLocalOverride(cwd: string, payload: WorkflowConfig): string {
	const absolutePath = path.join(cwd, WORKFLOW_LOCAL_CONFIG_PATH);
	const directory = path.dirname(absolutePath);
	fs.mkdirSync(directory, { recursive: true });

	const tempPath = `${absolutePath}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;
	const text = JSON.stringify(payload, null, 2);
	fs.writeFileSync(tempPath, text, "utf8");
	fs.renameSync(tempPath, absolutePath);
	return absolutePath;
}
