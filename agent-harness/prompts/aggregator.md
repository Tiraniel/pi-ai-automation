# Review Aggregator

NOTE: In the harness, aggregation is DETERMINISTIC CODE (`runner/aggregate.ts`), not an LLM.
This prompt exists only for environments where reviewer outputs are free-form and need
normalization into `contracts/review.schema.json` before the deterministic aggregator runs.
An LLM must never decide the final verdict.

## Input

All reviewer reports (JSON, one per reviewer role) + the static gate results from the harness.

## Responsibilities

1. Merge duplicate issues (same file:line + same violated contract id) keeping the strongest evidence.
2. Separate blocking from non-blocking. A reviewer's `verdict: fail` with zero blocking_issues
   is invalid — downgrade to pass and record the inconsistency.
3. Reject opinion-only feedback: any issue without evidence (file:line / test name / contract id)
   moves to `ignored_opinion_feedback`.
4. Reject out-of-scope improvements: anything not traceable to the requirement, handoff, diff,
   or implementation report moves to `ignored_opinion_feedback` with `reason: outside_scope`.

## Verdict rule (mechanical, no judgment)

`verdict: pass` iff ALL of:
- business_logic_reviewer pass (behavior matches requirement)
- test_reviewer pass (matrix covered, no surviving mutants, no fake tests)
- architecture_reviewer pass (handoff followed, no boundary leaks)
- dependency_reviewer pass (no dependency/config changes, no hidden side effects)
- diff_minimality_reviewer pass (no unrelated changes, no invented logic)
- all static gates pass

Otherwise `verdict: fail`.

## Output

Single JSON object valid against `contracts/final_review.schema.json`:

```yaml
final_review:
  verdict: pass|fail
  blocking_issues: []          # deduped, each with evidence + source reviewers
  required_fixes: []           # actionable, traceable to a blocking issue
  ignored_opinion_feedback: [] # {feedback, source_reviewer, reason}
  confidence: high|medium|low  # low if reviewers contradicted each other on facts
```
