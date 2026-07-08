// Deterministic review aggregator. No LLM decides the final verdict.
// Verdict rule: pass iff every reviewer passed AND every gate passed.
// Opinion feedback (issues without evidence, or marked ignored by reviewers)
// is preserved for audit but never affects the verdict.

import type { FinalReviewDoc, Gate, ReviewDoc } from "./types.ts";

export function aggregate(input: {
	taskId: string;
	gates: Gate[];
	reviews: ReviewDoc[];
	osot: { requirementSha256: string; handoffSha256: string };
}): FinalReviewDoc {
	const blocking = new Map<string, { description: string; evidence: string; sources: string[] }>();
	const ignored: FinalReviewDoc["final_review"]["ignored_opinion_feedback"] = [];
	let inconsistent = false;

	for (const { review } of input.reviews) {
		for (const issue of review.blocking_issues) {
			if (!issue.evidence || issue.evidence.trim() === "" || issue.evidence === "(no evidence captured)") {
				ignored.push({
					feedback: issue.description,
					source_reviewer: review.reviewer,
					reason: "no_evidence",
				});
				continue;
			}
			const key = `${issue.description}::${issue.evidence}`;
			const existing = blocking.get(key);
			if (existing) existing.sources.push(review.reviewer);
			else blocking.set(key, { description: issue.description, evidence: issue.evidence, sources: [review.reviewer] });
		}
		for (const item of review.ignored ?? []) {
			ignored.push({ feedback: item.feedback, source_reviewer: review.reviewer, reason: item.reason });
		}
		// A fail verdict with zero evidenced blocking issues is opinion, not review.
		if (review.verdict === "fail" && review.blocking_issues.length === 0) inconsistent = true;
	}

	const gateFailures = input.gates.filter((g) => g.result === "fail");
	const reviewFailures = input.reviews.filter(
		(r) => r.review.verdict === "fail" && r.review.blocking_issues.length > 0,
	);
	const verdict = gateFailures.length === 0 && reviewFailures.length === 0 ? "pass" : "fail";

	const requiredFixes = [...new Set(input.reviews.flatMap((r) => r.review.required_fixes))];

	return {
		final_review: {
			task_id: input.taskId,
			verdict,
			blocking_issues: [...blocking.values()],
			required_fixes: verdict === "fail" ? requiredFixes : [],
			ignored_opinion_feedback: ignored,
			confidence: inconsistent ? "low" : input.gates.some((g) => g.result === "skipped") ? "medium" : "high",
			gates: Object.fromEntries(input.gates.map((g) => [`${g.id}:${g.name}`, g.result])),
			osot: {
				requirement_sha256: input.osot.requirementSha256,
				handoff_sha256: input.osot.handoffSha256,
			},
		},
	};
}
