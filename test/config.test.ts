import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createDefaultConfig,
	loadConfig,
	migrateConfig,
	saveConfig,
	validateConfig,
} from "../src/config.ts";

test("config defaults and validation keep only the versioned secret-free shape", () => {
	assert.deepEqual(createDefaultConfig(), {
		version: 2,
		enabled: true,
		paused: false,
		models: [],
		noProgressTimeoutSeconds: 90,
		manualRecovery: {},
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
		version: 2,
		enabled: true,
		paused: true,
		models: [{ provider: "openai", id: "gpt" }],
		noProgressTimeoutSeconds: 0,
		manualRecovery: { "openai/gpt": "HTTP 401" },
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
			version: 2,
			enabled: true,
			models: [{ provider: "openai", id: "gpt" }],
			noProgressTimeoutSeconds: 90,
			paused: false,
			manualRecovery: {},
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
			version: 2 as const,
			enabled: true,
			paused: true,
			models: [{ provider: "anthropic", id: "claude" }],
			noProgressTimeoutSeconds: 90,
			manualRecovery: { "anthropic/claude": "HTTP 404" },
		};
		await saveConfig(path, config);
		const loaded = await loadConfig(path);
		assert.equal(loaded.exists, true);
		assert.equal(loaded.valid, true);
		assert.equal(loaded.migrated, false);
		assert.deepEqual(loaded.config, config);
		assert.match(await readFile(path, "utf8"), /"manualRecovery"/);
		assert.equal((await stat(path)).mode & 0o077, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent config saves use independent temporary files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	const path = join(directory, "model-failover.json");
	const originalNow = Date.now;
	Date.now = () => 1_000;
	try {
		await Promise.all(
			Array.from({ length: 20 }, () => saveConfig(path, createDefaultConfig())),
		);
		assert.equal((await loadConfig(path)).valid, true);
	} finally {
		Date.now = originalNow;
		await rm(directory, { recursive: true, force: true });
	}
});

test("loading version 1 config reports migration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	const path = join(directory, "model-failover.json");
	try {
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				enabled: false,
				models: [],
				noProgressTimeoutSeconds: 90,
			}),
			"utf8",
		);
		const loaded = await loadConfig(path);
		assert.equal(loaded.valid, true);
		assert.equal(loaded.migrated, true);
		assert.deepEqual(loaded.config, {
			...createDefaultConfig(),
			enabled: false,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing and malformed config load to safe defaults", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-failover-"));
	const path = join(directory, "model-failover.json");
	try {
		assert.deepEqual((await loadConfig(path)).config, createDefaultConfig());
		await saveConfig(path, createDefaultConfig());
		await writeFile(path, "{broken", "utf8");
		const loaded = await loadConfig(path);
		assert.equal(loaded.exists, true);
		assert.equal(loaded.valid, false);
		assert.deepEqual(loaded.config, createDefaultConfig());
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
