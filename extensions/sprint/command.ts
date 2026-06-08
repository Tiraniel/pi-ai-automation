// Sprint subsystem — `/sprint` slash command registration.
// Extracted from extensions/sprint-system.ts as part of TASK-018 Slice 4.
//
// `registerSprintCommand(pi)` registers the single `/sprint` command that
// drives the v1 .sprints substrate: init/new/status, debug/hotfix, task add/active/start/
// done, epic add, and log. The handler parses subcommands then dispatches
// to the store helpers in ./store. The task-start subcommand is the only
// one with non-trivial side effects (it pins the new Pi session to a
// single sprint task via a custom session entry); its body is inlined here
// because the setup/withSession callbacks are local to the command.

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startSprintTaskSession } from "./start-session";
import {
	createEpic,
	createSprint,
	createTask,
	initSprints,
	loadCurrent,
	parseArgs,
	rootPaths,
	setActiveTask,
	updateTaskStatus,
} from "./store";
import { appendDebugNote, completeDebugItem, createDebugItem, promoteDebugItem, readDebugLaneSummary } from "./debug";
import { SPRINTS_DIR } from "./types";

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
				if (sub === "debug" || sub === "hotfix") {
					const action = args[1] ?? "status";
					if (action === "status") {
						const summary = readDebugLaneSummary(ctx.cwd, 5);
						const latestText = summary.latest.length
							? summary.latest
									.map((item) => `${item.id} [${item.status}] ${item.title}${item.notePreview ? ` - ${item.notePreview}` : ""}`)
									.join("\n")
							: "(none)";
						ctx.ui.notify(
							[
								`Debug lane: ${summary.path} (${summary.exists ? "initialized" : "not initialized"})`,
								`open: ${summary.openCount} | done: ${summary.doneCount} | promoted: ${summary.promotedCount}`,
								"",
								"Latest: ",
								latestText,
							].join("\n"),
							"info",
						);
						return;
					}
					if (action === "add") {
						const title = args.slice(2).join(" ").trim();
						if (!title) throw new Error("Usage: /sprint debug add <title>");
						const item = createDebugItem(ctx.cwd, title);
						ctx.ui.notify(`Created ${item.id}: ${item.title}`, "info");
						return;
					}
					if (action === "note") {
						const id = args[2];
						if (!id) throw new Error("Usage: /sprint debug note <DBG-ID> <note>");
						const note = args.slice(3).join(" ").trim();
						if (!note) throw new Error("Usage: /sprint debug note <DBG-ID> <note>");
						const item = appendDebugNote(ctx.cwd, id, note);
						ctx.ui.notify(`Note added to ${item.id}`, "info");
						return;
					}
					if (action === "done") {
						const id = args[2];
						if (!id) throw new Error("Usage: /sprint debug done <DBG-ID> [evidence]");
						const evidence = args.slice(3).join(" ").trim();
						const item = completeDebugItem(ctx.cwd, id, evidence || undefined);
						ctx.ui.notify(`Completed ${item.id}${item.completedAt ? ` (${item.completedAt})` : ""}`, "info");
						return;
					}
					if (action === "promote") {
						const id = args[2];
						if (!id) throw new Error("Usage: /sprint debug promote <DBG-ID> [task title]");
						const taskTitle = args.slice(3).join(" ").trim();
						const result = promoteDebugItem(ctx.cwd, id, taskTitle ? { title: taskTitle } : undefined);
						ctx.ui.notify(
							`Promoted ${result.item.id} as ${result.task.id} at ${path.relative(ctx.cwd, result.task.filePath)}`,
							"info",
						);
						return;
					}
					throw new Error(
						"Usage: /sprint debug [status] | add <title> | note <DBG-ID> <note> | done <DBG-ID> [evidence] | promote <DBG-ID> [task title]",
					);
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

					const result = await startSprintTaskSession(ctx, taskId, { autoRun });
					if (result.cancelled) {
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
					"Usage: /sprint init [--private] [--gitignore] | new <name> | status | debug|hotfix [status] | debug add <title> | debug note <DBG-ID> <note> | debug done <DBG-ID> [evidence] | debug promote <DBG-ID> [task title] | task add <title> | task active <TASK-ID> | task start <TASK-ID> [--auto-run] | task done <TASK-ID> | epic add <title> | log <message>",
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
