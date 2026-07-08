// WP2 — verifiable coder evidence (port of agent-harness G7/G9 into the
// main workflow). This module owns the impure half of the verification:
//   - workspace diff snapshots around `runDelegateAgent` (G7 input),
//   - observed-diff computation between two snapshots,
//   - re-run policy resolution + command selection + bounded re-execution
//     of claimed-passed runnable evidence commands (G9).
// The pure folding of these observations into rejection codes lives in
// `completion-evidence.ts` (`evaluateCoderCompletionEvidence` options); the
// orchestration lives in `completion-evidence-gate.ts`.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { EvidenceRerunMode, WorkflowConfig } from "../types";
import {
	RUNNABLE_REQUIRED_KINDS,
	type CoderCompletionEvidence,
	type CoderEvidencePlanShape,
	type EvidenceCommandRerunOutcome,
	type EvidenceRerunSkip,
} from "./completion-evidence";

// ---------- Constants (single owner for WP2 verification budget) ----------

/** Max claimed-passed runnable commands the gate re-runs per coder phase. */
export const EVIDENCE_RERUN_COMMAND_CAP = 5;
/** Wall-clock cap for one re-run command; a hung test must not wedge Brain. */
export const EVIDENCE_RERUN_TIMEOUT_MS = 180000;
/** Default command-prefix allowlist for `evidence.rerunAllowlist`. */
export const DEFAULT_EVIDENCE_RERUN_ALLOWLIST: readonly string[] = [
	"npx tsx",
	"node",
	"npm test",
] as const;
const EVIDENCE_RERUN_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const EVIDENCE_RERUN_OUTPUT_PREVIEW_CHARS = 800;
/** Sentinel content hash for a dirty path that does not exist on disk. */
const MISSING_CONTENT_HASH = "<missing>";
/** Workflow runtime substrate written DURING a delegate run by the harness
 *  itself (done sidecars, manifests, operator questions, room events). It is
 *  not a coder deliverable, so it is excluded from the observed diff — in a
 *  repo that does not gitignore `.pi/`, it would otherwise produce false
 *  `evidence_diff_mismatch` rejections for every run. */
const OBSERVED_DIFF_EXCLUDE_PREFIXES: readonly string[] = [".pi/workflow-runs/"];

// ---------- Workspace diff snapshots (G7) ----------

export interface WorkspaceDiffSnapshot {
	gitAvailable: boolean;
	/** Absolute git worktree root. */
	gitRoot?: string;
	/** HEAD commit sha; undefined on an empty repository (no commits yet). */
	head?: string;
	/** Repo-root-relative posix path -> sha256 of worktree content
	 *  (MISSING_CONTENT_HASH when the dirty path does not exist on disk). */
	dirtyFileHashes: Record<string, string>;
	/** Populated when gitAvailable is false. */
	reason?: string;
}

export interface ObservedWorkspaceDiff {
	verifiable: boolean;
	/** Populated when verifiable is false. */
	reason?: string;
	/** Files changed between the two snapshots, relative to the delegate cwd
	 *  (posix separators). Includes worktree changes and files committed
	 *  between the snapshots' HEADs. */
	changedFiles: string[];
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; error?: string } {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: EVIDENCE_RERUN_MAX_OUTPUT_BYTES });
	if (result.error) return { ok: false, stdout: "", error: result.error.message };
	if (result.status !== 0) return { ok: false, stdout: "", error: (result.stderr || `git ${args[0]} exited ${result.status}`).trim() };
	return { ok: true, stdout: result.stdout ?? "" };
}

function hashWorktreeFile(gitRoot: string, relPath: string): string {
	try {
		const content = fs.readFileSync(path.join(gitRoot, relPath));
		return crypto.createHash("sha256").update(content).digest("hex");
	} catch {
		return MISSING_CONTENT_HASH;
	}
}

/** Parse `git status --porcelain -z` output into repo-root-relative paths.
 *  Rename/copy entries carry two NUL-separated paths; both count as dirty. */
function parsePorcelainZ(stdout: string): string[] {
	const tokens = stdout.split("\0");
	const files: string[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token) continue;
		const status = token.slice(0, 2);
		const file = token.slice(3);
		if (file) files.push(file);
		if (status[0] === "R" || status[0] === "C") {
			const origin = tokens[i + 1];
			if (origin) files.push(origin);
			i += 1;
		}
	}
	return files;
}

export function captureWorkspaceDiffSnapshot(cwd: string): WorkspaceDiffSnapshot {
	const toplevel = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!toplevel.ok) {
		return {
			gitAvailable: false,
			dirtyFileHashes: {},
			reason: `not a verifiable git workspace (${toplevel.error ?? "git rev-parse failed"})`,
		};
	}
	const gitRoot = toplevel.stdout.trim();
	const headResult = runGit(cwd, ["rev-parse", "HEAD"]);
	const head = headResult.ok ? headResult.stdout.trim() : undefined;
	// -uall expands untracked directories into individual files; without it a
	// brand-new directory shows up as one collapsed "dir/" entry and per-file
	// declarations in filesChanged could never match the observed diff.
	const status = runGit(gitRoot, ["status", "--porcelain", "-z", "-uall"]);
	if (!status.ok) {
		return {
			gitAvailable: false,
			gitRoot,
			dirtyFileHashes: {},
			reason: `git status failed (${status.error ?? "unknown error"})`,
		};
	}
	const dirtyFileHashes: Record<string, string> = {};
	for (const file of parsePorcelainZ(status.stdout)) {
		dirtyFileHashes[file] = hashWorktreeFile(gitRoot, file);
	}
	return { gitAvailable: true, gitRoot, head, dirtyFileHashes };
}

function toDelegateCwdRelative(gitRoot: string, delegateCwd: string, repoRelative: string): string {
	// git reports the toplevel as a fully-resolved path; the delegate cwd may
	// still contain symlinks (e.g. /var -> /private/var on macOS), so resolve
	// it the same way before computing the relative path.
	let baseCwd = path.resolve(delegateCwd);
	try {
		baseCwd = fs.realpathSync(baseCwd);
	} catch {
		// keep the lexical resolution; path.relative below still yields a stable result
	}
	const rel = path.relative(baseCwd, path.join(gitRoot, repoRelative));
	return rel.split(path.sep).join("/");
}

/** Compute the set of files that changed between two snapshots of the same
 *  workspace. Fail-closed: any inconsistency (non-git cwd, git failure,
 *  mismatched roots, unresolvable HEAD range) yields `verifiable: false`
 *  instead of an empty diff. */
export function computeObservedWorkspaceDiff(
	before: WorkspaceDiffSnapshot,
	after: WorkspaceDiffSnapshot,
	delegateCwd: string,
): ObservedWorkspaceDiff {
	if (!before.gitAvailable || !after.gitAvailable) {
		return { verifiable: false, reason: after.reason ?? before.reason ?? "git snapshot unavailable", changedFiles: [] };
	}
	if (!before.gitRoot || !after.gitRoot || before.gitRoot !== after.gitRoot) {
		return { verifiable: false, reason: "before/after snapshots point at different git roots", changedFiles: [] };
	}
	const gitRoot = after.gitRoot;
	const changed = new Set<string>();
	const keys = new Set<string>([...Object.keys(before.dirtyFileHashes), ...Object.keys(after.dirtyFileHashes)]);
	for (const key of keys) {
		if (before.dirtyFileHashes[key] !== after.dirtyFileHashes[key]) changed.add(key);
	}
	if (before.head !== after.head) {
		// The delegate committed during the run; committed files no longer show
		// in `git status`, so pull them from the commit range.
		if (!before.head || !after.head) {
			return { verifiable: false, reason: "HEAD changed across snapshots but one side has no resolvable commit", changedFiles: [] };
		}
		const range = runGit(gitRoot, ["diff", "--name-only", "-z", before.head, after.head]);
		if (!range.ok) {
			return { verifiable: false, reason: `git diff ${before.head.slice(0, 12)}..${after.head.slice(0, 12)} failed (${range.error ?? "unknown error"})`, changedFiles: [] };
		}
		for (const file of range.stdout.split("\0")) {
			if (file) changed.add(file);
		}
	}
	const changedFiles = [...changed]
		.map((file) => toDelegateCwdRelative(gitRoot, delegateCwd, file))
		.filter((file) => !OBSERVED_DIFF_EXCLUDE_PREFIXES.some((prefix) => file.startsWith(prefix)))
		.sort();
	return { verifiable: true, changedFiles };
}

// ---------- Re-run policy + selection + execution (G9) ----------

export interface ResolvedEvidenceRerunPolicy {
	mode: EvidenceRerunMode;
	allowlist: string[];
}

export function resolveEvidenceRerunPolicy(config: WorkflowConfig | undefined): ResolvedEvidenceRerunPolicy {
	const mode: EvidenceRerunMode = config?.evidence?.rerun === "off" ? "off" : "required";
	const configured = config?.evidence?.rerunAllowlist;
	const allowlist = Array.isArray(configured) && configured.some((item) => typeof item === "string" && item.trim())
		? configured.map((item) => String(item).trim()).filter((item) => item.length > 0)
		: [...DEFAULT_EVIDENCE_RERUN_ALLOWLIST];
	return { mode, allowlist };
}

/** Word-boundary prefix match: "node" allows "node -e ..." and exactly
 *  "node", but never "node_modules/.bin/evil". */
export function commandMatchesAllowlist(command: string, allowlist: readonly string[]): boolean {
	const trimmed = command.trim();
	return allowlist.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `));
}

export interface EvidenceRerunSelection {
	/** Commands the gate will re-run (deduped, capped). */
	selected: string[];
	/** Commands that support a runnable-required criterion but will NOT be
	 *  re-run, with the reason. `not_allowlisted` is fail-closed downstream. */
	skipped: EvidenceRerunSkip[];
}

/** Pick the claimed-passed commands that support criteria whose matrix rows
 *  require runnable evidence (behavior/regression/unit/runtime-gate tests). */
export function selectEvidenceRerunCommands(
	plan: CoderEvidencePlanShape | null | undefined,
	packet: CoderCompletionEvidence | undefined,
	allowlist: readonly string[],
): EvidenceRerunSelection {
	if (!plan || !packet) return { selected: [], skipped: [] };
	const runnableCriteria = new Set<string>();
	for (const entry of plan.acceptanceEvidenceMatrix ?? []) {
		if (entry.requiredEvidence.some((ev) => RUNNABLE_REQUIRED_KINDS.has(ev.kind))) {
			runnableCriteria.add(entry.criterion);
		}
	}
	if (runnableCriteria.size === 0) return { selected: [], skipped: [] };
	const passedCommands = new Set<string>();
	for (const cmd of packet.commandsRun) {
		if (cmd.outcome === "passed") passedCommands.add(cmd.command);
	}
	const candidates: string[] = [];
	const seen = new Set<string>();
	for (const row of packet.criterionCoverage) {
		if (!runnableCriteria.has(row.criterion)) continue;
		for (const command of row.supportingCommands) {
			if (!passedCommands.has(command) || seen.has(command)) continue;
			seen.add(command);
			candidates.push(command);
		}
	}
	const selected: string[] = [];
	const skipped: EvidenceRerunSkip[] = [];
	for (const command of candidates) {
		if (!commandMatchesAllowlist(command, allowlist)) {
			skipped.push({ command, reason: "not_allowlisted" });
			continue;
		}
		if (selected.length >= EVIDENCE_RERUN_COMMAND_CAP) {
			skipped.push({ command, reason: "command_cap" });
			continue;
		}
		selected.push(command);
	}
	return { selected, skipped };
}

export function rerunEvidenceCommands(
	commands: readonly string[],
	cwd: string,
	timeoutMs: number = EVIDENCE_RERUN_TIMEOUT_MS,
): EvidenceCommandRerunOutcome[] {
	const outcomes: EvidenceCommandRerunOutcome[] = [];
	for (const command of commands) {
		const startedAt = Date.now();
		const result = spawnSync(command, {
			cwd,
			shell: true,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: EVIDENCE_RERUN_MAX_OUTPUT_BYTES,
		});
		const timedOut = result.error !== undefined
			&& (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
		const failedToSpawn = result.error !== undefined && !timedOut;
		const exitCode = typeof result.status === "number" ? result.status : null;
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
		outcomes.push({
			command,
			exitCode: failedToSpawn && exitCode === null ? -1 : exitCode,
			timedOut,
			durationMs: Date.now() - startedAt,
			...(output ? { outputPreview: output.slice(-EVIDENCE_RERUN_OUTPUT_PREVIEW_CHARS) } : {}),
			...(failedToSpawn ? { spawnError: result.error!.message } : {}),
		});
	}
	return outcomes;
}
