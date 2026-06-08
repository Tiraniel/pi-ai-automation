// Workflow delegate runtime — top-level mode dispatcher for child Pi runs.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// `runDelegateAgent` is the single entry point used by the delegate tools
// and the reviewer swarm. It reads the workflow config to pick a transport
// (`headless` vs `pane`) and dispatches to the corresponding module. The
// actual transport implementations live in `./headless` and `./pane`; the
// shared event-state accumulator and parsers live in `./state`.

import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentName, AgentPreset, DelegateAgentName, DelegateRunResult } from "../types";
import type { ResolvedRoomContext } from "../rooms";
import { loadWorkflowConfig } from "../runtime/config";
import { resolveDelegateDisplayMode } from "./cmux";
import { runDelegateAgentHeadless } from "./headless";
import { runDelegateAgentPane } from "./pane";
import { makeDelegateGuardFailure, resolveDelegatePresetWithFallback } from "./model-guard";

// Re-exports for callers that need the lower-level surface (tests, future
// tooling, the legacy `makeDelegateTool` shape). All named exports below
// come from the split modules; this file is intentionally tiny.
export {
	processEventLine,
	processSessionLine,
	createDelegateEventState,
	type DelegateEventState,
} from "./state";

export { runDelegateAgentHeadless } from "./headless";
export { runDelegateAgentPane } from "./pane";

export async function runDelegateAgent(
	ctx: ExtensionContext,
	agent: AgentName,
	task: string,
	requestedCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	roomContext?: ResolvedRoomContext,
	presetOverride?: AgentPreset,
): Promise<DelegateRunResult> {
	if (presetOverride) {
		const loaded = loadWorkflowConfig(ctx.cwd);
		const mode = resolveDelegateDisplayMode(loaded.config);
		if (mode === "pane") {
			return runDelegateAgentPane(ctx, agent, task, requestedCwd, signal, onUpdate, roomContext, presetOverride);
		}
		return runDelegateAgentHeadless(ctx, agent, task, requestedCwd, signal, onUpdate, roomContext, presetOverride);
	}

	const loaded = loadWorkflowConfig(ctx.cwd);
	const guard = resolveDelegatePresetWithFallback(ctx, loaded.config, agent as DelegateAgentName);
	const cwd = requestedCwd ? path.resolve(ctx.cwd, requestedCwd) : ctx.cwd;
	if (!guard.ok) {
		if (typeof (ctx as any).ui?.notify === "function") {
			(ctx as any).ui.notify(guard.message, "warning");
		}
		return makeDelegateGuardFailure(agent as DelegateAgentName, task, cwd, guard.message);
	}
	if (guard.warning && typeof (ctx as any).ui?.notify === "function") {
		(ctx as any).ui.notify(guard.warning, "warning");
	}

	const mode = resolveDelegateDisplayMode(loaded.config);
	if (mode === "pane") {
		return runDelegateAgentPane(ctx, agent, task, requestedCwd, signal, onUpdate, roomContext, guard.preset);
	}
	return runDelegateAgentHeadless(ctx, agent, task, requestedCwd, signal, onUpdate, roomContext, guard.preset);
}
