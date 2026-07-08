# Workflow Config v2 — Canonical Runtime-Wired Design

This document defines the v2 workflow config model consumed by the runtime.
`loadWorkflowConfig` in `extensions/brain-workflow.ts` uses the normalizers,
resolver, and `loadV2Workflow` loader to load and compose a v2 workflow from
its catalog files for delegation.

## Goals

1. Split the v1 monolith (`WorkflowConfig` plus `DEFAULT_CONFIG` plus
   profile apply logic in `extensions/brain-workflow.ts`) into a small
   high-level workflow file plus separate catalogs.
2. Make concrete model ids, tool names, prompt text, and quality-gate
   commands live in catalogs, not in the workflow file. The workflow file
   references catalog entries by id only.
3. Add an explicit optional `deepPlanning` workflow block that runs planning-only multi-persona passes in an isolated, room-based flow before coder delegation.
   Planner configurations use `modelPreset` where possible and preserve a v1 `deep_planning` alias in configuration loaders.
4. Preserve v1 behavior. Every v1 `workflow.json` must normalize to a
   workflow whose resolved effective config (model, tools, prompts, swarm
   goals) is identical to what the current v1 deep-merge produces.
5. Make the active flow explicit. Brain orchestration is constrained to a
   declared set of agents (`meta.activeAgents`), defaulting to
   `["brain", "coder", "reviewer"]`.
6. Make coder / reviewer / reviewer-swarm identities composable from the
   same catalog building blocks, so a quality-gate catalog entry is the
   same object whether it is a CI check or a reviewer-swarm goal. Reviewer
   goals/targets are code-review goals derived from the reviewer identity and
   its quality-gate catalog entries, not from top-level v2 flow fields. The
   top-level v2 workflow may only carry compatibility runtime overrides for
   `reviewerSwarm.enabled` and `reviewerSwarm.maxConcurrency`;
   `reviewerSwarm.targets` is not merged from top-level v2 config.
7. Fail loudly on malformed required workflow entries. `normalizeV2Workflow`
   returns `undefined` when `flow` or `roles` is absent, empty, or
   contains any malformed entry; malformed entries are not silently
   dropped. Misconfiguration surfaces at load time, not as silent no-op
   runs.

## File responsibilities

All v2 files declare `version: 2`. The top-level workflow file holds only
high-level orchestration data; the catalogs hold concrete values.

| File | Responsibility | Concretely carries |
| --- | --- | --- |
| `examples/workflow.json` | The high-level workflow. | `meta`, `direction`, `flow`, `roles`, `references`, `deepPlanning` (runtime-wired planning mode exception). `deepPlanning` uses `modelPreset` planner references and stays planning-only. No raw model/tool/prompt/gate identities belong here; a tiny compatibility/runtime overlay may also include `autoApplyBrain`, `profile`, `reviewerSwarm.{enabled,maxConcurrency}`, `delegateDisplay`, and `delegatePaneAutoClose`. |
| `examples/workflow.agent-catalog.json` | Logical agent identities. | `agents[]`: `{id, role, modelPreset?, toolProfile?, promptPacks?, qualityGates?, overrides?}`. |
| `examples/workflow.model-presets.json` | Model preset catalog. | `presets[]`: `{id, provider, model, thinkingLevel?}`. |
| `examples/workflow.tool-profiles.json` | Tool profile catalog. | `profiles[]`: `{id, tools, includeKarpathyGuidelines?}`. |
| `examples/workflow.prompt-packs.json` | Prompt pack catalog. | `packs[]`: `{id, path?, inline?, description?}`. |
| `examples/workflow.quality-gates.json` | Quality gate catalog. | `gates[]`: `{id, description?, kind?, command?}`. |
| `prompt-packs/*.md` | Optional markdown content referenced by `path`. | Optional markdown prompts are optional file-backed metadata; metadata `path` is preserved for downstream loading. |

The example set lives in `examples/` and is intentionally separate from
`extensions/` so the workflow model is documented without touching the v1
runtime.

### Runtime / runtime-wired compatibility overlay on v2 workflows

v2 workflows remain catalog-driven for identities (`agents`, models,
`toolProfiles`, `promptPacks`, `qualityGates`), but the loader keeps a
small compatibility/runtime overlay on top-level for the most common legacy knobs:
`autoApplyBrain`, `profile`, `reviewerSwarm.{enabled,maxConcurrency}`, `delegateDisplay`,
`delegatePaneAutoClose`, and `delegateFallbacks`. These fields are validated and merged by
`loadWorkflowConfig` after catalog adaptation.

`delegateFallbacks` is a v1-compatible local override for the delegate model guard:
it carries optional `coder` and `reviewer` agent presets (provider, model, thinkingLevel)
that the guard tries when the primary model for that role is unavailable. It is a
runtime safety override, not a v2 catalog identity.

`reviewerSwarm.enabled` remains a compatibility switch only for legacy/no-matrix plans: setting it to `false` enables the legacy single-reviewer behavior there.
For matrix-gated `ready` plans that carry an `acceptanceEvidenceMatrix`, role-based reviewer coverage remains required and still runs in role mode even when `reviewerSwarm.enabled` is `false`.

### Optional semanticNavigation runtime block

`semanticNavigation` is an optional runtime configuration block for semantic code navigation backends. It is disabled by default and does not change default Brain/Coder/Reviewer tool profiles or workflow evidence gates.

Supported MVP values:

- `provider`: only `"serena"`.
- `mode`: `"disabled"` or `"external"`.
- `managed` mode is future scope and is not implemented in this MVP.
- role access: `"off"`, `"readonly"`, or `"edit"` for `brain`, `coder`, and `reviewer`.

Example project `.pi/workflow.json` or local `.pi/workflow.local.json` overlay:

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

External mode expects Serena MCP to be configured outside this package, for example in the user's MCP config:

```toml
[mcp_servers.serena]
startup_timeout_sec = 15
command = "serena"
args = ["start-mcp-server", "--project-from-cwd", "--context=codex"]
```

Limitations and evidence boundaries: this block only records configuration. It does not start, install, manage, or validate Serena MCP servers; it does not wire Serena tools into default profiles in this task; and Serena output is navigation context only, not workflow validation evidence. Role-specific Serena prompt guidance is appended only when semantic navigation is enabled for that role with provider `serena` and mode `external`; disabled configs and roles set to `off` keep the base prompts unchanged. When a `roles` map is provided, omitted roles are treated as `off` rather than inheriting default role access. Coder/reviewer completion still requires the same runnable checks and structured evidence as before. If `fallbackToBuiltinTools` is true, agents should continue with built-in `read`, `grep`, `find`, and `ls` when Serena tools are unavailable.

### Opt-in Serena-aware catalog examples

The example catalogs include optional Serena-aware agent/profile variants for projects that already run Serena MCP externally. These entries are additive examples only: `examples/workflow.json` remains bound to `brain-default`, `coder-default`, and `reviewer-default`, and the default profiles `brain-room-only`, `coder-room-and-edit`, and `reviewer-readonly` are unchanged.

To opt in, bind roles to these optional agent ids in a project workflow or overlay:

```json
{
  "roles": [
    { "role": "brain", "agent": "brain-serena-readonly" },
    { "role": "coder", "agent": "coder-serena-and-edit" },
    { "role": "reviewer", "agent": "reviewer-serena-readonly" }
  ]
}
```

The readonly Serena profiles (`brain-serena-readonly` and `reviewer-serena-readonly`) add only navigation tools: `mcp__serena__activate_project`, `mcp__serena__get_symbols_overview`, `mcp__serena__find_symbol`, `mcp__serena__find_referencing_symbols`, and `mcp__serena__search_for_pattern`. The coder opt-in profile (`coder-serena-and-edit`) adds those navigation tools plus explicit edit tools: `mcp__serena__replace_symbol_body`, `mcp__serena__insert_before_symbol`, and `mcp__serena__insert_after_symbol`. Reviewer profiles must stay readonly and must not include Serena edit/refactor/delete/write tools.

Tool resolution precedence is unchanged: `agent.overrides.tools`, when present, replaces the selected tool profile list instead of merging with it. Use an override only for deliberate one-off tool lists; otherwise select one of the catalog profiles above.

- `deepPlanning` remains the explicit runtime-wired planning exception and is
  resolved through the model preset catalog via `loadV2Workflow` + adapter.
- `loadWorkflowConfig` routes `version: 2` files through `loadV2Workflow` and
  keeps legacy v1 compatibility behavior for v1 config files.
- v2 model/tool/prompt/gate identity still comes from catalogs, not top-level
  raw ids on the workflow file.

### Deep-planning config as the explicit runtime-wired exception

`deepPlanning` is intentionally the one explicit runtime-wired feature that is first-class in the top-level workflow object.

`deepPlanning` is for **planning-only** Product Requirements execution before implementation delegation and should not replace Brain synthesis. The default is two Product Requirements agents (`plannerCount: 2`, `maxConcurrency: 2`, `rounds: 2`) that run bounded grill-me discussion. Planners inspect the codebase before asking when possible, ask at most one highest-value question per round with a recommended answer, and update a shared PRD with resolved decisions and open questions. They do not produce implementation plans or code.

Planner entries may include `provider/model/modelPreset` references; **`modelPreset` is the preferred form for v2** and is resolved through `workflow.model-presets.json`.
`deepPlanning` includes `enabled`, `plannerCount`, `maxConcurrency`, `rounds`, `roomIdPrefix`, and `planners` (each with `id`, `role`, `modelPreset`, optional `provider`, `model`, `thinkingLevel`, `instructions`).

Deep-planning is disabled by default (`enabled: false`). Opt in via workflow config with `"deepPlanning": { "enabled": true, ... }` (v1 alias remains `deep_planning`). If Brain honors `brain:deep_planning=required`, or if Brain selects `auto` while config is disabled, Brain must call `workflow_deep_plan` with `force: true` to run planning despite `enabled` being false.
When enabled, `workflow_deep_plan` orchestrates bounded rounds and returns a concise transcript for Brain to synthesize into a memo (PRD draft, resolved decisions, unresolved questions, options, risks, `ready_for_sprint: yes|no`). Brain proceeds with normal planning → implementation delegation only after explicit user confirmation.

Planning artifacts live under `.pi/workflow-runs/<planning-room>/` as durable planning state + materials: `planning-state.json`, `PRD.md`, `memo.md`, and gate snapshots.

Brain/Tool integration: `workflow_planning_state` is the durable PRD-first state surface used by both gate evaluators and slash-command/tool gates; it tracks `scopeClassification` and `prd_started`/`prd_ready_for_sprint`/`sprint_confirmed`/`implementation_confirmed` transitions. `workflow_planning_artifacts` stores `PRD.md` / `memo.md` text in the active planning room. Generic planning affirmations (`approved`/`yes`/`agree`) are treated as continuation only and do not set sprint/implementation confirmations—those require explicit stage-confirmation text.

Planning-room resolution is explicit-first: gates and tools prefer `.pi/workflow-runs/planning-current.json` as the planning-room pointer for non-create paths; for `action=create`, tools prefer the legacy `.pi/workflow-runs/current.json` first as a create fallback target, then use planning-current. For gates/read/update, legacy workflow-current fallback still applies only when that room already contains `planning-state.json`. Without a valid explicit/persistent/planning pointer, planning gates remain blocked and report missing-state guidance.

### V1 deep-planning alias

v1 config uses snake_case for this block (`deep_planning`) and is supported by `readDeepPlanningConfig` as an alias that maps into the normalized `deepPlanning` config.

## Active-flow constraint

`meta.activeAgents` declares the roles Brain is allowed to orchestrate in
this workflow. Defaults to `["brain", "coder", "reviewer"]` when omitted.

- The resolver emits `flow-step-out-of-active-agents` and
  `role-binding-out-of-active-agents` diagnostics for any flow step or
  role binding that references a role outside the active set.
- The resolver emits these diagnostics, and `extensions/brain-workflow.ts`
  enforces active-agent constraints before delegation.

The active-agents set is also the natural seam for the reviewer-swarm
identity: the swarm operates over the goals attached to the `reviewer`
role and is therefore implicitly bounded by the active set.

## Identity composition

The resolver produces a `V2ResolvedRoleIdentity` per role binding. The
identity is the resolved effective model / tool / prompts / gates for that
role at delegation time.

Precedence (high to low): `agent.overrides` > catalog refs. Override
fields compose independently: `overrides.thinkingLevel` overlays the
preset's thinking level even when `overrides.provider`/`overrides.model`
are not set; `overrides.tools`, when present, replaces the profile tool
list; `overrides.includeKarpathyGuidelines` overlays the profile's flag
independently of `overrides.tools`.

1. **Model**: build from `agent.modelPreset` (when present) and overlay
   each `agent.overrides.{provider, model, thinkingLevel}` field on top.
   Missing model preset emits `model-preset-missing`. An override that
   sets only one of `provider`/`model` while the preset does not supply
   the other emits `model-override-incomplete` and leaves the missing
   field absent (no fake strings). When neither a preset nor an override
   supplies a value the resolver emits `model-unresolved` and returns
   `{source: "fallback"}`; callers MUST check `provider`/`model` presence
   before use.
2. **Tools**: build from `agent.toolProfile` (when present) and overlay
   each `agent.overrides.{tools, includeKarpathyGuidelines}` field on
   top. Missing profile emits `tool-profile-missing`.
   `overrides.tools`, when present, replaces the profile's tool list;
   `overrides.includeKarpathyGuidelines` overlays the profile's flag
   independently so a partial override (flag only, no tool list) is
   honored.
3. **Prompts**: walk `agent.promptPacks` in catalog order and resolve each
   id against the prompt-packs catalog. Missing ids emit
   `prompt-pack-missing` and become empty `V2ResolvedPrompt` entries with
   `source: "missing"`. The resolver only consumes `inline` text; `path`
   is surfaced on the resolved identity as metadata and is not injected by
   the resolver.
4. **Quality gates**: walk `agent.qualityGates` in catalog order and
   resolve each id against the quality-gates catalog. Missing ids emit
   `quality-gate-missing`.

The reviewer-swarm identity is a derived projection of the resolved
reviewer role identity. Reviewer goals/targets are not carried directly in
the workflow file; they come from resolved reviewer quality gates whose
catalog gate has `kind === "review-goal"`, surfaced on
`V2ResolvedWorkflow.reviewerSwarm = { goals, goalIds }`.
`loadWorkflowConfig` applies a compatibility overlay for `reviewerSwarm.enabled`
and `reviewerSwarm.maxConcurrency`, but it intentionally does not merge
`reviewerSwarm.targets` from top-level v2 config because targets must remain
catalog-derived. Duplicating reviewer goals between the workflow and the agent
catalog is intentionally rejected: the agent catalog and quality-gates catalog
are the single source of truth, and the swarm identity is composed from them.

The `coder` and `reviewer` identity compositions are intentionally
symmetric — both are agents with a model, a tool list, a stack of prompt
packs, and a stack of quality gates. Reviewer-swarm goals are the same
`V2QualityGate` objects that the reviewer's `qualityGates` references, so
a goal can be both a swarm target and a per-reviewer check.

The pure helper `composeRolePrompt(identity, karpathyGuidelines)`
deterministically composes the prompt text a role receives: override
instructions first, then inline prompt-pack text in catalog order, then
the Karpathy-guidelines block when the resolved tool profile (or override)
opts in.

### Role-based reviewer swarm (matrix-derived)

For non-trivial `ready` architecture plans that carry an `acceptanceEvidenceMatrix`
(see [Runtime contract: architecture evidence matrix](#runtime-contract-architecture-evidence-matrix)),
the reviewer swarm enters role mode automatically:

- **Required reviewer roles are derived from the matrix.** `deriveReviewerRoleTargets`
  walks each `AcceptanceEvidenceMatrixEntry.reviewerRoles`, then layers in the
  default role set (behavior, evidence/test, implementation, maintainability,
  regression, and docs-config when scoped). Matrix-derived roles are the
  single source of truth for required coverage.
- **Explicit Brain `goals` are supplemental only.** Caller-supplied goals are
  attached to every role's task as supplemental context and embedded in the
  consolidated memo, but they never replace or weaken the required role set.
- **Per-role task embeds the contract.** `buildReviewerRoleTask` injects the
  matrix criteria, required evidence, blocking conditions, and hard role
  rules (e.g. rejection of source-string / static-only / prompt-only evidence
  for behavior, evidence-test, and regression) so each reviewer is graded
  against the same rubric the matrix encodes.
- **Fail-closed role evaluator.** Results are run through a fail-closed
  evaluator: an `APPROVED` behavior / evidence-test / regression result that
  relies on source-string / static-only / read-the-source / skipped-running
  / prompt-only evidence is downgraded to `CHANGES_REQUESTED`; an `auto_exit`
  / `process_exit` / `missing` / `legacy` completion is **provisional** and
  blocks required approval unless explicit structured reviewer evidence
  (typed criterion coverage rows, command outcomes, or an explicit reviewer
  evidence declaration) is supplied. The evaluator also surfaces weak
  evidence, prompt-only caveats, unresolved risks, and per-role blocking
  reasons.
- **Final approval is fail-closed on required roles.** A phase can only be
  marked `review_approved` when every required role clears the gate. Any
  required role that returns `CHANGES_REQUESTED`, has an `UNKNOWN` verdict,
  is missing, or is still provisional blocks final approval.
- **Durable consolidated memo.** A consolidated memo covering approvals,
  changes requested, weak evidence, prompt-only caveats, unresolved risks,
  provisional caveats, unknown/failed reviewers, and a final recommendation
  is written to `.pi/workflow-runs/reviewer-memos/<planId>-<phase>.md`
  (path exported as `REVIEWER_MEMO_DIRNAME` from
  `extensions/workflow/delegate/reviewer-memo-file.ts`). The
  `delegate_to_reviewer` tool result surfaces `reviewerMemoPath` and the
  full memo in its details, and the tool's human-readable content reports
  the memo path + decision before the per-target raw outputs.

The role-based contract is implemented by the helpers in
`extensions/workflow/delegate/reviewer-roles.ts`
(`deriveReviewerRoleTargets`, `buildReviewerRoleTask`, the result
evaluator, and `buildReviewerMemoForResults`) plus
`extensions/workflow/delegate/reviewer-memo-file.ts` (memo path + disk
write). The default reviewer target strings and the `review-goal-*`
catalog entries in `examples/workflow.quality-gates.json` mirror the
same role names so the workflow, the swarm, and the catalog stay aligned.

## Resolution and precedence

The resolver takes a normalized `V2Workflow` and a `V2CatalogBundle` and
returns a `V2ResolvedWorkflow`. `loadV2Workflow` is the filesystem-loading
entry point that builds the in-memory bundle from catalog files before
calling `resolveWorkflow`.

Within the resolver, the per-binding precedence is:

```
agent.overrides
  > agent.modelPreset  ->  model-presets catalog
  > agent.toolProfile  ->  tool-profiles catalog
  > agent.promptPacks  ->  prompt-packs catalog
  > agent.qualityGates ->  quality-gates catalog
```

The resolved `reviewerSwarm` is derived from the resolved reviewer role
identity (filtering `qualityGates` to entries whose catalog gate has
`kind === "review-goal"`) — it is not a separate precedence step.
These reviewer goals are implementation-focused checks over changed code,
not approval of architecture-plan text.

### Deep-planner `modelPreset` resolution

Planner entries use the same catalog-first pattern as roles:

1. If `planner.modelPreset` is set, it resolves to `workflow.model-presets.json`.
2. Missing presets emit `deep-planner-model-preset-missing` diagnostics.
3. `model` and `provider` from `planner` override any preset values only when present, so a planner can still customize without losing preset defaults.
4. Missing all model fields produces an unresolved planner model without fabricating values (no fake strings).

The resolved planner list in `loadWorkflowConfig` remains visible in `/workflow` and passed to `workflow_deep_plan`.

## V1 migration path

V1 is preserved end-to-end. The v1 config (`workflow.json` with no
`version` field, shaped like `WorkflowConfig` in
`extensions/brain-workflow.ts`) keeps loading through `loadWorkflowConfig`.
When `version: 2` is present, runtime routes through `loadV2Workflow` and
`resolveWorkflow`.

For migration, the v1 normalizer is a lossless pass-through:

- Every v1 field that has a v2 home is mapped below; compatible runtime/delegate
  settings are preserved as compatibility overlay on the loaded config where safe.
  See the runtime-wired compatibility section above.
- `normalizeV1Config(input: unknown): V1WorkflowConfig | undefined`
  validates shape and drops invalid fields; it does not throw.
- `v1ConfigToV2Workflow(v1)` returns a `{workflow, catalog}` pair that
  composes a v2 workflow with one agent entry per v1 `agents.<role>`.
  The agent's `id` is the role name and its `overrides` block carries
  the v1 fields verbatim, so effective behavior remains equivalent for
  v1 migration. Note: the helper bypasses `normalizeV2Workflow` (it is a
  programmatic conversion, not a JSON load), so a v1 with no `agents` will
  produce a v2 with empty `flow`/`roles` that would fail the strict
  normalizer if re-loaded from JSON. This is acceptable because the strict
  normalizer applies to user-supplied v2 files, not to v1 -> v2 derived
  data.

V1 -> V2 field map:

| v1 field | v2 home |
| --- | --- |
| `autoApplyBrain` | preserved as a compatibility override by `loadWorkflowConfig` when a v2 workflow is selected; v1 `profile` mode remains the legacy migration path for pre-v2 configs. |
| `delegateDisplay` | preserved as a compatibility override by `loadWorkflowConfig`; these overlay fields do not change catalog identity resolution. |
| `delegatePaneAutoClose` | preserved as a compatibility override by `loadWorkflowConfig`; these overlay fields do not change catalog identity resolution. |
| `agents.<role>.{provider, model, thinkingLevel, tools, instructions, includeKarpathyGuidelines}` | `agents[].overrides.*` (with `agents[].id` = `<role>` and `agents[].role` = `<role>`) |
| `deep_planning` | `deepPlanning` (canonical). The v2 alias supports planner references (`modelPreset`) and planner rounds/concurrency settings. |
| `reviewerSwarm.{enabled, maxConcurrency}` | preserved as compatibility overrides by `loadWorkflowConfig` while reviewer-swarm goals are still derived from the resolved reviewer identity and quality-gate catalog. |
| `profile` | preserved as a compatibility override by `loadWorkflowConfig` for v2 profile selection; catalog identities are the preferred v2 approach. |

The v1 `profile` mechanism (built-in `default`, `gonka-hybrid`,
`premium-brain-gonka-workers`) remains supported for legacy v1 inputs. For v2 files,
`profile` is preserved as a compatibility overlay by `loadWorkflowConfig`, while catalog identities remain the canonical behavior source.

## Runtime-wired compatibility and canonical examples

- `extensions/brain-workflow.ts` is the runtime host for profiles, providers,
  room tools, delegate transport, and other workflow features; it now consumes
  resolved v2 configs via `loadWorkflowConfig` when versioned files are selected.
- `examples/workflow.json` is the canonical high-level v2 example workflow.
  Keep `workflow.agent-catalog.json`, `workflow.model-presets.json`,
  `workflow.tool-profiles.json`, `workflow.prompt-packs.json`, and
  `workflow.quality-gates.json` nearby.
- `package.json` and the dependency set are untouched. No new dependencies,
  no `pnpm install`.
- `loadWorkflowConfig` now also loads nearest `.pi/workflow.local.json` after `.pi/workflow.json`; this optional file is a local-only runtime override (fields like `profile`, `agents`, `delegateDisplay`, etc.) and is applied before CLI `--workflow-profile`.
- `/workflow_cfg` is the interactive editor for that local override: it uses block-level Apply menus (Profile, Profile config, Runtime settings) where each block writes independently to `.pi/workflow.local.json`. It also exposes coder and reviewer fallback model rows using the existing searchable model picker. Catalog files (`.pi/workflow.json` and the v2 catalog sidecars) are never mutated, and cancel/back paths never write.
- The Profile config block hydrates from the effective loaded config plus the latest `.pi/workflow.local.json` override: if the local override defines any `agents`, the Custom row is shown as active and the Custom and fallback submenus are seeded from the current effective values (so a role is not misleadingly shown as `(default)`). The Custom per-role submenu and the Delegate fallback models submenu loop internally after a pick/clear action, so several fields can be changed in one visit; Esc/Back returns to the Profile config root without writing. Read-only Default/Gonka field views dismiss with Esc via Pi TUI key matching (`Key.escape` / `matchesKey`) and do not advertise a useless Enter action.
- The Custom per-role menu and the Delegate fallback models submenu are stack-based: selecting a `coder` / `reviewer` (or `coder fallback` / `reviewer fallback`) model row opens the model picker; Enter on a model opens the thinking picker constrained to that model; Enter on a thinking level stages both and returns to the params menu. The model row description shows the staged model and thinking level together, and there are no duplicated standalone `coder thinking` / `reviewer thinking` rows (Brain keeps its standalone `brain thinking` row until Brain is also converted to the chained flow). Esc on the thinking picker returns to the model picker (no commit); Esc on the model picker returns to the params menu with no model staged. The parent Profile config → Apply remains the only disk write for staged changes.

## Example v2 file set

See `examples/workflow.json` and the matching catalog files listed above.
The example workflow is the default three-agent flow (brain -> coder ->
reviewer) with a role-based six-goal reviewer swarm.

## File layout

```
extensions/workflow/
  types.ts
  config/
    guards.ts
    load.ts
    normalize.ts
    resolve.ts
    index.ts
  deep-planning.ts
  deep-planning-core.ts
  runtime/
    bootstrap.ts
    config.ts
    v2-adapter.ts
examples/
  workflow.json
  workflow.agent-catalog.json
  workflow.model-presets.json
  workflow.tool-profiles.json
  workflow.prompt-packs.json
  workflow.quality-gates.json
  prompt-packs/
    brain-orchestrator-core.md
    coder-implementer-core.md
    karpathy-guidelines.md
docs/
  workflow-config-v2.md   (this file)
```

## Runtime contract: architecture evidence matrix

Brain architecture plans carry an optional per-criterion `acceptanceEvidenceMatrix` (typed in `extensions/workflow/architecture/types.ts`; normalized/validated in `extensions/workflow/architecture/evidence-matrix.ts`; enforced in `extensions/workflow/architecture/store.ts` and `extensions/workflow/architecture/gate.ts`). The matrix is part of the workflow contract, not a free-form note, so the Brain -> coder -> reviewer chain is anchored in concrete proof obligations.

- `draft` plans may omit the matrix. The hard lock only applies once a plan is marked `ready` or once delegation is requested.
- `ready` plans must include a matrix that covers every acceptance criterion exactly once, with non-empty `enforcementLevel`, `requiredEvidence`, `reviewerRoles`, and `blockingConditions` per entry. Duplicate or extra matrix entries are rejected; structural issues produce matrix-specific rejection codes.
- A matrix entry whose only `enforcementLevel` is `prompt-only` is rejected when `criterionKind === "runtime-behavior"`. Any entry that uses `prompt-only` (including `documentation` / `planning-artifact` / `manual-process` criteria) must also set `promptOnlyCaveat`. This keeps docs/admin fixes lightweight while preventing prompt-only mitigations from being misrepresented as runtime enforcement.
- `validatePhaseGate` returns matrix-specific rejection codes (`acceptance_matrix_missing`, `acceptance_matrix_incomplete`, `acceptance_matrix_invalid`, `acceptance_matrix_prompt_only_invalid`) for ready-looking plans that are missing coverage, malformed, or legacy. Legacy plans without a matrix remain readable so existing plan files do not break, but delegation is blocked until they are updated.
- `buildArchitectureContext` renders the matrix in the delegated coder/reviewer context and adds role-specific instructions (coder maps completion evidence back to matrix entries; reviewer verifies per-entry required evidence and reviewer-role coverage). Coder and reviewer tools receive the same matrix via `buildArchitectureContext`, so a reviewer cannot approve a phase whose matrix entries have not been satisfied.
- Tiny admin / debug entries and docs-only criteria remain lightweight: they may use `prompt-only` with a caveat and skip behavior tests. The hard lock is on the *content* of the matrix, not on the existence of behavior tests for non-runtime criteria.

## Runtime contract: coder completion evidence gate

`delegate_to_coder` enforces a strict matrix-gated completion contract via `extensions/workflow/delegate/completion-evidence-gate.ts` (`evaluateCoderPhaseAdvancement` / `runCompletionEvidenceGate`). The gate runs after `runDelegateAgent` returns and before `markArchitecturePhaseUpdate(..., coder_completed)` so pane and headless transports share the same boundary.

- A coder phase whose plan is `ready` and has an `acceptanceEvidenceMatrix` must include a structured `coderEvidence` packet — typically via the child `sub_agent_done` / `workflow_delegate_done` done sidecar, or via intentionally-supported structured result details for headless transports. The packet must contain `filesChanged`, `commandsRun` (each with `outcome` of `passed` / `failed` / `skipped` plus a short `summary`), and a `criterionCoverage` row per matrix entry keyed by the exact criterion text with `evidenceKind`, `strength`, `supportingFiles`, `supportingCommands`, and a one-line `summary`.
- Free-form final assistant text — `auto_exit` (pane fallback), headless `legacy` / generic `completed`, or any free-form-only completion — is **diagnostic only** for ready matrix-gated plans and never advances the phase. The gate emits `free_form_only`, `auto_exit_incomplete`, `process_exit_incomplete`, or `missing_sidecar_incomplete` rejection codes so the diagnostics stay visible.
- Evidence-source precedence: explicit structured completion evidence written by the completion tool / sidecar is preferred; intentionally supported structured result details may be accepted only if parsed by the same validator; free-form final assistant text is never sufficient.
- Source-string / static-only / prompt-only evidence is not sufficient for `runtime-behavior` / `behavior-test` matrix rows — only runnable supporting commands that actually passed count. Failed / retry / auto-exit delegate history is preserved in the `delegateHistory` block and surfaced in the handoff / Brain pre-review summary.
- Tiny / admin / debug lightweight exceptions remain available only for non-matrix-gated plans. A ready matrix-gated plan always refuses the lightweight bypass (`lightweight_bypass_refused`) so the strict gate cannot be silently bypassed.

## v2 loader contract

`extensions/workflow/config/load.ts` provides `loadV2Workflow(workflowFilePath)`:

- Reads the workflow JSON file at the given path.
- Parses JSON with explicit diagnostics on read/parse failures.
- Resolves catalog references relative to the workflow file directory.
- Rejects absolute or escaping catalog reference paths
  (`catalog-reference-unsafe` diagnostic).
- Normalizes workflow/catalog JSON with the existing normalizers.
- Calls `resolveWorkflow` with whatever catalogs loaded successfully so
  downstream resolver diagnostics remain visible even when some catalogs fail.
- Returns `{ workflow?, catalogs?, resolved?, diagnostics }`.

## Workflow quality audit (advisory finalization linkage)

Brain exposes a deterministic workflow-quality audit so it can see
historical/session risk before finalizing future tasks. The audit scans
local-only artifacts (no network, no external LLM):

- Delegate manifests and sidecars under `.pi/workflow-runs/delegates/`
  for failed coder runs, missing done records, `auto_exit` /
  `process_exit` completions, and repeated reviewer retries.
- Sprint task files, debug items, and `PROGRESS.md` notes under
  `.sprints/` for prompt-only completion language, static-only
  interactive validation, repeated-same-area debug chains after a
  `done` task, and known historical risky tasks.
- Optional file-size metrics over `extensions/**` and `scripts/**` for
  oversized source/smoke files (`workflow_cfg_large_file`,
  `oversized_file`).

Public tool: `workflow_quality_audit_report`. Companion tools:
`workflow_run_quality_audit`, `workflow_render_quality_audit_report`,
`workflow_build_quality_audit_summary`. Implementation is split across
`extensions/workflow/quality-audit*.ts` and covered by
`scripts/task-009-workflow-quality-audit-smokes.ts` (with fixtures in
`task-009-workflow-quality-audit-fixtures.ts`).

Finalization integration:

- `evaluateSprintTaskFinalizationFromDisk` runs the audit during
  finalization and persists a task-filtered summary to
  `.pi/workflow-runs/quality-audit/<TASK-ID>-quality-audit-summary.json`.
- `evaluateFinalizationGate` exposes the audit as
  `details.qualityAudit` (summary, artifact link/path, finding counts,
  by-code, by-severity, first finding messages) and adds advisory
  warnings.
- Audit findings produce warnings/details only. They are advisory by
  design and never create hard blockers on their own; existing strict
  blockers (plan/memo/coder evidence) are preserved.

## Three-lane automation and AFK supervisor

The sprint subsystem exposes a three-lane automation model with a
local-only AFK (away-from-keyboard) supervisor MVP. This section is
the gate-preservation companion to `README.md` "Three-lane automation
flow and AFK supervisor"; it is intentionally short and points at the
shared contracts.

### Lanes and tools

- Lane vocabulary: exactly `full-sprint | hotfix | debug`. Hotfix kind
  vocabulary: exactly `code-changing | text-evidence-only`. Debug
  next-lane vocabulary: exactly `hotfix | full-sprint |
  no-code/report-only`. Vocabulary is enforced by the
  `AutomationLane` / `HotfixKind` / `DebugNextLane` enums in
  `extensions/sprint/lane-policy.ts`.
- AI tools: `sprint_classify_lane` (policy classifier) and
  `sprint_ship` (AFK supervisor) registered from
  `extensions/sprint/ship-tools.ts`. Slash command:
  `/sprint task ship <TASK-ID> --afk [--lane <lane>]
  [--hotfix-kind <kind>] [--run-id <id>] [--scope <text>]
  [--retry-budget <n>]`.
- Durables: state.json + REPORT.md at
  `.pi/workflow-runs/afk-ship/<runId>/`; the path is always
  repo-relative and canonical.

### Gate preservation

- `full-sprint` lane start calls
  `evaluatePlanningGate(cwd, roomId, 'implementation')` and **does
  not** create AFK state when the gate denies. The existing
  `delegate_to_coder` PRD/architecture/implementation gate and the
  `delegate_to_reviewer` review path remain the only implementation
  path for non-trivial work.
- `hotfix` and `debug` starts are lightweight and not PRD-gated;
  code-changing hotfix reviewer requirement is enforced by the Phase A
  `defaultReviewerRequiredFor` contract (durable state
  `reviewerRequired=true`). Text-evidence-only is reviewer-free only
  when concrete `textOnlyConcreteRefs` + `textOnlyValidationEvidence`
  are present and the changed refs do not look like code/control-flow
  paths (defensive backstop: `.ts`/`.tsx`/`extensions/`/`src/`/...
  paths are always refused, even when `textOnlyClass=prompt-template`).
- `delivery_complete` requires finalization summary/result AND
  workflow quality audit summary/artifact. A reviewer-required lane
  additionally requires an `approved` reviewer outcome; a
  `changes-requested` outcome blocks delivery.

### Default-deny remote actions

- AFK supervisor default `ShipPermissions` deny `push`, `pr`, `deploy`,
  `destructive`, and `credentialed`. The `remote_action_requested`
  engine event with a default-deny permission emits an
  `unauthorized-remote-action` stop condition.
- The `sprint_ship` and `sprint_classify_lane` tool surface never
  shells out to remote publishing, PR creation, deploy, publish, or
  any credentialed action. The supervisor only inspects/writes local
  files under `.pi/workflow-runs/afk-ship/<runId>/`. Push/PR/deploy
  require separate explicit opt-in (e.g. setting
  `permissions.push=true` on the durable state) and are out of scope
  for the default MVP path.
- See `scripts/task-011-three-lane-afk-smokes.ts` (behavior tests) and
  `scripts/task-011-phase-b-smokes.ts` (integration smokes) for the
  runtime evidence backing these defaults.
