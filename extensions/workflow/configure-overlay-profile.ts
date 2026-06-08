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
}

/** Opens the profile picker overlay. Returns the chosen profile or
 *  `"back"` when the user cancels. Gonka is gated by `gonkaAvailable`;
 *  selecting it when unavailable is a no-op. */
export async function runProfileOverlay(
	ctx: ExtensionContext,
	options: RunProfileOverlayOptions,
): Promise<ProfilePickerOutcome> {
	const items: SelectItem[] = [
		{ value: "default", label: "Default", description: "Use built-in default profile" },
		{
			value: "gonka",
			label: options.gonkaAvailable ? "Gonka" : "Gonka (unavailable)",
			description: options.gonkaAvailable
				? "Use gonka-hybrid profile (preserves existing custom role overrides)"
				: "No gonka provider configured; selecting will be blocked",
		},
		{ value: "custom", label: "Custom per-role", description: "Edit per-role model/thinking + runtime knobs" },
		{ value: "back", label: "Cancel", description: "Keep current workflow" },
	];

	return ctx.ui.custom<ProfilePickerOutcome>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Workflow configuration — profile")), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Default and Gonka do not overwrite existing local role overrides."), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme(), {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 30,
		});
		selectList.onSelect = (item) => {
			if (item.value === "back") return done("back");
			if (item.value === "gonka" && !options.gonkaAvailable) {
				// Visually unselectable: do nothing on enter.
				return;
			}
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
