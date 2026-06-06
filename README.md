# pi-ai-automation

Sharable Pi package for a `brain -> coder -> reviewer` workflow with an MVP global sprint substrate and durable async workflow rooms.

## Install

```bash
pi install git:git@github.com:Tiraniel/pi-ai-automation.git
```

Then run Pi normally in a repo:

```bash
pi
```

The extensions auto-apply the Brain preset (unless disabled), inject Brain orchestration instructions, add delegate tools, add a sprint system, and register workflow-room tools.

Workflow tools:
- `delegate_to_coder`
- `delegate_to_reviewer` (supports optional `goals` for targeted reviewer swarm)
- `room_create`, `room_job_start`, `room_send`, `room_read`, `room_job_done`, `room_status`

Delegated agents run as headless JSON subprocesses (`--mode json -p --no-session`) and stream bounded live events back to the parent. The parent Pi terminal renders delegate progress using theme-colored sections (status, tools, thinking indicators, assistant output previews, usage, and final output). Thinking/reasoning content from child agents is shown as a sanitized indicator (`thinking…`) rather than raw hidden chain-of-thought. There is no nested interactive TUI inside the child; rendering is handled by the parent using Pi extension rendering/theme APIs.

## Defaults

- **brain**: `openai-codex/gpt-5.5` thinking `xhigh`. Brain orchestrates planning and delegation; it does **not** take over code edits when coder fails or reviewer returns `CHANGES_REQUESTED`. Instead, it re-delegates a focused fix back to coder (or a room worker) and then re-reviews. Brain may do read-only diagnosis/planning/admin only, and direct edits are limited to tiny non-code/admin cases.
- **coder**: `openai-codex/gpt-5.3-codex` thinking `medium`, tools `read,bash,edit,write,grep,find,ls,room_create,room_job_start,room_send,room_read,room_job_done,room_status`, and **Karpathy Guidelines included by default**
- **reviewer**: `openai-codex/gpt-5.5` thinking `high`, tools `read,bash,grep,find,ls,room_create,room_job_start,room_send,room_read,room_job_done,room_status` (read-only)
- **reviewerSwarm**: enabled by default, runs targeted reviewer subprocesses (parallelized with `maxConcurrency`) across configured targets or explicit `goals`

Child delegates run with:
- `--mode json --print --no-session`
- preset `--model`, `--thinking`, and `--tools`
- `PI_WORKFLOW_CHILD=1` to prevent recursive Brain behavior in child sessions
- `PI_WORKFLOW_ROOM_ROOT`, `PI_WORKFLOW_ROOM_ID`, `PI_WORKFLOW_AGENT_ID`, `PI_WORKFLOW_AGENT_ROLE` when delegated with `room` context; the root points at the parent's `.pi/workflow-runs` so a delegated child with a sub-`cwd` still shares the same room store (see [Workflow Rooms v1](#workflow-rooms-v1))

## Configuration override

Config is deep-merged in this order:
1. Package defaults
2. Global `~/.pi/agent/workflow.json`
3. Nearest project `.pi/workflow.json`
4. Optional built-in workflow profile layer, applied at the source that selected it:
   - global `profile`: package defaults → profile → global → project
   - project `profile`: package defaults → global → profile → project
   - CLI `--workflow-profile`: package defaults → global → project → profile

That means a profile selected in `.pi/workflow.json` can override older global defaults, while fields in the same project file still win over the profile. See [`examples/workflow.json`](./examples/workflow.json).

Reviewer swarm behavior:
- If `reviewerSwarm.enabled` is `true` (default), `delegate_to_reviewer` runs one read-only reviewer per goal.
- Pass `goals` to `delegate_to_reviewer` to review acceptance criteria explicitly.
- Without `goals`, configured `reviewerSwarm.targets` are used.
- If any target reviewer fails or returns `CHANGES_REQUESTED`, the delegation result is marked failed.
- Set `reviewerSwarm.enabled: false` to keep single-reviewer behavior.

To disable Karpathy Guidelines for delegated coder prompts in overrides:

```json
{
  "agents": {
    "coder": {
      "includeKarpathyGuidelines": false
    }
  }
}
```

`autoApplyBrain: false` disables automatic Brain model/thinking/status application. To disable the workflow extension for a single Pi run, use:

```bash
pi --workflow-agent none
```

## Delegate display/transport modes (cmux pane support)

By default, delegated agents run as **headless** JSON subprocesses (`--mode json -p --no-session`). You can opt into launching them in a **visible cmux pane** for observability and manual inspection.

### Modes

- **`headless`** (default): child runs as a subprocess; parent tails stdout for structured events. CI-safe and works everywhere.
- **`pane`**: child runs in a visible cmux terminal surface. Parent still receives structured results by tailing a session JSONL file and polling a done sidecar — the pane is for human visibility, not screen scraping.
- **`auto`**: uses pane when cmux is available, otherwise falls back to headless.

### Enabling pane mode

Set in `~/.pi/agent/workflow.json` or `.pi/workflow.json`:

```json
{
  "delegateDisplay": "pane"
}
```

Or override per run with the env var:

```bash
PI_WORKFLOW_DELEGATE_DISPLAY=pane pi
```

Valid values: `headless`, `pane`, `auto`. The env var takes precedence over config.

### How pane mode works

1. Parent creates a temp run directory with:
   - `session.jsonl` — child Pi session file written by `--session`
   - `done.json` — sidecar written by the child when it calls `workflow_delegate_done`
   - `run.sh` — generated shell script that launches the child Pi session
2. Parent opens a new cmux terminal surface in the **same workspace/pane** (`cmux new-surface --type terminal`, scoped by `cmux identify --json` context) and sends a shell script into it that sets up env vars and runs Pi with `--session <sessionFile>` so the child renders its real TUI in the cmux tab.
3. Parent tails the session JSONL for finalized messages/tool calls (not streaming events) and polls `done.json` for completion.
4. The child gets a pane-specific instruction in its system prompt to call `workflow_delegate_done` after producing its final handoff.
5. On abort, parent sends Escape to the pane.
6. By default, the surface is **auto-closed** when the sub-agent finishes (success, failure, or abort). Set `delegatePaneAutoClose: false` to leave it open for inspection.

### Requirements and limitations

- **cmux must be running** and `CMUX_SOCKET_PATH` must be set (or discoverable). If cmux is unavailable and mode is `pane`, the delegate returns a clear failed result. `auto` silently falls back to headless.
- **API keys must be available to the pane shell** via its own environment, Pi auth, or `~/.pi/.env`. The generated pane script only exports workflow-specific env vars and does not copy arbitrary parent secrets into `/tmp`.
- **Surfaces auto-close by default** after the child finishes. Set `delegatePaneAutoClose: false` to keep them open for inspection.
- **Initial support is cmux-only.** tmux/zellij are not implemented unless very cheap to add later.
- **Reviewer swarm** works with pane mode too — each reviewer target may open its own pane when cmux is available.

## Opt-in Gonka hybrid profile

`extensions/brain-workflow.ts` registers a **`gonka`** provider that points at an OpenAI-compatible broker (`https://node.gonka.lat/v1` by default, override with `GONKA_BROKER_URL`) and ships an opt-in **`gonka-hybrid`** profile. The profile keeps Brain on the current premium default and only swaps the workers, so it is safe to enable without changing how the user talks to the Brain session.

When no profile is set, defaults are exactly the same as before — registering the provider and the profile machinery is a no-op for existing users.

### Enabling the profile

Pick one of:

```bash
# Ad-hoc: one Pi run on the Gonka hybrid workers
pi --workflow-profile gonka-hybrid
```

Project-scoped: drop this into `.pi/workflow.json` (or `~/.pi/agent/workflow.json` for global):

```json
{ "profile": "gonka-hybrid" }
```

`--workflow-profile` takes precedence over the config and applies after global/project config, so it is a true one-off switch for the current run. The alias `premium-brain-gonka-workers` is also accepted. The flag is forwarded to child delegates so the Gonka coder/reviewer model follows the parent session end-to-end.

### Required Gonka credentials

The `gonka` provider is registered unconditionally, but its models are only usable when `GONKA_BROKER_API_KEY` is available. Pi first respects values already exported in the shell, then falls back to `~/.pi/.env` for the Gonka keys so child delegates inherit them automatically. Set `GONKA_BROKER_URL` too when using a broker other than the default:

| Env var | Purpose |
| --- | --- |
| `GONKA_BROKER_URL` | Optional OpenAI-compatible broker base URL; defaults to `https://node.gonka.lat/v1`. |
| `GONKA_BROKER_API_KEY` | Required bearer token sent as the `Authorization` header. |

`/workflow` shows `set`/`default` for the URL and `set`/`unset` for the key without printing the values. Explicit shell values take precedence over `~/.pi/.env`; missing or unreadable `.env` files are ignored.

### Models in the profile

| Worker | Provider / model | Thinking | Notes |
| --- | --- | --- | --- |
| Brain | `openai-codex/gpt-5.5` (xhigh) — **unchanged from default** | on (xhigh) | Profile does not touch Brain. |
| Coder | `gonka/moonshotai/Kimi-K2.6` | off | Best validated coder; Karpathy Guidelines + existing coder tools kept. |
| Reviewer | `gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8` | off | Best validated primary reviewer; existing reviewer tools kept. |
| (Optional diversity reviewer) | `gonka/MiniMaxAI/MiniMax-M2.7` | off | Registered for experimentation, **not** used by the built-in profile. See caveat below. |

`Thinking: off` is the Pi setting for these Gonka workers. Some brokers/models may still stream provider reasoning metadata (for example `reasoning_content` from Kimi); Pi handled this in smoke tests, but do not interpret `off` as a guarantee that the upstream model will never emit reasoning metadata.

See [`examples/workflow.gonka-hybrid.json`](./examples/workflow.gonka-hybrid.json) for a minimal opt-in project config.

### Structured tool-call gate

The three broker models pass the OpenAI Chat Completions **auto/default** `tool_choice` test on the current broker (`/v1/chat/completions` returns `finish_reason=tool_calls` and a `message.tool_calls` entry with parsed JSON args; two-turn tool-result roundtrip works). This is the gate for using Gonka as a Pi coder/reviewer — without it, delegations fall back to plain text or refusals, which is unusable for tool-driven workflows.

### `MiniMax-M2.7` forced `tool_choice` caveat

`MiniMaxAI/MiniMax-M2.7` passes the auto/default `tool_choice` test but **fails** when the client forces a tool call: the broker pollutes `function.arguments` with visible `<think>` text, which fails `JSON.parse` and breaks structured tool calls. If you experiment with `MiniMax-M2.7` as a diversity reviewer, keep `tool_choice` at the default (auto) — do **not** force tool choice. Kimi K2.6 and Qwen3-235B do not have this caveat and work with both auto and forced `tool_choice`.

### Example: opt in for one project

```bash
mkdir -p .pi
cp examples/workflow.gonka-hybrid.json .pi/workflow.json
# Put GONKA_BROKER_API_KEY (and optionally GONKA_BROKER_URL) in ~/.pi/.env,
# or export them in this shell, then:
pi
```

The project-local `profile: "gonka-hybrid"` field is the project's source of truth; the CLI flag overrides it for the current run if you want to A/B test. To leave the profile but pin one worker back to a different model, override `agents.coder` / `agents.reviewer` in the same `.pi/workflow.json` — those fields win over the built-in profile.

## Workflow Rooms v1

Workflow Rooms are a **durable async coordination queue** for delegated sub-agents. They let a `brain` (or a future planner agent) hand work to multiple specialised sub-agents — e.g. backend + frontend, planner + implementer, or independent reviewers — and let them exchange assumptions, contracts, blockers, and decisions at job boundaries **without real-time interruption**.

v1 is intentionally minimal:

- No WebSocket server, no live interruption. Messages queue on disk and agents read them at `room_job_start` / `room_read` / `room_job_done` checkpoints.
- The event log is a plain append-only `events.jsonl` with a monotonic `seq`. It is dashboard-friendly (one JSON object per line) so a future UI can tail it directly.
- Per-agent state (read cursor, status, role) lives in `agents.json`. Tools use a small `.lock` file with `O_EXCL` open + bounded retry to serialise cross-process writes.

### Storage layout

```
.pi/workflow-runs/
  current.json                 # last created/active room pointer
  <roomId>/
    events.jsonl               # append-only events (room_created | job_start | message | job_done)
    agents.json                # per-agent state (lastReadSeq, status, role)
    .lock                      # transient cross-process lock
```

Event shape (each line in `events.jsonl`):

```json
{
  "seq": 7,
  "roomId": "auth-refactor",
  "type": "message",          // room_created | job_start | message | job_done
  "from": "backend",          // optional sender
  "to": "frontend",           // optional; omit to broadcast
  "topic": "schema",          // optional
  "body": "Use camelCase in the /users payload, not snake_case.",
  "jobId": "backend-auth",    // set on job_start/job_done
  "summary": "...",
  "owns": ["src/api/**"],     // advisory ownership on job_start
  "filesChanged": ["src/api/auth.ts"],
  "testsRun": ["pnpm test src/api"],
  "createdAt": "2026-06-04T08:33:00.000Z"
}
```

### Room tools

Registered in **both** brain and child sessions (room tools are intentionally not gated on `PI_WORKFLOW_CHILD` so sub-agents can call them):

| Tool | Purpose |
| --- | --- |
| `room_create({ roomId?, title? })` | Create or re-activate a room. Sets the active room in `.pi/workflow-runs/current.json`. Returns structured `details: { roomId, roomDir }` for tool chaining. |
| `room_job_start({ jobId, summary?, owns?, roomId?, agentId?, role? })` | Register the calling agent's job. `agentId`/`role` fall back to `PI_WORKFLOW_AGENT_ID`/`PI_WORKFLOW_AGENT_ROLE` env. |
| `room_send({ to?, topic?, message, roomId?, agentId? })` | Append a message. Omit `to` to broadcast; set to a specific `agentId` to direct it. |
| `room_read({ afterSeq?, markRead?, limit?, roomId?, agentId? })` | Return events after a cursor. `markRead: true` (default) advances the agent's `lastReadSeq` to the **max seq among the returned events** (never past unreturned ones). If `afterSeq` is ahead of the stored cursor, `markRead:true` is refused to avoid skipping unread messages; use `markRead:false` for lookahead reads. Also returns `latestAvailableSeq`, `hasMore`, and `unreadRelevant`. |
| `room_job_done({ jobId, summary?, filesChanged?, testsRun?, allowUnread? })` | Mark a job done. **Refuses with `isError: true`** if there are unread relevant messages (messages from other agents, broadcast or directed to you) after your `lastReadSeq`; pass `allowUnread: true` to override. Previews of unread messages are returned on refusal. |
| `room_status({ roomId?, agentId? })` | Summarise the active room: `latestSeq`, agents list, and (if `agentId` known) your unread count. |

Tool inputs all fall back to the env vars `PI_WORKFLOW_ROOM_ID`, `PI_WORKFLOW_AGENT_ID`, `PI_WORKFLOW_AGENT_ROLE` so sub-agents do not have to repeat the room context on every call. For non-child (Brain) sessions, `agentId` defaults to `brain` when neither params nor env specify it; child sessions still require an explicit `agentId` (typically via `PI_WORKFLOW_AGENT_ID`).

### Delegation with room context

Pass an optional `room` object to `delegate_to_coder` and `delegate_to_reviewer`:

```ts
// 1. Brain creates a room (uses ctx.cwd, no agentId required).
room_create({ roomId: "auth-refactor", title: "Auth refactor: backend + frontend" });

// 2. Brain delegates the backend implementation with room context.
delegate_to_coder({
  task: "Implement POST /auth/refresh. Persist refresh tokens server-side.",
  room: { roomId: "auth-refactor", agentId: "backend", role: "backend" },
});

// 3. Brain delegates the frontend implementation with room context.
delegate_to_coder({
  task: "Wire refresh-token rotation into the auth client. Match backend payload shape.",
  room: { roomId: "auth-refactor", agentId: "frontend", role: "frontend" },
});
```

What the child sub-agent sees:

- Env vars: `PI_WORKFLOW_ROOM_ID=auth-refactor`, `PI_WORKFLOW_AGENT_ID=backend`, `PI_WORKFLOW_AGENT_ROLE=backend`, plus `PI_WORKFLOW_ROOM_ROOT` pointing at the parent's `.pi/workflow-runs` (so a child with a sub-`cwd` still reads/writes the same room store), plus the existing `PI_WORKFLOW_CHILD=1`.
- A **Workflow Room Communication** block appended to its system prompt that instructs the sub-agent to:
  1. Call `room_job_start` before doing meaningful work.
  2. Use `room_send` for assumptions, contracts, blockers, and decisions (broadcast by default; direct to a specific `agentId` when needed).
  3. Call `room_read({ markRead: true })` after heavy work and before finalising.
  4. Call `room_job_done`. If it errors with unread messages, address them via `room_send` / `room_read` and retry.
  5. Never silently change shared contracts (APIs, ownership boundaries, schema) — announce via `room_send` first.
- `room_*` tools included in the child's `--tools` allowlist. If the project / global `workflow.json` has an older `tools` list that does not yet include them, they are appended/deduped automatically whenever `room` context is supplied. If a preset leaves `tools` undefined (all tools), it stays undefined.

### Example: backend ↔ frontend contract

```text
[backend]   room_send({ topic: "schema", message: "POST /auth/refresh accepts {refreshToken}; returns {accessToken, refreshToken, expiresIn}. Errors use {error, code}." })
[frontend]  room_read({ markRead: true })  // sees backend's schema
[frontend]  room_send({ to: "backend", topic: "question", message: "Should we rotate the refresh token on every call, or only when the existing one is within 1h of expiry?" })
[backend]   room_read({ markRead: true })  // sees frontend's question
[backend]   room_send({ to: "frontend", topic: "answer", message: "Rotate on every call. Server enforces single-use." })
... (work) ...
[backend]   room_job_done({ jobId: "backend-auth", summary: "POST /auth/refresh implemented, rotating tokens, single-use enforced", filesChanged: ["src/api/auth.ts"] })
[frontend]  room_job_done({ jobId: "frontend-auth", summary: "Client rotation wired with single-use retry-on-401", filesChanged: ["src/auth/client.ts"] })
```

### Limitations / non-goals (v1)

- **No real-time interruption.** Sub-agents finish heavy work, then read queued messages at checkpoints. If you need live interruption, use a future v2 (or a dedicated channel).
- **No built-in dashboard.** The event log is plain JSONL; you can `tail -f .pi/workflow-runs/<roomId>/events.jsonl` to watch a room. A TUI / web dashboard is a deliberate follow-up.
- **In-process atomicity for tool calls.** The cross-process lock is per-room (`.lock` in the room dir). It is short-lived (held only for read-mutate-write of `events.jsonl` and `agents.json`). There is no fsync — on hard crash mid-append you may lose the last unfsync'd line, but `seq` numbering will not corrupt the file.
- **Per-agent routing is by `agentId` only.** `to` matches an exact `agentId`; there is no role-based broadcast fan-out in v1. Use broadcast (omit `to`) if you want a "to anyone in role X" message and have consumers filter by their own role.
- **Project-local only.** Rooms live in `.pi/workflow-runs/` of the cwd where the workflow runs. When a delegate is launched with `room` context, the parent exports `PI_WORKFLOW_ROOM_ROOT` so a child running in a sub-`cwd` still reads/writes the same room store. They are not synced or aggregated across machines.
- **Reviewer swarm + room context.** When `delegate_to_reviewer` runs the reviewer swarm with `room` context, each parallel reviewer gets a unique `agentId` of the form `<baseAgentId>-<index+1>` (e.g. `reviewer-1`, `reviewer-2`) so they don't share one read cursor / status row.

### Existing delegation stays the same

If you do not pass `room` to `delegate_to_coder` / `delegate_to_reviewer`, the child receives no `PI_WORKFLOW_ROOM_*` env vars and no communication block, and behaviour is identical to the previous version. The room tools are still registered, but resolve nothing without a `roomId` and will return a clear error prompting the user to call `room_create` first.

Useful commands:

```bash
/workflow
/sprint init [--private] [--gitignore]
/sprint new <name>
/sprint status
/sprint task add <title>
/sprint task active <TASK-ID>
/sprint task start <TASK-ID> [--auto-run]
/sprint task done <TASK-ID>
/sprint epic add <title>
/sprint log <message>
```

`/sprint task start <TASK-ID> [--auto-run]` creates a new dedicated Pi session bound to that task:

- The new session is named `Sprint: <TASK-ID> <title>` (visible in `/resume`).
- A durable `sprintBinding` entry is appended to the new session, pinning it to the task's sprint path, task path, task id, and title.
- The task is marked `in_progress` and a `task session started` line is appended to the sprint's `PROGRESS.md`.
- The repo-global `.sprints/current.json` is also updated for consistency, but the new session treats the binding (not `.sprints/current.json`) as its effective context.
- With `--auto-run`, a kickoff prompt is sent in the new session telling the agent to work the pinned task using the brain -> coder -> reviewer workflow. Without `--auto-run`, the new session is just opened and the user is notified.
- If `<TASK-ID>` is omitted, the command falls back to the active task from `.sprints/current.json`.

`/workflow` shows effective resolved presets, reviewer swarm settings, the active workflow profile, and the `GONKA_BROKER_URL` / `GONKA_BROKER_API_KEY` env status (set/default/unset, no values).

## Sprint system

- Uses project-local `.sprints/` as AI navigation/execution context.
- Default: `.sprints/` is committed (`visibility: "committed"`).
- For sensitive repos: `/sprint init --private` keeps `.sprints/` local via `.git/info/exclude`.
- Use `/sprint init --private --gitignore` to write to `.gitignore` instead.
- Linear is the default future projection target (placeholder config/files only; no API sync yet).

Default `.sprints/config.json`:

```json
{
  "version": 1,
  "visibility": "committed",
  "autoCreate": "ask",
  "defaultTracker": "linear",
  "linear": { "enabled": false, "teamKey": null, "projectId": null }
}
```

Auto-bootstrap behavior (non-child sessions):
- If no active sprint, the extension can auto-create based on `~/.pi/agent/sprints.json` (`autoCreate`: `always|ask|never`, default `ask`).
- It uses a simple non-trivial-work heuristic and skips `/sprint` command prompts.
- Child delegated sessions still get active sprint pointer injection but do not auto-bootstrap.

AI-callable sprint tools:
- `sprint_read_context`
- `sprint_create`
- `sprint_create_task`
- `sprint_create_epic`
- `sprint_set_active`
- `sprint_update_task`
- `sprint_log_progress`
- `sprint_start_task_session`
- `sprint_get_session_binding`

Default session-per-task flow:

- For concrete sprint-tracked tasks, the project supports one dedicated Pi session per task. The Brain default instructions tell the Brain agent to invoke the `/sprint task start <TASK-ID> --auto-run` slash command (or call the `sprint_start_task_session` tool as a fallback) before implementation when the current session is not already pinned to that task.
- Only the `/sprint task start <TASK-ID> --auto-run` command performs the actual session switch by calling `ctx.newSession()`. It is available to the user directly and to any agent that can issue slash commands.
- `sprint_start_task_session` is an AI-callable tool that prepares the `/sprint task start <TASK-ID> --auto-run` command for the user to run. It places the command in the editor (when UI is available) and notifies the user. It exists because tools cannot call `ctx.newSession()` directly — only commands can — so the tool does NOT switch sessions; it only presents the command. After calling it, stop and wait for the user to run the command.
- Once a session is pinned, the binding is stored inside the session file itself as a `sprintBinding` custom entry, and `sprint_read_context`, `sprint_update_task`, `sprint_log_progress`, and `before_agent_start` all prefer the binding over `.sprints/current.json`. This means a pinned session remains bound to its task even if `.sprints/current.json` is changed by other sessions or commands. `sprint_update_task` also refuses to update a `taskId` that does not match the bound task, so a pinned session cannot accidentally write to a different task.

See [`examples/sprints-config.json`](./examples/sprints-config.json).

## pi-ai-automation-memory (repo context extension)

This package also includes a global repo-memory extension that gives every Brain/agent turn fast, bounded repo context via a deterministic SQLite-backed index.

### Install

The extension is bundled with this package — no separate install needed. It auto-registers when Pi starts.

### Quickstart

No configuration is required. The extension works out of the box with safe defaults:
- Default cache path: `~/.pi/agent/repo-memory/` (outside the repo)
- Default exclusions: secrets, generated artifacts, large binaries, IDE files, lockfiles
- Secret redaction enabled before hashing or storage
- No telemetry, no network syncing, no external dashboard

Optional per-project config at `.pi/repo-memory.json`:
```bash
mkdir -p .pi
cp examples/repo-memory.generic.json .pi/repo-memory.json
```

### AI tools

| Tool | Purpose | Typical caller |
|------|---------|---------------|
| `repo_context` | Bounded repo summary for agent planning | Brain, Coder |
| `repo_checkpoint` | Append-only evidence queue for claims, test refs, and confidence | Brain, Coder, Reviewer |
| `repo_health_report` | Ranked integrity/consultant findings (optional Mermaid Gantt) | Reviewer, Brain |
| `repo_index_status` | Quick diagnostic of index state and keeper lease | Any agent |

### Default exclusions

Secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, etc.), generated artifacts (`node_modules/`, `dist/`, `build/`, `*.min.js`, `*.map`), binaries (`*.png`, `*.zip`, `*.pdf`), lockfiles, IDE directories (`.vscode/`, `.idea/`), and OS files (`.DS_Store`).

These are built-in and cannot be removed; use `indexing.additionalExclusions` to extend them.

### Model presets and scouts

The extension ships provider-agnostic model presets:
- `index_keeper` (enabled): generate/refresh file cards
- `integrity_keeper` (enabled): generate health findings
- `scout_broad` (disabled): cross-file pattern scans
- `scout_deep` (disabled): deep architectural analysis

Override in `.pi/repo-memory.json` under `modelPresets`. Scouts are disabled by default and run deterministically without an external LLM provider.

### Exposing memory tools to delegated agents

If your `.pi/workflow.json` restricts `agents.coder.tools` or `agents.reviewer.tools`, add the four memory tools so sub-agents can use them:

```json
{
  "agents": {
    "coder": {
      "tools": [
        "read", "bash", "edit", "write", "grep", "find", "ls",
        "room_create", "room_job_start", "room_send", "room_read", "room_job_done", "room_status",
        "repo_context", "repo_checkpoint", "repo_health_report", "repo_index_status"
      ]
    },
    "reviewer": {
      "tools": [
        "read", "bash", "grep", "find", "ls",
        "room_create", "room_job_start", "room_send", "room_read", "room_job_done", "room_status",
        "repo_context", "repo_checkpoint", "repo_health_report", "repo_index_status"
      ]
    }
  }
}
```

See [`examples/workflow.with-memory-tools.json`](./examples/workflow.with-memory-tools.json) for a full example.

### Validation

Run the local validation suite to verify core behavior:

```bash
npx jiti scripts/validate-repo-memory.ts
```

### Limitations

- Keeper card generation and scout scanning are deterministic/local only; no external LLM provider integration yet.
- Health report findings are evidence-bound and ranked, but the consultant does not call external LLMs.
- No built-in dashboard; data is plain SQLite and JSONL.
- Rooms and workflow tools are separate from repo-memory; they coordinate but do not share storage.

### No-load-scan guarantee

The extension does **not** scan the repo, open SQLite, run `git status`, or walk the file tree on extension load. All indexing is deferred to lazy/on-demand tool calls. This keeps Pi startup fast and side-effect free.

### Diagnostic command

- `/repo-memory-status` — Show extension status, registered tools, model preset list, scout status, and no-load-scan guarantee.

### Intended usage

- **Brain**: call `repo_context` before planning; call `repo_checkpoint` after delegating to record claims.
- **Coder**: call `repo_context` with a focused `query`; call `repo_checkpoint` after completing work.
- **Reviewer**: call `repo_health_report` to surface integrity findings.

See [`docs/pi-ai-automation-memory-extension.md`](./docs/pi-ai-automation-memory-extension.md) for the full extension docs, and [`docs/pi-ai-automation-memory-spec.md`](./docs/pi-ai-automation-memory-spec.md) for the architecture blueprint.

## Update flow

- Update this package version/ref in your Pi package source.
- Run `pi update` (or reinstall with a pinned git ref/tag).

## Security note

Pi extensions execute local code and delegated child agents can run tools in your workspace. Review package contents before installing and keep overrides free of secrets.
