import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

async function withModelsJson(
	run: (path: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-model-catalog-"));
	try {
		await run(join(directory, "models.json"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function replaceAtomically(path: string, bytes: string): Promise<void> {
	const replacementPath = `${path}.replacement`;
	await writeFile(replacementPath, bytes, "utf8");
	await rename(replacementPath, path);
}

test("malformed models.json recovers from one atomic valid replacement", async () => {
	await withModelsJson(async (path) => {
		await writeFile(path, '{"providers":', "utf8");
		const replacement = { marker: "replacement", providers: {} };
		let hookCalls = 0;

		const loaded = await loadModelsJson(path, async () => {
			hookCalls += 1;
			await replaceAtomically(path, `${JSON.stringify(replacement)}\n`);
		});

		assert.equal(hookCalls, 1);
		assert.equal(loaded.kind, "loaded");
		if (loaded.kind !== "loaded") return;
		assert.deepEqual(loaded.document, replacement);

		let unexpectedHookCalls = 0;
		const reread = await loadModelsJson(path, async () => {
			unexpectedHookCalls += 1;
		});
		assert.equal(unexpectedHookCalls, 0);
		assert.equal(reread.kind, "loaded");
		if (reread.kind !== "loaded") return;
		assert.deepEqual(loaded.revision, reread.revision);
	});
});

test("persistent malformed models.json returns the original block without writing", async () => {
	await withModelsJson(async (path) => {
		const original = '{"providers":';
		await writeFile(path, original, "utf8");
		let hookCalls = 0;

		const loaded = await loadModelsJson(path, async () => {
			hookCalls += 1;
		});

		assert.equal(hookCalls, 1);
		assert.deepEqual(loaded, {
			kind: "blocked",
			reason: "malformed",
			detail: "models.json is not valid JSON",
		});
		assert.equal(await readFile(path, "utf8"), original);
	});
});

test("persistent zero-byte models.json stays malformed and is never treated as missing", async () => {
	await withModelsJson(async (path) => {
		await writeFile(path, "", "utf8");
		let hookCalls = 0;

		const loaded = await loadModelsJson(path, async () => {
			hookCalls += 1;
		});

		assert.equal(hookCalls, 1);
		assert.deepEqual(loaded, {
			kind: "blocked",
			reason: "malformed",
			detail: "models.json is not valid JSON",
		});
		assert.equal((await readFile(path)).length, 0);
	});
});

test("a changed but still malformed snapshot returns the original block", async () => {
	await withModelsJson(async (path) => {
		await writeFile(path, "{", "utf8");
		const replacement = "[";
		let hookCalls = 0;

		const loaded = await loadModelsJson(path, async () => {
			hookCalls += 1;
			await replaceAtomically(path, replacement);
		});

		assert.equal(hookCalls, 1);
		assert.deepEqual(loaded, {
			kind: "blocked",
			reason: "malformed",
			detail: "models.json is not valid JSON",
		});
		assert.equal(await readFile(path, "utf8"), replacement);
	});
});

test("a malformed snapshot followed by a missing file returns the original block", async () => {
	await withModelsJson(async (path) => {
		await writeFile(path, "{", "utf8");
		let hookCalls = 0;

		const loaded = await loadModelsJson(path, async () => {
			hookCalls += 1;
			await rename(path, `${path}.moved`);
		});

		assert.equal(hookCalls, 1);
		assert.deepEqual(loaded, {
			kind: "blocked",
			reason: "malformed",
			detail: "models.json is not valid JSON",
		});
		await assert.rejects(readFile(path), { code: "ENOENT" });
	});
});

test("a malformed snapshot followed by schema-invalid JSON returns the original block", async () => {
	await withModelsJson(async (path) => {
		await writeFile(path, "{", "utf8");
		const replacement = '{"providers":[]}\n';
		let hookCalls = 0;

		const loaded = await loadModelsJson(path, async () => {
			hookCalls += 1;
			await replaceAtomically(path, replacement);
		});

		assert.equal(hookCalls, 1);
		assert.deepEqual(loaded, {
			kind: "blocked",
			reason: "malformed",
			detail: "models.json is not valid JSON",
		});
		assert.equal(await readFile(path, "utf8"), replacement);
	});
});

test("valid, missing, and schema-invalid initial states do not invoke the hook", async () => {
	let hookCalls = 0;
	const hook = async () => {
		hookCalls += 1;
	};

	await withModelsJson(async (path) => {
		await writeFile(path, '{"providers":{}}\n', "utf8");
		assert.equal((await loadModelsJson(path, hook)).kind, "loaded");
	});
	await withModelsJson(async (path) => {
		assert.equal((await loadModelsJson(path, hook)).kind, "missing");
	});
	await withModelsJson(async (path) => {
		await writeFile(path, '{"providers":[]}\n', "utf8");
		assert.deepEqual(await loadModelsJson(path, hook), {
			kind: "blocked",
			reason: "invalid",
			detail: "models.json.providers must contain an object",
		});
	});
	assert.equal(hookCalls, 0);
});

test("a failing malformed hook is called once and preserves the original block", async () => {
	await withModelsJson(async (path) => {
		const original = "{";
		await writeFile(path, original, "utf8");
		let hookCalls = 0;

		const loaded = await loadModelsJson(path, async () => {
			hookCalls += 1;
			throw new Error("injected hook failure");
		});

		assert.equal(hookCalls, 1);
		assert.deepEqual(loaded, {
			kind: "blocked",
			reason: "malformed",
			detail: "models.json is not valid JSON",
		});
		assert.equal(await readFile(path, "utf8"), original);
	});
});

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
		version: 7 as const,
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
			buildFailoverCatalogModels({ version: 7, models: [model("primary")] }),
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
