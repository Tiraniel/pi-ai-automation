// Sprint subsystem — `before_agent_start` hook registration.
// Extracted from extensions/sprint-system.ts as part of TASK-018 Slice 4.
//
// `registerSprintHooks(pi)` wires the single v1 hook:
//   - on `before_agent_start`, if the session is bound to a sprint task,
//     inject the binding prompt; otherwise validate/normalize the global
//     current.json pointer and inject a pointer prompt when valid; when
//     there is no active sprint and the prompt looks non-trivial, ask the
//     user (or auto-create, depending on ~/.pi/agent/sprints.json) and
//     inject the pointer prompt for the freshly created sprint.
//
// DECLINED_CWDS is a per-process Set that remembers, for the lifetime of
// this extension load, which working directories have been asked and the
// user said "no" — we do not re-ask for those.
//
// When the effective task has Brain markers, they are parsed once per
// prompt and appended to the injected text so Brain sees the
// parallel/room/agent/contract hints.

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readBrainMarkersForTaskFile } from "./markers";
import { debugLaneGuidanceText, sessionBindingPromptText, sprintPointerText } from "./prompt";
import {
	createSprint,
	loadCurrent,
	normalizeActiveSprintPath,
	normalizeActiveTaskPath,
	nowIso,
	readJson,
	readSessionBinding,
	saveCurrent,
} from "./store";
import type { AutoCreateMode } from "./types";
import { evaluatePlanningGate } from "../workflow/planning-gate-runtime";

// ---- hook-local heuristics + UI adapters ----------------------------------
// These are implementation details of the before_agent_start hook: how it
// decides a prompt is non-trivial, how it names an auto-created sprint, how
// it reads the global auto-create mode, and how it asks the user. No other
// module needs them, so they are private here rather than part of the
// store's interface.

function getGlobalAutoCreate(): AutoCreateMode {
	const p = path.join(os.homedir(), ".pi", "agent", "sprints.json");
	const cfg = readJson<{ autoCreate?: AutoCreateMode }>(p);
	const mode = cfg?.autoCreate;
	if (mode === "always" || mode === "ask" || mode === "never") return mode;
	return "ask";
}

function isNonTrivialPrompt(text: string): boolean {
	const t = text.toLowerCase();
	if (/^\s*\/sprint\b/.test(t)) return false;
	if (t.length > 60) return true;
	return /(implement|fix|add|update|refactor|build|create|feature|bug|sprint)/.test(t);
}

function deriveSprintName(prompt: string): string {
	const cleaned = prompt.replace(/\s+/g, " ").trim();
	if (!cleaned) return "general-work";
	return cleaned.slice(0, 50);
}

async function askUi(ui: any, title: string, message: string): Promise<boolean> {
	if (typeof ui?.confirm === "function") return Boolean(await ui.confirm(title, message));
	if (typeof ui?.askConfirm === "function") return Boolean(await ui.askConfirm(message));
	return false;
}

async function askUiInput(ui: any, title: string, placeholder: string): Promise<string> {
	if (typeof ui?.input === "function") return String((await ui.input(title, placeholder)) ?? "");
	if (typeof ui?.prompt === "function") return String((await ui.prompt(title)) ?? "");
	return "";
}

const LIGHTWEIGHT_DEBUG_SCOPE_HINT_RE = /\b(tiny|typo|few-line|few\s+line|one-line|one\s+line|small\s+fix|minor\s+fix|quick\s+fix)\b/i;
const LIGHTWEIGHT_HOTFIX_HINT_RE = /\bhotfix\b/i;
const NON_LIGHTWEIGHT_DEBUG_HINT_RE = /\b(implement|feature|refactor|non-trivial|tests?|regression|production|architecture|across|migration|build|create|multi[-\s]step)\b/i;
const LIGHTWEIGHT_DEBUG_PROMPT_MAX_LEN = 140;
const LIGHTWEIGHT_HOTFIX_MAX_LEN = 90;

function isLikelyLightweightDebugPrompt(prompt: string): boolean {
	const normalized = String(prompt || "").trim().toLowerCase();
	if (!normalized) return false;
	if (normalized.length > LIGHTWEIGHT_DEBUG_PROMPT_MAX_LEN) return false;
	if (/^\s*\/sprint\b/.test(normalized)) return false;
	if (NON_LIGHTWEIGHT_DEBUG_HINT_RE.test(normalized)) return false;
	if (LIGHTWEIGHT_DEBUG_SCOPE_HINT_RE.test(normalized)) return true;
	if (LIGHTWEIGHT_HOTFIX_HINT_RE.test(normalized)) return normalized.length <= LIGHTWEIGHT_HOTFIX_MAX_LEN;
	return false;
}

const DECLINED_CWDS = new Set<string>();

function blockedSprintAutoCreateMessage(ctx: { cwd: string }, phase: string): string | null {
	const gate = evaluatePlanningGate(ctx.cwd, undefined, "sprint");
	if (gate.allowed) return null;
	return [
		`PRD-first planning gate blocked ${phase}:`,
		gate.text,
		"Action: use workflow_planning_state to record PRD-ready state and explicit sprint confirmation before non-trivial auto-create.",
	].join("\n");
}

export function registerSprintHooks(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const binding = readSessionBinding((ctx as any).sessionManager);
		if (binding) {
			try {
				const normalizedSprint = normalizeActiveSprintPath(ctx.cwd, binding.sprintPath, true);
				const normalizedTask = normalizeActiveTaskPath(ctx.cwd, binding.taskPath, normalizedSprint.absolutePath);
				const markers = readBrainMarkersForTaskFile(normalizedTask.absolutePath);
				return { systemPrompt: `${event.systemPrompt}\n\n${sessionBindingPromptText(binding, markers)}` };
			} catch {
				// fall through to global pointer handling
			}
		}

		const current = loadCurrent(ctx.cwd);
		if (current?.activeSprintPath) {
			try {
				const normalized = normalizeActiveSprintPath(ctx.cwd, current.activeSprintPath);
				if (normalized.relativePath !== current.activeSprintPath) {
					current.activeSprintPath = normalized.relativePath;
					current.updatedAt = nowIso();
				}
				let taskPath: string | null = null;
				if (current.activeTaskPath) {
					const normalizedTask = normalizeActiveTaskPath(ctx.cwd, current.activeTaskPath, normalized.absolutePath);
					if (normalizedTask.relativePath !== current.activeTaskPath) {
						current.activeTaskPath = normalizedTask.relativePath;
						current.updatedAt = nowIso();
					}
					taskPath = normalizedTask.absolutePath;
				}
				saveCurrent(ctx.cwd, current);
				const markers = taskPath ? readBrainMarkersForTaskFile(taskPath) : null;
				return { systemPrompt: `${event.systemPrompt}\n\n${sprintPointerText(current, markers)}` };
			} catch {
				// Ignore invalid active sprint pointer.
			}
		}

		if (process.env.PI_WORKFLOW_CHILD === "1") return;
		if (DECLINED_CWDS.has(ctx.cwd)) return;
		const rawPrompt = (event as any)?.prompt ?? (event as any)?.userPrompt ?? (event as any)?.message;
		const prompt = typeof rawPrompt === "string" ? String(rawPrompt) : "";
		if (isLikelyLightweightDebugPrompt(prompt)) {
			return { systemPrompt: `${event.systemPrompt}\n\n${debugLaneGuidanceText()}` };
		}
		if (!isNonTrivialPrompt(prompt)) return;
		const mode = getGlobalAutoCreate();
		if (mode === "never") return;
		if (mode === "always") {
			const gateMessage = blockedSprintAutoCreateMessage(ctx, "via auto-create");
			if (gateMessage) {
				ctx.ui.notify(gateMessage, "warning");
				return { systemPrompt: `${event.systemPrompt}\n\n${gateMessage}` };
			}
			const created = createSprint(ctx.cwd, deriveSprintName(prompt));
			ctx.ui.notify(`Auto-created sprint ${created.sprintId}`, "info");
			const createdCurrent = loadCurrent(ctx.cwd);
			if (createdCurrent?.activeSprintPath) {
				try {
					normalizeActiveSprintPath(ctx.cwd, createdCurrent.activeSprintPath);
					return { systemPrompt: `${event.systemPrompt}\n\n${sprintPointerText(createdCurrent)}` };
				} catch {
					return;
				}
			}
			return;
		}
		const accepted = await askUi((ctx as any).ui, "Sprint bootstrap", "No active sprint found. Create one now?");
		if (!accepted) {
			DECLINED_CWDS.add(ctx.cwd);
			return;
		}
		const inputName = (await askUiInput((ctx as any).ui, "Sprint name", "Optional: short sprint title")).trim();
		const gateMessage = blockedSprintAutoCreateMessage(ctx, "via user-confirmed bootstrap");
		if (gateMessage) {
			ctx.ui.notify(gateMessage, "warning");
			return { systemPrompt: `${event.systemPrompt}\n\n${gateMessage}` };
		}
		const created = createSprint(ctx.cwd, inputName || deriveSprintName(prompt));
		ctx.ui.notify(`Created sprint ${created.sprintId}`, "info");
		const createdCurrent = loadCurrent(ctx.cwd);
		if (createdCurrent?.activeSprintPath) {
			try {
				normalizeActiveSprintPath(ctx.cwd, createdCurrent.activeSprintPath);
				return { systemPrompt: `${event.systemPrompt}\n\n${sprintPointerText(createdCurrent)}` };
			} catch {
				return;
			}
		}
	});
}
