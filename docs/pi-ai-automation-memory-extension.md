# pi-ai-automation-memory Extension

Global Pi extension that provides AI-facing repo context, evidence checkpointing, health reports, and index diagnostics — with a deterministic SQLite-backed index and an async hybrid keeper for file cards and integrity analysis.

## Status

**Current:** TASK-006 implemented. Hybrid keeper scheduler with single-writer lease, evidence batch claiming with crash recovery, deterministic file card generation, adaptive scheduling, and stale-card trust safeguards are operational. Append-only evidence queue, `repo_checkpoint` persistence, and pending evidence counts remain operational. SQLite-backed index, git/non-git discovery, exclusions, dirty overlay, basic status, `repo_context`, auto-brief injection, and context deduplication remain operational.

| Component | Status | Task |
|-----------|--------|------|
| Extension skeleton + tool registration | ✅ Done | TASK-002 |
| Deterministic index (SQLite, scanner, sync) | ✅ Core implemented | TASK-003 |
| `repo_context` + auto-brief | ✅ Implemented | TASK-004 |
| `repo_checkpoint` evidence queue | ✅ Implemented | TASK-005 |
| Keeper scheduler + file cards | ✅ Implemented | TASK-006 |
| Integrity consultant + health report | ⏳ Pending | TASK-007 |
| Parallel/git hardening | ✅ Implemented | TASK-008 |
| Model presets + scouts | ⏳ Pending | TASK-009 |
| OSS docs + tests | ⏳ Pending | TASK-010 |

## Install

### Global install (git — current)

```bash
pi install git:git@github.com:Tiraniel/pi-ai-automation.git
```

### Future npm

```bash
pi install npm:@tiraniel/pi-ai-automation-memory
```

After install, the extension auto-registers when Pi starts in any repo.

## AI-Facing Tools

| Tool | Purpose | Current Behavior |
|------|---------|------------------|
| `repo_context` | Bounded repo summary for agent planning | Implemented: syncs index, ranks files by query/importance/dirty state, returns file metadata, excerpts, and optional evidence with token/byte/line caps. Stale cards labeled `DO NOT TRUST`. |
| `repo_checkpoint` | Append evidence to the evidence queue | Implemented: persists redacted evidence to SQLite, records agent/task/context refs, dedupes repeated claims, marks stale context/file-hash drift, and returns queue counts. |
| `repo_health_report` | Ranked integrity/consultant report | Scaffold: returns empty findings with a status message. No LLM calls yet. Deterministic index is available via `repo_index_status`. |
| `repo_index_status` | Quick diagnostic of the deterministic index | Core implemented: syncs on demand, shows file counts, dirty/untracked state, exclusion counts, language breakdown, keeper lease, and evidence queue stats (pending/processing/stale). |

## Diagnostic Commands

- `/repo-memory-status` — Show extension status, registered tools, model preset list, and no-load-scan guarantee.

## No-Load-Scan Guarantee

The extension **does not** scan the repository, open SQLite, run `git status`, or walk the file tree on extension load. All indexing work is deferred to lazy/on-demand tool calls. This keeps Pi startup fast and avoids side effects until an agent explicitly requests context.

## Intended AI-Agent Usage

**Brain (planner):**
- Call `repo_context` before planning to get a bounded repo overview.
- Call `repo_index_status` to verify index freshness.
- After delegating to coder/reviewer, call `repo_checkpoint` to record claims and evidence.

**Coder (implementer):**
- Call `repo_context` with a `query` focused on the files being changed.
- Call `repo_checkpoint` after completing work to record what changed and why.

**Reviewer:**
- Call `repo_health_report` to surface integrity findings before or after review.
- Call `repo_context` to inspect files relevant to the review scope.

## Model Presets (Future TASK-009)

The extension defines provider-agnostic model presets:

| Preset | Purpose | Default |
|--------|---------|---------|
| `index_keeper` | Generate/update file cards | enabled |
| `scout_broad` | Cross-file pattern scan | disabled |
| `scout_deep` | Deep architectural analysis | disabled |
| `integrity_keeper` | Health findings generation | enabled |

Presets are not hard-coded to any provider. Pi's `ModelRegistry` resolves `providerHint`/`modelHint` patterns at runtime.

## Keeper Workers (TASK-006)

The keeper runs asynchronously between agent turns (triggered by `agent_end` when `keeper.runOnAgentEnd` is true):
- **File card keeper**: refreshes stale/missing cards in batches. Cards are generated deterministically (no LLM/provider yet — TASK-009). Each card stores source hash, context version, refs, excerpts, confidence, worker ID, and model preset metadata.
- **Scout runner**: runs broad/deep scans when enabled (scaffold — TASK-009).
- **Integrity consultant**: regenerates health findings when stale (scaffold — TASK-007).

A single-writer SQLite lease prevents concurrent keeper writes across multiple Pi sessions. Evidence batches are claimed with short-term leases; expired leases are automatically reclaimed on the next run.

### Deterministic / No-Provider Fallback

Until TASK-009 implements model-preset LLM integration, the keeper generates cards using deterministic local rules:
- Reads the first ~12 lines of each target file (redacted).
- Collects related evidence claims referencing the file.
- Produces a structured markdown card with metadata.
- Cards are bounded by `keeper.maxTokensPerRun` and `keeper.maxRunTimeMs`.

This fallback ensures the keeper infrastructure is testable and useful even without an LLM provider configured.

## Mutation Tracking & Stale Context (TASK-008)

- After `bash`, `edit`, or `write` tools complete, a lazy `syncRepo` is triggered via `tool_result` hook to mark status/hash/card/evidence stale. Errors are caught and logged; the hook never throws.
- `repo_context` accepts an optional `contextVersion` parameter. If provided and different from the current sync version, a top-level warning indicates stale requested context.
- Merge conflicts are detected via `git status` and reported as high-risk warnings in both `repo_context` and `repo_index_status`. Conflicted file cards are forced stale with reason `"merge conflict detected"`.
- Branch/HEAD switches reuse cards by content hash when the file content is identical, avoiding unnecessary stale marking.
- DB writes during sync are wrapped in `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` for one-writer safety.

## Limitations

- `repo_checkpoint` persists evidence with deduplication and stale marking (TASK-005).
- `repo_health_report` does not invoke LLMs or generate findings (TASK-007).
- `before_agent_start` auto-brief is implemented (TASK-004).
- Keeper scheduling adapts to active-agent count and queue pressure; health report/integrity remains pending (TASK-007).
- Keeper card generation is deterministic/local only; no LLM provider integration yet (TASK-009).
- Scout runner and integrity consultant are scaffolds (TASK-007, TASK-009).

## Security Defaults

- Default exclusions for secrets, generated artifacts, and large binaries.
- Redaction of high-entropy strings before hashing or storage.
- All data stays local in `~/.pi/agent/repo-memory/`.
- No telemetry or network syncing.

## Architecture

See [`pi-ai-automation-memory-spec.md`](./pi-ai-automation-memory-spec.md) for the full architecture, data model, tool contracts, scheduling policy, and config schema.
