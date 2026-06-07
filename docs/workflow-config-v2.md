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
3. Preserve v1 behavior. Every v1 `workflow.json` must normalize to a
   workflow whose resolved effective config (model, tools, prompts, swarm
   goals) is identical to what the current v1 deep-merge produces.
4. Make the active flow explicit. Brain orchestration is constrained to a
   declared set of agents (`meta.activeAgents`), defaulting to
   `["brain", "coder", "reviewer"]`.
5. Make coder / reviewer / reviewer-swarm identities composable from the
   same catalog building blocks, so a quality-gate catalog entry is the
   same object whether it is a CI check or a reviewer-swarm goal. The
   reviewer swarm has no runtime settings on the v2 workflow; its goals
   are owned by the quality-gate catalog and attached to the reviewer
   agent identity through `agentCatalog.agents[].qualityGates`.
6. Fail loudly on malformed required workflow entries. `normalizeV2Workflow`
   returns `undefined` when `flow` or `roles` is absent, empty, or
   contains any malformed entry; malformed entries are not silently
   dropped. Misconfiguration surfaces at load time, not as silent no-op
   runs.

## File responsibilities

All v2 files declare `version: 2`. The top-level workflow file holds only
high-level orchestration data; the catalogs hold concrete values.

| File | Responsibility | Concretely carries |
| --- | --- | --- |
| `examples/workflow.json` | The high-level workflow. | `meta`, `direction`, `flow`, `roles`, `references`. No model ids, tool names, prompt text, runtime settings, or reviewer-swarm configuration. |
| `examples/workflow.agent-catalog.json` | Logical agent identities. | `agents[]`: `{id, role, modelPreset?, toolProfile?, promptPacks?, qualityGates?, overrides?}`. |
| `examples/workflow.model-presets.json` | Model preset catalog. | `presets[]`: `{id, provider, model, thinkingLevel?}`. |
| `examples/workflow.tool-profiles.json` | Tool profile catalog. | `profiles[]`: `{id, tools, includeKarpathyGuidelines?}`. |
| `examples/workflow.prompt-packs.json` | Prompt pack catalog. | `packs[]`: `{id, path?, inline?, description?}`. |
| `examples/workflow.quality-gates.json` | Quality gate catalog. | `gates[]`: `{id, description?, kind?, command?}`. |
| `prompt-packs/*.md` | Optional markdown content referenced by `path`. | Optional markdown prompts are optional file-backed metadata; metadata `path` is preserved for downstream loading. |

The example set lives in `examples/` and is intentionally separate from
`extensions/` so the workflow model is documented without touching the v1
runtime.

### Runtime / delegate settings are explicitly out of v2 workflow scope

The v1 `WorkflowConfig` carries runtime/delegate settings at the top
level — `autoApplyBrain`, `delegateDisplay`, `delegatePaneAutoClose` —
that control how `extensions/brain-workflow.ts` invokes Pi, not what
the workflow does. These are intentionally NOT a v2 workflow concern.

- The v2 `V2Workflow` type has no `runtime` field. `normalizeV2Workflow`
  drops any top-level `runtime` key from the input without warning
  (it is explicitly out-of-scope, not a malformed required entry).
- `loadWorkflowConfig` routes `version: 2` files through `loadV2Workflow`
  and keeps legacy v1 runtime behavior for v1 config files.
- If runtime settings need v2-first-class modeling, the right place is a
  separate runtime-settings/profile artifact, not a field on `V2Workflow`.
  That keeps workflow definitions high-level and shareable across profiles.

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
reviewer role identity. The v2 workflow carries no `reviewerSwarm` field
— the swarm goals are the resolved reviewer quality gates whose catalog
gate has `kind === "review-goal"`, surfaced on
`V2ResolvedWorkflow.reviewerSwarm = { goals, goalIds }`. There is no
`enabled`, `maxConcurrency`, or other runtime setting on the v2 resolved
identity: those remain v1-only and are honored by the legacy v1 compatibility
path in `extensions/brain-workflow.ts`. Duplicating reviewer goals between the
workflow and the agent catalog is intentionally rejected: the agent
catalog and quality-gates catalog are the single source of truth, and
the swarm identity is composed from them.

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

## V1 migration path

V1 is preserved end-to-end. The v1 config (`workflow.json` with no
`version` field, shaped like `WorkflowConfig` in
`extensions/brain-workflow.ts`) keeps loading through `loadWorkflowConfig`.
When `version: 2` is present, runtime routes through `loadV2Workflow` and
`resolveWorkflow`.

For migration, the v1 normalizer is a lossless pass-through:

- Every v1 field that has a v2 home is mapped below; runtime/delegate
  settings are deliberately NOT migrated (see "Runtime / delegate
  settings" above).
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
| `autoApplyBrain` | not migrated — preserved by legacy v1 compatibility behavior in `loadWorkflowConfig`. |
| `delegateDisplay` | not migrated — preserved by legacy v1 compatibility behavior in `loadWorkflowConfig`. |
| `delegatePaneAutoClose` | not migrated — preserved by legacy v1 compatibility behavior in `loadWorkflowConfig`. |
| `agents.<role>.{provider, model, thinkingLevel, tools, instructions, includeKarpathyGuidelines}` | `agents[].overrides.*` (with `agents[].id` = `<role>` and `agents[].role` = `<role>`) |
| `reviewerSwarm.{enabled, maxConcurrency, targets}` | not migrated into the v2 workflow — preserved by legacy v1 compatibility behavior in `loadWorkflowConfig`. Reviewer-swarm configuration in v2 is owned by the quality-gates catalog and the reviewer agent identity's `qualityGates`. |
| `profile` | preserved as `meta.name` (`"v1-profile:<id>"`) only; legacy profiles stay in v1 compatibility mode. |

The v1 `profile` mechanism (built-in `default`, `gonka-hybrid`,
`premium-brain-gonka-workers`) remains supported for legacy v1 inputs. V2
profile-style behavior is now represented through catalog identities, while
legacy profile handling remains available in v1 compatibility mode.

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
- `.pi/workflow.json` behavior is unchanged for override handling.

## Example v2 file set

See `examples/workflow.json` and the matching catalog files listed above.
The example workflow is the default three-agent flow (brain -> coder ->
reviewer) with a four-goal reviewer swarm.

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
