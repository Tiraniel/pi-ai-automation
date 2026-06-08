#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getWorkflowStatusLabel } from "../extensions/workflow/configure";

let failed = 0;

function check(condition: boolean, message: string): void {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		failed += 1;
		return;
	}
	console.log(`PASS: ${message}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-026-workflow-smoke-"));
try {
	const projectDir = path.join(tmpDir, "project");
	const localPath = path.join(projectDir, ".pi", "workflow.local.json");
	fs.mkdirSync(path.dirname(localPath), { recursive: true });
	fs.writeFileSync(localPath, JSON.stringify({ agents: { brain: { provider: "openai", model: "o4-mini" } } }, null, 2), "utf8");

	check(
		getWorkflowStatusLabel({
			profileId: "gonka-hybrid",
			profileSource: "cli",
			projectOverridePath: localPath,
			projectPath: null,
			configDiagnostics: [],
			config: {},
			globalPath: "global",
			projectSettingsPath: null,
			projectSettings: undefined,
			sources: [],
		}) === "wf: cli:gonka",
		"label helper: CLI profile takes precedence over local custom override label",
	);

	check(
		getWorkflowStatusLabel({
			profileId: "gonka-hybrid",
			profileSource: "cli",
			projectOverridePath: localPath,
			projectPath: null,
			configDiagnostics: [{ scope: "project", severity: "warning", code: "w", message: "test" }],
			config: {},
			globalPath: "global",
			projectSettingsPath: null,
			projectSettings: undefined,
			sources: [],
		}) === "wf: cli:gonka ⚠",
		"label helper: CLI profile includes warning marker when diagnostics exist",
	);
} catch (error) {
	console.error("FAIL: runtime exception", error);
	failed += 1;
} finally {
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

const runtimeSource = fs.readFileSync(path.join(process.cwd(), "extensions/workflow/runtime/config.ts"), "utf8");
check(
	runtimeSource.includes("Boolean(loaded.projectPath || loaded.projectOverridePath)"),
	"applyBrainPreset: local override path participates in project override predicate",
);

if (failed > 0) {
	process.exit(1);
}
