// LLM agent adapter. The harness is agent-backend-agnostic: any CLI that reads a
// prompt on stdin and writes a single JSON document to stdout can serve as an
// agent (e.g. `pi -p`, `claude -p --output-format json`).
//
// Set HARNESS_LLM_CMD to enable LLM reviewers, e.g.:
//   HARNESS_LLM_CMD="claude -p" node agent-harness/runner/run_flow.ts <fixture>
//
// When unset, run_flow uses static gates only — fully deterministic and offline.
// LLM reviewer output MUST validate against contracts/review.schema.json; invalid
// output is retried once, then recorded as a failed review (a reviewer that can't
// follow its own contract doesn't get to pass code).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { validateAgainstContract } from "./validate_contracts.ts";
import type { ReviewDoc } from "./types.ts";

const PROMPTS_DIR = path.join(import.meta.dirname, "..", "prompts");

export const REVIEWER_ROLES = [
	"test_reviewer",
	"architecture_reviewer",
	"business_logic_reviewer",
	"dependency_reviewer",
	"diff_minimality_reviewer",
] as const;

export function llmEnabled(): boolean {
	return Boolean(process.env.HARNESS_LLM_CMD);
}

function extractJson(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("no JSON object in agent output");
	return JSON.parse(text.slice(start, end + 1));
}

export function runLlmReviewer(role: string, reviewInput: unknown): ReviewDoc {
	const cmd = process.env.HARNESS_LLM_CMD;
	if (!cmd) throw new Error("HARNESS_LLM_CMD not set");
	const promptPath = role.endsWith("_reviewer") && role !== "requirement_intake"
		? path.join(PROMPTS_DIR, "reviewers", `${role}.md`)
		: path.join(PROMPTS_DIR, `${role}.md`);
	const prompt = fs.readFileSync(promptPath, "utf8");
	const stdin = `${prompt}\n\n## Review input (four sources only)\n\n${JSON.stringify(reviewInput, null, 2)}\n\nOutput exactly one JSON object matching contracts/review.schema.json.`;

	for (let attempt = 0; attempt < 2; attempt++) {
		const [bin, ...args] = cmd.split(" ");
		const proc = spawnSync(bin, args, { input: stdin, encoding: "utf8", timeout: 300_000 });
		try {
			const doc = extractJson(proc.stdout ?? "");
			const errors = validateAgainstContract("review.schema.json", doc);
			if (errors.length === 0) return doc as ReviewDoc;
		} catch {
			// fall through to retry
		}
	}
	return {
		review: {
			reviewer: role,
			verdict: "fail",
			blocking_issues: [{
				id: "AGENT-CONTRACT",
				description: `${role} produced output that does not satisfy review.schema.json after retry`,
				evidence: "agent output rejected by contract validation",
			}],
			non_blocking_issues: [],
			evidence: [],
			required_fixes: [`re-run ${role} with a compliant agent`],
			scope_creep_detected: [],
		},
	};
}
