# pi-ai-automation-memory Extension

Global Pi extension that provides AI-facing repo context, evidence checkpointing, health reports, and index diagnostics — with a deterministic SQLite-backed index and an async hybrid keeper for file cards and integrity analysis.

## Status

**Current:** TASK-002 scaffold (MVP skeleton). No indexing, SQLite, LLM calls, or keeper scheduling is implemented yet.

| Component | Status | Task |
|-----------|--------|------|
| Extension skeleton + tool registration | ✅ Done | TASK-002 |
| Deterministic index (SQLite, scanner, sync) | ⏳ Pending | TASK-003 |
| `repo_context` + auto-brief | ⏳ Pending | TASK-004 |
| `repo_checkpoint` evidence queue | ⏳ Pending | TASK-005 |
| Keeper scheduler + file cards | ⏳ Pending | TASK-006 |
| Integrity consultant + health report | ⏳ Pending | TASK-007 |
| Parallel/git hardening | ⏳ Pending | TASK-008 |
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
| `repo_context` | Bounded repo summary for agent planning | Scaffold: returns metadata and a status message. No scan performed. |
| `repo_checkpoint` | Append evidence to the evidence queue | Scaffold: validates input, returns `recorded: false`, `storage: pending TASK-005`. |
| `repo_health_report` | Ranked integrity/consultant report | Scaffold: returns empty findings with a status message. No LLM calls. |
| `repo_index_status` | Quick diagnostic of the deterministic index | Scaffold: returns placeholder counts (all zero) and metadata. |

All tools explicitly state they are scaffold stubs and defer real work to future tasks.

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

## Keeper Workers (Future TASK-006)

The keeper runs asynchronously between agent turns:
- File card keeper: refreshes stale/missing cards in batches.
- Scout runner: runs broad/deep scans when enabled.
- Integrity consultant: regenerates health findings when stale.

A single-writer SQLite lease prevents concurrent keeper writes across multiple Pi sessions.

## Scaffold Limitations

- No deterministic index: `repo_index_status` returns all zeros.
- No evidence persistence: `repo_checkpoint` accepts but does not store.
- No LLM calls: `repo_health_report` never invokes a model.
- No auto-brief: `before_agent_start` is a no-op.
- No keeper runs: `agent_end` trigger is a no-op.
- No SQLite or cache files are created.

## Security Defaults (Future)

- Default exclusions for secrets, generated artifacts, and large binaries.
- Redaction of high-entropy strings before hashing or storage.
- All data stays local in `~/.pi/agent/repo-memory/`.
- No telemetry or network syncing.

## Architecture

See [`pi-ai-automation-memory-spec.md`](./pi-ai-automation-memory-spec.md) for the full architecture, data model, tool contracts, scheduling policy, and config schema.
