# Domain glossary — pi-ai-automation

Ubiquitous language for this repo. Architecture reviews and refactors use these
terms; when a module is named after a concept, the concept lives here.

## Delegation triad

- **Brain** — the orchestrating agent: plans, delegates, never edits code when a
  coder/reviewer path exists.
- **coder** — implements exactly the delegated task; produces structured
  **coder evidence** checked by the completion-evidence gate.
- **reviewer** — read-only verifier; responds with a **reviewer verdict**.
- **delegate** — a headless/pane child Pi process running one role
  (`delegate_to_coder`, `delegate_to_reviewer`).

## Reviewer protocol (`extensions/workflow/reviewer-protocol.ts`)

- **reviewer role** — one of the closed set: `implementation`, `evidence-test`,
  `behavior`, `regression`, `maintainability`, `docs-config`. Declared once in
  the reviewer-protocol module; everything else imports it.
- **reviewer verdict** — `APPROVED` / `CHANGES_REQUESTED` / `UNKNOWN`; a
  reviewer must lead its response with one. `parseReviewerVerdict`
  (reviewer-protocol) is fail-closed: APPROVED counts only when it leads the
  first non-empty line; a buried APPROVED parses as UNKNOWN; CHANGES_REQUESTED
  anywhere still blocks. Finalization reads the structured memo JSON sidecar,
  not a re-parse of the memo markdown.
- **reviewer swarm** — parallel per-role reviewers; **role mode** is forced for
  matrix-gated plans, **legacy mode** covers configured targets/goals.
- **reviewer memo** — consolidated markdown verdict record under
  `.pi/workflow-runs/reviewer-memos/<planId>-<phase>.md`; file IO owned by
  `delegate/reviewer-memo-file.ts`.

## Gates

- **planning gate** — PRD-first state machine (`prd_started` →
  `prd_ready_for_sprint` → `sprint_confirmed` → `implementation_confirmed`)
  blocking sprint/implementation entry points.
- **architecture gate** — phaseA (isolated blocks) / phaseB (integration)
  advancement over an architecture plan.
- **acceptance evidence matrix** — per-criterion required evidence + reviewer
  roles on a `ready` plan; a plan with matrix rows is **matrix-gated**.
- **completion-evidence gate** — fail-closed check of coder evidence. Since
  WP2 it also *verifies* the packet: `filesChanged` is compared against the
  real workspace diff snapshotted around the coder run (G7,
  `evidence_diff_mismatch` / `diff_unverifiable`), and claimed-passed runnable
  evidence commands are re-run by the gate itself (G9,
  `evidence_rerun_failed` / `evidence_rerun_unverifiable`; bounded by an
  allowlist + command cap, `evidence.rerun` config). Owned by
  `delegate/evidence-verification.ts` + `delegate/completion-evidence.ts`.
- **finalization gate** — strict final check before a task is marked done.
- **quality audit** — advisory post-hoc scan persisted under
  `.pi/workflow-runs/quality-audit/`.

## Sprint substrate

- **sprint** — durable task board under `.sprints/` (config, current pointer,
  task files, PROGRESS.md).
- **lane** — automation lane: `full-sprint` | `hotfix` | `debug`
  (vocabulary owned by `extensions/sprint/lane-policy.ts`).
- **ship / AFK ship** — supervised delivery run under
  `.pi/workflow-runs/afk-ship/<runId>/`.
- **debug escalation** — rule codes DBG-001…DBG-006 deciding when a debug item
  must be promoted to a real task.
- **marker** — `<!-- brain:… -->` annotations in task files parsed by
  `extensions/sprint/markers.ts`.

## Rooms & runs

- **room** — durable async coordination queue under
  `.pi/workflow-runs/<roomId>/` (`ROOM_DIR_NAME` owned by
  `extensions/workflow/rooms/types.ts`).
- **workflow-runs root** — `.pi/workflow-runs/`; resolve via
  `getWorkflowRunsRoot`, never by re-joining the literal.

## agent-harness (prototype)

- **contract** — frozen JSON-schema artifact crossing an agent seam.
- **OSOT** — one source of truth: requirement/handoff bytes frozen by sha256.
- **gate (G1–G11)** — deterministic checks; LLM review can only add failures.
