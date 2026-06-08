// Workflow configuration overlay (TASK-028 Phase B).
//
// Dashboard-style configurator composed of small overlay modules:
//   - profile picker   → configure-overlay-profile.ts
//   - runtime settings → configure-overlay-runtime.ts
//   - thinking picker  → configure-overlay-thinking.ts
//   - model picker     → configure-model-picker.ts
//   - preview/apply    → configure-overlay-preview.ts
//
// All persistence flows through the Phase A `buildWorkflowLocalPayload`
// helper, the preview text through `buildWorkflowLocalPreviewText`, and
// model/thinking helpers through `collectWorkflowModelChoices`,
// `isGonkaAvailable`, and `getSupportedWorkflowThinkingLevels`. The
// `extensions/workflow/configure-io.ts` module owns the atomic write so
// no overlay module needs to import `configure.ts` (breaks the prior
// circular dependency).
//
// Built-in profile (Default/Gonka) selection does NOT seed
// `draft.customEdits` from existing agents: Phase A's
// `buildWorkflowLocalPayload` already preserves existing agents when no
// explicit edits are staged, and `summarizeWorkflowDraft` reports the
// preserved roles in the preview. Only explicit Custom per-role edits
// or clears mutate the agents map.

import { type ExtensionContext, DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";

import {
	type AgentName,
	AGENT_ROLES,
	type DelegateAgentName,
	type AgentPreset,
	type ThinkingLevel,
} from "./types";
import {
	collectWorkflowModelChoices,
	getSupportedWorkflowThinkingLevels,
	isGonkaAvailable,
	type WorkflowConfigDraft,
	type WorkflowCustomEdits,
	type WorkflowDraftProfile,
	type WorkflowModelChoice,
	type WorkflowModelRegistryLike,
	type WorkflowRoleEdit,
} from "./configure-helpers";
import { readExistingWorkflowLocal } from "./configure-io";
import { showModelPickerOverlay } from "./configure-model-picker";
import { runProfileOverlay } from "./configure-overlay-profile";
import { runPreviewOverlay } from "./configure-overlay-preview";
import { runRuntimeOverlay } from "./configure-overlay-runtime";
import { showThinkingPickerOverlay } from "./configure-overlay-thinking";
import { loadWorkflowConfig } from "./runtime/config";

export interface WorkflowConfigureResult {
	applied: boolean;
	cancelled: boolean;
	warning?: string;
}

// ============================================================================
// Public entry point
// ============================================================================

const DELEGATE_AGENT_ROLES: readonly DelegateAgentName[] = ["coder", "reviewer"] as const;

const PROFILE_LABEL: Record<WorkflowDraftProfile, string> = {
	default: "Default",
	gonka: "Gonka",
	custom: "Custom per-role",
};

function labelForProfile(profile: WorkflowDraftProfile): string {
	return PROFILE_LABEL[profile];
}

function findCurrentChoice(edit: WorkflowRoleEdit | undefined, choices: WorkflowModelChoice[]): WorkflowModelChoice | undefined {
	if (!edit || edit.cleared) return undefined;
	if (!edit.provider || !edit.model) return undefined;
	return choices.find((choice) => choice.provider === edit.provider && choice.id === edit.model);
}

function formatRoleEditDisplay(edit: WorkflowRoleEdit, choices: WorkflowModelChoice[]): string {
	if (edit.cleared) return "(cleared)";
	const choice = findCurrentChoice(edit, choices);
	const provider = edit.provider ?? "?";
	const model = edit.model ?? "?";
	const id = choice ? choice.fullId : `${provider}/${model}`;
	return edit.thinkingLevel ? `${id}:${edit.thinkingLevel}` : id;
}

/** Builds a fresh draft seeded only by the chosen profile. Existing
 *  custom agents are NOT copied into `customEdits` — they are preserved
 *  by `buildWorkflowLocalPayload` and surfaced via
 *  `summarizeWorkflowDraft` in the preview. */
function buildInitialDraft(profile: WorkflowDraftProfile): WorkflowConfigDraft {
	return { profile, runtime: {}, customEdits: {} };
}

function profileFromLoaded(profileId: string | undefined): WorkflowDraftProfile {
	return profileId === "gonka-hybrid" || profileId === "premium-brain-gonka-workers" ? "gonka" : "default";
}

interface DashboardItem {
	id: string;
	label: string;
	description: string;
}

function formatFallbackDisplay(
	role: DelegateAgentName,
	draft: WorkflowConfigDraft,
	effectiveFallbacks: Partial<Record<DelegateAgentName, AgentPreset>> | undefined,
	choices: WorkflowModelChoice[],
): string {
	const staged = draft.fallbackEdits?.[role];
	if (staged) return formatRoleEditDisplay(staged, choices);
	const effective = effectiveFallbacks?.[role];
	if (!effective) return "(none)";
	const id = effective.provider && effective.model ? `${effective.provider}/${effective.model}` : "(incomplete)";
	return effective.thinkingLevel ? `${id}:${effective.thinkingLevel}` : id;
}

function buildDashboardItems(
	draft: WorkflowConfigDraft,
	choices: WorkflowModelChoice[],
	effectiveFallbacks: Partial<Record<DelegateAgentName, AgentPreset>> | undefined,
): DashboardItem[] {
	const items: DashboardItem[] = [
		{
			id: "profile-models",
			label: `Profile & agent models: ${labelForProfile(draft.profile)}`,
			description: draft.profile === "custom"
				? "Switch profile or edit per-role models/thinking"
				: "Switch to Custom per-role to edit per-role models and runtime fields",
		},
		{ id: "runtime", label: "Runtime settings", description: "delegate display / pane auto-close / reviewer swarm / deep planning" },
		{ id: "fallbacks", label: "Delegate fallback models", description: "coder/reviewer fallback model overrides" },
		{ id: "preview", label: "Preview & apply", description: "Show the staged payload and write `.pi/workflow.local.json`" },
		{ id: "cancel", label: "Cancel", description: "Back out without writing" },
	];
	return items;
}

function formatRoleModelDescription(role: AgentName, draft: WorkflowConfigDraft, choices: WorkflowModelChoice[]): string {
	const edit = draft.customEdits[role];
	if (!edit) return "(default)";
	return formatRoleEditDisplay(edit, choices);
}

function formatRoleThinkingDescription(role: AgentName, draft: WorkflowConfigDraft): string {
	const edit = draft.customEdits[role];
	if (!edit?.thinkingLevel) return "(default)";
	return `${edit.thinkingLevel}${edit.provider ? ` (${edit.provider}/${edit.model ?? "?"})` : ""}`;
}

async function runProfileModelsOverlay(
	ctx: ExtensionContext,
	draft: WorkflowConfigDraft,
	choices: WorkflowModelChoice[],
	gonkaAvailable: boolean,
): Promise<string | null> {
	const items: SelectItem[] = [
		{ value: "switch-profile", label: "Switch profile", description: "Change the active workflow profile" },
	];

	if (draft.profile === "custom") {
		for (const role of AGENT_ROLES) {
			items.push({
				value: `model:${role}`,
				label: `${role} model`,
				description: formatRoleModelDescription(role, draft, choices),
			});
			items.push({
				value: `thinking:${role}`,
				label: `${role} thinking`,
				description: formatRoleThinkingDescription(role, draft),
			});
			if (draft.customEdits[role]) {
				items.push({
					value: `clear:${role}`,
					label: `Clear ${role} override`,
					description: "Drop the staged edit for this role",
				});
			}
		}
	}

	items.push({ value: "back", label: "Back", description: "Return to dashboard" });

	return ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Profile & agent models")), 1, 0));
		container.addChild(new Text(theme.fg("dim", `Current profile: ${labelForProfile(draft.profile)}`), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 16), getSelectListTheme(), {
			minPrimaryColumnWidth: 22,
			maxPrimaryColumnWidth: 50,
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done("back");

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc/back"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (input: string) => {
				selectList.handleInput(input);
				_tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 92, maxHeight: "85%" } });
}

async function runFallbackOverlay(
	ctx: ExtensionContext,
	draft: WorkflowConfigDraft,
	choices: WorkflowModelChoice[],
	effectiveFallbacks: Partial<Record<DelegateAgentName, AgentPreset>> | undefined,
): Promise<string | null> {
	const items: SelectItem[] = [];
	for (const role of DELEGATE_AGENT_ROLES) {
		items.push({
			value: `fallback:${role}`,
			label: `${role} fallback model`,
			description: formatFallbackDisplay(role, draft, effectiveFallbacks, choices),
		});
		if (draft.fallbackEdits?.[role] || effectiveFallbacks?.[role]) {
			items.push({
				value: `fallback-clear:${role}`,
				label: `Clear ${role} fallback`,
				description: "Remove this local fallback override on apply",
			});
		}
	}
	items.push({ value: "back", label: "Back", description: "Return to dashboard" });

	return ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Delegate fallback models")), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Pick a fallback model or clear an existing override."), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme(), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 50,
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done("back");

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc/back"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (input: string) => {
				selectList.handleInput(input);
				_tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 92, maxHeight: "85%" } });
}

async function runDashboardOverlay(
	ctx: ExtensionContext,
	getItems: () => DashboardItem[],
): Promise<string | null> {
	return ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		const items: SelectItem[] = getItems().map((action) => ({
			value: action.id,
			label: action.label,
			description: action.description,
		}));

		const selectList = new SelectList(items, Math.min(items.length, 18), getSelectListTheme(), {
			minPrimaryColumnWidth: 22,
			maxPrimaryColumnWidth: 60,
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Workflow configuration — dashboard")), 1, 0));
		container.addChild(new Text(
			theme.fg("dim", "Pick an action; profile/runtime/model/thinking changes stay staged until 'Preview & apply'."),
			1,
			0,
		));
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (input: string) => {
				selectList.handleInput(input);
				_tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 92, maxHeight: "85%" } });
}

// ============================================================================
// Sub-action handlers
// ============================================================================

async function applyProfileChoice(
	ctx: ExtensionContext,
	current: WorkflowConfigDraft,
	gonkaAvailable: boolean,
): Promise<WorkflowConfigDraft> {
	const choice = await runProfileOverlay(ctx, { gonkaAvailable, currentProfile: current.profile });
	if (choice === "back") return current;
	return buildInitialDraft(choice);
}

async function applyRuntimeEdit(
	ctx: ExtensionContext,
	current: WorkflowConfigDraft,
): Promise<WorkflowConfigDraft> {
	const result = await runRuntimeOverlay(ctx, current.runtime);
	if (result.action === "cancel") return current;
	return { ...current, runtime: result.runtime };
}

async function applyModelPick(
	ctx: ExtensionContext,
	current: WorkflowConfigDraft,
	role: AgentName,
	choices: WorkflowModelChoice[],
): Promise<WorkflowConfigDraft> {
	const existing = current.customEdits[role];
	const result = await showModelPickerOverlay(
		ctx,
		choices,
		role,
		existing?.provider,
		existing?.model,
	);
	if (!result) return current;
	const edit: WorkflowRoleEdit = { ...(existing ?? {}) };
	delete edit.cleared;
	edit.provider = result.choice.provider;
	edit.model = result.choice.id;
	const supported = getSupportedWorkflowThinkingLevels(result.choice);
	if (supported.length === 0) {
		delete edit.thinkingLevel;
	} else if (supported.length === 1 && supported[0] === "off") {
		edit.thinkingLevel = "off";
	} else if (edit.thinkingLevel && !supported.includes(edit.thinkingLevel)) {
		delete edit.thinkingLevel;
	}
	const customEdits: WorkflowCustomEdits = { ...current.customEdits, [role]: edit };
	return { profile: "custom", runtime: { ...current.runtime }, customEdits };
}

async function applyThinkingPick(
	ctx: ExtensionContext,
	current: WorkflowConfigDraft,
	role: AgentName,
	choices: WorkflowModelChoice[],
): Promise<WorkflowConfigDraft> {
	const existing = current.customEdits[role];
	const choice = findCurrentChoice(existing, choices);
	const currentLevel: ThinkingLevel = existing?.thinkingLevel ?? "off";
	const result = await showThinkingPickerOverlay(ctx, role, choice, currentLevel);
	if (!result) return current;
	const edit: WorkflowRoleEdit = { ...(existing ?? {}) };
	delete edit.cleared;
	edit.thinkingLevel = result.level;
	const customEdits: WorkflowCustomEdits = { ...current.customEdits, [role]: edit };
	return { profile: "custom", runtime: { ...current.runtime }, customEdits };
}

function applyClearRole(current: WorkflowConfigDraft, role: AgentName): WorkflowConfigDraft {
	const customEdits: WorkflowCustomEdits = { ...current.customEdits, [role]: { cleared: true } };
	return { profile: "custom", runtime: { ...current.runtime }, customEdits };
}

async function applyFallbackPick(
	ctx: ExtensionContext,
	current: WorkflowConfigDraft,
	role: DelegateAgentName,
	choices: WorkflowModelChoice[],
): Promise<WorkflowConfigDraft> {
	const existing = current.fallbackEdits?.[role];
	const result = await showModelPickerOverlay(
		ctx,
		choices,
		role,
		existing?.provider,
		existing?.model,
	);
	if (!result) return current;
	const edit: WorkflowRoleEdit = {};
	edit.provider = result.choice.provider;
	edit.model = result.choice.id;
	const supported = getSupportedWorkflowThinkingLevels(result.choice);
	if (supported.length === 0) {
		// no-op: omit thinkingLevel
	} else if (supported.length === 1 && supported[0] === "off") {
		edit.thinkingLevel = "off";
	} else if (existing?.thinkingLevel && supported.includes(existing.thinkingLevel)) {
		edit.thinkingLevel = existing.thinkingLevel;
	}
	const fallbackEdits: NonNullable<WorkflowConfigDraft["fallbackEdits"]> = {
		...(current.fallbackEdits ?? {}),
		[role]: edit,
	};
	return { ...current, fallbackEdits };
}

function applyClearFallback(current: WorkflowConfigDraft, role: DelegateAgentName): WorkflowConfigDraft {
	const fallbackEdits: NonNullable<WorkflowConfigDraft["fallbackEdits"]> = {
		...(current.fallbackEdits ?? {}),
		[role]: { cleared: true },
	};
	return { ...current, fallbackEdits };
}

// ============================================================================
// Public entry point: showWorkflowConfigureOverlay
// ============================================================================

/** Opens the centered overlay workflow configurator. */
export async function showWorkflowConfigureOverlay(ctx: ExtensionContext): Promise<WorkflowConfigureResult> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Workflow configuration needs interactive UI (TUI mode only).", "warning");
		return { applied: false, cancelled: true };
	}

	const existingLocal = readExistingWorkflowLocal(ctx.cwd);
	const loaded = loadWorkflowConfig(ctx.cwd);
	const registry = (ctx as unknown as { modelRegistry?: WorkflowModelRegistryLike | undefined }).modelRegistry;
	const collection = collectWorkflowModelChoices(registry);
	const gonkaAvailable = isGonkaAvailable(collection.choices);

	if (collection.degraded) {
		ctx.ui.notify(
			`Model registry degraded: ${collection.warning ?? "no models"}. Configure runs in a limited mode (built-in profiles and runtime fields only).`,
			"warning",
		);
	}

	let draft: WorkflowConfigDraft = buildInitialDraft(profileFromLoaded(loaded.profileId));

	while (true) {
		const action = await runDashboardOverlay(
			ctx,
			() => buildDashboardItems(draft, collection.choices, loaded.config.delegateFallbacks),
		);

		if (action === null || action === "cancel") {
			return { applied: false, cancelled: true };
		}
		if (action === "preview") {
			break;
		}
		if (action === "profile-models") {
			const sub = await runProfileModelsOverlay(ctx, draft, collection.choices, gonkaAvailable);
			if (sub === "back" || sub === null) {
				continue;
			}
			if (sub === "switch-profile") {
				draft = await applyProfileChoice(ctx, draft, gonkaAvailable);
				continue;
			}
			if (sub.startsWith("model:")) {
				const role = sub.slice("model:".length) as AgentName;
				if (!AGENT_ROLES.includes(role)) continue;
				draft = await applyModelPick(ctx, draft, role, collection.choices);
				continue;
			}
			if (sub.startsWith("thinking:")) {
				const role = sub.slice("thinking:".length) as AgentName;
				if (!AGENT_ROLES.includes(role)) continue;
				draft = await applyThinkingPick(ctx, draft, role, collection.choices);
				continue;
			}
			if (sub.startsWith("clear:")) {
				const role = sub.slice("clear:".length) as AgentName;
				if (!AGENT_ROLES.includes(role)) continue;
				draft = applyClearRole(draft, role);
				continue;
			}
			continue;
		}
		if (action === "runtime") {
			draft = await applyRuntimeEdit(ctx, draft);
			continue;
		}
		if (action === "fallbacks") {
			const sub = await runFallbackOverlay(ctx, draft, collection.choices, loaded.config.delegateFallbacks);
			if (sub === "back" || sub === null) {
				continue;
			}
			if (sub.startsWith("fallback:")) {
				const role = sub.slice("fallback:".length) as DelegateAgentName;
				if (!DELEGATE_AGENT_ROLES.includes(role)) continue;
				draft = await applyFallbackPick(ctx, draft, role, collection.choices);
				continue;
			}
			if (sub.startsWith("fallback-clear:")) {
				const role = sub.slice("fallback-clear:".length) as DelegateAgentName;
				if (!DELEGATE_AGENT_ROLES.includes(role)) continue;
				draft = applyClearFallback(draft, role);
				continue;
			}
			continue;
		}
	}

	return runPreviewOverlay(ctx, existingLocal, draft, collection.warning);
}
