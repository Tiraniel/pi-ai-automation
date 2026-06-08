// Runtime settings overlay for the workflow configurator (TASK-028).
//
// A small `SettingsList`-backed overlay that edits the `runtime` block of
// the staged draft. Edits stay in memory until the user calls
// `Preview & apply` in the dashboard; cancel/esc never writes disk.

import { type ExtensionContext, DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";

import {
	DELEGATE_DISPLAY_MODES,
	type DelegateDisplayMode,
} from "./types";
import type {
	WorkflowConfigDraft,
	WorkflowRuntimeDraft,
} from "./configure-helpers";

export type RuntimeOverlayOutcome =
	| { action: "save"; runtime: WorkflowRuntimeDraft }
	| { action: "cancel" };

const NUMERIC_VALUES_1_8 = ["1", "2", "3", "4", "5", "6", "7", "8"];
const ROUND_VALUES_1_4 = ["1", "2", "3", "4"];

function buildRuntimeItems(runtime: WorkflowRuntimeDraft): SettingItem[] {
	return [
		{
			id: "delegateDisplay",
			label: "Delegate display",
			description: "How delegate sessions are shown (headless/pane/auto)",
			currentValue: runtime.delegateDisplay ?? "headless",
			values: [...DELEGATE_DISPLAY_MODES],
		},
		{
			id: "delegatePaneAutoClose",
			label: "Close delegate panes",
			description: "Auto-close cmux delegate panes after completion",
			currentValue: runtime.delegatePaneAutoClose === false ? "false" : "true",
			values: ["true", "false"],
		},
		{
			id: "reviewerSwarm.enabled",
			label: "Reviewer swarm enabled",
			description: "Run reviewer swarm in parallel",
			currentValue: runtime.reviewerSwarmEnabled === false ? "false" : "true",
			values: ["true", "false"],
		},
		{
			id: "reviewerSwarm.maxConcurrency",
			label: "Reviewer swarm max concurrency",
			description: "Bounded 1-8 concurrent reviewers",
			currentValue: String(runtime.reviewerSwarmMaxConcurrency ?? 3),
			values: NUMERIC_VALUES_1_8,
		},
		{
			id: "deepPlanning.enabled",
			label: "Deep planning enabled",
			description: "Enable deep planning for this workflow",
			currentValue: runtime.deepPlanningEnabled === true ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "deepPlanning.plannerCount",
			label: "Deep planning planner count",
			description: "Bounded 1-8 planners per round",
			currentValue: String(runtime.deepPlanningPlannerCount ?? 3),
			values: NUMERIC_VALUES_1_8,
		},
		{
			id: "deepPlanning.rounds",
			label: "Deep planning rounds",
			description: "Bounded 1-4 planning rounds",
			currentValue: String(runtime.deepPlanningRounds ?? 2),
			values: ROUND_VALUES_1_4,
		},
		{
			id: "deepPlanning.maxConcurrency",
			label: "Deep planning max concurrency",
			description: "Bounded 1-8 concurrent planners",
			currentValue: String(runtime.deepPlanningMaxConcurrency ?? 3),
			values: NUMERIC_VALUES_1_8,
		},
		{
			id: "__save",
			label: "Save runtime edits",
			description: "Return staged runtime settings to the dashboard; disk still requires Preview & apply",
			currentValue: "save",
			values: ["save"],
		},
		{
			id: "__discard",
			label: "Discard runtime edits",
			description: "Return to the dashboard without staging runtime changes",
			currentValue: "discard",
			values: ["discard"],
		},
	];
}

function isDelegateDisplayMode(value: string): value is DelegateDisplayMode {
	return value === "headless" || value === "pane" || value === "auto";
}

function applyRuntimeChange(
	runtime: WorkflowRuntimeDraft,
	id: string,
	newValue: string,
): WorkflowRuntimeDraft {
	const next: WorkflowRuntimeDraft = { ...runtime };
	switch (id) {
		case "delegateDisplay":
			if (isDelegateDisplayMode(newValue)) next.delegateDisplay = newValue;
			break;
		case "delegatePaneAutoClose":
			next.delegatePaneAutoClose = newValue === "true";
			break;
		case "reviewerSwarm.enabled":
			next.reviewerSwarmEnabled = newValue === "true";
			break;
		case "reviewerSwarm.maxConcurrency": {
			const n = Number(newValue);
			if (Number.isFinite(n) && n >= 1 && n <= 8) next.reviewerSwarmMaxConcurrency = n;
			break;
		}
		case "deepPlanning.enabled":
			next.deepPlanningEnabled = newValue === "true";
			break;
		case "deepPlanning.plannerCount": {
			const n = Number(newValue);
			if (Number.isFinite(n) && n >= 1 && n <= 8) next.deepPlanningPlannerCount = n;
			break;
		}
		case "deepPlanning.rounds": {
			const n = Number(newValue);
			if (Number.isFinite(n) && n >= 1 && n <= 4) next.deepPlanningRounds = n;
			break;
		}
		case "deepPlanning.maxConcurrency": {
			const n = Number(newValue);
			if (Number.isFinite(n) && n >= 1 && n <= 8) next.deepPlanningMaxConcurrency = n;
			break;
		}
	}
	return next;
}

/** Opens the runtime settings overlay and returns the new runtime block
 *  on save, or `{ action: "cancel" }` when the user backs out. */
export async function runRuntimeOverlay(
	ctx: ExtensionContext,
	initialRuntime: WorkflowRuntimeDraft,
): Promise<RuntimeOverlayOutcome> {
	let state: WorkflowRuntimeDraft = { ...initialRuntime };

	return ctx.ui.custom<RuntimeOverlayOutcome>((tui, theme, _kb, done) => {
		const settingsList = new SettingsList(
			buildRuntimeItems(state),
			12,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "__save") {
					done({ action: "save", runtime: { ...state } });
					return;
				}
				if (id === "__discard") {
					done({ action: "cancel" });
					return;
				}
				state = applyRuntimeChange(state, id, newValue);
				// Update currentValue in place so the row reflects the
				// newly-staged value as the user cycles it.
				settingsList.updateValue(id, newValue);
				tui.requestRender();
			},
			() => done({ action: "cancel" }),
			{ enableSearch: true },
		);

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Runtime settings — staged in memory")), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Edits here stay staged until you return to the dashboard and pick 'Preview & apply'."), 1, 0));
		container.addChild(settingsList);
		container.addChild(new Text(theme.fg("dim", "Enter cycles values • choose 'Save runtime edits' to stage • Esc/discard returns without staging"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => {
				container.invalidate();
				settingsList.invalidate();
			},
			handleInput: (input: string) => {
				if (input === "\x1b" || input === "\x1b\x1b") {
					done({ action: "cancel" });
					return;
				}
				settingsList.handleInput(input);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "85%" } });
}

export function emptyRuntimeForDraft(draft: WorkflowConfigDraft): WorkflowRuntimeDraft {
	return { ...draft.runtime };
}
