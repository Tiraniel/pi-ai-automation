// Harness self-calibration: runs every fixture through the full flow and compares
// the aggregate verdict against the fixture's expected verdict.
//
//   expected fail  + actual pass  => FALSE SUCCESS  (harness accepted broken work)
//   expected pass  + actual fail  => FALSE FAILURE  (harness rejected correct work)
//
// This is how reviewer quality itself is regression-tested. Any change to gates,
// prompts, or aggregation must keep this suite green.
//
// Usage: node agent-harness/runner/calibrate.ts

import * as fs from "node:fs";
import * as path from "node:path";

import { runFlow } from "./run_flow.ts";

const FIXTURES_DIR = path.join(import.meta.dirname, "..", "fixtures");
const REPORTS_DIR = path.join(import.meta.dirname, "..", "reports");

interface ExpectedVerdict {
	expected: "pass" | "fail";
	reason: string;
	must_fail_gates?: string[];
}

const results: Array<{ fixture: string; expected: string; actual: string; classification: string }> = [];
let miscalibrated = 0;

const fixtures = fs
	.readdirSync(FIXTURES_DIR, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort();

for (const fixture of fixtures) {
	const fixtureDir = path.join(FIXTURES_DIR, fixture);
	const expected = JSON.parse(
		fs.readFileSync(path.join(fixtureDir, "expected_verdict.json"), "utf8"),
	) as ExpectedVerdict;
	const result = await runFlow(fixtureDir, REPORTS_DIR);
	const actual = result.finalReview.final_review.verdict;

	let classification = "calibrated";
	if (expected.expected === "fail" && actual === "pass") classification = "FALSE SUCCESS";
	if (expected.expected === "pass" && actual === "fail") classification = "FALSE FAILURE";
	if (classification !== "calibrated") miscalibrated++;

	// If the fixture pins WHICH gates must catch the defect, verify attribution too:
	// failing for the wrong reason is a latent false success.
	if (expected.must_fail_gates && classification === "calibrated" && expected.expected === "fail") {
		const failedGates = result.gates.filter((g) => g.result === "fail").map((g) => g.id);
		const missing = expected.must_fail_gates.filter((g) => !failedGates.includes(g));
		if (missing.length > 0) {
			classification = `WRONG ATTRIBUTION (expected gates ${missing.join(",")} to fail)`;
			miscalibrated++;
		}
	}

	results.push({ fixture, expected: expected.expected, actual, classification });
}

const width = Math.max(...results.map((r) => r.fixture.length));
console.log(`\n${"fixture".padEnd(width)}  expected  actual  classification`);
console.log("-".repeat(width + 40));
for (const r of results) {
	console.log(`${r.fixture.padEnd(width)}  ${r.expected.padEnd(8)}  ${r.actual.padEnd(6)}  ${r.classification}`);
}
console.log(
	miscalibrated === 0
		? "\nCALIBRATED: no false successes, no false failures."
		: `\nMISCALIBRATED: ${miscalibrated} fixture(s) — reviewer/gate quality regression.`,
);
process.exit(miscalibrated === 0 ? 0 : 1);
