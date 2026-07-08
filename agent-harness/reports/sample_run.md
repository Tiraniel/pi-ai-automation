# Sample run — calibration suite

Command: `node agent-harness/runner/calibrate.ts`
Frozen OSOT: requirement `sha256:7783c765…b74f1db3d415`, handoff `sha256:b2e0cf88…ffff9494fe84`

## Calibration matrix

| fixture | expected | actual | failed gates | classification |
|---------|----------|--------|--------------|----------------|
| button_loader_success | pass | pass | — | calibrated |
| button_loader_failure | fail | fail | G9 tests_pass | calibrated |
| false_success_case | fail | fail | G10 mutants_killed | calibrated |
| false_failure_case | pass | pass | — | calibrated |

Result: **CALIBRATED — 0 false successes, 0 false failures.**

## What each row proves

- **button_loader_success (PASS)** — correct controller + honest tests covering
  S1, S2, F1, FS1, FF1. All 11 gates green, all 3 mutants killed. The harness
  accepts correct work.
- **button_loader_failure (FAIL on G9)** — the coder "forgot" the failure path:
  on rejection the button stays blocked, no failure toast. The honest test suite
  fails on the broken build. The harness rejects broken work for the right reason
  (`must_fail_gates: ["G9"]` verified).
- **false_success_case (FAIL on G10)** — the dangerous one. The implementation
  shows a SUCCESS toast on failure, and the tests are fake: every matrix id is
  tagged, every test is green, coverage-by-name looks perfect. G8 passes. G9
  passes. Only the mutation gate catches it: all three known-broken mutants
  survive the fake suite, proving the tests cannot detect a broken
  implementation. Verdict FAIL with evidence naming each surviving mutant.
- **false_failure_case (PASS)** — behaviorally identical implementation written
  in a style a taste-based reviewer would reject (switch instead of lookup
  table, boolean flag, verbose comments). Every gate compares contract fields to
  observable facts, so style produces zero findings. The harness does not reject
  correct work.

## Excerpt — false_success_case blocking issue

> **mutants_killed gate failed** — SURVIVING MUTANT: tests pass on broken
> implementation never-disables-button.ts | SURVIVING MUTANT: tests pass on
> broken implementation wrong-failure-toast.ts | SURVIVING MUTANT: tests pass on
> broken implementation double-submit.ts
> _(source: test_reviewer, business_logic_reviewer)_

Full machine-readable reports: `reports/<fixture>.final_review.json` (validates
against `contracts/final_review.schema.json`); human-readable twins in
`reports/<fixture>.final_review.md`.
