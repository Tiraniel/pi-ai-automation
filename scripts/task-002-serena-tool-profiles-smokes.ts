#!/usr/bin/env node
// TASK-002 smoke tests for additive opt-in Serena-aware v2 tool profiles/catalog entries.
import * as fs from "node:fs";
import * as path from "node:path";

import { loadV2Workflow, resolveWorkflow } from "../extensions/workflow/config";
import type { V2AgentCatalog, V2CatalogBundle, V2ResolvedRoleIdentity, V2ToolProfilesCatalog, V2Workflow } from "../extensions/workflow/types";

const DEFAULT_BRAIN_TOOLS = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"room_create",
	"room_job_start",
	"room_send",
	"room_read",
	"room_job_done",
	"room_status",
	"workflow_deep_plan",
];
const DEFAULT_CODER_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"room_create",
	"room_job_start",
	"room_send",
	"room_read",
	"room_job_done",
	"room_status",
];
const DEFAULT_REVIEWER_TOOLS = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"room_create",
	"room_job_start",
	"room_send",
	"room_read",
	"room_job_done",
	"room_status",
];
const SERENA_READONLY_TOOLS = [
	"mcp__serena__activate_project",
	"mcp__serena__get_symbols_overview",
	"mcp__serena__find_symbol",
	"mcp__serena__find_referencing_symbols",
	"mcp__serena__search_for_pattern",
];
const SERENA_EDIT_TOOLS = [
	"mcp__serena__replace_symbol_body",
	"mcp__serena__insert_before_symbol",
	"mcp__serena__insert_after_symbol",
];
const SERENA_FORBIDDEN_REVIEWER_PATTERNS = [/replace/i, /insert/i, /rename/i, /refactor/i, /delete/i, /write/i];

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function readJson<T>(relativePath: string): T {
	return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")) as T;
}

function arraysEqual(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
	return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function profileById(catalog: V2ToolProfilesCatalog, id: string) {
	return catalog.profiles.find((profile) => profile.id === id);
}

function agentById(catalog: V2AgentCatalog, id: string) {
	return catalog.agents.find((agent) => agent.id === id);
}

function roleByName(roles: readonly V2ResolvedRoleIdentity[], role: string): V2ResolvedRoleIdentity | undefined {
	return roles.find((identity) => identity.role === role);
}

function includesAll(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
	return Array.isArray(actual) && expected.every((tool) => actual.includes(tool));
}

const toolProfiles = readJson<V2ToolProfilesCatalog>("examples/workflow.tool-profiles.json");
const agentCatalog = readJson<V2AgentCatalog>("examples/workflow.agent-catalog.json");

const defaultBrain = profileById(toolProfiles, "brain-room-only");
const defaultCoder = profileById(toolProfiles, "coder-room-and-edit");
const defaultReviewer = profileById(toolProfiles, "reviewer-readonly");
check(arraysEqual(defaultBrain?.tools, DEFAULT_BRAIN_TOOLS), "default brain-room-only tools match pre-Serena baseline exactly");
check(arraysEqual(defaultCoder?.tools, DEFAULT_CODER_TOOLS), "default coder-room-and-edit tools match pre-Serena baseline exactly");
check(defaultCoder?.includeKarpathyGuidelines === true, "default coder-room-and-edit keeps includeKarpathyGuidelines=true");
check(arraysEqual(defaultReviewer?.tools, DEFAULT_REVIEWER_TOOLS), "default reviewer-readonly tools match pre-Serena baseline exactly");

const serenaBrain = profileById(toolProfiles, "brain-serena-readonly");
const serenaCoder = profileById(toolProfiles, "coder-serena-and-edit");
const serenaReviewer = profileById(toolProfiles, "reviewer-serena-readonly");
check(Boolean(serenaBrain), "brain-serena-readonly profile exists");
check(Boolean(serenaCoder), "coder-serena-and-edit profile exists");
check(Boolean(serenaReviewer), "reviewer-serena-readonly profile exists");
check(arraysEqual(serenaBrain?.tools, [...DEFAULT_BRAIN_TOOLS, ...SERENA_READONLY_TOOLS]), "brain-serena-readonly contains default brain tools plus readonly Serena tools only");
check(arraysEqual(serenaCoder?.tools, [...DEFAULT_CODER_TOOLS, ...SERENA_READONLY_TOOLS, ...SERENA_EDIT_TOOLS]), "coder-serena-and-edit contains default coder tools plus readonly and explicit edit Serena tools");
check(arraysEqual(serenaReviewer?.tools, [...DEFAULT_REVIEWER_TOOLS, ...SERENA_READONLY_TOOLS]), "reviewer-serena-readonly contains default reviewer tools plus readonly Serena tools only");
check(SERENA_EDIT_TOOLS.every((tool) => !serenaBrain?.tools.includes(tool) && !serenaReviewer?.tools.includes(tool)), "readonly Serena profiles exclude explicit edit tools");
check((serenaReviewer?.tools ?? []).every((tool) => !tool.startsWith("mcp__serena__") || SERENA_FORBIDDEN_REVIEWER_PATTERNS.every((pattern) => !pattern.test(tool))), "reviewer-serena-readonly excludes Serena edit/refactor/delete/write tool names");
check([defaultBrain, defaultCoder, defaultReviewer, serenaBrain, serenaReviewer].every((profile) => SERENA_EDIT_TOOLS.every((tool) => !profile?.tools.includes(tool))), "only coder-serena-and-edit profile includes explicit Serena edit tools");
check(SERENA_EDIT_TOOLS.every((tool) => serenaCoder?.tools.includes(tool)), "coder-serena-and-edit explicitly includes all configured Serena edit tools");

const serenaBrainAgent = agentById(agentCatalog, "brain-serena-readonly");
const serenaCoderAgent = agentById(agentCatalog, "coder-serena-and-edit");
const serenaReviewerAgent = agentById(agentCatalog, "reviewer-serena-readonly");
check(serenaBrainAgent?.role === "brain" && serenaBrainAgent.modelPreset === "premium-brain" && serenaBrainAgent.toolProfile === "brain-serena-readonly" && arraysEqual(serenaBrainAgent.promptPacks, ["brain-orchestrator-core"]), "brain Serena agent binds premium brain preset, readonly Serena profile, and brain prompt pack");
check(serenaCoderAgent?.role === "coder" && serenaCoderAgent.modelPreset === "premium-coder" && serenaCoderAgent.toolProfile === "coder-serena-and-edit" && arraysEqual(serenaCoderAgent.promptPacks, ["coder-implementer-core", "coder-karpathy"]) && arraysEqual(serenaCoderAgent.qualityGates, ["gate-typescript-strict", "gate-git-diff-check"]), "coder Serena agent binds premium coder preset, Serena edit profile, prompt packs, and default coder quality gates");
check(serenaReviewerAgent?.role === "reviewer" && serenaReviewerAgent.modelPreset === "premium-reviewer" && serenaReviewerAgent.toolProfile === "reviewer-serena-readonly" && arraysEqual(serenaReviewerAgent.promptPacks, ["reviewer-judge-core"]) && arraysEqual(serenaReviewerAgent.qualityGates, agentById(agentCatalog, "reviewer-default")?.qualityGates ?? []), "reviewer Serena agent binds premium reviewer preset, readonly Serena profile, prompt pack, and default reviewer quality gates");

const loadedDefault = loadV2Workflow(path.join(process.cwd(), "examples", "workflow.json"));
check(!loadedDefault.diagnostics.some((diag) => diag.severity === "error"), "default workflow loads without resolver errors");
const defaultRoles = loadedDefault.resolved?.roles ?? [];
check(roleByName(defaultRoles, "brain")?.agent.id === "brain-default" && roleByName(defaultRoles, "coder")?.agent.id === "coder-default" && roleByName(defaultRoles, "reviewer")?.agent.id === "reviewer-default", "examples/workflow.json stays bound to default agents");
check(arraysEqual(roleByName(defaultRoles, "brain")?.tools.tools, DEFAULT_BRAIN_TOOLS) && arraysEqual(roleByName(defaultRoles, "coder")?.tools.tools, DEFAULT_CODER_TOOLS) && arraysEqual(roleByName(defaultRoles, "reviewer")?.tools.tools, DEFAULT_REVIEWER_TOOLS), "default workflow resolves default role tools exactly with no Serena additions");
check(defaultRoles.every((role) => SERENA_READONLY_TOOLS.every((tool) => !role.tools.tools.includes(tool)) && SERENA_EDIT_TOOLS.every((tool) => !role.tools.tools.includes(tool))), "default workflow resolved tools contain no Serena tools");

if (loadedDefault.workflow && loadedDefault.catalogs) {
	const serenaWorkflow: V2Workflow = {
		...loadedDefault.workflow,
		roles: [
			{ role: "brain", agent: "brain-serena-readonly" },
			{ role: "coder", agent: "coder-serena-and-edit" },
			{ role: "reviewer", agent: "reviewer-serena-readonly" },
		],
	};
	const resolvedSerena = resolveWorkflow(serenaWorkflow, loadedDefault.catalogs);
	check(!resolvedSerena.diagnostics.some((diag) => diag.severity === "error"), "synthetic Serena workflow resolves without errors");
	check(arraysEqual(roleByName(resolvedSerena.roles, "brain")?.tools.tools, [...DEFAULT_BRAIN_TOOLS, ...SERENA_READONLY_TOOLS]), "synthetic Serena brain resolves readonly navigation tools");
	check(arraysEqual(roleByName(resolvedSerena.roles, "coder")?.tools.tools, [...DEFAULT_CODER_TOOLS, ...SERENA_READONLY_TOOLS, ...SERENA_EDIT_TOOLS]), "synthetic Serena coder resolves navigation plus explicit edit tools");
	check(arraysEqual(roleByName(resolvedSerena.roles, "reviewer")?.tools.tools, [...DEFAULT_REVIEWER_TOOLS, ...SERENA_READONLY_TOOLS]), "synthetic Serena reviewer resolves readonly navigation tools");

	const overrideCatalogs: V2CatalogBundle = {
		...loadedDefault.catalogs,
		agentCatalog: {
			...loadedDefault.catalogs.agentCatalog!,
			agents: [
				...loadedDefault.catalogs.agentCatalog!.agents,
				{
					id: "coder-serena-override-smoke",
					role: "coder",
					modelPreset: "premium-coder",
					toolProfile: "coder-serena-and-edit",
					promptPacks: ["coder-implementer-core", "coder-karpathy"],
					overrides: { tools: ["custom_tool"] },
				},
			],
		},
	};
	const overrideWorkflow: V2Workflow = {
		...loadedDefault.workflow,
		roles: [{ role: "coder", agent: "coder-serena-override-smoke" }],
	};
	const resolvedOverride = resolveWorkflow(overrideWorkflow, overrideCatalogs);
	const overrideCoder = roleByName(resolvedOverride.roles, "coder");
	check(arraysEqual(overrideCoder?.tools.tools, ["custom_tool"]) && overrideCoder?.tools.source === "override", "agent.overrides.tools replaces Serena profile tools and reports source=override");
}

if (failures > 0) {
	console.error(`\n${failures} TASK-002 smoke assertion(s) failed.`);
	process.exit(1);
}
console.log("\nTASK-002 Serena tool profile/catalog smokes passed.");
