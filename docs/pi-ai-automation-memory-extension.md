# pi-ai-automation-memory Extension

Global Pi extension that provides AI-facing repo context, evidence checkpointing, health reports, and index diagnostics — with a deterministic SQLite-backed index and an async hybrid keeper for file cards and integrity analysis.

## Status

**Current:** TASK-010 implemented. Public OSS docs, examples, and validation suite are complete. Integrity consultant + health report, mutation hardening, model presets/scouts, and all prior features are operational. The extension is ready for public use with deterministic/local-only fallback; external LLM provider integration for keeper/scouts is not yet wired.

| Component | Status | Task |
|-----------|--------|------|
| Extension skeleton + tool registration | ✅ Done | TASK-002 |
| Deterministic index (SQLite, scanner, sync) | ✅ Core implemented | TASK-003 |
| `repo_context` + auto-brief | ✅ Implemented | TASK-004 |
| `repo_checkpoint` evidence queue | ✅ Implemented | TASK-005 |
| Keeper scheduler + file cards | ✅ Implemented | TASK-006 |
| Integrity consultant + health report | ✅ Implemented | TASK-007 |
| Parallel/git hardening | ✅ Implemented | TASK-008 |
| Model presets + scouts | ✅ Implemented | TASK-009 |
| OSS docs + tests | ✅ Implemented | TASK-010 |

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
| `repo_health_report` | Ranked integrity/consultant report | Implemented: generates evidence-bound findings from deterministic scans, ranks by severity/task relevance/confidence, and optionally includes a Mermaid Gantt chart. No external LLM calls; all findings are local and deterministic. |
| `repo_index_status` | Quick diagnostic of the deterministic index | Core implemented: syncs on demand, shows file counts, dirty/untracked state, exclusion counts, language breakdown, keeper lease, and evidence queue stats (pending/processing/stale). |

## Diagnostic Commands

- `/repo-memory-status` — Show extension status, registered tools, model preset list, scout status, and no-load-scan guarantee.

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

## Model Presets (TASK-009)

The extension defines provider-agnostic model presets:

| Preset | Purpose | Default |
|--------|---------|---------|
| `index_keeper` | Generate/update file cards | enabled |
| `scout_broad` | Cross-file pattern scan | disabled |
| `scout_deep` | Deep architectural analysis | disabled |
| `integrity_keeper` | Health findings generation | enabled |

Presets are not hard-coded to any provider. Pi's `ModelRegistry` resolves `providerHint`/`modelHint` patterns at runtime.

User overrides can be placed in `.pi/repo-memory.json` under `modelPresets`:

```json
{
  "modelPresets": {
    "scout_broad": { "enabled": true, "budgetTokens": 50000 },
    "my_custom": { "name": "my_custom", "enabled": true, "budgetMs": 10000 }
  }
}
```

Built-in defaults remain unchanged when not overridden. For built-in presets, the object key is used as the preset name, so partial overrides are valid. Unknown preset names must define `name` explicitly.

## Keeper Workers (TASK-006)

The keeper runs asynchronously between agent turns (triggered by `agent_end` when `keeper.runOnAgentEnd` is true):
- **File card keeper**: refreshes stale/missing cards in batches. Cards are generated deterministically (no LLM/provider yet). Each card stores source hash, context version, refs, excerpts, confidence, worker ID, and model preset metadata.
- **Scout runner**: runs broad/deep scans when enabled. Uses deterministic local scanning and strict structured-output validation; disabled by default.
- **Integrity consultant**: regenerates health findings when stale (implemented; deterministic/local — TASK-007).

A single-writer SQLite lease prevents concurrent keeper writes across multiple Pi sessions. Evidence batches are claimed with short-term leases; expired leases are automatically reclaimed on the next run.

### Deterministic / No-Provider Fallback

Until an LLM provider is wired, the keeper and scout use deterministic local rules:
- **Keeper**: reads the first ~12 lines of each target file (redacted), collects related evidence claims, and produces a structured markdown card with metadata. Cards are bounded by the `index_keeper` preset budgets (min with keeper config).
- **Scout**: scans files for markers such as `TODO`, `FIXME`, `DEPRECATED`, `XXX`, `HACK`. Findings are validated for strict structure (non-empty claim, line evidence refs, confidence in `[0,1]`, `unknowns` array). Prose output is rejected.

This fallback ensures the infrastructure is testable and useful even without an LLM provider configured.

## Mutation Tracking & Stale Context (TASK-008)

- After `bash`, `edit`, or `write` tools complete, a lazy `syncRepo` is triggered via `tool_result` hook to mark status/hash/card/evidence stale. Errors are caught and logged; the hook never throws.
- `repo_context` accepts an optional `contextVersion` parameter. If provided and different from the current sync version, a top-level warning indicates stale requested context.
- Merge conflicts are detected via `git status` and reported as high-risk warnings in both `repo_context` and `repo_index_status`. Conflicted file cards are forced stale with reason `"merge conflict detected"`.
- Branch/HEAD switches reuse cards by content hash when the file content is identical, avoiding unnecessary stale marking.
- DB writes during sync are wrapped in `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` for one-writer safety.

## Limitations

- Keeper card generation is deterministic/local only; no LLM provider integration yet.
- Scout runner uses deterministic local scanning and strict structured-output validation; no LLM provider integration yet.
- Integrity consultant generates evidence-bound findings deterministically; no external LLM provider integration yet.
- No built-in dashboard; data is plain SQLite and JSONL.
- `repo_health_report` Gantt chart is simple Markdown/Mermaid and optional (`includeGantt: true`).

## Security Defaults

- Default exclusions for secrets, generated artifacts, and large binaries.
- Redaction of high-entropy strings before hashing or storage.
- All data stays local in `~/.pi/agent/repo-memory/`.
- No telemetry or network syncing.

## Architecture

See [`pi-ai-automation-memory-spec.md`](./pi-ai-automation-memory-spec.md) for the full architecture, data model, tool contracts, scheduling policy, and config schema.
