// Preview / confirm / apply overlay for the workflow configurator (TASK-028).
//
// Renders a read-only preview of the staged draft (built by the Phase A
// `buildWorkflowLocalPreviewText` helper) plus a centered Apply/Cancel
// selector. Apply writes atomically via `writeWorkflowLocalOverride`
// (from `./configure-io`); Cancel/esc returns to the previous step
// without touching disk.

import { type ExtensionContext, DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import {
	buildWorkflowLocalPayload,
	buildWorkflowLocalPreviewText,
	type WorkflowConfigDraft,
} from "./configure-helpers";
import {
	displayWorkflowLocalPath,
	writeWorkflowLocalOverride,
} from "./configure-io";

export interface WorkflowConfigureResult {
	applied: boolean;
	cancelled: boolean;
	warning?: string;
}

/** Renders the preview/confirm overlay and applies the staged draft on Apply. */
export async function runPreviewOverlay(
	ctx: ExtensionContext,
	existingLocal: Record<string, unknown>,
	draft: WorkflowConfigDraft,
	warningFromRegistry?: string,
): Promise<WorkflowConfigureResult> {
	const extraWarnings: string[] = [];
	if (warningFromRegistry) extraWarnings.push(warningFromRegistry);
	const payloadPreview = buildWorkflowLocalPreviewText(existingLocal, draft, { extraWarnings });

	const action = await ctx.ui.custom<"apply" | "cancel">((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Workflow configuration — preview & confirm")), 1, 0));

		container.addChild(new PreviewBlock(payloadPreview));

		container.addChild(new Text(theme.fg("dim", "Apply writes `.pi/workflow.local.json` atomically. Cancel backs out without writing."), 1, 0));

		const buttonItems: SelectItem[] = [
			{ value: "apply", label: "Apply", description: "Write .pi/workflow.local.json" },
			{ value: "cancel", label: "Cancel", description: "Back out without writing" },
		];
		const selectList = new SelectList(buttonItems, buttonItems.length, getSelectListTheme());
		selectList.onSelect = (item) => done(item.value === "apply" ? "apply" : "cancel");
		selectList.onCancel = () => done("cancel");
		container.addChild(selectList);

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

	if (action !== "apply") {
		return { applied: false, cancelled: true };
	}

	const payload = buildWorkflowLocalPayload(existingLocal, draft);
	try {
		writeWorkflowLocalOverride(ctx.cwd, payload);
		ctx.ui.notify(`Saved workflow override to ${displayWorkflowLocalPath(ctx.cwd)}`, "info");
		return { applied: true, cancelled: false };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to save workflow override: ${message}`, "error");
		return { applied: false, cancelled: false, warning: message };
	}
}

/** Read-only preview block. Renders the first ~14 lines of the preview
 *  text plus a truncation hint. */
class PreviewBlock {
	private text: string;

	constructor(text: string) {
		this.text = text;
	}

	invalidate(): void {}

	handleInput(_data: string): void {}

	render(width: number): string[] {
		const inner = Math.max(10, width - 2);
		const allLines = this.text.split("\n");
		const maxVisible = 14;
		const slice = allLines.slice(0, maxVisible);
		const out: string[] = [];
		out.push("─".repeat(inner));
		for (const line of slice) {
			out.push(truncateToWidth(line, inner, "…"));
		}
		out.push("─".repeat(inner));
		out.push(allLines.length > maxVisible
			? `… (${allLines.length - maxVisible} more lines below)`
			: "(read-only preview)");
		while (out.length < maxVisible + 3) out.push("");
		return out.map((line) => padVisible(line, inner));
	}
}

function padVisible(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w >= width) return line;
	return line + " ".repeat(width - w);
}
