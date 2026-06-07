/**
 * Barrel for the v2 workflow config layer.
 *
 * Exports v2 normalize/resolve/load helpers used by the runtime. `loadWorkflowConfig`
 * resolves and loads versioned workflow files through this module so v2
 * config and catalog references are consumed at startup/delegate time.
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
