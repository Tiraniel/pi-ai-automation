#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getWorkflowStatusLabel } from "../extensions/workflow/configure";
import { applyBrainPreset } from "../extensions/workflow/runtime/config";
import { createFakeContext, createFakePi } from "../tests/fake-pi";

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

// Behavioral: applyBrainPreset must treat a lone .pi/workflow.local.json as a
// project-level workflow override. With only project settings present, the
// settings' defaultModel suppresses the brain preset; the moment a local
// override exists, the preset applies again. (Replaces the old source-string
// grep of runtime/config.ts, which broke on pure refactors.)
async function testApplyBrainPresetLocalOverride(): Promise<void> {
	const behaviorTmp = fs.mkdtempSync(path.join(os.tmpdir(), "task-026-brain-preset-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	// Hermetic global config: point the agent dir at an empty temp dir so the
	// developer's real ~/.pi/agent/workflow.json cannot influence the assertions.
	process.env.PI_CODING_AGENT_DIR = path.join(behaviorTmp, "agent-home");
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	try {
		const settingsOnly = path.join(behaviorTmp, "settings-only");
		fs.mkdirSync(path.join(settingsOnly, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(settingsOnly, ".pi", "settings.json"), JSON.stringify({ defaultModel: "user-picked" }), "utf8");

		const withLocalOverride = path.join(behaviorTmp, "with-local-override");
		fs.mkdirSync(path.join(withLocalOverride, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(withLocalOverride, ".pi", "settings.json"), JSON.stringify({ defaultModel: "user-picked" }), "utf8");
		fs.writeFileSync(
			path.join(withLocalOverride, ".pi", "workflow.local.json"),
			JSON.stringify({ agents: { brain: { provider: "openai", model: "o4-mini" } } }, null, 2),
			"utf8",
		);

		{
			const { pi, setModelCalls } = createFakePi();
			await applyBrainPreset(pi, createFakeContext(settingsOnly));
			check(setModelCalls.length === 0, "applyBrainPreset: project settings defaultModel suppresses the preset when no workflow override exists");
		}
		{
			const { pi, setModelCalls } = createFakePi();
			await applyBrainPreset(pi, createFakeContext(withLocalOverride));
			check(setModelCalls.length === 1, "applyBrainPreset: a lone .pi/workflow.local.json counts as a project workflow override");
			check(setModelCalls[0]?.model === "o4-mini", "applyBrainPreset: the local override's brain model is the one applied");
		}
	} finally {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		fs.rmSync(behaviorTmp, { recursive: true, force: true });
	}
}

testApplyBrainPresetLocalOverride().then(
	() => {
		if (failed > 0) process.exit(1);
	},
	(error) => {
		console.error("FAIL: applyBrainPreset behavioral check threw", error);
		process.exit(1);
	},
);
