// Sprint task Brain marker parser + prompt formatter.
//
// Sprint tasks may carry inline HTML-comment markers that Brain reads to
// decide whether a task should be parallelized and how the resulting
// sub-agents should coordinate. The accepted v1 syntax is:
//
//   <!-- brain:parallel=auto|required|off -->
//   <!-- brain:room=auto|<room-id> -->
//   <!-- brain:agent id=backend role=backend job=backend-api owns=src/api/** -->
//   <!-- brain:contract topic=api message="Agree request/response schema before editing." -->
//
// Only HTML comments that begin with `brain:` are considered. Unknown
// lines or malformed attributes are kept in `raw[]` and otherwise
// ignored — the parser must never throw on task content.

import * as fs from "node:fs";

export type BrainParallelMode = "auto" | "required" | "off";
export type BrainDeepPlanningMode = "auto" | "required" | "off";

export type BrainAgentMarker = {
	id?: string;
	role?: string;
	job?: string;
	owns: string[];
};

export type BrainContractMarker = {
	topic?: string;
	message: string;
};

export type BrainMarkers = {
	parallel: BrainParallelMode | null;
	deepPlanning: BrainDeepPlanningMode | null;
	room: string | null;
	agents: BrainAgentMarker[];
	contracts: BrainContractMarker[];
	raw: string[];
	hasMarkers: boolean;
};

const COMMENT_RE = /<!--([\s\S]*?)-->/g;

export const EMPTY_BRAIN_MARKERS: BrainMarkers = {
	parallel: null,
	deepPlanning: null,
	room: null,
	agents: [],
	contracts: [],
	raw: [],
	hasMarkers: false,
};

export const DEFAULT_BRAIN_MARKERS_BLOCK = [
	"<!-- brain:parallel=auto -->",
	"<!--",
	"  Brain marker syntax (read-only docs, not markers):",
	"  brain:parallel=auto|required|off",
	"  brain:deep_planning=auto|required|off",
	"  brain:room=auto|<room-id>",
	"  brain:agent id=backend role=backend job=backend-api owns=src/api/**",
	"  brain:contract topic=api message=\"Agree request/response schema before editing.\"",
	"-->",
].join("\n");

/**
 * Parse a single marker line into a head word plus `[key, value]` pairs.
 * The head is the first bare word (no `=`). Subsequent attributes use
 * `key=value` or `key="quoted value with spaces"`. Unknown bare flags
 * after the head are skipped silently.
 */
function parseMarkerLine(line: string): { head: string; attrs: Array<[string, string]> } {
	const len = line.length;
	let i = 0;
	// skip leading whitespace
	while (i < len && /\s/.test(line[i])) i++;
	// read head word (stops at whitespace or `=`)
	const headStart = i;
	while (i < len && !/\s/.test(line[i]) && line[i] !== "=") i++;
	const head = line.slice(headStart, i);
	const attrs: Array<[string, string]> = [];
	while (i < len) {
		while (i < len && /\s/.test(line[i])) i++;
		if (i >= len) break;
		// read key up to `=` or whitespace
		const keyStart = i;
		while (i < len && line[i] !== "=" && !/\s/.test(line[i])) i++;
		const key = line.slice(keyStart, i);
		if (i >= len || line[i] !== "=") {
			// bare flag (e.g. `verbose`); skip the rest of the token
			while (i < len && !/\s/.test(line[i])) i++;
			continue;
		}
		i++; // consume `=`
		if (i >= len) {
			attrs.push([key, ""]);
			break;
		}
		const ch = line[i];
		if (ch === '"' || ch === "'") {
			const quote = ch;
			i++;
			let value = "";
			while (i < len && line[i] !== quote) {
				if (line[i] === "\\" && i + 1 < len) {
					value += line[i + 1];
					i += 2;
				} else {
					value += line[i];
					i++;
				}
			}
			if (i < len && line[i] === quote) i++; // consume closing quote
			attrs.push([key, value]);
		} else {
			const valueStart = i;
			while (i < len && !/\s/.test(line[i])) i++;
			attrs.push([key, line.slice(valueStart, i)]);
		}
	}
	return { head, attrs };
}

function isParallelMode(value: string): BrainParallelMode | null {
	const v = value.trim().toLowerCase();
	if (v === "auto" || v === "required" || v === "off") return v;
	return null;
}

function isDeepPlanningMode(value: string): BrainDeepPlanningMode | null {
	const v = value.trim().toLowerCase();
	if (v === "auto" || v === "required" || v === "off") return v;
	return null;
}

function normalizeRoom(value: string): string {
	const v = value.trim();
	if (!v) return "";
	return v;
}

/**
 * For head-less direct-assignment markers (e.g. `parallel=auto`,
 * `room=my-room`) the value lives in the first attribute slot with an
 * empty key. Returns the raw value when the first attr is the
 * direct-assignment sentinel, or `null` for any other attribute shape
 * (named-key pairs, empty attr list, etc.).
 */
function directAssignmentValue(attrs: Array<[string, string]>): string | null {
	if (attrs.length === 0) return null;
	if (attrs[0][0] !== "") return null;
	return attrs[0][1];
}

/**
 * Scan a markdown body for `<!-- brain:... -->` comments and return a
 * structured view. Never throws; unknown/empty/malformed marker lines
 * are preserved in `raw[]` and otherwise ignored.
 */
export function parseBrainMarkersFromText(text: string | null | undefined): BrainMarkers {
	const result: BrainMarkers = {
		parallel: null,
		deepPlanning: null,
		room: null,
		agents: [],
		contracts: [],
		raw: [],
		hasMarkers: false,
	};
	if (!text) return result;
	COMMENT_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = COMMENT_RE.exec(text)) !== null) {
		const inner = match[1].trim();
		const lower = inner.toLowerCase();
		if (!lower.startsWith("brain:")) continue;
		const line = inner.slice("brain:".length).trim();
		if (!line) continue;
		result.raw.push(line);
		const { head, attrs } = parseMarkerLine(line);
		const h = head.toLowerCase();
		if (!h) continue;
		if (h === "parallel") {
			const value = directAssignmentValue(attrs);
			if (value === null) continue;
			const mode = isParallelMode(value);
			if (mode) {
				result.parallel = mode;
				result.hasMarkers = true;
			}
			continue;
		}
		if (h === "deep_planning" || h === "deepplanning") {
			const value = directAssignmentValue(attrs);
			if (value === null) continue;
			const mode = isDeepPlanningMode(value);
			if (mode) {
				result.deepPlanning = mode;
				result.hasMarkers = true;
			}
			continue;
		}
		if (h === "room") {
			const value = directAssignmentValue(attrs);
			if (value === null) continue;
			const room = normalizeRoom(value);
			if (room) {
				result.room = room.toLowerCase() === "auto" ? "auto" : room;
				result.hasMarkers = true;
			}
			continue;
		}
		if (h === "agent") {
			const agent: BrainAgentMarker = { owns: [] };
			for (const [k, v] of attrs) {
				const key = k.toLowerCase();
				if (key === "id") agent.id = v;
				else if (key === "role") agent.role = v;
				else if (key === "job") agent.job = v;
				else if (key === "owns") {
					const value = v.trim();
					if (value) agent.owns.push(value);
				}
			}
			if (!agent.id) continue;
			result.agents.push(agent);
			result.hasMarkers = true;
			continue;
		}
		if (h === "contract") {
			const contract: BrainContractMarker = { message: "" };
			for (const [k, v] of attrs) {
				const key = k.toLowerCase();
				if (key === "topic") contract.topic = v;
				else if (key === "message") contract.message = v;
			}
			if (contract.message) {
				result.contracts.push(contract);
				result.hasMarkers = true;
			}
			continue;
		}
		// Unknown head: preserved in raw[], ignored otherwise.
	}
	return result;
}

/**
 * Read a task file from disk and parse its Brain markers. Returns an
 * empty marker set if the file is missing or unreadable; never throws.
 * Convenience wrapper so callers do not all repeat the fs dance.
 */
export function readBrainMarkersForTaskFile(filePath: string): BrainMarkers {
	if (!fs.existsSync(filePath)) return { ...EMPTY_BRAIN_MARKERS };
	try {
		return parseBrainMarkersFromText(fs.readFileSync(filePath, "utf8"));
	} catch {
		return { ...EMPTY_BRAIN_MARKERS };
	}
}

/**
 * Render detected markers as a short prompt block Brain can read. Returns
 * an empty string when no markers are present so the prompt stays clean
 * for legacy/unmarked tasks.
 */
export function formatBrainMarkersForPrompt(markers: BrainMarkers): string {
	if (!markers || !markers.hasMarkers) return "";
	const lines: string[] = [];
	lines.push("Brain markers detected on the active sprint task:");
	if (markers.parallel) {
		let hint = "";
		if (markers.parallel === "required") {
			hint =
				"MUST create a workflow room (room_create) and delegate via delegate_to_coder / delegate_to_reviewer with `room: { roomId, ... }` context before any parallel work.";
		} else if (markers.parallel === "auto") {
			hint =
				"Assess whether this task splits safely into independent workstreams during Technical Architect / Parallel Work Assessment. If it does, create a workflow room and delegate room-scoped workers. If you are uncertain whether parallelization is safe, ASK THE USER before launching parallel agents.";
		} else {
			hint =
				"Do NOT use parallel-agent delegation for this task. Stay with the single coder/reviewer path unless the user explicitly overrides the marker.";
		}
		lines.push(`- parallel=${markers.parallel}: ${hint}`);
	}
	if (markers.deepPlanning) {
		let hint = "";
		if (markers.deepPlanning === "required") {
			hint = "Run a planning-only round of deep-planning (via workflow_deep_plan) before any coder delegation. Use force:true unless deepPlanning is already enabled in config.";
		} else if (markers.deepPlanning === "auto") {
			hint = "Assess task complexity and run deep planning when useful, then synthesize options + risks before coder delegation. If this opt-in comes from the marker while config is disabled, pass force:true.";
		} else {
			hint = "Deep planning not required for this task unless the user explicitly overrides the marker.";
		}
		lines.push(`- deep_planning=${markers.deepPlanning}: ${hint}`);
	}
	if (markers.room) {
		if (markers.room.toLowerCase() === "auto") {
			lines.push(
				"- room=auto: pick a stable roomId (e.g. derived from the task id / slug) and call room_create({ roomId, title }) first; pass that roomId to all parallel delegates via `room: { roomId, ... }`.",
			);
		} else {
			lines.push(
				`- room=${markers.room}: call room_create({ roomId: "${markers.room}", title }) first and pass this roomId to all parallel delegates via \`room: { roomId: "${markers.room}", ... }\`.`,
			);
		}
	}
	if (markers.agents.length) {
		lines.push("- proposed workstreams (proposed room workers):");
		for (const a of markers.agents) {
			const label = a.id ?? a.job ?? a.role ?? "(unnamed)";
			const parts: string[] = [label];
			if (a.role) parts.push(`role=${a.role}`);
			if (a.job) parts.push(`job=${a.job}`);
			if (a.id) parts.push(`id=${a.id}`);
			if (a.owns.length) parts.push(`owns=${a.owns.join(",")}`);
			lines.push(`  - ${parts.join(" ")}`);
		}
	}
	if (markers.contracts.length) {
		lines.push("- proposed contracts (post as room_send messages so workers can read them at room_read):");
		for (const c of markers.contracts) {
			const topic = c.topic ? ` [topic=${c.topic}]` : "";
			lines.push(`  -${topic} ${c.message}`);
		}
	}
	lines.push(
		"Concrete instructions: include the relevant marker hints in the Technical Architect / Parallel Work Assessment. If parallel=required or parallel=auto with a safe split, call room_create before delegating and pass `room: { roomId, ... }` on delegate_to_coder / delegate_to_reviewer so workers receive the workflow-room context.",
	);
	if (markers.deepPlanning === "required") {
		lines.push(
			"If deep_planning=required, run deep-planning (workflow_deep_plan) before coder delegation with force:true unless deepPlanning is already enabled in config.",
		);
	}
	return lines.join("\n");
}
