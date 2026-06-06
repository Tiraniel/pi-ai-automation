// Workflow delegate runtime — shared constants.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
// All numeric/limit values used by the delegate subsystem (stderr cap,
// progress truncation, pane poll/wait timings, env-var names) live here so
// callers can audit the budget in one place.

export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_PROGRESS_ITEMS = 80;
export const MAX_PROGRESS_TEXT = 240;
export const MAX_RENDERED_PROGRESS = 14;
export const MAX_TASK_PREVIEW = 140;
export const MAX_FINAL_OUTPUT_PREVIEW = 500;
export const MAX_TOOL_UPDATE_PREVIEW = 180;

export const DELEGATE_DISPLAY_ENV = "PI_WORKFLOW_DELEGATE_DISPLAY";
export const SUB_AGENT_DONE_TOOL_NAME = "sub_agent_done";
export const DELEGATE_DONE_TOOL_NAME = "workflow_delegate_done";
export const DELEGATE_DONE_ENV_VAR = "PI_WORKFLOW_DELEGATE_DONE_FILE";
export const DELEGATE_PANE_POLL_MS = 600;
export const DELEGATE_PANE_MAX_WAIT_MS = 600000;
