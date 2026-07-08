// Reviewer protocol — single owner of the reviewer-role vocabulary and the
// reviewer verdict contract. The architecture matrix, the reviewer swarm,
// delegate tools, and finalization all import from here; nothing re-declares
// these literals.

/** Closed, ordered set of reviewer role ids. */
export const REVIEWER_ROLE_IDS = [
	"implementation",
	"evidence-test",
	"behavior",
	"regression",
	"maintainability",
	"docs-config",
] as const;

export type ReviewerRole = (typeof REVIEWER_ROLE_IDS)[number];

export const KNOWN_REVIEWER_ROLES: ReadonlySet<ReviewerRole> = new Set<ReviewerRole>(REVIEWER_ROLE_IDS);

export function isReviewerRole(value: unknown): value is ReviewerRole {
	return typeof value === "string" && (KNOWN_REVIEWER_ROLES as ReadonlySet<string>).has(value);
}

/** Verdict a reviewer must lead its response with. */
export type ReviewerVerdict = "APPROVED" | "CHANGES_REQUESTED" | "UNKNOWN";

/**
 * Parse a reviewer's free-form final output into a verdict. Fail-closed:
 * APPROVED counts ONLY when it leads the first non-empty line (markdown
 * punctuation like backticks/bold around the token is tolerated). A buried
 * "…would have APPROVED…" never approves. CHANGES_REQUESTED anywhere in the
 * text still counts as changes-requested — leniency is allowed only in the
 * blocking direction. Everything else is UNKNOWN, which every consumer must
 * treat as not-approved.
 */
export function parseReviewerVerdict(text: string): ReviewerVerdict {
	const normalized = text.replace(/\r\n?/g, "\n");
	for (const line of normalized.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Strip leading markdown decoration (`, *, _, #, >, quotes) before the token.
		const cleaned = trimmed.toUpperCase().replace(/^[`*_>#"'“”\s]+/, "");
		if (/^APPROVED\b/.test(cleaned)) return "APPROVED";
		if (/^CHANGES[_\s-]?REQUESTED\b/.test(cleaned)) return "CHANGES_REQUESTED";
		break;
	}
	if (/\bCHANGES[_\s-]?REQUESTED\b/i.test(normalized)) return "CHANGES_REQUESTED";
	return "UNKNOWN";
}
