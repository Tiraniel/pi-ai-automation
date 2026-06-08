import type { DoneSidecar } from "./pane-status";
import type { DelegateCompletionSource } from "../types";
import { SUB_AGENT_DONE_TOOL_NAME } from "./constants";

export interface PaneCompletionOutcome {
	exitCode: number;
	finalOutput: string;
	stderr: string;
	status: "completed" | "failed";
	warning?: string;
	completionSource?: DelegateCompletionSource;
}

const BAD_STOP_REASONS = new Set(["aborted", "interrupted", "cancelled", "canceled", "error"]);

function trimText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim();
}

function makeMissingCompletionDiagnostic(toolName: string): string {
	return `\npane delegate did not provide a completion sidecar. The child MUST call ${toolName} as its final action to return control to Brain.`;
}

function makeFromExitDiagnostic(toolName: string, sidecarExitCode: number | undefined): string {
	return `\npane delegate exited without calling ${toolName}${
		sidecarExitCode === undefined ? "" : ` (exit ${sidecarExitCode})`
	}. The child MUST call ${toolName} as its final action to return control to Brain.`;
}

function isBadAutoStopReason(stopReason: string | undefined): boolean {
	if (!stopReason) return false;
	return BAD_STOP_REASONS.has(stopReason.toLowerCase());
}

function resolveCompletionSource(doneSidecar: DoneSidecar): DelegateCompletionSource {
	if (doneSidecar.completion === "explicit") return "explicit";
	if (doneSidecar.completion === "auto_exit") return "auto_exit";
	if (doneSidecar.completion === "process_exit") return "process_exit";
	if (doneSidecar.from_exit === true) return "process_exit";
	return "explicit";
}

export function resolvePaneCompletionOutcome(
	doneSidecar: DoneSidecar | undefined,
	finalAssistantText: string,
	defaultToolName: string = SUB_AGENT_DONE_TOOL_NAME,
): PaneCompletionOutcome {
	const toolName = trimText(doneSidecar?.tool) || defaultToolName;
	if (!doneSidecar || doneSidecar.done !== true) {
		return {
			exitCode: 1,
			finalOutput: "",
			stderr: makeMissingCompletionDiagnostic(toolName),
			status: "failed",
			completionSource: "missing",
		};
	}

	const completionSource = resolveCompletionSource(doneSidecar);
	const stopReason = trimText(doneSidecar.stop_reason);
	const fromExit = doneSidecar.from_exit === true || completionSource === "process_exit";
	if (fromExit) {
		const sidecarExitCode =
			typeof doneSidecar.exit_code === "number" ? doneSidecar.exit_code : undefined;
		return {
			exitCode: sidecarExitCode || 1,
			finalOutput: "",
			stderr: makeFromExitDiagnostic(toolName, sidecarExitCode),
			status: "failed",
			completionSource,
		};
	}

	const normalizedAssistantText = trimText(finalAssistantText);
	if (completionSource === "auto_exit") {
		if (isBadAutoStopReason(stopReason)) {
			return {
				exitCode: 1,
				finalOutput: "",
				stderr: `\npane delegate auto-exit fallback did not treat completion as normal. stop_reason=${stopReason || "unknown"}.`,
				status: "failed",
				warning: doneSidecar.warning,
				completionSource,
			};
		}
		if (!normalizedAssistantText) {
			return {
				exitCode: 1,
				finalOutput: "",
				stderr: "\npane delegate auto-exit fallback did not find final assistant output.",
				status: "failed",
				warning: doneSidecar.warning,
				completionSource,
			};
		}
		return {
			exitCode: typeof doneSidecar.exit_code === "number" ? doneSidecar.exit_code : 0,
			finalOutput: finalAssistantText,
			stderr: "",
			status: "completed",
			warning: doneSidecar.warning,
			completionSource,
		};
	}

	const resolvedExitCode =
		typeof doneSidecar.exit_code === "number" ? doneSidecar.exit_code : 0;
	const finalSummary = trimText(doneSidecar.summary);
	const finalOutput =
		normalizedAssistantText || finalSummary || `Pane delegate signaled completion via ${toolName}.`;

	return {
		exitCode: resolvedExitCode,
		finalOutput,
		stderr: "",
		status: "completed",
		warning: doneSidecar.warning,
		completionSource,
	};
}
