#!/usr/bin/env node
// TASK-029 Phase A smoke tests for PRD-first planning mode contracts.
// Deterministic/static assertions across prompts/defaults/bootstrap/example/deep-planning-core/docs.
import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}
function readSource(rel: string): string {
	return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

// --- 1. defaults.ts contracts ---
{
	const defaults = readSource("extensions/workflow/defaults.ts");
	check(defaults.includes('plannerCount: 2'), "defaults: plannerCount is 2");
	check(defaults.includes('maxConcurrency: 2'), "defaults: maxConcurrency is 2");
	check(defaults.includes('rounds: 2'), "defaults: rounds is 2");
	check(!defaults.includes('plannerCount: 3'), "defaults: no plannerCount 3 fallback");
	check(!defaults.includes('maxConcurrency: 3'), "defaults: no maxConcurrency 3 fallback");
	check(defaults.includes('"pr-agent-1"'), "defaults: pr-agent-1 present");
	check(defaults.includes('"pr-agent-2"'), "defaults: pr-agent-2 present");
	check(defaults.includes('"product-requirements"'), "defaults: role is product-requirements");
	check(defaults.includes("grill-me"), "defaults: instructions mention grill-me");
	check(defaults.includes("one highest-value question"), "defaults: instructions mention one highest-value question");
	check(defaults.includes("recommended answer"), "defaults: instructions mention recommended answer");
	check(defaults.includes("PRD draft"), "defaults: instructions mention PRD draft");
	check(defaults.includes("resolved decisions"), "defaults: instructions mention resolved decisions");
	check(defaults.includes("unresolved user questions"), "defaults: instructions mention unresolved user questions");
	check(defaults.includes("ready_for_sprint: yes|no"), "defaults: instructions mention ready_for_sprint");
	check(!defaults.includes('"planner-3"'), "defaults: no planner-3 id");
}

// --- 2. prompts.ts contracts ---
{
	const prompts = readSource("extensions/workflow/prompts.ts");
	check(prompts.includes("PRD-first planning"), "prompts: PRD-first planning mentioned");
	check(prompts.includes("PRD/Product Requirements intake"), "prompts: PRD/Product Requirements intake mentioned");
	check(prompts.includes("Sprint creation requires an explicit separate user confirmation"), "prompts: sprint creation confirmation gate");
	check(prompts.includes("Implementation/delegate_to_coder requires a second explicit confirmation"), "prompts: implementation confirmation gate");
	check(prompts.includes("Planning-stage approvals"), "prompts: planning-stage approval wording present");
	check(prompts.includes("continue planning / update the PRD"), "prompts: planning approval means continue planning");
	check(prompts.includes("do NOT authorize sprint creation or implementation"), "prompts: planning approval does not authorize implementation");
	check(prompts.includes("Tiny fixes"), "prompts: tiny-fix bypass mentioned");
	check(prompts.includes(".pi/workflow-runs/<planning-room>/PRD.md"), "prompts: PRD.md artifact path mentioned");
	check(prompts.includes("memo.md"), "prompts: memo.md artifact mentioned");
	check(prompts.includes("Product Requirements agent guidance"), "prompts: Product Requirements agent guidance present");
	check(prompts.includes("one highest-value grill-me question"), "prompts: grill-me one question wording");
	check(prompts.includes("recommended answer or default"), "prompts: recommended answer wording");
	check(prompts.includes("Inspect the codebase"), "prompts: inspect codebase before asking");
	check(prompts.includes("two Product Requirements agents"), "prompts: two PR agents default");
	check(prompts.includes("ready_for_sprint"), "prompts: ready_for_sprint in memo contract");
}

// --- 3. bootstrap.ts contracts ---
{
	const bootstrap = readSource("extensions/workflow/runtime/bootstrap.ts");
	check(bootstrap.includes('plannerCount: 2'), "bootstrap: plannerCount 2 in managed bundle");
	check(bootstrap.includes('maxConcurrency: 2'), "bootstrap: maxConcurrency 2 in managed bundle");
	check(bootstrap.includes('rounds: 2'), "bootstrap: rounds 2 in managed bundle");
	check(bootstrap.includes('"pr-agent-1"'), "bootstrap: pr-agent-1 in managed bundle");
	check(bootstrap.includes('"pr-agent-2"'), "bootstrap: pr-agent-2 in managed bundle");
	check(bootstrap.includes('"product-requirements"'), "bootstrap: product-requirements role in managed bundle");
	check(bootstrap.includes('modelPreset: "premium-planner"'), "bootstrap: modelPreset premium-planner in managed bundle");
	check(bootstrap.includes("grill-me"), "bootstrap: instructions mention grill-me");
	check(bootstrap.includes("one highest-value question"), "bootstrap: instructions mention one highest-value question");
	check(bootstrap.includes("recommended answer"), "bootstrap: instructions mention recommended answer");
	check(bootstrap.includes("PRD draft"), "bootstrap: instructions mention PRD draft");
	check(bootstrap.includes("ready_for_sprint: yes|no"), "bootstrap: instructions mention ready_for_sprint");
	check(!bootstrap.includes('plannerCount: 3'), "bootstrap: no plannerCount 3 in managed bundle");
	check(!bootstrap.includes('maxConcurrency: 3'), "bootstrap: no maxConcurrency 3 in managed bundle");
	check(!bootstrap.includes('"planner-3"'), "bootstrap: no planner-3 id in managed bundle");
	check(!bootstrap.includes('"role": "architecture"'), "bootstrap: no generic architecture role in managed bundle");
	check(bootstrap.includes('"premium-planner"'), "bootstrap: premium-planner preset in modelPresets");
}

// --- 4. examples/workflow.json contracts ---
{
	const example = readSource("examples/workflow.json");
	check(example.includes('"plannerCount": 2'), "example: plannerCount 2");
	check(example.includes('"maxConcurrency": 2'), "example: maxConcurrency 2");
	check(example.includes('"rounds": 2'), "example: rounds 2");
	check(example.includes('"pr-agent-1"'), "example: pr-agent-1");
	check(example.includes('"pr-agent-2"'), "example: pr-agent-2");
	check(example.includes('"product-requirements"'), "example: product-requirements role");
	check(example.includes('"modelPreset": "premium-planner"'), "example: modelPreset premium-planner");
	check(example.includes("grill-me"), "example: instructions mention grill-me");
	check(example.includes("one highest-value question"), "example: instructions mention one highest-value question");
	check(example.includes("recommended answer"), "example: instructions mention recommended answer");
	check(example.includes("PRD draft"), "example: instructions mention PRD draft");
	check(example.includes("ready_for_sprint: yes|no"), "example: instructions mention ready_for_sprint");
	check(!example.includes('"plannerCount": 3'), "example: no plannerCount 3");
	check(!example.includes('"maxConcurrency": 3'), "example: no maxConcurrency 3");
	check(!example.includes('"planner-3"'), "example: no planner-3 id");
	check(!example.includes('"role": "architecture"'), "example: no generic architecture role");
}

// --- 5. deep-planning-core.ts contracts ---
{
	const core = readSource("extensions/workflow/deep-planning-core.ts");
	check(core.includes("Product Requirements agent"), "core: buildPlannerRoundPrompt identifies as PR agent");
	check(core.includes("inspect the codebase"), "core: prompt instructs codebase inspection");
	check(core.includes("one highest-value question"), "core: prompt instructs one question per round");
	check(core.includes("recommended answer"), "core: prompt instructs recommended answer");
	check(core.includes("PRD draft"), "core: prompt mentions PRD draft");
	check(core.includes("resolved decisions"), "core: prompt mentions resolved decisions");
	check(core.includes("unresolved user questions"), "core: prompt mentions unresolved user questions");
	check(core.includes("ready_for_sprint: yes|no"), "core: prompt mentions ready_for_sprint");
	check(core.includes("Do not produce implementation plans or code"), "core: prompt forbids implementation plans");
	check(!core.includes("Round 1: independently produce options and explicit risks"), "core: old round 1 text removed");
	check(!core.includes("Round 2: read the room transcript, critique prior options, build consensus, and identify remaining risks"), "core: old round 2 text removed");
	check(core.includes("plannerCount ?? 2"), "core: fallback plannerCount is 2");
	check(core.includes("maxConcurrency ?? 2"), "core: fallback maxConcurrency is 2");
}

// --- 6. sprint prompt contracts ---
{
	const sprint = readSource("extensions/sprint/prompt.ts");
	check(sprint.includes("PRD/Product Requirements intake"), "sprint: PRD intake mentioned");
	check(sprint.includes("Planning-stage approval does NOT authorize implementation"), "sprint: planning approval does not authorize implementation");
	check(sprint.includes("sprint creation and implementation/delegation each require separate explicit user confirmations"), "sprint: separate confirmations");
	check(sprint.includes("tiny debug/hotfix"), "sprint: tiny-fix bypass mentioned");
}

// --- 7. configure-overlay-runtime.ts fallback values ---
{
	const runtime = readSource("extensions/workflow/configure-overlay-runtime.ts");
	check(runtime.includes("deepPlanningPlannerCount ?? 2"), "runtime overlay: plannerCount fallback 2");
	check(runtime.includes("deepPlanningMaxConcurrency ?? 2"), "runtime overlay: maxConcurrency fallback 2");
	check(!runtime.includes("deepPlanningPlannerCount ?? 3"), "runtime overlay: no plannerCount fallback 3");
	check(!runtime.includes("deepPlanningMaxConcurrency ?? 3"), "runtime overlay: no maxConcurrency fallback 3");
}

// --- 8. README.md contracts ---
{
	const readme = readSource("README.md");
	check(readme.includes('"plannerCount": 2'), "readme: plannerCount 2 in example");
	check(readme.includes('"maxConcurrency": 2'), "readme: maxConcurrency 2 in example");
	check(readme.includes('"pr-agent-1"'), "readme: pr-agent-1 in example");
	check(readme.includes('"pr-agent-2"'), "readme: pr-agent-2 in example");
	check(readme.includes('"product-requirements"'), "readme: product-requirements role in example");
	check(readme.includes("grill-me"), "readme: grill-me mentioned");
	check(readme.includes("one highest-value question"), "readme: one highest-value question mentioned");
	check(readme.includes("recommended answer"), "readme: recommended answer mentioned");
	check(readme.includes(".pi/workflow-runs/<planning-room>/PRD.md"), "readme: PRD.md artifact path");
	check(readme.includes("memo.md"), "readme: memo.md artifact mentioned");
	check(!readme.includes('"plannerCount": 3'), "readme: no plannerCount 3 in example");
	check(!readme.includes('"maxConcurrency": 3'), "readme: no maxConcurrency 3 in example");
	check(!readme.includes('"planner-1"'), "readme: no old planner-1 id");
	check(!readme.includes('"role": "architecture"'), "readme: no old architecture role");
}

// --- 9. docs/workflow-config-v2.md contracts ---
{
	const docs = readSource("docs/workflow-config-v2.md");
	check(docs.includes("two Product Requirements agents"), "docs: two PR agents default");
	check(docs.includes("plannerCount: 2"), "docs: plannerCount 2");
	check(docs.includes("maxConcurrency: 2"), "docs: maxConcurrency 2");
	check(docs.includes("grill-me"), "docs: grill-me mentioned");
	check(docs.includes("one highest-value question"), "docs: one highest-value question mentioned");
	check(docs.includes("recommended answer"), "docs: recommended answer mentioned");
	check(docs.includes(".pi/workflow-runs/<planning-room>/PRD.md"), "docs: PRD.md artifact path");
	check(docs.includes("memo.md"), "docs: memo.md artifact mentioned");
	check(docs.includes("ready_for_sprint: yes|no"), "docs: ready_for_sprint mentioned");
}

// --- 10. prompt-pack contracts ---
{
	const pack = readSource("examples/prompt-packs/brain-orchestrator-core.md");
	check(pack.includes("PRD-first planning rules"), "prompt-pack: PRD-first planning rules section");
	check(pack.includes("PRD/Product Requirements intake"), "prompt-pack: PRD intake mentioned");
	check(pack.includes("Sprint creation requires an explicit separate user confirmation"), "prompt-pack: sprint creation confirmation");
	check(pack.includes("Implementation/delegation to coder requires a separate explicit confirmation"), "prompt-pack: implementation confirmation");
	check(pack.includes("two Product Requirements agents"), "prompt-pack: two PR agents default");
	check(pack.includes("grill-me"), "prompt-pack: grill-me mentioned");
	check(pack.includes("ready_for_sprint"), "prompt-pack: ready_for_sprint mentioned");
	check(pack.includes(".pi/workflow-runs/<planning-room>/PRD.md"), "prompt-pack: PRD.md artifact path");
	check(pack.includes("memo.md"), "prompt-pack: memo.md artifact mentioned");
}

// --- 11. Preserve TASK-028/DBG-003 docs ---
{
	const readme = readSource("README.md");
	check(readme.includes("/workflow_cfg"), "readme: /workflow_cfg preserved");
	check(readme.includes("limited mode"), "readme: limited mode preserved");
	const overlay = readSource("extensions/workflow/configure-overlay.ts");
	check(overlay.includes('value: "profile"') && overlay.includes('label: "Profile"'), "dbg003: root Profile preserved");
	check(overlay.includes('value: "profile-config"') && overlay.includes('label: "Profile config"'), "dbg003: root Profile config preserved");
	check(overlay.includes('value: "runtime"') && overlay.includes('label: "Runtime settings"'), "dbg003: root Runtime settings preserved");
	const runtimeOverlay = readSource("extensions/workflow/configure-overlay-runtime.ts");
	check(runtimeOverlay.includes("Save runtime edits") && runtimeOverlay.includes("write to .pi/workflow.local.json"), "dbg003: runtime immediate save preserved");
}

if (failures > 0) {
	console.error(`\n${failures} smoke check(s) failed.`);
	process.exit(1);
}
console.log("\nAll TASK-029 PRD-first planning smoke checks passed.");
