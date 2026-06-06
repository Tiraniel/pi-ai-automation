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
	DELEGATE_DISPLAY_ENV,
	getDelegateFailureReason,
	isCmuxAvailable,
	registerDelegateDoneTools,
	registerDelegateTools,
	resolveDelegateDisplayMode,
	resolveReviewerSwarmConfig,
} from "./workflow/delegate";

export default function brainWorkflow(pi: ExtensionAPI) {
	loadGonkaEnvFromDefaultDotenv();

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

	pi.registerCommand("workflow", {
		description: "Show effective brain/coder/reviewer workflow presets",
		handler: async (_args, ctx) => {
			const loaded = loadWorkflowConfig(ctx.cwd, { cliProfile: pi.getFlag("workflow-profile") as string | undefined });
			const reviewerSwarm = resolveReviewerSwarmConfig(loaded.config);
			const profile = getWorkflowProfile(loaded.profileId);
			const gonkaEnv = getGonkaEnvStatus();
			const delegateMode = resolveDelegateDisplayMode(loaded.config);
			const cmuxAvailable = isCmuxAvailable();
			const lines = [
				"Pi workflow: brain -> coder -> reviewer",
				`global: ${loaded.globalPath}`,
				`project override: ${loaded.projectPath ?? "(none)"}`,
				"",
				`profile: ${loaded.profileId} source=${loaded.profileSource} (${profile.label})`,
				`gonka: provider=${GONKA_PROVIDER_NAME} ${GONKA_BROKER_URL_ENV}=${gonkaEnv.url} ${GONKA_BROKER_API_KEY_ENV}=${gonkaEnv.apiKey}`,
				"",
				formatPreset("brain", getAgentPreset(loaded.config, "brain")),
				formatPreset("coder", getAgentPreset(loaded.config, "coder")),
				formatPreset("reviewer", getAgentPreset(loaded.config, "reviewer")),
				`reviewerSwarm: enabled=${reviewerSwarm.enabled} maxConcurrency=${reviewerSwarm.maxConcurrency}`,
				`reviewerSwarm targets: ${reviewerSwarm.targets.join(" | ")}`,
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
