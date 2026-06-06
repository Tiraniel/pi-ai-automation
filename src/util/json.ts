/**
 * Safe JSON parsing utilities for persisted DB JSON strings.
 * Returns fallback on invalid/corrupt input; never throws.
 */

export function parseJsonStringArray(value: unknown, fallback: string[] = []): string[] {
	if (typeof value !== "string" || value.length === 0) return fallback;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
			return parsed;
		}
	} catch {
		// ignore
	}
	return fallback;
}

export function parseJsonStringRecord(value: unknown, fallback: Record<string, string> = {}): Record<string, string> {
	if (typeof value !== "string" || value.length === 0) return fallback;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(parsed)) {
				if (typeof v === "string") out[k] = v;
			}
			return out;
		}
	} catch {
		// ignore
	}
	return fallback;
}
