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
	if (!arraysEqual(reviewerSwarm.targets, DEFAULT_REVIEW_TARGETS)) return false;
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
				qualityGates: ["review-goal-architecture", "review-goal-correctness", "review-goal-tests", "review-goal-security"],
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
		],
	};
}

function managedToolProfiles(): JsonObject {
	return {
		version: 2,
		profiles: [
			{
				id: "brain-room-only",
				tools: ["read", "bash", "grep", "find", "ls", "room_create", "room_job_start", "room_send", "room_read", "room_job_done", "room_status"],
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
			{ id: "review-goal-architecture", kind: "review-goal", description: "Architecture and coupling review goal." },
			{ id: "review-goal-correctness", kind: "review-goal", description: "Functional correctness and regression risk review goal." },
			{ id: "review-goal-tests", kind: "review-goal", description: "Validation and evidence completeness review goal." },
			{ id: "review-goal-security", kind: "review-goal", description: "Security, safety, and concurrency review goal." },
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
