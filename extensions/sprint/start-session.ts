// Sprint subsystem — shared task-session starter used by `/sprint task start` and `sprint_start_task_session`.
// Extracted from extensions/sprint/command.ts as part of TASK-028 Slice 4.

import * as path from "node:path";
import { readBrainMarkersForTaskFile } from "./markers";
import { buildTaskSessionKickoff } from "./prompt";
import {
  activeSprintAbs,
  appendProgress,
  findTaskFileInSprint,
  loadCurrent,
  nowIso,
  saveCurrent,
  updateTaskStatus,
} from "./store";
import { SPRINT_BINDING_CUSTOM_TYPE, type SessionBinding, type SprintCurrent } from "./types";

export interface StartSprintTaskSessionOptions {
  autoRun: boolean;
}

export interface StartSprintTaskSessionResult {
  cancelled?: boolean;
  taskId: string;
  title: string;
  message: string;
}

export async function startSprintTaskSession(
  ctx: any,
  taskId: string,
  options: StartSprintTaskSessionOptions,
): Promise<StartSprintTaskSessionResult> {
  const autoRun = options.autoRun;
  const sprintAbs = activeSprintAbs(ctx.cwd);
  if (!sprintAbs) throw new Error("No active sprint.");
  const taskInfo = findTaskFileInSprint(sprintAbs, taskId);
  if (!taskInfo) throw new Error(`Task not found: ${taskId}`);

  const cwd = ctx.cwd;
  const sprintRel = path.relative(cwd, sprintAbs);
  const taskRel = path.relative(cwd, taskInfo.file);
  const title = String(taskInfo.frontmatter.title ?? taskId);
  const binding: SessionBinding = { sprintPath: sprintRel, taskPath: taskRel, taskId, title, boundAt: nowIso() };
  const sessionName = `Sprint: ${taskId} ${title}`.slice(0, 80);
  const markers = readBrainMarkersForTaskFile(taskInfo.file);
  const kickoff = buildTaskSessionKickoff(binding, autoRun, markers);
  const parentSession =
    ctx.sessionManager && typeof ctx.sessionManager.getSessionFile === "function"
      ? ctx.sessionManager.getSessionFile()
      : undefined;
  const newSession = ctx.newSession;
  if (typeof newSession !== "function") {
    throw new Error("ctx.newSession is not available in this context.");
  }

  const result = await newSession.call(ctx, {
    parentSession,
    setup: async (sm: any) => {
      sm.appendCustomEntry(SPRINT_BINDING_CUSTOM_TYPE, binding);
      sm.appendSessionInfo(sessionName);
      sm.appendCustomMessageEntry(
        SPRINT_BINDING_CUSTOM_TYPE,
        `Sprint task session bound to ${taskId}: ${title}\nSprint: ${sprintRel}\nTask: ${taskRel}`,
        true,
        binding,
      );
      updateTaskStatus(cwd, taskId, "in_progress", "session started");
      const current = loadCurrent(cwd) ?? { activeSprintPath: null, activeTaskPath: null, updatedAt: nowIso() } satisfies SprintCurrent;
      current.activeSprintPath = sprintRel;
      current.activeTaskPath = taskRel;
      current.updatedAt = nowIso();
      saveCurrent(cwd, current);
      appendProgress(cwd, `task session started ${taskId}${autoRun ? " (auto-run)" : ""}`);
    },
    withSession: async (newCtx: any) => {
      if (autoRun && kickoff) await newCtx.sendUserMessage(kickoff);
      else newCtx.ui.notify(`Sprint task session started: ${taskId} ${title}`, "info");
    },
  });

  const cancelled = Boolean(result?.cancelled);
  const message = cancelled
    ? `Sprint task session creation cancelled for ${taskId}`
    : `Sprint task session started: ${taskId} ${title}${autoRun ? " (auto-run sent)" : ""}`;

  return { cancelled, taskId, title, message };
}
