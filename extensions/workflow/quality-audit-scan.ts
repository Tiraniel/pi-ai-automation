// TASK-009 Phase A — workflow quality audit scanners and entry point.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	asString,
	AttemptRecord,
	DebugItem,
	DelegateDoneRecord,
	DelegateManifestRecord,
	countFindings,
	sortFindings,
	WorkflowQualityAuditFinding,
	WorkflowQualityAuditOptions,
	WorkflowQualityAuditReport,
} from "./quality-audit-types";
import {
	collectFiles,
	detectPattern,
	emitFinding,
	fileOversizedCode,
	inAgeWindow,
	inferDebugArea,
	isDelegateManifestPath,
	isDelegateManifestShape,
	isInsideCwd,
	normalizeOptions,
	parseDebugId,
	parseFrontmatter,
	parseJson,
	parseTaskId,
	readText,
	relativeFrom,
	safeStat,
	uniqueList,
} from "./quality-audit-scan-helpers";

export function scanDelegateArtifacts(
	cwd: string,
	options: Required<WorkflowQualityAuditOptions>,
	bucket: Map<string, WorkflowQualityAuditFinding>,
	reviewerAttempts: Map<string, AttemptRecord[]>,
): void {
	const delegateDir = path.join(cwd, ".pi", "workflow-runs", "delegates");
	// Walk all delegate .json candidates before any mtime ordering: the age
	// filter narrows the candidate set, the mtime-desc sort (path tiebreaker)
	// orders them, and the user-provided maxDelegateManifests cap applies last.
	// The include predicate excludes `*.done.json` basenames and the parsed-shape
	// check drops malformed files so sidecars/non-manifests never consume a
	// bounded slot.
	const candidates = collectFiles(delegateDir, {
		recursive: false,
		maxFiles: 0,
		include: (absPath) => isDelegateManifestPath(absPath),
	})
		.filter((filePath) => inAgeWindow(filePath, options.maxAgeDays));
	const shaped: string[] = [];
	for (const filePath of candidates) {
		const parsed = parseJson<Record<string, unknown>>(filePath);
		if (parsed && isDelegateManifestShape(parsed)) shaped.push(filePath);
	}
	shaped.sort((left, right) => {
		const leftMtime = safeStat(left)?.mtimeMs ?? 0;
		const rightMtime = safeStat(right)?.mtimeMs ?? 0;
		if (rightMtime !== leftMtime) return rightMtime - leftMtime;
		return left.localeCompare(right);
	});
	const manifests = shaped.slice(0, options.maxDelegateManifests);

	for (const manifestPath of manifests) {
		const manifest = parseJson<DelegateManifestRecord>(manifestPath);
		if (!manifest) continue;
		const runId = manifest.runId || path.basename(manifestPath, ".json");
		const taskId = parseTaskId(asString(manifest.task));
		const relManifest = relativeFrom(cwd, manifestPath);
		const manifestHasEmbeddedDone = !!(manifest.done && typeof manifest.done === "object");
		const embeddedDone = manifestHasEmbeddedDone ? manifest.done : undefined;
		const donePath = manifest.doneFile
			? path.isAbsolute(manifest.doneFile)
				? manifest.doneFile
				: path.join(path.dirname(manifestPath), manifest.doneFile)
			: path.join(path.dirname(manifestPath), `${runId}.done.json`);
		// Sidecar semantics are scoped to the scanned cwd: an absolute
		// `manifest.doneFile` outside `cwd` is treated as absent for all
		// downstream semantics, not just evidence refs. This keeps outside-cwd
		// sidecar contents from influencing `done`/`failed`/`completion`
		// findings, and keeps `delegate_missing_done` semantically repo-local.
		// Embedded `manifest.done` still applies when `doneFile` points outside
		// cwd.
		const donePathInsideCwd = donePath ? isInsideCwd(cwd, donePath) : false;
		const donePathReadable = donePathInsideCwd && safeStat(donePath)?.isFile() === true;
		const done = donePathReadable ? parseJson<DelegateDoneRecord>(donePath) : undefined;
		const hasDone = manifestHasEmbeddedDone || donePathReadable;
		const completion = embeddedDone?.completion || done?.completion;
		const agent = asString(manifest.agent) || "delegate";
		const state = asString(manifest.state);
		const failed = state === "failed" || state === "aborted" || (donePathReadable && done?.done === false);
		// Evidence refs must be repo-local: sidecar refs are only included when
		// the sidecar was actually read AND resolves inside the scanned cwd.
		// Outside-cwd doneFile paths are ignored as evidence even if readable,
		// to avoid brittle absolute refs, and missing sidecars are excluded so
		// evidence refs always point to files that exist on disk.
		const relDone = donePathReadable ? relativeFrom(cwd, donePath) : "";
		const refs = uniqueList([relManifest, relDone].filter(Boolean));
		const detail = {
			runId,
			taskId,
			agent,
			state,
			completion,
			relManifest,
			relDone: relDone || relManifest,
		};

		if (agent === "coder" && failed) {
			emitFinding(bucket, {
				code: "delegate_failed_coder",
				category: "delegate",
				severity: "high",
				message: `Coder delegate run ${runId} failed or done=false in manifest state ${state || "unknown"}.`,
				evidenceRefs: refs,
				taskIds: taskId ? [taskId] : [],
				runIds: [runId],
				details: detail,
			});
		}
		if (agent === "coder" && !hasDone) {
			emitFinding(bucket, {
				code: "delegate_missing_done",
				category: "delegate",
				severity: "medium",
				message: `Coder delegate run ${runId} is missing done sidecar.`,
				evidenceRefs: [relManifest],
				taskIds: taskId ? [taskId] : [],
				runIds: [runId],
				details: detail,
			});
		}
		if (completion === "auto_exit") {
			emitFinding(bucket, {
				code: "delegate_auto_exit",
				category: "delegate",
				severity: "high",
				message: `Delegate ${runId} completed with auto_exit.`,
				evidenceRefs: refs,
				taskIds: taskId ? [taskId] : [],
				runIds: [runId],
				details: detail,
			});
		}
		if (completion === "process_exit") {
			emitFinding(bucket, {
				code: "delegate_process_exit",
				category: "delegate",
				severity: "high",
				message: `Delegate ${runId} completed with process_exit.`,
				evidenceRefs: refs,
				taskIds: taskId ? [taskId] : [],
				runIds: [runId],
				details: detail,
			});
		}

		const recordKey = taskId || `run:${runId}`;
		const list = reviewerAttempts.get(recordKey) || [];
		list.push({
			runId,
			agent,
			failed,
			at: safeStat(manifestPath)?.mtimeMs || Date.now(),
			taskId: recordKey,
			relManifest,
		});
		reviewerAttempts.set(recordKey, list);
	}

	for (const [taskOrRun, attempts] of reviewerAttempts.entries()) {
		const reviewAttempts = attempts.filter((entry) => entry.agent === "reviewer");
		if (reviewAttempts.length < 2) continue;
		if (!reviewAttempts.some((entry) => entry.failed)) continue;
		reviewAttempts.sort((left, right) => left.at - right.at);
		emitFinding(bucket, {
			code: "reviewer_retries_repeated",
			category: "review",
			severity: "medium",
			message: `Reviewer retries observed for ${taskOrRun} (${reviewAttempts.length} attempts).`,
			evidenceRefs: uniqueList(reviewAttempts.map((entry) => entry.relManifest)),
			taskIds: taskOrRun.startsWith("TASK-") ? [taskOrRun] : [],
			runIds: reviewAttempts.map((entry) => entry.runId),
			details: { attempts: reviewAttempts.length },
		});
	}
}

export function scanTaskArtifacts(
	cwd: string,
	options: Required<WorkflowQualityAuditOptions>,
	bucket: Map<string, WorkflowQualityAuditFinding>,
): void {
	const files = collectFiles(path.join(cwd, ".sprints"), {
		recursive: true,
		maxFiles: options.maxTaskFiles,
		include: (_abs, rel) => /[\\/]tasks[\\/][^\\/]+\.md$/.test(rel),
	})
		.filter((filePath) => inAgeWindow(filePath, options.maxAgeDays))
		.sort((left, right) => left.localeCompare(right));

	for (const filePath of files) {
		const text = readText(filePath);
		if (!text) continue;
		const parsed = parseFrontmatter(text);
		const id = parseTaskId(asString(parsed.frontmatter.id));
		if (!id) continue;
		const rel = relativeFrom(cwd, filePath);
		const title = asString(parsed.frontmatter.title);
		const body = (parsed.body || "").toLowerCase();

		if (id === "TASK-028") {
			emitFinding(bucket, {
				code: "TASK-028",
				category: "historical",
				severity: "medium",
				message: "TASK-028 is present in historical task artifacts.",
				evidenceRefs: [rel],
				taskIds: [id],
				runIds: [],
				details: { title, status: asString(parsed.frontmatter.status) },
			});
		}
		if (id === "TASK-029") {
			emitFinding(bucket, {
				code: "TASK-029",
				category: "historical",
				severity: "medium",
				message: "TASK-029 is present in historical task artifacts.",
				evidenceRefs: [rel],
				taskIds: [id],
				runIds: [],
				details: { title, status: asString(parsed.frontmatter.status) },
			});
		}

		let promptOnly = id === "TASK-029";
		promptOnly = promptOnly || detectPattern(body, [
			/\bprompt[-\s]?only\b/,
			/\bdocumentation[-\s]?only\b/,
			/\bdocs[-\s]?only\b/,
		]);
		const staticOnly = detectPattern(body, [
			/\bstatic[-\s]?only\b/,
			/\bsource[-\s]?only\b/,
			/\bno\s+(interactive|runtime|behavior)\s+(validation|test|tests|verification)\b/,
		]);
		if (promptOnly) {
			emitFinding(bucket, {
				code: "prompt_only_completion",
				category: "task-risk",
				severity: "high",
				message: `Task ${id} contains prompt-only or documentation-only completion language.`,
				evidenceRefs: [rel],
				taskIds: [id],
				runIds: [],
				details: { title },
			});
		}
		if (staticOnly) {
			emitFinding(bucket, {
				code: "static_only_interactive_validation",
				category: "task-risk",
				severity: "high",
				message: `Task ${id} indicates static/source-only or non-interactive validation wording.`,
				evidenceRefs: [rel],
				taskIds: [id],
				runIds: [],
				details: { title },
			});
		}
	}
}

export function scanProgressArtifacts(
	cwd: string,
	options: Required<WorkflowQualityAuditOptions>,
	bucket: Map<string, WorkflowQualityAuditFinding>,
): void {
	const files = collectFiles(path.join(cwd, ".sprints"), {
		recursive: true,
		include: (_abs, rel) => /[\\/]PROGRESS\.md$/.test(rel),
		maxFiles: options.maxProgressFiles,
	})
		.filter((filePath) => inAgeWindow(filePath, options.maxAgeDays))
		.sort((left, right) => left.localeCompare(right));

	for (const filePath of files) {
		const text = readText(filePath);
		if (!text) continue;
		const rel = relativeFrom(cwd, filePath);
		const lines = text.split(/\r?\n/);
		const doneTasks = new Map<string, number>();
		for (let i = 0; i < lines.length; i += 1) {
			const raw = lines[i];
			const lineLower = raw.toLowerCase();
			if (!lineLower.trim()) continue;
			const taskMatch = lineLower.match(/task-(\d{3,})/);
			const debugMatch = lineLower.match(/dbg-(\d{3,})/);
			const ts = Date.parse(raw.substring(0, 32));
			const at = Number.isNaN(ts) ? Date.now() : ts;
			if (taskMatch) {
				const taskId = `TASK-${taskMatch[1].toUpperCase()}`;
				if (/->\s*done|\bdone\b|\bcompleted\b/.test(lineLower)) {
					doneTasks.set(taskId, at);
				}
				if (taskId === "TASK-028") {
					emitFinding(bucket, {
						code: "TASK-028",
						category: "historical",
						severity: "medium",
						message: `PROGRESS references TASK-028 on line ${i + 1}.`,
						evidenceRefs: [`${rel}:L${i + 1}`],
						taskIds: [taskId],
						runIds: [],
						details: { source: "PROGRESS.md" },
					});
				}
				if (taskId === "TASK-029") {
					emitFinding(bucket, {
						code: "TASK-029",
						category: "historical",
						severity: "medium",
						message: `PROGRESS references TASK-029 on line ${i + 1}.`,
						evidenceRefs: [`${rel}:L${i + 1}`],
						taskIds: [taskId],
						runIds: [],
						details: { source: "PROGRESS.md" },
					});
				}
			}
			if (debugMatch && /(done|completed|finished)/.test(lineLower)) {
				if (doneTasks.size > 0) {
					emitFinding(bucket, {
						code: "debug_chain_after_done",
						category: "debug",
						severity: "high",
						message: `Debug DBG-${debugMatch[1]} appears after prior task completion activity.`,
						evidenceRefs: [`${rel}:L${i + 1}`],
						taskIds: [`DBG-${debugMatch[1].toUpperCase()}`],
						runIds: [],
						details: { source: "PROGRESS.md", doneTaskCount: doneTasks.size },
					});
				}
			}
		}
	}
}

export function scanDebugArtifacts(
	cwd: string,
	options: Required<WorkflowQualityAuditOptions>,
	bucket: Map<string, WorkflowQualityAuditFinding>,
): void {
	const dir = path.join(cwd, ".sprints", "debug", "items");
	const files = collectFiles(dir, {
		recursive: false,
		maxFiles: options.maxDebugItems,
		include: (_abs, rel) => /DBG-\d{3,}.*\.md$/.test(path.basename(rel)),
	})
		.filter((filePath) => inAgeWindow(filePath, options.maxAgeDays))
		.sort((left, right) => left.localeCompare(right));

	const items: DebugItem[] = [];
	const byId = new Map<string, DebugItem>();
	for (const filePath of files) {
		const text = readText(filePath);
		if (!text) continue;
		const parsed = parseFrontmatter(text);
		const id = parseDebugId(asString(parsed.frontmatter.id));
		if (!id) continue;
		const rel = relativeFrom(cwd, filePath);
		const item: DebugItem = {
			id,
			title: asString(parsed.frontmatter.title),
			status: asString(parsed.frontmatter.status).toLowerCase(),
			createdAt: asString(parsed.frontmatter.createdAt),
			completedAt: asString(parsed.frontmatter.completedAt),
			path: rel,
			body: asString(parsed.body),
			area: inferDebugArea(`${asString(parsed.frontmatter.title)} ${parsed.body}`),
		};
		byId.set(id, item);
		items.push(item);

		emitFinding(bucket, {
			code: id,
			category: "historical",
			severity: "low",
			evidenceRefs: [rel],
			message: `Debug item ${id} is present in history.`,
			taskIds: [id],
			runIds: [],
			details: { title: item.title, status: item.status, area: item.area },
		});
	}

	const byArea = new Map<string, DebugItem[]>();
	for (const item of items) {
		const lowerText = `${item.title} ${item.body}`.toLowerCase();
		const referenced = lowerText.match(/dbg-\d{3,}/g) || [];
		const chainHint = /\bchain|follow|continue/.test(lowerText);
		const prior = byArea.get(item.area) || [];
		const completedPrior = prior.filter((entry) => entry.status === "done");
		if ((chainHint && completedPrior.length > 0) || referenced.some((entry) => byId.has(entry.toUpperCase()))) {
			emitFinding(bucket, {
				code: "debug_chain_after_done",
				category: "debug",
				severity: "high",
				message: `Debug item ${item.id} appears linked to previous debug work (${item.area}).`,
				evidenceRefs: [item.path, ...completedPrior.map((entry) => entry.path)],
				taskIds: [item.id],
				runIds: [],
				details: {
					references: uniqueList(referenced.map((entry) => entry.toUpperCase())),
					area: item.area,
					status: item.status,
				},
			});
		}
		if (item.status === "done" || item.status === "completed") {
			byArea.set(item.area, [...prior, item]);
		}
	}
}

export function scanMetrics(
	cwd: string,
	options: Required<WorkflowQualityAuditOptions>,
	bucket: Map<string, WorkflowQualityAuditFinding>,
): void {
	const exts = new Set(options.metricExtensions.map((ext) => ext.toLowerCase()));
	for (const relDir of options.metricFileDirs) {
		const dir = path.join(cwd, relDir);
		// Reject metricFileDirs that resolve outside cwd; outside-cwd evidence refs would leak.
		if (!isInsideCwd(cwd, dir)) continue;
		const files = collectFiles(dir, {
			recursive: true,
			maxFiles: options.maxMetricFiles,
			include: (_abs, _rel) => exts.has(path.extname(_abs).toLowerCase()),
		})
			.filter((filePath) => inAgeWindow(filePath, options.maxAgeDays))
			.sort((left, right) => left.localeCompare(right));
		for (const filePath of files) {
			const rel = relativeFrom(cwd, filePath);
			let lineCount = 0;
			const text = readText(filePath);
			if (text === undefined) continue;
			lineCount = text.split(/\r?\n/).length;
			if (lineCount <= options.maxMetricLines) continue;
			const code = fileOversizedCode(rel);
			emitFinding(bucket, {
				code,
				category: code === "workflow_cfg_large_file" ? "workflow_cfg-risk" : "metrics",
				severity: code === "workflow_cfg_large_file" ? "high" : "warning",
				message: `Large file ${rel} has ${lineCount} lines (threshold ${options.maxMetricLines}).`,
				evidenceRefs: [rel],
				taskIds: [],
				runIds: [],
				details: { lineCount, threshold: options.maxMetricLines },
			});
		}
	}
}

export function runWorkflowQualityAudit(
	cwdInput: string,
	options: WorkflowQualityAuditOptions = {},
): WorkflowQualityAuditReport {
	const cwd = path.resolve(cwdInput);
	const normalized = normalizeOptions(options);
	const bucket = new Map<string, WorkflowQualityAuditFinding>();
	const attemptsByTask = new Map<string, AttemptRecord[]>();

	scanDelegateArtifacts(cwd, normalized, bucket, attemptsByTask);
	scanTaskArtifacts(cwd, normalized, bucket);
	scanProgressArtifacts(cwd, normalized, bucket);
	scanDebugArtifacts(cwd, normalized, bucket);
	scanMetrics(cwd, normalized, bucket);

	const findings = sortFindings(Array.from(bucket.values()));
	return {
		cwd,
		generatedAt: new Date().toISOString(),
		options: normalized,
		findings,
		counts: countFindings(findings),
	};
}
