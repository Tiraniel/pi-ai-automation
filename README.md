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

Delegated agents stream bounded live progress back into the parent Pi terminal: current status, recent tool calls, tool completions/errors, assistant text previews, final output, and usage.

## Defaults

- **brain**: `openai-codex/gpt-5.5` thinking `xhigh`
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

See [`examples/workflow.json`](./examples/workflow.json).

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

`/workflow` shows effective resolved presets, reviewer swarm settings, and config sources.

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

## Update flow

- Update this package version/ref in your Pi package source.
- Run `pi update` (or reinstall with a pinned git ref/tag).

## Security note

Pi extensions execute local code and delegated child agents can run tools in your workspace. Review package contents before installing and keep overrides free of secrets.
