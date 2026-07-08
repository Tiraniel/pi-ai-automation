// Shared runner types. These mirror the JSON schemas in ../contracts — the schemas
// are the source of truth for agent-facing shape; these types are the runner's view.

export interface RequirementDoc {
	business_requirement: {
		summary: string;
		actor: string;
		trigger: string;
		expected_behavior: Array<{ id: string; description: string }>;
		success_path: string[];
		failure_path: string[];
		edge_cases: Array<{ id: string; description: string }>;
		forbidden_behavior: Array<{ id: string; description: string }>;
		assumptions: Array<{ id: string; description: string; covers_question?: string }>;
		open_questions: Array<{ id: string; question: string; blocking: boolean }>;
	};
}

export interface HandoffDoc {
	implementation_handoff: {
		task_id: string;
		original_requirement: { ref: string; sha256: string };
		architecture_summary: string;
		affected_layers: string[];
		allowed_files: string[];
		forbidden_files: string[];
		allowed_patterns: string[];
		forbidden_patterns: Array<{ pattern: string; reason: string }>;
		required_behavior: Array<{ id: string; description: string; derived_from: string }>;
		state_machine: {
			states: Record<string, Record<string, unknown>>;
			transitions: Array<{ from: string; on: string; to: string; note?: string }>;
			forbidden_transitions?: Array<{ from: string; on: string; reason: string }>;
		};
		data_contracts: Record<string, unknown>;
		side_effects: string[];
		dependency_policy: "none" | "explicit_list_only";
		allowed_dependencies?: string[];
		test_matrix: {
			success_cases: MatrixCase[];
			failure_cases: MatrixCase[];
			false_success_cases: MatrixCase[];
			false_failure_cases: MatrixCase[];
		};
		acceptance_criteria: Array<{ id: string; criterion: string }>;
		reviewer_contract: Record<string, string[]>;
	};
}

export interface MatrixCase {
	id: string;
	given: string;
	when: string;
	then: string;
	covers?: string;
}

export interface ImplementationReportDoc {
	implementation_report: {
		task_id: string;
		changed_files: string[];
		added_files: string[];
		removed_files: string[];
		dependency_changes: string[];
		architecture_changes: string[];
		business_logic_changes: string[];
		tests_added: Array<{ name: string; case_id: string }>;
		tests_updated: string[];
		assumptions_used: string[];
		deviations_from_handoff: string[];
	};
}

export type Verdict = "pass" | "fail";

export interface ReviewDoc {
	review: {
		reviewer: string;
		verdict: Verdict;
		blocking_issues: Array<{ id: string; case_id?: string; description: string; evidence: string }>;
		non_blocking_issues: Array<Record<string, unknown>>;
		evidence: string[];
		required_fixes: string[];
		scope_creep_detected: string[];
		ignored?: Array<{ feedback: string; reason: string }>;
	};
}

export interface FinalReviewDoc {
	final_review: {
		task_id: string;
		verdict: Verdict;
		blocking_issues: Array<{ description: string; evidence: string; sources: string[] }>;
		required_fixes: string[];
		ignored_opinion_feedback: Array<{ feedback: string; source_reviewer?: string; reason: string }>;
		confidence: "high" | "medium" | "low";
		gates: Record<string, "pass" | "fail" | "skipped">;
		osot?: { requirement_sha256: string; handoff_sha256: string };
	};
}

export interface Gate {
	id: string;
	name: string;
	result: "pass" | "fail" | "skipped";
	evidence: string[];
}

export interface DiffResult {
	added: string[];
	removed: string[];
	changed: string[];
	/** relative path -> content in the changed tree (added/changed files only) */
	changedContents: Record<string, string>;
	unifiedText: string;
}

export interface MutantResult {
	mutant: string;
	killed: boolean;
	output: string;
}

export interface TestRunResult {
	ok: boolean;
	output: string;
}
