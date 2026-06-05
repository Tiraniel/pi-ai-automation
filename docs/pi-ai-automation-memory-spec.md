# pi-ai-automation-memory — Implementation Specification

> **Status:** Pre-implementation approval spec. No code has been written.  
> **Scope:** Define architecture, data model, tool contracts, scheduling, security defaults, and config schema so that future tasks (TASK-002 through TASK-010) have an unambiguous blueprint.  
> **Target:** Global Pi extension / public `pi-package`.

---

## 1. Goals and Non-Goals

### Goals
- Provide an **AI-first global Pi extension** that gives every Brain/agent turn fast, accurate, bounded repo context.
- **Auto-compact repo brief** injected before Brain planning via `before_agent_start`.
- Maintain a **deterministic, git-aware index** in a global cache so repos are not rescanned every session.
- Collect **append-only evidence** from agents (claims, references, test results, confidence) into an evidence queue.
- Run an **async hybrid keeper** that refreshes file cards and runs deeper integrity analysis between turns.
- Surface **ranked health reports** and optional **simple Markdown/Mermaid Gantt** via an integrity consultant.
- Respect **parallel-agent safety**: one writer, many readers, branch/HEAD/dirty tracking, context versioning.
- Be **provider-agnostic** via model presets (not hard-coded to Gonka or any single provider).

### Non-Goals (Explicit)
- **No dashboard.** There is no web UI, no TUI panel, no real-time status screen. Output is text/Markdown/Mermaid only.
- **No telemetry.** The extension does not phone home, report usage, or send data to external services. All data stays local.
- **Secret-safe / local-first.** No secret content is stored in the index or evidence queue. Default exclusions prevent indexing of credential files, env files, and generated artifacts.
- No background network syncing. No cloud storage backends.
- No sub-agent orchestration. This extension provides context and evidence, not agent spawning.

---

## 2. Public Package / Extension Structure

Intended as a public `pi-package` installable via `pi install npm:@tiraniel/pi-ai-automation-memory` (or git equivalent).

```
pi-ai-automation-memory/
├── package.json                 # pi-package manifest; keywords: ["pi-package"]
├── README.md                    # OSS docs (TASK-010)
├── docs/
│   └── pi-ai-automation-memory-spec.md   # this file
├── schemas/
│   └── repo-memory.schema.json  # JSON Schema for .pi/repo-memory.json
├── examples/
│   └── repo-memory.default.json # Valid example config
├── src/
│   ├── index.ts                 # Extension entry point (default export factory)
│   ├── tools/
│   │   ├── repo_context.ts      # repo_context tool implementation
│   │   ├── repo_checkpoint.ts   # repo_checkpoint tool implementation
│   │   ├── repo_health_report.ts# repo_health_report tool implementation
│   │   └── repo_index_status.ts # repo_index_status tool implementation
│   ├── index/
│   │   ├── db.ts                # SQLite connection, migrations, WAL setup
│   │   ├── scanner.ts           # File tree scanner (gitignore, exclusions, hashing)
│   │   ├── importer.ts          # Import/package root detection
│   │   └── sync.ts              # Deterministic sync: compare tree to DB, update
│   ├── keeper/
│   │   ├── scheduler.ts         # Hybrid keeper scheduling, leases
│   │   ├── file_card_keeper.ts  # Per-file card generation/refresh
│   │   └── scout_runner.ts      # Scout preset execution
│   ├── evidence/
│   │   ├── queue.ts             # Append-only evidence queue, dedupe, stale marking
│   │   └── validator.ts         # Structured evidence validation
│   ├── integrity/
│   │   ├── consultant.ts        # Ranked health report generation
│   │   └── gantt.ts             # Optional Markdown/Mermaid Gantt output
│   ├── brief/
│   │   └── auto_brief.ts        # before_agent_start brief injection
│   ├── config/
│   │   ├── loader.ts            # .pi/repo-memory.json loading + schema validation
│   │   └── defaults.ts          # Hard-coded defaults
│   ├── models/
│   │   └── presets.ts           # Provider-agnostic preset definitions
│   ├── git/
│   │   ├── state.ts             # Git root, branch, HEAD, dirty, untracked detection
│   │   └── overlay.ts           # Dirty/untracked/conflict overlay tracking
│   ├── cache/
│   │   └── paths.ts             # Global cache path resolution (~/.pi/agent/repo-memory/)
│   └── security/
│       ├── exclusions.ts        # Default exclusion lists
│       └── redaction.ts         # Secret redaction helpers
└── tests/                       # Unit + integration tests (TASK-010)
```

**Extension registration:**
- `src/index.ts` exports a default factory `(pi: ExtensionAPI) => void | Promise<void>`.
- Registers four tools via `pi.registerTool()`.
- Subscribes to `before_agent_start`, `agent_end`, `session_shutdown`.
- Does **not** scan the repo on extension load. Scanning is lazy/on-demand.

---

## 3. Runtime Architecture / Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Pi Session                                  │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐  │
│  │   Brain     │   │   Coder     │   │  Reviewer   │   │   User      │  │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘  │
│         │                 │                 │                 │         │
│         └─────────────────┴─────────────────┴─────────────────┘         │
│                                   │                                     │
│                    before_agent_start (auto brief)                      │
│                                   │                                     │
│         ┌─────────────────────────┼─────────────────────────┐           │
│         ▼                         ▼                         ▼           │
│  ┌─────────────┐           ┌─────────────┐           ┌─────────────┐    │
│  │repo_context │           │repo_check-  │           │repo_health_ │    │
│  │  (tool)     │           │  point      │           │   report    │    │
│  └──────┬──────┘           └──────┬──────┘           └──────┬──────┘    │
│         │                         │                         │           │
│         └─────────────────────────┴─────────────────────────┘           │
│                                   │                                     │
│                    ┌──────────────┴──────────────┐                      │
│                    ▼                              ▼                     │
│         ┌─────────────────┐            ┌─────────────────┐              │
│         │ Deterministic   │            │   Evidence      │              │
│         │   Index (SQLite)│            │     Queue       │              │
│         │   WAL mode      │            │  (append-only)  │              │
│         │   ~/.pi/agent/  │            │                 │              │
│         │   repo-memory/  │            │                 │              │
│         └─────────────────┘            └─────────────────┘              │
│                    ▲                              ▲                     │
│                    │         ┌──────────────┐     │                     │
│                    │         ▼              ▼     │                     │
│                    │  ┌─────────────┐  ┌─────────────┐                  │
│                    └──┤ File Cards  │  │  Integrity  │                  │
│                       │ (keeper)    │  │ Consultant  │                  │
│                       └─────────────┘  └─────────────┘                  │
│                              ▲                                          │
│                              │                                          │
│                       ┌─────────────┐                                   │
│                       │ Keeper      │                                   │
│                       │ Scheduler   │                                   │
│                       │ (async)     │                                   │
│                       └─────────────┘                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

**Data flow rules:**
1. **Deterministic index** is refreshed synchronously on first tool call or `before_agent_start` if the cached tree is stale (git HEAD changed, file mtimes changed, config changed). It is fast and runs in the agent turn.
2. **Evidence queue** is append-only. Agents write evidence; no agent ever overwrites or deletes another agent's evidence.
3. **Keeper** runs asynchronously between turns (or during idle time). It never blocks an agent turn. It produces/updates file cards in the index DB.
4. **Integrity consultant** runs on demand (via `repo_health_report` tool) or as part of keeper scheduling. It reads cards + evidence, produces ranked findings. It does not mutate the index.
5. **All secret content is redacted** before entering the index or evidence queue.

---

## 4. Data Model (SQLite)

Database path: `~/.pi/agent/repo-memory/<repo-key>/index.sqlite`

`<repo-key>` is a deterministic safe identifier derived from the absolute path of the repo root (e.g., base64url of the normalized path, truncated). One DB per repo.

SQLite is opened with WAL mode (`PRAGMA journal_mode = WAL;`) for parallel-read safety. The extension uses a single writer connection (keeper + sync) and many short-lived reader connections (tool calls).

### 4.1 Tables

#### `repo_meta` — One row per repo
| Column | Type | Description |
|--------|------|-------------|
| `repo_key` | TEXT PRIMARY KEY | Deterministic repo identifier |
| `repo_root` | TEXT NOT NULL | Absolute path to repo root |
| `git_root` | TEXT | Absolute path to git root (may equal repo_root or be a parent) |
| `current_branch` | TEXT | Git branch name at last sync |
| `current_head` | TEXT | Git HEAD commit SHA at last sync |
| `is_dirty` | INTEGER (0/1) | Whether working tree had uncommitted changes at last sync |
| `has_untracked` | INTEGER (0/1) | Whether untracked files existed at last sync |
| `has_conflicts` | INTEGER (0/1) | Whether merge conflicts existed at last sync |
| `last_sync_at` | INTEGER (ms epoch) | Timestamp of last deterministic sync |
| `last_keeper_run_at` | INTEGER (ms epoch) | Timestamp of last keeper completion |
| `context_version` | TEXT NOT NULL | Deterministic version string representing the state of the index at last sync. Format: `<head-sha>[-dirty][-untracked]` or `nogit-<content-hash>` for non-git dirs. |
| `config_hash` | TEXT NOT NULL | Hash of `.pi/repo-memory.json` at last sync |

#### `files` — One row per tracked file
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Surrogate key |
| `repo_key` | TEXT NOT NULL | FK to repo_meta |
| `relative_path` | TEXT NOT NULL | Path relative to repo_root |
| `absolute_path` | TEXT NOT NULL | Absolute path |
| `content_hash` | TEXT NOT NULL | SHA-256 of file content (after redaction) |
| `size_bytes` | INTEGER | File size in bytes |
| `mtime_ms` | INTEGER | Last modified time (ms epoch) |
| `is_gitignored` | INTEGER (0/1) | Whether file is gitignored |
| `is_generated` | INTEGER (0/1) | Whether file matches generated-artifact patterns |
| `is_secret` | INTEGER (0/1) | Whether file matches secret-exclusion patterns |
| `language` | TEXT | Detected language (from extension or shebang) |
| `package_root` | TEXT | Nearest package root (e.g., directory with package.json, pyproject.toml) |
| `last_indexed_at` | INTEGER (ms epoch) | When this row was last updated by deterministic sync |
| `card_freshness` | TEXT | `fresh`, `stale`, `missing` — see §4.2 |
| `card_content` | TEXT | LLM-generated file card (summary, API surface, dependencies) |
| `card_generated_at` | INTEGER (ms epoch) | When card was generated |
| `card_model_preset` | TEXT | Which model preset generated the card |
| `card_token_budget` | INTEGER | Tokens consumed generating the card |
| `imports_hash` | TEXT | Hash of detected imports/exports for this file |

Unique constraint: `(repo_key, relative_path)`.

#### `imports` — Many-to-many file dependency map
| Column | Type | Description |
|--------|------|-------------|
| `from_file_id` | INTEGER NOT NULL | FK to files.id |
| `to_file_id` | INTEGER | FK to files.id (NULL if unresolved/external) |
| `import_path` | TEXT NOT NULL | Raw import string |
| `import_type` | TEXT | `relative`, `package`, `builtin`, `alias` |

Index on `(from_file_id)`, `(to_file_id)`.

#### `evidence` — Append-only evidence queue
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Surrogate key |
| `repo_key` | TEXT NOT NULL | FK to repo_meta |
| `context_version` | TEXT NOT NULL | Index context_version when evidence was recorded |
| `agent_id` | TEXT NOT NULL | Identifies the agent (e.g., `brain`, `coder`, `reviewer`) |
| `agent_run_id` | TEXT NOT NULL | Unique run identifier (session + turn) |
| `recorded_at` | INTEGER (ms epoch) | Timestamp |
| `claim` | TEXT NOT NULL | Short claim string |
| `evidence_refs` | TEXT (JSON array) | File paths / line refs supporting the claim |
| `test_refs` | TEXT (JSON array) | Test names / files that validate the claim |
| `review_refs` | TEXT (JSON array) | Review comments / PR refs |
| `confidence` | REAL (0.0–1.0) | Agent-reported confidence |
| `changed_files` | TEXT (JSON array) | Files changed in this turn |
| `metadata` | TEXT (JSON object) | Arbitrary agent metadata (bounded size) |
| `is_stale` | INTEGER (0/1) DEFAULT 0 | Set to 1 when context_version drifts |
| `stale_reason` | TEXT | Why marked stale |
| `dedupe_key` | TEXT NOT NULL | Deterministic key for deduplication `(repo_key, agent_id, claim_hash, time_window_bucket)` where `time_window_bucket` is floored to `evidenceQueue.dedupeWindowHours` |

Unique constraint: `UNIQUE(repo_key, dedupe_key)` — later identical evidence is ignored.
Index on `(repo_key, context_version)`, `(repo_key, is_stale)`.

#### `health_findings` — Integrity consultant output
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `repo_key` | TEXT NOT NULL | |
| `generated_at` | INTEGER (ms epoch) | |
| `context_version` | TEXT NOT NULL | |
| `severity` | TEXT | `critical`, `warning`, `info`, `ok` |
| `category` | TEXT | `test_coverage`, `type_safety`, `doc_freshness`, `dependency_risk`, `architectural_drift`, `security` |
| `finding` | TEXT NOT NULL | Human-readable finding |
| `evidence_refs` | TEXT (JSON array) | Related evidence IDs |
| `file_refs` | TEXT (JSON array) | Related file paths |
| `rank` | INTEGER | Sort order (lower = more important) |
| `model_preset` | TEXT | Which preset generated this |

Index on `(repo_key, severity, rank)`.

#### `keeper_leases` — Single-writer lease tracking
| Column | Type | Description |
|--------|------|-------------|
| `repo_key` | TEXT PRIMARY KEY | |
| `lease_holder` | TEXT | Process ID + timestamp |
| `leased_at` | INTEGER (ms epoch) | |
| `expires_at` | INTEGER (ms epoch) | Lease expiration |

Used to prevent multiple Pi processes from running keeper writes concurrently.

### 4.2 Freshness / Stale Semantics

| State | Meaning | Trigger |
|-------|---------|---------|
| `fresh` | Card matches current file content_hash and context_version | Card was generated after the latest sync for this file |
| `stale` | File content_hash changed since card generation, or context_version drifted | Deterministic sync detects `content_hash` mismatch, or git HEAD changed |
| `missing` | File exists in index but has no card yet | Never generated, or card was pruned |

**Stale cards are never trusted.**

**Rule: stale cards are never trusted.** Tools that return card content must mark it as `fresh` or `stale`. The LLM must be told explicitly when data is stale.

**Evidence staleness:** Evidence rows are marked `is_stale = 1` when the current `context_version` differs from the evidence's `context_version`. This is a lazy check at read time, not a background sweep.

---

## 5. AI-Facing Tool Contracts

All tools are registered via `pi.registerTool()`. Outputs are bounded/truncated. The extension uses `truncateHead`/`truncateTail` from `@earendil-works/pi-coding-agent` with the same limits as built-in tools (50KB / 2000 lines).

### 5.1 `repo_context`

**Purpose:** Return a bounded, structured summary of the repo for the current agent turn.

**Parameters (TypeBox schema):**
```typescript
Type.Object({
  query: Type.Optional(Type.String({ description: "Optional focus query to rank relevance" })),
  maxFiles: Type.Optional(Type.Integer({ default: 30, description: "Max files to include" })),
  maxTokens: Type.Optional(Type.Integer({ default: 8000, description: "Approximate token budget for response" })),
  includeCards: Type.Optional(Type.Boolean({ default: true, description: "Include file cards if fresh" })),
  includeEvidence: Type.Optional(Type.Boolean({ default: false, description: "Include recent evidence items" })),
})
```

**Behavior:**
1. Trigger deterministic index sync if stale (HEAD changed, mtime changed, config changed). Sync is synchronous and fast (seconds for <10k files).
2. Compute file relevance:
   - If `query` provided, rank by path match, import graph proximity, and card keyword overlap.
   - If no query, return package roots, config files, recently changed files, and files with stale cards.
3. Include for each file:
   - `relative_path`
   - `content_hash` (short)
   - `size_bytes`
   - `language`
   - `card_freshness`: `"fresh" | "stale" | "missing"`
   - `card_content` (only if `includeCards` and `fresh`; if `stale`, include a one-line stale warning instead)
   - Key imports/exports (bounded list)
4. If `includeEvidence`, append up to 20 most recent non-stale evidence items with `claim`, `confidence`, `changed_files`.
5. Append metadata block:
   - `context_version`
   - `git_branch`, `git_head`, `is_dirty`, `has_untracked`, `has_conflicts`
   - `repo_root`
   - `index_freshness_ms` (how old the deterministic sync is)

**Output format:** Structured Markdown with clear section headers. Truncated if it exceeds token budget; truncation is noted explicitly.

**Trust rules:**
- Cards marked `stale` are explicitly labeled "DO NOT TRUST — file may have changed".
- If `is_dirty` or `has_untracked`, a warning banner is included.
- If `has_conflicts`, the tool returns an error-level notice at the top.

### 5.2 `repo_checkpoint`

**Purpose:** Append evidence about the current agent turn to the evidence queue.

**Parameters:**
```typescript
Type.Object({
  contextVersion: Type.Optional(Type.String({ description: "Index context_version this evidence applies to. If omitted, the current version is used." })),
  agentId: Type.Optional(Type.String({ description: "Agent identifier (e.g., 'brain', 'coder'). Derived from the Pi session if omitted." })),
  agentRole: Type.Optional(Type.String({ description: "Agent role in this turn (e.g., 'planner', 'implementer', 'reviewer')." })),
  agentRunId: Type.Optional(Type.String({ description: "Unique run identifier (session + turn). Derived from the Pi session if omitted." })),
  taskId: Type.Optional(Type.String({ description: "Active task identifier, if any." })),
  claim: Type.String({ description: "Short claim about what was done or learned" }),
  evidenceRefs: Type.Optional(Type.Array(Type.String(), { description: "File paths or line refs supporting claim" })),
  testRefs: Type.Optional(Type.Array(Type.String(), { description: "Tests that validate the claim" })),
  reviewRefs: Type.Optional(Type.Array(Type.String(), { description: "Reviews or PR refs" })),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.8 })),
  changedFiles: Type.Optional(Type.Array(Type.String(), { description: "Files modified in this turn" })),
  metadata: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Bounded agent metadata" })),
})
```

**Behavior:**
1. Read current `context_version` from `repo_meta`.
2. If `contextVersion` is provided, compare it to the current `context_version`. If it matches, use it. If it mismatches, record the evidence with `is_stale = 1` and `stale_reason = "context_version mismatch: provided <provided> vs current <current>"`. If `contextVersion` is omitted, fill in the current `context_version`.
3. Derive `agent_id`, `agent_run_id`, and `agent_role` from the active Pi session / environment when omitted.
4. Compute `dedupe_key` = hash of `(repo_key, agent_id, claim, time_window_bucket)` where `time_window_bucket` is derived from `recorded_at` floored to `evidenceQueue.dedupeWindowHours`.
5. Insert into `evidence` table if `dedupe_key` does not already exist for the current window.
6. Return:
   - `recorded: true/false`
   - `deduplicated: true/false`
   - `context_version`
   - `recorded_at`
   - `stale_warning: true/false` (set if a context_version mismatch was detected)

**Mutability:** This is the **only** mutating tool in the MVP. It only appends; it never updates or deletes. It does not use `withFileMutationQueue` because it writes to SQLite, not to repo files.

**Security:** `metadata` is recursively scanned for likely secrets (regex patterns) and redacted before storage. `claim` and `evidenceRefs` are also scanned. If redaction occurs, the response includes a `redacted: true` flag.

### 5.3 `repo_health_report`

**Purpose:** Return a ranked integrity/consultant report.

**Parameters:**
```typescript
Type.Object({
  maxFindings: Type.Optional(Type.Integer({ default: 20, description: "Max findings to return" })),
  includeGantt: Type.Optional(Type.Boolean({ default: false, description: "Include simple Markdown/Mermaid Gantt" })),
  categories: Type.Optional(Type.Array(Type.String(), { description: "Filter by category" })),
  minSeverity: Type.Optional(Type.String({ default: "info", enum: ["ok", "info", "warning", "critical"] })),
  forceRefresh: Type.Optional(Type.Boolean({ default: false, description: "Bypass cache and regenerate findings" })),
})
```

**Behavior:**
1. If health findings in DB are stale (older than config `integrity.maxAgeMs` or context_version mismatch), trigger an on-demand integrity consultant run. This may call an LLM with a model preset; it is bounded by token/time budgets.
2. Read findings from `health_findings` filtered by `categories` and `minSeverity`, sorted by `rank`.
3. Return structured Markdown:
   - Executive summary (counts by severity)
   - Ranked findings list with `severity`, `category`, `finding`, `file_refs`, `evidence_refs`
   - Optional Gantt chart (Markdown/Mermaid) if `includeGantt` is true. The Gantt is simple: milestones as tasks, no nested sections, no external dependencies.
4. If consultant run is skipped because another process holds the keeper lease, return cached findings with a `stale: true` warning.

**Trust rules:**
- Findings include the `context_version` they were generated against.
- If `context_version` differs from current, findings are prefixed with a stale warning.
- Findings are advisory; they do not block agent execution.

### 5.4 `repo_index_status`

**Purpose:** Quick diagnostic of the deterministic index state.

**Parameters:**
```typescript
Type.Object({})
```

**Behavior:**
1. Return metadata from `repo_meta`:
   - `repo_root`, `git_root`, `current_branch`, `current_head`
   - `is_dirty`, `has_untracked`, `has_conflicts`
   - `context_version`
   - `last_sync_at`, `last_keeper_run_at`
   - `config_hash`
2. Return counts from `files`:
   - `total_files`, `fresh_cards`, `stale_cards`, `missing_cards`
   - `gitignored_files`, `secret_excluded_files`, `generated_excluded_files`
3. Return evidence queue stats:
   - `total_evidence`, `stale_evidence`
4. Return keeper lease status:
   - `keeper_leased_by`, `lease_expires_at`

**Output format:** Compact Markdown table + summary. No LLM call. Fast (<100ms).

---

## 6. Automatic Brain Repo Brief (`before_agent_start`)

The extension subscribes to `before_agent_start` and injects a compact repo brief as a persistent message.

**Behavior:**
1. Check if auto-brief is enabled in config (`autoBrief.enabled`). Default: `true`.
2. Check cooldown: do not regenerate if the last brief was generated within `autoBrief.minIntervalMs` (default: 30s) **and** context_version has not changed.
3. If cache miss, run a fast path equivalent to `repo_context` with:
   - `maxFiles: 20`
   - `maxTokens: 4000`
   - `includeCards: true`
   - `includeEvidence: false`
4. Format as a brief Markdown block (not a tool result; injected as a `message` with `customType: "repo-memory-brief"`).
5. The brief includes:
   - One-line repo identity (`repo_root`, branch, HEAD short SHA, dirty/untracked flags)
   - File count, language breakdown (top 5)
   - Key directories / package roots
   - Files with stale cards ( flagged for attention )
   - `context_version` and brief generation timestamp

**Bounded output:** The brief is truncated to `autoBrief.maxTokens` (default 4000). If truncated, it ends with `[Brief truncated: use repo_context tool for full details]`.

**No session pollution:** The auto Brain brief is bounded and must not accumulate large permanent session pollution. If the implementation injects the brief as a persistent custom message (`repo-memory-brief`), older messages of the same type must be compacted, suppressed, or replaced so that only the most recent brief remains active. The brief message must stay small (within `autoBrief.maxTokens`).

**No blocking:** The brief generation uses cached index data only. It does not wait for keeper or scouts. If the index needs sync, sync runs synchronously but is optimized to be fast.

---

## 7. Git / Tree Semantics

### 7.1 Git Root Detection
- Walk up from `cwd` looking for `.git` directory.
- `repo_root` = the directory where `.pi/repo-memory.json` exists, or `cwd` if absent.
- `git_root` = the directory containing `.git`, which may be `repo_root` or an ancestor (monorepo case).
- If no `.git` exists, `git_root` is NULL and the repo is treated as non-git.

### 7.2 Branch / HEAD / Dirty / Untracked
- Determined by `git status --porcelain=v1 -uall`, `git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD`.
- `is_dirty`: any entry in `git status` that is not `??` (untracked).
- `has_untracked`: any `??` entry.
- `has_conflicts`: any entry with status codes indicating merge conflict (e.g., `UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD`).
- These are snapshotted at sync time, not live.

### 7.3 Non-Git Directories
- For non-git dirs, `context_version` = `nogit-<root-content-hash>` where `root-content-hash` is a Merkle-like hash of all tracked file hashes.
- Sync still runs (mtimes + content hashes), but there is no branch/HEAD tracking.

### 7.4 Content-Hash Reuse
- During sync, if `mtime_ms` and `size_bytes` match the DB row, the content hash is assumed unchanged and not re-read.
- If mtime or size changed, the file is re-read, redacted, and re-hashed.
- This makes re-sync fast for large repos with few changes.

### 7.5 Context Version
- `context_version` is a deterministic string that changes whenever the repo state changes in a way that invalidates cached inferences.
- Git repos: `<head-sha>[-dirty][-untracked][-conflicts]`
- Non-git repos: `nogit-<merkle-hash>`
- Cards and evidence are tagged with the `context_version` at generation time.
- If current `context_version` != card/evidence `context_version`, the card/evidence is considered stale.

### 7.6 Dirty / Untracked Overlays
- Dirty files are included in the index (their current content is hashed), but a flag tracks that they differ from HEAD.
- Untracked files are included if they do not match exclusion patterns. They are marked `is_gitignored = false` but tracked as untracked in `repo_meta`.
- Conflicted files are included with a warning flag. Their content hash reflects the working-tree state (including conflict markers). The `repo_context` tool warns about conflicted files.

---

## 8. Scheduling Policy

### 8.1 Deterministic Index (Synchronous)
- Runs **synchronously** in the agent turn when:
  - `before_agent_start` needs a brief and index is stale
  - Any tool call needs current data and index is stale
- Uses fast heuristics (mtime, size, git status) to avoid re-hashing unchanged files.
- Target: <2s for repos with <50k files on SSD.
- Uses SQLite WAL; readers do not block on sync writes.

### 8.2 Hybrid Keeper (Asynchronous)
- Runs **asynchronously** between turns or during idle time.
- Components:
  - **File Card Keeper:** Generates/updates file cards. Prioritizes files with `missing` or `stale` cards. Processes in batches.
  - **Scout Runner:** Runs provider-agnostic scout presets (e.g., `scout_broad`, `scout_deep`) to find cross-file patterns, TODOs, architectural risks.
  - **Integrity Consultant:** Generates `health_findings` if enabled and stale.
- Scheduling:
  - Triggered by `agent_end` event (after a turn completes).
  - Checks keeper lease in `keeper_leases`. If lease is held by another process and not expired, skip.
  - If lease is free or expired, acquire lease with TTL = `keeper.leaseDurationMs` (default: 5 min).
  - Run one unit of work (e.g., one batch of file cards, or one scout run) bounded by `keeper.maxRunTimeMs` (default: 30s) and `keeper.maxTokensPerRun` (default: 50k).
  - Release lease when done or when time budget exhausted.
  - If the agent starts a new turn while keeper is running, keeper is **not** aborted. It continues in the background because it only reads repo files and writes to its own SQLite DB.

### 8.3 Single Writer Rule
- Only one process holds the keeper lease at a time.
- The deterministic sync (synchronous) does **not** need the keeper lease. It writes to `files` and `repo_meta`, but it is short-lived and WAL-safe.
- The keeper (async) holds the lease while writing cards and findings.
- Evidence queue writes (`repo_checkpoint`) do not need the lease. They are small, fast inserts.

### 8.4 Heavy Parallel Activity Behavior
- If multiple Pi sessions are open on the same repo (e.g., multiple terminals, or parallel agents):
  - All can read the index concurrently (WAL readers).
  - Only one runs the keeper at a time (lease).
  - Deterministic sync may run concurrently from multiple sessions; WAL handles this safely. If two sessions sync simultaneously, the later commit wins; conflicts are benign because sync is deterministic (same inputs → same outputs).
  - Evidence queue inserts from multiple sessions are safe (append-only, dedupe key prevents duplicates).

---

## 9. Parallel-Agent / Concurrency Rules

1. **Branch/HEAD changes:** If git HEAD changes between turns, the next sync updates `context_version`. All cards and evidence from the old context_version are marked stale. The brief reflects the new branch.
2. **Dirty overlays:** Dirty files are re-hashed during sync. Their cards are marked stale if content changed. The brief warns about dirty state.
3. **Conflicts:** Conflicted files are tracked. `repo_context` warns. `repo_health_report` may flag conflicts as critical findings.
4. **Untracked files:** Included in index if not excluded. Marked in `repo_meta.has_untracked`. Brief notes untracked count.
5. **Bash / edit / write side effects:** The extension does not intercept these. It relies on deterministic sync to detect changes at the next tool call. There is no attempt to watch filesystem events.
6. **Context version mismatch:** If a tool call references a `context_version` that does not match current, the tool returns data with a stale warning. It does not reject the call.
7. **One writer / many readers:**
   - SQLite WAL mode provides many readers.
   - Keeper lease ensures one writer for card/finding generation.
   - Sync writes are short and safe under WAL.
   - Evidence inserts are small and safe.

---

## 10. Security / Privacy Defaults

### 10.1 Default Exclusions
The scanner skips files matching these patterns (in addition to `.gitignore`):
- Secret/credential files: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.aws/`, `.ssh/`, `credentials*`, `secrets*`, `*.secret`, `*.token`, `*.passwd`
- Generated artifacts: `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`, `*.min.js`, `*.min.css`, `*.map`
- Large binaries: `*.zip`, `*.tar.gz`, `*.png`, `*.jpg`, `*.gif`, `*.mp4`, `*.pdf`, `*.woff*`, `*.ttf`
- Lock files (optional, configurable): `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`
- IDE/local configs: `.vscode/`, `.idea/`, `*.iml`
- OS files: `.DS_Store`, `Thumbs.db`

### 10.2 Redaction
- Before hashing or storing file content in cards, run a lightweight redaction pass:
  - Regex for high-entropy strings (>40 chars, alphanumeric + symbols) that look like API keys, tokens, passwords.
  - Regex for common secret patterns (`aws_access_key_id`, `private_key`, `password`, `secret`, `token` followed by `=` or `:` and a value).
- Redacted content is replaced with `[REDACTED:<hash-prefix>]` so the redaction is stable across runs.
- Redaction happens **before** hashing, so the content hash is of redacted content, not raw secrets.
- Redaction is applied to cards, evidence claims, and evidence metadata. It is **not** applied to the raw files on disk.

### 10.3 No Secret Content Storage
- The extension never stores raw file contents in the database. Only hashes, mtimes, sizes, and redacted cards are stored.
- Evidence queue stores claims and references, not file contents.
- If a file is marked `is_secret = 1`, its card generation is skipped entirely.

### 10.4 Local-First
- All data stays in `~/.pi/agent/repo-memory/`. No cloud upload, no remote sync.
- The extension does not read environment variables for remote service credentials (except those needed for the LLM provider, which Pi already manages).

---

## 11. Model Preset Config

Model presets are provider-agnostic definitions of how to invoke an LLM for a specific memory task. They are **not** hard-coded to Gonka or any single provider.

### 11.1 Preset Structure
```typescript
type ModelPreset = {
  name: string;                    // e.g., "scout_broad", "index_keeper", "integrity_keeper"
  description: string;
  providerHint?: string;           // Optional preferred provider (e.g., "anthropic", "openai")
  modelHint?: string;              // Optional preferred model pattern (e.g., "claude-sonnet-*")
  temperature?: number;            // Default 0.2 for deterministic tasks
  maxTokens?: number;              // Output token limit
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  systemPrompt?: string;           // Task-specific system prompt override
  enabled: boolean;                // Default false for scouts, true for keeper
  budgetMs?: number;               // Max wall-clock time for this preset call
  budgetTokens?: number;           // Max input+output tokens for this preset call
  fallbackBehavior: "error" | "skip" | "degrade"; // What to do if model unavailable
};
```

### 11.2 Built-In Presets
| Preset | Purpose | Default Enabled | Budget Defaults |
|--------|---------|-----------------|-----------------|
| `index_keeper` | Generate/update file cards | true | 30s, 16k tokens |
| `scout_broad` | Cross-file pattern scan, TODO find | false | 60s, 32k tokens |
| `scout_deep` | Deep architectural analysis | false | 120s, 64k tokens |
| `integrity_keeper` | Health findings generation | true | 60s, 32k tokens |

### 11.3 Graceful Degradation
- If a preset is disabled (`enabled: false`), the task is skipped. No error.
- If a preset is enabled but no matching model is available (no API key, no matching model in registry):
  - `fallbackBehavior: "skip"` → skip the task silently.
  - `fallbackBehavior: "degrade"` → fall back to a cheaper/available model if one can be found.
  - `fallbackBehavior: "error"` → log an error and skip.
- Default fallback for all presets: `"skip"`.

### 11.4 Not Gonka-Specific
- Presets do not reference Gonka model IDs, Gonka endpoints, or Gonka-specific parameters.
- Provider/model hints are patterns, not exact IDs. Pi's `ModelRegistry` is used for resolution.

---

## 12. Integrity Consultant Behavior

### 12.1 Principles Source
- The consultant reads principles from:
  1. `.pi/repo-memory.json` `integrity.principles` array.
  2. `AGENTS.md` / `CLAUDE.md` context files (if they contain principle-like sections).
  3. Default built-in principles (test coverage, type safety, doc freshness, dependency risk, architectural drift, security).

### 12.2 Evidence-Bound Findings
- Every finding must cite evidence from the evidence queue (`evidence_refs`).
- Findings without evidence are marked `severity: "info"` and noted as "inferred, no direct evidence."
- Findings are ranked by:
  1. Severity (`critical` > `warning` > `info` > `ok`)
  2. Number of supporting evidence items
  3. Confidence of supporting evidence
  4. Recency of evidence

### 12.3 Ranked Health Reports
- `repo_health_report` returns findings sorted by `rank`.
- The consultant regenerates findings only when:
  - No findings exist for the current `context_version`.
  - Findings are older than `integrity.maxAgeMs`.
  - Explicitly requested by tool parameter `forceRefresh: true`.

### 12.4 Optional Gantt Output
- If `includeGantt: true`, the consultant appends a simple Markdown/Mermaid Gantt chart.
- The Gantt shows:
  - Key milestones (e.g., "Test coverage gap closed", "Type safety achieved")
  - Estimated timeline based on evidence history
  - Current position marker
- Constraints: simple tasks only, no nested sections, no external dependency links, no interactive elements. Pure Markdown/Mermaid text.

---

## 13. Config Schema Summary

Config file: `.pi/repo-memory.json` (project-local, optional). If absent, hard-coded defaults are used.

### 13.1 Top-Level Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | true | Master switch for the extension |
| `cache` | object | see below | Global cache settings |
| `indexing` | object | see below | Deterministic index behavior |
| `memory` | object | see below | Card/evidence retention |
| `autoBrief` | object | see below | Automatic Brain brief |
| `tools` | object | see below | Tool defaults |
| `evidenceQueue` | object | see below | Evidence queue behavior |
| `keeper` | object | see below | Keeper scheduling |
| `integrity` | object | see below | Integrity consultant |
| `modelPresets` | object | see below | Model preset definitions |
| `security` | object | see below | Security/privacy settings |
| `output` | object | see below | Output formatting |

### 13.2 Sub-Object Defaults

**`cache`**
- `basePath`: `"~/.pi/agent/repo-memory"` (resolved to absolute path)
- `maxSizeMb`: `1024`
- `pruneAgeDays`: `90`

**`indexing`**
- `respectGitignore`: `true`
- `defaultExclusions`: `[".env*", "*.pem", "node_modules/", "dist/", ...]` (see §10.1)
- `additionalExclusions`: `[]` (user-supplied glob patterns)
- `maxFileSizeBytes`: `1048576` (1 MB)
- `includeLockfiles`: `false`
- `languages`: `[]` (empty = auto-detect all)

**`memory`**
- `maxCardsPerRepo`: `10000`
- `maxEvidencePerRepo`: `5000`
- `cardRetentionDays`: `90`
- `evidenceRetentionDays`: `180`

**`autoBrief`**
- `enabled`: `true`
- `maxTokens`: `4000`
- `minIntervalMs`: `30000`
- `includeCards`: `true`
- `includeEvidence`: `false`

**`tools`**
- `repo_context.maxFiles`: `30`
- `repo_context.maxTokens`: `8000`
- `repo_health_report.maxFindings`: `20`
- `repo_health_report.includeGanttDefault`: `false`
- `repo_health_report.forceRefreshDefault`: `false`

**`evidenceQueue`**
- `enabled`: `true`
- `maxClaimLength`: `500`
- `maxMetadataSizeBytes`: `4096`
- `dedupeWindowHours`: `168` (7 days)

**`keeper`**
- `enabled`: `true`
- `leaseDurationMs`: `300000` (5 min)
- `maxRunTimeMs`: `30000` (30s)
- `maxTokensPerRun`: `50000`
- `batchSize`: `10` (files per card batch)
- `runOnAgentEnd`: `true`
- `fileCardPriority`: `["missing", "stale", "fresh"]`

**`integrity`**
- `enabled`: `true`
- `maxAgeMs`: `3600000` (1 hour)
- `principles`: `[]` (user-defined principle strings)
- `defaultCategories`: `["test_coverage", "type_safety", "doc_freshness", "dependency_risk", "architectural_drift", "security"]`

**`modelPresets`**
- Object map of preset name → `ModelPreset` (see §11.1).
- Defaults include `index_keeper`, `integrity_keeper` enabled; `scout_broad`, `scout_deep` disabled.

**`security`**
- `redactionEnabled`: `true`
- `redactionPatterns`: `[]` (additional regex strings)
- `secretExclusions`: `[]` (additional glob patterns)
- `allowSecretFilesInIndex`: `false` (if true, secret files are indexed but not carded)

**`output`**
- `defaultTruncationLimitBytes`: `51200` (50KB)
- `defaultTruncationLimitLines`: `2000`
- `includeHashInOutput`: `false` (include content hashes in tool output)

### 13.3 Example Config File
See `examples/repo-memory.default.json`.

---

## 14. MVP Milestones Mapped to Future Tasks

| Task | Milestone | Acceptance from this spec |
|------|-----------|---------------------------|
| **TASK-002** | Extension/package skeleton | Package structure, `pi.extensions` manifest, tool registration stubs, no scan on load |
| **TASK-003** | Deterministic index | SQLite schema, WAL, scanner, gitignore, exclusions, content-hash reuse, `repo_index_status` |
| **TASK-004** | `repo_context` / auto brief | Tool contract, `before_agent_start` brief injection, bounded output, freshness rules |
| **TASK-005** | `repo_checkpoint` evidence queue | Append-only SQLite table, dedupe, stale marking, redaction, no secrets |
| **TASK-006** | Keeper scheduler | Async keeper, lease table, batch card generation, token/time budgets, `agent_end` trigger |
| **TASK-007** | Integrity consultant | `repo_health_report` tool, ranked findings, evidence-bound, optional Gantt |
| **TASK-008** | Parallel/git hardening | Branch/HEAD/dirty/conflict tracking, context_version rules, one-writer/many-reader |
| **TASK-009** | Model presets/scouts | Preset config schema, provider-agnostic hints, graceful degradation, budgets |
| **TASK-010** | OSS docs | README, examples, tests — spec already defines what to document |

---

## 15. Open Questions / Approval Checklist

- [ ] **Schema approval:** Is the `repo-memory.schema.json` strict enough? Are any keys missing?
- [ ] **Default exclusions:** Are the secret/generated patterns in §10.1 appropriate? Should lockfiles be excluded by default?
- [ ] **Token budgets:** Are the default token/time budgets (30s/16k for keeper, 60s/32k for integrity) reasonable for typical repos?
- [ ] **Gantt complexity:** Is the "simple Markdown/Mermaid only" constraint sufficient? Should we allow any other output format?
- [ ] **Model preset hints:** Should we include any default provider/model hints, or leave them entirely blank to force user configuration?
- [ ] **Cache location:** Is `~/.pi/agent/repo-memory/` the right global cache path? Should it respect `PI_CODING_AGENT_DIR`?
- [ ] **Non-git behavior:** Is the `nogit-<merkle-hash>` context_version format acceptable?
- [ ] **Redaction aggressiveness:** Should high-entropy string redaction be opt-in rather than default?
- [ ] **Approval:** Once this spec is approved, implementation will proceed in TASK-002 through TASK-010 in order. Any task can be skipped or reordered by agreement.
