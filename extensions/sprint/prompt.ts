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
import type { AutomationLane, HotfixKind } from "./lane-policy";
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
		"PRD-first planning gates, role ownership, and the delegation guardrail from your core workflow instructions apply to this task.",
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
		"1. For non-trivial work, run PRD/Product Requirements intake first (the PRD-first planning rules from your core workflow instructions apply).",
		"2. Inspect enough context and author this task's Brain-owned blueprint before delegating.",
		"3. Delegate implementation to coder with delegate_to_coder. Give coder a self-contained task with relevant files, constraints, and expected checks.",
		"4. Delegate independent verification to reviewer with delegate_to_reviewer.",
		"5. If reviewer requests changes, send focused fixes back to coder, then re-review (the delegation guardrail applies: never take over edits yourself).",
		"6. When the task is complete, mark it done with sprint_update_task and append a final progress note with sprint_log_progress.",
		"",
		"Multi-agent execution: when the task splits into independent workstreams, follow the workflow-rooms rules from your core instructions (room_create first, pass `room: { roomId, ... }` on delegates, room_send for contracts).",
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
		"PRD-first planning gates and role ownership from your core workflow instructions apply before sprint/task creation or implementation.",
		"For tiny debug/hotfix work (few-line fixes, typo/quick-fix corrections, tiny changes), use /sprint debug or sprint_debug instead of starting a full sprint task flow.",
		"For concrete, multi-step implementation, use normal .sprints task/session flow; one dedicated session is still required for that path.",
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

export interface AfkShipKickoffInput {
	runId: string;
	lane: AutomationLane;
	hotfixKind?: HotfixKind;
	taskId?: string;
	retryBudget: number;
	reportPath: string;
	statePath: string;
}

export function buildAfkShipKickoff(input: AfkShipKickoffInput): string {
	const kindLine = input.hotfixKind ? ` (hotfixKind=${input.hotfixKind})` : "";
	const taskLine = input.taskId ? ` taskId=${input.taskId}` : "";
	return [
		"AFK ship supervisor session bound (local-only MVP).",
		`runId=${input.runId} lane=${input.lane}${kindLine}${taskLine}`,
		`statePath=${input.statePath}`,
		`reportPath=${input.reportPath}`,
		`retryBudget=${input.retryBudget}`,
		"",
		"Distinct from `/sprint task start --auto-run` (which only kicks off a bound session): AFK supervised shipping drives a durable implement -> review/evidence -> focused-fix -> finalize loop through `sprint_ship` until the run is delivery_complete, blocked, or hits its retry budget.",
		"Workflow:",
		"1. Read the run state with `sprint_ship action=read runId=...` and confirm lane/retryBudget/reportPath.",
		"2. For non-trivial work, gate the lane with the existing PRD-first planning gate (`sprint_read_context`/workflow planning state). The full-sprint start path already enforces this; do not bypass.",
		"3. Drive the loop: `sprint_ship action=transition event={\"kind\":\"implement_started\"}` -> `coder_completed` -> reviewer flow -> `focused_fix_completed` (on reviewer changes-requested) -> `finalization_recorded` -> `delivery_complete`.",
		"4. When the run stops, the `REPORT.md` is the durable deliverable. Read it before claiming completion.",
		"",
		"Safety:",
		"- Local-only MVP: do NOT shell out to remote publishing, PR creation, deploy, or credentialed actions. Default permissions deny push/pr/deploy/destructive/credentialed; requests for these produce a stop condition unless explicitly authorized.",
		"- Full-sprint lane still requires PRD/sprint/architecture/implementation confirmations. The implementation gate is enforced at start; do not invent a silent bypass.",
		"- Hotfix lane is lightweight but strict: code-changing hotfixes are reviewer-required by default; text-evidence-only is reviewer-free only when concrete refs and validation evidence are present and the changes are non-code (.md/.txt/prompt packs).",
		"- Debug lane is audit-first and diagnose-first: a debug session must record a non-empty diagnosis and root-cause hypothesis, recommend a single next lane (hotfix | full-sprint | no-code/report-only), and may NOT perform implementation unless an explicit `select_next_lane` event promotes the lane. The supervisor must not silently perform broad implementation in debug lane.",
		"- The `sprint_ship` and `sprint_classify_lane` AI tools are the surface; both go through the durable state under `.pi/workflow-runs/afk-ship/<runId>/`.",
	].filter(Boolean).join("\n");
}
