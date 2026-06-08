// Profile picker overlay for the workflow configurator (DBG-003).
//
// In-place profile selector with check markers. Rows: Default, Gonka
// (env-gated), Custom, Apply, Back. Selecting a profile row moves the
// check (✓) marker and keeps the user in the menu. Apply writes the
// selected profile; Back leaves without writing.
//
// Gonka visibility is gated by process.env.GONKA_BROKER_API_KEY (already
// loaded from ~/.pi/.env at startup), NOT by model registry presence.

import { type ExtensionContext, DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";

import type { WorkflowDraftProfile } from "./configure-helpers";

export type ProfilePickerOutcome = WorkflowDraftProfile | "back";

interface RunProfileOverlayOptions {
	/** True when GONKA_BROKER_API_KEY is configured via process env or
	 *  the already-loaded ~/.pi/.env. Controls Gonka row visibility. */
	gonkaEnvConfigured: boolean;
	/** The currently active profile; shown with a ✓ marker. */
	currentProfile: WorkflowDraftProfile;
}

function labelForProfile(profile: WorkflowDraftProfile): string {
	return profile === "default" ? "Default" : profile === "gonka" ? "Gonka" : "Custom";
}

function buildProfileItems(selected: WorkflowDraftProfile, gonkaEnvConfigured: boolean): SelectItem[] {
	const items: SelectItem[] = [];
	items.push({
		value: "default",
		label: `${selected === "default" ? "✓ " : "  "}Default`,
		description: "Use built-in default profile",
	});
	if (gonkaEnvConfigured) {
		items.push({
			value: "gonka",
			label: `${selected === "gonka" ? "✓ " : "  "}Gonka`,
			description: "Use gonka-hybrid profile (premium brain + Gonka workers)",
		});
	}
	items.push({
		value: "custom",
		label: `${selected === "custom" ? "✓ " : "  "}Custom`,
		description: "Use custom per-role overrides",
	});
	items.push({ value: "apply", label: "Apply", description: "Write selected profile to .pi/workflow.local.json" });
	items.push({ value: "back", label: "Back", description: "Return without applying" });
	return items;
}

/** Opens the profile picker overlay. Returns the chosen profile when the
 *  user presses Apply, or `"back"` when the user presses Back or cancels.
 *  Gonka is omitted when env is not configured. */
export async function runProfileOverlay(
	ctx: ExtensionContext,
	options: RunProfileOverlayOptions,
): Promise<ProfilePickerOutcome> {
	let selected = options.currentProfile;

	return ctx.ui.custom<ProfilePickerOutcome>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Profile selection")), 1, 0));
		container.addChild(new Text(theme.fg("dim", `Current: ${labelForProfile(options.currentProfile)}`), 1, 0));
		if (!options.gonkaEnvConfigured) {
			container.addChild(new Text(theme.fg("dim", "Gonka hidden (GONKA_BROKER_API_KEY not configured)."), 1, 0));
		}

		const items = buildProfileItems(selected, options.gonkaEnvConfigured);
		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme(), {
			minPrimaryColumnWidth: 22,
			maxPrimaryColumnWidth: 40,
		});
		selectList.onSelect = (item) => {
			if (item.value === "apply") {
				done(selected);
				return;
			}
			if (item.value === "back") {
				done("back");
				return;
			}
			selected = item.value as WorkflowDraftProfile;
			// Mutate labels in place so SelectList renders the moved ✓
			for (const it of items) {
				if (it.value === "default" || it.value === "gonka" || it.value === "custom") {
					it.label = `${selected === it.value ? "✓ " : "  "}${labelForProfile(it.value as WorkflowDraftProfile)}`;
				}
			}
			tui.requestRender();
		};
		selectList.onCancel = () => done("back");

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (input: string) => {
				selectList.handleInput(input);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "85%" } });
}
