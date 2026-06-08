// Workflow configuration overlay (DBG-003 per-block apply refactor).
//
// Root menu blocks: Profile, Profile config, Runtime settings, Back/Close.
// Each block owns its own Apply/write. No global Preview & apply.
//
// Profile: in-place selector with check markers; Apply writes profile.
// Profile config: Default/Gonka read-only field views, Custom editable
//   model/thinking fields, Delegate fallback models submenu (staged),
//   parent Apply writes customEdits + fallbackEdits.
// Runtime: existing settings overlay; save writes immediately.
//
// Persistence flows through Phase A helpers: buildWorkflowLocalPayload,
// writeWorkflowLocalOverride, readExistingWorkflowLocal.

import { type ExtensionContext, DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
	Key,
	matchesKey,
} from "@earendil-works/pi-tui";

import {
	AGENT_ROLES,
	type AgentName,
	type DelegateAgentName,
	type LoadedWorkflowConfig,
	type ThinkingLevel,
} from "./types";
import {
	buildWorkflowLocalPayload,
	collectWorkflowModelChoices,
	getSupportedWorkflowThinkingLevels,
	hydrateProfileConfigDraft,
	type WorkflowConfigDraft,
	type WorkflowCustomEdits,
	type WorkflowDraftProfile,
	type WorkflowModelChoice,
	type WorkflowModelRegistryLike,
	type WorkflowRoleEdit,
	type WorkflowRuntimeDraft,
} from "./configure-helpers";
import {
	displayWorkflowLocalPath,
	readExistingWorkflowLocal,
	writeWorkflowLocalOverride,
} from "./configure-io";
import { showModelPickerOverlay } from "./configure-model-picker";
import { runProfileOverlay } from "./configure-overlay-profile";
import { runRuntimeOverlay } from "./configure-overlay-runtime";
import { showThinkingPickerOverlay } from "./configure-overlay-thinking";
import { loadWorkflowConfig } from "./runtime/config";
import { DEFAULT_CONFIG } from "./defaults";
import { GONKA_HYBRID_PROFILE_APPLY, GONKA_BROKER_API_KEY_ENV } from "./profiles";

export interface WorkflowConfigureResult {
	applied: boolean;
	cancelled: boolean;
	warning?: string;
}

// ============================================================================
// Helpers
// ============================================================================

const DELEGATE_AGENT_ROLES: readonly DelegateAgentName[] = ["coder", "reviewer"] as const;

function profileFromLoaded(profileId: string | undefined): WorkflowDraftProfile {
	return profileId === "gonka-hybrid" || profileId === "premium-brain-gonka-workers" ? "gonka" : "default";
}

/** DBG-006: derive the Profile block's current selection.
 *  The Profile block represents what the user actually has on disk, not
 *  just the loaded built-in profile id. When `.pi/workflow.local.json`
 *  carries one or more explicit `agents` overrides the effective profile
 *  is Custom, even if the built-in `loaded.profileId` is still default or
 *  gonka. We re-read the latest local file each time so the Profile
 *  overlay reflects whatever was just written by another block. */
function currentProfileForProfileBlock(ctx: ExtensionContext, loadedProfileId: string | undefined): WorkflowDraftProfile {
	const existingLocal = getLatestExistingLocal(ctx);
	const localAgents = existingLocal.agents;
	if (localAgents && typeof localAgents === "object" && !Array.isArray(localAgents) && Object.keys(localAgents).length > 0) {
		return "custom";
	}
	return profileFromLoaded(loadedProfileId);
}

function labelForProfile(profile: WorkflowDraftProfile): string {
	return profile === "default" ? "Default" : profile === "gonka" ? "Gonka" : "Custom";
}

function findCurrentChoice(edit: WorkflowRoleEdit | undefined, choices: WorkflowModelChoice[]): WorkflowModelChoice | undefined {
	if (!edit || edit.cleared) return undefined;
	if (!edit.provider || !edit.model) return undefined;
	return choices.find((choice) => choice.provider === edit.provider && choice.id === edit.model);
}

function formatRoleEditDisplay(edit: WorkflowRoleEdit | undefined, choices: WorkflowModelChoice[]): string {
	if (!edit || edit.cleared) return "(default)";
	const choice = findCurrentChoice(edit, choices);
	const provider = edit.provider ?? "?";
	const model = edit.model ?? "?";
	const id = choice ? choice.fullId : `${provider}/${model}`;
	return edit.thinkingLevel ? `${id}:${edit.thinkingLevel}` : id;
}

function gonkaEnvConfigured(): boolean {
	return Boolean(process.env[GONKA_BROKER_API_KEY_ENV]?.trim());
}

/** Reads the latest existing local config before each block write. */
function getLatestExistingLocal(ctx: ExtensionContext): Record<string, unknown> {
	return readExistingWorkflowLocal(ctx.cwd);
}

/** Notifies saved path and returns a result. */
function notifySaved(ctx: ExtensionContext): WorkflowConfigureResult {
	ctx.ui.notify(`Saved workflow override to ${displayWorkflowLocalPath(ctx.cwd)}`, "info");
	return { applied: true, cancelled: false };
}

function notifyError(ctx: ExtensionContext, message: string): WorkflowConfigureResult {
	ctx.ui.notify(`Failed to save workflow override: ${message}`, "error");
	return { applied: false, cancelled: false, warning: message };
}

// ============================================================================
// Root menu
// ============================================================================

async function runRootMenuOverlay(ctx: ExtensionContext): Promise<string | null> {
	const items: SelectItem[] = [
		{ value: "profile", label: "Profile", description: "Select active profile (Default, Gonka, Custom)" },
		{ value: "profile-config", label: "Profile config", description: "View/edit profile fields and fallback models" },
		{ value: "runtime", label: "Runtime settings", description: "Delegate display, swarm, deep planning" },
		{ value: "back", label: "Back/Close", description: "Close without writing" },
	];

	return ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Workflow configuration")), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Each block has its own Apply. Back/Close never writes."), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme(), {
			minPrimaryColumnWidth: 22,
			maxPrimaryColumnWidth: 50,
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc/close"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (input: string) => {
				selectList.handleInput(input);
				_tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "85%" } });
}

// ============================================================================
// Profile block: write profile only
// ============================================================================

async function runProfileBlock(
	ctx: ExtensionContext,
	currentProfile: WorkflowDraftProfile,
): Promise<WorkflowConfigureResult> {
	const choice = await runProfileOverlay(ctx, {
		gonkaEnvConfigured: gonkaEnvConfigured(),
		currentProfile,
	});
	if (choice === "back") return { applied: false, cancelled: true };

	const existingLocal = getLatestExistingLocal(ctx);
	const draft: WorkflowConfigDraft = { profile: choice, runtime: {}, customEdits: {} };
	const payload = buildWorkflowLocalPayload(existingLocal, draft);
	try {
		writeWorkflowLocalOverride(ctx.cwd, payload);
		return notifySaved(ctx);
	} catch (error) {
		return notifyError(ctx, error instanceof Error ? error.message : String(error));
	}
}

// ============================================================================
// Profile config block: read-only built-ins, editable Custom, fallback submenu
// ============================================================================

function formatProfileConfigItemLabel(profile: WorkflowDraftProfile, value: WorkflowDraftProfile): string {
	return `${profile === value ? "✓ " : "  "}${labelForProfile(value)}`;
}

async function runProfileConfigOverlay(
	ctx: ExtensionContext,
	choices: WorkflowModelChoice[],
	draft: WorkflowConfigDraft,
): Promise<string | null> {
	const envOk = gonkaEnvConfigured();
	const items: SelectItem[] = [
		{ value: "default", label: formatProfileConfigItemLabel(draft.profile, "default"), description: "View default profile fields (read-only)" },
	];
	if (envOk) {
		items.push({ value: "gonka", label: formatProfileConfigItemLabel(draft.profile, "gonka"), description: "View Gonka profile fields (read-only)" });
	}
	items.push(
		{ value: "custom", label: formatProfileConfigItemLabel(draft.profile, "custom"), description: "Edit custom per-role model/thinking" },
		{ value: "fallbacks", label: "Delegate fallback models", description: "Edit global coder/reviewer fallback models" },
		{ value: "apply", label: "Apply", description: "Write profile config changes to .pi/workflow.local.json" },
		{ value: "back", label: "Back", description: "Return without writing" },
	);

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Profile config")), 1, 0));
		container.addChild(new Text(theme.fg("dim", `Active profile: ${labelForProfile(draft.profile)}`), 1, 0));

		let selectList: SelectList;

		const rebuildItems = () => {
			const rebuilt: SelectItem[] = [
				{ value: "default", label: formatProfileConfigItemLabel(draft.profile, "default"), description: "View default profile fields (read-only)" },
			];
			if (envOk) {
				rebuilt.push({ value: "gonka", label: formatProfileConfigItemLabel(draft.profile, "gonka"), description: "View Gonka profile fields (read-only)" });
			}
			rebuilt.push(
				{ value: "custom", label: formatProfileConfigItemLabel(draft.profile, "custom"), description: "Edit custom per-role model/thinking" },
				{ value: "fallbacks", label: "Delegate fallback models", description: "Edit global coder/reviewer fallback models" },
				{ value: "apply", label: "Apply", description: "Write profile config changes to .pi/workflow.local.json" },
				{ value: "back", label: "Back", description: "Return without writing" },
			);
			selectList = new SelectList(rebuilt, Math.min(rebuilt.length, 12), getSelectListTheme(), {
				minPrimaryColumnWidth: 24,
				maxPrimaryColumnWidth: 50,
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done("back");
		};

		rebuildItems();
		container.addChild(selectList!);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (input: string) => {
				selectList!.handleInput(input);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 92, maxHeight: "85%" } });
}

// --- Read-only built-in field views ---

interface ReadonlyFieldRow {
	role: AgentName;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
}

function buildReadonlyFieldRows(profile: "default" | "gonka"): ReadonlyFieldRow[] {
	if (profile === "gonka") {
		return [
			{ role: "brain", provider: DEFAULT_CONFIG.agents!.brain.provider!, model: DEFAULT_CONFIG.agents!.brain.model!, thinkingLevel: DEFAULT_CONFIG.agents!.brain.thinkingLevel! },
			{ role: "coder", provider: GONKA_HYBRID_PROFILE_APPLY.agents!.coder.provider!, model: GONKA_HYBRID_PROFILE_APPLY.agents!.coder.model!, thinkingLevel: GONKA_HYBRID_PROFILE_APPLY.agents!.coder.thinkingLevel! },
			{ role: "reviewer", provider: GONKA_HYBRID_PROFILE_APPLY.agents!.reviewer.provider!, model: GONKA_HYBRID_PROFILE_APPLY.agents!.reviewer.model!, thinkingLevel: GONKA_HYBRID_PROFILE_APPLY.agents!.reviewer.thinkingLevel! },
		];
	}
	return [
		{ role: "brain", provider: DEFAULT_CONFIG.agents!.brain.provider!, model: DEFAULT_CONFIG.agents!.brain.model!, thinkingLevel: DEFAULT_CONFIG.agents!.brain.thinkingLevel! },
		{ role: "coder", provider: DEFAULT_CONFIG.agents!.coder.provider!, model: DEFAULT_CONFIG.agents!.coder.model!, thinkingLevel: DEFAULT_CONFIG.agents!.coder.thinkingLevel! },
		{ role: "reviewer", provider: DEFAULT_CONFIG.agents!.reviewer.provider!, model: DEFAULT_CONFIG.agents!.reviewer.model!, thinkingLevel: DEFAULT_CONFIG.agents!.reviewer.thinkingLevel! },
	];
}

async function runReadonlyFieldsOverlay(
	ctx: ExtensionContext,
	profile: "default" | "gonka",
): Promise<void> {
	const rows = buildReadonlyFieldRows(profile);
	const lines = rows.map((r) => `  ${r.role}: ${r.provider}/${r.model}  thinking=${r.thinkingLevel}`);

	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`${labelForProfile(profile)} profile fields`)), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Read-only view of built-in profile values."), 1, 0));
		for (const line of lines) {
			container.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
		container.addChild(new Text(theme.fg("dim", "esc to return"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (input: string) => {
				if (matchesKey(input, Key.escape) || matchesKey(input, Key.ctrl("c"))) {
					done();
					return;
				}
				_tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "70%" } });
}

// --- Custom editable fields ---

/** Builds a per-role display string for the custom fields overlay. When
 *  the user has no staged edit for a role but the loaded effective
 *  config defines one (e.g. a local override from a previous session),
 *  show that effective value so the user is not misled into thinking
 *  the role is at "(default)". */
function customRoleModelDisplay(
	role: AgentName,
	draft: WorkflowConfigDraft,
	choices: WorkflowModelChoice[],
	effectiveAgents: LoadedWorkflowConfig["config"]["agents"] | undefined,
): string {
	const staged = draft.customEdits[role];
	if (staged) return formatRoleEditDisplay(staged, choices);
	const effective = effectiveAgents?.[role];
	if (!effective || (!effective.provider && !effective.model)) return "(default)";
	const id = effective.provider && effective.model ? `${effective.provider}/${effective.model}` : "(incomplete)";
	return effective.thinkingLevel ? `${id}:${effective.thinkingLevel}` : id;
}

async function runCustomFieldsOverlay(
	ctx: ExtensionContext,
	draft: WorkflowConfigDraft,
	choices: WorkflowModelChoice[],
	effectiveAgents: LoadedWorkflowConfig["config"]["agents"] | undefined,
): Promise<WorkflowConfigDraft> {
	let working = draft;
	// Internal loop: after a model/clear action we re-open the same
	// submenu so the user can change several fields in one visit.
	// Esc/Back returns to the Profile config root without writing.
	//
	// DBG-005/DBG-006 chain: every role's model row encapsulates the
	// thinking-level selection (model picker -> thinking picker -> return
	// to params) via applyRoleModelAndThinkingPick, so no role emits a
	// standalone thinking row. The model row's description shows the
	// staged/effective thinking level via customRoleModelDisplay.
	while (true) {
		const items: SelectItem[] = [];
		for (const role of AGENT_ROLES) {
			items.push({
				value: `model:${role}`,
				label: `${role} model`,
				description: customRoleModelDisplay(role, working, choices, effectiveAgents),
			});
			if (working.customEdits[role]) {
				items.push({
					value: `clear:${role}`,
					label: `Clear ${role} override`,
					description: "Drop the staged edit for this role",
				});
			}
		}
		items.push({ value: "back", label: "Back", description: "Return to profile config menu" });

		const sub = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Custom profile fields")), 1, 0));
			container.addChild(new Text(theme.fg("dim", "Edit per-role model and thinking. Changes are staged until Profile config → Apply."), 1, 0));

			const selectList = new SelectList(items, Math.min(items.length, 16), getSelectListTheme(), {
				minPrimaryColumnWidth: 22,
				maxPrimaryColumnWidth: 50,
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done("back");

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0));
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

		if (sub === "back" || sub === null) return working;
		if (sub.startsWith("model:")) {
			const role = sub.slice("model:".length) as AgentName;
			if (!AGENT_ROLES.includes(role)) continue;
			// DBG-005/DBG-006: every role uses the model -> thinking chain
			// (model picker -> thinking picker -> return to params). Esc on
			// the model picker returns the draft unchanged; Esc on the
			// thinking picker returns to the model picker.
			working = await applyRoleModelAndThinkingPick(ctx, working, role, choices);
			continue;
		}
		if (sub.startsWith("clear:")) {
			const role = sub.slice("clear:".length) as AgentName;
			if (!AGENT_ROLES.includes(role)) continue;
			working = applyClearRole(working, role);
			continue;
		}
		return working;
	}
}

// --- Delegate fallback models submenu (staged, no inner apply) ---

function formatFallbackDisplay(
	role: DelegateAgentName,
	draft: WorkflowConfigDraft,
	effectiveFallbacks: Partial<Record<DelegateAgentName, { provider?: string; model?: string; thinkingLevel?: ThinkingLevel }>> | undefined,
	choices: WorkflowModelChoice[],
): string {
	const staged = draft.fallbackEdits?.[role];
	if (staged) return formatRoleEditDisplay(staged, choices);
	const effective = effectiveFallbacks?.[role];
	if (!effective) return "(none)";
	const id = effective.provider && effective.model ? `${effective.provider}/${effective.model}` : "(incomplete)";
	return effective.thinkingLevel ? `${id}:${effective.thinkingLevel}` : id;
}

async function runFallbackSubmenu(
	ctx: ExtensionContext,
	draft: WorkflowConfigDraft,
	choices: WorkflowModelChoice[],
	effectiveFallbacks: Partial<Record<DelegateAgentName, { provider?: string; model?: string; thinkingLevel?: ThinkingLevel }>> | undefined,
): Promise<WorkflowConfigDraft> {
	let working = draft;
	// Internal loop: after picking or clearing a fallback we re-open the
	// same submenu so the user can change several fallbacks in one visit.
	// Esc/Back returns to the Profile config root; the parent Apply still
	// owns the disk write.
	while (true) {
		const items: SelectItem[] = [];
		for (const role of DELEGATE_AGENT_ROLES) {
			items.push({
				value: `fallback:${role}`,
				label: `${role} fallback model`,
				description: formatFallbackDisplay(role, working, effectiveFallbacks, choices),
			});
			if (working.fallbackEdits?.[role] || effectiveFallbacks?.[role]) {
				items.push({
					value: `fallback-clear:${role}`,
					label: `Clear ${role} fallback`,
					description: "Remove this local fallback override",
				});
			}
		}
		items.push({ value: "back", label: "Back", description: "Return to profile config menu" });

		const sub = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Delegate fallback models")), 1, 0));
			container.addChild(new Text(theme.fg("dim", "Pick a fallback model or clear an existing override. Changes are staged until Profile config → Apply."), 1, 0));

			const selectList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme(), {
				minPrimaryColumnWidth: 24,
				maxPrimaryColumnWidth: 50,
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done("back");

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0));
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

		if (sub === "back" || sub === null) return working;
		if (sub.startsWith("fallback:")) {
			const role = sub.slice("fallback:".length) as DelegateAgentName;
			if (!DELEGATE_AGENT_ROLES.includes(role)) continue;
			// DBG-005: fallback model -> thinking chain (matches the
			// custom-fields chain). Esc on thinking returns to the model
			// picker; Esc on the model picker returns to fallback params
			// unchanged.
			working = await applyFallbackModelAndThinkingPick(ctx, working, role, choices);
			continue;
		}
		if (sub.startsWith("fallback-clear:")) {
			const role = sub.slice("fallback-clear:".length) as DelegateAgentName;
			if (!DELEGATE_AGENT_ROLES.includes(role)) continue;
			working = applyClearFallback(working, role);
			continue;
		}
		return working;
	}
}

// --- Profile config orchestration ---

async function runProfileConfigBlock(
	ctx: ExtensionContext,
	choices: WorkflowModelChoice[],
	loaded: LoadedWorkflowConfig,
): Promise<WorkflowConfigureResult> {
	const existingLocal = getLatestExistingLocal(ctx);
	const localAgents = (existingLocal.agents && typeof existingLocal.agents === "object"
		? (existingLocal.agents as LoadedWorkflowConfig["config"]["agents"])
		: undefined);
	const localFallbacks = (existingLocal.delegateFallbacks && typeof existingLocal.delegateFallbacks === "object"
		? (existingLocal.delegateFallbacks as LoadedWorkflowConfig["config"]["delegateFallbacks"])
		: undefined);
	let draft: WorkflowConfigDraft = hydrateProfileConfigDraft(
		loaded.config.agents,
		loaded.config.delegateFallbacks,
		localAgents,
		localFallbacks,
		profileFromLoaded(loaded.profileId),
	);

	while (true) {
		const action = await runProfileConfigOverlay(ctx, choices, draft);
		if (action === null || action === "back") {
			return { applied: false, cancelled: true };
		}
		if (action === "apply") {
			const existing = getLatestExistingLocal(ctx);
			const payload = buildWorkflowLocalPayload(existing, draft);
			try {
				writeWorkflowLocalOverride(ctx.cwd, payload);
				return notifySaved(ctx);
			} catch (error) {
				return notifyError(ctx, error instanceof Error ? error.message : String(error));
			}
		}
		if (action === "default" || action === "gonka") {
			await runReadonlyFieldsOverlay(ctx, action);
			continue;
		}
		if (action === "custom") {
			draft = await runCustomFieldsOverlay(ctx, draft, choices, loaded.config.agents);
			if (Object.keys(draft.customEdits).length > 0) {
				draft.profile = "custom";
			}
			continue;
		}
		if (action === "fallbacks") {
			draft = await runFallbackSubmenu(ctx, draft, choices, loaded.config.delegateFallbacks);
			continue;
		}
	}
}

// ============================================================================
// Runtime block: write immediately on save
// ============================================================================

async function runRuntimeBlock(
	ctx: ExtensionContext,
	loaded: ReturnType<typeof loadWorkflowConfig>,
): Promise<WorkflowConfigureResult> {
	const existingRuntime: WorkflowRuntimeDraft = {};
	if (loaded.config.delegateDisplay !== undefined) existingRuntime.delegateDisplay = loaded.config.delegateDisplay;
	if (loaded.config.delegatePaneAutoClose !== undefined) existingRuntime.delegatePaneAutoClose = loaded.config.delegatePaneAutoClose;
	const rs = loaded.config.reviewerSwarm;
	if (rs) {
		if (rs.enabled !== undefined) existingRuntime.reviewerSwarmEnabled = rs.enabled;
		if (rs.maxConcurrency !== undefined) existingRuntime.reviewerSwarmMaxConcurrency = rs.maxConcurrency;
	}
	const dp = loaded.config.deepPlanning;
	if (dp) {
		if (dp.enabled !== undefined) existingRuntime.deepPlanningEnabled = dp.enabled;
		if (dp.plannerCount !== undefined) existingRuntime.deepPlanningPlannerCount = dp.plannerCount;
		if (dp.rounds !== undefined) existingRuntime.deepPlanningRounds = dp.rounds;
		if (dp.maxConcurrency !== undefined) existingRuntime.deepPlanningMaxConcurrency = dp.maxConcurrency;
	}

	const result = await runRuntimeOverlay(ctx, existingRuntime);
	if (result.action === "cancel") {
		return { applied: false, cancelled: true };
	}

	const existingLocal = getLatestExistingLocal(ctx);
	const draft: WorkflowConfigDraft = { profile: profileFromLoaded(loaded.profileId), runtime: result.runtime, customEdits: {} };
	const payload = buildWorkflowLocalPayload(existingLocal, draft);
	try {
		writeWorkflowLocalOverride(ctx.cwd, payload);
		return notifySaved(ctx);
	} catch (error) {
		return notifyError(ctx, error instanceof Error ? error.message : String(error));
	}
}

// ============================================================================
// Sub-action handlers (model/thinking/fallback pick/clear)
// ============================================================================

/** DBG-005 chain helper for the Custom profile params menu.
 *
 *  Opens the model picker, then the thinking picker constrained to the
 *  chosen model. Esc on the model picker returns the draft unchanged
 *  (no model staged). Esc on the thinking picker returns to the model
 *  picker so the user can re-pick without losing the flow. Selecting a
 *  thinking level stages both model and thinking atomically. */
async function applyRoleModelAndThinkingPick(
	ctx: ExtensionContext,
	current: WorkflowConfigDraft,
	role: AgentName,
	choices: WorkflowModelChoice[],
): Promise<WorkflowConfigDraft> {
	const existing = current.customEdits[role];
	while (true) {
		const modelResult = await showModelPickerOverlay(
			ctx,
			choices,
			role,
			existing?.provider,
			existing?.model,
		);
		if (!modelResult) return current;
		const supported = getSupportedWorkflowThinkingLevels(modelResult.choice);
		if (supported.length === 0) {
			// No thinking levels advertised for this model -> commit model
			// only and clear any prior thinking level on this edit.
			const edit: WorkflowRoleEdit = { ...(existing ?? {}) };
			delete edit.cleared;
			edit.provider = modelResult.choice.provider;
			edit.model = modelResult.choice.id;
			delete edit.thinkingLevel;
			const customEdits: WorkflowCustomEdits = { ...current.customEdits, [role]: edit };
			return { ...current, profile: "custom", customEdits };
		}
		const currentLevel: ThinkingLevel = (existing?.thinkingLevel && supported.includes(existing.thinkingLevel))
			? existing.thinkingLevel
			: (supported.includes("off") ? "off" : (supported[0] ?? "off"));
		const thinkingResult = await showThinkingPickerOverlay(
			ctx,
			role,
			modelResult.choice,
			currentLevel,
		);
		if (!thinkingResult) continue;
		const edit: WorkflowRoleEdit = { ...(existing ?? {}) };
		delete edit.cleared;
		edit.provider = modelResult.choice.provider;
		edit.model = modelResult.choice.id;
		edit.thinkingLevel = thinkingResult.level;
		const customEdits: WorkflowCustomEdits = { ...current.customEdits, [role]: edit };
		return { ...current, profile: "custom", customEdits };
	}
}

/** DBG-005 chain helper for the Delegate fallback models submenu.
 *
 *  Mirrors `applyRoleModelAndThinkingPick` but commits to
 *  `fallbackEdits` instead of `customEdits` and seeds the initial
 *  thinking highlight from the existing fallback edit. */
async function applyFallbackModelAndThinkingPick(
	ctx: ExtensionContext,
	current: WorkflowConfigDraft,
	role: DelegateAgentName,
	choices: WorkflowModelChoice[],
): Promise<WorkflowConfigDraft> {
	const existing = current.fallbackEdits?.[role];
	while (true) {
		const modelResult = await showModelPickerOverlay(
			ctx,
			choices,
			role,
			existing?.provider,
			existing?.model,
		);
		if (!modelResult) return current;
		const supported = getSupportedWorkflowThinkingLevels(modelResult.choice);
		if (supported.length === 0) {
			const edit: WorkflowRoleEdit = {};
			edit.provider = modelResult.choice.provider;
			edit.model = modelResult.choice.id;
			const fallbackEdits: NonNullable<WorkflowConfigDraft["fallbackEdits"]> = {
				...(current.fallbackEdits ?? {}),
				[role]: edit,
			};
			return { ...current, fallbackEdits };
		}
		const currentLevel: ThinkingLevel = (existing?.thinkingLevel && supported.includes(existing.thinkingLevel))
			? existing.thinkingLevel
			: (supported.includes("off") ? "off" : (supported[0] ?? "off"));
		const thinkingResult = await showThinkingPickerOverlay(
			ctx,
			role,
			modelResult.choice,
			currentLevel,
		);
		if (!thinkingResult) continue;
		const edit: WorkflowRoleEdit = {};
		edit.provider = modelResult.choice.provider;
		edit.model = modelResult.choice.id;
		edit.thinkingLevel = thinkingResult.level;
		const fallbackEdits: NonNullable<WorkflowConfigDraft["fallbackEdits"]> = {
			...(current.fallbackEdits ?? {}),
			[role]: edit,
		};
		return { ...current, fallbackEdits };
	}
}

function applyClearRole(current: WorkflowConfigDraft, role: AgentName): WorkflowConfigDraft {
	const customEdits: WorkflowCustomEdits = { ...current.customEdits, [role]: { cleared: true } };
	return { ...current, profile: "custom", customEdits };
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
// Public entry point
// ============================================================================

/** Opens the centered overlay workflow configurator. */
export async function showWorkflowConfigureOverlay(ctx: ExtensionContext): Promise<WorkflowConfigureResult> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Workflow configuration needs interactive UI (TUI mode only).", "warning");
		return { applied: false, cancelled: true };
	}

	const loaded = loadWorkflowConfig(ctx.cwd);
	const registry = (ctx as unknown as { modelRegistry?: WorkflowModelRegistryLike | undefined }).modelRegistry;
	const collection = collectWorkflowModelChoices(registry);

	if (collection.degraded) {
		ctx.ui.notify(
			`Model registry degraded: ${collection.warning ?? "no models"}. Configure runs in a limited mode (built-in profiles and runtime fields only).`,
			"warning",
		);
	}

	while (true) {
		const action = await runRootMenuOverlay(ctx);
		if (action === null || action === "back") {
			return { applied: false, cancelled: true };
		}
		if (action === "profile") {
			const result = await runProfileBlock(ctx, currentProfileForProfileBlock(ctx, loaded.profileId));
			if (result.applied) return result;
			continue;
		}
		if (action === "profile-config") {
			const result = await runProfileConfigBlock(ctx, collection.choices, loaded);
			if (result.applied) return result;
			continue;
		}
		if (action === "runtime") {
			const result = await runRuntimeBlock(ctx, loaded);
			if (result.applied) return result;
			continue;
		}
	}
}
