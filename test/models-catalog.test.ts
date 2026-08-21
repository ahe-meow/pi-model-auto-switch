import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildFailoverCatalogModel,
	buildFailoverCatalogModels,
	loadModelsJson,
	reconcileFailoverCatalog,
} from "../src/models-catalog.ts";
import { createGeneratedModel } from "../src/generated-config.ts";

function model(id: string, enabled = true) {
	return {
		...createGeneratedModel([{ provider: "provider-a", id: "model-a" }]),
		id,
		name: id.toUpperCase(),
		enabled,
	};
}

test("catalog metadata uses the safe minimum across a chain", () => {
	const first = model("primary");
	first.chain.push({ provider: "provider-b", id: "model-b" });
	assert.deepEqual(
		buildFailoverCatalogModel(first, [
			{
				ref: { provider: "provider-a", id: "model-a" },
				input: ["text", "image"],
				reasoning: true,
				thinkingLevelMap: { low: "low", medium: "medium" },
				contextWindow: 200_000,
				maxTokens: 32_000,
			},
			{
				ref: { provider: "provider-b", id: "model-b" },
				input: ["text"],
				reasoning: true,
				thinkingLevelMap: { low: "balanced", medium: null },
				contextWindow: 100_000,
				maxTokens: 16_000,
			},
		]),
		{
			id: "primary",
			name: "PRIMARY",
			reasoning: true,
			input: ["text"],
			contextWindow: 100_000,
			maxTokens: 16_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			thinkingLevelMap: { off: "none", low: "low", high: "high" },
		},
	);
});

test("disabled generated models are omitted from the managed catalog", () => {
	const config = {
		version: 6 as const,
		models: [model("enabled"), model("disabled", false)],
	};
	assert.deepEqual(
		buildFailoverCatalogModels(config).map((entry) => entry.id),
		["enabled"],
	);
});

test("catalog reconciliation preserves unrelated providers and credentials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-catalog-"));
	const path = join(directory, "models.json");
	try {
		const original = {
			custom: "keep",
			providers: {
				unrelated: { apiKey: "secret-that-must-survive", models: [{ id: "real" }] },
				failover: { apiKey: "old-managed-secret", models: [{ id: "stale" }] },
			},
		};
		await writeFile(path, `${JSON.stringify(original)}\n`, "utf8");
		const loaded = await loadModelsJson(path);
		assert.equal(loaded.kind, "loaded");
		if (loaded.kind !== "loaded") return;
		const result = await reconcileFailoverCatalog(
			path,
			buildFailoverCatalogModels({ version: 6, models: [model("primary")] }),
			loaded.revision,
		);
		assert.deepEqual(result, { kind: "saved" });
		const persisted = JSON.parse(await readFile(path, "utf8")) as typeof original;
		assert.equal(persisted.custom, "keep");
		assert.deepEqual(persisted.providers.unrelated, original.providers.unrelated);
		assert.deepEqual(persisted.providers.failover, {
			name: "Failover",
			models: [
				{
					id: "primary",
					name: "PRIMARY",
					reasoning: false,
					input: ["text"],
					contextWindow: 128000,
					maxTokens: 16384,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});

		await writeFile(path, `${JSON.stringify(persisted)}\n`, "utf8");
		assert.deepEqual(await reconcileFailoverCatalog(path, [], loaded.revision), {
			kind: "conflict",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing models.json can be created without an unrelated provider block", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-catalog-"));
	const path = join(directory, "models.json");
	try {
		const missing = await loadModelsJson(path);
		assert.equal(missing.kind, "missing");
		if (missing.kind !== "missing") return;
		assert.deepEqual(await reconcileFailoverCatalog(path, [], missing.revision), {
			kind: "saved",
		});
		const persisted = JSON.parse(await readFile(path, "utf8")) as {
			providers: Record<string, unknown>;
		};
		assert.deepEqual(persisted.providers.failover, {
			name: "Failover",
			models: [],
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
