#!/usr/bin/env node
// TASK-003 Phase A smoke tests for isolated Serena prompt guidance helpers.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import {
	BRAIN_INSTRUCTIONS,
	CODER_INSTRUCTIONS,
	REVIEWER_INSTRUCTIONS,
	buildSemanticNavigationPromptGuidance,
	isSemanticNavigationPromptGuidanceEnabled,
	withSemanticNavigationPromptGuidance,
} from "../extensions/workflow/prompts";
import type { AgentName, AgentPreset, SemanticNavigationConfig, WorkflowConfig } from "../extensions/workflow/types";

const require = createRequire(import.meta.url);
const Module = require("module");
const originalLoad = Module._load;
Module._load = function patchedTask003Load(request: string, parent: unknown, isMain: boolean) {
	if (request === "@earendil-works/pi-coding-agent") {
		return { getAgentDir: () => path.join(os.tmpdir(), "task-003-empty-agent-dir") };
	}
	return originalLoad.call(this, request, parent, isMain);
};

const { loadWorkflowConfig, getAgentPreset } = require("../extensions/workflow/runtime/config") as {
	loadWorkflowConfig: (cwd: string, options?: { cliProfile?: string }) => { config: WorkflowConfig };
	getAgentPreset: (config: WorkflowConfig, agent: AgentName) => AgentPreset;
};

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function includesAll(text: string, phrases: readonly string[]): boolean {
	const lower = text.toLowerCase();
	return phrases.every((phrase) => lower.includes(phrase.toLowerCase()));
}

function withTempProject(name: string, fn: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
	try {
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function writeWorkflow(dir: string, payload: unknown): void {
	fs.writeFileSync(path.join(dir, ".pi", "workflow.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function baseInstructionsForRole(role: AgentName): string {
	if (role === "brain") return BRAIN_INSTRUCTIONS;
	if (role === "coder") return CODER_INSTRUCTIONS;
	return REVIEWER_INSTRUCTIONS;
}

const enabledExternal: SemanticNavigationConfig = {
	enabled: true,
	provider: "serena",
	mode: "external",
	fallbackToBuiltinTools: true,
	roles: {
		brain: "readonly",
		coder: "edit",
		reviewer: "readonly",
	},
};

const roles: AgentName[] = ["brain", "coder", "reviewer"];
for (const role of roles) {
	check(isSemanticNavigationPromptGuidanceEnabled(enabledExternal, role), `enabled external config enables ${role} guidance`);
	check(buildSemanticNavigationPromptGuidance(role, enabledExternal).includes("Serena semantic navigation"), `${role} guidance names Serena semantic navigation`);
}

const brainGuidance = buildSemanticNavigationPromptGuidance("brain", enabledExternal);
check(includesAll(brainGuidance, [
	"codebase orientation",
	"architecture understanding",
	"concrete file/symbol/reference findings",
	"self-contained coder task",
	"do not delegate vague Serena exploration",
	"built-in tools",
]), "Brain guidance covers orientation, architecture, concrete refs, self-contained delegation, no vague exploration, and fallback context");

const coderGuidance = buildSemanticNavigationPromptGuidance("coder", enabledExternal);
check(includesAll(coderGuidance, [
	"symbol/reference lookup",
	"modifying existing subsystems",
	"inspect the exact target file with built-in file tools/read",
	"before final edits",
	"run required validation commands",
	"not validation proof",
]), "Coder guidance requires semantic lookup, exact built-in file inspection before final edits, and validation after semantic edits");

const reviewerGuidance = buildSemanticNavigationPromptGuidance("reviewer", enabledExternal);
check(includesAll(reviewerGuidance, [
	"readonly navigation",
	"changed symbols",
	"references/call sites",
	"diagnostics",
	"review coverage/supporting context",
	"not behavioral/runtime validation evidence",
	"request changes",
	"do not use reviewer edit/refactor tools",
]), "Reviewer guidance covers changed symbols/references/diagnostics as coverage, not behavior evidence, with readonly/no-edit boundaries");

const disabledConfig: SemanticNavigationConfig = { ...enabledExternal, enabled: false };
const disabledModeConfig: SemanticNavigationConfig = { ...enabledExternal, mode: "disabled" };
const roleOffConfig: SemanticNavigationConfig = { ...enabledExternal, roles: { brain: "off", coder: "off", reviewer: "off" } };
const missingRoleConfig: SemanticNavigationConfig = { ...enabledExternal, roles: {} };
const unsupportedProviderConfig = { ...enabledExternal, provider: "other" } as unknown as SemanticNavigationConfig;

for (const [label, config] of [
	["missing config", undefined],
	["disabled config", disabledConfig],
	["disabled mode", disabledModeConfig],
	["role off", roleOffConfig],
	["missing role", missingRoleConfig],
	["unsupported provider", unsupportedProviderConfig],
] as const) {
	for (const role of roles) {
		check(!isSemanticNavigationPromptGuidanceEnabled(config, role), `${label} disables ${role} guidance`);
		check(buildSemanticNavigationPromptGuidance(role, config) === "", `${label} returns empty ${role} guidance`);
	}
}

const preset: AgentPreset = { model: "example", instructions: "Base instructions", tools: ["read"] };
const disabledPreset = withSemanticNavigationPromptGuidance(preset, "coder", disabledConfig);
check(disabledPreset === preset, "withSemanticNavigationPromptGuidance returns original preset when disabled");
check(preset.instructions === "Base instructions" && preset.tools?.[0] === "read", "withSemanticNavigationPromptGuidance does not mutate disabled preset input");

const enabledPreset = withSemanticNavigationPromptGuidance(preset, "coder", enabledExternal);
check(enabledPreset !== preset, "withSemanticNavigationPromptGuidance returns shallow copy when guidance applies");
check(enabledPreset.instructions === `Base instructions\n\n${coderGuidance}`, "withSemanticNavigationPromptGuidance appends guidance after a blank line");
check(preset.instructions === "Base instructions", "withSemanticNavigationPromptGuidance does not mutate enabled preset input");
check(enabledPreset.tools === preset.tools, "withSemanticNavigationPromptGuidance preserves other preset fields by shallow copy");

for (const [role, instructions] of [
	["brain", BRAIN_INSTRUCTIONS],
	["coder", CODER_INSTRUCTIONS],
	["reviewer", REVIEWER_INSTRUCTIONS],
] as const) {
	const basePreset: AgentPreset = { instructions };
	const unchanged = withSemanticNavigationPromptGuidance(basePreset, role, disabledConfig);
	check(unchanged === basePreset, `disabled config keeps ${role} base preset object unchanged`);
	check(unchanged.instructions === instructions, `disabled config keeps ${role} base instructions behavior-compatible`);
	check(!unchanged.instructions?.includes("Serena semantic navigation"), `disabled config appends no Serena guidance to ${role} instructions`);
}

withTempProject("task-003-runtime-enabled", (dir) => {
	writeWorkflow(dir, { semanticNavigation: enabledExternal });
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	for (const role of roles) {
		const instructions = getAgentPreset(loaded.config, role).instructions ?? "";
		check(includesAll(instructions, buildSemanticNavigationPromptGuidance(role, enabledExternal).split(/\n-?\s*/).filter(Boolean)), `runtime getAgentPreset appends ${role} Serena guidance when enabled external`);
	}
	check(includesAll(getAgentPreset(loaded.config, "brain").instructions ?? "", ["codebase orientation", "architecture understanding", "concrete file/symbol/reference findings", "self-contained coder task"]), "runtime Brain guidance includes orientation, architecture, concrete refs, and self-contained delegation");
	check(includesAll(getAgentPreset(loaded.config, "coder").instructions ?? "", ["inspect the exact target file with built-in file tools/read", "before final edits", "run required validation commands"]), "runtime Coder guidance includes exact built-in file inspection before final edits and validation commands");
	check(includesAll(getAgentPreset(loaded.config, "reviewer").instructions ?? "", ["review coverage/supporting context", "not behavioral/runtime validation evidence", "do not use reviewer edit/refactor tools"]), "runtime Reviewer guidance treats Serena as review coverage, not behavior evidence, and stays readonly/no-edit");
});

withTempProject("task-003-runtime-default", (dir) => {
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	for (const role of roles) {
		const instructions = getAgentPreset(loaded.config, role).instructions;
		check(instructions === baseInstructionsForRole(role), `runtime absent semanticNavigation keeps ${role} base instructions unchanged`);
		check(!instructions?.includes("Serena semantic navigation"), `runtime absent semanticNavigation appends no ${role} Serena guidance`);
	}
});

withTempProject("task-003-runtime-disabled", (dir) => {
	writeWorkflow(dir, { semanticNavigation: disabledConfig });
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	for (const role of roles) {
		const instructions = getAgentPreset(loaded.config, role).instructions;
		check(instructions === baseInstructionsForRole(role), `runtime disabled semanticNavigation keeps ${role} base instructions unchanged`);
		check(!instructions?.includes("Serena semantic navigation"), `runtime disabled semanticNavigation appends no ${role} Serena guidance`);
	}
});

withTempProject("task-003-runtime-role-off", (dir) => {
	writeWorkflow(dir, {
		semanticNavigation: {
			...enabledExternal,
			roles: { brain: "readonly", coder: "off", reviewer: "readonly" },
		},
	});
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	check(getAgentPreset(loaded.config, "brain").instructions?.includes("Serena semantic navigation guidance for Brain") === true, "runtime role-off config still enables Brain guidance");
	check(getAgentPreset(loaded.config, "coder").instructions === CODER_INSTRUCTIONS, "runtime role-off config suppresses Coder guidance");
	check(!getAgentPreset(loaded.config, "coder").instructions?.includes("Serena semantic navigation"), "runtime role-off config appends no Coder Serena guidance");
	check(getAgentPreset(loaded.config, "reviewer").instructions?.includes("Serena semantic navigation guidance for Reviewer") === true, "runtime role-off config still enables Reviewer guidance");
});

withTempProject("task-003-runtime-empty-roles", (dir) => {
	writeWorkflow(dir, { semanticNavigation: { ...enabledExternal, roles: {} } });
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	for (const role of roles) {
		const instructions = getAgentPreset(loaded.config, role).instructions;
		check(instructions === baseInstructionsForRole(role), `runtime explicit empty roles map keeps ${role} base instructions unchanged`);
		check(!instructions?.includes("Serena semantic navigation"), `runtime explicit empty roles map appends no ${role} Serena guidance`);
	}
});

withTempProject("task-003-runtime-partial-roles", (dir) => {
	writeWorkflow(dir, { semanticNavigation: { ...enabledExternal, roles: { brain: "readonly" } } });
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	check(getAgentPreset(loaded.config, "brain").instructions?.includes("Serena semantic navigation guidance for Brain") === true, "runtime partial roles map enables explicitly configured Brain guidance");
	check(getAgentPreset(loaded.config, "coder").instructions === CODER_INSTRUCTIONS, "runtime partial roles map suppresses omitted Coder guidance");
	check(!getAgentPreset(loaded.config, "coder").instructions?.includes("Serena semantic navigation"), "runtime partial roles map appends no omitted Coder Serena guidance");
	check(getAgentPreset(loaded.config, "reviewer").instructions === REVIEWER_INSTRUCTIONS, "runtime partial roles map suppresses omitted Reviewer guidance");
	check(!getAgentPreset(loaded.config, "reviewer").instructions?.includes("Serena semantic navigation"), "runtime partial roles map appends no omitted Reviewer Serena guidance");
});

withTempProject("task-003-runtime-repeat", (dir) => {
	writeWorkflow(dir, { semanticNavigation: enabledExternal });
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	const first = getAgentPreset(loaded.config, "coder");
	const second = getAgentPreset(loaded.config, "coder");
	check(first.instructions === second.instructions, "repeated getAgentPreset calls produce stable instructions");
	check((second.instructions?.match(/Serena semantic navigation guidance for Coder/g) ?? []).length === 1, "repeated getAgentPreset calls do not duplicate guidance");
	check(loaded.config.agents?.coder?.instructions === CODER_INSTRUCTIONS, "repeated getAgentPreset calls do not mutate loaded config preset instructions");
});

if (failures > 0) {
	console.error(`\n${failures} TASK-003 smoke assertion(s) failed.`);
	process.exit(1);
}
console.log("\nTASK-003 Serena prompt guidance smokes passed.");
