#!/usr/bin/env node
// TASK-028 Phase A smoke tests for `extensions/workflow/configure-helpers.ts` (pure helpers; no real `.pi/workflow.local.json` writes).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildWorkflowLocalPayload,
	buildWorkflowLocalPreviewText,
	collectWorkflowModelChoices,
	getSupportedWorkflowThinkingLevels,
	hydrateProfileConfigDraft,
	isGonkaAvailable,
	isWorkflowDraftEmpty,
	summarizeWorkflowDraft,
	type WorkflowConfigDraft,
	type WorkflowModelChoice,
	type WorkflowModelRegistryLike,
} from "../extensions/workflow/configure-helpers";
import { normalizeV1Config } from "../extensions/workflow/config";
import { makeDelegateGuardFailure, resolveDelegatePresetWithFallback } from "../extensions/workflow/delegate/model-guard";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}
function makeRegistry(entries: unknown[]): WorkflowModelRegistryLike {
	return { getAvailable: () => entries };
}
function throwingRegistry(message: string): WorkflowModelRegistryLike {
	return { getAvailable: () => { throw new Error(message); } };
}

check(collectWorkflowModelChoices(undefined).degraded === true, "model collection: undefined registry is degraded (no crash)");
check(collectWorkflowModelChoices(null).degraded === true, "model collection: null registry is degraded (no crash)");
check(collectWorkflowModelChoices(makeRegistry([])).degraded === true, "model collection: empty registry is degraded");
{
	const r = collectWorkflowModelChoices(throwingRegistry("boom"));
	check(r.degraded === true, "model collection: throwing registry degrades");
	check((r.warning ?? "").includes("boom"), "model collection: warning includes thrown message");
}
{
	const r = collectWorkflowModelChoices(makeRegistry([null, undefined, { id: "no-provider" }, { provider: "no-id" }, { provider: "", id: "" }, { provider: "  " }, { id: "   " }, 42, "not-an-object"]));
	check(r.degraded === true, "model collection: all-invalid registry is degraded");
	check(r.choices.length === 0, "model collection: all-invalid registry yields zero choices");
	check(typeof r.warning === "string" && r.warning.length > 0, "model collection: all-invalid warning is non-empty");
	check((r.warning ?? "").toLowerCase().includes("usable"), "model collection: all-invalid warning mentions 'usable'");
}
{
	const r = collectWorkflowModelChoices(makeRegistry([
		{ provider: "openai-codex", id: "gpt-5.5", reasoning: true, thinkingLevelMap: { off: "off", medium: "medium", xhigh: "xhigh", high: null, low: null, minimal: null } },
		{ provider: "openai-codex", id: "gpt-5.5" },
		{ provider: "openai-codex", id: "gpt-5.5-codex" },
		{ provider: "minimax", id: "MiniMax-M3", reasoning: false },
		{ provider: "", id: "no-provider" },
		{ provider: "no-id" },
		null,
		{ provider: "openai-codex", id: "gpt-5.5", name: "GPT 5.5" },
	]));
	check(!r.degraded, "model collection: healthy registry is not degraded");
	check(r.choices.length === 3, "model collection: dedupes by fullId, drops invalid entries");
	check(r.choices[0]?.fullId === "minimax/MiniMax-M3", "model collection: sorts by fullId (minimax first)");
	const choice = r.choices.find((c) => c.fullId === "openai-codex/gpt-5.5");
	check(Boolean(choice), "model collection: openai-codex/gpt-5.5 is present");
	check(choice?.reasoning === true, "model collection: reasoning is preserved");
	check(choice?.thinkingLevelMap !== undefined, "model collection: thinkingLevelMap is preserved");
}

check(!isGonkaAvailable([]), "Gonka availability: empty list => false");
check(!isGonkaAvailable([{ provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5" }, { provider: "minimax", id: "MiniMax-M3", fullId: "minimax/MiniMax-M3" }]), "Gonka availability: no gonka provider => false");
check(isGonkaAvailable([{ provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5" }, { provider: "gonka", id: "moonshotai/Kimi-K2.6", fullId: "gonka/moonshotai/Kimi-K2.6" }]), "Gonka availability: gonka provider present => true");
check(isGonkaAvailable([{ provider: "GONKA", id: "model", fullId: "GONKA/model" }]), "Gonka availability: case-insensitive match for GONKA");

check(JSON.stringify(getSupportedWorkflowThinkingLevels(undefined)) === JSON.stringify(["off","minimal","low","medium","high","xhigh"]), "thinking levels: undefined choice => all THINKING_LEVELS");
check(JSON.stringify(getSupportedWorkflowThinkingLevels({ provider:"x", id:"y", fullId:"x/y", reasoning:true })) === JSON.stringify(["off","minimal","low","medium","high","xhigh"]), "thinking levels: reasoning=true with no map => all THINKING_LEVELS");
check(JSON.stringify(getSupportedWorkflowThinkingLevels({ provider:"x", id:"y", fullId:"x/y", reasoning:false })) === JSON.stringify(["off"]), "thinking levels: reasoning=false => [off] only");
check(JSON.stringify(getSupportedWorkflowThinkingLevels({ provider:"x", id:"y", fullId:"x/y", reasoning:undefined })) === JSON.stringify(["off","minimal","low","medium","high","xhigh"]), "thinking levels: reasoning=undefined (unknown) => all THINKING_LEVELS");
{
	const choice: WorkflowModelChoice = { provider:"x", id:"y", fullId:"x/y", reasoning:true, thinkingLevelMap:{ off:"off", minimal:"minimal", low:"low", medium:"medium", high:"high", xhigh:null } };
	const levels = getSupportedWorkflowThinkingLevels(choice);
	check(!levels.includes("xhigh"), "thinking levels: null map entry excludes the level");
	check(levels.includes("off") && levels.includes("high"), "thinking levels: non-null map entries are included");
}
{
	const choice: WorkflowModelChoice = { provider:"x", id:"y", fullId:"x/y", reasoning:true, thinkingLevelMap:{ off:null, minimal:null, low:null, medium:null, high:null, xhigh:null } };
	const levels = getSupportedWorkflowThinkingLevels(choice);
	check(levels.length === 0, `thinking levels: all-null map => empty (no fallback), got ${levels.length}`);
}
{
	const choice: WorkflowModelChoice = { provider:"x", id:"y", fullId:"x/y", reasoning:true, thinkingLevelMap:{ high:"high" } };
	const levels = getSupportedWorkflowThinkingLevels(choice);
	check(levels.includes("off") && levels.includes("minimal") && levels.includes("low") && levels.includes("medium") && levels.includes("high") && !levels.includes("xhigh"), "thinking levels: partial map { high } includes off/minimal/low/medium/high, excludes xhigh");
}
{
	const choice: WorkflowModelChoice = { provider:"x", id:"y", fullId:"x/y", reasoning:true, thinkingLevelMap:{ xhigh:"max" } };
	const levels = getSupportedWorkflowThinkingLevels(choice);
	check(levels.includes("xhigh") && levels.includes("off"), "thinking levels: partial map { xhigh } includes xhigh and off");
}
{
	const choice: WorkflowModelChoice = { provider:"x", id:"y", fullId:"x/y", reasoning:true, thinkingLevelMap:{ high:null } };
	const levels = getSupportedWorkflowThinkingLevels(choice);
	check(!levels.includes("high") && levels.includes("off") && levels.includes("minimal") && levels.includes("low") && levels.includes("medium"), "thinking levels: partial map { high: null } excludes high, includes off/minimal/low/medium");
}

{
	const payload = buildWorkflowLocalPayload(null, { profile: "default", runtime: { delegateDisplay: "headless" }, customEdits: {} });
	check(payload.profile === "default" && payload.delegateDisplay === "headless" && payload.agents === undefined, "buildWorkflowLocalPayload: null existing => profile/runtime written, no agents");
}
{
	const payload = buildWorkflowLocalPayload(undefined, { profile: "gonka", runtime: {}, customEdits: { coder: { provider: "minimax", model: "MiniMax-M3" } } });
	check(payload.profile === "gonka-hybrid" && payload.agents?.coder?.provider === "minimax" && payload.agents?.brain === undefined, "buildWorkflowLocalPayload: gonka profile + coder edit => correct");
}

check(isWorkflowDraftEmpty({ profile:"default", runtime:{}, customEdits:{} }), "isWorkflowDraftEmpty: pure default => empty");
check(!isWorkflowDraftEmpty({ profile:"default", runtime:{ delegateDisplay:"pane" }, customEdits:{} }), "isWorkflowDraftEmpty: runtime change => not empty");
check(!isWorkflowDraftEmpty({ profile:"default", runtime:{}, customEdits:{ brain:{ provider:"x" } } }), "isWorkflowDraftEmpty: custom edit => not empty");

{
	const existing = { agents: { brain: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" }, coder: { provider: "minimax", model: "MiniMax-M3", thinkingLevel: "off" } }, unknown: { keep: "me" } };
	const draft: WorkflowConfigDraft = { profile: "default", runtime: {}, customEdits: {} };
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(payload.profile === "default" && JSON.stringify(payload.agents) === JSON.stringify(existing.agents) && (payload as { unknown?: { keep: string } }).unknown?.keep === "me", "default payload: profile/agents/unknown preserved");
}
{
	const existing = { agents: { brain: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" }, coder: { provider: "minimax", model: "MiniMax-M3", thinkingLevel: "off" }, reviewer: { provider: "anthropic", model: "claude-opus-4" } } };
	const draft: WorkflowConfigDraft = { profile: "gonka", runtime: {}, customEdits: {} };
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(payload.profile === "gonka-hybrid" && JSON.stringify(payload.agents?.brain) === JSON.stringify(existing.agents.brain) && JSON.stringify(payload.agents?.coder) === JSON.stringify(existing.agents.coder) && JSON.stringify(payload.agents?.reviewer) === JSON.stringify(existing.agents.reviewer), "gonka payload: all agents preserved");
}
{
	const existing = { agents: { coder: { provider: "minimax", model: "MiniMax-M3" } } };
	const draft: WorkflowConfigDraft = { profile: "gonka", runtime: {}, customEdits: {} };
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(payload.agents?.brain === undefined && payload.agents?.coder !== undefined, "gonka payload: brain absent, coder preserved");
}
{
	const existing = { agents: { brain: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" }, coder: { provider: "minimax", model: "MiniMax-M3", thinkingLevel: "off" } } };
	const draft: WorkflowConfigDraft = { profile: "custom", runtime: {}, customEdits: { brain: { model: "gpt-5.5-mini" } } };
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(payload.agents?.brain?.model === "gpt-5.5-mini" && payload.agents?.brain?.provider === "openai-codex" && payload.agents?.brain?.thinkingLevel === "xhigh" && JSON.stringify(payload.agents?.coder) === JSON.stringify(existing.agents.coder), "custom edit: brain merged, coder preserved");
}
{
	const existing = { agents: { brain: { provider: "openai-codex", model: "gpt-5.5" }, coder: { provider: "minimax", model: "MiniMax-M3" } } };
	const draft: WorkflowConfigDraft = { profile: "custom", runtime: {}, customEdits: { brain: { cleared: true } } };
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(payload.agents?.brain === undefined && JSON.stringify(payload.agents?.coder) === JSON.stringify(existing.agents.coder), "explicit clear: brain removed, coder preserved");
}
{
	const existing = { profile: "gonka-hybrid", agents: { brain: { provider: "x", model: "y" } } };
	const draft: WorkflowConfigDraft = { profile: "custom", runtime: {}, customEdits: { brain: { model: "z" } } };
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(payload.profile === undefined && payload.agents?.brain?.model === "z" && payload.agents?.brain?.provider === "x", "custom profile: stale gonka-hybrid cleared, brain merged");
}
{
	const existing = { profile: "default", agents: { brain: { provider: "x", model: "y" } } };
	const draft: WorkflowConfigDraft = { profile: "custom", runtime: {}, customEdits: { brain: { model: "z" } } };
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(payload.profile === undefined && payload.agents?.brain?.model === "z", "custom profile: stale default cleared, brain model applied");
}
{
	const existing = { unknown: "field" };
	const draft: WorkflowConfigDraft = { profile: "default", runtime: { delegateDisplay: "pane", delegatePaneAutoClose: false, reviewerSwarmEnabled: true, reviewerSwarmMaxConcurrency: 4, deepPlanningEnabled: true, deepPlanningPlannerCount: 5, deepPlanningRounds: 3, deepPlanningMaxConcurrency: 2 }, customEdits: {} };
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(payload.delegateDisplay === "pane" && payload.delegatePaneAutoClose === false && payload.reviewerSwarm?.enabled === true && payload.reviewerSwarm?.maxConcurrency === 4 && payload.deepPlanning?.enabled === true && payload.deepPlanning?.plannerCount === 5 && payload.deepPlanning?.rounds === 3 && payload.deepPlanning?.maxConcurrency === 2 && (payload as { unknown: string }).unknown === "field", "runtime payload: all runtime fields and unknown preserved");
}
{
	const existing = { agents: { brain: { provider: "x", model: "y" } } };
	const draft: WorkflowConfigDraft = { profile: "default", runtime: {}, customEdits: {} };
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(payload.profile === "default" && JSON.stringify(payload.agents) === JSON.stringify(existing.agents), "empty staged default: profile/agents preserved");
}
{
	const existing = { agents: { brain: { provider: "x", model: "y" } } };
	const draft: WorkflowConfigDraft = { profile: "custom", runtime: {}, customEdits: { brain: { cleared: true } } };
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(payload.agents === undefined, "cleared-only draft: agents omitted");
}

{
	const existing = { agents: { brain: { provider: "openai-codex", model: "gpt-5.5" }, coder: { provider: "minimax", model: "MiniMax-M3" } } };
	const summary = summarizeWorkflowDraft(existing, { profile: "default", runtime: {}, customEdits: {} });
	check(summary.profile === "default" && summary.preservedRoles.length === 2 && summary.clearedRoles.length === 0 && summary.editedRoles.length === 0, "summary: default draft, two preserved roles");
}
{
	const existing = { agents: { brain: { provider: "x", model: "y" } } };
	const summary = summarizeWorkflowDraft(existing, { profile: "gonka", runtime: { reviewerSwarmEnabled: false }, customEdits: { brain: { cleared: true } } });
	check(summary.clearedRoles.includes("brain") && summary.runtimeChanges.includes("reviewerSwarm.enabled=false"), "summary: brain cleared + runtime change listed");
}

{
	const existing = { agents: { brain: { provider: "openai-codex", model: "gpt-5.5" }, coder: { provider: "minimax", model: "MiniMax-M3" } } };
	const text = buildWorkflowLocalPreviewText(existing, { profile: "default", runtime: { delegateDisplay: "pane" }, customEdits: {} });
	check(text.includes("Profile: Default") && text.includes("delegateDisplay=pane") && text.includes("Preserved custom role overrides: brain, coder") && text.includes("These take precedence") && text.includes("--- .pi/workflow.local.json preview ---"), "preview text: header/runtime/preserved/JSON section present");
	const jsonStart = text.indexOf("--- .pi/workflow.local.json preview ---");
	const jsonLines = text.slice(jsonStart).split("\n");
	const bodyStart = jsonLines.findIndex((line) => line.trimStart().startsWith("{"));
	const jsonBody = jsonLines.slice(bodyStart).join("\n");
	const parsed = JSON.parse(jsonBody);
	check(parsed.profile === "default" && JSON.stringify(parsed.agents) === JSON.stringify(existing.agents), "preview text: JSON body profile/agents correct");
}
{
	const text = buildWorkflowLocalPreviewText({}, { profile: "default", runtime: {}, customEdits: {} }, { extraWarnings: ["model registry unavailable"] });
	check(text.includes("Warning: model registry unavailable"), "preview text: extraWarnings surfaced");
}

{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-028-workflow-cfg-smoke-"));
	try {
		const projectDir = path.join(tmpDir, "project");
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
		const realLocal = path.join(process.cwd(), ".pi", "workflow.local.json");
		const beforeRealExists = fs.existsSync(realLocal);
		const beforeReal = beforeRealExists ? fs.readFileSync(realLocal, "utf8") : undefined;
		const draft: WorkflowConfigDraft = { profile: "default", runtime: { deepPlanningEnabled: true }, customEdits: {} };
		const payload = buildWorkflowLocalPayload({ agents: { brain: { provider: "x", model: "y" } } }, draft);
		const target = path.join(projectDir, ".pi", "workflow.local.json");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify(payload, null, 2), "utf8");
		check(fs.existsSync(target), "end-to-end: payload written to temp project .pi/workflow.local.json");
		if (beforeRealExists && beforeReal !== undefined) {
			const afterReal = fs.readFileSync(realLocal, "utf8");
			check(afterReal === beforeReal, "end-to-end: real project .pi/workflow.local.json untouched");
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}
{
	const task026Path = path.join(process.cwd(), "scripts", "task-026-workflow-smokes.ts");
	check(fs.existsSync(task026Path), "compat: task-026 smoke file still present");
}

{
	const existing = {
		profile: "default",
		unknown: { keep: "me" },
		reviewerSwarm: { enabled: false, maxConcurrency: 1, targets: ["docs"] },
		deepPlanning: { enabled: false, plannerCount: 1, rounds: 1, maxConcurrency: 1 },
		agents: { brain: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" } },
	};
	const before = JSON.stringify(existing);
	const draft: WorkflowConfigDraft = {
		profile: "custom",
		runtime: { reviewerSwarmEnabled: true, reviewerSwarmMaxConcurrency: 3, deepPlanningEnabled: true, deepPlanningRounds: 2 },
		customEdits: { brain: { model: "z" } },
	};
	const payload = buildWorkflowLocalPayload(existing, draft);
	check(JSON.stringify(existing) === before, "immutability: caller-provided existingLocal is byte-identical after buildWorkflowLocalPayload");
	check((existing.reviewerSwarm as { enabled: boolean }).enabled === false && (existing.reviewerSwarm as { maxConcurrency: number }).maxConcurrency === 1 && (existing.deepPlanning as { rounds: number }).rounds === 1 && (existing.agents.brain as { model: string }).model === "gpt-5.5" && (existing.agents.brain as { provider: string }).provider === "openai-codex", "immutability: existing fields untouched");
	check(payload.reviewerSwarm?.enabled === true && payload.reviewerSwarm?.maxConcurrency === 3 && payload.deepPlanning?.enabled === true && payload.deepPlanning?.rounds === 2 && payload.agents?.brain?.model === "z" && payload.agents?.brain?.provider === "openai-codex", "immutability: payload carries staged values");
}

{
	const payload = buildWorkflowLocalPayload({}, { profile: "default", runtime: {}, customEdits: {} });
	check(payload.delegateFallbacks === undefined, "fallback payload: none written by default");
}
{
	const existing = { delegateFallbacks: { coder: { provider: "x", model: "a" } } };
	const payload = buildWorkflowLocalPayload(existing, { profile: "default", runtime: {}, customEdits: {} });
	check(payload.delegateFallbacks?.coder?.model === "a", "fallback payload: existing coder fallback preserved when untouched");
}
{
	const payload = buildWorkflowLocalPayload({}, { profile: "default", runtime: {}, customEdits: {}, fallbackEdits: { coder: { provider: "gonka", model: "m", thinkingLevel: "off" } } });
	check(payload.delegateFallbacks?.coder?.provider === "gonka" && payload.delegateFallbacks?.coder?.model === "m" && payload.delegateFallbacks?.coder?.thinkingLevel === "off", "fallback payload: coder fallback written");
}
{
	const existing = { delegateFallbacks: { coder: { provider: "x", model: "a" }, reviewer: { provider: "y", model: "b" } } };
	const payload = buildWorkflowLocalPayload(existing, { profile: "default", runtime: {}, customEdits: {}, fallbackEdits: { coder: { cleared: true } } });
	check(payload.delegateFallbacks?.coder === undefined && payload.delegateFallbacks?.reviewer?.model === "b", "fallback payload: cleared coder fallback removed, reviewer preserved");
}
{
	const existing = { delegateFallbacks: { coder: { provider: "x", model: "a" }, reviewer: { provider: "y", model: "b" } } };
	const draft = { profile: "default" as const, runtime: {}, customEdits: {}, fallbackEdits: { coder: { cleared: true } } };
	const summary = summarizeWorkflowDraft(existing, draft);
	check(summary.fallbackClearedRoles.includes("coder") && !summary.fallbackEditedRoles.includes("reviewer"), "summary: cleared coder fallback listed, reviewer untouched");
	const text = buildWorkflowLocalPreviewText(existing, draft);
	check(text.includes("Cleared delegate fallbacks: coder"), "preview text: cleared fallback mentioned");
}
{
	const draft = { profile: "default" as const, runtime: {}, customEdits: {}, fallbackEdits: { reviewer: { provider: "z", model: "m" } } };
	const summary = summarizeWorkflowDraft({}, draft);
	check(summary.fallbackEditedRoles.includes("reviewer"), "summary: edited reviewer fallback listed");
	const text = buildWorkflowLocalPreviewText({}, draft);
	check(text.includes("Edited delegate fallbacks: reviewer"), "preview text: edited fallback mentioned");
}
{
	const ctx = { modelRegistry: { find: (p: string, m: string) => p === "gonka" && m === "m" ? { provider: p, id: m } : undefined } } as any;
	const cfg = { agents: { coder: { provider: "openai-codex", model: "missing", thinkingLevel: "medium", tools: ["read"], instructions: "keep" } }, delegateFallbacks: { coder: { provider: "gonka", model: "m", thinkingLevel: "off" } } };
	const r = resolveDelegatePresetWithFallback(ctx, cfg, "coder");
	check(r.ok && r.usedFallback === true, "guard: unavailable coder primary uses available fallback");
	if (r.ok) {
		check(r.preset.provider === "gonka" && r.preset.model === "m" && r.preset.thinkingLevel === "off" && r.preset.tools?.includes("read") === true && r.preset.instructions === "keep", "guard: fallback merged with primary tools/instructions");
	}
}
{
	const ctx = { modelRegistry: { find: () => undefined } } as any;
	const r = resolveDelegatePresetWithFallback(ctx, { agents: { reviewer: { provider: "openai-codex", model: "missing" } } }, "reviewer");
	check(!r.ok && r.message.includes("/workflow_cfg") && r.message.includes("No fallback"), "guard: unavailable reviewer primary without fallback fails, message mentions /workflow_cfg and no fallback");
}
{
	const ctx = { modelRegistry: { find: () => { throw new Error("boom"); } } } as any;
	const r = resolveDelegatePresetWithFallback(ctx, { agents: { coder: { provider: "openai-codex", model: "m" } } }, "coder");
	check(!r.ok && r.message.includes("boom"), "guard: registry throw fails safely and message preserved");
}
{
	const ctx = {} as any;
	const r = resolveDelegatePresetWithFallback(ctx, { agents: { coder: { instructions: "default-model" } } }, "coder");
	check(r.ok && r.usedFallback === false, "guard: preset without explicit provider/model is allowed");
}
{
	const f = makeDelegateGuardFailure("coder", "task", "/tmp/work", "warning text");
	check(f.status === "failed" && f.exitCode === 1 && f.finalOutput === "warning text" && f.errorMessage === "warning text", "guard failure result: failed exit status with warning text surfaced");
}
function readSource(rel: string): string {
	return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}
{
	const brain = readSource("extensions/brain-workflow.ts");
	check(brain.includes('registerCommand("workflow_cfg"') && brain.includes("/workflow_cfg"), "phaseB source: /workflow_cfg command registered and usage mentions it");
	const configure = readSource("extensions/workflow/configure.ts");
	check(configure.includes("showWorkflowConfigureOverlay") && configure.includes("./configure-overlay"), "phaseB source: /workflow configure routes to overlay");
	const overlay = readSource("extensions/workflow/configure-overlay.ts");
	check(overlay.includes('overlayOptions: { anchor: "center"') && overlay.includes("maxHeight"), "phaseB source: overlay uses centered overlay options");
	check(overlay.includes("collectWorkflowModelChoices") && overlay.includes("showModelPickerOverlay") && overlay.includes("loadWorkflowConfig") && overlay.includes("runProfileOverlay") && overlay.includes("runRuntimeOverlay"), "phaseB source: overlay composes helper/model/profile/runtime blocks");
	check(!overlay.includes("cleared: false"), "phaseB source: role edits do not assign cleared:false");
	const preview = readSource("extensions/workflow/configure-overlay-preview.ts");
	check(preview.includes("buildWorkflowLocalPreviewText") && preview.includes("buildWorkflowLocalPayload") && preview.includes("writeWorkflowLocalOverride") && preview.includes("./configure-io") && !preview.includes('from "./configure"'), "phaseB source: preview/apply uses Phase A helpers and configure-io");
	const thinking = readSource("extensions/workflow/configure-overlay-thinking.ts");
	check(thinking.includes("getSupportedWorkflowThinkingLevels") && !thinking.includes("for (const level of THINKING_LEVELS)"), "phaseB source: thinking picker constrained by helper");
	const picker = readSource("extensions/workflow/configure-model-picker.ts");
	check(picker.includes("Input") && picker.includes("getValue()") && !picker.includes("getText()") && picker.includes("truncateToWidth") && picker.includes("visibleWidth"), "phaseB source: model picker is searchable and width-safe");
	check(picker.includes("matchesKey") && picker.includes("Key.up") && picker.includes("Key.down") && picker.includes("Key.enter") && picker.includes("Key.escape") && picker.includes('Key.ctrl("c")'), "phaseB source: model picker uses Pi TUI key matching for navigation/confirm/cancel");
	const runtime = readSource("extensions/workflow/configure-overlay-runtime.ts");
	check(runtime.includes("__save") && runtime.includes("__discard"), "phaseB source: runtime overlay has explicit save/discard actions");
	for (const id of ["delegateDisplay", "delegatePaneAutoClose", "reviewerSwarm.enabled", "reviewerSwarm.maxConcurrency", "deepPlanning.enabled", "deepPlanning.plannerCount", "deepPlanning.rounds", "deepPlanning.maxConcurrency"]) {
		check(runtime.includes(id), `phaseB source: runtime setting exposed: ${id}`);
	}
	const readme = readSource("README.md");
	check(readme.includes("/workflow_cfg") && readme.includes("limited mode"), "phaseB docs: README documents /workflow_cfg and degraded limited mode");
}

{
	const guard = readSource("extensions/workflow/delegate/model-guard.ts");
	check(guard.includes("resolveDelegatePresetWithFallback") && guard.includes("delegateFallbacks") && guard.includes("makeDelegateGuardFailure") && guard.includes("modelRegistry"), "slice3 source: model-guard exports and references correct");
	const runner = readSource("extensions/workflow/delegate/runner.ts");
	check(runner.includes("presetOverride") && runner.includes("resolveDelegatePresetWithFallback") && runner.includes("makeDelegateGuardFailure"), "slice3 source: runner.ts imports guard");
	const headless = readSource("extensions/workflow/delegate/headless.ts");
	check(headless.includes("presetOverride"), "slice3 source: headless.ts accepts presetOverride");
	const pane = readSource("extensions/workflow/delegate/pane.ts");
	check(pane.includes("presetOverride"), "slice3 source: pane.ts accepts presetOverride");
	const swarm = readSource("extensions/workflow/delegate/swarm.ts");
	check(swarm.includes("presetOverride") && swarm.includes("runDelegateAgent"), "slice3 source: swarm.ts passes presetOverride to runDelegateAgent");
	const tools = readSource("extensions/workflow/delegate/tools.ts");
	check(tools.includes("resolveDelegatePresetWithFallback") && tools.includes("makeDelegateGuardFailure") && tools.includes("guard.preset"), "slice3 source: tools.ts imports guard and passes guard.preset");
}

{
	const startSession = readSource("extensions/sprint/start-session.ts");
	check(startSession.includes("export async function startSprintTaskSession") && startSession.includes("newSession") && startSession.includes("sendUserMessage") && startSession.includes("buildTaskSessionKickoff") && startSession.includes("SPRINT_BINDING_CUSTOM_TYPE"), "slice4 source: start-session helper starts sessions and sends kickoff");
	const command = readSource("extensions/sprint/command.ts");
	check(command.includes('import { startSprintTaskSession } from "./start-session"') && command.includes("startSprintTaskSession(ctx, taskId") && command.includes("--auto-run"), "slice4 source: command.ts uses start-session helper and keeps --auto-run");
	const sprintTools = readSource("extensions/sprint/tools.ts");
	check(sprintTools.includes('import { startSprintTaskSession } from "./start-session"') && sprintTools.includes("startSprintTaskSession(ctx, taskId") && sprintTools.includes("Automatic session start unavailable") && sprintTools.includes("setEditorText"), "slice4 source: tools.ts auto-starts with editor fallback");
}

{
	const normalized = normalizeV1Config({ delegateFallbacks: { coder: { provider: "gonka", model: "m", thinkingLevel: "off" }, reviewer: { provider: "openai-codex", model: "gpt-5.5" }, brain: { provider: "x", model: "ignored" } } });
	check(normalized?.delegateFallbacks?.coder?.provider === "gonka" && normalized?.delegateFallbacks?.coder?.thinkingLevel === "off", "normalizeV1Config: coder delegate fallback preserved");
	check(normalized?.delegateFallbacks?.reviewer?.model === "gpt-5.5" && (normalized?.delegateFallbacks as any)?.brain === undefined, "normalizeV1Config: reviewer fallback preserved and non-delegate ignored");
}
{
	const runtime = readSource("extensions/workflow/runtime/config.ts");
	check(runtime.includes("normalized.delegateFallbacks"), "slice6 source: runtime/config.ts copies delegateFallbacks from normalized");
}
{
	const readme = readSource("README.md");
	check(readme.includes("delegateFallbacks") && readme.includes("/workflow_cfg") && (readme.includes("exits with warning") || readme.includes("no child")), "slice5 docs: README documents delegate fallbacks and guard exit");
	const prompts = readSource("extensions/workflow/prompts.ts");
	check(!prompts.includes("tool itself does NOT switch sessions") && (prompts.includes("auto-starts") || prompts.includes("automatic session")), "slice5 prompts: auto-start wording present and stale wording removed");
}

{
	// DBG-003 per-block apply schema checks
	const overlay = readSource("extensions/workflow/configure-overlay.ts");
	const profileOverlay = readSource("extensions/workflow/configure-overlay-profile.ts");

	// Root menu: Profile, Profile config, Runtime settings, Back/Close
	check(overlay.includes('value: "profile"') && overlay.includes('label: "Profile"'), "dbg003: root has Profile");
	check(overlay.includes('value: "profile-config"') && overlay.includes('label: "Profile config"'), "dbg003: root has Profile config");
	check(overlay.includes('value: "runtime"') && overlay.includes('label: "Runtime settings"'), "dbg003: root has Runtime settings");
	check(overlay.includes('value: "back"') && overlay.includes('label: "Back/Close"'), "dbg003: root has Back/Close");
	// Root must not have global preview/fallbacks
	check(!overlay.includes('id: "preview"'), "dbg003: root has no global preview");
	check(!overlay.includes('id: "cancel"'), "dbg003: root has no cancel");
	const rootEnd = overlay.indexOf("function runProfileConfigOverlay");
	const rootSection = rootEnd > 0 ? overlay.slice(0, rootEnd) : overlay;
	check(!rootSection.includes('id: "fallback:'), "dbg003: root does not expose fallback: leaf rows");
	check(!rootSection.includes('id: "fallback-clear:'), "dbg003: root does not expose fallback-clear: leaf rows");

	// Profile config menu: Default, Gonka (env-gated), Custom, Delegate fallback models, Apply, Back
	check(overlay.includes("function runProfileConfigOverlay"), "dbg003: profile config overlay exists");
	check(overlay.includes('value: "default"') && overlay.includes("read-only"), "dbg003: profile config has Default read-only");
	check(overlay.includes('value: "gonka"') && overlay.includes("read-only"), "dbg003: profile config has Gonka read-only");
	check(overlay.includes('value: "custom"') && overlay.includes("Edit custom"), "dbg003: profile config has Custom editable");
	check(overlay.includes('value: "fallbacks"') && overlay.includes("Delegate fallback"), "dbg003: profile config has Delegate fallback models");
	check(overlay.includes('value: "apply"') && overlay.includes("Profile config"), "dbg003: profile config has Apply");
	check(overlay.includes('value: "back"') && overlay.includes("function runProfileConfigOverlay"), "dbg003: profile config has Back");

	// Fallback submenu is nested under profile config, has Back only
	check(overlay.includes("function runFallbackSubmenu"), "dbg003: fallback submenu exists");
	check(overlay.includes('value: `fallback:${role}`'), "dbg003: fallback submenu has fallback: rows");
	check(overlay.includes('value: `fallback-clear:${role}`'), "dbg003: fallback submenu has fallback-clear: rows");
	check(overlay.includes('value: "back"') && overlay.includes("function runFallbackSubmenu"), "dbg003: fallback submenu has Back");

	// Custom fields overlay under profile config
	check(overlay.includes("function runCustomFieldsOverlay"), "dbg003: custom fields overlay exists");
	check(overlay.includes('value: `model:${role}`'), "dbg003: custom fields has model: rows");
	// DBG-006: standalone thinking rows are removed (model row chains
	// into the thinking picker for every role). The model row's
	// description still surfaces the staged/effective thinking level.
	check(!overlay.includes('value: `thinking:${role}`'), "dbg006: custom fields no longer emits standalone thinking: rows");
	check(overlay.includes('value: `clear:${role}`'), "dbg003: custom fields has clear: rows");

	// Profile selection overlay: checked in-place, Apply/Back, env-gated Gonka
	check(profileOverlay.includes("gonkaEnvConfigured"), "dbg003: profile overlay uses env-gated Gonka");
	check(profileOverlay.includes('"✓ "') || profileOverlay.includes("'✓ '"), "dbg003: profile overlay has check marker");
	check(profileOverlay.includes('value: "apply"'), "dbg003: profile overlay has Apply");
	check(profileOverlay.includes('value: "back"'), "dbg003: profile overlay has Back");
	check(profileOverlay.includes("GONKA_BROKER_API_KEY"), "dbg003: profile overlay mentions env key gate");
	check(!profileOverlay.includes("gonkaAvailable"), "dbg003: profile overlay does not use model-registry gonkaAvailable");

	// Runtime writes immediately
	check(overlay.includes("function runRuntimeBlock"), "dbg003: runtime block exists");
	const runtimeOverlay = readSource("extensions/workflow/configure-overlay-runtime.ts");
	check(runtimeOverlay.includes("Save runtime edits") && runtimeOverlay.includes("write to .pi/workflow.local.json"), "dbg003: runtime overlay mentions immediate write");

	// Read-only built-in field views use DEFAULT_CONFIG and GONKA_HYBRID_PROFILE_APPLY
	check(overlay.includes("DEFAULT_CONFIG.agents"), "dbg003: read-only fields use DEFAULT_CONFIG");
	check(overlay.includes("GONKA_HYBRID_PROFILE_APPLY"), "dbg003: read-only fields use GONKA_HYBRID_PROFILE_APPLY");
}

{
	// DBG-004 Profile config hydration helper (pure)
	const loadedAgents = {
		brain: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" },
		coder: { provider: "openai-codex", model: "gpt-5.3-codex", thinkingLevel: "medium" },
		reviewer: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "high" },
	};
	const loadedFallbacks = undefined;
	// Case 1: no local override => use loaded profile id
	{
		const d = hydrateProfileConfigDraft(loadedAgents, loadedFallbacks, undefined, undefined, "default");
		check(d.profile === "default" && Object.keys(d.customEdits).length === 0, "dbg004: no local override => profile=default, empty customEdits");
	}
	{
		const d = hydrateProfileConfigDraft(loadedAgents, loadedFallbacks, undefined, undefined, "gonka");
		check(d.profile === "gonka" && Object.keys(d.customEdits).length === 0, "dbg004: no local override => profile=gonka, empty customEdits");
	}
	// Case 2: local agent override => profile flips to custom and edits are seeded
	{
		const localAgents = { coder: { provider: "minimax", model: "MiniMax-M3", thinkingLevel: "off" } };
		const d = hydrateProfileConfigDraft(loadedAgents, loadedFallbacks, localAgents, undefined, "default");
		check(d.profile === "custom", "dbg004: local agents => profile=custom");
		check(d.customEdits.coder?.provider === "minimax" && d.customEdits.coder?.model === "MiniMax-M3" && d.customEdits.coder?.thinkingLevel === "off", "dbg004: local agents => coder edit seeded from local");
		check(d.customEdits.brain === undefined, "dbg004: local agents => roles not in local override are not seeded");
	}
	// Case 3: local override is loaded profile id (e.g. default) but has agents => still custom
	{
		const localAgents = { brain: { provider: "x", model: "y" } };
		const d = hydrateProfileConfigDraft(loadedAgents, loadedFallbacks, localAgents, undefined, "default");
		check(d.profile === "custom" && d.customEdits.brain?.model === "y", "dbg004: local agents even when loaded id is default => custom");
	}
	// Case 4: local fallbacks are seeded when present
	{
		const localFallbacks = { reviewer: { provider: "gonka", model: "m", thinkingLevel: "off" } };
		const d = hydrateProfileConfigDraft(loadedAgents, loadedFallbacks, undefined, localFallbacks, "default");
		check(d.fallbackEdits?.reviewer?.provider === "gonka" && d.fallbackEdits?.reviewer?.thinkingLevel === "off", "dbg004: local fallbacks => reviewer edit seeded");
		check(d.fallbackEdits?.coder === undefined, "dbg004: local fallbacks => unfilled roles not seeded");
	}
	// Case 5: empty local override objects are not treated as having overrides
	{
		const d = hydrateProfileConfigDraft(loadedAgents, loadedFallbacks, {}, {}, "default");
		check(d.profile === "default" && Object.keys(d.customEdits).length === 0 && Object.keys(d.fallbackEdits ?? {}).length === 0, "dbg004: empty local objects => profile=default");
	}
	// Case 6: thinkingLevel that is not a valid ThinkingLevel is dropped
	{
		const localAgents = { coder: { provider: "minimax", model: "m", thinkingLevel: "bogus" } };
		const d = hydrateProfileConfigDraft(loadedAgents, loadedFallbacks, localAgents, undefined, "default");
		check(d.customEdits.coder?.thinkingLevel === undefined, "dbg004: invalid thinkingLevel is dropped from seeded edit");
	}
	// Case 7: preset with only provider is seeded (matches buildWorkflowLocalPayload tolerance)
	{
		const localAgents = { coder: { provider: "minimax", instructions: "x" } };
		const d = hydrateProfileConfigDraft(loadedAgents, loadedFallbacks, localAgents, undefined, "default");
		check(d.customEdits.coder?.provider === "minimax", "dbg004: preset with provider-only is seeded to match payload builder tolerance");
	}
}

{
	// DBG-004 source checks: submenu loops, read-only Esc UX, no useless Enter
	const overlay = readSource("extensions/workflow/configure-overlay.ts");

	// Import Key and matchesKey from pi-tui
	check(overlay.includes('Key,') && overlay.includes("matchesKey") && overlay.includes('from "@earendil-works/pi-tui"'), "dbg004: overlay imports Key and matchesKey from pi-tui");

	// Read-only overlay uses matchesKey(Key.escape) and does not advertise Enter
	const roStart = overlay.indexOf("function runReadonlyFieldsOverlay");
	const roEnd = overlay.indexOf("\n}\n", roStart);
	const roSection = roStart > 0 && roEnd > 0 ? overlay.slice(roStart, roEnd) : "";
	check(roSection.includes("matchesKey") && roSection.includes("Key.escape"), "dbg004: read-only overlay uses matchesKey + Key.escape");
	check(!roSection.includes('input === "\\r"') && !roSection.includes('input === "\\n"'), "dbg004: read-only overlay no longer checks raw enter string");
	check(!roSection.includes("Press enter or esc"), "dbg004: read-only overlay no longer advertises enter as a dismiss action");
	check(roSection.includes("esc to return"), "dbg004: read-only overlay footer mentions esc only");

	// Custom fields overlay has internal loop
	const customStart = overlay.indexOf("function runCustomFieldsOverlay");
	const customEnd = overlay.indexOf("\n}\n", customStart);
	const customSection = customStart > 0 && customEnd > 0 ? overlay.slice(customStart, customEnd) : "";
	check(/while\s*\(\s*true\s*\)/.test(customSection), "dbg004: runCustomFieldsOverlay has an internal while(true) loop");
	// DBG-006: every role routes through the model->thinking chain helper,
	// so the section references the chain helper and the clear helper only.
	check(customSection.includes("applyRoleModelAndThinkingPick") && customSection.includes("applyClearRole"), "dbg004: runCustomFieldsOverlay still routes model/clear");
	// The loop must re-show the submenu by calling ctx.ui.custom again inside the loop body
	const innerCustomCalls = (customSection.match(/ctx\.ui\.custom/g) ?? []).length;
	check(innerCustomCalls >= 1, "dbg004: runCustomFieldsOverlay shows the submenu via ctx.ui.custom inside the loop");

	// Fallback submenu has internal loop
	const fbStart = overlay.indexOf("function runFallbackSubmenu");
	const fbEnd = overlay.indexOf("\n}\n", fbStart);
	const fbSection = fbStart > 0 && fbEnd > 0 ? overlay.slice(fbStart, fbEnd) : "";
	check(/while\s*\(\s*true\s*\)/.test(fbSection), "dbg004: runFallbackSubmenu has an internal while(true) loop");
	// DBG-005: the pick route was upgraded to the chain helper. The clear
	// route is preserved. Accept either helper name for the pick route so
	// the DBG-004 invariant ("fallback submenu still routes to a pick
	// helper and the clear helper") stays valid across the refactor.
	check(
		(fbSection.includes("applyFallbackPick") || fbSection.includes("applyFallbackModelAndThinkingPick")) && fbSection.includes("applyClearFallback"),
		"dbg004: runFallbackSubmenu still routes pick/clear",
	);

	// runProfileConfigBlock uses the hydration helper and reads local override
	const blkStart = overlay.indexOf("function runProfileConfigBlock");
	const blkEnd = overlay.indexOf("\n}\n", blkStart);
	const blkSection = blkStart > 0 && blkEnd > 0 ? overlay.slice(blkStart, blkEnd) : "";
	check(blkSection.includes("hydrateProfileConfigDraft"), "dbg004: runProfileConfigBlock uses hydrateProfileConfigDraft");
	check(blkSection.includes("getLatestExistingLocal") && blkSection.includes("localAgents") && blkSection.includes("localFallbacks"), "dbg004: runProfileConfigBlock reads the latest local override for agents/fallbacks");
	check(blkSection.includes("loaded.config.agents") && blkSection.includes("runCustomFieldsOverlay"), "dbg004: runProfileConfigBlock passes effective agents into runCustomFieldsOverlay");

	// Custom display helpers seed from effective values when no staged edit
	const helpersSection = overlay;
	// DBG-006: brain no longer has a standalone thinking row, so the
	// thinking-only display helper is gone. Only the model-row helper
	// remains and it surfaces the staged/effective thinking level in
	// the description (via formatRoleEditDisplay).
	check(helpersSection.includes("customRoleModelDisplay"), "dbg004: customRoleModelDisplay still seeds from effective agents");
	check(!helpersSection.includes("customRoleThinkingDisplay"), "dbg006: standalone brain thinking display helper is removed");
}

{
	// DBG-005 chain: model -> thinking for coder/reviewer and fallback
	const overlay = readSource("extensions/workflow/configure-overlay.ts");

	// Chain helpers exist and use the same pickers as the standalone flow
	check(overlay.includes("async function applyRoleModelAndThinkingPick"), "dbg005: applyRoleModelAndThinkingPick helper exists");
	check(overlay.includes("async function applyFallbackModelAndThinkingPick"), "dbg005: applyFallbackModelAndThinkingPick helper exists");

	// The chain helpers must call BOTH the model picker and the thinking
	// picker. Slice each helper's source to keep this local.
	{
		const start = overlay.indexOf("async function applyRoleModelAndThinkingPick");
		const end = overlay.indexOf("\nasync function applyFallbackModelAndThinkingPick", start);
		const sec = start > 0 && end > 0 ? overlay.slice(start, end) : "";
		check(/showModelPickerOverlay/.test(sec), "dbg005: role chain calls showModelPickerOverlay");
		check(/showThinkingPickerOverlay/.test(sec), "dbg005: role chain calls showThinkingPickerOverlay");
		check(/while\s*\(\s*true\s*\)/.test(sec), "dbg005: role chain loops so Esc on thinking returns to model picker");
	}
	{
		const start = overlay.indexOf("async function applyFallbackModelAndThinkingPick");
		// DBG-006: applyModelPick is gone; the next top-level helper is
		// applyClearRole. Use that as the slice boundary.
		const end = overlay.indexOf("\nfunction applyClearRole", start);
		const sec = start > 0 && end > 0 ? overlay.slice(start, end) : "";
		check(/showModelPickerOverlay/.test(sec), "dbg005: fallback chain calls showModelPickerOverlay");
		check(/showThinkingPickerOverlay/.test(sec), "dbg005: fallback chain calls showThinkingPickerOverlay");
		check(/while\s*\(\s*true\s*\)/.test(sec), "dbg005: fallback chain loops so Esc on thinking returns to model picker");
	}

	// runCustomFieldsOverlay routes every role to the chain helper
	{
		const start = overlay.indexOf("function runCustomFieldsOverlay");
		const end = overlay.indexOf("\n}\n", start);
		const sec = start > 0 && end > 0 ? overlay.slice(start, end) : "";
		check(sec.includes("applyRoleModelAndThinkingPick"), "dbg006: runCustomFieldsOverlay routes to role chain helper");
		// DBG-006: every role uses the chain; the standalone model and
		// thinking pickers are gone from the custom fields overlay.
		check(!sec.includes("applyModelPick"), "dbg006: runCustomFieldsOverlay no longer calls standalone applyModelPick");
		check(!sec.includes("applyThinkingPick"), "dbg006: runCustomFieldsOverlay no longer calls standalone applyThinkingPick");
		// The action handler must not emit or accept a standalone
		// `${role} thinking` row. The thinking row literal must be
		// absent and the `thinking:` action branch must be gone.
		check(!/thinking:\${role}/.test(sec), "dbg006: no standalone `${role} thinking` row is emitted");
		check(!sec.includes('startsWith("thinking:")'), "dbg006: no standalone `thinking:` action branch in handler");
		// The model row is emitted for every role and routed through the
		// chain helper unconditionally.
		check(/value:\s*`model:\${role}`/.test(sec), "dbg006: model row emitted for every role");
		check(/working\s*=\s*await\s+applyRoleModelAndThinkingPick\(\s*ctx,\s*working,\s*role,\s*choices\s*\)/.test(sec), "dbg006: all roles route through applyRoleModelAndThinkingPick");
		// The clear route is preserved.
		check(/working\s*=\s*applyClearRole\(\s*working,\s*role\s*\)/.test(sec), "dbg006: clear route for every role preserved");
	}

	// runFallbackSubmenu routes both fallback roles to the chain helper
	{
		const start = overlay.indexOf("function runFallbackSubmenu");
		const end = overlay.indexOf("\n}\n", start);
		const sec = start > 0 && end > 0 ? overlay.slice(start, end) : "";
		check(sec.includes("applyFallbackModelAndThinkingPick"), "dbg005: runFallbackSubmenu routes to fallback chain helper");
		check(!sec.includes("working = await applyFallbackPick("), "dbg005: runFallbackSubmenu no longer uses standalone applyFallbackPick");
	}

	// Coder and reviewer display helper stays useful (model row description
	// shows both model and thinking via formatRoleEditDisplay when a
	// staged edit exists).
	{
		check(overlay.includes("formatRoleEditDisplay") && overlay.includes("customRoleModelDisplay"), "dbg005: customRoleModelDisplay still routes to formatRoleEditDisplay for staged edits");
	}
}

{
	// DBG-006 profile current-selection derivation
	const overlay = readSource("extensions/workflow/configure-overlay.ts");

	// Helper exists and reads the latest local config to detect a
	// non-empty `agents` override; falls back to profileFromLoaded
	// otherwise.
	check(overlay.includes("function currentProfileForProfileBlock"), "dbg006: currentProfileForProfileBlock helper exists");
	{
		const start = overlay.indexOf("function currentProfileForProfileBlock");
		const end = overlay.indexOf("\n}\n", start);
		const sec = start > 0 && end > 0 ? overlay.slice(start, end) : "";
		check(sec.includes("getLatestExistingLocal"), "dbg006: currentProfileForProfileBlock reads the latest local config");
		check(/agents/.test(sec) && /Object\.keys/.test(sec), "dbg006: currentProfileForProfileBlock inspects a non-empty agents object");
		check(sec.includes('"custom"'), "dbg006: currentProfileForProfileBlock returns 'custom' when local agents are present");
		check(sec.includes("profileFromLoaded"), "dbg006: currentProfileForProfileBlock falls back to profileFromLoaded");
	}

	// The Profile block call site uses the helper, not the bare
	// profileFromLoaded, so the in-place check marker reflects the
	// latest local override.
	{
		const idx = overlay.indexOf("await runProfileBlock(");
		const end = overlay.indexOf(")", idx);
		const callExpr = idx > 0 && end > 0 ? overlay.slice(idx, end + 1) : "";
		check(callExpr.includes("currentProfileForProfileBlock"), "dbg006: runProfileBlock is invoked with currentProfileForProfileBlock");
	}

	// Profile config block and Runtime block still use profileFromLoaded
	// directly. They were intentionally left untouched in DBG-006: those
	// blocks already read the latest local override via getLatestExistingLocal
	// before staging, so the 'custom' state is seeded by the hydration
	// helper rather than derived here.
	{
		const start = overlay.indexOf("function runProfileConfigBlock");
		const end = overlay.indexOf("\n}\n", start);
		const sec = start > 0 && end > 0 ? overlay.slice(start, end) : "";
		check(sec.includes("profileFromLoaded"), "dbg006: runProfileConfigBlock still uses profileFromLoaded for initial draft profile");
		check(sec.includes("hydrateProfileConfigDraft"), "dbg006: runProfileConfigBlock still uses hydrateProfileConfigDraft to seed the draft");
	}
}

if (failures > 0) {
	console.error(`\n${failures} smoke check(s) failed.`);
	process.exit(1);
}
console.log(`\nAll workflow_cfg smoke checks passed.`);