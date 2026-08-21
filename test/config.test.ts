import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type ConfigLoadResult,
	createDefaultConfig,
	loadConfig,
	migrateConfig,
	saveConfig,
	validateConfig,
	type ConfigSourceRevision,
} from "../src/config.ts";
import { resolveReasoningEffort } from "../src/config.ts";
import type { ModelRef } from "../src/types.ts";

test("config load results distinguish missing files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	try {
		const result: ConfigLoadResult = await loadConfig(
			join(directory, "missing.json"),
		);
		assert.equal(result.kind, "missing");
		if (result.kind === "missing") {
			assert.deepEqual(result.revision, {
				kind: "absent",
			} satisfies ConfigSourceRevision);
			assert.equal(result.bytes, undefined);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("config defaults and validation keep only the versioned secret-free shape", () => {
	assert.deepEqual(createDefaultConfig(), {
		version: 5,
		enabled: true,
		paused: false,
		models: [],
		reasoningEffort: "medium",
		cooldownMinutes: 30,
		errorHandlingMode: "smart",
		maxRetries: 1,
		noProgressTimeoutSeconds: 90,
		manualRecovery: {},
		modelParameters: {},
		modelReasoningEfforts: {},
	});

	const config = validateConfig({
		version: 2,
		enabled: true,
		paused: true,
		models: [{ provider: "openai", id: "gpt", apiKey: "must-not-persist" }],
		noProgressTimeoutSeconds: 0,
		manualRecovery: { "openai/gpt": "HTTP 401" },
		secret: "must-not-persist",
	});
	assert.deepEqual(config, {
		version: 5,
		enabled: true,
		paused: true,
		models: [{ provider: "openai", id: "gpt" }],
		noProgressTimeoutSeconds: 0,
		reasoningEffort: "medium",
		cooldownMinutes: 30,
		errorHandlingMode: "smart",
		maxRetries: 1,
		manualRecovery: { "openai/gpt": "HTTP 401" },
		modelParameters: {},
		modelReasoningEfforts: {},
	});
	assert.equal(
		validateConfig({ ...config!, noProgressTimeoutSeconds: 14 }),
		undefined,
	);
	assert.equal(
		validateConfig({ ...config!, noProgressTimeoutSeconds: 901 }),
		undefined,
	);
	assert.equal(
		validateConfig({ ...config!, noProgressTimeoutSeconds: 15.5 }),
		undefined,
	);
	assert.equal(
		validateConfig({
			...config!,
			models: [
				{ provider: "openai", id: "gpt" },
				{ provider: "openai", id: "gpt" },
			],
		}),
		undefined,
	);
	assert.equal(
		validateConfig({ ...config!, manualRecovery: { "openai/gpt": "" } }),
		undefined,
	);
});

test("version 1 config migrates to persistent pause and recovery fields", () => {
	assert.deepEqual(
		migrateConfig({
			version: 1,
			enabled: true,
			models: [{ provider: "openai", id: "gpt" }],
			noProgressTimeoutSeconds: 90,
		}),
		{
			version: 5,
			enabled: true,
			models: [{ provider: "openai", id: "gpt" }],
			noProgressTimeoutSeconds: 90,
			paused: false,
			manualRecovery: {},
			cooldownMinutes: 30,
			errorHandlingMode: "smart",
			maxRetries: 1,
			modelParameters: {},
			modelReasoningEfforts: {},
		},
	);
	assert.deepEqual(
		validateConfig({
			version: 1,
			enabled: true,
			models: [],
			noProgressTimeoutSeconds: 90,
		}),
		createDefaultConfig(),
	);
});

test("config writes atomically and reloads persistent status", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	const path = join(directory, "nested", "model-failover.json");
	try {
		const config = {
			version: 5 as const,
			enabled: true,
			paused: true,
			models: [{ provider: "anthropic", id: "claude" }],
			reasoningEffort: "medium" as const,
			cooldownMinutes: 30,
			errorHandlingMode: "smart" as const,
			maxRetries: 1,
			noProgressTimeoutSeconds: 90,
			manualRecovery: { "anthropic/claude": "HTTP 404" },
			modelParameters: {},
			modelReasoningEfforts: {},
		};
		const missing = await loadConfig(path);
		assert.equal(missing.kind, "missing");
		assert.equal(
			(
				await saveConfig(
					path,
					config,
					missing.kind === "missing" ? missing.revision : assert.fail(),
				)
			).kind,
			"saved",
		);
		const loaded = await loadConfig(path);
		assert.equal(loaded.kind, "loaded");
		if (loaded.kind !== "loaded") return;
		assert.equal(loaded.migrated, false);
		assert.deepEqual(loaded.config, config);
		assert.match(await readFile(path, "utf8"), /"manualRecovery"/);
		assert.equal((await stat(path)).mode & 0o077, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent first-run saves serialize and conflict instead of overwriting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	const path = join(directory, "model-failover.json");
	try {
		const missing = await loadConfig(path);
		assert.equal(missing.kind, "missing");
		if (missing.kind !== "missing") return;
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				saveConfig(path, createDefaultConfig(), missing.revision),
			),
		);
		assert.equal(results.filter((result) => result.kind === "saved").length, 1);
		assert.equal(
			results.filter((result) => result.kind === "conflict").length,
			7,
		);
		assert.equal((await loadConfig(path)).kind, "loaded");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("loading supported versions reports migration and preserves model order", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	const path = join(directory, "model-failover.json");
	try {
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				enabled: false,
				models: [
					{ provider: "provider-b", id: "model-b" },
					{ provider: "provider-a", id: "model-a" },
				],
				noProgressTimeoutSeconds: 90,
			}),
			"utf8",
		);
		const loaded = await loadConfig(path);
		assert.equal(loaded.kind, "loaded");
		if (loaded.kind !== "loaded") return;
		assert.equal(loaded.migrated, true);
		assert.deepEqual(loaded.config.models, [
			{ provider: "provider-b", id: "model-b" },
			{ provider: "provider-a", id: "model-a" },
		]);
		assert.equal(loaded.config.enabled, false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("blocked configs are classified and preserved byte-for-byte", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	try {
		for (const fixture of [
			{ name: "malformed", text: "{broken", reason: "malformed" },
			{ name: "invalid", text: JSON.stringify({ version: 3 }), reason: "invalid" },
			{
				name: "future",
				text: JSON.stringify({ version: 6 }),
				reason: "future-version",
			},
		] as const) {
			await t.test(fixture.name, async () => {
				const path = join(directory, `${fixture.name}.json`);
				await writeFile(path, fixture.text, "utf8");
				const before = await readFile(path);
				const loaded = await loadConfig(path);
				assert.equal(loaded.kind, "blocked");
				if (loaded.kind === "blocked")
					assert.equal(loaded.failure.reason, fixture.reason);
				assert.deepEqual(await readFile(path), before);
			});
		}
		const unreadable = await loadConfig(directory);
		assert.equal(unreadable.kind, "blocked");
		if (unreadable.kind === "blocked")
			assert.equal(unreadable.failure.reason, "unreadable");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("first-run compare-and-swap preserves a concurrently created target", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	const path = join(directory, "model-failover.json");
	try {
		const missing = await loadConfig(path);
		assert.equal(missing.kind, "missing");
		if (missing.kind !== "missing") return;
		const newer = '{"version":99,"owner":"newer"}\n';
		await writeFile(path, newer, "utf8");
		assert.equal(
			(await saveConfig(path, createDefaultConfig(), missing.revision)).kind,
			"conflict",
		);
		assert.equal(await readFile(path, "utf8"), newer);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("migration compare-and-swap preserves a concurrently replaced target", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	const path = join(directory, "model-failover.json");
	try {
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				enabled: true,
				models: [{ provider: "provider-a", id: "model-a" }],
				noProgressTimeoutSeconds: 90,
			}),
			"utf8",
		);
		const loaded = await loadConfig(path);
		assert.equal(loaded.kind, "loaded");
		if (loaded.kind !== "loaded") return;
		const newer = '{"version":5,"owner":"newer"}\n';
		await writeFile(path, newer, "utf8");
		assert.equal(
			(await saveConfig(path, loaded.config, loaded.revision)).kind,
			"conflict",
		);
		assert.equal(await readFile(path, "utf8"), newer);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a live config lock times out without being deleted", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	const path = join(directory, "model-failover.json");
	const lockPath = `${path}.lock`;
	try {
		await writeFile(
			lockPath,
			JSON.stringify({
				pid: process.pid,
				createdAt: 0,
				owner: "live-owner",
			}),
			"utf8",
		);
		await assert.rejects(
			saveConfig(path, createDefaultConfig(), { kind: "absent" }),
			/Timed out waiting for config lock/,
		);
		assert.equal(
			JSON.parse(await readFile(lockPath, "utf8")).owner,
			"live-owner",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an abandoned config lock fails closed and remains for manual review", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	const path = join(directory, "model-failover.json");
	const lockPath = `${path}.lock`;
	try {
		await writeFile(
			lockPath,
			JSON.stringify({
				pid: 2_147_483_647,
				createdAt: 0,
				owner: "abandoned-owner",
			}),
			"utf8",
		);
		await assert.rejects(
			saveConfig(path, createDefaultConfig(), { kind: "absent" }),
			/Verify no Pi process is writing, then remove the stale lock/,
		);
		assert.equal(
			JSON.parse(await readFile(lockPath, "utf8")).owner,
			"abandoned-owner",
		);
		assert.equal((await loadConfig(path)).kind, "missing");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("version 3 config migrates through version 4 to version 5", () => {
	const v3 = {
		version: 3,
		enabled: true,
		paused: false,
		models: [{ provider: "openai", id: "gpt" }],
		reasoningEffort: "high",
		cooldownMinutes: 15,
		errorHandlingMode: "retry",
		maxRetries: 2,
		noProgressTimeoutSeconds: 60,
		manualRecovery: { "openai/gpt": "HTTP 429" },
	};
	const migrated = migrateConfig(v3);
	assert.deepEqual(migrated, {
		...v3,
		version: 5,
		modelParameters: {},
		modelReasoningEfforts: {},
	});
	const validated = validateConfig(v3);
	assert.deepEqual(validated, {
		...v3,
		version: 5,
		modelParameters: {},
		modelReasoningEfforts: {},
	});
});

test("version 4 config migrates to version 5 with empty model reasoning efforts", () => {
	const v4 = {
		version: 4,
		enabled: true,
		paused: false,
		models: [{ provider: "openai", id: "gpt" }],
		reasoningEffort: "high",
		cooldownMinutes: 15,
		errorHandlingMode: "retry",
		maxRetries: 2,
		noProgressTimeoutSeconds: 60,
		manualRecovery: { "openai/gpt": "HTTP 429" },
		modelParameters: {},
	};
	assert.deepEqual(migrateConfig(v4), {
		...v4,
		version: 5,
		modelReasoningEfforts: {},
	});
	assert.deepEqual(validateConfig(v4), {
		...v4,
		version: 5,
		modelReasoningEfforts: {},
	});
});

test("reasoning effort resolver prefers a model override", () => {
	const config = createDefaultConfig();
	const model: ModelRef = { provider: "openai", id: "gpt" };
	assert.equal(resolveReasoningEffort(config, model), "medium");
	config.modelReasoningEfforts["openai/gpt"] = "max";
	assert.equal(resolveReasoningEffort(config, model), "max");
	assert.equal(resolveReasoningEffort(config), "medium");
});

test("model parameters and reasoning efforts round-trip and reject malformed shapes", () => {
	const base = createDefaultConfig([{ provider: "openai", id: "gpt" }]);
	const valid = validateConfig({
		...base,
		modelParameters: {
			"openai/gpt": {
				promptCacheKey: false,
				promptCacheRetention: true,
				reasoningEffort: false,
				sessionAffinity: true,
			},
		},
		modelReasoningEfforts: {
			"openai/gpt": "max",
		},
	});
	assert.deepEqual(valid?.modelParameters, {
		"openai/gpt": {
			promptCacheKey: false,
			promptCacheRetention: true,
			reasoningEffort: false,
			sessionAffinity: true,
		},
	});
	assert.deepEqual(valid?.modelReasoningEfforts, { "openai/gpt": "max" });

	for (const malformed of [
		{ "openai/gpt": { promptCacheKey: "yes" } },
		{ "openai/gpt": { promptCacheKey: true } },
		{
			"": {
				promptCacheKey: true,
				promptCacheRetention: true,
				reasoningEffort: true,
				sessionAffinity: true,
			},
		},
		{ "openai/gpt": null },
	]) {
		assert.equal(
			validateConfig({ ...base, modelParameters: malformed }),
			undefined,
			`expected to reject ${JSON.stringify(malformed)}`,
		);
	}
	for (const malformed of [
		{ "": "max" },
		{ "openai/gpt": "invalid" },
		{ "openai/gpt": 1 },
		{ "openai/gpt": null },
	]) {
		assert.equal(
			validateConfig({ ...base, modelReasoningEfforts: malformed }),
			undefined,
			`expected to reject ${JSON.stringify(malformed)}`,
		);
	}
});
