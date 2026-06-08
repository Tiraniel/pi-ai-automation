// Workflow delegate room subsystem and delegate runtime extracted to
// ./workflow/rooms (TASK-018 Slice 1), ./workflow/runtime/config
// (TASK-018 Slice 2), and ./workflow/delegate (TASK-018 Slice 3).
// brain-workflow.ts is the thin composition root: provider/flag/room
// registration, the /workflow status command, and the lifecycle hooks
// (tool_result, session_start, before_agent_start). All delegate
// implementation lives under ./workflow/delegate.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	GONKA_BROKER_API_KEY_ENV,
	GONKA_BROKER_URL_ENV,
	GONKA_HYBRID_PROFILE_ID,
	GONKA_MODELS,
	GONKA_PROVIDER_NAME,
	getGonkaBrokerUrl,
	getGonkaEnvStatus,
} from "./workflow/profiles";
import { registerRoomTools } from "./workflow/rooms";
import {
	applyBrainPreset,
	formatPreset,
	getAgentPreset,
	getWorkflowProfile,
	loadGonkaEnvFromDefaultDotenv,
	loadWorkflowConfig,
} from "./workflow/runtime/config";
import {
	getWorkflowStatusLabel,
	setWorkflowStatusFromConfig,
	showWorkflowConfigure,
} from "./workflow/configure";
import {
	DELEGATE_DISPLAY_ENV,
	getDelegateFailureReason,
	isCmuxAvailable,
	registerDelegateDoneTools,
	registerDelegateTools,
	resolveDelegateDisplayMode,
	resolveReviewerSwarmConfig,
} from "./workflow/delegate";
import { registerArchitectureTools } from "./workflow/architecture";
import { registerDeepPlanningTool } from "./workflow/deep-planning";
import {
	ensureManagedGlobalWorkflow,
	inspectGlobalWorkflowState,
} from "./workflow/runtime/bootstrap";

export default function brainWorkflow(pi: ExtensionAPI) {
	loadGonkaEnvFromDefaultDotenv();

	if (process.env.PI_WORKFLOW_CHILD !== "1") {
		try {
			ensureManagedGlobalWorkflow();
		} catch {
			// bootstrap is best effort at startup
		}
	}

	pi.registerFlag("workflow-agent", {
		description: "Workflow agent for this process: brain or none",
		type: "string",
	});
	pi.registerFlag("workflow-profile", {
		description: `Opt-in workflow profile: default or ${GONKA_HYBRID_PROFILE_ID}`,
		type: "string",
	});

	// Register the Gonka provider unconditionally so it is always available,
	// but do not point any agent at it by default. Defaults stay premium.
	pi.registerProvider(GONKA_PROVIDER_NAME, {
		name: "Gonka",
		baseUrl: getGonkaBrokerUrl(),
		apiKey: `$${GONKA_BROKER_API_KEY_ENV}`,
		api: "openai-completions",
		models: GONKA_MODELS,
	});

	registerDelegateTools(pi);
	registerRoomTools(pi);
	registerDelegateDoneTools(pi);
	registerArchitectureTools(pi);
	registerDeepPlanningTool(pi);

	pi.registerCommand("workflow", {
		description: "Show effective brain/coder/reviewer workflow presets",
		handler: async (rawArgs, ctx) => {
			const args = Array.isArray(rawArgs)
				? rawArgs.map((value) => String(value).trim()).filter(Boolean)
				: typeof rawArgs === "string"
					? rawArgs.trim().split(/\s+/).filter(Boolean)
					: [];
			const subcommand = args[0]?.trim().toLowerCase();
			const cliProfile = pi.getFlag("workflow-profile") as string | undefined;

			if (subcommand === "configure" || subcommand === "config") {
				await showWorkflowConfigure(ctx);
				const updated = loadWorkflowConfig(ctx.cwd, { cliProfile });
				setWorkflowStatusFromConfig(ctx, updated);
				return;
			}

			if (subcommand) {
				ctx.ui.notify("Usage: /workflow | /workflow configure", "info");
				return;
			}

			const loaded = loadWorkflowConfig(ctx.cwd, { cliProfile });
			const reviewerSwarm = resolveReviewerSwarmConfig(loaded.config);
			const profile = getWorkflowProfile(loaded.profileId);
			const gonkaEnv = getGonkaEnvStatus();
			const delegateMode = resolveDelegateDisplayMode(loaded.config);
			const cmuxAvailable = isCmuxAvailable();
			const globalWorkflowState = inspectGlobalWorkflowState();
			const configDiagnostics = loaded.configDiagnostics ?? [];
			const errorCount = configDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
			const warningCount = configDiagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
			const sourceLines = loaded.sources.map((source) => {
				const managed = [
					source.managedBy ? `managedBy=${source.managedBy}` : undefined,
					source.managedVersion ? `managedVersion=${source.managedVersion}` : undefined,
				];
				const parts = [
					`scope=${source.scope}`,
					`format=${source.format}`,
					`version=${source.version ?? "1"}`,
					`selected=${source.selected ? "yes" : "no"}`,
					`path=${source.path}`,
					...managed.filter(Boolean),
				];
				return `- ${parts.join(" ")}`;
			});
			const diagnosticPreview = configDiagnostics
				.slice(0, 5)
				.map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`);
			const deepPlanning = loaded.config.deepPlanning ?? {};
			const plannerLabels =
				(deepPlanning.planners ?? []).map((planner, index) => `${planner.id ?? `planner-${index + 1}`}: ${planner.role ?? `planner-${index + 1}`}`).join(" | ") || "(none)";
			const lines = [
				"Pi workflow status",
				`workflow label: ${getWorkflowStatusLabel(loaded)}`,
				`global: ${loaded.globalPath}`,
				`global preset source: ${globalWorkflowState.state}`,
				`project override: ${loaded.projectPath ?? "(none)"}`,
				`project local override: ${loaded.projectOverridePath ?? "(none)"}`,
				`config diagnostics: errors=${errorCount} warnings=${warningCount}`,
				"",
				"loaded.sources:",
				...sourceLines,
				"",
				`profile: ${loaded.profileId} source=${loaded.profileSource} (${profile.label})`,
				`gonka: provider=${GONKA_PROVIDER_NAME} ${GONKA_BROKER_URL_ENV}=${gonkaEnv.url} ${GONKA_BROKER_API_KEY_ENV}=${gonkaEnv.apiKey}`,
				"",
				`config diagnostics (${configDiagnostics.length}):`,
				...diagnosticPreview.map((diagnostic) => `- ${diagnostic}`),
				"",
				formatPreset("brain", getAgentPreset(loaded.config, "brain")),
				formatPreset("coder", getAgentPreset(loaded.config, "coder")),
				formatPreset("reviewer", getAgentPreset(loaded.config, "reviewer")),
				`reviewerSwarm: enabled=${reviewerSwarm.enabled} maxConcurrency=${reviewerSwarm.maxConcurrency}`,
				`reviewerSwarm targets: ${reviewerSwarm.targets.join(" | ")}`,
				`deepPlanning: enabled=${deepPlanning.enabled === true ? "true" : "false"} plannerCount=${deepPlanning.plannerCount ?? 0} rounds=${deepPlanning.rounds ?? 0} maxConcurrency=${deepPlanning.maxConcurrency ?? 0} roomIdPrefix=${deepPlanning.roomIdPrefix ?? "(none)"}`,
				`deepPlanning planners: ${plannerLabels}`,
				"",
				`delegateDisplay: ${delegateMode}${delegateMode !== "headless" ? ` (cmux=${cmuxAvailable ? "available" : "unavailable"})` : ""}`,
				`delegatePaneAutoClose: ${loaded.config.delegatePaneAutoClose !== false ? "true (default)" : "false"}`,
				`env override: ${DELEGATE_DISPLAY_ENV}=${process.env[DELEGATE_DISPLAY_ENV] ?? "(not set)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("tool_result", async (event) => {
		const raw = event as any;
		const toolName = String(raw.toolName ?? "");
		if (toolName !== "delegate_to_coder" && toolName !== "delegate_to_reviewer") return;
		const failure = getDelegateFailureReason(toolName, { details: raw.details });
		if (!failure || raw.isError === true) return;
		return { isError: true };
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("workflow-agent") === "none") return;
		await applyBrainPreset(pi, ctx);

		const cliProfile = pi.getFlag("workflow-profile") as string | undefined;
		const loaded = loadWorkflowConfig(ctx.cwd, { cliProfile });
		setWorkflowStatusFromConfig(ctx, loaded);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (process.env.PI_WORKFLOW_CHILD === "1") return;
		if (pi.getFlag("workflow-agent") === "none") return;

		const cliProfile = pi.getFlag("workflow-profile") as string | undefined;
		const loaded = loadWorkflowConfig(ctx.cwd, { cliProfile });
		const brain = getAgentPreset(loaded.config, "brain");
		if (!brain.instructions?.trim()) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${brain.instructions.trim()}`,
		};
	});
}
