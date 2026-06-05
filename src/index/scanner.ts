/**
 * File scanner for pi-ai-automation-memory.
 *
 * Discovers files, applies exclusions, computes content hashes,
 * detects languages, package roots, and import-like strings.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	gitLsFiles,
	gitBlobHashes,
	isExcluded,
	isGitignoredPath,
	classifyExclusion,
	collectGitignorePatterns,
} from "../security/exclusions";

export interface ScannedFile {
	relativePath: string;
	absolutePath: string;
	contentHash: string;
	gitBlobHash: string | null;
	sizeBytes: number;
	mtimeMs: number;
	isGitignored: boolean;
	isGenerated: boolean;
	isSecret: boolean;
	isUntracked: boolean;
	isDirty: boolean;
	language: string | null;
	packageRoot: string | null;
	importsHash: string | null;
	importPaths: string[];
}

export interface ExclusionCounts {
	secretExcludedCount: number;
	generatedExcludedCount: number;
	binaryExcludedCount: number;
	lockExcludedCount: number;
	ideExcludedCount: number;
	osExcludedCount: number;
	gitignoredExcludedCount: number;
}

export interface ScanResult {
	files: ScannedFile[];
	exclusions: ExclusionCounts;
}

const EXT_TO_LANGUAGE: Record<string, string> = {
	".ts": "typescript", ".tsx": "typescript",
	".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
	".py": "python",
	".rs": "rust",
	".go": "go",
	".java": "java",
	".kt": "kotlin",
	".scala": "scala",
	".rb": "ruby",
	".php": "php",
	".cs": "csharp",
	".fs": "fsharp",
	".swift": "swift",
	".c": "c", ".h": "c",
	".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
	".sh": "shell", ".bash": "shell", ".zsh": "shell",
	".ps1": "powershell",
	".sql": "sql",
	".html": "html", ".htm": "html",
	".css": "css", ".scss": "scss", ".sass": "scss", ".less": "less",
	".json": "json",
	".yaml": "yaml", ".yml": "yaml",
	".xml": "xml",
	".md": "markdown", ".mdx": "markdown",
	".dockerfile": "dockerfile",
	".tf": "terraform", ".hcl": "hcl",
	".vue": "vue",
	".svelte": "svelte",
	".r": "r",
	".pl": "perl", ".pm": "perl",
	".lua": "lua",
	".elm": "elm",
	".erl": "erlang", ".ex": "elixir", ".exs": "elixir",
	".hs": "haskell",
	".ml": "ocaml", ".mli": "ocaml",
	".dart": "dart",
	".jl": "julia",
	".clj": "clojure", ".cljs": "clojure",
	".groovy": "groovy",
	".nim": "nim",
	".v": "v",
	".zig": "zig",
	".odin": "odin",
	".cairo": "cairo",
	".sol": "solidity",
	".move": "move",
};

const PACKAGE_MARKERS = [
	"package.json", "pyproject.toml", "setup.py", "setup.cfg",
	"Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
	"composer.json", "Gemfile", "requirements.txt", "Pipfile",
	"mix.exs", "rebar.config", "dune-project", "stack.yaml", "package.yaml",
	"*.cabal", "project.clj", "build.zig", "build.zig.zon",
	"CMakeLists.txt", "configure.ac", "Makefile", "makefile",
];

function detectLanguage(filePath: string, content?: string): string | null {
	const ext = path.extname(filePath).toLowerCase();
	if (EXT_TO_LANGUAGE[ext]) {
		return EXT_TO_LANGUAGE[ext];
	}
	// Shebang detection
	if (content && content.startsWith("#!")) {
		const firstLine = content.split(/\r?\n/)[0] ?? "";
		if (firstLine.includes("python")) return "python";
		if (firstLine.includes("node") || firstLine.includes("nodejs")) return "javascript";
		if (firstLine.includes("bash") || firstLine.includes("sh")) return "shell";
		if (firstLine.includes("ruby")) return "ruby";
		if (firstLine.includes("perl")) return "perl";
		if (firstLine.includes("php")) return "php";
	}
	return null;
}

function findPackageRoot(filePath: string, repoRoot: string): string | null {
	let dir = path.dirname(path.resolve(filePath));
	const root = path.resolve(repoRoot);
	while (true) {
		for (const marker of PACKAGE_MARKERS) {
			if (marker.includes("*")) {
				const prefix = marker.replace("*.", "");
				try {
					const entries = fs.readdirSync(dir);
					for (const e of entries) {
						if (e.endsWith("." + prefix)) {
							return dir;
						}
					}
				} catch { /* ignore */ }
			} else if (fs.existsSync(path.join(dir, marker))) {
				return dir;
			}
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

const IMPORT_RE =
	/(?:^|\n)\s*(?:import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+(['"][^'"]+['"])|#include\s+[<"']([^>"']+)[>"'])/g;

function extractImports(content: string): string[] {
	const paths: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = IMPORT_RE.exec(content)) !== null) {
		const p = m[1] ?? m[2] ?? m[3] ?? m[4];
		if (p) paths.push(p.replace(/^['"]|['"]$/g, ""));
	}
	return [...new Set(paths)];
}

function hashContent(content: string): string {
	return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

function hashImports(paths: string[]): string {
	const sorted = [...paths].sort();
	return crypto.createHash("sha256").update(sorted.join("\n")).digest("hex");
}

/**
 * Simple redaction: replace high-entropy strings (>40 chars, alphanumeric+symbols)
 * and common secret patterns with [REDACTED].
 */
function redactContent(content: string): string {
	let redacted = content.replace(
		/[A-Za-z0-9+/=]{40,}/g,
		(m) => {
			if (/^[0-9a-f]{40,}$/i.test(m)) return m;
			if (/^[0-9]+$/.test(m)) return m;
			return "[REDACTED]";
		},
	);
	redacted = redacted.replace(
		/(aws_access_key_id|aws_secret_access_key|private_key|password|secret|token|api_key)\s*[:=]\s*[^\s\n]+/gi,
		'$1: [REDACTED]',
	);
	return redacted;
}

export function readAndHash(filePath: string): { contentHash: string; imports: string[] } {
	const raw = fs.readFileSync(filePath, "utf-8");
	const redacted = redactContent(raw);
	const contentHash = hashContent(redacted);
	const imports = extractImports(raw);
	return { contentHash, imports };
}

/**
 * Scan a repository and return file records.
 *
 * @param repoRoot Absolute path to repo root
 * @param gitRoot Absolute path to git root, or null if not a git repo
 * @param knownFiles Map of relativePath -> { contentHash, sizeBytes, mtimeMs } from DB for hash reuse
 */
export function scanRepo(
	repoRoot: string,
	gitRoot: string | null,
	knownFiles: Map<string, { contentHash: string; sizeBytes: number; mtimeMs: number }>,
): ScanResult {
	const repoRootResolved = path.resolve(repoRoot);

	const exclusions: ExclusionCounts = {
		secretExcludedCount: 0,
		generatedExcludedCount: 0,
		binaryExcludedCount: 0,
		lockExcludedCount: 0,
		ideExcludedCount: 0,
		osExcludedCount: 0,
		gitignoredExcludedCount: 0,
	};

	let relativePaths: string[];
	let fromGit = false;
	let blobMap: Map<string, string> | null = null;

	if (gitRoot) {
		const gitRootResolved = path.resolve(gitRoot);
		const gitFiles = gitLsFiles(gitRoot);
		if (gitFiles) {
			fromGit = true;
			blobMap = gitBlobHashes(gitRoot);
			if (gitRootResolved === repoRootResolved) {
				relativePaths = gitFiles;
			} else {
				// Filter to only files under repoRoot and convert to repoRoot-relative
				const repoRelFromGit = path.relative(gitRootResolved, repoRootResolved).replace(/\\/g, "/");
				const prefix = repoRelFromGit ? repoRelFromGit + "/" : "";
				relativePaths = [];
				for (const p of gitFiles) {
					if (prefix) {
						if (p.startsWith(prefix)) {
							relativePaths.push(p.slice(prefix.length));
						}
					} else {
						relativePaths.push(p);
					}
				}
				// Also filter blobMap to repoRoot-relative keys
				if (blobMap) {
					const filtered = new Map<string, string>();
					for (const [gitRel, hash] of blobMap) {
						if (prefix && gitRel.startsWith(prefix)) {
							filtered.set(gitRel.slice(prefix.length), hash);
						} else if (!prefix) {
							filtered.set(gitRel, hash);
						}
					}
					blobMap = filtered;
				}
			}
		} else {
			relativePaths = walkDir(repoRootResolved, exclusions);
		}
	} else {
		relativePaths = walkDir(repoRootResolved, exclusions);
	}

	// For non-git, collect gitignore patterns from each file's directory
	const gitignorePatterns = new Map<string, string[]>();

	const results: ScannedFile[] = [];
	for (const relPath of relativePaths) {
		const absPath = path.join(repoRootResolved, relPath);

		// Skip .git and cache dirs
		if (relPath.startsWith(".git/") || relPath === ".git") continue;
		if (relPath.startsWith("node_modules/") || relPath === "node_modules") continue;
		if (relPath.includes(".pi/agent/repo-memory")) continue;

		// Default exclusions
		const exclusion = classifyExclusion(relPath);
		if (exclusion.excluded) {
			if (exclusion.category === "secret") exclusions.secretExcludedCount++;
			else if (exclusion.category === "generated") exclusions.generatedExcludedCount++;
			else if (exclusion.category === "binary") exclusions.binaryExcludedCount++;
			else if (exclusion.category === "lock") exclusions.lockExcludedCount++;
			else if (exclusion.category === "ide") exclusions.ideExcludedCount++;
			else if (exclusion.category === "os") exclusions.osExcludedCount++;
			continue;
		}

		// For non-git, also check .gitignore patterns with ordered negation
		if (!fromGit) {
			const dir = path.dirname(absPath);
			let patterns = gitignorePatterns.get(dir);
			if (!patterns) {
				patterns = collectGitignorePatterns(dir, repoRootResolved);
				gitignorePatterns.set(dir, patterns);
			}
			if (isGitignoredPath(relPath, patterns)) {
				exclusions.gitignoredExcludedCount++;
				continue;
			}
		}

		let stats: fs.Stats;
		try {
			stats = fs.statSync(absPath);
		} catch {
			continue;
		}
		if (!stats.isFile()) continue;

		const sizeBytes = stats.size;
		const mtimeMs = Math.floor(stats.mtimeMs);

		// Reuse hash if size+mtime match
		const known = knownFiles.get(relPath);
		let contentHash: string;
		let imports: string[] = [];
		if (known && known.sizeBytes === sizeBytes && known.mtimeMs === mtimeMs) {
			contentHash = known.contentHash;
		} else {
			try {
				const hashed = readAndHash(absPath);
				contentHash = hashed.contentHash;
				imports = hashed.imports;
			} catch {
				continue;
			}
		}

		const language = detectLanguage(absPath);
		const packageRoot = findPackageRoot(absPath, repoRootResolved);
		const importsHash = imports.length > 0 ? hashImports(imports) : null;

		// Determine git blob hash (blobMap is already repoRoot-relative when gitRoot != repoRoot)
		let gitBlobHash: string | null = null;
		if (blobMap) {
			gitBlobHash = blobMap.get(relPath) ?? null;
		}

		results.push({
			relativePath: relPath,
			absolutePath: absPath,
			contentHash,
			gitBlobHash,
			sizeBytes,
			mtimeMs,
			isGitignored: false,
			isGenerated: false,
			isSecret: false,
			isUntracked: false,
			isDirty: false,
			language,
			packageRoot: packageRoot ? path.relative(repoRootResolved, packageRoot) || "." : null,
			importsHash,
			importPaths: imports,
		});
	}

	return { files: results, exclusions };
}

const SKIP_DIR_NAMES = new Set([
	"node_modules", ".git",
	"dist", "build", ".next", "coverage",
	".vscode", ".idea",
	".ssh", ".aws",
]);

function classifyDirSkip(entry: string): { category: "generated" | "ide" | "secret" | "os" | null } {
	if (entry === "dist" || entry === "build" || entry === ".next" || entry === "coverage") {
		return { category: "generated" };
	}
	if (entry === ".vscode" || entry === ".idea") {
		return { category: "ide" };
	}
	if (entry === ".ssh" || entry === ".aws") {
		return { category: "secret" };
	}
	return { category: null };
}

function walkDir(dir: string, exclusions?: ExclusionCounts): string[] {
	const results: string[] = [];
	function walk(current: string, prefix: string) {
		let entries: string[];
		try {
			entries = fs.readdirSync(current);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry === ".git") continue;
			if (entry === "node_modules") continue;
			const rel = prefix ? prefix + "/" + entry : entry;
			const abs = path.join(current, entry);
			let st: fs.Stats;
			try {
				st = fs.statSync(abs);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				// Skip default directory exclusions (but allow .pi/repo-memory.json)
				if (SKIP_DIR_NAMES.has(entry)) {
					const cls = classifyDirSkip(entry);
					if (exclusions && cls.category) {
						if (cls.category === "generated") exclusions.generatedExcludedCount++;
						else if (cls.category === "ide") exclusions.ideExcludedCount++;
						else if (cls.category === "secret") exclusions.secretExcludedCount++;
					}
					continue;
				}
				walk(abs, rel);
			} else if (st.isFile()) {
				results.push(rel);
			}
		}
	}
	walk(dir, "");
	return results;
}
