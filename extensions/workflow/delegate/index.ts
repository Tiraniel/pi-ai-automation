// Workflow delegate runtime — public barrel.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// See ./constants.ts for numeric/env-var limits, ./messages.ts for the
// pure message/progress helpers, ./cmux.ts for the cmux pane transport and
// display-mode resolver, ./child.ts for the child Pi invocation helpers,
// ./state.ts for the streaming event-state accumulator and parsers,
// ./headless.ts and ./pane.ts for the two transports, ./runner.ts for the
// mode dispatcher, ./swarm.ts for the reviewer swarm, ./tools.ts for the
// delegate_to_coder / delegate_to_reviewer tool registration, and
// ./done-tools.ts for the child-only completion tools.

export {
	DELEGATE_DISPLAY_ENV,
	DELEGATE_DONE_ENV_VAR,
	DELEGATE_DONE_TOOL_NAME,
	SUB_AGENT_DONE_TOOL_NAME,
} from "./constants";

export { getDelegateFailureReason } from "./messages";

export { isCmuxAvailable, resolveDelegateDisplayMode } from "./cmux";

export { resolveReviewerSwarmConfig } from "./swarm";

export { registerDelegateTools } from "./tools";
export { registerDelegateDoneTools } from "./done-tools";
