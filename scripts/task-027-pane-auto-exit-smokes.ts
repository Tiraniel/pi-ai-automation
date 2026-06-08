#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	findLatestAssistantStopReason,
	shouldAutoCompleteOnAgentEnd,
	writeAutoExitDoneSidecar,
} from "../extensions/workflow/delegate/done-tools";
import { resolvePaneCompletionOutcome } from "../extensions/workflow/delegate/pane-completion";

let failures = 0;

function check(condition: boolean, message: string): void {
	if (condition) {
		console.log(`PASS: ${message}`);
		return;
	}
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function readJson<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function main(): Promise<void> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-027-pane-auto-exit-smoke-"));
	try {
		const doneFile = path.join(tmpDir, "done.json");
		const explicit = {
			done: true,
			completion: "explicit",
			source: "tool",
			tool: "sub_agent_done",
			summary: "Explicit completion summary",
			at: new Date().toISOString(),
			exit_code: 0,
		} as const;
		fs.writeFileSync(doneFile, JSON.stringify(explicit) + "\n", "utf8");
		const explicitSidecar = readJson<typeof explicit>(doneFile);
		const explicitOutcome = resolvePaneCompletionOutcome(explicitSidecar, "assistant final output");
		check(explicitOutcome.status === "completed", "explicit done returns completed");
		check(explicitOutcome.finalOutput === "assistant final output", "explicit done uses final assistant output");
		check(explicitOutcome.completionSource === "explicit", "explicit done preserves completion source");

		const autoDoneFile = path.join(tmpDir, "auto-done.json");
		const wroteAuto = await writeAutoExitDoneSidecar(autoDoneFile, { stopReason: "completed" });
		check(wroteAuto === true, "auto done sidecar writes with exclusive create");
		const autoSidecar = readJson<any>(autoDoneFile);
		const autoOutcome = resolvePaneCompletionOutcome(autoSidecar, "auto final assistant output");
		check(autoOutcome.status === "completed", "auto-exit fallback can complete on normal stop reason");
		check(autoOutcome.finalOutput === "auto final assistant output", "auto-exit fallback uses final assistant output");
		check(Boolean(autoOutcome.warning && autoOutcome.warning.includes("did not call")), "auto-exit fallback exposes warning metadata");

		const noFinalAutoDoneFile = path.join(tmpDir, "auto-done-no-final.json");
		const noFinalAuto = {
			done: true,
			completion: "auto_exit",
			source: "agent_end",
			at: new Date().toISOString(),
			summary: "auto-exit sidecar summary present",
			exit_code: 0,
			from_auto_exit: true,
			stop_reason: "completed",
		} as const;
		fs.writeFileSync(noFinalAutoDoneFile, JSON.stringify(noFinalAuto) + "\n", "utf8");
		const noFinalAutoSidecar = readJson<any>(noFinalAutoDoneFile);
		const noFinalAutoOutcome = resolvePaneCompletionOutcome(noFinalAutoSidecar, "");
		check(noFinalAutoOutcome.status === "failed", "auto-exit fallback without final assistant output fails");
		check(noFinalAutoOutcome.exitCode === 1, "auto-exit fallback without final output exits with failure code");
		check(noFinalAutoOutcome.finalOutput === "", "auto-exit fallback without final output returns empty finalOutput");
		check(noFinalAutoOutcome.stderr.includes("did not find final assistant output"), "auto-exit fallback without final output explains missing final assistant output");

		const explicitPreservedFile = path.join(tmpDir, "preserve.json");
		const explicitPayload = {
			done: true,
			completion: "explicit",
			source: "tool",
			tool: "sub_agent_done",
			at: new Date().toISOString(),
			summary: "existing explicit",
			exit_code: 0,
		} as const;
		fs.writeFileSync(explicitPreservedFile, JSON.stringify(explicitPayload) + "\n", "utf8");
		const overwritten = await writeAutoExitDoneSidecar(explicitPreservedFile, { stopReason: "completed" });
		check(overwritten === false, "auto-exit does not overwrite existing explicit sidecar");
		const preservedPayload = readJson<typeof explicitPayload>(explicitPreservedFile);
		check(preservedPayload?.summary === "existing explicit", "explicit sidecar remains unchanged after auto-write");

		check(
			findLatestAssistantStopReason({ messages: [
				{ role: "assistant", stopReason: "aborted" },
				{ role: "assistant", content: "final response" },
			] }) === undefined,
			"latest assistant stop reason uses the latest assistant turn only",
		);
		check(
			findLatestAssistantStopReason({ messages: [
				{ role: "assistant", stopReason: "interrupted", stop_reason: "interrupted" },
				{ role: "assistant", stopReason: "ok" },
			] }) === "ok",
			"latest assistant stop reason ignores older aborted/interrupted",
		);
		check(
			findLatestAssistantStopReason({ messages: [
				{ role: "assistant", stopReason: "aborted" },
				{ role: "assistant", content: "final response" },
				{ role: "assistant", stopReason: "error" },
			] }) === "error",
			"latest assistant stop reason detects latest blocked stop reason",
		);
		check(shouldAutoCompleteOnAgentEnd({ messages: [] }) === false, "empty messages does not auto-complete");
		check(
			shouldAutoCompleteOnAgentEnd({ messages: [{ role: "user" }] }) === false,
			"non-assistant latest message does not auto-complete",
		);
		check(
			shouldAutoCompleteOnAgentEnd({ message: { role: "user", content: "foo" } }) === false,
			"event payload with no assistant message does not auto-complete",
		);
		check(
			shouldAutoCompleteOnAgentEnd({ message: { content: "roleless generic" } }) === false,
			"role-less generic message does not auto-complete",
		);
		check(
			shouldAutoCompleteOnAgentEnd({ assistantMessage: { content: "assistant-specific payload" } }) === true,
			"assistantMessage payload without role counts as assistant evidence",
		);
		check(
			shouldAutoCompleteOnAgentEnd({ message: { role: "assistant", content: "summary" } }) === true,
			"assistant event payload evidence allows normal auto-complete",
		);
		check(
			shouldAutoCompleteOnAgentEnd({ errorMessage: "provider error" }) === false,
			"top-level errorMessage blocks auto-complete even without assistant messages",
		);
		check(shouldAutoCompleteOnAgentEnd({ stopReason: "interrupted" }) === false, "stop reason interrupted does not auto-complete");
		check(
			shouldAutoCompleteOnAgentEnd({ messages: [
				{ role: "assistant", stopReason: "aborted" },
				{ role: "assistant", content: "final response" },
			] }) === true,
			"older aborted assistant stop reason does not block latest normal turn",
		);
		check(
			shouldAutoCompleteOnAgentEnd({ messages: [
				{ role: "assistant", content: "final response" },
				{ role: "assistant", stopReason: "error" },
			] }) === false,
			"latest assistant stop reason error blocks auto-complete",
		);
		check(
			shouldAutoCompleteOnAgentEnd({ stopReason: "error", messages: [{ role: "assistant", stopReason: "ok" }] }) === false,
			"stop reason error does not auto-complete",
		);
		check(
			shouldAutoCompleteOnAgentEnd({ messages: [{ role: "assistant", errorMessage: "old provider error" }, { role: "assistant", content: "final response" }] }) === true,
			"older assistant error message does not block latest normal turn",
		);
		check(
			shouldAutoCompleteOnAgentEnd({ errorMessage: "agent_end error", messages: [{ role: "assistant", content: "final response" }] }) === false,
			"event-level errorMessage blocks auto-complete",
		);
		check(shouldAutoCompleteOnAgentEnd({ messages: [{ role: "assistant", errorMessage: "provider error" }] }) === false, "latest assistant error message blocks auto-complete");

		const badAutoSidecar = {
			done: true,
			completion: "auto_exit",
			source: "agent_end",
			at: new Date().toISOString(),
			stop_reason: "interrupted",
			exit_code: 0,
			summary: "interrupted run",
		} as const;
		const badAutoOutcome = resolvePaneCompletionOutcome(badAutoSidecar, "");
		check(badAutoOutcome.status === "failed", "auto-exit fallback fails on interrupted stop reason");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

main()
	.then(() => {
		if (failures > 0) {
			process.exit(1);
		}
	})
	.catch((error) => {
		console.error("FAIL: task-027 smoke runner threw", error);
		process.exit(1);
	});
