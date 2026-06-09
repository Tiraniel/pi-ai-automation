import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MANAGED_BY = "pi-ai-automation";
const MANAGED_VERSION = "2026.06.05";
const MANAGED_FILE_PREFIX = "workflow";

const WORKFLOW_FILE = `${MANAGED_FILE_PREFIX}.json`;
const WORKFLOW_AGENT_CATALOG_FILE = `${MANAGED_FILE_PREFIX}.agent-catalog.json`;
const WORKFLOW_MODEL_PRESETS_FILE = `${MANAGED_FILE_PREFIX}.model-presets.json`;
const WORKFLOW_TOOL_PROFILES_FILE = `${MANAGED_FILE_PREFIX}.tool-profiles.json`;
const WORKFLOW_PROMPT_PACKS_FILE = `${MANAGED_FILE_PREFIX}.prompt-packs.json`;
const WORKFLOW_QUALITY_GATES_FILE = `${MANAGED_FILE_PREFIX}.quality-gates.json`;

const DEFAULT_REVIEW_TARGETS = [
	"Changed-code acceptance behavior",
	"Implementation correctness and regressions",
	"Test and validation evidence for implementation",
	"Security, performance, and maintainability of changed code",
];

const LEGACY_REVIEW_TARGETS = [
	"Requirements and acceptance criteria coverage",
	"Correctness and regression risks",
	"Tests and validation quality",
	"Security, performance, and maintainability",
];

export interface ManagedBootstrapDiagnostic {
	code:
		| "bootstrap-create"
		| "bootstrap-refresh"
		| "bootstrap-replace-legacy"
		| "bootstrap-preserve-custom"
		| "bootstrap-preserve-unreadable";
	message: string;
}

export interface BootstrapResult {
	action: "created" | "updated" | "preserved" | "replaced" | "noop";
	diagnostics: ManagedBootstrapDiagnostic[];
	written: string[];
	backupPath?: string;
	agentDir: string;
	status: string;
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyDefaultReviewerTargets(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	return arraysEqual(value, DEFAULT_REVIEW_TARGETS) || arraysEqual(value, LEGACY_REVIEW_TARGETS);
}

function readJson(filePath: string): JsonObject | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as JsonObject;
	} catch {
		return null;
	}
}

function writeJson(filePath: string, value: JsonObject): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function toManaged<T extends JsonObject>(value: T): T {
	return {
		...value,
		_managedBy: MANAGED_BY,
		_managedVersion: MANAGED_VERSION,
	};
}

function arraysEqual(a: unknown, b: unknown): boolean {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function isManagedConfig(fileContents: unknown): boolean {
	return (
		isPlainObject(fileContents)
		&& fileContents._managedBy === MANAGED_BY
		&& typeof fileContents._managedVersion === "string"
	);
}

function isLegacyDefaultV1Config(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	if (value.version === 2) return false;

	if (value.autoApplyBrain !== true) return false;
	if (value.delegateDisplay !== "headless") return false;
	if (value.delegatePaneAutoClose !== true && value.delegatePaneAutoClose !== undefined) return false;

	const agents = value.agents;
	if (!isPlainObject(agents)) return false;

	const brain = agents.brain;
	const coder = agents.coder;
	const reviewer = agents.reviewer;
	if (!isPlainObject(brain) || !isPlainObject(coder) || !isPlainObject(reviewer)) return false;

	if (brain.provider !== "openai-codex" || brain.model !== "gpt-5.5" || brain.thinkingLevel !== "xhigh") return false;
	if (coder.provider !== "openai-codex" || coder.model !== "gpt-5.3-codex" || coder.thinkingLevel !== "medium") return false;
	if (reviewer.provider !== "openai-codex" || reviewer.model !== "gpt-5.5" || reviewer.thinkingLevel !== "high") return false;

	const brainInstructions = normalizeString(brain.instructions);
	const coderInstructions = normalizeString(coder.instructions);
	const reviewerInstructions = normalizeString(reviewer.instructions);
	if (!brainInstructions.startsWith("Optional: override") || !coderInstructions.startsWith("Optional: override") || !reviewerInstructions.startsWith("Optional: override")) {
		return false;
	}

	if (!arraysEqual(coder.tools, [
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
	])) return false;
	if (!arraysEqual(reviewer.tools, [
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
	])) return false;

	if (value.reviewerSwarm === undefined) return false;
	const reviewerSwarm = value.reviewerSwarm;
	if (!isPlainObject(reviewerSwarm)) return false;
	if (reviewerSwarm.enabled !== true) return false;
	if (reviewerSwarm.maxConcurrency !== 2) return false;
	if (!isLegacyDefaultReviewerTargets(reviewerSwarm.targets)) return false;
	if (coder.includeKarpathyGuidelines !== true) return false;
	return true;
}

function normalizeString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function makeTimestamp(): string {
	return new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
}

function backupFile(filePath: string): string {
	const backupPath = `${filePath}.backup-${makeTimestamp()}.json`;
	fs.copyFileSync(filePath, backupPath);
	return backupPath;
}

function managedWorkflowBundle(): JsonObject {
	return {
		version: 2,
		meta: {
			name: "pi-managed-default",
			description: "Managed default workflow for pi-ai-automation",
		},
		direction: "sequential",
		flow: [
			{ role: "brain" },
			{ role: "coder" },
			{ role: "reviewer" },
		],
		deepPlanning: {
			enabled: false,
			plannerCount: 2,
			maxConcurrency: 2,
			rounds: 2,
			roomIdPrefix: "deep-plan",
			planners: [
				{
					id: "pr-agent-1",
					role: "product-requirements",
					modelPreset: "premium-planner",
					thinkingLevel: "xhigh",
					instructions:
						"You are a Product Requirements agent. In a bounded grill-me discussion with one other PR agent, ask at most one highest-value question per round with a recommended answer. Inspect the codebase before asking when possible. Update the shared PRD with resolved decisions and open questions. Do not produce implementation plans or code. Final output must include: PRD draft, resolved decisions, unresolved user questions, options, risks, ready_for_sprint: yes|no.",
				},
				{
					id: "pr-agent-2",
					role: "product-requirements",
					modelPreset: "premium-planner",
					thinkingLevel: "xhigh",
					instructions:
						"You are a Product Requirements agent. In a bounded grill-me discussion with one other PR agent, ask at most one highest-value question per round with a recommended answer. Inspect the codebase before asking when possible. Update the shared PRD with resolved decisions and open questions. Do not produce implementation plans or code. Final output must include: PRD draft, resolved decisions, unresolved user questions, options, risks, ready_for_sprint: yes|no.",
				},
			],
		},
		roles: [
			{ role: "brain", agent: "brain-default" },
			{ role: "coder", agent: "coder-default" },
			{ role: "reviewer", agent: "reviewer-default" },
		],
		references: {
			agentCatalog: "workflow.agent-catalog.json",
			modelPresets: "workflow.model-presets.json",
			toolProfiles: "workflow.tool-profiles.json",
			promptPacks: "workflow.prompt-packs.json",
			qualityGates: "workflow.quality-gates.json",
		},
	};
}

function managedAgentCatalog(): JsonObject {
	return {
		version: 2,
		agents: [
			{
				id: "brain-default",
				role: "brain",
				modelPreset: "premium-brain",
				toolProfile: "brain-room-only",
			},
			{
				id: "coder-default",
				role: "coder",
				modelPreset: "premium-coder",
				toolProfile: "coder-room-and-edit",
				qualityGates: ["gate-typescript-strict", "gate-git-diff-check"],
			},
			{
				id: "reviewer-default",
				role: "reviewer",
				modelPreset: "premium-reviewer",
				toolProfile: "reviewer-readonly",
				qualityGates: [
					"review-goal-behavior",
					"review-goal-evidence-test",
					"review-goal-implementation",
					"review-goal-maintainability",
					"review-goal-regression",
					"review-goal-docs-config",
				],
			},
		],
	};
}

function managedModelPresets(): JsonObject {
	return {
		version: 2,
		presets: [
			{ id: "premium-brain", provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" },
			{ id: "premium-coder", provider: "openai-codex", model: "gpt-5.3-codex", thinkingLevel: "medium" },
			{ id: "premium-reviewer", provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "high" },
			{ id: "premium-planner", provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" },
		],
	};
}

function managedToolProfiles(): JsonObject {
	return {
		version: 2,
		profiles: [
			{
				id: "brain-room-only",
				tools: ["read", "bash", "grep", "find", "ls", "room_create", "room_job_start", "room_send", "room_read", "room_job_done", "room_status", "workflow_deep_plan"],
			},
			{
				id: "coder-room-and-edit",
				tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "room_create", "room_job_start", "room_send", "room_read", "room_job_done", "room_status"],
				includeKarpathyGuidelines: true,
			},
			{
				id: "reviewer-readonly",
				tools: ["read", "bash", "grep", "find", "ls", "room_create", "room_job_start", "room_send", "room_read", "room_job_done", "room_status"],
			},
		],
	};
}

function managedPromptPacks(): JsonObject {
	return {
		version: 2,
		packs: [],
	};
}

function managedQualityGates(): JsonObject {
	return {
		version: 2,
		gates: [
			{ id: "gate-typescript-strict", kind: "checks", command: "npx --no-install tsc --noEmit", description: "Run TypeScript type checks before considering work complete." },
			{ id: "gate-git-diff-check", kind: "checks", command: "git diff --check", description: "Run git diff --check to avoid formatting and conflict-marker issues." },
			{ id: "review-goal-behavior", kind: "review-goal", description: "Behavior reviewer — validate that changed-code acceptance behavior is satisfied. For TUI / runtime behavior, require runnable behavior test, runtime gate, or observed tool output; reject source-string / static-only / read-the-source / skipped-running evidence." },
			{ id: "review-goal-evidence-test", kind: "review-goal", description: "Evidence/test-adequacy reviewer — validate that validation evidence is concrete and complete for each acceptance criterion. Reject prompt-only / instructions-only mitigations for runtime behavior." },
			{ id: "review-goal-implementation", kind: "review-goal", description: "Implementation reviewer — validate the implementation diff matches the Brain-authored contract/block plan, with correct boundaries, imports, and behavior." },
			{ id: "review-goal-maintainability", kind: "review-goal", description: "Maintainability/architecture reviewer — flag regressions in module ownership, coupling, runtime integration shape, and patterns introduced by implementation changes." },
			{ id: "review-goal-regression", kind: "review-goal", description: "Regression reviewer — verify the change does not regress existing behavior; require runnable regression evidence for runtime-behavior criteria." },
			{ id: "review-goal-docs-config", kind: "review-goal", description: "Docs/config reviewer (scoped) — validate README, docs/, examples/, and workflow config (workflow.json / workflow.quality-gates.json / settings.json) stay consistent with implementation. Active only when docs/config files are in the plan scope." },
		],
	};
}

type ManagedBootstrapFile = {
	filePath: string;
	payload: JsonObject;
	fileKind: "workflow" | "sidecar";
};

function managedPlanFiles(agentDir: string): ManagedBootstrapFile[] {
	return [
		{ filePath: path.join(agentDir, WORKFLOW_FILE), payload: toManaged(managedWorkflowBundle()), fileKind: "workflow" },
		{ filePath: path.join(agentDir, WORKFLOW_AGENT_CATALOG_FILE), payload: toManaged(managedAgentCatalog()), fileKind: "sidecar" },
		{ filePath: path.join(agentDir, WORKFLOW_MODEL_PRESETS_FILE), payload: toManaged(managedModelPresets()), fileKind: "sidecar" },
		{ filePath: path.join(agentDir, WORKFLOW_TOOL_PROFILES_FILE), payload: toManaged(managedToolProfiles()), fileKind: "sidecar" },
		{ filePath: path.join(agentDir, WORKFLOW_PROMPT_PACKS_FILE), payload: toManaged(managedPromptPacks()), fileKind: "sidecar" },
		{ filePath: path.join(agentDir, WORKFLOW_QUALITY_GATES_FILE), payload: toManaged(managedQualityGates()), fileKind: "sidecar" },
	];
}

function writeManagedSidecar(filePath: string, payload: JsonObject, diagnostics: ManagedBootstrapDiagnostic[], written: string[]): void {
	if (!fs.existsSync(filePath)) {
		writeJson(filePath, payload);
		written.push(filePath);
		return;
	}
	const existing = readJson(filePath);
	if (!existing) {
		diagnostics.push({
			code: "bootstrap-preserve-unreadable",
			message: `Preserving unreadable sidecar ${path.basename(filePath)}; using existing contents to avoid overwrite.`,
		});
		return;
	}
	if (!isManagedConfig(existing)) {
		diagnostics.push({
			code: "bootstrap-preserve-custom",
			message: `Preserving custom sidecar ${path.basename(filePath)}; using existing contents to avoid overwrite.`,
		});
		return;
	}
	writeJson(filePath, payload);
	written.push(filePath);
}

function writeManagedBundle(agentDir: string, diagnostics: ManagedBootstrapDiagnostic[]): Array<string> {
	const written: string[] = [];
	for (const { filePath, payload, fileKind } of managedPlanFiles(agentDir)) {
		if (fileKind === "workflow") {
			writeJson(filePath, payload);
			written.push(filePath);
			continue;
		}
		writeManagedSidecar(filePath, payload, diagnostics, written);
	}
	return written;
}

export function inspectGlobalWorkflowState(agentDir?: string): {
	state: "missing" | "managed" | "legacy" | "custom" | "unreadable";
	workflowPath: string;
	parsed: JsonObject | null;
} {
	const homeDir = agentDir ?? getAgentDir();
	const workflowPath = path.join(homeDir, WORKFLOW_FILE);
	const parsed = readJson(workflowPath);
	if (!parsed) {
		return {
			state: fs.existsSync(workflowPath) ? "unreadable" : "missing",
			workflowPath,
			parsed: null,
		};
	}
	if (isManagedConfig(parsed)) return { state: "managed", workflowPath, parsed };
	if (isLegacyDefaultV1Config(parsed)) return { state: "legacy", workflowPath, parsed };
	return { state: "custom", workflowPath, parsed };
}

export function ensureManagedGlobalWorkflow(agentDir?: string): BootstrapResult {
	const homeDir = agentDir ?? getAgentDir();
	const { state, workflowPath } = inspectGlobalWorkflowState(homeDir);
	const diagnostics: ManagedBootstrapDiagnostic[] = [];
	const written: string[] = [];
	const result: BootstrapResult = {
		action: "noop",
		diagnostics,
		written,
		agentDir: homeDir,
		status: "",
	};

	if (state === "missing") {
		const files = writeManagedBundle(homeDir, diagnostics);
		written.push(...files);
		result.action = "created";
		result.status = "No global workflow.json exists; created managed v2 defaults.";
		diagnostics.push({ code: "bootstrap-create", message: result.status });
		return result;
	}

	if (state === "managed") {
		const files = writeManagedBundle(homeDir, diagnostics);
		written.push(...files);
		result.action = "updated";
		result.status = "Existing managed workflow detected; refreshed managed workflow bundle.";
		diagnostics.push({ code: "bootstrap-refresh", message: result.status });
		return result;
	}

	if (state === "legacy") {
		const backupPath = backupFile(workflowPath);
		result.backupPath = backupPath;
		const files = writeManagedBundle(homeDir, diagnostics);
		written.push(...files);
		result.action = "replaced";
		result.status = "Legacy package-default global workflow replaced with managed v2 defaults.";
		diagnostics.push({ code: "bootstrap-replace-legacy", message: `Backed up workflow.json to ${path.basename(backupPath)} and replaced with managed bundle.` });
		return result;
	}

	if (state === "unreadable") {
		result.action = "preserved";
		result.status = "Existing global workflow is unreadable; preserving user override to avoid data loss.";
		diagnostics.push({ code: "bootstrap-preserve-unreadable", message: "Global workflow.json could not be parsed as JSON; bootstrap did not mutate files." });
		return result;
	}

	result.action = "preserved";
	result.status = "Existing global workflow appears custom; preserving user override.";
	diagnostics.push({ code: "bootstrap-preserve-custom", message: "Custom global workflow override preserved; bootstrap did not mutate files." });
	return result;
}

export function shouldCreateOrRefreshManagedWorkflow(agentDir?: string): boolean {
	const { state } = inspectGlobalWorkflowState(agentDir);
	return state !== "custom" && state !== "unreadable";
}
