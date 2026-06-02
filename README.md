# pi-ai-automation

Sharable Pi package for a `brain -> coder -> reviewer` workflow with an MVP global sprint substrate.

## Install

```bash
pi install git:git@github.com:Tiraniel/pi-ai-automation.git
```

Then run Pi normally in a repo:

```bash
pi
```

The extensions auto-apply the Brain preset (unless disabled), inject Brain orchestration instructions, add delegate tools, and add a sprint system.

Workflow tools:
- `delegate_to_coder`
- `delegate_to_reviewer` (supports optional `goals` for targeted reviewer swarm)

Delegated agents stream bounded live progress back into the parent Pi terminal: current status, recent tool calls, tool completions/errors, assistant text previews, final output, and usage.

## Defaults

- **brain**: `openai-codex/gpt-5.5` thinking `xhigh`
- **coder**: `openai-codex/gpt-5.3-codex` thinking `medium`, tools `read,bash,edit,write,grep,find,ls`, and **Karpathy Guidelines included by default**
- **reviewer**: `openai-codex/gpt-5.5` thinking `high`, tools `read,bash,grep,find,ls` (read-only)
- **reviewerSwarm**: enabled by default, runs targeted reviewer subprocesses (parallelized with `maxConcurrency`) across configured targets or explicit `goals`

Child delegates run with:
- `--mode json --print --no-session`
- preset `--model`, `--thinking`, and `--tools`
- `PI_WORKFLOW_CHILD=1` to prevent recursive Brain behavior in child sessions

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
