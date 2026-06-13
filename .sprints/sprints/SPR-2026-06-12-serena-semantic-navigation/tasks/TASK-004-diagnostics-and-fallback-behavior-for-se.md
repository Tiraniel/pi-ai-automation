---
id: TASK-004
title: Diagnostics and fallback behavior for Serena setup
status: todo
createdAt: 2026-06-12T12:06:13.425Z
humanSummary: Expose warnings/details for inconsistent Serena configuration and make fallback-to-builtins behavior visible and non-breaking.
aiContext: Source PRD: docs/prd-serena-semantic-navigation.md. Planning room: serena-semantic-navigation-planning. Diagnostics should explain enabled Serena with empty expected tool lists, unknown provider/mode, and fallback behavior. Missing Serena tools must not break default workflow when fallbackToBuiltinTools is true. If Pi exposes registered MCP tool introspection safely, use it read-only; otherwise document that live registry inspection is future scope. Likely files: extensions/workflow/config/normalize.ts, extensions/workflow/config/resolve.ts, docs/workflow-config-v2.md, tests/smoke scripts.
acceptanceCriteria: - Enabled Serena with no configured tool names produces a warning/diagnostic.
- Unknown provider/mode produces a diagnostic in normal load paths.
- Resolved config/details surface fallbackToBuiltinTools behavior.
- Missing Serena tools do not break default workflow when fallback is enabled.
- Diagnostics avoid requiring Serena installation for normal tests.
epic:
priority: medium
---

## Human Summary
Expose warnings/details for inconsistent Serena configuration and make fallback-to-builtins behavior visible and non-breaking.

## AI Context
Source PRD: docs/prd-serena-semantic-navigation.md. Planning room: serena-semantic-navigation-planning. Diagnostics should explain enabled Serena with empty expected tool lists, unknown provider/mode, and fallback behavior. Missing Serena tools must not break default workflow when fallbackToBuiltinTools is true. If Pi exposes registered MCP tool introspection safely, use it read-only; otherwise document that live registry inspection is future scope. Likely files: extensions/workflow/config/normalize.ts, extensions/workflow/config/resolve.ts, docs/workflow-config-v2.md, tests/smoke scripts.

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
- Enabled Serena with no configured tool names produces a warning/diagnostic.
- Unknown provider/mode produces a diagnostic in normal load paths.
- Resolved config/details surface fallbackToBuiltinTools behavior.
- Missing Serena tools do not break default workflow when fallback is enabled.
- Diagnostics avoid requiring Serena installation for normal tests.

## Notes
