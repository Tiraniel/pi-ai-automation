# agent-harness — contract-driven multi-agent implementation flow

Prototype of a controlled implementation pipeline:

```
raw requirement
  → Requirement Intake agent   → business_requirement   (frozen, sha256 = OSOT)
  → System Architect agent     → implementation_handoff (frozen contract)
  → Coder agent                → diff + implementation_report
  → Reviewer swarm             → 5 role reviews (static gates + optional LLM)
  → Deterministic aggregator   → final_review (pass/fail)
```

Design rule: **every check that can be code IS code.** Deterministic gates
(G1–G11) enforce file allowlists, dependency freeze, report honesty, test-matrix
coverage, green tests, and mutation kills. LLM reviewers are optional add-ons for
what code can't judge (semantic drift, fake-test intent) and can only ADD
failures, never override a gate. An LLM never decides the final verdict.

## Layout

- `prompts/` — agent prompt files (intake, architect, coder, 5 reviewers, aggregator)
- `contracts/` — JSON Schemas for every artifact crossing an agent boundary
- `fixtures/` — 4 calibration fixtures for the button-loader example
- `runner/` — TypeScript runner, zero dependencies, runs on Node ≥ 23.6 (type stripping)
- `reports/` — machine- and human-readable outputs (`sample_run.*` checked in)

## Run it

```sh
# full calibration (the false-success / false-failure regression suite)
node agent-harness/runner/calibrate.ts

# single fixture through the whole flow
node agent-harness/runner/run_flow.ts agent-harness/fixtures/button_loader_success

# validate any artifact against its contract
node agent-harness/runner/validate_contracts.ts handoff.schema.json \
  agent-harness/fixtures/button_loader_success/handoff.json

# optional LLM reviewer swarm on top of the static gates
HARNESS_LLM_CMD="claude -p" node agent-harness/runner/run_flow.ts agent-harness/fixtures/button_loader_success
```

## Gates

| id | gate | catches |
|----|------|---------|
| G1 | contract_validation | malformed agent output |
| G2 | osot_freeze | handoff written against a different requirement |
| G3 | allowed_files_only | scope creep into unauthorized files |
| G4 | forbidden_files_untouched | boundary violations |
| G5 | forbidden_patterns_absent | transport/DOM/timer leaks into the controller |
| G6 | dependency_freeze | dependency/config/env drift |
| G7 | report_matches_diff | dishonest implementation reports |
| G8 | test_matrix_coverage | missing matrix cases (by tagged id) |
| G9 | tests_pass | broken implementation with honest tests |
| G10 | mutants_killed | fake/superficial tests (false success) |
| G11 | state_machine_states_present | silently dropped states |

## Calibration fixtures

| fixture | expected | proves |
|---------|----------|--------|
| `button_loader_success` | pass | correct work is accepted |
| `button_loader_failure` | fail (G9) | broken work is rejected, right attribution |
| `false_success_case` | fail (G10) | green fake tests can't smuggle a broken build |
| `false_failure_case` | pass | style variance is never a rejection reason |

`calibrate.ts` exits non-zero on any false success, false failure, or
wrong-gate attribution. Treat it as the regression suite for reviewer quality:
run it after any change to gates, prompts, or aggregation.
