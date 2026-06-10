#!/usr/bin/env node
// Fake UI harness + fake ExtensionContext for behavior-driving /workflow_cfg overlays.
//
// - Drives production overlay components through `ctx.ui.custom(...)` callbacks.
// - Feeds semantic keys (arrow/enter/escape/search text) to rendered overlays.
// - Captures render output for behavioral assertions.
// - Uses an explicit temp `cwd` and injected registry fixture (no real project writes).

import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowModelRegistryLike } from "../extensions/workflow/configure-helpers";

// Ensure selector/list themes are safe in non-TUI test contexts.
initTheme();

type CustomOverlay = {
	render: (width: number) => string[];
	invalidate(): void;
	handleInput(data: string): void;
};

type RenderFn<T> = (
	tui: { requestRender(): void },
	theme: { fg(color: string, text: string): string; bold(text: string): string },
	kb: unknown,
	done: (value: T) => void,
) => CustomOverlay;

export interface WorkflowCfgOverlayStep {
	name: string;
	inputs: string[];
	assertInitial?: (renderedLines: string[]) => void;
	assertAfterInput?: (input: string, renderedLines: string[], inputIndex: number) => void;
	assertFinal?: (renderedLines: string[]) => void;
	allowNoResolve?: boolean;
}

export interface WorkflowCfgOverlayRunRecord {
	name: string;
	inputs: string[];
	renders: string[][];
	result: unknown;
}

export interface WorkflowCfgHarnessResult {
	result: unknown;
	runs: WorkflowCfgOverlayRunRecord[];
	notifications: Array<{ message: string; severity?: string }>;
}

interface MakeHarnessOptions {
	cwd: string;
	registry?: WorkflowModelRegistryLike;
	steps: WorkflowCfgOverlayStep[];
	overlayWidth?: number;
	notifyLog?: Array<{ message: string; severity?: string }>;
}

function defaultRegistryStep(): WorkflowCfgOverlayStep {
	return { name: "fallback-escape", inputs: ["\x1b"], assertInitial: () => {} };
}

function safeRender(overlay: CustomOverlay, width: number): string[] {
	try {
		return overlay.render(width);
	} catch {
		return [];
	}
}

/**
 * Creates a fake `ExtensionContext` whose `ui.custom` executes scripted key flows
 * against production overlay implementations.
 */
export function makeWorkflowCfgFakeUiHarness(options: MakeHarnessOptions) {
	const { cwd, registry, overlayWidth = 120 } = options;
	const runs: WorkflowCfgOverlayRunRecord[] = [];
	const notifications: Array<{ message: string; severity?: string }> = options.notifyLog ?? [];
	let invocationIndex = 0;

	const fakeTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const fakeTui = {
		requestRender: () => {},
	};

	const ctx = {
		cwd,
		hasUI: true,
		modelRegistry: registry,
		ui: {
			custom: async <T>(render: RenderFn<T>) => {
				const step = options.steps[invocationIndex] ?? defaultRegistryStep();
				invocationIndex += 1;
				const runRecord: WorkflowCfgOverlayRunRecord = {
					name: step.name,
					inputs: [...step.inputs],
					renders: [],
					result: undefined,
				};
				runs.push(runRecord);

				let done = false;
				let doneValue: unknown = undefined;
				let lastRendered: string[] = [];

				const doneFn = (value: T) => {
					if (done) return;
					done = true;
					doneValue = value;
				};

				const overlay = render(fakeTui, fakeTheme, {} as unknown, doneFn);
				const runOnce = () => {
					lastRendered = safeRender(overlay, overlayWidth);
					runRecord.renders.push(lastRendered);
					return lastRendered;
				};

				const initial = runOnce();
				if (step.assertInitial) {
					step.assertInitial(initial);
				}

				for (let i = 0; i < step.inputs.length; i += 1) {
					if (done) break;
					overlay.handleInput(step.inputs[i]);
					const rendered = runOnce();
					if (step.assertAfterInput) {
						step.assertAfterInput(step.inputs[i], rendered, i);
					}
				}

				if (!done && !step.allowNoResolve) {
					throw new Error(`workflow-cfg fake ui step "${step.name}" did not resolve`);
				}
				if (step.assertFinal && lastRendered.length > 0) {
					step.assertFinal(lastRendered);
				}

				runRecord.result = doneValue;
				return doneValue as T;
			},
			notify: (message: string, severity?: string) => {
				notifications.push({ message, severity });
			},
		},
	} as unknown as ExtensionContext & { modelRegistry?: WorkflowModelRegistryLike };

	const run = async <T>(runner: (ctx: ExtensionContext) => Promise<T>): Promise<WorkflowCfgHarnessResult & { result: T }> => {
		const result = await runner(ctx);
		return { result, runs, notifications };
	};

	return {
		ctx,
		runs,
		notifyLog: notifications,
		run,
	};
}

export function makeLineValue(lines: string[] | undefined, predicate: (line: string) => boolean): string | undefined {
	if (!lines) return undefined;
	for (const line of lines) {
		if (predicate(line)) return line;
	}
	return undefined;
}

export function makeRegistryStub(entries: unknown[]): WorkflowModelRegistryLike {
	return { getAvailable: () => entries };
}
