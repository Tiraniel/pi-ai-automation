// Workflow delegate runtime — top-level mode dispatcher for child Pi runs.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// `runDelegateAgent` is the single entry point used by the delegate tools
// and the reviewer swarm. It reads the workflow config to pick a transport
// (`headless` vs `pane`) and dispatches to the corresponding module. The
// actual transport implementations live in `./headless` and `./pane`; the
// shared event-state accumulator and parsers live in `./state`.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentName, DelegateRunResult } from "../types";
import type { ResolvedRoomContext } from "../rooms";
import { loadWorkflowConfig } from "../runtime/config";
import { resolveDelegateDisplayMode } from "./cmux";
import { runDelegateAgentHeadless } from "./headless";
import { runDelegateAgentPane } from "./pane";

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
): Promise<DelegateRunResult> {
	const loaded = loadWorkflowConfig(ctx.cwd);
	const mode = resolveDelegateDisplayMode(loaded.config);
	if (mode === "pane") {
		return runDelegateAgentPane(ctx, agent, task, requestedCwd, signal, onUpdate, roomContext);
	}
	return runDelegateAgentHeadless(ctx, agent, task, requestedCwd, signal, onUpdate, roomContext);
}
