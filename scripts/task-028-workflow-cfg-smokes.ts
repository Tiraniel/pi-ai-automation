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
	check(overlay.includes("collectWorkflowModelChoices") && overlay.includes("isGonkaAvailable") && overlay.includes("runPreviewOverlay") && overlay.includes("showModelPickerOverlay") && overlay.includes("loadWorkflowConfig"), "phaseB source: overlay composes helper/model/profile/preview blocks");
	check(!overlay.includes("cleared: false"), "phaseB source: role edits do not assign cleared:false");
	const preview = readSource("extensions/workflow/configure-overlay-preview.ts");
	check(preview.includes("buildWorkflowLocalPreviewText") && preview.includes("buildWorkflowLocalPayload") && preview.includes("writeWorkflowLocalOverride") && preview.includes("./configure-io") && !preview.includes('from "./configure"'), "phaseB source: preview/apply uses Phase A helpers and configure-io");
	const thinking = readSource("extensions/workflow/configure-overlay-thinking.ts");
	check(thinking.includes("getSupportedWorkflowThinkingLevels") && !thinking.includes("for (const level of THINKING_LEVELS)"), "phaseB source: thinking picker constrained by helper");
	const picker = readSource("extensions/workflow/configure-model-picker.ts");
	check(picker.includes("Input") && picker.includes("getValue()") && !picker.includes("getText()") && picker.includes("truncateToWidth") && picker.includes("visibleWidth"), "phaseB source: model picker is searchable and width-safe");
	const runtime = readSource("extensions/workflow/configure-overlay-runtime.ts");
	check(runtime.includes("__save") && runtime.includes("__discard"), "phaseB source: runtime overlay has explicit save/discard actions");
	for (const id of ["delegateDisplay", "delegatePaneAutoClose", "reviewerSwarm.enabled", "reviewerSwarm.maxConcurrency", "deepPlanning.enabled", "deepPlanning.plannerCount", "deepPlanning.rounds", "deepPlanning.maxConcurrency"]) {
		check(runtime.includes(id), `phaseB source: runtime setting exposed: ${id}`);
	}
	const readme = readSource("README.md");
	check(readme.includes("/workflow_cfg") && readme.includes("limited mode") && readme.includes("Preview/Apply"), "phaseB docs: README documents /workflow_cfg and degraded limited mode");
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

if (failures > 0) {
	console.error(`\n${failures} smoke check(s) failed.`);
	process.exit(1);
}
console.log(`\nAll workflow_cfg smoke checks passed.`);