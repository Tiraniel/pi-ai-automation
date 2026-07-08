// Assembles a scratch workspace from a fixture's `changed/` tree, runs its tests
// with `node --test`, and runs the mutation gate: each mutant in `mutants/`
// replaces the implementation and the test suite MUST fail (mutant "killed").
// A surviving mutant proves the tests cannot detect a broken implementation —
// the mechanical definition of a false-success risk.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import type { MutantResult, TestRunResult } from "./types.ts";

const MUTATION_TARGET = "src/submit-controller.ts"; // per-fixture convention; see fixture README

export function assembleWorkspace(fixtureDir: string): string {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-"));
	fs.cpSync(path.join(fixtureDir, "changed"), workspace, { recursive: true });
	return workspace;
}

function findTestFiles(dir: string, prefix = ""): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...findTestFiles(path.join(dir, entry.name), rel));
		else if (entry.name.endsWith(".test.ts")) out.push(rel);
	}
	return out;
}

export function runNodeTests(workspace: string): TestRunResult {
	const testFiles = findTestFiles(workspace);
	if (testFiles.length === 0) return { ok: false, output: "no *.test.ts files found" };
	const proc = spawnSync(process.execPath, ["--test", ...testFiles], {
		cwd: workspace,
		encoding: "utf8",
		timeout: 60_000,
	});
	return { ok: proc.status === 0, output: `${proc.stdout ?? ""}${proc.stderr ?? ""}` };
}

export function runMutationGate(fixtureDir: string): MutantResult[] {
	const mutantsDir = path.join(fixtureDir, "mutants");
	if (!fs.existsSync(mutantsDir)) return [];
	const results: MutantResult[] = [];
	for (const mutant of fs.readdirSync(mutantsDir).filter((f) => f.endsWith(".ts")).sort()) {
		const workspace = assembleWorkspace(fixtureDir);
		try {
			fs.copyFileSync(path.join(mutantsDir, mutant), path.join(workspace, MUTATION_TARGET));
			const run = runNodeTests(workspace);
			// killed = the suite failed on the broken implementation (what we want)
			results.push({ mutant, killed: !run.ok, output: run.output });
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	}
	return results;
}
