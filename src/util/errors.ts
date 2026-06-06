/**
 * Extract a human-readable message from an unknown error value.
 */
export function errorMessage(error: unknown): string {
	if (error && typeof error === "object" && "message" in error) {
		return String((error as { message: unknown }).message);
	}
	return String(error);
}

/** Extract a code (e.g. 'ENOENT') from an unknown error value, if present. */
export function errorCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error) {
		return String((error as { code: unknown }).code);
	}
	return undefined;
}
