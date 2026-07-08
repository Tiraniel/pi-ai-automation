// Workflow delegate runtime — message/progress/result helpers.
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 3.
//
// This module owns the small, pure helpers used by the delegate runner,
// the delegate tools, and the reviewer swarm. They have no I/O and no
// ExtensionAPI dependencies, so they are safe to import from any other
// delegate module. The duplicated `isPlainObject` guard previously kept in
// brain-workflow.ts lives here so the cmux parser and the tool-update
// preview share one definition.

import type { Message } from "@earendil-works/pi-ai";
import type {
	DelegateProgressItem,
	DelegateRunResult,
	UsageStats,
} from "../types";
import { MAX_FINAL_OUTPUT_PREVIEW, MAX_PROGRESS_TEXT, MAX_TOOL_UPDATE_PREVIEW } from "./constants";

// Shared plain-object guard for cmux JSON parsing and tool-update extraction.
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n");
		if (text.trim()) return text.trim();
	}
	return "";
}

export function extractMessageText(message: Message | undefined): string {
	const msg = message as any;
	if (!msg || !Array.isArray(msg.content)) return "";
	return msg.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

export function extractMessageThinking(message: Message | undefined): { text: string; chars: number } {
	const msg = message as any;
	if (!msg || !Array.isArray(msg.content)) return { text: "", chars: 0 };
	const parts = msg.content.filter((part: any) => part?.type === "thinking" && typeof part.thinking === "string");
	const text = parts.map((part: any) => part.thinking).join("\n").trim();
	return { text, chars: text.length };
}

export function findLastAssistantMessage(messages: Message[]): any | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg.role === "assistant") return msg;
	}
	return undefined;
}

export function formatDelegateProgressLine(item: DelegateProgressItem, theme: any): string {
	switch (item.type) {
		case "status":
			return theme.fg("dim", `  · ${item.text}`);
		case "tool_start":
			return theme.fg("toolTitle", `  ${item.text}`);
		case "tool_update":
			return theme.fg("dim", `  ${item.text}`);
		case "tool_end":
			return theme.fg("success", `  ${item.text}`);
		case "error":
			return theme.fg("error", `  ${item.text}`);
		case "assistant":
			return theme.fg("muted", `  ${item.text}`);
		case "thinking":
			return theme.fg("thinkingText", `  ${item.text}`);
		default:
			return theme.fg("dim", `  ${item.text}`);
	}
}

export function truncateText(text: string, max = MAX_PROGRESS_TEXT): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}

export function countThinkingChars(messages: Message[]): number {
	const msg = findLastAssistantMessage(messages);
	return msg ? extractMessageThinking(msg).chars : 0;
}

export function isFailed(result: DelegateRunResult): boolean {
	return result.aborted || result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function normalizeFinalStatus(result: Pick<DelegateRunResult, "aborted" | "stopReason" | "exitCode">): "failed" | "aborted" | "completed" {
	if (result.aborted || result.stopReason === "aborted") return "aborted";
	if (result.exitCode !== 0 || result.stopReason === "error") return "failed";
	return "completed";
}

export function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`in:${usage.input}`);
	if (usage.output) parts.push(`out:${usage.output}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(", ");
}

export function getDelegateFailureReason(toolName: string, result: any): string | null {
	if (!result || typeof result !== "object") return null;
	const details = (result as any).details;

	if (toolName === "delegate_to_reviewer") {
		if (details?.status === "failed" || details?.status === "aborted") return String(details.status);
		if (Array.isArray(details?.swarm)) {
			// Align with the swarm's own fail semantics: only required targets
			// (role mode) — or legacy targets, which carry no `required` flag —
			// can flip the result to failure. A non-required role's UNKNOWN must
			// not override the tool's own verdict.
			const failedItem = details.swarm.find(
				(item: any) =>
					item?.required !== false
					&& (item?.status !== "completed" || item?.verdict === "CHANGES_REQUESTED" || item?.verdict === "UNKNOWN"),
			);
			if (failedItem) return `swarm:${failedItem.status ?? "failed"}:${failedItem.verdict ?? "UNKNOWN"}`;
		}
	}

	if (details && typeof details === "object") {
		if (typeof details.status === "string" && details.status !== "completed") return `status:${details.status}`;
		if (typeof details.exitCode === "number" && details.exitCode !== 0) return `exitCode:${details.exitCode}`;
		if (details.aborted === true) return "aborted";
	}

	return null;
}

export function extractToolUpdatePreview(partialResult: unknown): string {
	if (typeof partialResult === "string") return truncateText(partialResult, MAX_TOOL_UPDATE_PREVIEW);
	if (!isPlainObject(partialResult)) return "";

	const candidates: unknown[] = [];
	const content = partialResult.content;
	if (typeof content === "string") candidates.push(content);
	if (Array.isArray(content)) {
		for (const item of content) {
			if (typeof item === "string") candidates.push(item);
			else if (isPlainObject(item) && typeof item.text === "string") candidates.push(item.text);
		}
	}
	if (typeof partialResult.output === "string") candidates.push(partialResult.output);
	if (typeof partialResult.stdout === "string") candidates.push(partialResult.stdout);
	if (typeof partialResult.stderr === "string") candidates.push(partialResult.stderr);
	if (typeof partialResult.summary === "string") candidates.push(partialResult.summary);
	if (isPlainObject(partialResult.details) && typeof partialResult.details.summary === "string") {
		candidates.push(partialResult.details.summary);
	}

	for (const candidate of candidates) {
		const text = truncateText(String(candidate), MAX_TOOL_UPDATE_PREVIEW);
		if (text) return text;
	}
	return "";
}

export function appendCapped(current: string, next: string, maxBytes: number): string {
	const combined = current + next;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
	let trimmed = combined.slice(-maxBytes);
	while (Buffer.byteLength(trimmed, "utf8") > maxBytes) trimmed = trimmed.slice(1);
	return trimmed;
}

// Re-exported so the runner module and tool renderers can stay consistent
// about the rendered-preview budget without re-declaring it.
export const FINAL_OUTPUT_PREVIEW_LIMIT = MAX_FINAL_OUTPUT_PREVIEW;
