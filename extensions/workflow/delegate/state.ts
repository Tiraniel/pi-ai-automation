// Workflow delegate runtime — streaming event-state accumulator and parsers.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// This module owns the *shape* of an in-flight delegate run:
//   - `DelegateEventState` / `createDelegateEventState` — the accumulator
//     reused by both transports (headless JSONL stream and pane session
//     tail),
//   - `processEventLine` — headless `--mode json` event line parser,
//   - `processSessionLine` — pane-mode `session.jsonl` entry parser.
//
// The two transports in `./headless` and `./pane` import these helpers
// directly and only differ in *how* they call them (live stdout pipe vs.
// file tail with done-sidecar signaling).

import type { Message } from "@earendil-works/pi-ai";
import type {
	AgentName,
	AgentPreset,
	DelegateProgressItem,
	UsageStats,
} from "../types";
import { resolveModelLabel } from "../runtime/config";
import {
	MAX_FINAL_OUTPUT_PREVIEW,
	MAX_PROGRESS_ITEMS,
	MAX_TASK_PREVIEW,
} from "./constants";
import {
	countThinkingChars,
	extractMessageText,
	extractMessageThinking,
	extractToolUpdatePreview,
	findLastAssistantMessage,
	getFinalAssistantText,
	truncateText,
} from "./messages";

export interface DelegateEventState {
	usage: UsageStats;
	messages: Message[];
	progress: DelegateProgressItem[];
	activeTools: Map<string, { name: string }>;
	status: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	aborted: boolean;
	lastAssistantPreview: string;
	lastAssistantEmitAt: number;
	lastThinkingChars: number;
	lastThinkingEmitAt: number;
	latestThinkingChars: number;
	/** Count of child stream lines that failed JSON.parse and were dropped. */
	malformedEventLines: number;
}

export function createDelegateEventState(): DelegateEventState {
	return {
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		messages: [],
		progress: [],
		activeTools: new Map(),
		status: "starting",
		stderr: "",
		aborted: false,
		lastAssistantPreview: "",
		lastAssistantEmitAt: 0,
		lastThinkingChars: 0,
		lastThinkingEmitAt: 0,
		latestThinkingChars: 0,
		malformedEventLines: 0,
	};
}

// A dropped line can carry `message_end` / usage / the final assistant text,
// so a silent drop can turn a failed child into a "completed with empty
// output" result. Count and surface the first occurrence in stderr.
function recordMalformedLine(state: DelegateEventState): void {
	state.malformedEventLines += 1;
	if (state.malformedEventLines === 1) {
		state.stderr = `${state.stderr}${state.stderr ? "\n" : ""}[delegate] dropped malformed JSON line(s) from the child stream; usage/final output may be incomplete`;
	}
}

function pushProgress(state: DelegateEventState, item: DelegateProgressItem): void {
	state.progress.push(item);
	if (state.progress.length > MAX_PROGRESS_ITEMS) state.progress.splice(0, state.progress.length - MAX_PROGRESS_ITEMS);
}

function buildPartialUpdate(
	state: DelegateEventState,
	agent: AgentName,
	task: string,
	cwd: string,
	preset: AgentPreset,
): any {
	const { usage, messages, progress, activeTools } = state;
	const output = getFinalAssistantText(messages);
	const finalOutputPreview = truncateText(output, MAX_FINAL_OUTPUT_PREVIEW);
	const thinkingChars = Math.max(countThinkingChars(messages), state.latestThinkingChars);
	return {
		content: [{ type: "text", text: finalOutputPreview || `${agent} ${state.status}...` }],
		details: {
			agent,
			taskPreview: truncateText(task, MAX_TASK_PREVIEW),
			cwd,
			model: resolveModelLabel(preset),
			usage,
			status: state.status,
			activeTools: Array.from(activeTools.entries()).map(([id, t]) => ({ id, name: t.name })),
			progress,
			finalOutputPreview,
			thinkingChars,
		},
	};
}

export function processEventLine(state: DelegateEventState, line: string, agent: AgentName, task: string, cwd: string, preset: AgentPreset, onUpdate?: (partial: any) => void) {
	if (!line.trim()) return;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		recordMalformedLine(state);
		return;
	}

	const { usage, messages, activeTools } = state;
	const now = Date.now();
	const emitUpdate = () => onUpdate?.(buildPartialUpdate(state, agent, task, cwd, preset));

	switch (event.type) {
		case "turn_start": {
			state.status = `turn ${Number(event.turnIndex ?? usage.turns + 1)} running`;
			pushProgress(state, { at: now, type: "status", text: state.status });
			emitUpdate();
			break;
		}
		case "turn_end": {
			state.status = "turn complete";
			pushProgress(state, { at: now, type: "status", text: state.status });
			emitUpdate();
			break;
		}
		case "tool_execution_start": {
			const name = String(event.toolName ?? "tool");
			const id = String(event.toolCallId ?? `${name}-${now}`);
			activeTools.set(id, { name });
			state.status = `${name} running`;
			pushProgress(state, { at: now, type: "tool_start", text: `→ ${name}` });
			emitUpdate();
			break;
		}
		case "tool_execution_update": {
			const name = String(event.toolName ?? "tool");
			const details = extractToolUpdatePreview(event.partialResult);
			pushProgress(state, { at: now, type: "tool_update", text: `… ${name}${details ? ` ${details}` : ""}` });
			emitUpdate();
			break;
		}
		case "tool_execution_end": {
			const name = String(event.toolName ?? "tool");
			const id = String(event.toolCallId ?? "");
			if (id) activeTools.delete(id);
			const ok = !event.isError;
			pushProgress(state, { at: now, type: ok ? "tool_end" : "error", text: `${ok ? "✓" : "✗"} ${name}` });
			state.status = ok ? "tool complete" : "tool failed";
			emitUpdate();
			break;
		}
		case "message_update": {
			const text = truncateText(extractMessageText(event.message as Message));
			if (text) {
				const shouldEmit =
					text !== state.lastAssistantPreview &&
					(text.length - state.lastAssistantPreview.length >= 40 || now - state.lastAssistantEmitAt > 400);
				if (shouldEmit) {
					state.lastAssistantPreview = text;
					state.lastAssistantEmitAt = now;
					pushProgress(state, { at: now, type: "assistant", text: truncateText(`💬 ${text}`) });
					emitUpdate();
				}
			}
			if (event.assistantMessageEvent) {
				const partialMsg = event.assistantMessageEvent.partial as any;
				if (partialMsg && Array.isArray(partialMsg.content)) {
					const thinkingParts = partialMsg.content.filter((part: any) => part?.type === "thinking" && typeof part.thinking === "string");
					if (thinkingParts.length > 0) {
						const totalChars = thinkingParts.reduce((sum: number, part: any) => sum + part.thinking.length, 0);
						state.latestThinkingChars = totalChars;
						if (totalChars > 0 && (totalChars - state.lastThinkingChars > 80 || now - state.lastThinkingEmitAt > 600)) {
							state.lastThinkingChars = totalChars;
							state.lastThinkingEmitAt = now;
							pushProgress(state, { at: now, type: "thinking", text: `thinking… (${totalChars} chars)` });
							emitUpdate();
						}
					}
				}
			}
			break;
		}
		case "message_end": {
			if (!event.message) break;
			const msg = event.message as Message;
			messages.push(msg);
			const asAny = msg as any;
			if (asAny.role === "assistant") {
				usage.turns++;
				if (asAny.usage) {
					usage.input += asAny.usage.input || 0;
					usage.output += asAny.usage.output || 0;
					usage.cacheRead += asAny.usage.cacheRead || 0;
					usage.cacheWrite += asAny.usage.cacheWrite || 0;
					usage.cost += asAny.usage.cost?.total || 0;
					usage.contextTokens = asAny.usage.totalTokens || usage.contextTokens;
				}
				if (asAny.stopReason) state.stopReason = asAny.stopReason;
				if (asAny.errorMessage) state.errorMessage = asAny.errorMessage;
				const assistantText = extractMessageText(msg);
				if (assistantText) pushProgress(state, { at: now, type: "assistant", text: `💬 ${truncateText(assistantText)}` });
			}
			emitUpdate();
			break;
		}
		case "tool_result_end": {
			if (event.message) messages.push(event.message as Message);
			emitUpdate();
			break;
		}
		case "agent_end": {
			state.status = state.aborted ? "aborted" : "completed";
			pushProgress(state, { at: now, type: "status", text: state.status });
			emitUpdate();
			break;
		}
		default: {
			if (typeof event.type === "string" && (event.type.startsWith("auto_retry") || event.type.startsWith("compaction"))) {
				pushProgress(state, { at: now, type: "status", text: truncateText(event.type) });
				emitUpdate();
			}
		}
	}
}

/**
 * Parse a Pi session JSONL entry for pane-mode tailing.
 * Updates state from finalized messages/tool calls rather than streaming events.
 * Live partials are not required because the user sees the live pane.
 */
export function processSessionLine(state: DelegateEventState, line: string, agent: AgentName, task: string, cwd: string, preset: AgentPreset, onUpdate?: (partial: any) => void) {
	if (!line.trim()) return;
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		recordMalformedLine(state);
		return;
	}

	const { usage, messages, activeTools } = state;
	const now = Date.now();
	const emitUpdate = () => onUpdate?.(buildPartialUpdate(state, agent, task, cwd, preset));

	if (entry.type === "message" && entry.message) {
		const msg = entry.message as Message;
		messages.push(msg);
		const asAny = msg as any;
		if (asAny.role === "assistant") {
			usage.turns++;
			if (asAny.usage) {
				usage.input += asAny.usage.input || 0;
				usage.output += asAny.usage.output || 0;
				usage.cacheRead += asAny.usage.cacheRead || 0;
				usage.cacheWrite += asAny.usage.cacheWrite || 0;
				usage.cost += asAny.usage.cost?.total || 0;
				usage.contextTokens = asAny.usage.totalTokens || usage.contextTokens;
			}
			if (asAny.stopReason) state.stopReason = asAny.stopReason;
			if (asAny.errorMessage) state.errorMessage = asAny.errorMessage;
			const assistantText = extractMessageText(msg);
			if (assistantText) pushProgress(state, { at: now, type: "assistant", text: `💬 ${truncateText(assistantText)}` });
			const thinking = extractMessageThinking(msg);
			if (thinking.chars > 0) {
				state.latestThinkingChars = thinking.chars;
				pushProgress(state, { at: now, type: "thinking", text: `thinking… (${thinking.chars} chars)` });
			}
		} else if (asAny.role === "toolResult") {
			const name = asAny.toolName || asAny.name || "tool";
			const id = asAny.toolCallId || "";
			if (id) activeTools.delete(id);
			const ok = !asAny.isError;
			pushProgress(state, { at: now, type: ok ? "tool_end" : "error", text: `${ok ? "✓" : "✗"} ${name}` });
		}
		// Also emit progress for tool calls embedded in assistant content parts
		if (asAny.role === "assistant" && Array.isArray(asAny.content)) {
			for (const part of asAny.content) {
				if (part?.type === "toolCall") {
					const tcName = String(part.name ?? part.toolName ?? "tool");
					const tcId = String(part.id ?? `${tcName}-${now}`);
					activeTools.set(tcId, { name: tcName });
					state.status = `${tcName} running`;
					pushProgress(state, { at: now, type: "tool_start", text: `→ ${tcName}` });
				}
			}
		}
		emitUpdate();
	} else if (entry.type === "tool_call" && entry.tool_call) {
		const tc = entry.tool_call as any;
		const name = String(tc.name ?? "tool");
		const id = String(tc.id ?? `${name}-${now}`);
		activeTools.set(id, { name });
		state.status = `${name} running`;
		pushProgress(state, { at: now, type: "tool_start", text: `→ ${name}` });
		emitUpdate();
	} else if (entry.type === "tool_result" && entry.tool_result) {
		const tr = entry.tool_result as any;
		const name = String(tr.name ?? "tool");
		const id = String(tr.id ?? "");
		if (id) activeTools.delete(id);
		const ok = !tr.isError;
		pushProgress(state, { at: now, type: ok ? "tool_end" : "error", text: `${ok ? "✓" : "✗"} ${name}` });
		state.status = ok ? "tool complete" : "tool failed";
		emitUpdate();
	}
}
