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

test("[S1] click blocks the button and shows the loader while the request is in flight", async () => {
	const { controller, calls } = harness();
	const clicking = controller.click();
	assert.equal(controller.view.buttonEnabled, false);
	assert.equal(controller.view.loaderVisible, true);
	assert.equal(controller.view.toast, null);
	calls[0].resolve();
	await clicking;
});

test("[S2] resolved request unblocks the button, hides the loader, shows the success toast", async () => {
	const { controller, calls } = harness();
	const clicking = controller.click();
	calls[0].resolve();
	await clicking;
	assert.equal(controller.view.buttonEnabled, true);
	assert.equal(controller.view.loaderVisible, false);
	assert.equal(controller.view.toast, "success");
});

test("[F1] rejected request unblocks the button, hides the loader, shows the failure toast", async () => {
	const { controller, calls } = harness();
	const clicking = controller.click();
	calls[0].reject(new Error("boom"));
	await clicking;
	assert.equal(controller.view.buttonEnabled, true);
	assert.equal(controller.view.loaderVisible, false);
	assert.equal(controller.view.toast, "failure");
});

test("[FS1] clicking while submitting does not send a second request", async () => {
	const { controller, calls } = harness();
	const first = controller.click();
	await controller.click(); // must be ignored while in flight
	assert.equal(calls.length, 1);
	assert.equal(controller.view.buttonEnabled, false);
	calls[0].resolve();
	await first;
	assert.equal(controller.view.toast, "success");
});

test("[FF1] slow success still ends unblocked with a success toast", async () => {
	const { controller, calls } = harness();
	const clicking = controller.click();
	for (let tick = 0; tick < 50; tick++) await Promise.resolve();
	assert.equal(controller.view.buttonEnabled, false); // honestly still submitting
	calls[0].resolve();
	await clicking;
	assert.equal(controller.view.buttonEnabled, true);
	assert.equal(controller.view.loaderVisible, false);
	assert.equal(controller.view.toast, "success");
});
