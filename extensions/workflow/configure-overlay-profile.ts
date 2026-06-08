// Profile picker overlay for the workflow configurator (TASK-028).
//
// Single-screen SelectList with three options (Default, Gonka, Custom)
// plus Cancel. Gonka is rendered as disabled when no gonka model is
// available in `choices` (Gating invariant from the architecture plan).

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
	/** True when the registry exposes a Gonka model — controls whether
	 *  the Gonka row is selectable. */
	gonkaAvailable: boolean;
	/** The currently active profile; omitted from selectable rows to avoid
	 *  no-op selections. */
	currentProfile: WorkflowDraftProfile;
}

/** Opens the profile picker overlay. Returns the chosen profile or
 *  `"back"` when the user cancels. The current profile is omitted from
 *  selectable rows; Gonka is omitted when unavailable. */
export async function runProfileOverlay(
	ctx: ExtensionContext,
	options: RunProfileOverlayOptions,
): Promise<ProfilePickerOutcome> {
	const items: SelectItem[] = [];

	if (options.currentProfile !== "default") {
		items.push({ value: "default", label: "Default", description: "Use built-in default profile" });
	}
	if (options.currentProfile !== "gonka") {
		if (options.gonkaAvailable) {
			items.push({
				value: "gonka",
				label: "Gonka",
				description: "Use gonka-hybrid profile (preserves existing custom role overrides)",
			});
		}
		// When Gonka is unavailable we omit the row entirely (no selectable
		// no-op) and surface the hint in header text instead.
	}
	if (options.currentProfile !== "custom") {
		items.push({ value: "custom", label: "Custom per-role", description: "Edit per-role model/thinking + runtime knobs" });
	}
	items.push({ value: "back", label: "Back", description: "Return to previous menu" });

	const currentLabel = options.currentProfile === "default" ? "Default" : options.currentProfile === "gonka" ? "Gonka" : "Custom per-role";
	const gonkaHint = !options.gonkaAvailable && options.currentProfile !== "gonka"
		? " Gonka is unavailable (no gonka provider configured)."
		: "";

	return ctx.ui.custom<ProfilePickerOutcome>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Workflow configuration — profile")), 1, 0));
		container.addChild(new Text(theme.fg("dim", `Current profile: ${currentLabel}.${gonkaHint}`), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Default and Gonka do not overwrite existing local role overrides."), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme(), {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 30,
		});
		selectList.onSelect = (item) => {
			if (item.value === "back") return done("back");
			done(item.value as WorkflowDraftProfile);
		};
		selectList.onCancel = () => done("back");

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
	}, { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "85%" } });
}
