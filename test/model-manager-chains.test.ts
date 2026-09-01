import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelManagerCatalogSnapshot } from "../src/model-manager-catalog.ts";
import type { CatalogImpact } from "../src/model-manager-impact.ts";
import {
	buildVirtualModel,
	notifyModelManagerDelete,
	registerFailoverChain,
	registerModelManagerBridge,
	selectCatalogRecordsForChains,
} from "../src/model-manager-bridge.ts";
import type { ModelManagerRecord } from "../src/model-manager-types.ts";
import * as index from "../src/index.ts";
import type { TuiState } from "../src/model-manager-tui.ts";

function record(overrides: Partial<ModelManagerRecord> = {}): ModelManagerRecord {
	return {
		id: "record-a",
		providerAlias: "provider-a",
		providerName: "Provider A",
		modelId: "model-a",
		...overrides,
	};
}

function snapshot(
	records: readonly ModelManagerRecord[],
	byId: readonly ModelManagerRecord[] = records,
): ModelManagerCatalogSnapshot {
	return {
		records: [...records],
		byId: new Map(byId.map((entry) => [entry.id, entry])),
		providers: [],
		failoverUntouched: true,
	};
}

const impact: CatalogImpact = {
	recordId: "record-a",
	chains: [
		{ file: "model-failover.json", chainId: "primary", kind: "model-entry" },
	],
	state: [],
	referenced: true,
};

// This is the runtime export snapshot from src/index.ts before Task 9 wiring.
const existingIndexExports = new Set([
	"FAILOVER_CONFIG_PATH",
	"MODELS_JSON_PATH",
	"registerFailoverExtension",
	"default",
]);


test("selectCatalogRecordsForChains filters to sidecar records only", () => {
	const sidecarA = record({ id: "sidecar-a" });
	const sidecarB = record({ id: "sidecar-b", modelId: "model-b" });
	const providerOnly = record({ id: "provider-only", modelId: "orphan" });
	const current = snapshot([sidecarA, sidecarB], [sidecarA, sidecarB, providerOnly]);
	const beforeRecords = [...current.records];
	const beforeById = [...current.byId.entries()];

	const selected = selectCatalogRecordsForChains(current);

	assert.notStrictEqual(selected, current.records);
	assert.equal(selected[0], sidecarA);
	assert.equal(selected[1], sidecarB);
	assert.deepEqual(selected, [sidecarA, sidecarB]);
	assert.deepEqual(current.records, beforeRecords);
	assert.deepEqual([...current.byId.entries()], beforeById);
	assert.equal(selected.some((entry) => entry.id === providerOnly.id), false);
});

test("buildVirtualModel returns null for unregistered chain", () => {
	const records = [record({ providerAlias: "safe-provider" })];

	assert.equal(buildVirtualModel("not-registered", records), null);
	assert.equal(buildVirtualModel("unsafe/chain", records), null);
	assert.equal(buildVirtualModel("", records), null);
});

test("buildVirtualModel uses mm prefix for registered chain", () => {
	registerFailoverChain("catalog-primary");
	registerFailoverChain("catalog-primary");
	const records = [
		record({
			providerAlias: "safe-provider",
			apiKey: "do-not-return",
		}),
		record({ id: "record-b", providerAlias: "second-provider" }),
	];

	assert.deepEqual(buildVirtualModel("catalog-primary", records), {
		id: "mm-catalog-primary",
		provider: "safe-provider",
	});
	assert.deepEqual(buildVirtualModel("catalog-primary", records), {
		id: "mm-catalog-primary",
		provider: "safe-provider",
	});
	assert.equal(buildVirtualModel("catalog-primary", []), null);
});

test("notifyModelManagerDelete without a bridge is a safe no-op", async () => {
	await assert.doesNotReject(
		notifyModelManagerDelete("missing-bridge-record", impact),
	);
});

test("bridge delete routes through coordinator callback and leaves failover files byte identical", async () => {
	const directory = await mkdtemp(join(tmpdir(), "model-manager-bridge-"));
	const failoverPaths = [
		join(directory, "model-failover.json"),
		join(directory, "failover-state.json"),
	];
	const originalBytes = [
		Buffer.from('{"version":8,"models":[]}\n'),
		Buffer.from('{"targets":{}}\n'),
	];
	try {
		await Promise.all(
			failoverPaths.map((path, index) => writeFile(path, originalBytes[index])),
		);
		const before = await Promise.all(failoverPaths.map((path) => readFile(path)));
		const calls: Array<{ recordId: string; impact: CatalogImpact }> = [];
		registerModelManagerBridge({
			onDeleteRecord: async (
				recordId: string,
				receivedImpact: CatalogImpact,
			) => {
				calls.push({ recordId, impact: receivedImpact });
			},
		});

		await notifyModelManagerDelete("record-a", impact);

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.recordId, "record-a");
		assert.strictEqual(calls[0]?.impact, impact);
		const after = await Promise.all(failoverPaths.map((path) => readFile(path)));
		assert.deepEqual(after, before);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("bridge delete propagates coordinator callback errors", async () => {
	const failure = new Error("coordinator rejected delete");
	registerModelManagerBridge({
		onDeleteRecord: async () => {
			throw failure;
		},
	});

	await assert.rejects(
		notifyModelManagerDelete("record-a", impact),
		(error) => error === failure,
	);
});

test("index exports model manager api as a superset of previous exports", () => {
	const exported = new Set(Object.keys(index));
	for (const name of existingIndexExports) assert.equal(exported.has(name), true, name);
	for (const name of [
		"buildVirtualModel",
		"notifyModelManagerDelete",
		"registerFailoverChain",
		"registerModelManagerBridge",
		"selectCatalogRecordsForChains",
	]) {
		assert.equal(exported.has(name), true, name);
	}

	assert.equal(index.modelManagerCommand.name, "failover");
	assert.equal(index.modelManagerCommand.initialScreen, "Model Manager");
	const state: TuiState = {
		tab: "model-manager",
		snapshot: null,
		blocked: null,
		conflict: null,
		message: null,
		pendingDraft: null,
		pendingImpact: null,
		failoverSummary: null,
		history: [],
	};
	assert.match(index.modelManagerCommand.render(state), /Model Manager/);
});
