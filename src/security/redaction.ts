/**
 * Lightweight secret redaction for claims, refs, metadata, and tool output.
 *
 * Covers common key=value patterns and long high-entropy strings.
 * Does not depend on heavy regex libraries.
 */

const SECRET_KEY_PATTERNS = [
	/password/i,
	/token/i,
	/secret/i,
	/api[_-]?key/i,
	/private[_-]?key/i,
	/access[_-]?token/i,
	/auth/i,
	/credential/i,
	/aws[_-]?(access[_-]?key|secret)/i,
	/ssh[_-]?key/i,
	/bearer/i,
];

const HIGH_ENTROPY_MIN_LEN = 32;
const HIGH_ENTROPY_RE = /[A-Za-z0-9+/]{32,}={0,2}/g;
const KEY_VALUE_RE = /([\w\-_]+)\s*([:=])\s*(\S+)/g;

/**
 * Redact a single text string. Returns { text, redacted }.
 */
export function redactText(input: string): { text: string; redacted: boolean } {
	let redacted = false;
	let text = input;

	// Redact key=value or key:value patterns where key looks secret-related
	text = text.replace(KEY_VALUE_RE, (match, key, sep, value) => {
		if (SECRET_KEY_PATTERNS.some((p) => p.test(key))) {
			redacted = true;
			return `${key}${sep}[REDACTED]`;
		}
		return match;
	});

	// Redact long high-entropy strings (likely base64-encoded secrets or tokens)
	text = text.replace(HIGH_ENTROPY_RE, (match) => {
		if (match.length >= HIGH_ENTROPY_MIN_LEN) {
			redacted = true;
			return "[REDACTED]";
		}
		return match;
	});

	return { text, redacted };
}

/**
 * Redact an array of strings.
 */
export function redactStrings(inputs: string[]): { items: string[]; redacted: boolean } {
	let anyRedacted = false;
	const items = inputs.map((s) => {
		const result = redactText(String(s));
		if (result.redacted) anyRedacted = true;
		return result.text;
	});
	return { items, redacted: anyRedacted };
}

/**
 * Recursively redact values in a plain object, preserving structure.
 * Keys are inspected; if a key looks secret-related, its value is redacted.
 */
export function redactMetadata(obj: Record<string, unknown> | null | undefined): { obj: Record<string, unknown>; redacted: boolean } {
	if (!obj || typeof obj !== "object") {
		return { obj: {}, redacted: false };
	}
	let redacted = false;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		const keyLooksSecret = SECRET_KEY_PATTERNS.some((p) => p.test(key));
		if (keyLooksSecret && value !== undefined && value !== null) {
			redacted = true;
			out[key] = "[REDACTED]";
		} else if (typeof value === "string") {
			const r = redactText(value);
			if (r.redacted) redacted = true;
			out[key] = r.text;
		} else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			const r = redactMetadata(value as Record<string, unknown>);
			if (r.redacted) redacted = true;
			out[key] = r.obj;
		} else if (Array.isArray(value)) {
			const r = redactStrings(value.map((v) => String(v)));
			if (r.redacted) redacted = true;
			out[key] = r.items;
		} else {
			out[key] = value;
		}
	}
	return { obj: out, redacted };
}
