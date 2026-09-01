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
	readModelCatalog,
	type ModelManagerCatalogSnapshot,
} from "../src/model-manager-catalog.ts";
import {
	buildVirtualModel,
	clearFailoverChains,
	clearModelManagerBridge,
	notifyModelManagerDelete,
	registerFailoverChain,
	registerModelManagerBridge,
} from "../src/model-manager-bridge.ts";
import {
	analyzeDeletionImpact,
	confirmCascade,
	type CatalogImpact,
} from "../src/model-manager-impact.ts";
import {
	buildPreview,
	cloneDraft,
} from "../src/model-manager-operations.ts";
import {
	serializeSidecar,
	validateSidecar,
} from "../src/model-manager-sidecar.ts";
import {
	commitCatalogTransaction,
	readRevision,
} from "../src/model-manager-store.ts";
import { parseRawKeys } from "../src/model-manager-input.ts";
import {
	renderManagerScreen,
	type TuiState,
} from "../src/model-manager-tui.ts";
import type {
	ModelManagerRecord,
	ModelManagerResult,
	ModelManagerSidecar,
} from "../src/model-manager-types.ts";

const sourceRecord: ModelManagerRecord = {
	id: "source-record",
	providerAlias: "mm-provider-release-old-fingerprint",
	providerName: "Release Provider",
	modelId: "release-model",
	label: "Release model",
	multiplier: 2.5,
	baseUrl: "https://provider.example.test/v1",
	advancedConfig: { region: "test", limits: { context: 128000 } },
};

function snapshot(
	records: readonly ModelManagerRecord[] = [sourceRecord],
): ModelManagerCatalogSnapshot {
	const copied = structuredClone(records) as ModelManagerRecord[];
	return {
		records: copied,
		byId: new Map(copied.map((record) => [record.id, record])),
		providers:
			copied.length === 0
				? []
				: [
						{
							name: sourceRecord.providerAlias,
							apiKey: "",
							models: [{ id: sourceRecord.modelId }],
						},
					],
		failoverUntouched: true,
	};
}

function assertOk<T>(result: ModelManagerResult<T>): T {
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("expected successful result");
	return result.value;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "model-manager-release-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("sidecar unknown fields survive validate serialize validate round trip", () => {
	const sidecar: ModelManagerSidecar = {
		version: 1,
		futureTopLevel: { keep: true, values: [1, "two"] },
		models: [
			{
				...sourceRecord,
				futureRecordField: { nested: { keep: "value" } },
			},
		],
	};

	const validated = assertOk(validateSidecar(sidecar));
	const serialized = assertOk(serializeSidecar(validated));
	const roundTrip = assertOk(
		validateSidecar(JSON.parse(new TextDecoder().decode(serialized))),
	);

	assert.deepEqual(roundTrip, sidecar);
});

test("raw duplicate batch rejects all lines without key material in errors", () => {
	const secret = "release-raw-key-secret";
	const result = parseRawKeys(`${secret}\nsecond-valid-key\n${secret}`);

	assert.equal(result.accepted, false);
	assert.deepEqual(result.entries, []);
	assert.deepEqual(result.rejected.map(({ line }) => line), [3]);
	assert.equal(JSON.stringify(result).includes(secret), false);
});

test("clone keeps advanced fields through buildPreview without secret material", () => {
	const draft = assertOk(
		cloneDraft(snapshot(), sourceRecord.id, "release-clone-fingerprint"),
	);
	const secret = "release-clone-secret";
	draft.secret = secret;
	const preview = assertOk(buildPreview(snapshot(), draft));
	const cloned = preview.sidecarAfter.models.find(
		(record) => record.providerAlias === draft.fields.providerAlias,
	);
	const provider = preview.providerDrafts.find(
		(candidate) => candidate.name === draft.fields.providerAlias,
	);

	assert.deepEqual(cloned?.advancedConfig, sourceRecord.advancedConfig);
	assert.equal(cloned?.baseUrl, sourceRecord.baseUrl);
	assert.deepEqual(
		provider?.models.find((model) => model.id === sourceRecord.modelId)?.advancedConfig,
		sourceRecord.advancedConfig,
	);
	assert.equal(provider?.apiKey, "");
	assert.equal(JSON.stringify(preview).includes(secret), false);
});

test("cas conflict leaves every catalog file byte-identical", async () => {
	await withTempDir(async (dir) => {
		const modelsPath = join(dir, "models.json");
		const sidecarPath = join(dir, "model-manager.json");
		const originalModels = Buffer.from('{"providers":[]}\n');
		const originalSidecar = Buffer.from('{"version":1,"models":[]}\n');
		await writeFile(modelsPath, originalModels);
		await writeFile(sidecarPath, originalSidecar);
		const modelsRevision = (await readRevision(modelsPath)).revision;
		const sidecarRevision = (await readRevision(sidecarPath)).revision;
		await writeFile(modelsPath, '{"providers":[{"name":"changed"}]}\n');
		const before = [await readFile(modelsPath), await readFile(sidecarPath)];
		const writes: string[] = [];

		const result = await commitCatalogTransaction(
			{
				writes: [
					{
						path: sidecarPath,
						bytes: Buffer.from('{"version":1,"models":[{}]}\n'),
						expectRevision: sidecarRevision,
					},
					{
						path: modelsPath,
						bytes: Buffer.from('{"providers":[]}\n'),
						expectRevision: modelsRevision,
					},
				],
			},
			async (path, bytes) => {
				writes.push(path);
				await writeFile(path, bytes);
			},
		);

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.phase, "prepare");
		assert.deepEqual(writes, []);
		assert.deepEqual(await readFile(sidecarPath), before[1]);
		assert.deepEqual(await readFile(modelsPath), before[0]);
	});
});

test("blocked sidecar prevents catalog and TUI renders fixed recovery hint", async () => {
	await withTempDir(async (dir) => {
		const modelsPath = join(dir, "models.json");
		const sidecarPath = join(dir, "model-manager.json");
		const rawBytes = Buffer.from("{ malformed release sidecar", "utf8");
		await writeFile(modelsPath, JSON.stringify({ providers: [] }));
		await writeFile(sidecarPath, rawBytes);

		const catalog = await readModelCatalog(modelsPath, sidecarPath);
		assert.equal(catalog.ok, false);
		if (catalog.ok) return;
		assert.equal("reason" in catalog.error, true);
		if (!("reason" in catalog.error)) return;
		assert.equal(catalog.error.reason, "malformed");
		assert.deepEqual(Buffer.from(catalog.error.rawBytes ?? []), rawBytes);

		const state: TuiState = {
			tab: "model-manager",
			snapshot: null,
			blocked: catalog.error,
			conflict: null,
			message: null,
			pendingDraft: null,
			pendingImpact: null,
			failoverSummary: null,
			history: [],
		};
		const rendered = renderManagerScreen(state);
		assert.match(rendered, /Catalog blocked: malformed/);
		assert.match(rendered, /raw bytes preserved/);
		assert.doesNotMatch(rendered, /malformed release sidecar/);
	});
});

test("delete confirmation then notifies bridge with exact impact and no failover writes", async () => {
	await withTempDir(async (dir) => {
		const chainsPath = join(dir, "model-failover.json");
		const statePath = join(dir, "failover-state.json");
		const chainBytes = Buffer.from(
			JSON.stringify({ chains: { primary: [{ provider: sourceRecord.providerAlias, modelId: sourceRecord.modelId }] } }) +
			"\n",
		);
		const stateBytes = Buffer.from(
			JSON.stringify({ targets: { [`${sourceRecord.providerAlias}/${sourceRecord.modelId}`]: {} } }) +
			"\n",
		);
		await writeFile(chainsPath, chainBytes);
		await writeFile(statePath, stateBytes);
		const before = [await readFile(chainsPath), await readFile(statePath)];
		const impact = assertOk(
			await analyzeDeletionImpact(snapshot(), sourceRecord.id, {
				chainsPath,
				statePath,
			}),
		);
		assert.equal(impact.referenced, true);
		assert.equal(confirmCascade(impact, { recordId: sourceRecord.id, ack: true }).ok, true);

		let received: { recordId: string; impact: CatalogImpact } | undefined;
		const cleanup = registerModelManagerBridge({
			onDeleteRecord: async (recordId, receivedImpact) => {
				received = { recordId, impact: receivedImpact };
			},
		});
		try {
			await notifyModelManagerDelete(sourceRecord.id, impact);
		} finally {
			cleanup();
		}

		assert.equal(received?.recordId, sourceRecord.id);
		assert.strictEqual(received?.impact, impact);
		assert.deepEqual(await readFile(chainsPath), before[0]);
		assert.deepEqual(await readFile(statePath), before[1]);
	});
});

test("virtual model exists only for an explicitly registered chain and is cleaned up", () => {
	clearFailoverChains();
	const records = [sourceRecord];
	assert.equal(buildVirtualModel("release-chain", records), null);

	const cleanup = registerFailoverChain("release-chain");
	try {
		assert.deepEqual(buildVirtualModel("release-chain", records), {
			id: "mm-release-chain",
			provider: sourceRecord.providerAlias,
		});
	} finally {
		cleanup();
		clearFailoverChains();
		clearModelManagerBridge();
	}
	assert.equal(buildVirtualModel("release-chain", records), null);
});
