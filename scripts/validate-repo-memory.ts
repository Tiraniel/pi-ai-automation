#!/usr/bin/env node
/**
 * Local validation suite for pi-ai-automation-memory.
 * Run with: npx jiti scripts/validate-repo-memory.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawn } from "node:child_process";

import piAiAutomationMemory from "../src/index";
import { syncRepo } from "../src/index/sync";
import { openDb, closeDb } from "../src/index/db";
import { appendEvidence } from "../src/evidence/queue";
import { loadConfig } from "../src/config/loader";
import { resolvePreset, BUILT_IN_PRESETS } from "../src/models/presets";
import { deriveRepoKey } from "../src/cache/paths";
import {
	generateFindings,
	rankFindings,
	persistFindings,
	readFindingsFromDb,
	loadAllPrinciples,
	persistPrinciples,
} from "../src/integrity/consultant";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		failed++;
	} else {
		console.log(`PASS: ${msg}`);
		passed++;
	}
}

function cleanup(dir: string) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

// ------------------------------------------------------------------
// a) Extension load / no-load-scan
// ------------------------------------------------------------------
async function testA_noLoadScan() {
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-a-home-"));
	const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-a-cwd-"));
	const oldHome = process.env.HOME;
	process.env.HOME = tmpHome;

	try {
		const registered: any[] = [];
		const fakePi = {
			registerTool(t: any) {
				registered.push(t);
			},
			registerCommand(_n: string, _c: any) {},
			on(_e: string, _h: any) {},
		};

		piAiAutomationMemory(fakePi as any);

		assert(registered.some((t) => t.name === "repo_context"), "a: repo_context registered");
		assert(registered.some((t) => t.name === "repo_checkpoint"), "a: repo_checkpoint registered");
		assert(registered.some((t) => t.name === "repo_health_report"), "a: repo_health_report registered");
		assert(registered.some((t) => t.name === "repo_index_status"), "a: repo_index_status registered");

		const cacheDir = path.join(tmpHome, ".pi", "agent", "repo-memory");
		assert(!fs.existsSync(cacheDir), "a: no cache dir created on extension load");
	} finally {
		process.env.HOME = oldHome;
		cleanup(tmpHome);
		cleanup(tmpCwd);
	}
}

// ------------------------------------------------------------------
// b) Non-git repo sync
// ------------------------------------------------------------------
async function testB_nogitSync() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-b-"));
	const repoKey = deriveRepoKey(tmpDir);
	try {
		fs.writeFileSync(path.join(tmpDir, "hello.txt"), "world");
		const result = syncRepo(tmpDir, repoKey, "");
		assert(result.contextVersion.startsWith("nogit-"), "b: context_version starts with nogit-");
		assert(result.totalFiles >= 1, "b: at least one file indexed");
	} finally {
		cleanup(tmpDir);
	}
}

// ------------------------------------------------------------------
// c) Git dirty tree
// ------------------------------------------------------------------
async function testC_gitDirty() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-c-"));
	const repoKey = deriveRepoKey(tmpDir);
	try {
		execSync("git init", { cwd: tmpDir, stdio: "ignore" });
		execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "ignore" });
		execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "ignore" });
		fs.writeFileSync(path.join(tmpDir, "file.txt"), "original");
		execSync("git add file.txt", { cwd: tmpDir, stdio: "ignore" });
		execSync("git commit -m 'init'", { cwd: tmpDir, stdio: "ignore" });

		fs.writeFileSync(path.join(tmpDir, "file.txt"), "modified");

		const result = syncRepo(tmpDir, repoKey, "");
		assert(result.isDirty === true, "c: isDirty true");
		assert(result.dirtyCount >= 1, "c: dirtyCount >= 1");
		assert(result.contextVersion.includes("-dirty"), "c: contextVersion includes -dirty");
	} finally {
		cleanup(tmpDir);
	}
}

// ------------------------------------------------------------------
// d) Concurrent checkpoints (multi-process)
// ------------------------------------------------------------------
async function testD_concurrentCheckpoints() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-d-"));
	const repoKey = deriveRepoKey(tmpDir);
	try {
		fs.writeFileSync(path.join(tmpDir, "file.txt"), "data");
		// Pre-sync to create DB
		syncRepo(tmpDir, repoKey, "");

		// Write a small JS helper that uses jiti to import appendEvidence
		const helperPath = path.join(tmpDir, "append-helper.js");
		const queueTs = path.resolve(__dirname, "..", "src", "evidence", "queue.ts").replace(/\\/g, "/");
		const helperCode = `
const jiti = require('jiti')();
const { appendEvidence } = jiti(${JSON.stringify(queueTs)});
appendEvidence(
  {
    repoKey: process.env.REPO_KEY,
    repoRoot: process.env.REPO_ROOT,
    contextVersion: "v1",
    agentId: "coder",
    agentRole: "coder",
    agentRunId: process.env.RUN_ID,
    taskId: null,
    claim: process.env.CLAIM,
    evidenceRefs: ["file.txt"],
    testRefs: [],
    reviewRefs: [],
    confidence: 0.8,
    changedFiles: [],
    metadata: null,
    isStale: 0,
    staleReason: null,
  },
  500,
  4096,
  168,
);
`;
		fs.writeFileSync(helperPath, helperCode);

		const N = 5;
		const children: ReturnType<typeof spawn>[] = [];
		for (let i = 0; i < N; i++) {
			const child = spawn("node", [helperPath], {
				env: {
					...process.env,
					REPO_KEY: repoKey,
					REPO_ROOT: tmpDir,
					RUN_ID: `run-${i}`,
					CLAIM: `Concurrent claim ${i}`,
				},
				stdio: "pipe",
			});
			children.push(child);
		}

		const exits = await Promise.all(
			children.map(
				(c) =>
					new Promise<number>((resolve) =>
						c.on("close", (code) => {
							resolve(code ?? 1);
						}),
				),
			),
		);

		assert(exits.every((c) => c === 0), `d: all child processes exited 0 (got: ${exits.join(", ")})`);

		// Check evidence count in DB
		const handle = openDb(repoKey, tmpDir);
		try {
			const row = handle.db
				.prepare("SELECT COUNT(*) as c FROM evidence WHERE repo_key = ?")
				.get(repoKey) as { c: number };
			assert(row.c >= N, `d: evidence count ${row.c} >= ${N}`);
		} finally {
			closeDb(handle);
		}
	} finally {
		cleanup(tmpDir);
	}
}

// ------------------------------------------------------------------
// e) Stale card behavior
// ------------------------------------------------------------------
async function testE_staleCard() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-e-"));
	const repoKey = deriveRepoKey(tmpDir);
	try {
		const filePath = path.join(tmpDir, "src", "main.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const x = 1;");

		// First sync
		const r1 = syncRepo(tmpDir, repoKey, "");
		assert(r1.totalFiles >= 1, "e: file indexed");

		// Manually set card to fresh with matching source hash
		const handle = openDb(repoKey, tmpDir);
		try {
			const hashRow = handle.db
				.prepare("SELECT content_hash FROM files WHERE repo_key = ? AND relative_path = ?")
				.get(repoKey, "src/main.ts") as { content_hash: string } | undefined;
			assert(!!hashRow, "e: hash row found");
			handle.db
				.prepare(
					`UPDATE files SET card_freshness = 'fresh', card_content = 'old card', card_source_hash = ? WHERE repo_key = ? AND relative_path = ?`,
				)
				.run(hashRow!.content_hash, repoKey, "src/main.ts");
		} finally {
			closeDb(handle);
		}

		// Mutate file
		fs.writeFileSync(filePath, "export const x = 2;");

		// Re-sync
		const r2 = syncRepo(tmpDir, repoKey, "");
		assert(r2.changedFiles >= 1, "e: changedFiles >= 1 after mutation");

		const handle2 = openDb(repoKey, tmpDir);
		try {
			const row = handle2.db
				.prepare(
					"SELECT card_freshness, card_stale_reason FROM files WHERE repo_key = ? AND relative_path = ?",
				)
				.get(repoKey, "src/main.ts") as {
					card_freshness: string | null;
					card_stale_reason: string | null;
				};
			assert(row.card_freshness === "stale", "e: card_freshness is stale");
			assert(
				!!row.card_stale_reason && row.card_stale_reason.includes("content_hash"),
				`e: stale reason mentions content_hash (got: ${row.card_stale_reason})`,
			);
		} finally {
			closeDb(handle2);
		}
	} finally {
		cleanup(tmpDir);
	}
}

// ------------------------------------------------------------------
// f) Config parsing / model presets / scouts
// ------------------------------------------------------------------
async function testF_configPresets() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-f-"));
	try {
		fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".pi", "repo-memory.json"),
			JSON.stringify({
				modelPresets: {
					scout_broad: { enabled: true, budgetTokens: 99999 },
					my_custom: { name: "my_custom", enabled: true, budgetMs: 10000 },
				},
				scouts: {
					enabled: true,
					maxFilesPerRun: 77,
				},
			}),
		);

		const cfg = loadConfig(tmpDir);
		assert(cfg.scouts.enabled === true, "f: scouts.enabled overridden to true");
		assert(cfg.scouts.maxFilesPerRun === 77, "f: scouts.maxFilesPerRun overridden to 77");

		const scoutBroad = resolvePreset("scout_broad", cfg.modelPresets);
		assert(scoutBroad?.enabled === true, "f: scout_broad enabled via override");
		assert(scoutBroad?.budgetTokens === 99999, "f: scout_broad budgetTokens overridden");

		const custom = resolvePreset("my_custom", cfg.modelPresets);
		assert(custom?.enabled === true, "f: my_custom resolved");
		assert(custom?.budgetMs === 10000, "f: my_custom budgetMs set");

		// Defaults unchanged for non-overridden presets
		const indexKeeper = resolvePreset("index_keeper", cfg.modelPresets);
		assert(indexKeeper?.enabled === true, "f: index_keeper default unchanged");
		assert(
			indexKeeper?.budgetTokens === BUILT_IN_PRESETS.index_keeper.budgetTokens,
			"f: index_keeper budgetTokens unchanged",
		);
	} finally {
		cleanup(tmpDir);
	}
}

// ------------------------------------------------------------------
// g) Health report ranking / Gantt via fake tool execute
// ------------------------------------------------------------------
async function testG_healthReport() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-g-"));
	const repoKey = deriveRepoKey(tmpDir);
	try {
		fs.writeFileSync(path.join(tmpDir, "src.ts"), "// TODO: fix this\nexport const a = 1;");
		fs.writeFileSync(path.join(tmpDir, "lib.ts"), "export const b = 2;");

		// Sync and seed principles/findings
		const sync = syncRepo(tmpDir, repoKey, "");
		const handle = openDb(repoKey, tmpDir);
		try {
			const principles = loadAllPrinciples(tmpDir);
			persistPrinciples(handle.db, repoKey, principles);

			const findings = generateFindings(
				handle.db,
				repoKey,
				tmpDir,
				sync.contextVersion,
				principles,
				{
					maxFindings: 20,
					categories: null,
					minSeverity: "info",
					forceRefresh: true,
					taskId: null,
					taskFiles: null,
					taskQuery: null,
					includeGantt: false,
				},
			);

			assert(findings.length > 0, "g: findings generated");
			assert(
				findings.some((f) => f.evidenceRefs.length > 0 || f.fileRefs.length > 0),
				"g: findings are evidence-bound or file-bound",
			);

			const ranked = rankFindings(findings, {
				maxFindings: 20,
				categories: null,
				minSeverity: "info",
				forceRefresh: true,
				taskId: null,
				taskFiles: null,
				taskQuery: null,
				includeGantt: false,
			});

			assert(ranked.length > 0, "g: ranked findings > 0");
			assert(ranked[0].rank === 1, "g: top finding has rank 1");
			assert(
				ranked.every((f, i) => f.rank === i + 1),
				"g: ranks are sequential",
			);

			persistFindings(handle.db, repoKey, sync.contextVersion, ranked);
		} finally {
			closeDb(handle);
		}

		// Register repo_health_report with a fake Pi and call execute
		let healthTool: any;
		const fakePi = {
			registerTool(t: any) {
				if (t.name === "repo_health_report") healthTool = t;
			},
			registerCommand() {},
			on() {},
		};
		piAiAutomationMemory(fakePi as any);
		assert(!!healthTool, "g: repo_health_report tool captured");

		const result = await healthTool.execute(
			"call-1",
			{ forceRefresh: true, includeGantt: true, maxFindings: 20 },
			undefined,
			() => {},
			{ cwd: tmpDir },
		);

		const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
		assert(text.includes("```mermaid"), "g: output contains ```mermaid");
		assert(
			text.includes("# repo_health_report"),
			"g: output contains report header",
		);

		// Verify details contain findings that are ranked and evidence-bound
		const details = result.details;
		assert(Array.isArray(details.findings) && details.findings.length > 0, "g: details.findings present");
		assert(
			details.findings.every((f: any) => typeof f.rank === "number" && f.rank > 0),
			"g: all details.findings have positive rank",
		);
		assert(
			details.findings.some((f: any) => (f.fileRefs?.length ?? 0) > 0 || (f.evidenceRefs?.length ?? 0) > 0),
			"g: details.findings are evidence-bound or file-bound",
		);
		assert(details.includeGantt === true, "g: details.includeGantt is true");
		assert(details.refreshed === true, "g: details.refreshed is true");
	} finally {
		cleanup(tmpDir);
	}
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
async function main() {
	console.log("=== pi-ai-automation-memory validation suite ===\n");
	await testA_noLoadScan();
	await testB_nogitSync();
	await testC_gitDirty();
	await testD_concurrentCheckpoints();
	await testE_staleCard();
	await testF_configPresets();
	await testG_healthReport();

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Unhandled error:", err);
	process.exit(1);
});
