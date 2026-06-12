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
- `workflow_record_architecture_plan`, `workflow_read_architecture_plan`, `workflow_update_architecture_plan` (architecture-plan persistence; `ready` plans require the per-criterion `acceptanceEvidenceMatrix` — see [Architecture evidence matrix](#architecture-evidence-matrix))
- `workflow_planning_state` (durable PRD-first planning state machine in `.pi/workflow-runs/<planning-room>/planning-state.json`)
- `workflow_planning_artifacts` (write/read planning PRD.md and memo.md text)
- `room_create`, `room_job_start`, `room_send`, `room_read`, `room_job_done`, `room_status`
- `workflow_deep_plan` (optional planning-only deep-planning pass; planning-only delegates, no code edits)

Delegated agents run as headless JSON subprocesses (`--mode json -p --no-session`) and stream bounded live events back to the parent. The parent Pi terminal renders delegate progress using theme-colored sections (status, tools, thinking indicators, assistant output previews, usage, and final output). Thinking/reasoning content from child agents is shown as a sanitized indicator (`thinking…`) rather than raw hidden chain-of-thought. There is no nested interactive TUI inside the child; rendering is handled by the parent using Pi extension rendering/theme APIs.

## Defaults

- **brain**: `openai-codex/gpt-5.5` thinking `xhigh`. Brain orchestrates planning and delegation using a contract-first pipeline: Business Planner (domain intent), Technical Architect (pattern/transaction boundary selection with explicit rationale), Contract/Block Plan (DTOs, ports, events, use-cases, files), then Phase A isolated block building followed by Phase B integration wiring. Brain does **not** take over code edits when coder fails or reviewer returns `CHANGES_REQUESTED`. Instead, it re-delegates a focused fix back to coder (or a room worker) and then re-reviews. Brain may do read-only diagnosis/planning/admin only, and direct edits are limited to tiny non-code/admin cases.
- **coder**: `openai-codex/gpt-5.3-codex` thinking `medium`, tools `read,bash,edit,write,grep,find,ls,room_create,room_job_start,room_send,room_read,room_job_done,room_status`, and **Karpathy Guidelines included by default**. Coder follows Brain's blueprint/contracts, builds isolated DTOs/classes/ports/events/use-cases first, and asks rather than guessing when the blueprint is ambiguous.
- **reviewer**: `openai-codex/gpt-5.5` thinking `high`, tools `read,bash,grep,find,ls,room_create,room_job_start,room_send,room_read,room_job_done,room_status` (read-only). Focuses on implementation diffs/behavior and test evidence; architecture context is for intended scope only.
- **reviewerSwarm**: enabled by default, runs targeted reviewer subprocesses (parallelized with `maxConcurrency`) across configured targets or explicit `goals`

Child delegates run with:
- `--mode json --print --no-session`
- preset `--model`, `--thinking`, and `--tools`
- `PI_WORKFLOW_CHILD=1` to prevent recursive Brain behavior in child sessions
- `PI_WORKFLOW_ROOM_ROOT`, `PI_WORKFLOW_ROOM_ID`, `PI_WORKFLOW_AGENT_ID`, `PI_WORKFLOW_AGENT_ROLE` when delegated with `room` context; the root points at the parent's `.pi/workflow-runs` so a delegated child with a sub-`cwd` still shares the same room store (see [Workflow Rooms](#workflow-rooms))

## Configuration override

Config is deep-merged in this order:
1. Package defaults
2. Global `~/.pi/agent/workflow.json`
3. Nearest project `.pi/workflow.json`
4. Nearest project `.pi/workflow.local.json` (runtime override, not a managed catalog)
5. Optional built-in workflow profile layer, applied at the source that selected it:
   - global `profile`: package defaults → profile → global → project
   - project `profile`: package defaults → global → profile → project
   - local override `profile`: package defaults → global → project → local override profile
   - CLI `--workflow-profile`: package defaults → global → project → local override → profile

That means a profile selected in `.pi/workflow.json` can override older global defaults, while fields in the same project file still win over the profile. A `.pi/workflow.local.json` file then applies on top of project config for project-local runtime overrides and is intended for local customization without mutating managed workflow sidecars. See [`examples/workflow.json`](./examples/workflow.json).

### Interactive workflow configuration

You can open a local workflow profile/runtime editor with `/workflow_cfg` in TUI mode. It opens a centered overlay configurator with a root menu of three blocks: **Profile**, **Profile config**, and **Runtime settings**. Each block has its own Apply/write; there is no global Preview & apply. Cancel/back paths never write. `/workflow configure` and `/workflow config` remain compatibility aliases for the same overlay, so existing command bindings keep working.

**Profile** is an in-place selector with check (✓) markers. Rows: Default, Gonka (shown only when `GONKA_BROKER_API_KEY` is configured via process env or `~/.pi/.env`), Custom, Apply, Back. Selecting a profile row moves the ✓ marker and keeps the user in the menu; Apply writes the selected profile to `.pi/workflow.local.json`.

**Profile config** shows Default, Gonka (same env gate), Custom, Delegate fallback models, Apply, Back. Default and Gonka open read-only field views so you understand the built-in values; Custom opens editable per-role model/thinking pickers; Delegate fallback models opens a submenu where edits are staged and written by the parent Profile config → Apply. The active row (Default/Gonka/Custom) is hydrated from the effective loaded config and the latest `.pi/workflow.local.json` override: if the local override defines any `agents`, the Custom row is shown as active and the Custom and fallback submenus are seeded with the current effective values so they are not misleadingly displayed as "(default)". Both the Custom per-role submenu and the Delegate fallback models submenu loop internally after a pick/clear action, so you can change several fields in one visit; Esc/Back returns to the Profile config root without writing. Read-only built-in field views dismiss reliably with Esc (Pi key matching) and do not advertise an Enter action.

Inside **Custom profile fields** the per-role menus are stack-based: `coder` and `reviewer` use a chained model -> thinking flow (selecting the model row opens the model picker, Enter on a model opens the thinking picker constrained to that model, Enter on a thinking level stages both and returns to the params menu). Their model row description shows the staged model and thinking level together, and there is no separate `coder thinking` / `reviewer thinking` row. Esc in the thinking picker returns to the model picker (no commit); Esc in the model picker returns to the params menu with no model staged. `brain` keeps its existing standalone `brain model` and `brain thinking` rows until Brain is also converted to the chained flow. Inside **Delegate fallback models** the same model -> thinking -> commit chain is used for `coder fallback` and `reviewer fallback`; the parent Profile config → Apply remains the only disk write.

**Runtime settings** keeps its own Save/Discard actions and writes runtime changes immediately on Save.

For Custom per-role and fallback models, choices are sourced from Pi's available models list (`ctx.modelRegistry.getAvailable()`) and rendered as `provider/model` choices. If the model registry is empty or unavailable, the overlay warns and continues in a limited mode: built-in profiles and runtime settings remain available, custom model picking and fallback model picking are unavailable.

The configure flow persists only runtime override fields to `.pi/workflow.local.json` and does not mutate `.pi/workflow.json` managed catalog sidecars. The file is loaded after nearest `.pi/workflow.json` and before profile flags so it stays project-local and persistent.

When diagnostics exist, `/workflow` and the status line show a warning marker (`⚠`) in the friendly `wf:` label.

### Delegation guard and fallback models

Before spawning a coder or reviewer delegate, the workflow validates the configured primary model against Pi's current model registry. If the primary model is unavailable, the guard tries the role's configured fallback from `delegateFallbacks` (if any). If neither primary nor fallback is available, the delegate flow exits with a warning/error result and no child process is spawned.

Fallback settings are optional and none are configured by default. They can be set or cleared via `/workflow_cfg`. Fallback selection preserves the role's existing tools, instructions, and `includeKarpathyGuidelines`; only provider, model, and thinking level are overridden.

Example fallback configuration in `.pi/workflow.local.json`:

```json
{
  "delegateFallbacks": {
    "coder": { "provider": "gonka", "model": "moonshotai/Kimi-K2.6", "thinkingLevel": "off" },
    "reviewer": { "provider": "openai-codex", "model": "gpt-5.5", "thinkingLevel": "high" }
  }
}
```

`/workflow_cfg` can set or clear these fallbacks under Profile config → Delegate fallback models; they are staged and written by Profile config → Apply. Cancel/back paths never write.

Reviewer swarm behavior:
- If `reviewerSwarm.enabled` is `true` (default), `delegate_to_reviewer` runs one read-only reviewer per goal.
- Reviewer goals are implementation/check goals (diffs, behavior, tests, security/perf/maintainability); they are not a mechanism to validate Brain's plan quality.
- Pass `goals` to `delegate_to_reviewer` to review acceptance criteria explicitly.
- Without `goals`, configured `reviewerSwarm.targets` are used.
- If any target reviewer fails or returns `CHANGES_REQUESTED`, the delegation result is marked failed.
- Set `reviewerSwarm.enabled: false` for legacy/no-matrix plans only; this keeps legacy single-reviewer behavior.
  - Matrix-gated `ready` plans with `acceptanceEvidenceMatrix` still run role-based matrix reviewer coverage even when this flag is `false`.

#### Role-based reviewer swarm (matrix-derived)

For non-trivial `ready` architecture plans with an `acceptanceEvidenceMatrix`, the reviewer swarm enters role mode automatically:

- Required reviewer roles are derived from each matrix entry's `reviewerRoles`, plus the default role set (behavior, evidence/test, implementation, maintainability, regression, docs-config when scoped). Explicit `goals` on the delegation call are supplemental and never replace required roles.
- Each role is assigned its own reviewer; the per-role task embeds the matrix criteria, required evidence, blocking conditions, hard role rules (rejection of source-string / static-only / prompt-only evidence for behavior + evidence-test + regression), and the supplemental goals.
- Results are evaluated with the fail-closed role evaluator: an `APPROVED` behavior / evidence-test / regression result that relies on source-string / static-only / read-the-source / skipped-running / prompt-only evidence is downgraded to `CHANGES_REQUESTED`; an `auto_exit` / `process_exit` / `missing` / `legacy` completion is provisional and blocks required approval unless explicit structured reviewer evidence is supplied.
- A consolidated memo is written to `.pi/workflow-runs/reviewer-memos/<planId>-<phase>.md` covering approvals, changes requested, weak evidence, prompt-only caveats, unresolved risks, provisional caveats, unknown/failed, and a final recommendation. The tool output shows the memo path + memo before the per-target raw outputs.
- Final approval is blocked whenever any required role returns `CHANGES_REQUESTED`, has an `UNKNOWN` verdict, is missing, or is still provisional. The phase is only marked `review_approved` when every required role clears the gate.

## Deep planning (opt-in)

Deep planning is planning-only and disabled by default. It runs bounded Product Requirements agent discussion before implementation:

```json
{
  "deepPlanning": {
    "enabled": false,
    "plannerCount": 2,
    "maxConcurrency": 2,
    "rounds": 2,
    "roomIdPrefix": "deep-plan",
    "planners": [
      {
        "id": "pr-agent-1",
        "role": "product-requirements",
        "modelPreset": "premium-planner",
        "thinkingLevel": "xhigh"
      },
      {
        "id": "pr-agent-2",
        "role": "product-requirements",
        "modelPreset": "premium-planner",
        "thinkingLevel": "xhigh"
      }
    ]
  }
}
```

Planner entries are Product Requirements personas for `workflow_deep_plan`: read-only delegates, no `edit`, `write`, or `bash`. They use bounded grill-me behavior: inspect the codebase before asking when possible, ask at most one highest-value question per round with a recommended answer, and update a shared PRD with resolved decisions and open questions. They do not produce implementation plans or code.

Brain must synthesize planner outputs into a memo with PRD draft, resolved decisions, unresolved user questions, options, risks, and `ready_for_sprint: yes|no`, persist planning state and artifacts via `workflow_planning_state` / `workflow_planning_artifacts`, then proceed with normal planning → implementation delegation only after explicit user confirmation.

Planning artifacts and approvals live under `.pi/workflow-runs/<planning-room>/` as `planning-state.json`, `PRD.md`, and `memo.md` as the pre-sprint contract.

Planning-room resolution is explicit: `workflow_planning_state` and gates resolve `planningRoomId` from explicit parameter first; `workflow_planning_state` uses `.pi/workflow-runs/current.json` first for `action=create` (legacy compatibility), and non-create paths prefer `.pi/workflow-runs/planning-current.json` and only fall back to `.pi/workflow-runs/current.json` when that room already has planning state. This keeps planning artifacts decoupled from runtime workflow room churn while preserving legacy create behavior.

`brain` should call `workflow_deep_plan` for complex tasks when the task marker/opt-in requests it, then synthesize options and risks before sending implementation tasks to `delegate_to_coder`. If deep-planning config is disabled (default), pass `force:true` when honoring a required/auto marker unless the user explicitly enabled deep planning in config.

For opt-in control, put a task marker in the sprint task markdown:

```markdown
<!-- brain:deep_planning=required -->
```

Use `off` or `auto` to down-scope or let Brain decide:

```markdown
<!-- brain:deep_planning=off -->
<!-- brain:deep_planning=auto -->
```

To opt in via config instead of marker forcing (or in addition):

```json
{
  "deepPlanning": {
    "enabled": true
  }
}
```
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
   - `done.json` — sidecar written by the child when it calls explicit completion tool, or by child auto-exit fallback on normal completion
   - `run.sh` — generated shell script that launches the child Pi session
2. Parent opens a new cmux terminal surface in the **same workspace/pane** (`cmux new-surface --type terminal`, scoped by `cmux identify --json` context). If the delegate has `room` context (or a task id like `TASK-015`), the first surface is moved to a **new cmux workspace** (`move-tab-to-new-workspace`) named after the room/task id; subsequent delegates with the same group key reuse that workspace. Each agent gets a tab titled `{group}-{role}`, e.g. `auth-refactor-backend` or `TASK-015-coder`.
3. Parent tails the session JSONL for finalized messages/tool calls (not streaming events) and polls `done.json` for completion.
4. The child gets a pane-specific instruction in its system prompt: after producing the concise final handoff, **MUST call `sub_agent_done`** as the final action to return control to Brain. Final text alone is insufficient.
5. On abort, parent sends Escape to the pane.
6. By default, the surface is **auto-closed** when the sub-agent finishes (success, failure, or abort). Set `delegatePaneAutoClose: false` to leave it open for inspection.

### Requirements and limitations

- **cmux must be running** and `CMUX_SOCKET_PATH` must be set (or discoverable). If cmux is unavailable and mode is `pane`, the delegate returns a clear failed result. `auto` silently falls back to headless.
- **API keys must be available to the pane shell** via its own environment, Pi auth, or `~/.pi/.env`. The generated pane script only exports workflow-specific env vars and does not copy arbitrary parent secrets into `/tmp`.
- **Surfaces auto-close by default** after the child finishes. Set `delegatePaneAutoClose: false` to keep them open for inspection.
- **Initial support is cmux-only.** tmux/zellij are not implemented unless very cheap to add later.
- **Reviewer swarm** works with pane mode too — each reviewer target may open its own pane when cmux is available.
- `done.json` may be written either by explicit `sub_agent_done` / `workflow_delegate_done` (preferred) **or** by a child-side auto-exit fallback after a normal `agent_end` when the child forgot the tool call.
  - Explicit completion is the preferred contract; final assistant text alone is not.
  - Auto-exit fallback only applies to normal `agent_end` completion and succeeds by reading final assistant output from the session file.
  - Shell/process exit without a completion sidecar is still treated as failure, including `shell` / `from_exit` / `error` / `interrupted` stop reasons.
  - `workflow_delegate_status` includes completion metadata (for example `explicit` vs `auto_exit`) and warning text, so room-scoped workers that skipped `room_job_done` remain visible instead of being silently synthesized as success.

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

See [`examples/workflow.gonka-hybrid.json`](./examples/workflow.gonka-hybrid.json) for the opt-in project override with `profile: "gonka-hybrid"`. For the default workflow setup, start from `examples/workflow.json` and its sibling `workflow.*.json` catalog files.

### Structured tool-call gate

The three broker models pass the OpenAI Chat Completions **auto/default** `tool_choice` test on the current broker (`/v1/chat/completions` returns `finish_reason=tool_calls` and a `message.tool_calls` entry with parsed JSON args; two-turn tool-result roundtrip works). This is the gate for using Gonka as a Pi coder/reviewer — without it, delegations fall back to plain text or refusals, which is unusable for tool-driven workflows.

### `MiniMax-M2.7` forced `tool_choice` caveat

`MiniMaxAI/MiniMax-M2.7` passes the auto/default `tool_choice` test but **fails** when the client forces a tool call: the broker pollutes `function.arguments` with visible `<think>` text, which fails `JSON.parse` and breaks structured tool calls. If you experiment with `MiniMax-M2.7` as a diversity reviewer, keep `tool_choice` at the default (auto) — do **not** force tool choice. Kimi K2.6 and Qwen3-235B do not have this caveat and work with both auto and forced `tool_choice`.

### Example: opt in for one project

```bash
mkdir -p .pi
cp examples/workflow.gonka-hybrid.json .pi/workflow.json
# For the default workflow setup, copy examples/workflow.json and its sibling catalog files (`workflow.*.json`)
# Put GONKA_BROKER_API_KEY (and optionally GONKA_BROKER_URL) in ~/.pi/.env,
# or export them in this shell, then:
pi
```

The project-local `profile: "gonka-hybrid"` field is the project's source of truth; the CLI flag overrides it for the current run if you want to A/B test. To leave the profile but pin one worker back to a different model, override `agents.coder` / `agents.reviewer` in the same `.pi/workflow.json` — those fields win over the built-in profile.

## Workflow Rooms

Workflow Rooms are a **durable async coordination queue** for delegated sub-agents. They let a `brain` (or a future planner agent) hand work to multiple specialised sub-agents — e.g. backend + frontend, planner + implementer, or independent reviewers — and let them exchange assumptions, contracts, blockers, and decisions at job boundaries **without real-time interruption**.

Workflow rooms are intentionally minimal:

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

### Limitations / non-goals

- **No real-time interruption.** Sub-agents finish heavy work, then read queued messages at checkpoints. If you need live interruption, use a dedicated channel.
- **No built-in dashboard.** The event log is plain JSONL; you can `tail -f .pi/workflow-runs/<roomId>/events.jsonl` to watch a room. A TUI / web dashboard is a deliberate follow-up.
- **In-process atomicity for tool calls.** The cross-process lock is per-room (`.lock` in the room dir). It is short-lived (held only for read-mutate-write of `events.jsonl` and `agents.json`). There is no fsync — on hard crash mid-append you may lose the last unfsync'd line, but `seq` numbering will not corrupt the file.
- **Per-agent routing is by `agentId` only.** `to` matches an exact `agentId`; there is no role-based broadcast fan-out. Use broadcast (omit `to`) if you want a "to anyone in role X" message and have consumers filter by their own role.
- **Project-local only.** Rooms live in `.pi/workflow-runs/` of the cwd where the workflow runs. When a delegate is launched with `room` context, the parent exports `PI_WORKFLOW_ROOM_ROOT` so a child running in a sub-`cwd` still reads/writes the same room store. They are not synced or aggregated across machines.
- **Reviewer swarm + room context.** When `delegate_to_reviewer` runs the reviewer swarm with `room` context, each parallel reviewer gets a unique `agentId` of the form `<baseAgentId>-<index+1>` (e.g. `reviewer-1`, `reviewer-2`) so they don't share one read cursor / status row.

### Architecture evidence matrix

Brain architecture plans carry an optional per-criterion `acceptanceEvidenceMatrix` (see [`docs/workflow-config-v2.md` runtime contract note](./docs/workflow-config-v2.md#runtime-contract-architecture-evidence-matrix) for the canonical contract). Behaviour:

- `draft` plans may omit the matrix; `ready` plans require one that covers every acceptance criterion exactly once, with non-empty `enforcementLevel`, `requiredEvidence`, `reviewerRoles`, and `blockingConditions` per entry.
- A ready-plan entry whose only enforcement level is `prompt-only` is rejected for `runtime-behavior` criteria; any other entry that uses `prompt-only` must include `promptOnlyCaveat`.
- Delegation (coder/reviewer) calls `validatePhaseGate`, which returns matrix-specific rejection codes (`acceptance_matrix_missing`, `acceptance_matrix_incomplete`, `acceptance_matrix_invalid`, `acceptance_matrix_prompt_only_invalid`) when coverage is incomplete, invalid, or dropped on a legacy plan. Legacy plans without a matrix remain readable, but delegation is blocked until they are updated.
- Simple/tiny admin and docs/planning entries may legitimately use `prompt-only` with a caveat (no behavior tests required) so the workflow does not overburden small fixes; runtime-behavior criteria cannot.

This keeps the Brain -> coder -> reviewer chain anchored in concrete proof obligations per acceptance criterion instead of prompt-only mitigations or hand-wavy "covered" claims.

### Coder completion evidence gate (TASK-003)

`delegate_to_coder` enforces a strict matrix-gated completion contract via `extensions/workflow/delegate/completion-evidence-gate.ts` (`evaluateCoderPhaseAdvancement` / `runCompletionEvidenceGate`). The gate runs after `runDelegateAgent` returns and before `markArchitecturePhaseUpdate(..., coder_completed)` so pane and headless transports share the same boundary.

- A coder phase whose plan is `ready` and has an `acceptanceEvidenceMatrix` must include a structured `coderEvidence` packet (typically via the child `sub_agent_done` sidecar, or via intentionally-supported structured result details for headless transports): `filesChanged`, `commandsRun` (each with `outcome` of `passed` / `failed` / `skipped`), and a `criterionCoverage` row per matrix entry keyed by the exact criterion text.
- Free-form final assistant text (`auto_exit` / headless `legacy` / generic `completed`) is **diagnostic only** for ready matrix-gated plans and never advances the phase. The gate emits `free_form_only`, `auto_exit_incomplete`, `process_exit_incomplete`, or `missing_sidecar_incomplete` rejection codes so the diagnostics are visible.
- Source-string / static-only / prompt-only evidence is not sufficient for `runtime-behavior` / `behavior-test` matrix rows; only runnable supporting commands that actually passed count. Failed/retry/auto-exit delegate history is preserved in the `delegateHistory` block and surfaced in the handoff / pre-review summary.
- Tiny / admin / debug lightweight exceptions remain available only for non-matrix-gated plans; a ready matrix-gated plan always refuses the lightweight bypass (`lightweight_bypass_refused`).

`extensions/workflow/prompts.ts` (`CODER_INSTRUCTIONS`) and `examples/prompt-packs/coder-implementer-core.md` describe the per-criterion `coderEvidence` packet the completion tool expects on matrix-gated work.

### Existing delegation stays the same

If you do not pass `room` to `delegate_to_coder` / `delegate_to_reviewer`, the child receives no `PI_WORKFLOW_ROOM_*` env vars and no communication block, so normal delegation behavior is unchanged. The room tools are still registered, but resolve nothing without a `roomId` and will return a clear error prompting the user to call `room_create` first.

Useful commands:

```bash
/workflow [configure|config]
/sprint init [--private] [--gitignore]
/sprint new <name>
/sprint status
/sprint debug status
/sprint debug add <title>
/sprint debug note <DBG-ID> <note>
/sprint debug done <DBG-ID> [evidence]
/sprint debug promote <DBG-ID> [task title]
/sprint hotfix status  # alias of /sprint debug
/sprint hotfix add <title>
/sprint hotfix note <DBG-ID> <note>
/sprint hotfix done <DBG-ID> [evidence]
/sprint hotfix promote <DBG-ID> [task title]
/sprint task add <title>
/sprint task active <TASK-ID>
/sprint task start <TASK-ID> [--auto-run]
/sprint task ship <TASK-ID> --afk [--lane <lane>] [--hotfix-kind <kind>] [--run-id <id>] [--scope <text>] [--retry-budget <n>]
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

`/workflow` shows effective resolved presets, reviewer swarm settings, deep-planning state (`enabled`, `plannerCount`, `rounds`, `maxConcurrency`, `roomIdPrefix`, planner ids/roles), a friendly workflow label (`wf:` with an optional warning marker when diagnostics exist), the active workflow profile, and the `GONKA_BROKER_URL` / `GONKA_BROKER_API_KEY` env status (set/default/unset, no values).

## Brain task markers

Sprint task files (`.sprints/.../TASK-*.md`) can carry Brain-specific HTML-comment markers that surface a parallelization hint to Brain when it calls `sprint_read_context`. Markers are optional hints, not instructions to override Brain's own contract-first planning; unmarked tasks remain valid and Brain should treat them as "no explicit task hint".

### Syntax

All markers are HTML comments so they stay invisible in rendered Markdown:

```markdown
<!-- brain:parallel=auto|required|off -->
<!-- brain:deep_planning=auto|required|off -->
<!-- brain:room=auto|<room-id> -->
<!-- brain:agent id=backend role=backend job=backend-api owns=src/api/** -->
<!-- brain:contract topic=api message="Agree request/response schema before editing." -->
```

### Semantics

| Marker | Effect |
| --- | --- |
| `<!-- brain:parallel=auto -->` | **Default for new tasks.** Brain applies its own parallel-work assessment; when uncertain it must ask the user rather than guess. |
| `<!-- brain:parallel=required -->` | The task is designed for parallel multi-agent execution. Brain should create/use a [workflow room](#workflow-rooms) and delegate with `room: { roomId, agentId, role }` matching the markers. |
| `<!-- brain:parallel=off -->` | Prefer serial execution. Brain should not spawn parallel agents unless the user explicitly overrides. |
| `<!-- brain:deep_planning=auto -->` | Brain may run planning-only deep-planning when helpful (for complex/architecture-risk tasks) before coder delegation. When config is disabled, running due to this marker should pass `force:true`. |
| `<!-- brain:deep_planning=required -->` | Brain must run planning-only `workflow_deep_plan` before coder delegation and synthesize planner options/risks first, using `force:true` if config is not already enabled. |
| `<!-- brain:deep_planning=off -->` | Deep planning is skipped unless the user explicitly enables it. |
| `<!-- brain:room=auto -->` | (default) Brain picks a room id, e.g. derived from the task id (`TASK-019` → `task-019`). |
| `<!-- brain:room=<room-id> -->` | Brain reuses the named room (creates it if it does not exist). |
| `<!-- brain:agent id=... role=... job=... owns=... -->` | Declares one planned sub-agent. Multiple `brain:agent` lines list the expected workers. The `id` is the `agentId` Brain will use on `delegate_to_coder` and in the room. `owns` is advisory file ownership. |
| `<!-- brain:contract topic=... message="..." -->` | Declares a contract Brain should broadcast via `room_send` before the workers start. |

### Coordination flow

When markers opt in (or Brain's own Parallel Work Assessment decides parallel is safe):

1. Brain calls `room_create` (task-derived or marker-named room id).
2. Brain broadcasts each `brain:contract` line as a `room_send` message so every worker reads the same schema.
3. Brain delegates each `brain:agent` line with `room: { roomId, agentId, role }` matching the marker. `owns` is mirrored as the `owns` field on `room_job_start`.
4. Sub-agents exchange questions/answers and assumptions via the room at `room_job_start` / `room_job_done` checkpoints; Brain reads the room between delegations.

### Safety rules

- Brain must **only** parallelize when workstreams have clear file-ownership boundaries and shared contracts (DTOs, ports, events, schemas) that are already agreed. Never invent contracts in flight.
- If Brain is **uncertain** whether parallelization is safe, it must ask the user before launching parallel agents - it must not guess.
- `parallel=off` is a hint, not a hard ban: the user can still override per task.
- Unmarked tasks keep working unchanged: Brain falls back to its normal contract-first planning pipeline without a parallel hint, and the sprint subsystem treats missing markers as a no-op.
- `deep_planning=required` means Brain must run planning-only deep-planning (`workflow_deep_plan`) before delegation; if config is disabled, run it with `force:true`. `deep_planning=auto` follows the same marker-derived force rule when config is off. `deep_planning=off` skips it.

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
- It uses a simple non-trivial-work heuristic and skips `/sprint` command prompts. Tiny debug/hotfix prompts now inject debug-lane guidance instead of forcing auto-bootstrap.
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
- `sprint_debug`
- `sprint_classify_lane` (three-lane automation policy; see "Three-lane automation flow and AFK supervisor" below)
- `sprint_ship` (local AFK ship supervisor: start / read / transition / report)

Lightweight debug/hotfix lane:

- Use the debug lane under `.sprints/debug/` (with `LOG.md` plus `items/DBG-###-slug.md`) for tiny fixes, typos, one-liners, and other low-friction fixes that should not yet become full sprint tasks.
- Use `/sprint debug ...` slash commands or `sprint_debug` tool actions (`status`, `add`, `note`, `done`, `promote`) for minimal tracking.
- Debug escalation triggers (from rule thresholds or inference) include:
  - >2 files changed (`coreFilesThreshold`) or >50 LOC (`locThreshold`)
  - `state-machine` / `schema` / `persistence` / `architecture` / `refactor` / `redesign` wording in title/body/evidence (or `navigation` when paired with these structural/change terms)
  - >1 behavior path (`behaviorPaths`)
  - repeated same-area chain beyond threshold (`workflow_cfg`, etc.)
  - missing reviewer-visible behavior evidence (`reviewerBehaviorEvidenceMissing`)
- Default behavior: `sprint_debug done` is strict (`strict` mode) and blocks completion when escalation recommends promotion; `finalizationGateMode: "dry-run"` allows completion but emits escalation warnings.
- Optional metadata can be provided via `sprint_debug` params to improve rule matching:
  - `area` (or `featureArea` internally), `filesChanged`, `locChanged`, `behaviorPaths`, `stateMachineOrArchitectureChange`, `reviewerBehaviorEvidenceMissing`.
- `sprint_debug promote` (or `/sprint debug promote`) is evaluated before conversion and passes the escalation context into the promoted normal-task body, including a **Debug Lane Context** section and generated acceptance criteria.
- `sprint_debug promote` (and `/sprint debug promote`) moves a debug item into a normal `.sprints` task once scope grows; this does **not** start a session.
- Repeated same-area escalations should suggest a root-cause stabilization task before continuing as tiny debug fixes.

Default session-per-task flow:

- For concrete sprint-tracked tasks, the project supports one dedicated Pi session per task. The Brain default instructions tell the Brain agent to invoke the `/sprint task start <TASK-ID> --auto-run` slash command (or call the `sprint_start_task_session` tool as a fallback) before implementation when the current session is not already pinned to that task.
- The `/sprint task start <TASK-ID> --auto-run` slash command performs the actual session switch by calling `ctx.newSession()`. It is available to the user directly and to any agent that can issue slash commands.
- `sprint_start_task_session` is an AI-callable tool that also starts the session automatically when `ctx.newSession` is available in the tool context. It creates the new session, binds it to the task, and sends the auto-run kickoff prompt directly. Only when automatic session creation is unavailable does the tool fall back to placing the `/sprint task start <TASK-ID> --auto-run` command in the editor for the user to run. In that fallback case, stop and wait for the user to run the command.
- Once a session is pinned, the binding is stored inside the session file itself as a `sprintBinding` custom entry, and `sprint_read_context`, `sprint_update_task`, `sprint_log_progress`, and `before_agent_start` all prefer the binding over `.sprints/current.json`. This means a pinned session remains bound to its task even if `.sprints/current.json` is changed by other sessions or commands. `sprint_update_task` also refuses to update a `taskId` that does not match the bound task, so a pinned session cannot accidentally write to a different task.

See [`examples/sprints-config.json`](./examples/sprints-config.json).

## Three-lane automation flow and AFK supervisor

The sprint subsystem exposes a strict three-lane automation model so users
and agents can pick the right level of planning for the work in front of
them without weakening the existing quality gates. A bounded, local-only
AFK (away-from-keyboard) supervisor MVP drives the implement -> review ->
focused-fix -> finalize loop for authorized lanes and writes a durable
delivery/blocker report.

### Lane selection

| Lane | Use it for | Planning depth | Reviewer | Finalization |
| --- | --- | --- | --- | --- |
| `full-sprint` | Non-trivial work: new features, refactors, anything touching state machines, schemas, persistence, or multiple behavior paths. | Full PRD + architecture + sprint + implementation confirmations (`workflow_planning_state`, sprint task, architecture plan with `acceptanceEvidenceMatrix`, coder evidence, reviewer approval). | Required (existing `delegate_to_coder` and `delegate_to_reviewer` gates remain the only path). | Linked to workflow quality audit before `delivery_complete`. |
| `hotfix` | Lightweight, bounded fixes that still need strict execution. Two sub-kinds: `code-changing` (default; reviewer required) and `text-evidence-only` (docs/typo-only or non-code prompt/template text only; reviewer-free only when concrete refs and validation evidence are present). | Lightweight: short `--scope` statement, optional `--hotfix-kind`, file/LOC/behavior thresholds, root-cause clarity. | Code-changing hotfixes require reviewer by default; text-evidence-only is reviewer-free only when concrete refs and validation evidence are present and changes are non-code (`.md`/`.txt`/prompt packs). | Same finalization + workflow quality audit linkage as full-sprint. |
| `debug` | Diagnosis-first inspection: read, hypothesize, recommend. | No PRD. Must record a non-empty diagnosis and root-cause hypothesis, and emit exactly one next-lane recommendation: `hotfix`, `full-sprint`, or `no-code/report-only`. | Not required. | May exit via report-only stop; may NOT silently perform implementation without an explicit `select_next_lane` promotion. |

Lane vocabulary is enforced at every layer: the `AutomationLane` enum in
`extensions/sprint/lane-policy.ts`, the `sprint_classify_lane` AI tool,
and the `/sprint task ship` slash command all accept exactly
`full-sprint | hotfix | debug`. Hotfix kind vocabulary is exactly
`code-changing | text-evidence-only`. Debug next-lane vocabulary is
exactly `hotfix | full-sprint | no-code/report-only`. A fourth implicit
lane is never introduced without a PRD update.

### Hotfix scope and promotion triggers

A hotfix blocks or promotes (to full-sprint) on any of:

- Scope expansion (missing or vague `--scope` statement).
- File count over the threshold (>2 files) or LOC over the threshold (>50 LOC).
- More than one behavior path touched.
- Architecture / state-machine / schema / persistence / refactor surface.
- Unclear root cause.
- Repeated same-area fix chain (>=2 prior fixes in the same area).
- Reviewer broader-risk flag.

For text-only hotfixes, the evidence-only reviewer-free path requires
**all** of: explicit `textOnlyClass` (`docs` | `prompt-template` | `typo`),
non-empty `textOnlyConcreteRefs` (file + `#section`/`#line`), non-empty
`textOnlyValidationEvidence` (smoke/static-check command or
`rg`-rendered proof), and **no code/control-flow files** in `changedFiles`
or in the ref paths (paths matching `.ts`/`.tsx`/`.js`/`.py`/...
extensions or `extensions/`/`src/`/`scripts/`/... directories are
auto-rejected even if `textOnlyClass=prompt-template`). Uncertain or
`other` classification defaults to reviewer-required, never reviewer-free.

### Debug lane is audit-first

A debug session must record a non-empty diagnosis and root-cause
hypothesis on the durable state, and recommend exactly one next lane
(`hotfix` | `full-sprint` | `no-code/report-only`) before any
implementation may be authorized. The debug state machine rejects
`implement_started`, `coder_completed`, and `focused_fix_completed` until
an explicit `select_next_lane` event promotes the lane to `hotfix` or
`full-sprint`. The `no-code/report-only` outcome is the only path that
stops the supervisor at the audit/report stage without entering the
implement loop. Debug never silently performs broad implementation.

### AI tools and slash command

The thin AFK supervisor surface is exposed as two AI tools registered
from `extensions/sprint/ship-tools.ts`:

- `sprint_classify_lane` — classifies an automation request into the
  three-lane policy and returns a `LaneDecision` (status, reviewer
  requirement, evidence-only flag, recommended next lane, risk codes).
- `sprint_ship` — drives the AFK run lifecycle. `action=start` creates a
  run and persists state under `.pi/workflow-runs/afk-ship/<runId>/`
  with `state.json` and `REPORT.md`. `action=read` / `action=report` /
  `action=transition` advance the run. The tool never shells out to
  remote publishing, PR creation, deploy, or credentialed actions; the
  `permissions` field on durable state defaults to deny for `push`,
  `pr`, `deploy`, `destructive`, and `credentialed`.

Slash command:

```bash
/sprint task ship <TASK-ID> --afk [--lane full-sprint|hotfix|debug] [--hotfix-kind code-changing|text-evidence-only] [--run-id <id>] [--scope <text>] [--retry-budget <n>]
```

- `--lane full-sprint` runs the existing implementation gate
  (`gateSprintEntryPoint(...,'implementation')`); the run is **not**
  created if the gate denies.
- `--lane hotfix` requires `--hotfix-kind` and `--scope`; default
  reviewer-required state is enforced by Phase A contracts.
- `--lane debug` is the audit-first path and does not require a scope
  statement; the run starts in the `diagnosing` stage.

### AFK supervisor limits and default-deny

The AFK supervisor MVP is local-only and bounded:

- Default permissions deny `push`, `pr`, `deploy`, `destructive`, and
  `credentialed`. Requests for these produce an
  `unauthorized-remote-action` stop condition unless explicitly
  authorized on the durable state.
- The tool/command surface never shells out to remote publishing, PR
  creation, deploy, or credentialed actions. The supervisor only
  inspects/writes local files under
  `.pi/workflow-runs/afk-ship/<runId>/`.
- The retry budget is configurable (`--retry-budget`, default 3) and
  is enforced by the pure stage-transition engine. Once the budget is
  exhausted the run stops with a `retry-budget-exhausted` stop
  condition.
- `delivery_complete` requires both finalization summary/result and the
  workflow quality audit summary/artifact. A reviewer-required lane
  (full-sprint or code-changing hotfix) additionally requires an
  approved reviewer outcome; a `changes-requested` outcome is
  treated as unresolved and blocks delivery.

### `--auto-run` kickoff vs AFK supervised shipping

- `/sprint task start <TASK-ID> --auto-run` only kicks off a dedicated
  Pi session bound to the task and sends the regular
  `buildTaskSessionKickoff` prompt. It does **not** create AFK state,
  drive a `sprint_ship` loop, or write a delivery report.
- `/sprint task ship <TASK-ID> --afk` creates durable AFK state
  (state.json + REPORT.md) and a new session bound to the task with the
  AFK kickoff prompt layered in front of the regular kickoff. The new
  session then drives the bounded
  `implement_started -> coder_completed -> reviewer_* / evidence_collected
  -> focused_fix_completed -> finalization_recorded -> delivery_complete`
  loop through `sprint_ship action=transition` until the run completes,
  is blocked, or hits its retry budget.

### AFK delivery report

The `REPORT.md` written at `.pi/workflow-runs/afk-ship/<runId>/REPORT.md`
always includes: lane and scope, debug diagnosis (when applicable),
changed files, evidence refs, checks, reviewer outcome (or "not
applicable" for the evidence-only path — the report never fabricates
reviewer approval), finalization status, finalization summary/result,
quality-audit summary/artifact, promotion reason codes, blockers,
residual risks, default-deny permissions, and a final status line.

## Workflow quality audit

Brain exposes a deterministic workflow-quality audit that scans local
workflow-run and sprint artifacts (no network, no external LLM) and
surfaces evidence-backed risk signals before finalization: failed coder
runs, missing done sidecars, `auto_exit` / `process_exit` completions,
repeated reviewer retries, debug chains after a `done` task, prompt-only
completion language, static-only validation for interactive behavior, and
oversized source/smoke files.

Public tool entry point:

- `workflow_quality_audit_report` — runs the audit, persists a
  task-filtered finalization summary JSON under
  `.pi/workflow-runs/quality-audit/`, and returns the rendered Markdown
  plus structured details (`findingCount`, `byCode`, `artifactPath`,
  repo-relative `artifactLink`, severity breakdown, first finding
  messages). Optional params: `cwd`, `taskId`, `maxDelegateManifests`,
  `maxTaskFiles`, `maxProgressFiles`, `maxDebugItems`, `maxMetricFiles`,
  `maxMetricLines`, `metricFileDirs`, `metricExtensions`, `maxAgeDays`.
- Companion tools registered alongside it: `workflow_run_quality_audit`
  (in-memory scan), `workflow_render_quality_audit_report` (render only),
  and `workflow_build_quality_audit_summary` (build a finalization
  summary payload).

Sprint finalization integration:

- `evaluateSprintTaskFinalizationFromDisk` runs the audit during
  finalization and writes the task-filtered summary to
  `.pi/workflow-runs/quality-audit/<TASK-ID>-quality-audit-summary.json`.
- `evaluateFinalizationGate` exposes the audit as
  `details.qualityAudit` (summary, artifact link/path, finding counts,
  by-code, by-severity) and adds advisory warnings; audit findings
  produce warnings/details, never hard blockers. Existing strict
  blockers (plan/memo/coder evidence) are preserved.
- The audit is advisory by design; historical/recent workflow risk is
  surfaced for citation, not used to refuse otherwise-valid finalization.

See `extensions/workflow/quality-audit.ts`, the split across
`quality-audit-{types,scan,scan-helpers,render,tools}.ts`, and the
smoke/fixture pair at
`scripts/task-009-workflow-quality-audit-{smokes,fixtures}.ts`.

## pi-ai-automation-memory (repo context extension)

This package also includes a global repo-memory extension that gives every Brain/agent turn fast, bounded repo context via a deterministic SQLite-backed index.

### Install

The extension is bundled with this package — no separate install needed. It auto-registers when Pi starts.

### Quickstart

No configuration is required. The extension works out of the box with safe defaults:
- Default cache path: `~/.pi/agent/repo-memory/` (outside the repo)
- Default exclusions: secrets, generated artifacts, large binaries, IDE files, lockfiles
- Secret redaction enabled before hashing or storage
- `repo_context` navigation-first defaults: `maxFiles=12`, `maxTokens=3000`, `includeExcerpts=false`
- Auto-brief defaults: `maxTokens=500`, `includeCards=false`, `includeEvidence=false`
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
