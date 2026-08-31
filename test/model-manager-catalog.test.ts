import assert from "node:assert/strict";
import {
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	applyCatalogDraft,
	readModelCatalog,
	toPiProviderAlias,
	toSidecarRecord,
	type ModelManagerCatalogSnapshot,
} from "../src/model-manager-catalog.ts";
import {
	createStableId,
	type ModelManagerBlockedState,
	type ModelManagerRecord,
	type ModelManagerResult,
	type ModelManagerSidecar,
} from "../src/model-manager-types.ts";

const opaqueApiKey = "opaque-native-api-key-reference";
const failoverMarker = "failover-file-must-stay-byte-for-byte-unchanged";

interface Fixture {
	dir: string;
	modelsPath: string;
	sidecarPath: string;
	failoverPaths: string[];
	modelsBytes: Buffer;
	sidecar: ModelManagerSidecar;
	records: ModelManagerRecord[];
}

function makeFixtureData(): Omit<Fixture, "dir" | "modelsPath" | "sidecarPath" | "failoverPaths"> {
	const firstId = createStableId("provider-a", "gpt-4o");
	const records: ModelManagerRecord[] = [
		{
			id: firstId,
			providerAlias: "provider-a",
			providerName: "Provider A",
			modelId: "gpt-4o",
			label: "Primary",
			multiplier: 2,
			unknownField: { nested: [1, 2, 3] },
		},
		{
			id: `${firstId}-2`,
			providerAlias: "provider-a",
			providerName: "Provider A",
			modelId: "gpt-4o",
			label: "Duplicate model entry",
		},
	];
	const sidecar: ModelManagerSidecar = {
		version: 1,
		models: records,
		unknownTopLevel: { retained: true },
	};
	const modelsValue = {
		providers: [
			{
				name: "provider-a",
				baseUrl: "https://api.example.test/v1",
				api: "openai-completions",
				apiKey: opaqueApiKey,
				models: [
					{ id: "gpt-4o", name: "GPT-4o", reasoning: true },
					{ id: "gpt-4o", name: "GPT-4o duplicate", reasoning: false },
				],
			},
		],
	};
	return {
		modelsBytes: Buffer.from(`${JSON.stringify(modelsValue, null, 2)}\n`, "utf8"),
		sidecar,
		records,
	};
}

async function makeFixture(): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "model-manager-catalog-"));
	const modelsPath = join(dir, "models.json");
	const sidecarPath = join(dir, "model-manager.json");
	const failoverPaths = [join(dir, "model-failover.json"), join(dir, "failover-state.json")];
	const data = makeFixtureData();
	await writeFile(modelsPath, data.modelsBytes);
	await writeFile(sidecarPath, `${JSON.stringify(data.sidecar, null, 2)}\n`, "utf8");
	for (const path of failoverPaths) await writeFile(path, failoverMarker, "utf8");
	return { dir, modelsPath, sidecarPath, failoverPaths, ...data };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
	const fixture = await makeFixture();
	try {
		await run(fixture);
	} finally {
		await rm(fixture.dir, { recursive: true, force: true });
	}
}

function assertBlocked<T>(
	result: ModelManagerResult<T>,
): asserts result is { ok: false; error: ModelManagerBlockedState } {
	assert.equal(result.ok, false);
}

function assertSnapshot(
	result: ModelManagerResult<ModelManagerCatalogSnapshot>,
): ModelManagerCatalogSnapshot {
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("expected catalog snapshot");
	return result.value;
}

test("readModelCatalog builds stable id index from records and models config", async () => {
	await withFixture(async ({ modelsPath, sidecarPath, records }) => {
		const result = await readModelCatalog(modelsPath, sidecarPath);
		const snapshot = assertSnapshot(result);

		assert.deepEqual(snapshot.records, records);
		assert.equal(snapshot.providers.length, 1);
		assert.equal(snapshot.providers[0]?.name, "provider-a");
		assert.equal(snapshot.providers[0]?.baseUrl, "https://api.example.test/v1");
		assert.deepEqual(snapshot.providers[0]?.models.map(({ id }) => id), ["gpt-4o", "gpt-4o"]);
		assert.equal(snapshot.providers[0]?.apiKey, "");
		assert.equal(snapshot.byId.get(createStableId("provider-a", "gpt-4o")), snapshot.records[0]);
		assert.equal(
			snapshot.byId.get(createStableId("provider-a", "gpt-4o", new Set([createStableId("provider-a", "gpt-4o")]))),
			snapshot.records[1],
		);
		assert.equal(snapshot.failoverUntouched, true);
	});
});

test("readModelCatalog surfaces sidecar blocked state unchanged", async () => {
	await withFixture(async ({ modelsPath, sidecarPath }) => {
		await writeFile(sidecarPath, "{ malformed sidecar", "utf8");
		const result = await readModelCatalog(modelsPath, sidecarPath);
		assertBlocked(result);
		if (result.ok) return;
		assert.equal("reason" in result.error, true);
		if (!("reason" in result.error)) return;
		assert.equal(result.error.reason, "malformed");
		assert.equal(result.error.message, "sidecar is not valid JSON");
		assert.deepEqual(Buffer.from(result.error.rawBytes ?? []), Buffer.from("{ malformed sidecar", "utf8"));
		assert.equal("code" in result.error, false);
	});
});

test("toPiProviderAlias emits single apiKey provider schema", () => {
	const record: ModelManagerRecord = {
		id: "record-id",
		providerAlias: "mm-provider-key",
		providerName: "Provider A",
		modelId: "gpt-4o",
	};
	const alias = toPiProviderAlias(record);

	assert.deepEqual(Object.keys(alias).sort(), ["apiKey", "models", "name"]);
	assert.equal(alias.name, "mm-provider-key");
	assert.equal(alias.apiKey, "");
	assert.deepEqual(alias.models, [{ id: "gpt-4o" }]);
	assert.equal(JSON.stringify(alias).includes(opaqueApiKey), false);
});

test("existing apiKey bytes survive unchanged without entering snapshot", async () => {
	await withFixture(async ({ modelsPath, sidecarPath, modelsBytes }) => {
		const before = await readFile(modelsPath);
		const result = await readModelCatalog(modelsPath, sidecarPath);
		const snapshot = assertSnapshot(result);
		const printableOutput = JSON.stringify(snapshot);

		assert.deepEqual(before, modelsBytes);
		assert.deepEqual(await readFile(modelsPath), before);
		assert.equal(printableOutput.includes(opaqueApiKey), false);
		assert.equal(JSON.stringify(snapshot.records).includes(opaqueApiKey), false);
		assert.equal(JSON.stringify(snapshot.providers).includes(opaqueApiKey), false);
		assert.equal(JSON.stringify(toPiProviderAlias(snapshot.records[0]!)).includes(opaqueApiKey), false);
		assert.equal(JSON.stringify(snapshot).includes("apiKey"), true);
		assert.equal(snapshot.providers[0]?.apiKey, "");
	});
});

test("toSidecarRecord fills defaults with multiplier 1 and group fields", () => {
	const record = toSidecarRecord("Provider A", "gpt-4o", {
		providerAlias: "provider-a",
		label: "GPT-4o",
		unknownField: { keep: true },
	});

	assert.equal(record.id, createStableId("provider-a", "gpt-4o"));
	assert.equal(record.providerAlias, "provider-a");
	assert.equal(record.providerName, "Provider A");
	assert.equal(record.modelId, "gpt-4o");
	assert.equal(record.multiplier, 1);
	assert.equal(record.groupOwner, false);
	assert.equal(record.remoteGroup, undefined);
	assert.deepEqual(record.unknownField, { keep: true });
});

test("applyCatalogDraft add edit remove returns new snapshot without mutating input", async () => {
	await withFixture(async ({ modelsPath, sidecarPath }) => {
		const result = await readModelCatalog(modelsPath, sidecarPath);
		const snapshot = assertSnapshot(result);
		const originalRecords = structuredClone(snapshot.records);
		const originalIndex = [...snapshot.byId.entries()];
		const added = toSidecarRecord("Provider A", "new-model", {
			providerAlias: "provider-a",
			label: "New",
			unknownAddedField: "preserved",
		});
		const editedId = snapshot.records[0]!.id;
		const removedId = snapshot.records[1]!.id;

		const draft = applyCatalogDraft(snapshot, {
			add: [added],
			edit: [{ id: editedId, fields: { label: "Edited", multiplier: 3 } }],
			remove: [removedId],
		});

		assert.notEqual(draft, snapshot);
		assert.notEqual(draft.records, snapshot.records);
		assert.notEqual(draft.byId, snapshot.byId);
		assert.deepEqual(snapshot.records, originalRecords);
		assert.deepEqual([...snapshot.byId.entries()], originalIndex);
		assert.equal(draft.records.length, 2);
		assert.equal(draft.records.find((record) => record.id === editedId)?.label, "Edited");
		assert.equal(draft.records.find((record) => record.id === editedId)?.multiplier, 3);
		assert.deepEqual(draft.records.find((record) => record.id === editedId)?.unknownField, {
			nested: [1, 2, 3],
		});
		assert.equal(draft.records.some((record) => record.id === removedId), false);
		assert.equal(draft.byId.get(added.id), draft.records.find((record) => record.id === added.id));
		assert.equal(draft.byId.get(createStableId("provider-a", "new-model")), draft.records.find((record) => record.id === added.id));
		assert.equal(draft.failoverUntouched, true);
	});
});

test("readModelCatalog returns unreadable-models for malformed models JSON", async () => {
	await withFixture(async ({ modelsPath, sidecarPath }) => {
		await writeFile(modelsPath, "{ malformed models", "utf8");
		const result = await readModelCatalog(modelsPath, sidecarPath);
		assertBlocked(result);
		if (result.ok) return;
		assert.equal("code" in result.error, true);
		if (!("code" in result.error)) return;
		assert.equal(result.error.code, "unreadable-models");
		assert.equal(result.error.message.includes(opaqueApiKey), false);
	});
});

test("readModelCatalog rejects a non-array providers shape", async () => {
	await withFixture(async ({ modelsPath, sidecarPath }) => {
		await writeFile(modelsPath, JSON.stringify({ providers: {} }), "utf8");
		const result = await readModelCatalog(modelsPath, sidecarPath);
		assertBlocked(result);
		if (result.ok) return;
		assert.equal("code" in result.error, true);
		if (!("code" in result.error)) return;
		assert.equal(result.error.code, "unreadable-models");
		assert.equal(result.error.message.includes(opaqueApiKey), false);
	});
});

test("readModelCatalog never reads or modifies failover files", async () => {
	await withFixture(async ({ modelsPath, sidecarPath, failoverPaths }) => {
		const before = await Promise.all(failoverPaths.map((path) => readFile(path)));
		const result = await readModelCatalog(modelsPath, sidecarPath);
		assertSnapshot(result);
		const after = await Promise.all(failoverPaths.map((path) => readFile(path)));

		assert.deepEqual(after, before);
		assert.equal(JSON.stringify(result).includes(failoverMarker), false);
	});
});
