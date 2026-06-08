// Thinking-level picker overlay for the workflow configurator (TASK-028).
//
// Constrained by the supplied `WorkflowModelChoice` via
// `getSupportedWorkflowThinkingLevels` (Phase A helper). When the helper
// returns an empty list we surface a warning and return null instead of
// offering an invalid level. Non-reasoning models only offer `off`.
//
// Returns the chosen `ThinkingLevel` on select, or `null` on cancel.

import { type ExtensionContext, DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";

import type { ThinkingLevel, AgentName } from "./types";
import { getSupportedWorkflowThinkingLevels, type WorkflowModelChoice } from "./configure-helpers";

export interface ThinkingPickerResult {
	level: ThinkingLevel;
}

/** Opens the thinking-level picker constrained by the supplied model
 *  choice. Returns `null` on cancel, and surfaces a warning (no
 *  outcome) when the choice yields no usable levels. */
export async function showThinkingPickerOverlay(
	ctx: ExtensionContext,
	role: AgentName,
	choice: WorkflowModelChoice | undefined,
	currentLevel: ThinkingLevel,
): Promise<ThinkingPickerResult | null> {
	const supported = getSupportedWorkflowThinkingLevels(choice);
	if (supported.length === 0) {
		ctx.ui.notify(`No thinking levels available for ${role} (registry reported none for the selected model).`, "warning");
		return null;
	}
	const items: SelectItem[] = supported.map((level) => ({
		value: level,
		label: level,
		description: level === currentLevel ? "current/supported" : "supported",
	}));

	return ctx.ui.custom<ThinkingPickerResult | null>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`Pick thinking level for ${role}`)), 1, 0));
		container.addChild(new Text(
			theme.fg("dim", choice
				? `Constrained by ${choice.fullId} metadata: ${supported.join(", ") || "(empty)"}`
				: "No model selected; showing all THINKING_LEVELS."),
			1,
			0,
		));

		const selectList = new SelectList(items, items.length, getSelectListTheme());
		selectList.onSelect = (item) => done({ level: item.value as ThinkingLevel });
		selectList.onCancel = () => done(null);
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
	}, { overlay: true, overlayOptions: { anchor: "center", width: 60, maxHeight: "70%" } });
}
