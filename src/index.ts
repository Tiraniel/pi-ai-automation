/**
 * pi-ai-automation-memory — Pi extension entry point.
 *
 * Default export factory: (pi: ExtensionAPI) => void
 * Registers four AI-facing tools, a diagnostic command, and future integration stubs.
 * Does NOT scan the repo, open SQLite, or run git on load.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDiagnostics } from "./diagnostics";
import { registerRepoContext } from "./tools/repo_context";
import { registerRepoCheckpoint } from "./tools/repo_checkpoint";
import { registerRepoHealthReport } from "./tools/repo_health_report";
import { registerRepoIndexStatus } from "./tools/repo_index_status";

// Future integration stubs — imported to ensure they compile and are discoverable,
// but not invoked during extension load.
import { resolvePreset } from "./models/presets";
import { runKeeperUnit } from "./keeper/scheduler";

export default function piAiAutomationMemory(pi: ExtensionAPI) {
	// Register the four AI-facing tools
	registerRepoContext(pi);
	registerRepoCheckpoint(pi);
	registerRepoHealthReport(pi);
	registerRepoIndexStatus(pi);

	// Register diagnostic slash command
	registerDiagnostics(pi);

	// Future integration stubs: ensure preset/keeper modules are reachable at runtime
	// and provide a clear hook for TASK-006+ wiring.
	const _presets = resolvePreset("index_keeper");
	const _keeperStub = runKeeperUnit;
	void _presets;
	void _keeperStub;

	// Event stubs for future tasks:
	// - TASK-004: before_agent_start (auto-brief injection)
	// - TASK-006: agent_end (keeper trigger)
	// - TASK-006: session_shutdown (cleanup)
	//
	// These are intentionally no-ops in the scaffold so the extension can be
	// loaded without errors even if Pi emits these events.
	pi.on("before_agent_start", async () => {
		// Scaffold: no auto-brief yet (TASK-004)
	});

	pi.on("agent_end", async () => {
		// Scaffold: no keeper trigger yet (TASK-006)
	});

	pi.on("session_shutdown", async () => {
		// Scaffold: no cleanup yet (TASK-006)
	});
}
