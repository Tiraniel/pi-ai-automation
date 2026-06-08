import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentPreset, DelegateAgentName, WorkflowConfig } from "../types";
import { getAgentPreset, resolveModelLabel } from "../runtime/config";
import type { DelegateRunResult } from "../types";

export type DelegatePresetResolution =
	| { ok: true; preset: AgentPreset; usedFallback: boolean; warning?: string }
	| { ok: false; preset: AgentPreset; message: string };

function isPresetModelAvailable(
	ctx: ExtensionContext,
	preset: AgentPreset,
): { available: true } | { available: false; reason: string } {
	const provider = preset.provider;
	const model = preset.model;
	if (!provider || !model) {
		return { available: true };
	}
	const registry = (ctx as any).modelRegistry;
	if (!registry || typeof registry.find !== "function") {
		return { available: false, reason: "model registry unavailable" };
	}
	try {
		const found = registry.find(provider, model);
		if (found) {
			return { available: true };
		}
		return { available: false, reason: `model not found: ${provider}/${model}` };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { available: false, reason: `registry error: ${msg}` };
	}
}

export function resolveDelegatePresetWithFallback(
	ctx: ExtensionContext,
	config: WorkflowConfig,
	agent: DelegateAgentName,
): DelegatePresetResolution {
	const primary = getAgentPreset(config, agent);
	const primaryLabel = resolveModelLabel(primary);
	const primaryCheck = isPresetModelAvailable(ctx, primary);
	if (primaryCheck.available) {
		return { ok: true, preset: primary, usedFallback: false };
	}

	const fallback = config.delegateFallbacks?.[agent];
	if (fallback && fallback.provider && fallback.model) {
		const merged: AgentPreset = {
			...primary,
			provider: fallback.provider,
			model: fallback.model,
			thinkingLevel: fallback.thinkingLevel ?? primary.thinkingLevel,
		};
		const fallbackCheck = isPresetModelAvailable(ctx, merged);
		if (fallbackCheck.available) {
			return {
				ok: true,
				preset: merged,
				usedFallback: true,
				warning: `[${agent}] primary model ${primaryLabel} is unavailable (${primaryCheck.reason}); using fallback ${resolveModelLabel(merged)}.`,
			};
		}
		return {
			ok: false,
			preset: primary,
			message: `[${agent}] primary model ${primaryLabel} is unavailable (${primaryCheck.reason}); fallback ${resolveModelLabel(merged)} is also unavailable (${fallbackCheck.reason}). Configure a different fallback via /workflow_cfg.`,
		};
	}

	return {
		ok: false,
		preset: primary,
		message: `[${agent}] primary model ${primaryLabel} is unavailable (${primaryCheck.reason}). No fallback configured. Configure one via /workflow_cfg.`,
	};
}

export function makeDelegateGuardFailure(
	agent: DelegateAgentName,
	task: string,
	cwd: string,
	message: string,
): DelegateRunResult {
	return {
		agent,
		task,
		cwd,
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		status: "failed",
		errorMessage: message,
		finalOutput: message,
		progress: [{ at: Date.now(), type: "error" as const, text: message }],
	};
}
