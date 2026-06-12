// Sprint subsystem — `/sprint` slash command registration.
// Extracted from extensions/sprint-system.ts as part of TASK-018 Slice 4.
//
// `registerSprintCommand(pi)` registers the single `/sprint` command that
// drives the v1 .sprints substrate: init/new/status, debug/hotfix, task add/active/start/
// done, epic add, log, and task ship (AFK supervisor kickoff). The handler
// parses subcommands then dispatches to the store helpers in ./store and
// the AFK supervisor helpers in ./ship-state. The task-start and task-ship
// subcommands are the only ones with non-trivial side effects (they pin
// the new Pi session to a single sprint task via a custom session entry);
// their bodies are inlined here because the setup/withSession callbacks
// are local to the command.

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startSprintTaskSession } from "./start-session";
import {
	appendProgress,
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
import {
	appendDebugNote,
	completeDebugItem,
	createDebugItem,
	evaluateDebugLaneEscalationFromDisk,
	promoteDebugItem,
	readDebugLaneSummary,
} from "./debug";
import { evaluateDebugFinalization } from "../workflow/finalization-runtime";
import { gateSprintEntryPoint } from "./planning-gate";
import { SPRINTS_DIR } from "./types";
import {
	createInitialShipState,
	shipReportPathRelative,
	shipStatePathRelative,
	shipStateExists,
	writeShipReport,
	writeShipState,
} from "./ship-state";
import { renderShipReport } from "./ship-report";
import { ALL_HOTFIX_KINDS, isAutomationLane, type HotfixKind } from "./lane-policy";

function isHotfixKind(value: unknown): value is HotfixKind {
	return typeof value === "string" && (ALL_HOTFIX_KINDS as readonly string[]).includes(value);
}

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
					const gate = gateSprintEntryPoint(ctx.cwd, undefined, "sprint");
					if (!gate.allowed) {
						ctx.ui.notify(gate.text, "warning");
						ctx.ui.notify("Use workflow_planning_state to record PRD-ready sprint authorization before /sprint new.", "info");
						return;
					}
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
						if (!id) throw new Error("Usage: /sprint debug done <DBG-ID> [--dry-run] [evidence]");
						const rawEvidence = args.slice(3);
						const dryRun = rawEvidence[0] === "--dry-run";
						const evidence = (dryRun ? rawEvidence.slice(1) : rawEvidence).join(" ").trim();
						const mode: "strict" | "dry-run" = dryRun ? "dry-run" : "strict";
						const escalation = evaluateDebugLaneEscalationFromDisk(ctx.cwd, {
							itemId: id,
							evidenceText: evidence,
						});
						const finalization = evaluateDebugFinalization({
							itemId: id,
							requestedStatus: "done",
							mode,
							finalEvidence: evidence,
							finalNote: evidence,
							debugChain: { repeatedInAreaCount: escalation.repeatedSameAreaFixCount },
						});
						if (escalation.needsEscalation && mode === "strict") {
							ctx.ui.notify(`Debug completion blocked for ${id}; escalate rule requires ${escalation.suggestedAction}.`, "warning");
							ctx.ui.notify(`Rule codes: ${escalation.ruleCodes.join("; ")}`, "warning");
							ctx.ui.notify(`Summary: ${escalation.summary}`, "warning");
							ctx.ui.notify("Promote to a normal sprint task now to avoid hidden repeated hotfix escalation.", "warning");
							if (finalization.blockers.length) ctx.ui.notify(`Blockers: ${finalization.blockers.join("; ")}`, "warning");
							if (finalization.warnings.length) ctx.ui.notify(`Warnings: ${finalization.warnings.join("; ")}`, "warning");
							return;
						}
						const item = completeDebugItem(ctx.cwd, id, evidence || undefined);
						if (escalation.needsEscalation) {
							ctx.ui.notify(`Escalation signals present in strict/dry-run mode (${escalation.ruleCodes.join("; ")}).`, "warning");
						}
						ctx.ui.notify(`Completed ${item.id}${item.completedAt ? ` (${item.completedAt})` : ""}`, "info");
						if (finalization.warnings.length) ctx.ui.notify(`Warnings: ${finalization.warnings.join("; ")}`, "warning");
						if (finalization.blockers.length) ctx.ui.notify(`Blockers: ${finalization.blockers.join("; ")}`, "warning");
						return;
					}
					if (action === "promote") {
						const gate = gateSprintEntryPoint(ctx.cwd, undefined, "sprint");
						if (!gate.allowed) {
							ctx.ui.notify(gate.text, "warning");
							ctx.ui.notify("Use workflow_planning_state to record PRD-ready sprint authorization before debug promotion.", "info");
							return;
						}
						const id = args[2];
						if (!id) throw new Error("Usage: /sprint debug promote <DBG-ID> [task title]");
						const taskTitle = args.slice(3).join(" ").trim();
						const escalation = evaluateDebugLaneEscalationFromDisk(ctx.cwd, {
							itemId: id,
						});
						const result = promoteDebugItem(ctx.cwd, id, taskTitle ? { title: taskTitle, escalation } : { escalation });
						ctx.ui.notify(
							`Promoted ${result.item.id} as ${result.task.id} at ${path.relative(ctx.cwd, result.task.filePath)}`,
							"info",
						);
						return;
					}
					throw new Error(
						"Usage: /sprint debug [status] | add <title> | note <DBG-ID> <note> | done <DBG-ID> [--dry-run] [evidence] | promote <DBG-ID> [task title]",
					);
				}
				if (sub === "task" && args[1] === "add") {
					const title = args.slice(2).join(" ").trim();
					if (!title) throw new Error("Usage: /sprint task add <title>");
					const gate = gateSprintEntryPoint(ctx.cwd, undefined, "sprint");
					if (!gate.allowed) {
						ctx.ui.notify(gate.text, "warning");
						ctx.ui.notify("Use workflow_planning_state to record PRD-ready sprint authorization before creating sprint tasks.", "info");
						return;
					}
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
					const gate = gateSprintEntryPoint(ctx.cwd, undefined, "sprint");
					if (!gate.allowed) {
						ctx.ui.notify(gate.text, "warning");
						ctx.ui.notify("Use workflow_planning_state to record PRD-ready sprint authorization before starting this task.", "info");
						return;
					}

					const result = await startSprintTaskSession(ctx, taskId, { autoRun });
					if (result.cancelled) {
						ctx.ui.notify("Sprint task session creation cancelled", "warning");
					}
					return;
				}
				if (sub === "task" && args[1] === "ship") {
					// /sprint task ship <TASK-ID> --afk [--lane full-sprint|hotfix|debug]
					//   [--hotfix-kind code-changing|text-evidence-only]
					//   [--run-id <id>] [--scope <text>] [--retry-budget <n>]
					// Default lane is full-sprint for normal sprint tasks. Hotfix and
					// debug starts are lightweight and not PRD-gated. Full-sprint
					// starts run gateSprintEntryPoint(...,'implementation'); if denied,
					// the command stops and the AFK run is NOT created.
					if (!args.includes("--afk")) {
						throw new Error("Usage: /sprint task ship <TASK-ID> --afk [--lane <lane>] [--hotfix-kind <kind>] [--run-id <id>] [--scope <text>] [--retry-budget <n>]");
					}
					const positional = args.slice(2).filter((a) => !a.startsWith("--"));
					const taskId = positional[0];
					if (!taskId) throw new Error("Usage: /sprint task ship <TASK-ID> --afk [--lane <lane>] [--scope <text>]");

					const laneArgRaw = (() => {
						const idx = args.indexOf("--lane");
						return idx >= 0 ? String(args[idx + 1] || "").trim() : "full-sprint";
					})();
					if (!isAutomationLane(laneArgRaw)) {
						throw new Error(`Invalid --lane "${laneArgRaw}"; must be one of: full-sprint|hotfix|debug.`);
					}
					const laneArg = laneArgRaw;

					const hotfixKindArg = (() => {
						const idx = args.indexOf("--hotfix-kind");
						return idx >= 0 ? String(args[idx + 1] || "").trim() : "";
					})();
					if (laneArg === "hotfix" && !isHotfixKind(hotfixKindArg)) {
						throw new Error("hotfix lane requires --hotfix-kind code-changing|text-evidence-only.");
					}

					const scopeArg = (() => {
						const idx = args.indexOf("--scope");
						return idx >= 0 ? String(args[idx + 1] || "").trim() : "";
					})();
					if (laneArg === "hotfix" && !scopeArg) {
						throw new Error("hotfix lane requires an explicit --scope statement.");
					}

					const runIdArg = (() => {
						const idx = args.indexOf("--run-id");
						return idx >= 0 ? String(args[idx + 1] || "").trim() : "";
					})();
					const retryBudgetArg = (() => {
						const idx = args.indexOf("--retry-budget");
						return idx >= 0 ? Number(args[idx + 1]) : NaN;
					})();
					const retryBudget = Number.isFinite(retryBudgetArg) && retryBudgetArg > 0 ? Math.max(1, Math.floor(retryBudgetArg)) : 3;

					if (laneArg === "full-sprint") {
						const gate = gateSprintEntryPoint(ctx.cwd, undefined, "implementation");
						if (!gate.allowed) {
							ctx.ui.notify(gate.text, "warning");
							ctx.ui.notify("Use workflow_planning_state to record PRD-ready implementation authorization before starting a full-sprint AFK ship run.", "info");
							return;
						}
					}

					const runId = runIdArg || `afk-${taskId.toLowerCase()}-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
					if (shipStateExists(ctx.cwd, runId)) {
						ctx.ui.notify(`AFK run already exists: ${shipStatePathRelative(ctx.cwd, runId)}; pick a different --run-id.`, "warning");
						return;
					}

					const initial = createInitialShipState({
						runId,
						taskId,
						lane: laneArg,
						hotfixKind: laneArg === "hotfix" ? (hotfixKindArg as "code-changing" | "text-evidence-only") : undefined,
						retryBudget,
						allowedScope: scopeArg || undefined,
						fullSprintGatesConfirmed: laneArg === "full-sprint",
					});
					const persisted = writeShipState(ctx.cwd, initial);
					const withReport = writeShipReport(ctx.cwd, persisted, { render: (s) => renderShipReport(s, { workspaceName: path.basename(ctx.cwd) }) });

					ctx.ui.notify(
						`AFK ship run created runId=${withReport.runId} lane=${withReport.lane}${withReport.hotfixKind ? ` hotfixKind=${withReport.hotfixKind}` : ""} state=${shipStatePathRelative(ctx.cwd, withReport.runId)} report=${shipReportPathRelative(ctx.cwd, withReport.runId)}`,
						"info",
					);

					const newSession = (ctx as any).newSession;
					if (typeof newSession !== "function") {
						ctx.ui.notify(
							`AFK run is ready (${shipStatePathRelative(ctx.cwd, withReport.runId)}). Automatic session start is unavailable in this context; start a session bound to ${taskId} manually with /sprint task start ${taskId} --auto-run, or use the sprint_ship AI tool to drive the run.`,
							"info",
						);
						return;
					}
					const result = await startSprintTaskSession(ctx, taskId, {
						autoRun: true,
						shipRun: {
							runId: withReport.runId,
							lane: withReport.lane,
							hotfixKind: withReport.hotfixKind,
							taskId,
							retryBudget: withReport.retryBudget,
							reportPath: withReport.finalReportPath ?? shipReportPathRelative(ctx.cwd, withReport.runId),
							statePath: shipStatePathRelative(ctx.cwd, withReport.runId),
						},
					});
					if (result.cancelled) {
						ctx.ui.notify("Sprint task session creation cancelled (AFK run state and report are still on disk).", "warning");
					}
					return;
				}
				if (sub === "epic" && args[1] === "add") {
					const title = args.slice(2).join(" ").trim();
					if (!title) throw new Error("Usage: /sprint epic add <title>");
					const gate = gateSprintEntryPoint(ctx.cwd, undefined, "sprint");
					if (!gate.allowed) {
						ctx.ui.notify(gate.text, "warning");
						ctx.ui.notify("Use workflow_planning_state to record PRD-ready sprint authorization before creating epics.", "info");
						return;
					}
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
					"Usage: /sprint init [--private] [--gitignore] | new <name> | status | debug|hotfix [status] | debug add <title> | debug note <DBG-ID> <note> | debug done <DBG-ID> [--dry-run] [evidence] | debug promote <DBG-ID> [task title] | task add <title> | task active <TASK-ID> | task start <TASK-ID> [--auto-run] | task ship <TASK-ID> --afk [--lane <lane>] [--hotfix-kind <kind>] [--run-id <id>] [--scope <text>] [--retry-budget <n>] | task done <TASK-ID> | epic add <title> | log <message>",
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
