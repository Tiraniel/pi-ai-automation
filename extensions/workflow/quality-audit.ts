// TASK-009 Phase A — workflow quality audit public facade.
//
// Re-exports the stable public API consumed by tools, smokes, and (Phase B)
// finalization runtime/gate. Implementation is split across:
//   - quality-audit-types.ts        shared types, defaults, severity, stable codes
//   - quality-audit-scan-helpers.ts file I/O + parsing + emission helpers
//   - quality-audit-scan.ts         scanners and runWorkflowQualityAudit entry
//   - quality-audit-render.ts       markdown render + finalization summary

export {
	DEFAULT_OPTIONS,
	SEVERITY_RANK,
	STABLE_CODES,
	asString,
	countFindings,
	sortFindings,
	AttemptRecord,
	DebugItem,
	DelegateDoneRecord,
	DelegateManifestRecord,
	FindingCounts,
	ParsedArtifact,
	WorkflowQualityAuditFinalizationSummary,
	WorkflowQualityAuditFinding,
	WorkflowQualityAuditOptions,
	WorkflowQualityAuditReport,
	WorkflowQualityAuditSeverity,
} from "./quality-audit-types";

export { runWorkflowQualityAudit } from "./quality-audit-scan";
export {
	renderWorkflowQualityAuditReport,
	buildWorkflowQualityAuditFinalizationSummary,
} from "./quality-audit-render";

import { SEVERITY_RANK, STABLE_CODES } from "./quality-audit-types";

export const severityRank = SEVERITY_RANK;
export const stableCodes = STABLE_CODES;
