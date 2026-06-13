# PRD: Optional Serena Semantic Navigation Integration

## Status

Draft

## Summary

Add optional Serena integration to `pi-ai-automation` as a semantic code navigation backend for Brain/Coder/Reviewer workflows. Serena should improve agent efficiency on large repositories by providing symbol-aware code exploration, references, diagnostics, and targeted edits through MCP, while keeping the existing workflow artifacts as the source of truth for planning, delegation, evidence, review, and finalization.

This PRD does not propose replacing the workflow state machine, sprint files, architecture plans, reviewer memos, rooms, or structured completion evidence. It proposes replacing or reducing the current repo-wide SQLite scanner's role in code navigation.

## Current Problem

Agents currently rely on broad file-system tools and an optional repo-memory layer for repository orientation. The repo-memory layer performs synchronous, repo-wide SQLite synchronization in runtime paths that can block prompt submission and agent startup on large repositories. The resulting latency hurts the core Brain -> Coder -> Reviewer workflow even though the workflow itself does not use repo-memory SQLite as its source of truth.

The missing capability is a fast, optional, semantic navigation path that lets agents inspect symbols, references, declarations, and diagnostics without forcing repo-wide scans or large file reads before each task.

## Target End State

`pi-ai-automation` supports Serena as an opt-in semantic navigation backend. When enabled, Brain, Coder, and Reviewer receive role-appropriate Serena MCP tools and role-specific prompt guidance. Agents use Serena for code understanding and targeted edits, while workflow artifacts remain authoritative for sprint state, architecture plans, coder evidence, reviewer approvals, and finalization gates.

When Serena is disabled or unavailable, the workflow behaves exactly as it does today and falls back to built-in tools. Enabling Serena must not trigger repo-memory sync, require Serena memories as workflow truth, or make semantic inspection count as runtime validation evidence.

## Problem

The current repo-memory mechanism performs expensive repository-wide synchronization in several runtime paths:

- `before_agent_start` auto-brief generation.
- `tool_result` after `bash`, `edit`, or `write`.
- `repo_context`, `repo_checkpoint`, `repo_health_report`, and `repo_index_status`.
- `agent_end` keeper/scout maintenance.

On large repositories, this creates long terminal stalls before the agent begins working. The cost is especially high because the scanner is synchronous and repo-wide: it walks or lists files, stats files, hashes changed files, computes package roots, updates SQLite, and recalculates context metadata.

At the same time, the core automation flow does not depend on repo-memory SQLite as its source of truth. Workflow state lives in `.pi/workflow-runs`, `.sprints`, architecture plans, sidecars, reviewer memos, and structured evidence packets.

## Goals

- Add Serena as an optional semantic navigation backend.
- Allow users to enable or disable Serena per project.
- Make workflow tool profiles Serena-aware when enabled.
- Improve large-repo agent efficiency by encouraging symbol-level navigation before broad file reads.
- Keep existing workflow state and evidence gates authoritative.
- Provide safe fallback to existing built-in tools when Serena is not installed or disabled.
- Reduce reliance on repo-wide `repo_context` for code navigation.

## Non-Goals

- Do not vendor Serena source code into this repository.
- Do not make Serena mandatory for the default workflow.
- Do not replace workflow state storage with Serena memories.
- Do not make Serena output sufficient evidence for finalization by itself.
- Do not remove `read`, `grep`, `find`, `ls`, `bash`, `edit`, or `write`.
- Do not dynamically install language servers without an explicit user action.

## Users

- Brain users running large projects where repo-wide scanning creates noticeable latency.
- Coder agents that need to find symbols, references, and safe edit locations.
- Reviewer agents that need to inspect changed symbols and references without reading large file sets.
- Maintainers who want semantic navigation without making it a hard dependency.

## Current State

Default workflow tool profiles do not include repo-memory tools. Memory tools are available globally but only affect agent behavior when:

- auto-brief is enabled;
- an agent explicitly calls `repo_context`, `repo_checkpoint`, or `repo_health_report`;
- a workflow config explicitly includes repo-memory tools in role tool lists;
- keeper/scout background hooks are enabled.

The current repo-memory SQLite database is useful as a local cache and evidence store, but it is not required for core workflow execution.

## PRD Review Findings

This PRD is directionally sound, but future sprint agents need more precision before implementation starts.

Required clarifications:

- The first implementation should target `external` mode only. `managed` mode must remain a documented future option until Pi exposes a stable API for MCP server lifecycle management.
- Serena tool names must not be guessed in runtime code. The integration must support an explicit configurable tool-name list and provide documented defaults that can be updated without TypeScript changes.
- Workflow profile changes must be additive. Default profiles must remain unchanged so existing installations do not suddenly depend on Serena.
- Prompt guidance must be role-specific. Brain, Coder, and Reviewer use semantic navigation differently and should not receive the same instruction block.
- The repo-memory performance fix is related but separable. The Serena sprint should not be blocked on rewriting repo-memory, but it should prevent Serena enablement from adding any repo-memory sync calls.
- Reviewer evidence must remain behavioral. Serena references can support code understanding, but they do not satisfy runtime behavior, regression, or validation evidence by themselves.

## Proposed Solution

Introduce an optional `semanticNavigation` configuration area and Serena-specific workflow profiles.

Example project config:

```json
{
  "semanticNavigation": {
    "enabled": true,
    "provider": "serena",
    "mode": "external",
    "fallbackToBuiltinTools": true,
    "roles": {
      "brain": "readonly",
      "coder": "edit",
      "reviewer": "readonly"
    }
  }
}
```

Supported modes:

- `disabled`: no Serena integration; existing workflow behavior.
- `external`: Serena is configured outside this package as an MCP server; workflow only exposes Serena tool names in role profiles.
- `managed`: future mode where this package can validate or prepare Serena startup/configuration. This mode is optional and should not be part of the first implementation unless Pi exposes a stable MCP server management API.

MVP scope:

- Implement only `disabled` and `external`.
- Store Serena tool names in config/catalog data, not hard-coded role logic.
- Add diagnostics that explain when Serena config values are unsupported; provider/mode typos are warnings and must not crash normal config loading.
- Add examples that users can copy into project-local `.pi/workflow*.json` files.

TASK-001 config slice decision: `semanticNavigation` lives in workflow config as optional synchronous configuration plumbing. Defaults are conservative (`enabled: false`, `provider: "serena"`, `mode: "disabled"`, fallback enabled, Brain/Reviewer readonly and Coder edit role policy, empty Serena tool lists). Users may opt into external Serena MCP by setting `mode: "external"` and explicit Serena tool-name lists in `.pi/workflow.json` or `.pi/workflow.local.json`; no TypeScript source edits are required.

Example workflow config:

```json
{
  "semanticNavigation": {
    "enabled": true,
    "provider": "serena",
    "mode": "external",
    "fallbackToBuiltinTools": true,
    "roles": {
      "brain": "readonly",
      "coder": "edit",
      "reviewer": "readonly"
    },
    "serenaReadonlyTools": [
      "mcp__serena__get_symbols_overview",
      "mcp__serena__find_symbol",
      "mcp__serena__find_referencing_symbols"
    ],
    "serenaEditTools": [
      "mcp__serena__replace_symbol_body"
    ],
    "serenaProjectTools": [
      "mcp__serena__activate_project"
    ]
  }
}
```

External MCP setup remains outside this package. Example MCP config:

```toml
[mcp_servers.serena]
startup_timeout_sec = 15
command = "serena"
args = ["start-mcp-server", "--project-from-cwd", "--context=codex"]
```

Non-goals and limitations for the MVP config slice: no MCP lifecycle/startup/installation automation, no tool-profile wiring, no prompt guidance, no repo-memory rewrite, and no finalization evidence changes. Serena is optional navigation context only; workflow artifacts and runnable validation remain the evidence boundary. `managed` remains documented future scope and is treated as unsupported by the config loader.

Future scope:

- `managed` startup.
- automatic MCP config generation.
- automatic Serena project activation or indexing commands.
- repo-memory navigation deprecation.

## Workflow Behavior

When Serena is enabled:

- Brain may use Serena read-only tools for codebase orientation before planning.
- Coder may use Serena symbol navigation and edit tools for implementation.
- Reviewer may use Serena read-only symbol/reference/diagnostic tools for review.
- Agents must still run validation commands and provide structured evidence.
- If Serena tools are unavailable, agents fall back to built-in `read`, `grep`, `find`, and `ls` when `fallbackToBuiltinTools` is true.

When Serena is disabled:

- Existing workflow behavior remains unchanged.
- No Serena tools are included in role tool profiles.
- Repo-memory tools remain governed by their own configuration.

Serena should never bypass existing workflow gates:

- Brain still owns PRD/sprint/architecture planning.
- Coder still returns structured `coderEvidence` for matrix-gated work.
- Reviewer still evaluates implementation behavior, tests, regression risk, and maintainability.
- Finalization still relies on workflow artifacts and validation evidence, not Serena memory.

## Tool Profile Design

Add optional profile variants:

- `brain-serena-readonly`
- `coder-serena-and-edit`
- `reviewer-serena-readonly`

Expected read-only Serena capabilities:

- symbol overview
- find symbol
- find references
- find declaration
- diagnostics
- pattern/search helpers, if available and safe

Expected coder Serena capabilities:

- read-only capabilities above
- symbol-aware insert/replace tools
- rename/refactor tools only if stable and safe in the chosen Serena backend

The exact Serena tool names should be discovered from the MCP server during setup or documented as a configurable list. Avoid hard-coding unstable names without a compatibility note.

Suggested configurable categories:

- `serenaReadonlyTools`: symbol overview, symbol lookup, references, declarations, diagnostics, safe pattern search.
- `serenaEditTools`: targeted symbol body replacement, insert before/after symbol, rename/refactor tools that are stable for the configured backend.
- `serenaProjectTools`: project activation, onboarding, memory read/write, if the chosen Serena setup exposes them and the user explicitly enables them.

Default role policy:

| Role | Serena level | Tool policy |
| --- | --- | --- |
| Brain | `readonly` | Code orientation only; no semantic edits. |
| Coder | `edit` | Read-only navigation plus targeted edits; still use exact file reads before final edits. |
| Reviewer | `readonly` | References, declarations, diagnostics, and changed-symbol inspection only. |

Readonly roles must not receive Serena edit/refactor tools.

## Prompt Changes

Add role guidance:

- Prefer Serena symbol overview before opening many files.
- Prefer references/declarations before changing shared APIs.
- Use built-in `read` for exact local inspection before final edits.
- Use built-in validation commands for runtime evidence.
- Do not treat semantic navigation output as proof of behavior.
- If Serena is unavailable, continue with built-in tools and mention the fallback only when it affects confidence.

Brain prompt addition:

- Use Serena for codebase orientation when the task touches unfamiliar APIs, broad architecture, or many files.
- Convert semantic findings into a concrete plan with file/symbol refs before delegating.
- Do not delegate vague Serena exploration tasks; delegated tasks must remain self-contained.

Coder prompt addition:

- Start with Serena symbol/reference lookup when modifying an existing subsystem.
- Before editing, open the exact target file with built-in file tools to verify current content and surrounding behavior.
- After semantic edits, run the same validation commands required by the acceptance matrix.
- Include Serena-discovered affected symbols or references in `coderEvidence.supportingFiles` or `summary` only as supporting context, not as validation proof.

Reviewer prompt addition:

- Use Serena to inspect changed symbols, references, call sites, and diagnostics before approving.
- Treat semantic checks as review coverage, not runtime evidence.
- Request changes if Serena indicates unreviewed call sites or diagnostics that are relevant to the acceptance criteria.

## Repo-Memory Changes

Serena should reduce the need for `repo_context` as a code navigation tool.

Recommended repo-memory changes:

- Disable `autoBrief` by default, or make it read-only from the last snapshot.
- Remove full `syncRepo()` from `before_agent_start`.
- Make `repo_checkpoint` a fast append-only write that does not require full sync.
- Make `repo_context` support `refresh: false | incremental | full`, defaulting to `false`.
- Keep `repo_health_report` advisory and task-scoped.

Repo-memory changes should be tracked as a separate implementation lane unless the sprint explicitly includes both Serena integration and repo-memory performance work. The Serena lane must not add new calls to `syncRepo()`.

## Configuration UX

Add documentation and a diagnostic command or workflow configure path:

- Detect whether `serena` is available on PATH.
- Show the recommended MCP config snippet.
- Show whether Serena tools are present in the current Pi tool registry, if Pi exposes that information.
- Write or update workflow tool profiles only when the user opts in.

Recommended MCP config snippet for external mode:

```toml
[mcp_servers.serena]
startup_timeout_sec = 15
command = "serena"
args = ["start-mcp-server", "--project-from-cwd", "--context=codex"]
```

## Implementation Notes For Sprint Agents

Likely files and modules:

- `extensions/workflow/types.ts`: add typed config shapes for semantic navigation if the config belongs in workflow config.
- `extensions/workflow/config/normalize.ts`: normalize semantic navigation config and defaults.
- `extensions/workflow/config/resolve.ts`: resolve Serena-aware tool profiles without mutating defaults.
- `extensions/workflow/runtime/bootstrap.ts`: update generated example catalogs if bootstrap writes workflow config files.
- `extensions/workflow/defaults.ts`: keep default profiles unchanged; optionally add disabled semantic-navigation defaults.
- `extensions/workflow/prompts.ts`: add role-specific Serena guidance behind config-aware prompt composition.
- `examples/workflow.tool-profiles.json`: add optional Serena profile examples only if examples can safely reference external MCP tool names.
- `examples/workflow.agent-catalog.json`: add optional Serena-enabled agent entries or a separate example file.
- `docs/workflow-config-v2.md`: document semantic navigation config and profile wiring.
- `docs/prd-serena-semantic-navigation.md`: keep this PRD updated with final decisions.

Do not edit these areas unless required:

- `extensions/workflow/finalization-gate.ts`: finalization behavior should remain unchanged.
- `extensions/workflow/delegate/completion-evidence*.ts`: evidence semantics should remain unchanged.
- `src/index/sync.ts`: repo-memory sync changes should be a separate lane unless explicitly scoped.

Recommended implementation shape:

1. Add schema/types for `semanticNavigation`.
2. Add config normalization with conservative defaults: disabled, external mode, fallback enabled.
3. Add optional Serena tool lists as data.
4. Add catalog/profile examples.
5. Add prompt guidance that is only active when Serena is enabled for a role.
6. Add diagnostics for inconsistent config, such as `enabled=true` with empty Serena tool lists.
7. Add smoke tests for disabled mode, enabled external mode, readonly role policy, and fallback behavior.

## Suggested Sprint Breakdown

### Story 1: Config Model And Documentation

Implement `semanticNavigation` config support with `disabled` and `external` modes.

Acceptance:

- Config loader accepts absent config and defaults to disabled.
- Config loader accepts enabled external Serena config.
- Invalid provider/mode emits diagnostics instead of throwing in normal load paths.
- Documentation explains external MCP setup and limitations.

### Story 2: Serena-Aware Tool Profiles

Add additive profile/catalog support for Serena-enabled Brain/Coder/Reviewer roles.

Acceptance:

- Default tool profiles remain byte-for-byte behavior compatible.
- Serena profile examples include readonly/edit separation.
- Reviewer profiles do not include edit/refactor tools.
- Coder profile can include configured Serena edit tools only when enabled.

### Story 3: Prompt Guidance

Add role-specific Serena instructions.

Acceptance:

- Brain guidance emphasizes orientation and self-contained delegation.
- Coder guidance requires exact file inspection and validation after semantic edits.
- Reviewer guidance treats Serena output as review coverage, not behavior proof.
- Guidance is absent when Serena is disabled.

### Story 4: Diagnostics And Fallback

Expose configuration diagnostics for Serena setup.

Acceptance:

- Enabled Serena with no configured tool names produces a warning.
- Unknown mode/provider produces a diagnostic.
- Fallback behavior is visible in resolved config/details.
- Missing Serena tools do not break default workflow when fallback is enabled.

### Story 5: Repo-Memory Decoupling Guard

Prevent Serena enablement from triggering repo-memory sync.

Acceptance:

- No Serena config path imports or calls `syncRepo()`.
- Existing repo-memory behavior remains unchanged unless a separate lane changes it.
- Tests cover that resolving Serena profiles does not touch filesystem scanning or SQLite.

## Acceptance Evidence Matrix

| Criterion | Required evidence | Reviewer roles |
| --- | --- | --- |
| Serena disabled preserves current workflow behavior. | Smoke test comparing default resolved tools/prompts before and after absent config. | regression, implementation |
| External Serena mode resolves additive role tool profiles. | Smoke test with enabled config showing Brain/Coder/Reviewer effective tools. | implementation |
| Reviewer readonly policy is enforced. | Test that reviewer Serena profile excludes edit/refactor tools. | behavior, evidence-test |
| Coder receives edit tools only when configured. | Test with explicit `serenaEditTools`; test with empty edit list. | behavior, regression |
| Prompt guidance is role-specific and gated by config. | Snapshot or string tests for disabled/enabled prompts. | implementation, maintainability |
| Serena integration does not call repo-memory sync. | Static import check or targeted test around resolver/config paths. | regression |
| Finalization evidence semantics are unchanged. | Existing finalization/completion evidence smokes still pass. | regression, evidence-test |

## Test Plan

Minimum tests:

- Config normalization: absent, disabled, external enabled, invalid provider, invalid mode.
- Resolver behavior: default profiles unchanged, Serena profiles additive, override precedence preserved.
- Prompt rendering: Serena guidance absent when disabled and present per role when enabled.
- Policy guard: readonly roles cannot receive configured edit tools unless explicitly allowed by role policy.
- No-sync guard: semantic navigation config resolution does not import or execute repo-memory sync.

Recommended commands should use the existing smoke style in `scripts/task-*.ts`.

## Acceptance Criteria

- A project can enable or disable Serena integration without editing TypeScript source.
- Default workflow behavior remains unchanged when Serena is disabled.
- Serena-enabled tool profiles can be selected for Brain/Coder/Reviewer.
- Coder and Reviewer prompts include Serena usage guidance.
- If Serena tools are not available, workflows continue with built-in tools when fallback is enabled.
- No full repo-memory sync runs solely because Serena is enabled.
- Finalization gates continue to require structured evidence and runnable validation where applicable.
- Documentation clearly explains Serena's role and limits.
- Sprint-ready implementation notes identify likely files, non-goals, tests, and evidence requirements.

## Risks

- MCP tool names may vary across Serena versions.
- Serena requires Python/uv and language-server dependencies.
- Managed startup may not be possible without Pi-level MCP lifecycle APIs.
- Too many tools can confuse agents unless prompts and profiles are clear.
- Symbol-aware edits may be unsafe if used without exact file inspection and tests.
- Treating Serena memories as workflow truth would fragment state and weaken finalization gates.
- Over-coupling Serena config to repo-memory config would make it harder to disable either feature independently.

## Open Questions

- Does Pi expose enough runtime API to inspect currently registered MCP tools?
- Does Pi expose enough runtime API to start or configure MCP servers from an extension?
- Which Serena tools should be allowed for reviewer roles in readonly mode?
- Should Serena be configured in `.pi/workflow.json`, `.pi/repo-memory.json`, or a new `.pi/semantic-navigation.json`?
- Should repo-memory be formally deprecated for navigation once Serena is enabled?
- Should Serena-enabled examples live in the default catalog files or in separate opt-in example files?
- Should project onboarding include a one-time Serena index/onboarding step, or should agents call it only when needed?

## Rollout Plan

1. Documentation-only integration guide for external Serena MCP setup.
2. Add config schema and workflow profile variants.
3. Add role prompt guidance.
4. Add diagnostics for Serena availability and active tool profile state.
5. Make repo-memory auto-brief non-blocking or disabled by default.
6. Add optional managed mode only if Pi supports MCP lifecycle management safely.

## Success Metrics

- Reduced time from prompt submit to agent start on large repositories.
- Fewer broad `grep/find/read` scans during code navigation.
- More focused changed file sets from coder agents.
- Reviewer reports cite symbols/references more consistently.
- No regression in finalization gate reliability.
