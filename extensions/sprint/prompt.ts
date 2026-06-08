// Sprint subsystem — prompt text builders for session binding and global pointer.
// Extracted from extensions/sprint-system.ts as part of TASK-018 Slice 4.
//
// These prompt builders are the strings the before_agent_start hook
// injects into the system prompt (or the user message, for auto-run kickoff).
// Keeping them here means the hook body in ./hooks.ts is just branching +
// orchestration, and the strings can be reviewed/edited in one place.
//
// Each builder accepts an optional `BrainMarkers` view; when present and
// non-empty, the formatted marker block is appended so Brain sees the
// task's parallel/room/agent/contract hints directly in the prompt.

import { formatBrainMarkersForPrompt, type BrainMarkers } from "./markers";
import type { SessionBinding, SprintCurrent } from "./types";

function markersBlock(markers: BrainMarkers | null | undefined): string {
	if (!markers || !markers.hasMarkers) return "";
	return `\n${formatBrainMarkersForPrompt(markers)}`;
}

export function sessionBindingPromptText(binding: SessionBinding, markers?: BrainMarkers | null): string {
	return [
		"Sprint task session bound.",
		`Bound task: ${binding.taskId} - ${binding.title}`,
		`Sprint path: ${binding.sprintPath}`,
		`Task path: ${binding.taskPath}`,
		"",
		"This Pi session is dedicated to a single sprint task. Do NOT switch to a different task or sprint in this session, even if .sprints/current.json is later modified by other sessions or commands.",
		"Work this task using the brain -> coder -> reviewer workflow: delegate implementation to coder and verification to reviewer.",
		"For non-trivial work, begin with PRD/Product Requirements intake before sprint/task creation or implementation. Planning-stage approval does NOT authorize implementation; sprint creation and implementation/delegation each require separate explicit user confirmations.",
		"Brain owns task understanding, sprint/task authoring, architecture decisions, and phase planning; coder receives and implements Brain-authored plans only.",
		"Guardrail: when delegate_to_coder fails or reviewer returns CHANGES_REQUESTED, do NOT take over code edits/fixes yourself with the premium model. Re-delegate a focused fix back to coder (or a room worker) and then re-review. You may do read-only diagnosis/planning/admin only, and direct edits are limited to tiny non-code/admin cases.",
		"Keep the task file and PROGRESS.md updated with sprint_update_task and sprint_log_progress as you work.",
		markersBlock(markers),
	].filter(Boolean).join("\n");
}

export function buildTaskSessionKickoff(binding: SessionBinding, autoRun: boolean, markers?: BrainMarkers | null): string {
	if (!autoRun) return "";
	return [
		`This Pi session is bound to task ${binding.taskId}: ${binding.title}.`,
		`Sprint path: ${binding.sprintPath}`,
		`Task path: ${binding.taskPath}`,
		"",
		"Read the sprint and task context with sprint_read_context, then implement this task using the brain -> coder -> reviewer workflow:",
		"1. For non-trivial work, begin with PRD/Product Requirements intake before sprint/task creation or implementation. Planning-stage approval does NOT authorize implementation; sprint creation and implementation/delegation each require separate explicit user confirmations.",
		"2. Inspect enough context and author this task's Brain-owned blueprint before delegating.",
		"3. Delegate implementation to coder with delegate_to_coder. Give coder a self-contained task with relevant files, constraints, and expected checks.",
		"Coder must not author task understanding, planning, sprint/task authoring, architecture planning, contract/block planning, or phase planning; coder implements only the Brain-authored plan.",
		"4. Delegate independent verification to reviewer with delegate_to_reviewer. Use goals mapped to the task's acceptance criteria.",
		"5. If reviewer requests changes, send focused fixes back to coder, then re-review.",
		"6. When the task is complete, mark it done with sprint_update_task and append a final progress note with sprint_log_progress.",
		"",
		"Guardrail: when delegate_to_coder fails or reviewer returns CHANGES_REQUESTED, do NOT take over code edits/fixes yourself with the premium model. Re-delegate a focused fix back to coder (or a room worker) and then re-review. You may do read-only diagnosis/planning/admin only, and direct edits are limited to tiny non-code/admin cases.",
		"",
		"Multi-agent execution: when the task splits into independent workstreams, Brain MUST create a workflow room (room_create) before delegating, and pass `room: { roomId, ... }` on delegate_to_coder / delegate_to_reviewer so workers receive the workflow-room context. Use room_send for cross-agent contracts and room_read at job boundaries.",
		markersBlock(markers),
		"",
		"Do NOT switch to a different task or sprint in this session.",
	].filter(Boolean).join("\n");
}

export function sprintPointerText(current: SprintCurrent, markers?: BrainMarkers | null): string {
	return [
		"Sprint system active.",
		`Active sprint path: ${current.activeSprintPath}`,
		`Active task path: ${current.activeTaskPath ?? "(none)"}`,
		"Before non-trivial implementation, read sprint/task context. Keep PROGRESS/task evidence updated.",
		"For non-trivial work, begin with PRD/Product Requirements intake before sprint/task creation or implementation. Planning-stage approval does NOT authorize implementation; sprint creation and implementation/delegation each require separate explicit user confirmations.",
		"For tiny debug/hotfix work (few-line fixes, typo/quick-fix corrections, tiny changes), use /sprint debug or sprint_debug instead of starting a full sprint task flow.",
		"For concrete, multi-step implementation, use normal .sprints task/session flow; one dedicated session is still required for that path.",
		"Brain retains planning ownership for sprint/task architecture and authoring; coder does not perform plan/sprint/architecture authoring.",
		markersBlock(markers),
	].filter(Boolean).join("\n");
}

export function debugLaneGuidanceText(): string {
	return [
		"Tiny debug/hotfix work can be tracked without opening a dedicated sprint task session:",
		"- Use `/sprint debug add <title>` or `sprint_debug` with `action: add` for minimal findings.",
		"- Append evidence with `note` or `done` as needed while investigating.",
		"- Promote to a normal sprint task when scope grows using `promote`, then continue in the regular sprint workflow.",
	].filter(Boolean).join("\n");
}
