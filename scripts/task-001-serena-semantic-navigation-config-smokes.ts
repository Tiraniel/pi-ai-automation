#!/usr/bin/env node
// TASK-001 smoke tests for optional Serena semanticNavigation config plumbing.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import { DEFAULT_CONFIG } from "../extensions/workflow/defaults";
import { normalizeV1Config } from "../extensions/workflow/config";

const require = createRequire(import.meta.url);
const Module = require("module");
const originalLoad = Module._load;
Module._load = function patchedTask001Load(request: string, parent: unknown, isMain: boolean) {
	if (request === "@earendil-works/pi-coding-agent") {
		return { getAgentDir: () => path.join(os.tmpdir(), "task-001-empty-agent-dir") };
	}
	return originalLoad.call(this, request, parent, isMain);
};

const { loadWorkflowConfig } = require("../extensions/workflow/runtime/config");

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
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

function writeWorkflow(dir: string, file: "workflow.json" | "workflow.local.json", payload: unknown): void {
	fs.writeFileSync(path.join(dir, ".pi", file), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

{
	const semanticNavigation = DEFAULT_CONFIG.semanticNavigation;
	check(semanticNavigation?.enabled === false, "DEFAULT_CONFIG semanticNavigation is disabled");
	check(semanticNavigation?.provider === "serena", "DEFAULT_CONFIG semanticNavigation provider is serena");
	check(semanticNavigation?.mode === "disabled", "DEFAULT_CONFIG semanticNavigation mode is disabled");
	check(semanticNavigation?.fallbackToBuiltinTools === true, "DEFAULT_CONFIG semanticNavigation fallback is enabled");
	check(semanticNavigation?.roles?.brain === "readonly" && semanticNavigation?.roles?.coder === "edit" && semanticNavigation?.roles?.reviewer === "readonly", "DEFAULT_CONFIG role policy is brain/reviewer readonly and coder edit");
	check(Array.isArray(semanticNavigation?.serenaReadonlyTools) && semanticNavigation?.serenaReadonlyTools.length === 0, "DEFAULT_CONFIG readonly Serena tool list is empty");
	check(Array.isArray(semanticNavigation?.serenaEditTools) && semanticNavigation?.serenaEditTools.length === 0, "DEFAULT_CONFIG edit Serena tool list is empty");
	check(Array.isArray(semanticNavigation?.serenaProjectTools) && semanticNavigation?.serenaProjectTools.length === 0, "DEFAULT_CONFIG project Serena tool list is empty");
}

withTempProject("task-001-absent", (dir) => {
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	check(loaded.config.semanticNavigation?.enabled === false, "loadWorkflowConfig absent project config defaults semanticNavigation disabled");
	check(loaded.config.semanticNavigation?.mode === "disabled", "loadWorkflowConfig absent project config defaults mode disabled");
});

{
	const normalized = normalizeV1Config({
		semanticNavigation: {
			enabled: true,
			provider: "serena",
			mode: "external",
			fallbackToBuiltinTools: false,
			roles: { brain: "readonly", coder: "edit", reviewer: "off", extra: "edit" },
			serenaReadonlyTools: ["mcp__serena__get_symbols_overview", "mcp__serena__find_symbol"],
			serenaEditTools: ["mcp__serena__replace_symbol_body"],
			serenaProjectTools: ["mcp__serena__activate_project"],
		},
	});
	check(normalized?.semanticNavigation?.enabled === true, "normalizeV1Config preserves semanticNavigation enabled=true");
	check(normalized?.semanticNavigation?.provider === "serena", "normalizeV1Config preserves provider serena");
	check(normalized?.semanticNavigation?.mode === "external", "normalizeV1Config preserves external mode");
	check(normalized?.semanticNavigation?.fallbackToBuiltinTools === false, "normalizeV1Config preserves fallback=false");
	check(normalized?.semanticNavigation?.roles?.coder === "edit" && normalized?.semanticNavigation?.roles?.reviewer === "off", "normalizeV1Config preserves supported role access values");
	check((normalized?.semanticNavigation?.roles as Record<string, unknown> | undefined)?.extra === undefined, "normalizeV1Config drops unknown role keys");
	check(normalized?.semanticNavigation?.serenaReadonlyTools?.includes("mcp__serena__find_symbol") === true, "normalizeV1Config preserves readonly Serena tools");
	check(normalized?.semanticNavigation?.serenaEditTools?.[0] === "mcp__serena__replace_symbol_body", "normalizeV1Config preserves edit Serena tools");
	check(normalized?.semanticNavigation?.serenaProjectTools?.[0] === "mcp__serena__activate_project", "normalizeV1Config preserves project Serena tools");
}

withTempProject("task-001-external", (dir) => {
	writeWorkflow(dir, "workflow.json", {
		semanticNavigation: {
			enabled: true,
			provider: "serena",
			mode: "external",
			fallbackToBuiltinTools: false,
			roles: { brain: "readonly", coder: "edit", reviewer: "readonly" },
			serenaReadonlyTools: ["mcp__serena__get_symbols_overview", "mcp__serena__find_referencing_symbols"],
			serenaEditTools: ["mcp__serena__replace_symbol_body"],
			serenaProjectTools: ["mcp__serena__activate_project"],
		},
	});
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	const semanticNavigation = loaded.config.semanticNavigation;
	check(semanticNavigation?.enabled === true, "loadWorkflowConfig accepts external Serena enabled=true");
	check(semanticNavigation?.provider === "serena" && semanticNavigation?.mode === "external", "loadWorkflowConfig accepts provider serena and external mode");
	check(semanticNavigation?.fallbackToBuiltinTools === false, "loadWorkflowConfig preserves fallback override");
	check(semanticNavigation?.serenaReadonlyTools?.includes("mcp__serena__find_referencing_symbols") === true, "loadWorkflowConfig preserves configured readonly tool list");
	check(semanticNavigation?.serenaEditTools?.[0] === "mcp__serena__replace_symbol_body", "loadWorkflowConfig preserves configured edit tool list");
	check(semanticNavigation?.serenaProjectTools?.[0] === "mcp__serena__activate_project", "loadWorkflowConfig preserves configured project tool list");
});

withTempProject("task-001-invalid", (dir) => {
	writeWorkflow(dir, "workflow.json", {
		semanticNavigation: {
			enabled: true,
			provider: "unknown-provider",
			mode: "managed",
			roles: { brain: "invalid", coder: "edit" },
			serenaReadonlyTools: ["valid", 42, "also-valid"],
		},
	});
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	check(Boolean(loaded.config), "loadWorkflowConfig returns a config object for invalid semanticNavigation values");
	check(loaded.config.semanticNavigation?.provider === "serena", "invalid provider falls back to the default Serena provider while disabled");
	check(loaded.config.semanticNavigation?.mode === "disabled", "managed/invalid mode falls back to disabled mode");
	check(loaded.config.semanticNavigation?.enabled === false, "invalid provider/mode disables semantic navigation instead of enabling defaults");
	check(loaded.config.semanticNavigation?.roles?.coder === "edit", "invalid provider/mode falls back to default role policy, not raw overrides");
	check(Array.isArray(loaded.config.semanticNavigation?.serenaReadonlyTools) && loaded.config.semanticNavigation?.serenaReadonlyTools.length === 0, "invalid provider/mode falls back to default empty tool lists");
	const diagnostics = loaded.configDiagnostics;
	check(diagnostics.some((diag) => diag.severity === "warning" && diag.code === "semantic-navigation-provider-unsupported" && diag.message.includes("unknown-provider")), "invalid provider emits warning diagnostic");
	check(diagnostics.some((diag) => diag.severity === "warning" && diag.code === "semantic-navigation-mode-unsupported" && diag.message.includes("managed") && diag.message.toLowerCase().includes("future")), "managed mode emits unsupported future-scope warning diagnostic");
	check(!diagnostics.some((diag) => diag.severity === "error" && diag.code.startsWith("semantic-navigation")), "semanticNavigation diagnostics are warnings, not errors");
});

withTempProject("task-001-local-invalid", (dir) => {
	writeWorkflow(dir, "workflow.local.json", { semanticNavigation: { provider: "bad-local", mode: "bad-mode" } });
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	check(loaded.configDiagnostics.some((diag) => diag.source === "semanticNavigation.provider" && diag.message.includes("bad-local")), "workflow.local.json invalid provider emits diagnostic");
	check(loaded.configDiagnostics.some((diag) => diag.source === "semanticNavigation.mode" && diag.message.includes("bad-mode")), "workflow.local.json invalid mode emits diagnostic");
});

withTempProject("task-001-non-string-invalid-provider", (dir) => {
	writeWorkflow(dir, "workflow.json", { semanticNavigation: { enabled: true, provider: 42, mode: "external" } });
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	check(loaded.config.semanticNavigation?.enabled === false, "non-string provider disables semanticNavigation instead of allowing external mode");
	check(loaded.config.semanticNavigation?.provider === "serena", "non-string provider falls back to default Serena provider");
	check(loaded.config.semanticNavigation?.mode === "disabled", "non-string provider falls back to disabled mode");
	check(loaded.configDiagnostics.some((diag) => diag.severity === "warning" && diag.code === "semantic-navigation-provider-unsupported" && diag.message.includes("42")), "non-string provider emits warning diagnostic");
});

withTempProject("task-001-non-string-invalid-mode", (dir) => {
	writeWorkflow(dir, "workflow.json", { semanticNavigation: { enabled: true, provider: "serena", mode: false } });
	const loaded = loadWorkflowConfig(dir, { cliProfile: "default" });
	check(loaded.config.semanticNavigation?.enabled === false, "non-string mode disables semanticNavigation");
	check(loaded.config.semanticNavigation?.mode === "disabled", "non-string mode falls back to disabled mode");
	check(loaded.configDiagnostics.some((diag) => diag.severity === "warning" && diag.code === "semantic-navigation-mode-unsupported" && diag.message.includes("false")), "non-string mode emits warning diagnostic");
});

{
	const workflowDoc = fs.readFileSync(path.join(process.cwd(), "docs", "workflow-config-v2.md"), "utf8");
	const prdDoc = fs.readFileSync(path.join(process.cwd(), "docs", "prd-serena-semantic-navigation.md"), "utf8");
	const docs = `${workflowDoc}\n${prdDoc}`.toLowerCase();
	check(docs.includes("semanticnavigation"), "docs mention semanticNavigation config");
	check(docs.includes("mode") && docs.includes("external"), "docs mention external mode");
	check(docs.includes("mcp_servers.serena") && docs.includes("start-mcp-server"), "docs include external Serena MCP TOML snippet");
	check(docs.includes("managed") && docs.includes("future"), "docs document managed as future scope");
	check(docs.includes("limitations") || docs.includes("non-goals"), "docs include limitations or non-goals");
	check(docs.includes("evidence") && docs.includes("workflow"), "docs preserve workflow evidence boundaries");
}

if (failures > 0) {
	console.error(`\n${failures} TASK-001 smoke assertion(s) failed.`);
	process.exit(1);
}
console.log("\nTASK-001 Serena semanticNavigation config smokes passed.");
