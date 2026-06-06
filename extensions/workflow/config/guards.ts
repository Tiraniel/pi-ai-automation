/**
 * Unknown-safe structural guards for the v2 workflow model.
 *
 * These helpers are intentionally tiny and return `undefined` (rather than
 * throwing) for any value that does not match the expected shape. The
 * normalizers in `./normalize.ts` build typed v2 values by composing these
 * guards; resolvers and downstream code can therefore treat the result of
 * `normalize*` as already-shape-checked JSON.
 *
 * Design notes:
 * - We never return `any` from these helpers. Each guard narrows the type
 *   so callers can compose them with `??` fallbacks and still produce a
 *   fully typed result.
 * - `asRecord` returns `Record<string, unknown>` and is the entry point for
 *   any object-shaped field. Other helpers are layered on top of it.
 */

import {
	AGENT_ROLES,
	DELEGATE_DISPLAY_MODES,
	FLOW_DIRECTIONS,
	QUALITY_GATE_KINDS,
	THINKING_LEVELS,
	type AgentRole,
	type DelegateDisplayMode,
	type FlowDirection,
	type QualityGateKind,
	type ThinkingLevel,
} from "../types.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isPlainObject(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asInteger(value: unknown): number | undefined {
	const n = asNumber(value);
	return n !== undefined && Number.isInteger(n) ? n : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
	const arr = asArray(value);
	if (!arr) return undefined;
	const out: string[] = [];
	for (const entry of arr) {
		const s = asString(entry);
		if (s === undefined) return undefined;
		out.push(s);
	}
	return out;
}

export function asOptionalStringArray(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	return asStringArray(value) ?? [];
}

export function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const s = asString(value);
	if (!s) return undefined;
	return (THINKING_LEVELS as readonly string[]).includes(s) ? (s as ThinkingLevel) : undefined;
}

export function asAgentRole(value: unknown): AgentRole | undefined {
	const s = asString(value);
	if (!s) return undefined;
	return (AGENT_ROLES as readonly string[]).includes(s) ? (s as AgentRole) : undefined;
}

export function asDelegateDisplayMode(value: unknown): DelegateDisplayMode | undefined {
	const s = asString(value);
	if (!s) return undefined;
	return (DELEGATE_DISPLAY_MODES as readonly string[]).includes(s)
		? (s as DelegateDisplayMode)
		: undefined;
}

export function asFlowDirection(value: unknown): FlowDirection | undefined {
	const s = asString(value);
	if (!s) return undefined;
	return (FLOW_DIRECTIONS as readonly string[]).includes(s) ? (s as FlowDirection) : undefined;
}

export function asQualityGateKind(value: unknown): QualityGateKind | undefined {
	const s = asString(value);
	if (!s) return undefined;
	return (QUALITY_GATE_KINDS as readonly string[]).includes(s) ? (s as QualityGateKind) : undefined;
}

/**
 * Version discriminator. Returns `1` for v1-shaped input, `2` for v2-shaped
 * input, or `undefined` when the shape is ambiguous. v1 has no `version`
 * field; v2 must set `version: 2`. We treat the presence of `agents` plus
 * the absence of `version` as the strongest v1 signal; the v2 top-level
 * `flow` field is the strongest v2 signal.
 */
export type WorkflowConfigVersion = 1 | 2;

export function detectConfigVersion(value: unknown): WorkflowConfigVersion | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const version = record.version;
	if (version === 2) return 2;
	if (version === 1) return 1;
	if (typeof version === "number" && version !== 1 && version !== 2) return undefined;
	if (Array.isArray(record.flow) && Array.isArray(record.roles)) return 2;
	if (asRecord(record.agents) !== undefined) return 1;
	return undefined;
}
