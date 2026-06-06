# Workflow Config v2 — Foundation Design (Slice 1 + 2)

This document defines the v2 workflow config model that
`extensions/brain-workflow.ts` will eventually load alongside (or instead of)
the current v1 `WorkflowConfig`. Slice 1 ships the type system, pure
normalizers, a pure resolver, and example files. Slice 2 adds a side-effect-
isolated file loader (`loadV2Workflow`) that reads a v2 workflow JSON file
plus referenced catalog JSON files from disk and returns a normalized/resolved
v2 config. Neither slice wires into `extensions/brain-workflow.ts` or changes
v1 behavior.

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
| `examples/workflow.v2.json` | The high-level workflow. | `meta`, `direction`, `flow`, `roles`, `references`. No model ids, tool names, prompt text, runtime settings, or reviewer-swarm configuration. |
| `examples/workflow.agent-catalog.v2.json` | Logical agent identities. | `agents[]`: `{id, role, modelPreset?, toolProfile?, promptPacks?, qualityGates?, overrides?}`. |
| `examples/workflow.model-presets.v2.json` | Model preset catalog. | `presets[]`: `{id, provider, model, thinkingLevel?}`. |
| `examples/workflow.tool-profiles.v2.json` | Tool profile catalog. | `profiles[]`: `{id, tools, includeKarpathyGuidelines?}`. |
| `examples/workflow.prompt-packs.v2.json` | Prompt pack catalog. | `packs[]`: `{id, path?, inline?, description?}`. |
| `examples/workflow.quality-gates.v2.json` | Quality gate catalog. | `gates[]`: `{id, description?, kind?, command?}`. |
| `examples/prompt-packs/*.md` | Optional markdown content referenced by `path`. | Long-form prompt content for the loader to read. |

The example set lives in `examples/` and is intentionally separate from
`extensions/` so the workflow model is documented without touching the v1
runtime.

### Runtime / delegate settings are explicitly out of v2 workflow scope (Slice 1)

The v1 `WorkflowConfig` carries runtime/delegate settings at the top
level — `autoApplyBrain`, `delegateDisplay`, `delegatePaneAutoClose` —
that control how `extensions/brain-workflow.ts` invokes Pi, not what
the workflow does. These are intentionally NOT a v2 workflow concern in
Slice 1:

- The v2 `V2Workflow` type has no `runtime` field. `normalizeV2Workflow`
  drops any top-level `runtime` key from the input without warning
  (silent drop is acceptable here because the field is explicitly
  out-of-scope, not a malformed required entry).
- V1 files keep their runtime fields and the untouched v1 loader
  (`extensions/brain-workflow.ts`) continues to honor them. The v1 ->
  v2 migration helper does NOT carry them into the v2 workflow; they
  are preserved by the v1 loader that is not replaced.
- If a future slice needs to model runtime settings explicitly, the
  right home is a separate runtime settings / profile artifact — not a
  field on `V2Workflow`. That separation keeps the workflow file
  high-level and shareable across profiles.

## Active-flow constraint

`meta.activeAgents` declares the roles Brain is allowed to orchestrate in
this workflow. Defaults to `["brain", "coder", "reviewer"]` when omitted.

- The resolver emits `flow-step-out-of-active-agents` and
  `role-binding-out-of-active-agents` diagnostics for any flow step or
  role binding that references a role outside the active set.
- Slice 1 only emits the diagnostic. Enforcement of "Brain cannot
  delegate to a non-active role" lives in
  `extensions/brain-workflow.ts` and is a follow-up slice.

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
   is surfaced on the resolved identity for the file loader.
4. **Quality gates**: walk `agent.qualityGates` in catalog order and
   resolve each id against the quality-gates catalog. Missing ids emit
   `quality-gate-missing`.

The reviewer-swarm identity is a derived projection of the resolved
reviewer role identity. The v2 workflow carries no `reviewerSwarm` field
— the swarm goals are the resolved reviewer quality gates whose catalog
gate has `kind === "review-goal"`, surfaced on
`V2ResolvedWorkflow.reviewerSwarm = { goals, goalIds }`. There is no
`enabled`, `maxConcurrency`, or other runtime setting on the v2 resolved
identity: those remain v1-only and are honored by the untouched v1 loader
in `extensions/brain-workflow.ts`. Duplicating reviewer goals between the
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

The resolver takes a normalized `V2Workflow` and an in-memory
`V2CatalogBundle` and returns a `V2ResolvedWorkflow`. Slice 1 deliberately
defines the bundle as an in-memory structure with no filesystem effects.
A follow-up slice can add a thin loader that reads JSON from disk, runs
it through the v2 normalizers, and feeds the result into
`resolveWorkflow`.

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
`extensions/brain-workflow.ts`) keeps loading via the existing
`loadWorkflowConfig` code path. The new module is a parallel, unused
seam.

For migration, the v1 normalizer is a lossless pass-through:

- Every v1 field that has a v2 home is mapped below; runtime/delegate
  settings are deliberately NOT migrated (see "Runtime / delegate
  settings" above).
- `normalizeV1Config(input: unknown): V1WorkflowConfig | undefined`
  validates shape and drops invalid fields; it does not throw.
- `v1ConfigToV2Workflow(v1)` returns a `{workflow, catalog}` pair that
  composes a v2 workflow with one agent entry per v1 `agents.<role>`.
  The agent's `id` is the role name and its `overrides` block carries
  the v1 fields verbatim, so a follow-up slice that swaps the v1 loader
  for a v1 -> v2 -> resolveWorkflow pipeline produces the same effective
  model, tools, and prompts the current code does. Note: the helper
  bypasses `normalizeV2Workflow` (it is a programmatic conversion, not
  a JSON load), so a v1 with no `agents` will produce a v2 with empty
  `flow`/`roles` that would fail the strict normalizer if re-loaded
  from JSON. This is acceptable because the strict normalizer applies
  to user-supplied v2 files, not to v1 -> v2 derived data.

V1 -> V2 field map:

| v1 field | v2 home |
| --- | --- |
| `autoApplyBrain` | not migrated — preserved by the untouched v1 loader (see "Runtime / delegate settings" above). |
| `delegateDisplay` | not migrated — preserved by the untouched v1 loader. |
| `delegatePaneAutoClose` | not migrated — preserved by the untouched v1 loader. |
| `agents.<role>.{provider, model, thinkingLevel, tools, instructions, includeKarpathyGuidelines}` | `agents[].overrides.*` (with `agents[].id` = `<role>` and `agents[].role` = `<role>`) |
| `reviewerSwarm.{enabled, maxConcurrency, targets}` | not migrated into the v2 workflow — preserved by the untouched v1 loader. Reviewer-swarm configuration in v2 is owned by the quality-gates catalog and the reviewer agent identity's `qualityGates`; a future quality-gate migration is the right home for v1 reviewerSwarm. |
| `profile` | preserved as `meta.name` (`"v1-profile:<id>"`) only; built-in profile apply remains v1-only for slice 1. |

The v1 `profile` mechanism (built-in `default`, `gonka-hybrid`,
`premium-brain-gonka-workers`) is intentionally untouched in slice 1. A
follow-up slice can model the v2 equivalent via catalog entries (e.g. a
`"gonka-hybrid"` agent catalog that swaps `coder-default` /
`reviewer-default` for Gonka-backed identities) and have the v1 loader
short-circuit to the v2 resolver when `version: 2` is set.

## What slice 1 does NOT change

- `extensions/brain-workflow.ts` is untouched. The v1 loader, v1
  `DEFAULT_CONFIG`, `KARPATHY_GUIDELINES_PROMPT`, the Gonka provider and
  profiles, the room tools, the delegate tools, and the sprint system
  integration all keep their existing behavior.
- `examples/workflow.json` and `examples/workflow.gonka-hybrid.json` are
  untouched. The v1 examples continue to work exactly as before.
- `package.json` and the dependency set are untouched. No new
  dependencies, no `pnpm install`.
- `.pi/workflow.json` is untouched. Strict coder/reviewer rules remain
  online.

## Example files

See `examples/workflow.v2.json` and the matching
`examples/workflow.*.v2.json` catalog files. The example workflow is the
default three-agent flow (brain -> coder -> reviewer) with a four-goal
reviewer swarm. Each catalog entry is named after its role to make the
mental mapping from v1 easy: the v1 `agents.coder` block becomes a
`coder-default` agent catalog entry whose `overrides` mirror the v1
fields.

## File layout added in slice 1

```
extensions/workflow/
  types.ts
  config/
    guards.ts
    normalize.ts
    resolve.ts
    index.ts
examples/
  workflow.v2.json
  workflow.agent-catalog.v2.json
  workflow.model-presets.v2.json
  workflow.tool-profiles.v2.json
  workflow.prompt-packs.v2.json
  workflow.quality-gates.v2.json
  prompt-packs/
    brain-orchestrator-core.md
    coder-implementer-core.md
    karpathy-guidelines.md
docs/
  workflow-config-v2.md   (this file)
```

## Follow-up slices (out of scope for slice 1 + 2)

- ~~A v2 file loader that reads the catalog files referenced by
  `workflow.v2.json#references` and feeds them into the v2 normalizers
  and resolver.~~ (Slice 2 — `loadV2Workflow` in
  `extensions/workflow/config/load.ts`)
- A swap of `extensions/brain-workflow.ts`'s `loadWorkflowConfig` to use
  the v2 resolver when `version: 2` is present, while keeping the v1
  path for backward compatibility.
- Migration of `examples/workflow.gonka-hybrid.json` to a v2 catalog
  entry (or pair of entries: `coder-gonka` and `reviewer-gonka`).
- Enforcement of `meta.activeAgents` at delegation time in
  `extensions/brain-workflow.ts`.

## Slice 2 loader seam

`extensions/workflow/config/load.ts` provides `loadV2Workflow(workflowFilePath)`:

- Reads the workflow JSON file at the given path.
- Parses JSON with explicit diagnostics on read/parse failures.
- Normalizes via `normalizeV2Workflow`; malformed workflows return diagnostics
  and no `workflow`/`resolved`.
- Resolves `workflow.references` relative to the workflow file directory.
- Rejects absolute or escaping catalog reference paths (`catalog-reference-unsafe`
  diagnostic).
- Loads referenced catalog JSON files and normalizes with existing catalog
  normalizers.
- Calls `resolveWorkflow` with whatever catalogs loaded successfully, so
  downstream resolver diagnostics are visible even when some catalogs fail.
- Returns `{ workflow?, catalogs?, resolved?, diagnostics }`.

The loader is exported from `extensions/workflow/config/index.ts` but is NOT
wired into `extensions/brain-workflow.ts`. It is a pure seam for tests and
future runtime integration.
