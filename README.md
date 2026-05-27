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
/sprint task done <TASK-ID>
/sprint epic add <title>
/sprint log <message>
```

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

See [`examples/sprints-config.json`](./examples/sprints-config.json).

## Update flow

- Update this package version/ref in your Pi package source.
- Run `pi update` (or reinstall with a pinned git ref/tag).

## Security note

Pi extensions execute local code and delegated child agents can run tools in your workspace. Review package contents before installing and keep overrides free of secrets.
