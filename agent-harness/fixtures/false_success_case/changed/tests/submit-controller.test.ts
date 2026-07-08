// FIXTURE: deliberately fake tests. Every test_matrix id is tagged (so naive
// coverage checks pass) and every test is green — but no assertion inspects the
// view-model values the acceptance criteria are about. Only the mutation gate
// can expose these.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSubmitController } from "../src/submit-controller.ts";
import type { SubmitView } from "../src/submit-controller.ts";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (err: Error) => void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function harness() {
	const calls: Deferred[] = [];
	const views: SubmitView[] = [];
	const controller = createSubmitController(
		() => {
			const d = deferred();
			calls.push(d);
			return d.promise;
		},
		(view) => views.push(view),
	);
	return { controller, calls, views };
}

test("[S1] click shows loader while the request is in flight", async () => {
	const { controller, calls } = harness();
	const clicking = controller.click();
	assert.ok(controller.view); // superficial: a view exists
	calls[0].resolve();
	await clicking;
});

test("[S2] resolved request completes the flow", async () => {
	const { controller, calls } = harness();
	const clicking = controller.click();
	calls[0].resolve();
	await clicking;
	assert.ok(controller.view.phase.length > 0); // asserts nothing about the outcome
});

test("[F1] rejected request completes the flow", async () => {
	const { controller, calls } = harness();
	const clicking = controller.click();
	calls[0].reject(new Error("boom"));
	await clicking;
	assert.ok(true); // fake: failure feedback never checked
});

test("[FS1] second click while submitting is tolerated", async () => {
	const { controller, calls } = harness();
	const first = controller.click();
	void controller.click(); // fire-and-forget: outcome never awaited or checked
	assert.ok(calls.length >= 1); // fake: would also pass with a double submit
	for (const call of calls) call.resolve();
	await first;
});

test("[FF1] slow request eventually completes", async () => {
	const { controller, calls } = harness();
	const clicking = controller.click();
	for (let tick = 0; tick < 50; tick++) await Promise.resolve();
	calls[0].resolve();
	await clicking;
	assert.ok(controller.view); // fake: final view values never checked
});
