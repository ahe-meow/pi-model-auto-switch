import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_GENERATED_MODEL_ID,
	DEFAULT_GENERATED_MODEL_NAME,
	copyGeneratedConfigV8,
	createGeneratedConfigV8,
	createGeneratedModel,
	extractLegacyTargetCandidates,
	loadGeneratedConfig,
	loadGeneratedConfigV8,
	migrateGeneratedConfig,
	saveGeneratedConfig,
	saveGeneratedConfigV8,
	stripLegacyToV8,
	validateGeneratedConfig,
	validateGeneratedConfigV8,
} from "../src/generated-config.ts";
import type {
	GeneratedFailoverConfig,
	GeneratedFailoverConfigV8,
	GeneratedFailoverModel,
	GeneratedFailoverModelV8,
	ModelParameterToggles,
} from "../src/types.ts";

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
	assert.equal(migrated.version, 7);
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
	assert.equal("cooldownMinutes" in model, false);
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
		version: 7,
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

test("v6 generated config migrates to v7 and preserves every other field", () => {
	const expected = {
		...createGeneratedModel([{ provider: "provider-a", id: "model-a" }]),
		id: "primary",
		name: "Primary",
		reasoningEffort: "max" as const,
		errorHandlingMode: "retry" as const,
		maxRetries: 3,
		noProgressTimeoutSeconds: 120,
		modelParameters: {
			promptCacheKey: false,
			promptCacheRetention: true,
			reasoningEffort: false,
			sessionAffinity: true,
		},
		targetOverrides: {
			"provider-a/model-a": { reasoningEffort: "low" as const },
		},
		manualRecovery: { "provider-a/model-a": "HTTP 401" },
	};
	const migrated = validateGeneratedConfig({
		version: 6,
		models: [{ ...expected, cooldownMinutes: 45 }],
	});
	assert.ok(migrated);
	assert.equal(migrated.version, 7);
	assert.deepEqual(migrated.models, [expected]);
	assert.equal("cooldownMinutes" in migrated.models[0]!, false);
});

test("v6 and v7 generated configs enforce version-specific cooldown fields", () => {
	const model = createGeneratedModel([
		{ provider: "provider-a", id: "model-a" },
	]);
	assert.equal(
		validateGeneratedConfig({
			version: 6,
			models: [{ ...model, cooldownMinutes: -1 }],
		}),
		undefined,
	);
	assert.equal(
		validateGeneratedConfig({
			version: 6,
			models: [{ ...model, cooldownMinutes: 30, unknown: true }],
		}),
		undefined,
	);
	assert.equal(
		validateGeneratedConfig({ version: 6, models: [model] }),
		undefined,
	);
	assert.equal(
		validateGeneratedConfig({
			version: 7,
			models: [{ ...model, cooldownMinutes: 30 }],
		}),
		undefined,
	);
});

test("legacy v1-v5 configs migrate directly to v7 without cooldownMinutes", () => {
	for (const version of [1, 2, 3, 4, 5]) {
		const migrated = validateGeneratedConfig(legacyConfig({ version }));
		assert.ok(migrated, `version ${version}`);
		assert.equal(migrated.version, 7);
		assert.equal("cooldownMinutes" in migrated.models[0]!, false);
	}
});

test("empty legacy and v6 configs migrate to empty v7 configs", () => {
	for (const input of [
		legacyConfig({ models: [] }),
		{ version: 6, models: [] },
	]) {
		const migrated = migrateGeneratedConfig(input);
		assert.deepEqual(migrated, { version: 7, models: [] });
		assert.deepEqual(validateGeneratedConfig(migrated)?.models, []);
	}
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
		assert.equal(persisted.version, 7);
		assert.equal("paused" in persisted, false);
		assert.equal("manualRecovery" in persisted, false);
		assert.equal(JSON.stringify(persisted).includes("cooldownMinutes"), false);

		await writeFile(path, "{}\n", "utf8");
		assert.deepEqual(
			await saveGeneratedConfig(path, loaded.config, loaded.revision),
			{ kind: "conflict" },
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

const togglesOn: ModelParameterToggles = {
	promptCacheKey: true,
	promptCacheRetention: true,
	reasoningEffort: true,
	sessionAffinity: true,
};

const togglesOff: ModelParameterToggles = {
	promptCacheKey: false,
	promptCacheRetention: false,
	reasoningEffort: false,
	sessionAffinity: false,
};

function v8Model(
	overrides: Partial<GeneratedFailoverModelV8> = {},
): GeneratedFailoverModelV8 {
	return {
		id: "primary",
		name: "Primary",
		enabled: true,
		chain: [{ provider: "provider-a", id: "model-a" }],
		...overrides,
	};
}

function legacyGeneratedModel(
	id: string,
	name: string,
	chain: GeneratedFailoverModel["chain"],
	overrides: Partial<GeneratedFailoverModel> = {},
): GeneratedFailoverModel {
	return {
		...createGeneratedModel(chain),
		id,
		name,
		...overrides,
	};
}

test("v8 create, copy, and validation preserve exact chain-only identity", () => {
	const sourceModels = [
		v8Model({
			chain: [
				{ provider: "provider-a", id: "model-a" },
				{ provider: "provider-b", id: "model-b" },
			],
		}),
		v8Model({ id: "disabled", name: "Disabled", enabled: false, chain: [] }),
	];
	const config = createGeneratedConfigV8(sourceModels);
	assert.deepEqual(config, {
		version: 8,
		models: [
			{
				id: "primary",
				name: "Primary",
				enabled: true,
				chain: [
					{ provider: "provider-a", id: "model-a" },
					{ provider: "provider-b", id: "model-b" },
				],
			},
			{ id: "disabled", name: "Disabled", enabled: false, chain: [] },
		],
	});
	assert.deepEqual(validateGeneratedConfigV8(config), config);

	sourceModels[0]!.name = "Changed source";
	sourceModels[0]!.chain[0]!.id = "changed-source";
	assert.equal(config.models[0]!.name, "Primary");
	assert.equal(config.models[0]!.chain[0]!.id, "model-a");
	const copied = copyGeneratedConfigV8(config);
	copied.models[0]!.name = "Changed copy";
	copied.models[0]!.chain[0]!.id = "changed-copy";
	assert.equal(config.models[0]!.name, "Primary");
	assert.equal(config.models[0]!.chain[0]!.id, "model-a");

	const invalid: unknown[] = [
		{ ...config, secret: "never" },
		{ version: 8, models: [{ ...v8Model(), maxRetries: 1 }] },
		{
			version: 8,
			models: [
				v8Model({
					chain: [{ provider: "provider-a", id: "model-a", extra: true } as never],
				}),
			],
		},
		{ version: 8, models: [v8Model({ chain: [] })] },
		{
			version: 8,
			models: [v8Model({ chain: [{ provider: "failover", id: "recursive" }] })],
		},
		{
			version: 8,
			models: [v8Model(), v8Model({ name: "Duplicate ID" })],
		},
		{
			version: 8,
			models: [
				v8Model({
					chain: [
						{ provider: "provider-a", id: "model-a" },
						{ provider: "provider-a", id: "model-a" },
					],
				}),
			],
		},
	];
	for (const value of invalid)
		assert.equal(validateGeneratedConfigV8(value), undefined);
});

test("stripLegacyToV8 removes all policy fields and preserves model and chain order", () => {
	const legacy: GeneratedFailoverConfig = {
		version: 7,
		models: [
			legacyGeneratedModel(
				"primary",
				"Primary",
				[
					{ provider: "provider-b", id: "model-b" },
					{ provider: "provider-a", id: "model-a" },
				],
				{
					reasoningEffort: "max",
					errorHandlingMode: "retry",
					manualRecovery: { "provider-a/model-a": "HTTP 401" },
				},
			),
			legacyGeneratedModel("disabled", "Disabled", [], { enabled: false }),
		],
	};
	const stripped = stripLegacyToV8(legacy);
	assert.ok(stripped);
	assert.deepEqual(stripped, {
		version: 8,
		models: [
			{
				id: "primary",
				name: "Primary",
				enabled: true,
				chain: [
					{ provider: "provider-b", id: "model-b" },
					{ provider: "provider-a", id: "model-a" },
				],
			},
			{ id: "disabled", name: "Disabled", enabled: false, chain: [] },
		],
	});
	assert.equal(JSON.stringify(stripped).includes("reasoningEffort"), false);
	legacy.models[0]!.chain[0]!.id = "changed";
	assert.equal(stripped.models[0]!.chain[0]!.id, "model-b");
});

test("legacy candidates preserve occurrence order, effective settings, and manual data", () => {
	const targetA = { provider: "provider-a", id: "model-a" };
	const targetB = { provider: "provider-b", id: "model-b" };
	const legacy: GeneratedFailoverConfig = {
		version: 7,
		models: [
			legacyGeneratedModel("first", "First", [targetA, targetB], {
				reasoningEffort: "high",
				errorHandlingMode: "retry",
				maxRetries: 2,
				noProgressTimeoutSeconds: 60,
				modelParameters: togglesOn,
				targetOverrides: {
					"provider-a/model-a": {
						reasoningEffort: "low",
						modelParameters: togglesOff,
					},
				},
				manualRecovery: { "provider-b/model-b": "HTTP 429" },
			}),
			legacyGeneratedModel("second", "Second", [targetA], {
				enabled: false,
				reasoningEffort: "max",
				errorHandlingMode: "switch",
				maxRetries: 4,
				noProgressTimeoutSeconds: 120,
				modelParameters: togglesOn,
				manualRecovery: { "provider-a/model-a": "HTTP 401" },
			}),
			legacyGeneratedModel("third", "Third", [targetA], {
				reasoningEffort: "medium",
				errorHandlingMode: "smart",
				maxRetries: 1,
				noProgressTimeoutSeconds: 90,
				modelParameters: togglesOff,
				manualRecovery: { "provider-a/model-a": "HTTP 403" },
			}),
		],
	};
	const candidates = extractLegacyTargetCandidates(legacy);
	assert.deepEqual(
		candidates.map((candidate) => ({
			target: candidate.target,
			source: candidate.source,
			manualRecoveryReason: candidate.manualRecoveryReason,
		})),
		[
			{
				target: targetA,
				source: 'generated model "First" (first), chain position 1',
				manualRecoveryReason: undefined,
			},
			{
				target: targetB,
				source: 'generated model "First" (first), chain position 2',
				manualRecoveryReason: "HTTP 429",
			},
			{
				target: targetA,
				source: 'generated model "Second" (second), chain position 1',
				manualRecoveryReason: "HTTP 401",
			},
			{
				target: targetA,
				source: 'generated model "Third" (third), chain position 1',
				manualRecoveryReason: "HTTP 403",
			},
		],
	);
	assert.deepEqual(candidates[0]!.settings, {
		enabled: true,
		errorHandlingMode: "retry",
		maxRetries: 2,
		noProgressTimeoutSeconds: 60,
		reasoningEffort: "low",
		modelParameters: togglesOff,
	});
	assert.deepEqual(candidates[1]!.settings, {
		enabled: true,
		errorHandlingMode: "retry",
		maxRetries: 2,
		noProgressTimeoutSeconds: 60,
		reasoningEffort: "high",
		modelParameters: togglesOn,
	});
	assert.deepEqual(candidates[2]!.settings, {
		enabled: true,
		errorHandlingMode: "switch",
		maxRetries: 4,
		noProgressTimeoutSeconds: 120,
		reasoningEffort: "max",
		modelParameters: togglesOn,
	});
	assert.equal(Object.hasOwn(candidates[0]!, "manualRecoveryReason"), false);
});

test("v8 loader classifies supported v1-v7 legacy sources without writing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-v8-legacy-load-"));
	const path = join(directory, "model-failover.json");
	try {
		const missing = await loadGeneratedConfigV8(path);
		assert.equal(missing.kind, "missing");
		for (const version of [1, 2, 3, 4, 5] as const) {
			const bytes = `${JSON.stringify(legacyConfig({ version }), null, 2)}\n`;
			await writeFile(path, bytes, "utf8");
			const loaded = await loadGeneratedConfigV8(path);
			assert.equal(loaded.kind, "legacy", `version ${String(version)}`);
			if (loaded.kind !== "legacy") continue;
			assert.equal(loaded.sourceVersion, version);
			assert.equal(loaded.config.version, 7);
			assert.equal(loaded.v8.version, 8);
			assert.equal(loaded.candidates.length, 2);
			assert.equal(await readFile(path, "utf8"), bytes);
		}

		const generated = legacyGeneratedModel("primary", "Primary", [
			{ provider: "provider-a", id: "model-a" },
		]);
		for (const [version, value] of [
			[6, { version: 6, models: [{ ...generated, cooldownMinutes: 30 }] }],
			[7, { version: 7, models: [generated] }],
		] as const) {
			const bytes = JSON.stringify(value);
			await writeFile(path, bytes, "utf8");
			const loaded = await loadGeneratedConfigV8(path);
			assert.equal(loaded.kind, "legacy");
			if (loaded.kind !== "legacy") continue;
			assert.equal(loaded.sourceVersion, version);
			assert.deepEqual(loaded.v8.models, [
				{
					id: "primary",
					name: "Primary",
					enabled: true,
					chain: [{ provider: "provider-a", id: "model-a" }],
				},
			]);
			assert.equal(await readFile(path, "utf8"), bytes);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("v8 loader blocks recursive legacy targets and preserves v5/v7 bytes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-v8-recursive-load-"));
	const path = join(directory, "model-failover.json");
	const recursiveTarget = { provider: "failover", id: "recursive" };
	const recursiveV7: GeneratedFailoverConfig = {
		version: 7,
		models: [legacyGeneratedModel("primary", "Primary", [recursiveTarget])],
	};
	try {
		assert.equal(stripLegacyToV8(recursiveV7), undefined);
		for (const [version, value] of [
			[5, legacyConfig({ models: [recursiveTarget] })],
			[7, recursiveV7],
		] as const) {
			assert.ok(
				validateGeneratedConfig(value),
				`legacy version ${String(version)}`,
			);
			const bytes = `${JSON.stringify(value, null, "\t")}\n`;
			await writeFile(path, bytes, "utf8");
			const loaded = await loadGeneratedConfigV8(path);
			assert.equal(loaded.kind, "blocked", `version ${String(version)}`);
			if (loaded.kind !== "blocked") continue;
			assert.equal(loaded.reason, "invalid");
			assert.equal(Object.hasOwn(loaded, "config"), false);
			assert.equal(Object.hasOwn(loaded, "v8"), false);
			assert.equal(Object.hasOwn(loaded, "candidates"), false);
			assert.equal(await readFile(path, "utf8"), bytes);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("v8 loader blocks future, malformed, and invalid bytes without changing them", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-v8-blocked-load-"));
	const path = join(directory, "model-failover.json");
	try {
		const cases = [
			{
				bytes: '{"version":9,"models":[],"future":"preserve"}\n',
				reason: "future-version",
			},
			{ bytes: '{"version":', reason: "malformed" },
			{
				bytes: JSON.stringify({
					version: 8,
					models: [{ ...v8Model(), maxRetries: 2 }],
				}),
				reason: "invalid",
			},
		] as const;
		for (const entry of cases) {
			await writeFile(path, entry.bytes, "utf8");
			const loaded = await loadGeneratedConfigV8(path);
			assert.equal(loaded.kind, "blocked");
			if (loaded.kind === "blocked") assert.equal(loaded.reason, entry.reason);
			assert.equal(await readFile(path, "utf8"), entry.bytes);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("v8 save validates, round trips, and detects source conflicts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-v8-save-"));
	const path = join(directory, "model-failover.json");
	try {
		const missing = await loadGeneratedConfigV8(path);
		assert.equal(missing.kind, "missing");
		if (missing.kind !== "missing") return;
		const config: GeneratedFailoverConfigV8 = createGeneratedConfigV8([
			v8Model(),
			v8Model({ id: "disabled", name: "Disabled", enabled: false, chain: [] }),
		]);
		assert.deepEqual(
			await saveGeneratedConfigV8(path, config, missing.revision),
			{ kind: "saved" },
		);
		const loaded = await loadGeneratedConfigV8(path);
		assert.equal(loaded.kind, "loaded-v8");
		if (loaded.kind !== "loaded-v8") return;
		assert.deepEqual(loaded.config, config);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")) as unknown, config);
		await assert.rejects(
			saveGeneratedConfigV8(
				path,
				{ ...config, secret: "never" } as GeneratedFailoverConfigV8,
				loaded.revision,
			),
			/invalid version 8 generated config/,
		);

		const replacement = '{"external":true}\n';
		await writeFile(path, replacement, "utf8");
		assert.deepEqual(await saveGeneratedConfigV8(path, config, loaded.revision), {
			kind: "conflict",
		});
		assert.equal(await readFile(path, "utf8"), replacement);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
