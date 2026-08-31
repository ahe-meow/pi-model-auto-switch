import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	analyzeDeletionImpact,
	confirmCascade,
	type CatalogImpact,
} from "../src/model-manager-impact.ts";
import type { ModelManagerCatalogSnapshot } from "../src/model-manager-catalog.ts";
import type {
	ModelManagerRecord,
	ModelManagerResult,
} from "../src/model-manager-types.ts";

const record: ModelManagerRecord = {
	id: "record-target",
	providerAlias: "provider-a",
	providerName: "Provider A",
	modelId: "target-model",
};

function makeSnapshot(records: readonly ModelManagerRecord[] = [record]): ModelManagerCatalogSnapshot {
	return {
		records: [...records],
		byId: new Map(records.map((entry) => [entry.id, entry])),
		providers: [],
		failoverUntouched: true,
	};
}

async function makeFixture(): Promise<{
	dir: string;
	chainsPath: string;
	statePath: string;
	chainsBytes: Buffer;
	stateBytes: Buffer;
}> {
	const dir = await mkdtemp(join(tmpdir(), "model-manager-impact-"));
	const chainsPath = join(dir, "chains-v8.json");
	const statePath = join(dir, "failover-state.json");
	const chainsValue = {
		version: 8,
		models: [
			{
				id: "mm-primary",
				name: "Primary",
				enabled: true,
				chain: [{ provider: "provider-a", id: "target-model" }],
			},
			{
				id: "plain-chain",
				name: "Unrelated",
				enabled: true,
				chain: [{ provider: "provider-b", id: "other-model" }],
			},
		],
		entries: [
			{
				id: "mm-legacy",
				chain: [{ provider: "provider-a", id: "target-model" }],
			},
		],
	};
	const stateValue = {
		version: 1,
		targets: {
			"provider-a/target-model": {
			settings: { enabled: true },
				runtime: { consecutiveFailures: 0 },
			},
		},
		registrations: {
			"/agent/project": {
				targets: ["provider-a/target-model"],
				scopeKeys: ["scope-provider-a"],
			},
		},
		scopes: {
			"scope-provider-a": {
				targets: ["provider-a/target-model"],
			},
		},
	};
	const chainsBytes = Buffer.from(`${JSON.stringify(chainsValue, null, 2)}\n`, "utf8");
	const stateBytes = Buffer.from(`${JSON.stringify(stateValue, null, 2)}\n`, "utf8");
	await writeFile(chainsPath, chainsBytes);
	await writeFile(statePath, stateBytes);
	return { dir, chainsPath, statePath, chainsBytes, stateBytes };
}

async function withFixture(
	run: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
): Promise<void> {
	const fixture = await makeFixture();
	try {
		await run(fixture);
	} finally {
		await rm(fixture.dir, { recursive: true, force: true });
	}
}

function assertImpact(
	result: ModelManagerResult<CatalogImpact>,
): CatalogImpact {
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("expected deletion impact");
	return result.value;
}

function assertError<T>(
	result: ModelManagerResult<T>,
	code: string,
): void {
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal("code" in result.error, true);
	if (!("code" in result.error)) return;
	assert.equal(result.error.code, code);
}

test("analyzeDeletionImpact lists chain model entries", async () => {
	await withFixture(async ({ chainsPath, statePath }) => {
		const impact = assertImpact(
			await analyzeDeletionImpact(makeSnapshot(), record.id, {
				chainsPath,
				statePath,
			}),
		);

		assert.deepEqual(impact.chains.filter(({ kind }) => kind === "model-entry"), [
			{ file: chainsPath, chainId: "mm-legacy", kind: "model-entry" },
			{ file: chainsPath, chainId: "mm-primary", kind: "model-entry" },
		]);
	});
});

test("analyzeDeletionImpact lists generated blocks with mm prefix", async () => {
	await withFixture(async ({ chainsPath, statePath }) => {
		const impact = assertImpact(
			await analyzeDeletionImpact(makeSnapshot(), record.id, {
				chainsPath,
				statePath,
			}),
		);

		assert.deepEqual(impact.chains.filter(({ kind }) => kind === "generated-block"), [
			{ file: chainsPath, chainId: "mm-legacy", kind: "generated-block" },
			{ file: chainsPath, chainId: "mm-primary", kind: "generated-block" },
		]);
	});
});

test("analyzeDeletionImpact lists active state references", async () => {
	await withFixture(async ({ chainsPath, statePath }) => {
		const impact = assertImpact(
			await analyzeDeletionImpact(makeSnapshot(), record.id, {
				chainsPath,
				statePath,
			}),
		);

		assert.deepEqual(impact.state, [
			{ file: statePath, key: "registrations./agent/project.targets[0]" },
			{ file: statePath, key: "scopes.scope-provider-a.targets[0]" },
			{ file: statePath, key: "targets.provider-a/target-model" },
		]);
	});
});

test("analyzeDeletionImpact unreferenced record reports referenced false", async () => {
	await withFixture(async ({ chainsPath, statePath }) => {
		const missingFromFiles: ModelManagerRecord = {
			id: "record-unreferenced",
			providerAlias: "provider-missing",
			providerName: "Provider Missing",
			modelId: "missing-model",
		};
		const impact = assertImpact(
			await analyzeDeletionImpact(makeSnapshot([missingFromFiles]), missingFromFiles.id, {
				chainsPath,
				statePath,
			}),
		);

		assert.deepEqual(impact, {
			recordId: missingFromFiles.id,
			chains: [],
			state: [],
			referenced: false,
		});
	});
});

test("analyzeDeletionImpact supports array and wrapped v8 chain shapes", async () => {
	await withFixture(async ({ chainsPath, statePath }) => {
		await writeFile(
			chainsPath,
			JSON.stringify([
				{ id: "mm-array", chain: [{ provider: "provider-a", id: "target-model" }] },
			]),
			"utf8",
		);
		const impact = assertImpact(
			await analyzeDeletionImpact(makeSnapshot(), record.id, {
				chainsPath,
				statePath,
			}),
		);

		assert.deepEqual(impact.chains.filter(({ chainId }) => chainId === "mm-array"), [
			{ file: chainsPath, chainId: "mm-array", kind: "generated-block" },
			{ file: chainsPath, chainId: "mm-array", kind: "model-entry" },
		]);
	});
});

test("analyzeDeletionImpact never writes files or source implementation", async () => {
	await withFixture(async ({ chainsPath, statePath, chainsBytes, stateBytes }) => {
		const sourcePath = new URL("../src/model-manager-impact.ts", import.meta.url);
		const implementation = await readFile(sourcePath, "utf8");
		const before = await Promise.all([readFile(chainsPath), readFile(statePath)]);

		assertImpact(
			await analyzeDeletionImpact(makeSnapshot(), record.id, {
				chainsPath,
				statePath,
			}),
		);

		const after = await Promise.all([readFile(chainsPath), readFile(statePath)]);
		assert.deepEqual(before[0], chainsBytes);
		assert.deepEqual(before[1], stateBytes);
		assert.deepEqual(after, before);
		assert.equal(/\b(?:writeFile|appendFile)\b/.test(implementation), false);
	});
});

test("analyzeDeletionImpact returns a safe error for malformed reads", async () => {
	await withFixture(async ({ chainsPath, statePath }) => {
		const secret = "malformed-private-content";
		await writeFile(chainsPath, `{ "secret": "${secret}"`, "utf8");
		const result = await analyzeDeletionImpact(makeSnapshot(), record.id, {
			chainsPath,
			statePath,
		});

		assertError(result, "unreadable-failover-read-only");
		assert.equal(JSON.stringify(result).includes(secret), false);
	});
});

test("analyzeDeletionImpact rejects a record missing from the snapshot", async () => {
	await withFixture(async ({ chainsPath, statePath }) => {
		const result = await analyzeDeletionImpact(makeSnapshot(), "record-missing", {
			chainsPath,
			statePath,
		});

		assertError(result, "record-not-found");
	});
});

test("confirmCascade confirms only an acknowledged matching record", () => {
	const impact: CatalogImpact = {
		recordId: record.id,
		chains: [],
		state: [],
		referenced: false,
	};

	assert.deepEqual(confirmCascade(impact, { recordId: record.id, ack: true }), {
		ok: true,
		value: "confirmed",
	});
});

test("confirmCascade rejects mismatched record id without leaking it", () => {
	const impact: CatalogImpact = {
		recordId: record.id,
		chains: [],
		state: [],
		referenced: true,
	};
	const unrelated = "unrelated-confirmation-secret";
	const result = confirmCascade(impact, { recordId: unrelated, ack: true });

	assertError(result, "cascade-not-confirmed");
	assert.equal(JSON.stringify(result).includes(unrelated), false);
});

test("confirmCascade rejects missing ack without leaking unrelated values", () => {
	const impact: CatalogImpact = {
		recordId: record.id,
		chains: [],
		state: [],
		referenced: true,
	};
	const result = confirmCascade(impact, {
		recordId: record.id,
		ack: false,
	});

	assertError(result, "cascade-not-confirmed");
	assert.equal(JSON.stringify(result).includes("target-model"), false);
});
