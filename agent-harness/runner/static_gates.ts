// Deterministic contract gates. Design rule of this harness: every check that CAN
// be code IS code. LLM reviewers (see agents.ts) only judge what code can't —
// semantic drift and fake-test intent. Gates never have opinions; each gate
// compares one contract field against one observable fact and emits evidence.

import type {
	DiffResult,
	Gate,
	HandoffDoc,
	ImplementationReportDoc,
	MutantResult,
	ReviewDoc,
	TestRunResult,
	Verdict,
} from "./types.ts";

const DEPENDENCY_SENSITIVE = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.env[^/]*|tsconfig\.json|.*\.config\.(js|ts|mjs|cjs|json)|Dockerfile|\.github\/.*)$/;

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.split("**")
		.map((part) =>
			part
				.split("*")
				.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join("[^/]*"),
		)
		.join(".*");
	return new RegExp(`^${escaped}$`);
}

function matchesAny(file: string, patterns: string[]): boolean {
	return patterns.some((p) => globToRegExp(p).test(file));
}

function sameSet(a: string[], b: string[]): boolean {
	const sa = [...a].sort().join("\n");
	const sb = [...b].sort().join("\n");
	return sa === sb;
}

export function runStaticGates(input: {
	handoff: HandoffDoc;
	report: ImplementationReportDoc;
	diff: DiffResult;
	testRun: TestRunResult;
	mutation: MutantResult[];
	contractErrors: string[];
	osot: { requirementSha256: string; handoffClaimsSha256: string };
}): Gate[] {
	const h = input.handoff.implementation_handoff;
	const r = input.report.implementation_report;
	const touched = [...input.diff.added, ...input.diff.changed, ...input.diff.removed];
	const gates: Gate[] = [];
	const gate = (id: string, name: string, ok: boolean, evidence: string[]) =>
		gates.push({ id, name, result: ok ? "pass" : "fail", evidence });

	// G1 — all agent documents validate against their JSON schemas
	gate("G1", "contract_validation", input.contractErrors.length === 0, input.contractErrors);

	// G2 — OSOT freeze: handoff points at the exact requirement bytes it was written for
	gate(
		"G2",
		"osot_freeze",
		input.osot.handoffClaimsSha256 === input.osot.requirementSha256,
		[`requirement sha256=${input.osot.requirementSha256}`, `handoff claims=${input.osot.handoffClaimsSha256}`],
	);

	// G3 — only allowed_files were touched
	const outsideAllowed = touched.filter((f) => !matchesAny(f, h.allowed_files));
	gate("G3", "allowed_files_only", outsideAllowed.length === 0,
		outsideAllowed.map((f) => `file outside allowed_files: ${f}`));

	// G4 — no forbidden_files touched
	const forbiddenTouched = touched.filter((f) => matchesAny(f, h.forbidden_files));
	gate("G4", "forbidden_files_untouched", forbiddenTouched.length === 0,
		forbiddenTouched.map((f) => `forbidden file touched: ${f}`));

	// G5 — forbidden_patterns absent from changed content
	const patternHits: string[] = [];
	for (const [file, content] of Object.entries(input.diff.changedContents)) {
		for (const fp of h.forbidden_patterns) {
			if (new RegExp(fp.pattern, "m").test(content)) {
				patternHits.push(`${file}: forbidden pattern /${fp.pattern}/ (${fp.reason})`);
			}
		}
	}
	gate("G5", "forbidden_patterns_absent", patternHits.length === 0, patternHits);

	// G6 — dependency/config freeze
	const depFiles = touched.filter((f) => DEPENDENCY_SENSITIVE.test(f));
	const depOk =
		h.dependency_policy === "none"
			? depFiles.length === 0 && r.dependency_changes.length === 0
			: r.dependency_changes.every((d) => (h.allowed_dependencies ?? []).includes(d));
	gate("G6", "dependency_freeze", depOk, [
		...depFiles.map((f) => `dependency-sensitive file touched: ${f}`),
		...(h.dependency_policy === "none" && r.dependency_changes.length > 0
			? [`report declares dependency changes under policy=none: ${r.dependency_changes.join(", ")}`]
			: []),
	]);

	// G7 — implementation_report matches the actual diff (honesty gate)
	const reportHonest =
		sameSet(r.changed_files, input.diff.changed) &&
		sameSet(r.added_files, input.diff.added) &&
		sameSet(r.removed_files, input.diff.removed);
	gate("G7", "report_matches_diff", reportHonest, reportHonest ? [] : [
		`report changed=${JSON.stringify(r.changed_files)} actual=${JSON.stringify(input.diff.changed)}`,
		`report added=${JSON.stringify(r.added_files)} actual=${JSON.stringify(input.diff.added)}`,
		`report removed=${JSON.stringify(r.removed_files)} actual=${JSON.stringify(input.diff.removed)}`,
	]);

	// G8 — every test_matrix case id appears verbatim in some test file
	const testContent = Object.entries(input.diff.changedContents)
		.filter(([f]) => f.endsWith(".test.ts"))
		.map(([, c]) => c)
		.join("\n");
	const allCases = [
		...h.test_matrix.success_cases,
		...h.test_matrix.failure_cases,
		...h.test_matrix.false_success_cases,
		...h.test_matrix.false_failure_cases,
	];
	const missingCases = allCases.filter((c) => !testContent.includes(`[${c.id}]`));
	gate("G8", "test_matrix_coverage", missingCases.length === 0,
		missingCases.map((c) => `no test tagged [${c.id}] (${c.then})`));

	// G9 — the test suite passes on the actual implementation
	gate("G9", "tests_pass", input.testRun.ok,
		input.testRun.ok ? [] : [input.testRun.output.slice(-2000)]);

	// G10 — mutation gate: tests must FAIL on every known-broken implementation.
	// A surviving mutant means the tests would accept a broken build (false success).
	const survivors = input.mutation.filter((m) => !m.killed);
	gate("G10", "mutants_killed",
		input.mutation.length > 0 && survivors.length === 0,
		input.mutation.length === 0
			? ["no mutants provided — gate cannot certify test strength"]
			: survivors.map((m) => `SURVIVING MUTANT: tests pass on broken implementation ${m.mutant}`));

	// G11 — every state named by the handoff state machine exists in the changed source
	const srcContent = Object.entries(input.diff.changedContents)
		.filter(([f]) => !f.endsWith(".test.ts"))
		.map(([, c]) => c)
		.join("\n");
	const missingStates = Object.keys(h.state_machine.states).filter((s) => !srcContent.includes(s));
	gate("G11", "state_machine_states_present", missingStates.length === 0,
		missingStates.map((s) => `state "${s}" from handoff not found in implementation`));

	return gates;
}

// Gate → reviewer-role mapping. Static reviews are Review documents synthesized
// from gate results so the aggregator treats code checks and LLM checks uniformly.
const ROLE_GATES: Record<string, string[]> = {
	test_reviewer: ["G8", "G9", "G10"],
	architecture_reviewer: ["G3", "G4", "G5", "G11"],
	business_logic_reviewer: ["G9", "G10", "G11"],
	dependency_reviewer: ["G6"],
	diff_minimality_reviewer: ["G3", "G7"],
};

export function gatesToStaticReviews(gates: Gate[]): ReviewDoc[] {
	return Object.entries(ROLE_GATES).map(([reviewer, gateIds]) => {
		const mine = gates.filter((g) => gateIds.includes(g.id));
		const failed = mine.filter((g) => g.result === "fail");
		const verdict: Verdict = failed.length === 0 ? "pass" : "fail";
		return {
			review: {
				reviewer,
				verdict,
				blocking_issues: failed.map((g) => ({
					id: g.id,
					description: `${g.name} gate failed`,
					evidence: g.evidence.join(" | ") || "(no evidence captured)",
				})),
				non_blocking_issues: [],
				evidence: mine.map((g) => `${g.id}:${g.name}=${g.result}`),
				required_fixes: failed.map((g) => `satisfy gate ${g.id} (${g.name})`),
				scope_creep_detected: [],
			},
		};
	});
}
