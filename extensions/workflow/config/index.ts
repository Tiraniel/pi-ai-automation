/**
 * Barrel for the v2 workflow config layer.
 *
 * Slice 1 intentionally does NOT export a file loader, a default catalog, or
 * any side-effecting module. Consumers that need the resolver should import
 * `resolveWorkflow` and feed it normalized v2 inputs.
 *
 * Slice 2 adds `loadV2Workflow` — the side-effect boundary that reads a v2
 * workflow JSON file plus referenced catalog JSON files from disk and returns
 * a normalized/resolved v2 config. It is still NOT wired into the v1 runtime
 * (`extensions/brain-workflow.ts`); it is a pure loader seam for tests and
 * future slices.
 */

export {
	normalizeAgentCatalog,
	normalizeModelPresetsCatalog,
	normalizePromptPacksCatalog,
	normalizeQualityGatesCatalog,
	normalizeToolProfilesCatalog,
	normalizeV1Config,
	normalizeV2Workflow,
	v1ConfigToV2Workflow,
	v1PresetToV2Agent,
} from "./normalize.js";

export {
	composeRolePrompt,
	resolveWorkflow,
} from "./resolve.js";

export {
	loadV2Workflow,
	type V2WorkflowLoadDiagnostic,
	type V2WorkflowLoadResult,
} from "./load.js";

export {
	asAgentRole,
	asArray,
	asBoolean,
	asDelegateDisplayMode,
	asFlowDirection,
	asInteger,
	asNumber,
	asOptionalStringArray,
	asQualityGateKind,
	asRecord,
	asString,
	asStringArray,
	asThinkingLevel,
	detectConfigVersion,
	isPlainObject,
} from "./guards.js";
