import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_GENERATED_MODEL_ID,
	DEFAULT_GENERATED_MODEL_NAME,
	createGeneratedModel,
	loadGeneratedConfig,
	migrateGeneratedConfig,
	saveGeneratedConfig,
	validateGeneratedConfig,
} from "../src/generated-config.ts";
import type { GeneratedFailoverConfig } from "../src/types.ts";

function legacyConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		version: 5,
		enabled: true,
		paused: true,
		models: [
			{ provider: "provider-a", id: "model-a" },
			{ provider: "provider-b", id: "model-b" },
		],
		reasoningEffort: "high",
		cooldownMinutes: 15,
		errorHandlingMode: "retry",
		maxRetries: 2,
		noProgressTimeoutSeconds: 60,
		manualRecovery: { "provider-b/model-b": "HTTP 429" },
		modelParameters: {
			"provider-a/model-a": {
				promptCacheKey: false,
				promptCacheRetention: true,
				reasoningEffort: true,
				sessionAffinity: false,
			},
		},
		modelReasoningEfforts: { "provider-b/model-b": "max" },
		...overrides,
	};
}

test("v5 migrates to one stable generated default and drops paused", () => {
	const migrated = validateGeneratedConfig(legacyConfig());
	assert.ok(migrated);
	assert.equal(migrated.version, 6);
	assert.deepEqual(
		migrated.models.map(({ id, name }) => ({ id, name })),
		[{ id: DEFAULT_GENERATED_MODEL_ID, name: DEFAULT_GENERATED_MODEL_NAME }],
	);
	const [model] = migrated.models;
	assert.equal(model.enabled, true);
	assert.deepEqual(model.chain, [
		{ provider: "provider-a", id: "model-a" },
		{ provider: "provider-b", id: "model-b" },
	]);
	assert.equal(model.reasoningEffort, "high");
	assert.equal(model.cooldownMinutes, 15);
	assert.equal(model.maxRetries, 2);
	assert.deepEqual(model.manualRecovery, { "provider-b/model-b": "HTTP 429" });
	assert.deepEqual(model.targetOverrides, {
		"provider-a/model-a": {
			modelParameters: {
				promptCacheKey: false,
				promptCacheRetention: true,
				reasoningEffort: true,
				sessionAffinity: false,
			},
		},
		"provider-b/model-b": { reasoningEffort: "max" },
	});
	assert.equal("paused" in model, false);
	assert.equal("paused" in migrated, false);
});

test("generated config is strict, secret-free, and preserves stable IDs", () => {
	const base = createGeneratedModel([{ provider: "provider-a", id: "model-a" }]);
	const config: GeneratedFailoverConfig = {
		version: 6,
		models: [{ ...base, id: "primary", name: "Primary", targetOverrides: {} }],
	};
	assert.deepEqual(
		validateGeneratedConfig({ ...config, secret: "never" }),
		config,
	);
	assert.equal(
		validateGeneratedConfig({
			...config,
			models: [{ ...config.models[0], paused: false }],
		}),
		undefined,
	);
	assert.equal(
		validateGeneratedConfig({
			...config,
			models: [{ ...config.models[0], id: "bad/id" }],
		}),
		undefined,
	);
	assert.equal(
		validateGeneratedConfig({
			...config,
			models: [{ ...config.models[0], chain: [] }],
		}),
		undefined,
	);
	assert.equal(
		validateGeneratedConfig({
			...config,
			models: [
				{
					...config.models[0],
					targetOverrides: { "provider-b/model-b": { reasoningEffort: "low" } },
				},
			],
		}),
		undefined,
	);
});

test("empty legacy chains migrate to an empty v6 config without creating a model", () => {
	const migrated = migrateGeneratedConfig(legacyConfig({ models: [] }));
	assert.deepEqual(migrated, { version: 6, models: [] });
	assert.deepEqual(validateGeneratedConfig(migrated)?.models, []);
});

test("generated config persistence uses atomic CAS and strips legacy input fields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-generated-config-"));
	const path = join(directory, "model-failover.json");
	try {
		await writeFile(path, JSON.stringify(legacyConfig()), "utf8");
		const loaded = await loadGeneratedConfig(path);
		assert.equal(loaded.kind, "loaded");
		if (loaded.kind !== "loaded") return;
		assert.equal(loaded.migrated, true);
		const saved = await saveGeneratedConfig(path, loaded.config, loaded.revision);
		assert.deepEqual(saved, { kind: "saved" });
		const persisted = JSON.parse(await readFile(path, "utf8")) as Record<
			string,
			unknown
		>;
		assert.equal(persisted.version, 6);
		assert.equal("paused" in persisted, false);
		assert.equal("manualRecovery" in persisted, false);

		await writeFile(path, "{}\n", "utf8");
		assert.deepEqual(
			await saveGeneratedConfig(path, loaded.config, loaded.revision),
			{ kind: "conflict" },
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
