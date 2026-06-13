---
id: TASK-005
title: Repo-memory decoupling guard and finalization evidence regression
status: todo
createdAt: 2026-06-12T12:06:20.447Z
humanSummary: Add guards/tests proving Serena configuration/profile resolution does not trigger repo-memory full sync or alter finalization evidence semantics.
aiContext: Source PRD: docs/prd-serena-semantic-navigation.md. Planning room: serena-semantic-navigation-planning. This task is a guard lane, not a repo-memory performance rewrite. Do not change finalization-gate or completion-evidence semantics unless a failing test proves a necessary compatibility fix. Likely files/tests: semantic navigation resolver/config tests, static import check around src/index/sync.ts or repo-memory sync paths, existing finalization/completion evidence smoke tests. Areas to avoid unless required: extensions/workflow/finalization-gate.ts, extensions/workflow/delegate/completion-evidence*.ts, src/index/sync.ts.
acceptanceCriteria: - No Serena config/profile path imports or calls repo-memory syncRepo().
- Tests/static checks cover that resolving Serena profiles does not touch filesystem scanning or SQLite.
- Existing finalization/completion evidence smoke tests still pass.
- Serena references remain supporting context only and do not satisfy runtime behavior/regression evidence by themselves.
- Existing repo-memory behavior remains unchanged unless explicitly handled in a separate sprint/lane.
epic:
priority: medium
---

## Human Summary
Add guards/tests proving Serena configuration/profile resolution does not trigger repo-memory full sync or alter finalization evidence semantics.

## AI Context
Source PRD: docs/prd-serena-semantic-navigation.md. Planning room: serena-semantic-navigation-planning. This task is a guard lane, not a repo-memory performance rewrite. Do not change finalization-gate or completion-evidence semantics unless a failing test proves a necessary compatibility fix. Likely files/tests: semantic navigation resolver/config tests, static import check around src/index/sync.ts or repo-memory sync paths, existing finalization/completion evidence smoke tests. Areas to avoid unless required: extensions/workflow/finalization-gate.ts, extensions/workflow/delegate/completion-evidence*.ts, src/index/sync.ts.

## Brain Markers
<!-- brain:parallel=auto -->
<!--
  Brain marker syntax (read-only docs, not markers):
  brain:parallel=auto|required|off
  brain:deep_planning=auto|required|off
  brain:room=auto|<room-id>
  brain:agent id=backend role=backend job=backend-api owns=src/api/**
  brain:contract topic=api message="Agree request/response schema before editing."
-->

## Acceptance Criteria
- No Serena config/profile path imports or calls repo-memory syncRepo().
- Tests/static checks cover that resolving Serena profiles does not touch filesystem scanning or SQLite.
- Existing finalization/completion evidence smoke tests still pass.
- Serena references remain supporting context only and do not satisfy runtime behavior/regression evidence by themselves.
- Existing repo-memory behavior remains unchanged unless explicitly handled in a separate sprint/lane.

## Notes
