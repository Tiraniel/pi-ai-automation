// Workflow Rooms — shared tool helpers (textResult and small truncation utilities).
// Extracted from extensions/brain-workflow.ts as part of TASK-018 Slice 1.

export function textResult(text: string, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

export function truncateLabel(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}
