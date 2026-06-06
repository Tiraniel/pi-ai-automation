// Sprint subsystem — `/sprint` slash command registration.
// Extracted from extensions/sprint-system.ts as part of TASK-018 Slice 4.
//
// `registerSprintCommand(pi)` registers the single `/sprint` command that
// drives the v1 .sprints substrate: init/new/status, task add/active/start/
// done, epic add, and log. The handler parses subcommands then dispatches
// to the store helpers in ./store. The task-start subcommand is the only
// one with non-trivial side effects (it pins the new Pi session to a
// single sprint task via a custom session entry); its body is inlined here
// because the setup/withSession callbacks are local to the command.

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readBrainMarkersForTaskFile } from "./markers";
import { buildTaskSessionKickoff } from "./prompt";
import {
	activeSprintAbs,
	appendProgress,
	createEpic,
	createSprint,
	createTask,
	findTaskFileInSprint,
	initSprints,
	loadCurrent,
	nowIso,
	parseArgs,
	rootPaths,
	saveCurrent,
	setActiveTask,
	updateTaskStatus,
} from "./store";
import { SPRINT_BINDING_CUSTOM_TYPE, SPRINTS_DIR, type SessionBinding, type SprintCurrent } from "./types";

export function registerSprintCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sprint", {
		description: "Manage .sprints sprint substrate",
		handler: async (rawArgs, ctx) => {
			const args = parseArgs(rawArgs);
			const sub = args[0];
			try {
				if (sub === "init") {
					const isPrivate = args.includes("--private");
					const gitignore = args.includes("--gitignore");
					initSprints(ctx.cwd, { isPrivate, gitignore });
					ctx.ui.notify(`Sprint system initialized at ${path.join(ctx.cwd, SPRINTS_DIR)}`, "info");
					return;
				}
				if (sub === "new") {
					const name = args.slice(1).join(" ").trim();
					if (!name) throw new Error("Usage: /sprint new <name>");
					const created = createSprint(ctx.cwd, name);
					ctx.ui.notify(`Active sprint: ${created.sprintId}`, "info");
					return;
				}
				if (sub === "status") {
					const p = rootPaths(ctx.cwd);
					const current = loadCurrent(ctx.cwd);
					ctx.ui.notify(
						[
							`.sprints: ${p.sprintsRoot}`,
							`active sprint: ${current?.activeSprintPath ?? "(none)"}`,
							`active task: ${current?.activeTaskPath ?? "(none)"}`,
						].join("\n"),
						"info",
					);
					return;
				}
				if (sub === "task" && args[1] === "add") {
					const title = args.slice(2).join(" ").trim();
					if (!title) throw new Error("Usage: /sprint task add <title>");
					const t = createTask(ctx.cwd, title);
					ctx.ui.notify(`Created ${t.id}`, "info");
					return;
				}
				if (sub === "task" && args[1] === "active") {
					const id = args[2];
					if (!id) throw new Error("Usage: /sprint task active <TASK-ID>");
					const file = setActiveTask(ctx.cwd, id);
					ctx.ui.notify(`Active task: ${path.relative(ctx.cwd, file)}`, "info");
					return;
				}
				if (sub === "task" && args[1] === "done") {
					const id = args[2];
					if (!id) throw new Error("Usage: /sprint task done <TASK-ID>");
					updateTaskStatus(ctx.cwd, id, "done", "marked done");
					ctx.ui.notify(`Done: ${id}`, "info");
					return;
				}
				if (sub === "task" && args[1] === "start") {
					const autoRun = args.includes("--auto-run");
					const positional = args.slice(2).filter((a) => !a.startsWith("--"));
					let taskId = positional[0];
					if (!taskId) {
						const current = loadCurrent(ctx.cwd);
						if (current?.activeTaskPath) {
							const base = path.basename(current.activeTaskPath);
							const m = base.match(/^(TASK-\d+)-/);
							if (m) taskId = m[1];
						}
					}
					if (!taskId) throw new Error("Usage: /sprint task start <TASK-ID> [--auto-run]");

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
					const parentSession = (ctx.sessionManager && typeof ctx.sessionManager.getSessionFile === "function")
						? ctx.sessionManager.getSessionFile()
						: undefined;
					const newSession = (ctx as any).newSession;
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

					if (result?.cancelled) {
						ctx.ui.notify("Sprint task session creation cancelled", "warning");
					}
					return;
				}
				if (sub === "epic" && args[1] === "add") {
					const title = args.slice(2).join(" ").trim();
					if (!title) throw new Error("Usage: /sprint epic add <title>");
					const epic = createEpic(ctx.cwd, title);
					ctx.ui.notify(`Created epic ${epic.epicId}`, "info");
					return;
				}
				if (sub === "log") {
					const msg = args.slice(1).join(" ").trim();
					if (!msg) throw new Error("Usage: /sprint log <message>");
					appendProgress(ctx.cwd, msg);
					ctx.ui.notify("Progress logged", "info");
					return;
				}
				ctx.ui.notify(
					"Usage: /sprint init [--private] [--gitignore] | new <name> | status | task add <title> | task active <TASK-ID> | task start <TASK-ID> [--auto-run] | task done <TASK-ID> | epic add <title> | log <message>",
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
