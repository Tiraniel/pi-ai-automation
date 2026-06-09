#!/usr/bin/env node
// TASK-002 architecture-plan acceptance/evidence matrix smoke checks.
// Phase A (1-5): direct store/helper coverage for draft, valid matrix, partial coverage,
//   runtime-prompt-only-only, and prompt-only-without-caveat rules.
// Phase B (6-12): ready hard-lock on create/update, validatePhaseGate matrix rejection codes,
//   coder/reviewer context render, and tool schema/forwarding coverage.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildArchitectureContext,
	createArchitecturePlanRecord,
	readArchitecturePlan,
	updatePlanPhase,
	updatePlanRecord,
	validatePhaseGate,
} from "../extensions/workflow/architecture/store";
import { validateEvidenceMatrix } from "../extensions/workflow/architecture/evidence-matrix";
import { registerArchitectureTools } from "../extensions/workflow/architecture/tools";
import type {
	AcceptanceEvidenceMatrixEntry,
	PhaseGateStatus,
	WorkflowPhaseId,
} from "../extensions/workflow/architecture/types";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) { console.log(`PASS: ${message}`); return; }
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function makeEntry(overrides: Partial<AcceptanceEvidenceMatrixEntry>): AcceptanceEvidenceMatrixEntry {
	return {
		criterion: "c1",
		criterionKind: "runtime-behavior",
		businessRiskIfWrong: "service unavailable",
		enforcementLevel: ["behavior-test"],
		requiredEvidence: [{ kind: "behavior-test", description: "covered by behavior test" }],
		reviewerRoles: ["behavior"],
		blockingConditions: ["behavior test fails"],
		...overrides,
	};
}

function expectError(fn: () => unknown): { threw: boolean; message: string } {
	try { fn(); return { threw: false, message: "" }; }
	catch (error) {
		return { threw: true, message: error instanceof Error ? error.message : String(error) };
	}
}

const baseInput = {
	businessPlan: "Business outcome of the matrix enforcement.",
	technicalPlan: "Store-level normalization and helper validation.",
	parallelAssessment: "Serial: matrix is part of the architecture contract.",
	contractBlockPlan: "Hard-lock on invalid matrix; ready plans must cover all criteria.",
	acceptanceCriteria: ["criterion alpha", "criterion beta"],
} as const;

async function main(): Promise<void> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-002-matrix-smoke-"));
	try {
		// 1. Draft plan without matrix can be created/read.
		{
			const plan = createArchitecturePlanRecord({ cwd: tmpDir, planId: "draft-no-matrix", ...baseInput });
			check(plan.status === "draft", "draft plan created with default draft status");
			check(plan.acceptanceEvidenceMatrix === undefined, "draft plan has no matrix when none was supplied");
			const readback = readArchitecturePlan(tmpDir, "draft-no-matrix");
			check(readback !== null, "draft plan readback returns plan");
			check(readback?.acceptanceEvidenceMatrix === undefined, "draft plan readback has no matrix");
			check(readback?.acceptanceCriteria.length === 2, "draft plan readback preserves acceptanceCriteria");
		}

		// 2. Valid supplied matrix persists/readbacks intact.
		{
			const matrix: AcceptanceEvidenceMatrixEntry[] = [
				makeEntry({
					criterion: "criterion alpha", criterionKind: "runtime-behavior",
					businessRiskIfWrong: "alpha path may regress",
					enforcementLevel: ["behavior-test", "regression-proof"],
					requiredEvidence: [{ kind: "behavior-test", description: "behavior test alpha", command: "npx tsx scripts/smoke-alpha.ts" }],
					reviewerRoles: ["behavior", "regression"], blockingConditions: ["alpha behavior test fails"],
				}),
				makeEntry({
					criterion: "criterion beta", criterionKind: "documentation",
					businessRiskIfWrong: "operators lack docs for beta",
					enforcementLevel: ["manual-validation"],
					requiredEvidence: [{ kind: "manual-validation", description: "docs reviewer approval" }],
					reviewerRoles: ["docs-config"], blockingConditions: ["docs reviewer not signed off"],
				}),
			];
			const plan = createArchitecturePlanRecord({ cwd: tmpDir, planId: "draft-with-matrix", ...baseInput, acceptanceEvidenceMatrix: matrix });
			check(plan.acceptanceEvidenceMatrix?.length === 2, "valid matrix persists 2 entries on create");
			check(plan.acceptanceEvidenceMatrix?.[0]?.criterion === "criterion alpha", "first matrix entry criterion preserved on create");
			const readback = readArchitecturePlan(tmpDir, "draft-with-matrix");
			check(readback !== null, "valid-matrix plan readback returns plan");
			check(readback?.acceptanceEvidenceMatrix?.length === 2, "valid-matrix plan readback has 2 entries");
			check(readback?.acceptanceEvidenceMatrix?.[0]?.enforcementLevel?.[0] === "behavior-test", "first readback entry preserves enforcement level");
			check(readback?.acceptanceEvidenceMatrix?.[1]?.requiredEvidence?.[0]?.kind === "manual-validation", "second readback entry preserves evidence kind");
			check(readback?.acceptanceEvidenceMatrix?.[0]?.requiredEvidence?.[0]?.command === "npx tsx scripts/smoke-alpha.ts", "first readback entry preserves evidence command");
		}

		// 3. criterion_missing / coverage failure for ready-style validation.
		{
			const result = validateEvidenceMatrix(
				{ acceptanceCriteria: ["criterion alpha", "criterion beta", "criterion gamma"],
					acceptanceEvidenceMatrix: [makeEntry({ criterion: "criterion alpha", enforcementLevel: ["behavior-test"] })] },
				{ isReadyPlan: true },
			);
			check(result.ok === false, "ready plan with partial coverage is not ok");
			const codes = result.issues.map((issue) => issue.code);
			check(codes.includes("criterion_missing"), "ready partial coverage reports criterion_missing");
			check(result.issues.some((issue) => issue.code === "criterion_missing" && issue.criterion === "criterion beta"), "criterion_missing identifies the missing criterion");
		}

		// 4. runtime_prompt_only_only for runtime-behavior with only prompt-only.
		{
			const result = validateEvidenceMatrix(
				{ acceptanceCriteria: ["runtime-only-criterion"],
					acceptanceEvidenceMatrix: [makeEntry({ criterion: "runtime-only-criterion", criterionKind: "runtime-behavior", enforcementLevel: ["prompt-only"], promptOnlyCaveat: "experimental; tracked for follow-up" })] },
				{ isReadyPlan: true },
			);
			check(result.ok === false, "runtime behavior with only prompt-only is not ok");
			check(result.issues.some((issue) => issue.code === "runtime_prompt_only_only"), "runtime-behavior + only prompt-only reports runtime_prompt_only_only");
		}

		// 5. prompt_only_missing_caveat for prompt-only without caveat.
		{
			const result = validateEvidenceMatrix(
				{ acceptanceCriteria: ["docs-criterion"],
					acceptanceEvidenceMatrix: [makeEntry({ criterion: "docs-criterion", criterionKind: "documentation", enforcementLevel: ["prompt-only"],
						requiredEvidence: [{ kind: "reviewer-approval", description: "reviewer signoff" }],
						reviewerRoles: ["docs-config"], blockingConditions: ["reviewer not signed off"] })] },
				{ isReadyPlan: true },
			);
			check(result.ok === false, "prompt-only without caveat is not ok");
			check(result.issues.some((issue) => issue.code === "prompt_only_missing_caveat"), "prompt-only without caveat reports prompt_only_missing_caveat");
		}

		// 6. Ready create without matrix fails.
		{
			const { threw, message } = expectError(() => createArchitecturePlanRecord({ cwd: tmpDir, planId: "ready-no-matrix", status: "ready", ...baseInput }));
			check(threw, "ready create without matrix throws");
			check(message.startsWith("acceptanceEvidenceMatrix is invalid:"), `ready create without matrix error starts with acceptanceEvidenceMatrix is invalid: (got: ${JSON.stringify(message)})`);
			const readback = readArchitecturePlan(tmpDir, "ready-no-matrix");
			check(readback === null, "ready create without matrix does not persist a plan");
		}

		// 7. Draft -> ready update without matrix fails.
		{
			createArchitecturePlanRecord({ cwd: tmpDir, planId: "draft-to-ready", ...baseInput });
			const { threw, message } = expectError(() => updatePlanRecord(tmpDir, "draft-to-ready", { status: "ready" }));
			check(threw, "draft -> ready update without matrix throws");
			check(message.startsWith("acceptanceEvidenceMatrix is invalid:"), `draft -> ready update error starts with acceptanceEvidenceMatrix is invalid: (got: ${JSON.stringify(message)})`);
			const readback = readArchitecturePlan(tmpDir, "draft-to-ready");
			check(readback?.status === "draft", "draft plan is still draft after rejected update");
		}

		// 8. Ready runtime-behavior with only prompt-only fails at create time.
		{
			const { threw, message } = expectError(() => createArchitecturePlanRecord({
				cwd: tmpDir, planId: "ready-runtime-prompt-only", status: "ready", ...baseInput,
				acceptanceEvidenceMatrix: [
					makeEntry({ criterion: "criterion alpha", criterionKind: "runtime-behavior", enforcementLevel: ["prompt-only"], promptOnlyCaveat: "experimental only" }),
					makeEntry({ criterion: "criterion beta", criterionKind: "runtime-behavior", enforcementLevel: ["prompt-only"], promptOnlyCaveat: "experimental only" }),
				],
			}));
			check(threw, "ready runtime-behavior with only prompt-only throws at create time");
			check(message.includes("runtime_prompt_only_only"), `error mentions runtime_prompt_only_only (got: ${JSON.stringify(message)})`);
		}

		// 9. Ready docs/planning prompt-only with promptOnlyCaveat succeeds.
		{
			const plan = createArchitecturePlanRecord({
				cwd: tmpDir, planId: "ready-docs-prompt-only", status: "ready", ...baseInput,
				acceptanceEvidenceMatrix: [
					makeEntry({ criterion: "criterion alpha", criterionKind: "documentation", enforcementLevel: ["prompt-only"],
						promptOnlyCaveat: "docs-only follow-up; tracked in TASK-002 §6",
						requiredEvidence: [{ kind: "reviewer-approval", description: "docs-config reviewer signoff" }],
						reviewerRoles: ["docs-config"], blockingConditions: ["docs-config reviewer not signed off"] }),
					makeEntry({ criterion: "criterion beta", criterionKind: "planning-artifact", enforcementLevel: ["manual-validation"],
						requiredEvidence: [{ kind: "artifact", description: "planning artifact present in repo" }],
						reviewerRoles: ["docs-config"], blockingConditions: ["planning artifact missing"] }),
				],
			});
			check(plan.status === "ready", "ready docs/planning plan is created as ready");
			check(plan.acceptanceEvidenceMatrix?.length === 2, "ready docs/planning plan persists both matrix entries");
		}

		// 10. validatePhaseGate rejects a ready legacy/no-matrix plan with matrix code.
		{
			// Synthetic ready plan without a matrix, simulating a legacy plan persisted
			// before the matrix contract was required.
			createArchitecturePlanRecord({ cwd: tmpDir, planId: "ready-legacy-no-matrix", ...baseInput });
			const onDisk = readArchitecturePlan(tmpDir, "ready-legacy-no-matrix");
			if (onDisk) {
				const file = path.join(tmpDir, ".pi", "workflow-architecture", "plans", "ready-legacy-no-matrix.json");
				const legacyReady = { ...onDisk, status: "ready" as const };
				delete (legacyReady as { acceptanceEvidenceMatrix?: AcceptanceEvidenceMatrixEntry[] }).acceptanceEvidenceMatrix;
				fs.writeFileSync(file, JSON.stringify(legacyReady, null, 2), "utf-8");
			}
			const readback = readArchitecturePlan(tmpDir, "ready-legacy-no-matrix");
			check(readback?.status === "ready", "legacy no-matrix fixture is read back as ready");
			check(readback?.acceptanceEvidenceMatrix === undefined, "legacy no-matrix fixture has no matrix field");
			const phase: WorkflowPhaseId = "phaseA";
			const gate = validatePhaseGate(readback, phase, { forAgent: "coder" });
			check(gate.ok === false, "validatePhaseGate rejects ready legacy/no-matrix plan");
			const matrixCodes = gate.rejections.map((rejection) => rejection.code).filter((code) => code.startsWith("acceptance_matrix_"));
			check(matrixCodes.length > 0, `validatePhaseGate rejection includes at least one acceptance_matrix_* code (got: ${matrixCodes.join(",")})`);
			check(matrixCodes.includes("acceptance_matrix_missing"), `validatePhaseGate rejection includes acceptance_matrix_missing (got: ${matrixCodes.join(",")})`);
		}

		// 11. Valid coder/reviewer context renders matrix section and role-specific text.
		{
			const plan = createArchitecturePlanRecord({
				cwd: tmpDir, planId: "render-matrix", ...baseInput,
				acceptanceEvidenceMatrix: [
					makeEntry({ criterion: "criterion alpha", criterionKind: "runtime-behavior", businessRiskIfWrong: "alpha path may regress",
						enforcementLevel: ["behavior-test", "regression-proof"],
						requiredEvidence: [{ kind: "behavior-test", description: "behavior test alpha", command: "npx tsx scripts/smoke-alpha.ts" }],
						reviewerRoles: ["behavior", "regression"], blockingConditions: ["alpha behavior test fails"] }),
					makeEntry({ criterion: "criterion beta", criterionKind: "documentation", businessRiskIfWrong: "operators lack docs for beta",
						enforcementLevel: ["prompt-only"], promptOnlyCaveat: "docs-only follow-up",
						requiredEvidence: [{ kind: "manual-validation", description: "docs reviewer approval" }],
						reviewerRoles: ["docs-config"], blockingConditions: ["docs reviewer not signed off"],
						manualValidationPlan: "Reviewer walks the docs in the PR diff." }),
				],
			});
			// Force phaseA into a coder-friendly status so the gate is otherwise green
			// for the matrix-rendering assertion (matrix coverage is the focus here).
			const planForRender = { ...plan, status: "draft" as const };
			const coderContext = buildArchitectureContext(planForRender, { phase: "phaseA", forAgent: "coder" });
			const reviewerContext = buildArchitectureContext(planForRender, { phase: "phaseA", forAgent: "reviewer" });
			check(coderContext.includes("Acceptance/evidence matrix:"), "coder context includes Acceptance/evidence matrix: section");
			check(coderContext.includes("Criterion: criterion alpha"), "coder context renders first matrix entry criterion");
			check(coderContext.includes("Enforcement: behavior-test, regression-proof"), "coder context renders enforcement levels for the entry");
			check(coderContext.includes("behavior-test: behavior test alpha (command: npx tsx scripts/smoke-alpha.ts)"), "coder context renders required-evidence kind/description/command");
			check(coderContext.includes("Reviewer roles: behavior, regression"), "coder context renders reviewer roles");
			check(coderContext.includes("promptOnlyCaveat: docs-only follow-up"), "coder context renders promptOnlyCaveat when present");
			check(coderContext.includes("manualValidationPlan: Reviewer walks the docs in the PR diff."), "coder context renders manualValidationPlan when present");
			check(coderContext.includes("Coder completion evidence must map changed files and commands back to these matrix entries."), "coder context includes coder-completion-evidence instruction");
			check(reviewerContext.includes("Acceptance/evidence matrix:"), "reviewer context includes Acceptance/evidence matrix: section");
			check(reviewerContext.includes("Review implementation and validation evidence against the acceptance/evidence matrix; do not approve if required evidence or required reviewer-role coverage is missing."), "reviewer context includes reviewer evidence-review instruction");
			check(reviewerContext.includes("Reviewer must verify each required-evidence item and reviewer-role coverage listed above; do not approve the phase if any entry lacks evidence or role coverage."), "reviewer context includes per-matrix evidence/role coverage summary");
		}

		// 12. Tool source includes acceptanceEvidenceMatrix in record/update schemas.
		{
			const toolsSource = fs.readFileSync(path.join(process.cwd(), "extensions/workflow/architecture/tools.ts"), "utf-8");
			function sectionFor(toolName: string): string {
				const start = toolsSource.indexOf(`name: "${toolName}"`);
				if (start < 0) return "";
				const next = toolsSource.indexOf("pi.registerTool({", start + 1);
				return toolsSource.slice(start, next > 0 ? next : toolsSource.length);
			}
			const recordSection = sectionFor("workflow_record_architecture_plan");
			const updateSection = sectionFor("workflow_update_architecture_plan");
			check(recordSection.length > 0, "workflow_record_architecture_plan tool section located in tools.ts");
			check(updateSection.length > 0, "workflow_update_architecture_plan tool section located in tools.ts");
			check(recordSection.includes("acceptanceEvidenceMatrix"), "workflow_record_architecture_plan TypeBox schema includes acceptanceEvidenceMatrix");
			check(updateSection.includes("acceptanceEvidenceMatrix"), "workflow_update_architecture_plan TypeBox schema includes acceptanceEvidenceMatrix");
			check(recordSection.includes("acceptanceEvidenceMatrix: acceptanceEvidenceMatrixParameters"), "workflow_record_architecture_plan schema references shared matrix parameters");
			check(updateSection.includes("acceptanceEvidenceMatrix: acceptanceEvidenceMatrixParameters"), "workflow_update_architecture_plan schema references shared matrix parameters");
			check(recordSection.includes("acceptanceEvidenceMatrix: (params as any).acceptanceEvidenceMatrix"), "record tool execute path forwards acceptanceEvidenceMatrix to createArchitecturePlanRecord");
			check(updateSection.includes("patch.acceptanceEvidenceMatrix = (params as any).acceptanceEvidenceMatrix"), "update tool execute path forwards acceptanceEvidenceMatrix to updatePlanRecord");
		}

		// 13. Registered TypeBox schemas: matrix entry must not require a top-level
		//     "description" field. Catches the regression where the entry description
		//     string was placed inside the properties map (making description a
		//     required non-schema field on every matrix entry).
		{
			const registered: any[] = [];
			const fakePi = { registerTool: (def: any) => { registered.push(def); } };
			registerArchitectureTools(fakePi as any);
			const recordTool = registered.find((t) => t.name === "workflow_record_architecture_plan");
			const updateTool = registered.find((t) => t.name === "workflow_update_architecture_plan");
			check(!!recordTool, "record tool registered for TypeBox schema inspection");
			check(!!updateTool, "update tool registered for TypeBox schema inspection");
			function getMatrixItemsSchema(tool: any): any {
				return tool?.parameters?.properties?.acceptanceEvidenceMatrix?.items;
			}
			const recordItems = getMatrixItemsSchema(recordTool);
			const updateItems = getMatrixItemsSchema(updateTool);
			check(!!recordItems, "record tool matrix items schema is present");
			check(!!updateItems, "update tool matrix items schema is present");
			check(Array.isArray(recordItems?.required), "record tool matrix items.required is an array");
			check(Array.isArray(updateItems?.required), "update tool matrix items.required is an array");
			check(!recordItems?.required?.includes("description"), "record tool matrix items.required does NOT include 'description'");
			check(!updateItems?.required?.includes("description"), "update tool matrix items.required does NOT include 'description'");
			check(recordItems?.properties?.description === undefined, "record tool matrix items.properties.description is undefined");
			check(updateItems?.properties?.description === undefined, "update tool matrix items.properties.description is undefined");
			check(recordItems?.properties?.criterion !== undefined, "record tool matrix items.properties.criterion is present");
			check(recordItems?.properties?.requiredEvidence !== undefined, "record tool matrix items.properties.requiredEvidence is present");
			check(recordItems?.properties?.promptOnlyCaveat !== undefined, "record tool matrix items.properties.promptOnlyCaveat is present");
			check(updateItems?.properties?.criterion !== undefined, "update tool matrix items.properties.criterion is present");
			check(updateItems?.properties?.requiredEvidence !== undefined, "update tool matrix items.properties.requiredEvidence is present");
			check(updateItems?.properties?.promptOnlyCaveat !== undefined, "update tool matrix items.properties.promptOnlyCaveat is present");
		}

		// 14. Corrupt on-disk acceptanceEvidenceMatrix must NOT silently normalize away:
		// readArchitecturePlan still returns a plan, but validatePhaseGate rejects the
		// ready plan with acceptance_matrix_invalid because the matrix had a malformed
		// row that could not be normalized. Coverage stays valid via other rows so the
		// test specifically exercises the read-issue path (not the coverage path).
		{
			const matrix: AcceptanceEvidenceMatrixEntry[] = [
				makeEntry({ criterion: "criterion alpha", criterionKind: "runtime-behavior", businessRiskIfWrong: "alpha path may regress",
					enforcementLevel: ["behavior-test"], requiredEvidence: [{ kind: "behavior-test", description: "alpha behavior test" }],
					reviewerRoles: ["behavior"], blockingConditions: ["alpha test fails"] }),
				makeEntry({ criterion: "criterion beta", criterionKind: "runtime-behavior", businessRiskIfWrong: "beta path may regress",
					enforcementLevel: ["behavior-test"], requiredEvidence: [{ kind: "behavior-test", description: "beta behavior test" }],
					reviewerRoles: ["behavior"], blockingConditions: ["beta test fails"] }),
			];
			createArchitecturePlanRecord({ cwd: tmpDir, planId: "corrupt-matrix", status: "ready", ...baseInput, acceptanceEvidenceMatrix: matrix });
			const file = path.join(tmpDir, ".pi", "workflow-architecture", "plans", "corrupt-matrix.json");
			const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
			// Append a row whose criterionKind is unknown to force a normalizeMatrix
			// read issue. Surviving valid rows still cover all criteria, so the test
			// only passes if the read-issue path produces acceptance_matrix_invalid.
			onDisk.acceptanceEvidenceMatrix.push({
				criterion: "criterion alpha", // duplicate of an existing criterion, but malformed kind
				criterionKind: "not-a-real-kind",
				businessRiskIfWrong: "duplicate malformed row",
				enforcementLevel: ["behavior-test"],
				requiredEvidence: [{ kind: "behavior-test", description: "should never normalize" }],
				reviewerRoles: ["behavior"],
				blockingConditions: ["never"],
			});
			fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), "utf-8");
			const readback = readArchitecturePlan(tmpDir, "corrupt-matrix");
			check(readback !== null, "corrupt-matrix plan readback still returns a plan (legacy readability preserved)");
			check(readback?.status === "ready", "corrupt-matrix readback keeps status=ready");
			check((readback?.acceptanceEvidenceMatrix?.length ?? 0) === 2, "corrupt-matrix readback drops the malformed row (2 valid entries remain)");
			const gate = validatePhaseGate(readback, "phaseA" as WorkflowPhaseId, { forAgent: "coder" });
			check(gate.ok === false, "validatePhaseGate rejects ready plan whose on-disk matrix had malformed rows");
			check(gate.rejections.some((r) => r.code === "acceptance_matrix_invalid"), "validatePhaseGate rejection includes acceptance_matrix_invalid for read issues");
		}

		// 15. Legacy ready/no-matrix plan must not be phase-mutated: updatePlanPhase
		// must throw and the on-disk phase status must remain unchanged.
		{
			createArchitecturePlanRecord({ cwd: tmpDir, planId: "legacy-phase-mutation", ...baseInput });
			const file = path.join(tmpDir, ".pi", "workflow-architecture", "plans", "legacy-phase-mutation.json");
			const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
			onDisk.status = "ready";
			delete onDisk.acceptanceEvidenceMatrix;
			fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), "utf-8");
			const phaseBefore: PhaseGateStatus = readArchitecturePlan(tmpDir, "legacy-phase-mutation")?.phases.phaseA.status ?? "not_started";
			const { threw, message } = expectError(() => updatePlanPhase(tmpDir, "legacy-phase-mutation", "phaseA" as WorkflowPhaseId, "changes_requested", "audit smoke"));
			check(threw, "updatePlanPhase throws on legacy ready/no-matrix plan");
			check(/acceptanceEvidenceMatrix is invalid/.test(message), `updatePlanPhase error mentions acceptanceEvidenceMatrix is invalid (got: ${JSON.stringify(message)})`);
			const readback = readArchitecturePlan(tmpDir, "legacy-phase-mutation");
			check(readback?.phases.phaseA.status === phaseBefore, "phase status remains unchanged after rejected updatePlanPhase on legacy plan");
			check(readback?.status === "ready", "plan status remains ready after rejected updatePlanPhase on legacy plan");
		}

		// 16. Registered update tool execute path: phaseStatus-only call against a
		// legacy ready/no-matrix plan must return isError and must not mutate the
		// on-disk phase status. Catches the bypass where the tool would have
		// updated the phase without enforcing the ready-plan matrix hard-lock.
		{
			const registered: any[] = [];
			const fakePi = { registerTool: (def: any) => { registered.push(def); } };
			registerArchitectureTools(fakePi as any);
			const updateTool = registered.find((t) => t.name === "workflow_update_architecture_plan");
			check(!!updateTool, "update tool registered for execute regression");
			// Build a minimal ctx compatible with the execute closure: cwd, sessionManager.
			const fakeCtx = { cwd: tmpDir, sessionManager: undefined } as any;
			const phaseBefore: PhaseGateStatus = readArchitecturePlan(tmpDir, "legacy-phase-mutation")?.phases.phaseA.status ?? "not_started";
			const result = await updateTool.execute(
				"test-call",
				{ planId: "legacy-phase-mutation", phase: "phaseA", phaseStatus: "changes_requested" },
				new AbortController().signal,
				() => undefined,
				fakeCtx,
			);
			check(result?.isError === true, "update tool returns isError=true for phaseStatus-only against legacy ready/no-matrix plan");
			check(/acceptanceEvidenceMatrix is invalid/.test(result?.content?.[0]?.text ?? ""), "update tool error message mentions acceptanceEvidenceMatrix is invalid");
			const readback = readArchitecturePlan(tmpDir, "legacy-phase-mutation");
			check(readback?.phases.phaseA.status === phaseBefore, "phase status remains unchanged after rejected update-tool execute");
		}

		// 17. Repair path: malformed on-disk ready plan + valid replacement matrix in
		// the same update call (with phaseStatus) must succeed, write the repaired
		// matrix, and update the phase. This proves the symbol-keyed read issues
		// inherited from a corrupt on-disk plan do not block legitimate repair in
		// workflow_update_architecture_plan.
		{
			const matrix: AcceptanceEvidenceMatrixEntry[] = [
				makeEntry({ criterion: "criterion alpha", criterionKind: "runtime-behavior", businessRiskIfWrong: "alpha path may regress",
					enforcementLevel: ["behavior-test"], requiredEvidence: [{ kind: "behavior-test", description: "alpha behavior test" }],
					reviewerRoles: ["behavior"], blockingConditions: ["alpha test fails"] }),
				makeEntry({ criterion: "criterion beta", criterionKind: "runtime-behavior", businessRiskIfWrong: "beta path may regress",
					enforcementLevel: ["behavior-test"], requiredEvidence: [{ kind: "behavior-test", description: "beta behavior test" }],
					reviewerRoles: ["behavior"], blockingConditions: ["beta test fails"] }),
			];
			createArchitecturePlanRecord({ cwd: tmpDir, planId: "repair-matrix", status: "ready", ...baseInput, acceptanceEvidenceMatrix: matrix });
			// Corrupt the on-disk matrix by appending a malformed row. The valid rows
			// still cover all criteria, so the only thing standing between this plan
			// and a successful update is the symbol-keyed read issues attached on read.
			const file = path.join(tmpDir, ".pi", "workflow-architecture", "plans", "repair-matrix.json");
			const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
			onDisk.acceptanceEvidenceMatrix.push({
				criterion: "criterion alpha",
				criterionKind: "not-a-real-kind",
				businessRiskIfWrong: "duplicate malformed row",
				enforcementLevel: ["behavior-test"],
				requiredEvidence: [{ kind: "behavior-test", description: "should never normalize" }],
				reviewerRoles: ["behavior"],
				blockingConditions: ["never"],
			});
			fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), "utf-8");
			const corruptReadback = readArchitecturePlan(tmpDir, "repair-matrix");
			check(corruptReadback !== null, "repair-matrix corrupt readback returns a plan");
			check((corruptReadback?.acceptanceEvidenceMatrix?.length ?? 0) === 2, "repair-matrix corrupt readback drops the malformed row");
			// Verify validatePhaseGate would reject this plan on the read-issue path.
			const corruptGate = validatePhaseGate(corruptReadback, "phaseA" as WorkflowPhaseId, { forAgent: "coder" });
			check(corruptGate.ok === false, "validatePhaseGate rejects the corrupt on-disk plan");
			check(corruptGate.rejections.some((r) => r.code === "acceptance_matrix_invalid"), "corrupt plan rejection includes acceptance_matrix_invalid");

			// Build a fresh, fully-valid replacement matrix that covers the same criteria.
			const repairedMatrix: AcceptanceEvidenceMatrixEntry[] = [
				makeEntry({ criterion: "criterion alpha", criterionKind: "runtime-behavior", businessRiskIfWrong: "alpha path may regress",
					enforcementLevel: ["behavior-test", "regression-proof"],
					requiredEvidence: [
						{ kind: "behavior-test", description: "alpha behavior test", command: "npx tsx scripts/smoke-alpha.ts" },
						{ kind: "regression-test", description: "alpha regression test" },
					],
					reviewerRoles: ["behavior", "regression"], blockingConditions: ["alpha behavior test fails", "alpha regression test fails"] }),
				makeEntry({ criterion: "criterion beta", criterionKind: "runtime-behavior", businessRiskIfWrong: "beta path may regress",
					enforcementLevel: ["behavior-test"],
					requiredEvidence: [{ kind: "behavior-test", description: "beta behavior test", command: "npx tsx scripts/smoke-beta.ts" }],
					reviewerRoles: ["behavior"], blockingConditions: ["beta behavior test fails"] }),
			];

			// Run the public tool path: workflow_update_architecture_plan execute with
			// a valid replacement matrix + { phase: 'phaseA', phaseStatus: 'changes_requested' }.
			const registered: any[] = [];
			const fakePi = { registerTool: (def: any) => { registered.push(def); } };
			registerArchitectureTools(fakePi as any);
			const updateTool = registered.find((t) => t.name === "workflow_update_architecture_plan");
			check(!!updateTool, "update tool registered for repair-path smoke");
			const fakeCtx = { cwd: tmpDir, sessionManager: undefined } as any;
			const result = await updateTool.execute(
				"test-call",
				{
					planId: "repair-matrix",
					acceptanceEvidenceMatrix: repairedMatrix,
					phase: "phaseA",
					phaseStatus: "changes_requested",
				},
				new AbortController().signal,
				() => undefined,
				fakeCtx,
			);
			check(result?.isError !== true, `update tool execute succeeds for repair path (got: ${JSON.stringify(result?.content?.[0]?.text ?? "")})`);

			// Verify the on-disk matrix is the repaired one (2 entries, repaired criterion).
			const onDiskAfter = JSON.parse(fs.readFileSync(file, "utf-8"));
			check(Array.isArray(onDiskAfter.acceptanceEvidenceMatrix), "repaired plan on-disk matrix is an array");
			check(onDiskAfter.acceptanceEvidenceMatrix.length === 2, "repaired plan on-disk matrix has 2 entries (malformed row replaced)");
			const onDiskCriteria = onDiskAfter.acceptanceEvidenceMatrix.map((e: { criterion: string }) => e.criterion).sort();
			check(JSON.stringify(onDiskCriteria) === JSON.stringify(["criterion alpha", "criterion beta"]), "repaired plan on-disk matrix covers the required criteria");
			const alphaEntry = onDiskAfter.acceptanceEvidenceMatrix.find((e: { criterion: string }) => e.criterion === "criterion alpha");
			check(Array.isArray(alphaEntry?.enforcementLevel) && alphaEntry.enforcementLevel.includes("regression-proof"), "repaired alpha entry preserves the regression-proof enforcement level");
			check(Array.isArray(alphaEntry?.requiredEvidence) && alphaEntry.requiredEvidence.length === 2, "repaired alpha entry preserves the 2 required-evidence items");
			const alphaCmd = alphaEntry?.requiredEvidence?.find((ev: { command?: string }) => Boolean(ev.command));
			check(alphaCmd?.command === "npx tsx scripts/smoke-alpha.ts", "repaired alpha entry preserves the evidence command");

			// Verify the phase status was updated and the plan remains ready.
			const readback = readArchitecturePlan(tmpDir, "repair-matrix");
			check(readback?.phases.phaseA.status === "changes_requested", "phaseA was updated to changes_requested by the repair call");
			check(readback?.status === "ready", "plan status remains ready after the repair call");
			// No Symbol-keyed read issues on the post-repair readback.
			const postGate = validatePhaseGate(readback, "phaseA" as WorkflowPhaseId, { forAgent: "coder" });
			check(postGate.ok === true, `validatePhaseGate accepts the post-repair plan (rejections: ${postGate.rejections.map((r) => r.code).join(",")})`);
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

main()
	.then(() => {
		if (failures > 0) { console.error(`\n${failures} smoke check(s) failed.`); process.exit(1); }
		console.log("\nAll TASK-002 architecture evidence matrix smoke checks passed.");
	})
	.catch((error) => { console.error("FAIL: task-002 smoke runner threw", error); process.exit(1); });
