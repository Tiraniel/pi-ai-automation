#!/usr/bin/env node
// TASK-008 behavior smoke for `/workflow_cfg`.
// This is the primary behavior assertion command.
// Static/source-string checks in task-028 remain secondary compatibility checks.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { showWorkflowConfigureOverlay } from "../extensions/workflow/configure-overlay";
import {
	makeLineValue,
	makeRegistryStub,
	makeWorkflowCfgFakeUiHarness,
	type WorkflowCfgOverlayStep,
} from "./workflow-cfg-fake-ui-harness";

interface StepResult {
	applied: boolean;
	cancelled: boolean;
	warning?: string;
}

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) {
		console.log(`PASS: ${message}`);
		return;
	}
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function makeTempProjectDir(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task-008-workflow-cfg-"));
	const projectDir = path.join(tmp, "project");
	fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	return projectDir;
}

function writeLocalConfig(cwd: string, data: unknown): void {
	const file = path.join(cwd, ".pi", "workflow.local.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function readLocalConfig(cwd: string): unknown {
	const file = path.join(cwd, ".pi", "workflow.local.json");
	if (!fs.existsSync(file)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function hasLine(lines: string[] | undefined, text: string): boolean {
	return lines ? lines.some((line) => line.includes(text)) : false;
}

function stripRenderCodes(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

function hasRenderedTitle(lines: string[] | undefined, title: string): boolean {
	const normalizedTitle = title.trim();
	return lines ? lines.some((line) => stripRenderCodes(line) === normalizedTitle) : false;
}

function findStandaloneThinkingLine(lines: string[] | undefined): string | undefined {
	if (!lines) return undefined;
	for (const line of lines) {
		const lower = line.toLowerCase();
		if (lower.includes("brain thinking") || lower.includes("coder thinking") || lower.includes("reviewer thinking")) {
			return line;
		}
	}
	return undefined;
}

function assertNoStandaloneThinkingLines(lines: string[] | undefined): void {
	const invalidLine = findStandaloneThinkingLine(lines);
	if (invalidLine !== undefined) {
		throw new Error(`standalone thinking row detected: ${invalidLine}`);
	}
}

function containsAnyStandaloneThinking(lines: string[] | undefined): boolean {
	return findStandaloneThinkingLine(lines) !== undefined;
}

function expectFailure(description: string, run: () => void): void {
	try {
		run();
		check(false, `${description}: expected failure but no failure was thrown`);
	} catch {
		check(true, `${description}: failure path rejected invalid fixture`);
	}
}

function makeMarker(lines: string[] | undefined, predicate: (line: string) => boolean): string | undefined {
	if (!lines) return undefined;
	return makeLineValue(lines, predicate);
}

function normalizeForCompare(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map((entry) => normalizeForCompare(entry));
	if (typeof value === "object") {
		const entries = Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => [key, normalizeForCompare((value as Record<string, unknown>)[key])]);
		const out: Record<string, unknown> = {};
		for (const [key, next] of entries) {
			out[key] = next;
		}
		return out;
	}
	return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

function assertRealLocalNotTouched(fnName: string): { before: string | undefined } {
	const realPath = path.join(process.cwd(), ".pi", "workflow.local.json");
	const before = fs.existsSync(realPath) ? fs.readFileSync(realPath, "utf8") : undefined;
	return {
		before,
	};
}

function assertRealLocalUntouched(fnName: string, before: string | undefined): void {
	const realPath = path.join(process.cwd(), ".pi", "workflow.local.json");
	if (before === undefined) {
		check(!fs.existsSync(realPath), `${fnName}: real .pi/workflow.local.json not created`);
		return;
	}
	check(fs.readFileSync(realPath, "utf8") === before, `${fnName}: real .pi/workflow.local.json unchanged`);
}

async function runScenario(
	name: string,
	steps: WorkflowCfgOverlayStep[],
	initialLocal: unknown,
	assertions?: (ctx: { cwd: string }) => Promise<void> | void,
): Promise<{ result: StepResult; localAfter: unknown } & { cwd: string }> {
	const cwd = makeTempProjectDir();
	writeLocalConfig(cwd, initialLocal);
	const marker = assertRealLocalNotTouched(name);

	const harness = makeWorkflowCfgFakeUiHarness({
		cwd,
		registry: makeRegistryStub(MODEL_REGISTRY_ENTRIES),
		steps,
	});

	const outcome = await harness.run(async (ctx) => {
		return (await showWorkflowConfigureOverlay(ctx)) as StepResult;
	});

	check(harness.runs.length === steps.length, `${name}: overlay stack consumed exactly ${steps.length} scripted steps`);
	assertRealLocalUntouched(name, marker.before);
	const localAfter = readLocalConfig(cwd);
	await assertions?.({ cwd });
	return { cwd, result: outcome.result as StepResult, localAfter };
}

const MODEL_REGISTRY_ENTRIES = [
	{ provider: "openai-codex", id: "gpt-5.5", reasoning: true, thinkingLevelMap: { off: "off", minimal: "minimal", medium: "medium", high: "high", xhigh: "xhigh" } },
	{ provider: "openai-codex", id: "gpt-5.5-codex", reasoning: false, thinkingLevelMap: { off: "off" } },
	{ provider: "gonka", id: "moonshotai/Kimi-K2.6", reasoning: true, thinkingLevelMap: { off: "off", medium: "medium", high: "high", xhigh: "xhigh" } },
	{ provider: "minimax", id: "MiniMax-M3", reasoning: false, thinkingLevelMap: { off: "off" } },
];

async function scenarioProfileCustomMarkerAndPreserveDefault(): Promise<void> {
	const initial = {
		agents: {
			brain: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" },
			coder: { provider: "minimax", model: "MiniMax-M3", thinkingLevel: "off" },
		},
	};
	const previous = process.env.GONKA_BROKER_API_KEY;
	delete process.env.GONKA_BROKER_API_KEY;
	try {
		const { result, localAfter, cwd } = await runScenario(
			"profile-local-custom-selection-preserved-default",
			[
				{
					name: "root -> profile block",
					inputs: ["\r"],
					assertFinal: (lines) => {
						check(lines[0]?.includes("Workflow configuration") || hasLine(lines, "Profile"), "root menu rendered");
					},
				},
				{
					name: "profile overlay default path",
					inputs: ["\r", "\x1b[B", "\x1b[B", "\r"],
					assertInitial: (lines) => check(hasLine(lines, "✓ Custom"), "local agents => Profile selector shows Custom"),
					assertAfterInput: (input, lines) => {
						if (input === "\r") {
							check(hasLine(lines, "✓ Default"), "default profile selected before apply");
						}
					},
				},
			],
			initial,
		);
		check(result.applied, "profile default apply returns applied result");
		check(
			(localAfter as { profile?: string } | undefined)?.profile === "default",
			"profile write uses 'default' id when selecting Default",
		);
		check(
			deepEqual((localAfter as { agents?: unknown })?.agents, (initial as { agents?: unknown }).agents),
			"Default profile apply preserves local custom agents",
		);
		check(
			readLocalConfig(cwd) !== undefined,
			"profile scenario produced local config under temporary cwd",
		);
	} finally {
		if (previous === undefined) {
			delete process.env.GONKA_BROKER_API_KEY;
		} else {
			process.env.GONKA_BROKER_API_KEY = previous;
		}
	}
}

async function scenarioProfileGonkaPreservesCustom(): Promise<void> {
	const previous = process.env.GONKA_BROKER_API_KEY;
	process.env.GONKA_BROKER_API_KEY = "integration-test-token";
	try {
		const initial = {
			agents: {
				reviewer: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "high" },
			},
		};
		const { result, localAfter } = await runScenario(
			"profile-gonka-preserves-custom",
			[
				{ name: "root -> profile block", inputs: ["\r"] },
				{
					name: "profile overlay gonka path",
					inputs: ["\x1b[B", "\r", "\x1b[B", "\x1b[B", "\r"],
					assertInitial: (lines) => check(hasLine(lines, "✓ Custom"), "local agents => Profile overlay starts from Custom"),
					assertAfterInput: (input, lines) => {
						if (input === "\r") {
							check(hasLine(lines, "✓ Gonka"), "gonka row selected before apply");
						}
					},
				},
			],
			initial,
		);
		check(result.applied, "profile gonka apply returns applied result");
		check((localAfter as { profile?: string } | undefined)?.profile === "gonka-hybrid", "gonka apply writes gonka-hybrid");
		check(
			deepEqual((localAfter as { agents?: unknown })?.agents, (initial as { agents?: unknown }).agents),
			"gonka apply preserves local custom agents",
		);
	} finally {
		if (previous === undefined) {
			delete process.env.GONKA_BROKER_API_KEY;
		} else {
			process.env.GONKA_BROKER_API_KEY = previous;
		}
	}
}

async function scenarioModelChainBackSemanticsAndNoStandaloneThinkingRows(): Promise<void> {
	const initial = {
		agents: {
			brain: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" },
		},
	};
	const previous = process.env.GONKA_BROKER_API_KEY;
	delete process.env.GONKA_BROKER_API_KEY;
	try {
		let brainSearchMark: string | undefined;
		let brainDownMark: string | undefined;
		let brainUpMark: string | undefined;

		const { result, localAfter } = await runScenario(
			"model-picker-chain-back-semantics",
			[
				{ name: "root -> profile config", inputs: ["\x1b[B", "\r"] },
				{ name: "profile config -> custom", inputs: ["\x1b[B", "\r"] },
				{
					name: "custom fields open brain model",
					inputs: ["\r"],
					assertInitial: (lines) => {
						check(!containsAnyStandaloneThinking(lines), "no standalone thinking rows in custom fields");
						check(hasLine(lines, "brain model"), "custom fields includes brain model row");
					},
				},
				{
					name: "brain model picker with search + arrows",
					inputs: ["o", "\x1b[B", "\x1b[A", "\r"],
					assertInitial: (lines) => {
						check(hasLine(lines, "Pick model for brain"), "nested brain model picker opens");
					},
					assertAfterInput: (input, lines) => {
						if (input === "o") brainSearchMark = makeMarker(lines, (line) => line.includes("▶ "));
						if (input === "\x1b[B") brainDownMark = makeMarker(lines, (line) => line.includes("▶ "));
						if (input === "\x1b[A") brainUpMark = makeMarker(lines, (line) => line.includes("▶ "));
					},
					assertFinal: () => {
						check(brainSearchMark !== undefined && brainDownMark !== undefined && brainUpMark !== undefined, "brain model picker emits selected row markers while searching");
						check(brainDownMark !== brainSearchMark, "arrow down changes search-filtered selection");
						check(brainUpMark !== brainDownMark, "arrow up changes selection away from down result");
						check(brainUpMark === brainSearchMark, "arrow up returns to search-start selection");
					},
				},
				{
					name: "brain thinking returns to model on escape",
					inputs: ["\x1b"],
					allowNoResolve: true,
					assertInitial: (lines) => check(hasLine(lines, "Pick thinking level for brain"), "brain model selection opens thinking"),
				},
				{ name: "model picker after thinking escape", inputs: [], allowNoResolve: true, assertInitial: (lines) => check(hasRenderedTitle(lines, "Pick model for brain"), "Esc in thinking returns model picker") },
				{ name: "brain model escape returns params", inputs: ["\x1b"], allowNoResolve: true, assertInitial: (lines) => check(hasRenderedTitle(lines, "Custom profile fields"), "esc in model picker returns custom fields") },
				{ name: "custom fields after model escape", inputs: [], allowNoResolve: true, assertInitial: (lines) => check(hasRenderedTitle(lines, "Profile config"), "custom back returns Profile config") },
				{ name: "custom back to profile config", inputs: ["\x1b"], allowNoResolve: true },
				{ name: "root after profile config back", inputs: [], allowNoResolve: true, assertInitial: (lines) => check(hasRenderedTitle(lines, "Workflow configuration"), "profile config back returns Workflow configuration") },
				{ name: "root back", inputs: ["\x1b"], assertFinal: (lines) => check(lines.length > 0, "root back exits overlay") },
			],
			initial,
		);

		check(result.applied === false, "model chain scenario ended via back path");
		check(deepEqual((localAfter as { agents?: unknown })?.agents, (initial as { agents?: unknown }).agents), "model-picker no-write paths do not alter local custom agents");
	} finally {
		if (previous === undefined) {
			delete process.env.GONKA_BROKER_API_KEY;
		} else {
			process.env.GONKA_BROKER_API_KEY = previous;
		}
	}
}

async function scenarioModelChainForRole(role: "coder" | "reviewer"): Promise<void> {
	const initial = {} as const;
	const previous = process.env.GONKA_BROKER_API_KEY;
	delete process.env.GONKA_BROKER_API_KEY;
	const roleDownPresses = role === "coder" ? 1 : 2;
	let modelSearchMark: string | undefined;
	let modelDownMark: string | undefined;
	let modelUpMark: string | undefined;

	try {
		const { result, localAfter } = await runScenario(
			`model-${role}-picker-think-chain`,
			[
				{ name: "root -> profile config", inputs: ["\x1b[B", "\r"] },
				{ name: "profile config -> custom", inputs: ["\x1b[B", "\r"] },
				{
					name: `custom fields open ${role} model`,
					inputs: [...Array.from({ length: roleDownPresses }, () => "\x1b[B"), "\r"],
					assertInitial: (lines) => {
						assertNoStandaloneThinkingLines(lines);
						check(hasLine(lines, `${role} model`), `${role} model row appears in custom fields`);
					},
				},
				{
					name: `${role} model picker with search + arrows`,
					inputs: ["o", "\x1b[B", "\x1b[A", "\r"],
					assertInitial: (lines) => {
						check(hasLine(lines, `Pick model for ${role}`), `${role} model picker opens`);
					},
					assertAfterInput: (input, lines) => {
						if (input === "o") modelSearchMark = makeMarker(lines, (line) => line.includes("▶ "));
						if (input === "\x1b[B") modelDownMark = makeMarker(lines, (line) => line.includes("▶ "));
						if (input === "\x1b[A") modelUpMark = makeMarker(lines, (line) => line.includes("▶ "));
					},
					assertFinal: () => {
						check(modelSearchMark !== undefined && modelDownMark !== undefined && modelUpMark !== undefined, `${role} model picker emits selected row markers while searching`);
						check(modelDownMark !== modelSearchMark, `${role} model picker arrow down moves selection while searching`);
						check(modelUpMark !== modelDownMark, `${role} model picker records up-arrow selection change from down`);
						check(modelUpMark === modelSearchMark, `${role} model picker arrow up returns to search-start selection`);
					},
				},
				{
					name: `${role} thinking picker opens from model row`,
					inputs: ["\r"],
					allowNoResolve: true,
					assertInitial: (lines) => {
						check(hasLine(lines, `Pick thinking level for ${role}`), `${role} model selection opens thinking picker`);
					},
				},
				{ name: `${role} model picker after thinking escape`, inputs: ["\x1b"], allowNoResolve: true },
				{ name: `${role} model after thinking escape`, inputs: [], allowNoResolve: true, assertInitial: (lines) => check(hasRenderedTitle(lines, "Profile config"), `${role} returns to profile config after thinking escape`) },
				{ name: `${role} custom fields after model escape`, inputs: ["\x1b"], allowNoResolve: true },
				{ name: `${role} root after profile config back`, inputs: [], allowNoResolve: true, assertInitial: (lines) => check(hasRenderedTitle(lines, "Workflow configuration"), `${role} profile config back returns root`) },
				{ name: `${role} root back`, inputs: ["\x1b"], assertFinal: (lines) => check(lines.length > 0, `${role} root back exits overlay`) },
			],
			initial,
		);

		check(result.applied === false, `${role}: model chain exits via back path`);
		check(deepEqual((localAfter as { agents?: unknown })?.agents, (initial as { agents?: unknown }).agents), `${role}: model-picker no-write path does not alter local custom agents`);
	} finally {
		if (previous === undefined) {
			delete process.env.GONKA_BROKER_API_KEY;
		} else {
			process.env.GONKA_BROKER_API_KEY = previous;
		}
	}
}

function scenarioBrokenStandaloneThinkingFixtureRejected(): void {
	expectFailure("negative fixture", () => {
		assertNoStandaloneThinkingLines([
			"  brain model",
			"  brain thinking",
			"  coder model",
			"  reviewer thinking",
			"  reviewer model",
			"  coder thinking",
		]);
	});
}

async function scenarioRuntimeSaveAndRuntimeOnlyBackPaths(): Promise<void> {
	const initial = {
		agents: { brain: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" } },
		reviewerSwarm: { enabled: false, maxConcurrency: 1 },
		deepPlanning: { enabled: false, plannerCount: 1, rounds: 1, maxConcurrency: 1 },
		delegateDisplay: "headless",
		delegatePaneAutoClose: true,
		unknown: { keep: "me" },
	};

	const save = await runScenario(
		"runtime-save-updates-runtime-only",
		[
			{ name: "root -> runtime", inputs: ["\x1b[B", "\x1b[B", "\r"] },
			{
				name: "runtime edit + save",
				inputs: ["\r", ...Array.from({ length: 8 }, () => "\x1b[B"), "\r"],
				assertInitial: (lines) => check(hasLine(lines, "Runtime settings"), "runtime overlay opens"),
			},
		],
		initial,
	);

	const saved = save.localAfter as any;
	check(save.result.applied === true, "runtime save returns applied");
	check(saved?.delegateDisplay === "pane", "runtime save updated delegateDisplay only runtime field");
	check(saved?.unknown?.keep === "me", "runtime save preserved unknown top-level field");
	check(saved?.agents?.brain?.provider === "openai-codex", "runtime save preserved agent provider");
	check(saved?.reviewerSwarm?.enabled === false && saved?.reviewerSwarm?.maxConcurrency === 1, "runtime save preserved reviewerSwarm");
	check(saved?.deepPlanning?.enabled === false && saved?.deepPlanning?.rounds === 1, "runtime save preserved deepPlanning");
	check(!(Object.prototype.hasOwnProperty.call(saved ?? {}, "profile")), "runtime save does not write profile field (intentional pre-fix regression guard)");

	const cancel = await runScenario(
		"runtime-cancel-no-write",
		[
			{ name: "root -> runtime", inputs: ["\x1b[B", "\x1b[B", "\r"] },
			{ name: "runtime cancel", inputs: ["\x1b"] },
			{ name: "root back", inputs: ["\x1b"] },
		],
		initial,
	);
	check(cancel.result.applied === false, "runtime cancel/back path does not apply");
	check(deepEqual(cancel.localAfter, initial), "runtime cancel leaves local config unchanged");
}

(async () => {
	await scenarioProfileCustomMarkerAndPreserveDefault();
	await scenarioProfileGonkaPreservesCustom();
	await scenarioModelChainBackSemanticsAndNoStandaloneThinkingRows();
	await scenarioModelChainForRole("coder");
	await scenarioModelChainForRole("reviewer");
	scenarioBrokenStandaloneThinkingFixtureRejected();
	await scenarioRuntimeSaveAndRuntimeOnlyBackPaths();

	if (failures > 0) {
		console.error(`\n${failures} task-008 behavior checks failed.`);
		process.exit(1);
	}
	console.log("\nTASK-008 behavior smoke checks passed.");
})();
