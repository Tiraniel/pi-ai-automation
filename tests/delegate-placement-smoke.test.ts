import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	allocateDelegatePlacement,
	derivePlacementGroupKeyAndTitle,
	markDelegatePlacementSurfaceState,
	readPlacementRegistry,
	type CmuxDelegateAdapter,
	type CreateGroupWorkspaceInput,
	type CreateSurfaceInGroupInput,
} from "../extensions/workflow/delegate/placement.ts";

function makeCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-placement-smoke-"));
}

function makeAdapter() {
	let nextSurface = 1;
	let nextGroup = 1;
	const livePanes = new Set<string>();
	const liveSurfaces = new Set<string>();
	const calls = {
		createGroupWorkspace: 0,
		createSurfaceInGroup: 0,
	};
	const adapter: CmuxDelegateAdapter = {
		identify() {
			return { surface: "surface:parent" };
		},
		probeWorkspace(ref: string) {
			return ref.startsWith("workspace:");
		},
		probePane(ref: string) {
			return livePanes.has(ref);
		},
		probeSurface(ref: string) {
			return liveSurfaces.has(ref);
		},
		createGroupWorkspace(_input: CreateGroupWorkspaceInput) {
			calls.createGroupWorkspace += 1;
			const paneRef = `pane:${nextGroup}`;
			const workspaceRef = `workspace:${nextGroup}`;
			const surfaceRef = `surface:${nextSurface++}`;
			nextGroup += 1;
			livePanes.add(paneRef);
			liveSurfaces.add(surfaceRef);
			return { workspaceRef, paneRef, surfaceRef };
		},
		createSurfaceInGroup(input: CreateSurfaceInGroupInput) {
			calls.createSurfaceInGroup += 1;
			if (!livePanes.has(input.paneRef)) return null;
			const surfaceRef = `surface:${nextSurface++}`;
			liveSurfaces.add(surfaceRef);
			return {
				workspaceRef: input.workspaceRef,
				paneRef: input.paneRef,
				surfaceRef,
			};
		},
		renameSurface() {},
		closeSurface() {},
	};
	return {
		adapter,
		calls,
		killPane(ref: string) {
			livePanes.delete(ref);
		},
	};
}

function request(cwd: string, runId: string, groupKey: string, groupTitle: string) {
	return {
		cwd,
		runId,
		agent: "coder" as const,
		task: "Implement HK-12",
		groupKey,
		groupTitle,
		tabTitle: `${groupTitle}-coder`,
		roomContext: { roomId: "auth-refactor", agentId: "backend", role: "backend" },
	};
}

async function testConcurrentSameGroup() {
	const cwd = makeCwd();
	const fake = makeAdapter();
	const group = derivePlacementGroupKeyAndTitle({ roomId: "auth-refactor", agentId: "a", role: "backend" }, "ignored");
	const refs = await Promise.all([
		allocateDelegatePlacement(request(cwd, "pane-a", group.groupKey, group.groupTitle), fake.adapter),
		allocateDelegatePlacement(request(cwd, "pane-b", group.groupKey, group.groupTitle), fake.adapter),
		allocateDelegatePlacement(request(cwd, "pane-c", group.groupKey, group.groupTitle), fake.adapter),
	]);
	assert.equal(fake.calls.createGroupWorkspace, 1);
	assert.equal(fake.calls.createSurfaceInGroup, 2);
	assert.equal(new Set(refs.map((ref) => ref?.pane)).size, 1);
	assert.equal(Object.keys(readPlacementRegistry(cwd).groups[group.groupKey].surfaces).length, 3);
}

async function testDifferentGroups() {
	const cwd = makeCwd();
	const fake = makeAdapter();
	await Promise.all([
		allocateDelegatePlacement(request(cwd, "pane-a", "room:one", "one"), fake.adapter),
		allocateDelegatePlacement(request(cwd, "pane-b", "room:two", "two"), fake.adapter),
	]);
	assert.equal(fake.calls.createGroupWorkspace, 2);
	assert.equal(Object.keys(readPlacementRegistry(cwd).groups).length, 2);
}

async function testStalePaneRecovery() {
	const cwd = makeCwd();
	const fake = makeAdapter();
	const first = await allocateDelegatePlacement(request(cwd, "pane-a", "task:HK-12", "HK-12"), fake.adapter);
	assert.ok(first?.pane);
	fake.killPane(first.pane);
	const second = await allocateDelegatePlacement(request(cwd, "pane-b", "task:HK-12", "HK-12"), fake.adapter);
	assert.equal(fake.calls.createGroupWorkspace, 2);
	assert.notEqual(second?.pane, first.pane);
	const group = readPlacementRegistry(cwd).groups["task:HK-12"];
	assert.equal(group.staleRefs?.length, 1);
	assert.equal(group.surfaces["pane-a"].state, "stale");
}

async function testRegistrySurvivesAdapterResetAndCloseState() {
	const cwd = makeCwd();
	const fake = makeAdapter();
	const first = await allocateDelegatePlacement(request(cwd, "pane-a", "room:durable", "durable"), fake.adapter);
	assert.ok(first?.pane);
	const resetFake = makeAdapter();
	resetFake.adapter.probePane = (ref: string) => ref === first.pane;
	resetFake.adapter.createSurfaceInGroup = (input: CreateSurfaceInGroupInput) => {
		resetFake.calls.createSurfaceInGroup += 1;
		return { workspaceRef: input.workspaceRef, paneRef: input.paneRef, surfaceRef: "surface:after-reset" };
	};
	await allocateDelegatePlacement(request(cwd, "pane-b", "room:durable", "durable"), resetFake.adapter);
	assert.equal(resetFake.calls.createGroupWorkspace, 0);
	assert.equal(resetFake.calls.createSurfaceInGroup, 1);
	await markDelegatePlacementSurfaceState(cwd, "room:durable", "pane-b", "closed");
	assert.equal(readPlacementRegistry(cwd).groups["room:durable"].surfaces["pane-b"].state, "closed");
}

async function testParentSurfaceRejectedByAdapter() {
	const cwd = makeCwd();
	const fake = makeAdapter();
	fake.adapter.createGroupWorkspace = (input: CreateGroupWorkspaceInput) => {
		fake.calls.createGroupWorkspace += 1;
		return {
			workspaceRef: "workspace:parent",
			paneRef: "pane:parent",
			surfaceRef: input.sourceSurface ?? "surface:parent",
		};
	};
	fake.adapter.probeSurface = (ref: string) => ref !== "surface:parent";
	const allocated = await allocateDelegatePlacement(request(cwd, "pane-a", "room:parent-guard", "parent-guard"), fake.adapter);
	assert.equal(allocated, null);
	assert.equal(fake.calls.createGroupWorkspace, 1);
	assert.equal(readPlacementRegistry(cwd).groups["room:parent-guard"], undefined);
}

await testConcurrentSameGroup();
await testDifferentGroups();
await testStalePaneRecovery();
await testRegistrySurvivesAdapterResetAndCloseState();
await testParentSurfaceRejectedByAdapter();
console.log("delegate placement smoke ok");
