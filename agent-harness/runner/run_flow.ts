// Full flow for one fixture (or one live task directory laid out the same way):
//
//   1. load requirement.json / handoff.json / implementation_report.json
//   2. freeze OSOT: sha256 of the stored requirement + handoff bytes
//   3. validate every document against its contract schema           (G1)
//   4. verify handoff points at the frozen requirement               (G2)
//   5. collect the diff (base/ vs changed/)
//   6. run tests + mutation gate
//   7. run static gates G3..G11 and synthesize static reviews
//   8. optionally run LLM reviewer swarm (HARNESS_LLM_CMD)
//   9. aggregate deterministically -> final_review
//  10. write machine-readable + human-readable reports
//
// Usage: node agent-harness/runner/run_flow.ts <fixture-dir> [--report-dir <dir>]

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { aggregate } from "./aggregate.ts";
import { llmEnabled, runLlmReviewer, REVIEWER_ROLES } from "./agents.ts";
import { collectDirDiff } from "./collect_diff.ts";
import { assembleWorkspace, runMutationGate, runNodeTests } from "./run_tests.ts";
import { gatesToStaticReviews, runStaticGates } from "./static_gates.ts";
import { validateAgainstContract } from "./validate_contracts.ts";
import type {
	FinalReviewDoc,
	Gate,
	HandoffDoc,
	ImplementationReportDoc,
	RequirementDoc,
	ReviewDoc,
} from "./types.ts";

function sha256(buf: Buffer | string): string {
	return crypto.createHash("sha256").update(buf).digest("hex");
}

function loadJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export interface FlowResult {
	finalReview: FinalReviewDoc;
	gates: Gate[];
	reviews: ReviewDoc[];
	fixture: string;
}

export async function runFlow(fixtureDir: string, reportDir?: string): Promise<FlowResult> {
	const requirementPath = path.join(fixtureDir, "requirement.json");
	const handoffPath = path.join(fixtureDir, "handoff.json");
	const reportPath = path.join(fixtureDir, "implementation_report.json");

	const requirement = loadJson<RequirementDoc>(requirementPath);
	const handoff = loadJson<HandoffDoc>(handoffPath);
	const implReport = loadJson<ImplementationReportDoc>(reportPath);

	// OSOT freeze: the stored bytes are the single source of truth; every later
	// stage refers to them by hash, never by re-reading mutable agent state.
	const requirementSha256 = sha256(fs.readFileSync(requirementPath));
	const handoffSha256 = sha256(fs.readFileSync(handoffPath));

	const contractErrors = [
		...validateAgainstContract("requirement.schema.json", requirement).map((e) => `requirement ${e.path}: ${e.message}`),
		...validateAgainstContract("handoff.schema.json", handoff).map((e) => `handoff ${e.path}: ${e.message}`),
		...validateAgainstContract("implementation_report.schema.json", implReport).map((e) => `report ${e.path}: ${e.message}`),
	];

	const diff = collectDirDiff(path.join(fixtureDir, "base"), path.join(fixtureDir, "changed"));

	const workspace = assembleWorkspace(fixtureDir);
	let testRun;
	try {
		testRun = runNodeTests(workspace);
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
	const mutation = runMutationGate(fixtureDir);

	const gates = runStaticGates({
		handoff,
		report: implReport,
		diff,
		testRun,
		mutation,
		contractErrors,
		osot: {
			requirementSha256,
			handoffClaimsSha256: handoff.implementation_handoff.original_requirement.sha256,
		},
	});

	const reviews: ReviewDoc[] = gatesToStaticReviews(gates);

	if (llmEnabled()) {
		// The four allowed sources — and nothing else — go to each LLM reviewer.
		const reviewInput = {
			original_requirement: requirement,
			implementation_handoff: handoff,
			diff: { files: { added: diff.added, changed: diff.changed, removed: diff.removed }, unified: diff.unifiedText },
			implementation_report: implReport,
			mutation_results: mutation.map((m) => ({ mutant: m.mutant, killed: m.killed })),
		};
		for (const role of REVIEWER_ROLES) {
			reviews.push(runLlmReviewer(role, reviewInput));
		}
	}

	const finalReview = aggregate({
		taskId: handoff.implementation_handoff.task_id,
		gates,
		reviews,
		osot: { requirementSha256, handoffSha256 },
	});

	const fixtureName = path.basename(fixtureDir);
	if (reportDir) {
		fs.mkdirSync(reportDir, { recursive: true });
		fs.writeFileSync(
			path.join(reportDir, `${fixtureName}.final_review.json`),
			`${JSON.stringify(finalReview, null, 2)}\n`,
		);
		fs.writeFileSync(path.join(reportDir, `${fixtureName}.final_review.md`), renderMarkdown(fixtureName, finalReview, gates));
	}

	return { finalReview, gates, reviews, fixture: fixtureName };
}

function renderMarkdown(fixture: string, finalReview: FinalReviewDoc, gates: Gate[]): string {
	const fr = finalReview.final_review;
	const lines = [
		`# Final review — ${fixture}`,
		"",
		`- task: \`${fr.task_id}\``,
		`- verdict: **${fr.verdict.toUpperCase()}**`,
		`- confidence: ${fr.confidence}`,
		`- requirement OSOT: \`sha256:${fr.osot?.requirement_sha256}\``,
		`- handoff contract: \`sha256:${fr.osot?.handoff_sha256}\``,
		"",
		"## Gates",
		"",
		"| gate | result | evidence |",
		"|------|--------|----------|",
		...gates.map((g) => `| ${g.id} ${g.name} | ${g.result} | ${g.evidence.join("; ").replace(/\|/g, "\\|").slice(0, 200) || "—"} |`),
		"",
		"## Blocking issues",
		"",
		...(fr.blocking_issues.length === 0
			? ["none"]
			: fr.blocking_issues.map((b) => `- **${b.description}** — ${b.evidence} _(source: ${b.sources.join(", ")})_`)),
		"",
		"## Required fixes",
		"",
		...(fr.required_fixes.length === 0 ? ["none"] : fr.required_fixes.map((f) => `- ${f}`)),
		"",
		"## Ignored opinion feedback",
		"",
		...(fr.ignored_opinion_feedback.length === 0
			? ["none"]
			: fr.ignored_opinion_feedback.map((i) => `- ${i.feedback} (${i.reason}, from ${i.source_reviewer ?? "?"})`)),
		"",
	];
	return `${lines.join("\n")}\n`;
}

if (process.argv[1] === import.meta.filename) {
	const args = process.argv.slice(2);
	const reportFlag = args.indexOf("--report-dir");
	const reportDir = reportFlag !== -1 ? args[reportFlag + 1] : path.join(import.meta.dirname, "..", "reports");
	const fixtureDir = args.find((a, i) => !a.startsWith("--") && (reportFlag === -1 || i !== reportFlag + 1));
	if (!fixtureDir) {
		console.error("usage: node run_flow.ts <fixture-dir> [--report-dir <dir>]");
		process.exit(2);
	}
	const result = await runFlow(path.resolve(fixtureDir), reportDir);
	const fr = result.finalReview.final_review;
	console.log(`${result.fixture}: ${fr.verdict.toUpperCase()} (confidence=${fr.confidence})`);
	for (const g of result.gates) {
		console.log(`  ${g.result === "pass" ? "ok " : "FAIL"} ${g.id} ${g.name}`);
	}
	for (const b of fr.blocking_issues) console.log(`  blocking: ${b.description}`);
}
