---
id: TASK-001
title: Config Model and Documentation for Serena semanticNavigation
status: done
createdAt: 2026-06-12T12:05:51.942Z
humanSummary: Add sprint scope for semanticNavigation config support: absent/disabled defaults and external Serena mode, with documentation for external MCP setup and limitations.
aiContext: Source PRD: docs/prd-serena-semantic-navigation.md. Planning room: serena-semantic-navigation-planning. MVP only supports disabled/default behavior and external Serena MCP mode. Managed mode, MCP lifecycle automation, automatic onboarding/indexing, and repo-memory rewrite are non-goals. Likely files: extensions/workflow/types.ts, extensions/workflow/config/normalize.ts, extensions/workflow/defaults.ts, docs/workflow-config-v2.md, docs/prd-serena-semantic-navigation.md. Keep runtime load paths tolerant: invalid provider/mode should report diagnostics/warnings, not crash normal config loading.
acceptanceCriteria: - Config loader accepts absent config and defaults to disabled.
epic:
priority: high
updatedAt: 2026-06-12T18:45:02.198Z
completedAt: 2026-06-12T18:45:02.198Z
---

## Human Summary
Add sprint scope for semanticNavigation config support: absent/disabled defaults and external Serena mode, with documentation for external MCP setup and limitations.

## AI Context
Source PRD: docs/prd-serena-semantic-navigation.md. Planning room: serena-semantic-navigation-planning. MVP only supports disabled/default behavior and external Serena MCP mode. Managed mode, MCP lifecycle automation, automatic onboarding/indexing, and repo-memory rewrite are non-goals. Likely files: extensions/workflow/types.ts, extensions/workflow/config/normalize.ts, extensions/workflow/defaults.ts, docs/workflow-config-v2.md, docs/prd-serena-semantic-navigation.md. Keep runtime load paths tolerant: invalid provider/mode should report diagnostics/warnings, not crash normal config loading.

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
- Config loader accepts absent config and defaults to disabled.
- Config loader accepts enabled external Serena config without TypeScript source edits.
- Invalid provider/mode emits diagnostics instead of throwing in normal load paths.
- Documentation explains external MCP setup, supported modes, non-goals, and limitations.
- Managed mode remains documented future scope, not implemented in MVP.

## Notes
- 2026-06-12T12:30:25.415Z session started
- 2026-06-12T18:45:02.198Z Implemented semanticNavigation MVP config model/docs for disabled/default and external Serena mode. Verification: `npx tsx scripts/task-001-serena-semantic-navigation-config-smokes.ts` passed, including malformed non-string provider/mode regression coverage. Disclosure: one earlier coder pane auto_exit/free-form attempt failed the evidence gate before a later explicit structured coderEvidence pass succeeded; reviewer role raw outputs approved after the fix, and Brain corrected the workflow memo/phase artifact for a verdict-parser artifact. Quality audit advisory remains: earlier auto_exit delegate plus pre-existing oversized workflow files.
