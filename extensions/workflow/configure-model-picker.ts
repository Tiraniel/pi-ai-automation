// Searchable model picker overlay for the workflow configurator (TASK-028).
//
// Sourced from `WorkflowModelChoice[]` produced by
// `collectWorkflowModelChoices`; the picker is intentionally a small
// custom component (manual filter, no fuzzy dependency) and only depends
// on `Input`, `Container`, `DynamicBorder`, `Text`, `truncateToWidth`,
// and `visibleWidth` from `@earendil-works/pi-tui`.

import { type ExtensionContext, DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import type { AgentName } from "./types";
import type { WorkflowModelChoice } from "./configure-helpers";

function fitLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "…");
	const pad = Math.max(0, width - visibleWidth(clipped));
	return clipped + " ".repeat(pad);
}

export interface ModelPickerResult {
	choice: WorkflowModelChoice;
}

interface ModelPickerOptions {
	tui: { requestRender(): void };
	theme: { fg(color: string, text: string): string; bold(text: string): string };
	role: AgentName;
	choices: WorkflowModelChoice[];
	initialIndex: number;
	onSelect(choice: WorkflowModelChoice): void;
	onCancel(): void;
}

const MAX_VISIBLE = 12;

/** Opens the searchable model picker. Returns null on cancel. */
export async function showModelPickerOverlay(
	ctx: ExtensionContext,
	choices: WorkflowModelChoice[],
	role: AgentName,
	currentProvider?: string,
	currentModel?: string,
): Promise<ModelPickerResult | null> {
	if (choices.length === 0) {
		ctx.ui.notify(`No models available; cannot pick model for ${role}.`, "warning");
		return null;
	}

	const initial = currentProvider && currentModel
		? choices.findIndex((c) => c.provider === currentProvider && c.id === currentModel)
		: -1;

	return ctx.ui.custom<ModelPickerResult | null>((tui, theme, _kb, done) => {
		const picker = new ModelPicker({
			tui,
			theme,
			role,
			choices,
			initialIndex: initial,
			onSelect: (choice) => done({ choice }),
			onCancel: () => done(null),
		});
		return picker.build();
	}, { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "85%" } });
}

class ModelPicker {
	private readonly opts: ModelPickerOptions;
	private readonly searchInput: Input;
	private filtered: WorkflowModelChoice[];
	private selectedIndex: number;
	private scrollOffset: number;
	private listText: Text;
	private disposed = false;

	constructor(opts: ModelPickerOptions) {
		this.opts = opts;
		this.searchInput = new Input();
		this.filtered = [...opts.choices];
		this.selectedIndex = opts.initialIndex >= 0 ? opts.initialIndex : 0;
		this.scrollOffset = 0;
		this.listText = new Text("", 0, 0);
		this.searchInput.onSubmit = () => {
			const choice = this.filtered[this.selectedIndex];
			if (choice) this.opts.onSelect(choice);
		};
		this.renderList();
	}

	private renderList(): void {
		const out: string[] = [];
		if (this.filtered.length === 0) {
			out.push(this.opts.theme.fg("warning", "  No models match the search"));
		} else {
			const start = this.scrollOffset;
			const end = Math.min(start + MAX_VISIBLE, this.filtered.length);
			for (let i = start; i < end; i++) {
				const choice = this.filtered[i];
				if (!choice) continue;
				const isSelected = i === this.selectedIndex;
				const prefix = isSelected ? "▶ " : "  ";
				const tag = choice.reasoning === true ? " 🧠" : "";
				const name = choice.name ? `  ${choice.name}` : "";
				const line = `${prefix}${choice.fullId}${tag}${name}`;
				out.push(isSelected ? this.opts.theme.fg("accent", line) : line);
			}
			if (this.filtered.length > MAX_VISIBLE) {
				const above = this.scrollOffset;
				const below = Math.max(0, this.filtered.length - this.scrollOffset - MAX_VISIBLE);
				out.push(this.opts.theme.fg(
					"dim",
					`  ↑↓ to move (${this.filtered.length} matches, ${above} above, ${below} below)`,
				));
			} else {
				out.push(this.opts.theme.fg("dim", `  ${this.filtered.length} matches — enter to select`));
			}
		}
		this.listText.setText(out.join("\n"));
	}

	private rebuild(): void {
		const query = this.searchInput.getValue().trim().toLowerCase();
		if (!query) {
			this.filtered = [...this.opts.choices];
		} else {
			const tokens = query.split(/\s+/);
			this.filtered = this.opts.choices.filter((choice) => {
				const haystack = `${choice.fullId} ${choice.provider} ${choice.id} ${choice.name ?? ""}`.toLowerCase();
				return tokens.every((t) => haystack.includes(t));
			});
		}
		if (this.selectedIndex >= this.filtered.length) {
			this.selectedIndex = Math.max(0, this.filtered.length - 1);
		}
		this.adjustScroll();
		this.renderList();
		this.opts.tui.requestRender();
	}

	private adjustScroll(): void {
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE) {
			this.scrollOffset = this.selectedIndex - MAX_VISIBLE + 1;
		}
		if (this.scrollOffset < 0) this.scrollOffset = 0;
		const maxOffset = Math.max(0, this.filtered.length - MAX_VISIBLE);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
	}

	build(): { render(w: number): string[]; invalidate(): void; handleInput(data: string): void } {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => this.opts.theme.fg("accent", s)));
		container.addChild(new Text(this.opts.theme.fg("accent", this.opts.theme.bold(`Pick model for ${this.opts.role}`)), 1, 0));
		container.addChild(new Text(this.opts.theme.fg("dim", "Type to filter by provider/id/name, ↑↓ to move, enter to select, esc to cancel."), 1, 0));
		container.addChild(this.searchInput);
		container.addChild(this.listText);
		container.addChild(new DynamicBorder((s: string) => this.opts.theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w).map((line) => fitLine(line, w)),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (this.disposed) return;
				if (data === "\x1b" || data === "\x1b\x1b") {
					this.disposed = true;
					this.opts.onCancel();
					return;
				}
				if (data === "\x1b[A" || data === "k") {
					if (this.filtered.length === 0) return;
					this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
					this.adjustScroll();
					this.renderList();
					this.opts.tui.requestRender();
					return;
				}
				if (data === "\x1b[B" || data === "j") {
					if (this.filtered.length === 0) return;
					this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
					this.adjustScroll();
					this.renderList();
					this.opts.tui.requestRender();
					return;
				}
				if (data === "\r" || data === "\n") {
					const choice = this.filtered[this.selectedIndex];
					if (choice) {
						this.disposed = true;
						this.opts.onSelect(choice);
					}
					return;
				}
				this.searchInput.handleInput(data);
				this.rebuild();
			},
		};
	}
}
