---
id: TASK-003
title: Role-specific Serena prompt guidance
status: done
createdAt: 2026-06-12T12:06:07.080Z
humanSummary: Add config-gated Brain/Coder/Reviewer prompt guidance for semantic navigation without weakening validation or delegation rules.
aiContext: Source PRD: docs/prd-serena-semantic-navigation.md. Planning room: serena-semantic-navigation-planning. Guidance must be role-specific and only present when Serena is enabled for that role. Brain: orientation and self-contained delegation. Coder: symbol/reference lookup first, exact file inspection before edits, validation required after changes. Reviewer: changed symbols/references/diagnostics review coverage, not behavior proof. Likely files: extensions/workflow/prompts.ts and prompt tests/snapshots if present.
acceptanceCriteria: - Brain guidance emphasizes orientation, architecture understanding, and concrete file/symbol refs before delegation.
epic:
priority: high
updatedAt: 2026-06-13T09:54:51.700Z
completedAt: 2026-06-13T09:54:51.700Z
---

## Human Summary
Add config-gated Brain/Coder/Reviewer prompt guidance for semantic navigation without weakening validation or delegation rules.

## AI Context
Source PRD: docs/prd-serena-semantic-navigation.md. Planning room: serena-semantic-navigation-planning. Guidance must be role-specific and only present when Serena is enabled for that role. Brain: orientation and self-contained delegation. Coder: symbol/reference lookup first, exact file inspection before edits, validation required after changes. Reviewer: changed symbols/references/diagnostics review coverage, not behavior proof. Likely files: extensions/workflow/prompts.ts and prompt tests/snapshots if present.

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
- Brain guidance emphasizes orientation, architecture understanding, and concrete file/symbol refs before delegation.
- Coder guidance requires exact built-in file inspection before final edits and validation commands after semantic edits.
- Reviewer guidance treats Serena output as review coverage, not behavioral evidence.
- Serena guidance is absent when semanticNavigation is disabled or role is not enabled.
- Existing non-Serena prompts remain behavior-compatible.

## Notes
- 2026-06-13T08:32:40.209Z session started
- 2026-06-13 Phase B: added RED runtime smoke coverage for `getAgentPreset` semanticNavigation guidance, wired prompt composition through runtime config, and documented role-gated prompt/evidence boundaries.
- 2026-06-13T09:08:03.799Z Finalization retry with explicit delegate-history disclosure. Initial Phase A coder attempt was rejected by the matrix gate because headless completion provided only free-form text and no structured coderEvidence; this was a workflow/evidence handoff issue, not an implementation failure. Brain temporarily enabled pane delegation, re-delegated Phase A, and coder supplied structured coderEvidence; Phase A reviewer swarm approved. Phase B coder supplied structured coderEvidence and Phase B reviewer swarm approved. Quality audit high finding disclosed: TASK-003 reviewer pane pane-mqc4kez9-6oc87d auto-exited without sub_agent_done, but the generated reviewer memo still recorded APPROVED for all required roles with no changes requested. Fresh final checks passed: TASK-003 smoke, TASK-001 smoke, TASK-002 smoke, and scoped git diff --check.
- 2026-06-13T09:18:49.955Z session started
- 2026-06-13 focused fix after reviewer CHANGES_REQUESTED: added runtime smoke coverage for explicit empty/partial semanticNavigation roles maps, changed normalizer so provided roles maps turn omitted/invalid known roles off before deep merge, documented omitted roles behavior, and reran TASK-003/TASK-001/TASK-002 smokes plus scoped git diff --check.
- 2026-06-13T09:54:51.700Z AFK delivery complete for TASK-003. Final verification passed: `npx tsx --conditions import scripts/task-003-serena-prompt-guidance-smokes.ts`, `npx tsx --conditions import scripts/task-001-serena-semantic-navigation-config-smokes.ts`, `npx tsx --conditions import scripts/task-002-serena-tool-profiles-smokes.ts`, and scoped `git diff --check`. Reviewer approved all required roles in `.pi/workflow-runs/reviewer-memos/task-003-afk-recertification-phaseA.md`. AFK report: `.pi/workflow-runs/afk-ship/afk-task-003-20260613091847-54z5py/REPORT.md`. Workflow quality audit: `.pi/workflow-runs/quality-audit/TASK-003-quality-audit-summary.json`. Disclosure: earlier delegate evidence attempts included auto_exit/free-form sidecar handoff problems and retries; these were mitigated by explicit structured coderEvidence sidecar `pane-mqc62s1t-3hlpsm`, focused fix attempt 2, independent reviewer approval, and fresh Brain-run checks.
