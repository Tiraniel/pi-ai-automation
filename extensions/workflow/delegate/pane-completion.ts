import type { DoneSidecar } from "./pane-status";
import { SUB_AGENT_DONE_TOOL_NAME } from "./constants";

export interface PaneCompletionOutcome {
	exitCode: number;
	finalOutput: string;
	stderr: string;
	status: "completed" | "failed";
}

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
		};
	}

	const fromExit = doneSidecar.from_exit === true;
	if (fromExit) {
		const sidecarExitCode =
			typeof doneSidecar.exit_code === "number" ? doneSidecar.exit_code : undefined;
		return {
			exitCode: sidecarExitCode || 1,
			finalOutput: "",
			stderr: makeFromExitDiagnostic(toolName, sidecarExitCode),
			status: "failed",
		};
	}

	const resolvedExitCode =
		typeof doneSidecar.exit_code === "number" ? doneSidecar.exit_code : 0;
	const finalSummary = trimText(doneSidecar.summary);
	const normalizedAssistantText = trimText(finalAssistantText);
	const finalOutput =
		normalizedAssistantText || finalSummary || `Pane delegate signaled completion via ${toolName}.`;

	return {
		exitCode: resolvedExitCode,
		finalOutput,
		stderr: "",
		status: "completed",
	};
}
