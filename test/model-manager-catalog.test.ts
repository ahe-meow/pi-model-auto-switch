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
	const firstId = "arbitrary-record-id";
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
					{ id: "orphan-model", name: "Orphan Model", metadata: { source: "native" } },
				],
			},
			{
				name: "provider-b",
				api: "anthropic-messages",
				apiKey: opaqueApiKey,
				models: [{ id: "orphan-provider-model", name: "Orphan Provider Model", metadata: { tier: "native" } }],
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
		assert.equal(snapshot.providers.length, 2);
		assert.equal(snapshot.providers[0]?.name, "provider-a");
		assert.equal(snapshot.providers[0]?.baseUrl, "https://api.example.test/v1");
		assert.deepEqual(snapshot.providers[0]?.models.map(({ id }) => id), ["gpt-4o", "gpt-4o", "orphan-model"]);
		assert.equal(snapshot.providers[1]?.name, "provider-b");
		assert.deepEqual(snapshot.providers[1]?.models.map(({ id }) => id), ["orphan-provider-model"]);
		assert.equal(snapshot.providers[0]?.apiKey, "");
		assert.equal(snapshot.providers[1]?.apiKey, "");
		assert.equal(snapshot.byId.get(snapshot.records[0]!.id), snapshot.records[0]);
		assert.equal(snapshot.byId.get(snapshot.records[1]!.id), snapshot.records[1]);
		assert.equal(snapshot.byId.get(createStableId("provider-a", "gpt-4o")), undefined);
		assert.equal(snapshot.failoverUntouched, true);
	});
});

test("readModelCatalog rejects invalid provider credentials and model shapes", async () => {
	await withFixture(async ({ modelsPath, sidecarPath }) => {
		const cases = [
			{ name: "missing apiKey", provider: { name: "provider-a", models: [{ id: "gpt-4o" }] } },
			{
				name: "non-string apiKey",
				provider: { name: "provider-a", apiKey: 42, models: [{ id: "gpt-4o" }] },
			},
			{ name: "missing models", provider: { name: "provider-a", apiKey: opaqueApiKey } },
			{
				name: "non-array models",
				provider: { name: "provider-a", apiKey: opaqueApiKey, models: {} },
			},
		];

		for (const { name, provider } of cases) {
			await writeFile(modelsPath, JSON.stringify({ providers: [provider] }), "utf8");
			const result = await readModelCatalog(modelsPath, sidecarPath);
			assertBlocked(result);
			if (result.ok) continue;
			assert.equal("code" in result.error, true, name);
			if (!("code" in result.error)) continue;
			assert.equal(result.error.code, "unreadable-models", name);
			assert.equal(result.error.message.includes(opaqueApiKey), false, name);
		}
	});
});

test("applyCatalogDraft preserves provider and model metadata", async () => {
	await withFixture(async ({ modelsPath, sidecarPath }) => {
		const snapshot = assertSnapshot(await readModelCatalog(modelsPath, sidecarPath));
		const edited = applyCatalogDraft(snapshot, {
			edit: [{ id: snapshot.records[0]!.id, fields: { label: "Edited" } }],
		});

		assert.equal((snapshot.providers[0] as Record<string, unknown>).api, "openai-completions");
		assert.equal((edited.providers[0] as Record<string, unknown>).api, "openai-completions");
		assert.equal(snapshot.providers[0]?.models[0]?.reasoning, true);
		assert.equal(edited.providers[0]?.models[0]?.reasoning, true);
	});
});

test("applyCatalogDraft preserves orphan providers and models", async () => {
	await withFixture(async ({ modelsPath, sidecarPath }) => {
		const snapshot = assertSnapshot(await readModelCatalog(modelsPath, sidecarPath));
		const edited = applyCatalogDraft(snapshot, {
			edit: [{ id: snapshot.records[0]!.id, fields: { label: "Edited" } }],
		});

		assert.equal(edited.providers.length, 2);
		const providerA = edited.providers.find((provider) => provider.name === "provider-a")!;
		const providerB = edited.providers.find((provider) => provider.name === "provider-b")!;
		assert.equal(providerA.api, "openai-completions");
		assert.equal(providerB.api, "anthropic-messages");
		assert.deepEqual(providerA.models.find((model) => model.id === "orphan-model"), {
			id: "orphan-model",
			name: "Orphan Model",
			metadata: { source: "native" },
		});
		assert.deepEqual(providerB.models, [{
			id: "orphan-provider-model",
			name: "Orphan Provider Model",
			metadata: { tier: "native" },
		}]);
		assert.equal(providerA.apiKey, "");
		assert.equal(providerB.apiKey, "");
	});
});
test("applyCatalogDraft keeps record identity fields immutable", async () => {
	await withFixture(async ({ modelsPath, sidecarPath }) => {
		const snapshot = assertSnapshot(await readModelCatalog(modelsPath, sidecarPath));
		const original = snapshot.records[0]!;
		const edited = applyCatalogDraft(snapshot, {
			edit: [{
				id: original.id,
				fields: {
					id: "replacement-id",
					providerAlias: "replacement-provider",
					modelId: "replacement-model",
					label: "Edited",
				},
			}],
		});
		const record = edited.records[0]!;

		assert.equal(record.id, original.id);
		assert.equal(record.providerAlias, original.providerAlias);
		assert.equal(record.modelId, original.modelId);
		assert.equal(record.label, "Edited");
		assert.equal(edited.byId.get(original.id), record);
		assert.equal(edited.byId.has("replacement-id"), false);
	});
});

test("readModelCatalog strips nested secrets from sidecar records and outputs", async () => {
	await withFixture(async ({ modelsPath, sidecarPath, sidecar, records }) => {
		const secret = "nested-record-secret";
		const nestedRecord = {
			...records[0],
			nestedMetadata: {
				token: secret,
				keep: true,
				deeper: [{ api_key: secret, visible: "yes" }],
			},
		};
		await writeFile(sidecarPath, JSON.stringify({ ...sidecar, models: [nestedRecord, records[1]] }), "utf8");

		const snapshot = assertSnapshot(await readModelCatalog(modelsPath, sidecarPath));
		const output = JSON.stringify(snapshot);
		assert.equal(output.includes(secret), false);
		assert.deepEqual(snapshot.records[0]?.nestedMetadata, {
			keep: true,
			deeper: [{ visible: "yes" }],
		});
		assert.equal(JSON.stringify(toPiProviderAlias(snapshot.records[0]!)).includes(secret), false);
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
		assert.equal(draft.records.find((record: ModelManagerRecord) => record.id === editedId)?.label, "Edited");
		assert.equal(draft.records.find((record: ModelManagerRecord) => record.id === editedId)?.multiplier, 3);
		assert.deepEqual(draft.records.find((record: ModelManagerRecord) => record.id === editedId)?.unknownField, {
			nested: [1, 2, 3],
		});
		assert.equal(draft.records.some((record: ModelManagerRecord) => record.id === removedId), false);
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
