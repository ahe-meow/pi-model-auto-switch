import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
	readSidecar,
	serializeSidecar,
	sidecarRevision,
	validateSidecar,
} from "../src/model-manager-sidecar.ts";
import type {
	ModelManagerBlockedState,
	ModelManagerResult,
	ModelManagerSidecar,
} from "../src/model-manager-types.ts";

function baseSidecar(
	overrides: Record<string, unknown> = {},
): ModelManagerSidecar {
	return {
		version: 1,
		models: [
			{
				id: "r1",
				providerAlias: "provider-a",
				providerName: "Provider A",
				modelId: "model-a",
				multiplier: 1.25,
			},
		],
		...overrides,
	};
}

function tempPath(name = "sidecar.json"): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "model-manager-sidecar-"));
	return { dir, path: join(dir, name) };
}

function removeTemp(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function assertBlocked<T>(
	result: ModelManagerResult<T>,
	reason: string,
): asserts result is { ok: false; error: ModelManagerBlockedState } {
	assert.equal(result.ok, false);
	if (result.ok) return;
	if (!("reason" in result.error)) throw new Error("expected blocked result");
	assert.equal(result.error.reason, reason);
}

test("readSidecar returns blocked missing with compatibility import sources", async () => {
	const { dir, path } = tempPath();
	const previous = process.env.PI_AGENT_DIR;
	const importDir = join(dir, "pi-agent");
	process.env.PI_AGENT_DIR = importDir;
	try {
		const result = await readSidecar(path);

		assertBlocked(result, "missing");
		if (result.ok) return;
		assert.deepEqual(result.error.compatibilityImport, {
			available: true,
			sourcePaths: [join(importDir, "auth.json"), join(importDir, "models.json")],
		});
		assert.equal("rawBytes" in result.error, false);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
		removeTemp(dir);
	}
});

test("missing compatibility sources fall back to homedir .pi agent", async () => {
	const { dir, path } = tempPath();
	const previous = process.env.PI_AGENT_DIR;
	delete process.env.PI_AGENT_DIR;
	try {
		const result = await readSidecar(path);

		assertBlocked(result, "missing");
		if (result.ok) return;
		assert.deepEqual(result.error.compatibilityImport?.sourcePaths, [
			join(homedir(), ".pi", "agent", "auth.json"),
			join(homedir(), ".pi", "agent", "models.json"),
		]);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
		removeTemp(dir);
	}
});

test("readSidecar returns malformed with raw bytes preserved", async () => {
	const { dir, path } = tempPath();
	const rawBytes = Buffer.from("{ malformed sidecar", "utf8");
	writeFileSync(path, rawBytes);
	try {
		const result = await readSidecar(path);

		assertBlocked(result, "malformed");
		if (result.ok) return;
		assert.deepEqual(Buffer.from(result.error.rawBytes ?? []), rawBytes);
	} finally {
		removeTemp(dir);
	}
});

test("readSidecar returns future for a version newer than one", async () => {
	const { dir, path } = tempPath();
	const rawBytes = Buffer.from(
		JSON.stringify({ version: 2, models: [] }),
		"utf8",
	);
	writeFileSync(path, rawBytes);
	try {
		const result = await readSidecar(path);

		assertBlocked(result, "future");
		if (result.ok) return;
		assert.deepEqual(Buffer.from(result.error.rawBytes ?? []), rawBytes);
		assert.doesNotMatch(result.error.message, /2/);
	} finally {
		removeTemp(dir);
	}
});

test("validateSidecar rejects invalid version and top-level shapes", () => {
	const invalidValues: Array<[string, unknown]> = [
		["version", { version: 0, models: [] }],
		["version", { version: "1", models: [] }],
		["models", { version: 1, models: {} }],
		["models[0]", { version: 1, models: [null] }],
	];

	for (const [path, value] of invalidValues) {
		const result = validateSidecar(value);
		assertBlocked(result, "invalid");
		if (result.ok) continue;
		assert.match(
			result.error.message,
			new RegExp(path.replace(/[.[\]]/g, "\\$&")),
		);
	}
});

test("validateSidecar rejects invalid record fields and multiplier", () => {
	const invalidValues: Array<[string, unknown]> = [
		[
			"models[0].id",
			baseSidecar({ models: [{ ...baseSidecar().models[0], id: "" }] }),
		],
		[
			"models[0].providerAlias",
			baseSidecar({ models: [{ ...baseSidecar().models[0], providerAlias: 42 }] }),
		],
		[
			"models[0].providerName",
			baseSidecar({ models: [{ ...baseSidecar().models[0], providerName: "" }] }),
		],
		[
			"models[0].modelId",
			baseSidecar({ models: [{ ...baseSidecar().models[0], modelId: null }] }),
		],
		[
			"models[0].multiplier",
			baseSidecar({ models: [{ ...baseSidecar().models[0], multiplier: 0 }] }),
		],
	];

	for (const [path, value] of invalidValues) {
		const result = validateSidecar(value);
		assertBlocked(result, "invalid");
		if (result.ok) continue;
		assert.match(
			result.error.message,
			new RegExp(path.replace(/[.[\]]/g, "\\$&")),
		);
	}
});

test("validateSidecar rejects secret keys without exposing their values", () => {
	const secretKeys = ["apiKey", "api_key", "token", "secret"] as const;
	for (const key of secretKeys) {
		const topLevelValue = `top-level-${key}-secret-value`;
		const topLevelSidecar = { ...baseSidecar(), [key]: topLevelValue };
		const topLevel = validateSidecar(topLevelSidecar);
		assertBlocked(topLevel, "invalid");
		if (!topLevel.ok) {
			assert.match(topLevel.error.message, new RegExp(key));
			assert.doesNotMatch(
				JSON.stringify(topLevel.error),
				new RegExp(topLevelValue),
			);
		}

		const recordValue = `record-${key}-secret-value`;
		const record = validateSidecar(
			baseSidecar({
				models: [{ ...baseSidecar().models[0], [key]: recordValue }],
			}),
		);
		assertBlocked(record, "invalid");
		if (!record.ok) {
			assert.match(record.error.message, new RegExp(`models\\[0\\]\\.${key}`));
			assert.doesNotMatch(JSON.stringify(record.error), new RegExp(recordValue));
		}

		const serialized = serializeSidecar(topLevelSidecar);
		assertBlocked(serialized, "invalid");
		assert.doesNotMatch(JSON.stringify(serialized), new RegExp(topLevelValue));
	}
});

test("validateSidecar preserves unknown top-level and record fields through round trip", () => {
	const sidecar = baseSidecar({
		unknownTopLevel: { enabled: true, tags: ["one", "two"] },
		models: [
			{
				...baseSidecar().models[0],
				unknownRecordField: { nested: [1, 2, 3] },
			},
		],
	});

	const validated = validateSidecar(sidecar);
	assert.equal(validated.ok, true);
	if (!validated.ok) return;
	assert.deepEqual(validated.value, sidecar);

	const serialized = serializeSidecar(validated.value);
	assert.equal(serialized.ok, true);
	if (!serialized.ok) return;
	const roundTrip = validateSidecar(
		JSON.parse(new TextDecoder().decode(serialized.value)),
	);
	assert.equal(roundTrip.ok, true);
	if (!roundTrip.ok) return;
	assert.deepEqual(roundTrip.value, sidecar);
});

test("serializeSidecar emits canonical JSON bytes with a trailing newline", () => {
	const sidecar = baseSidecar();
	const result = serializeSidecar(sidecar);

	assert.equal(result.ok, true);
	if (!result.ok) return;
	const expected = `${JSON.stringify(sidecar, null, 2)}\n`;
	assert.deepEqual(Buffer.from(result.value), Buffer.from(expected, "utf8"));
	assert.equal(result.value[result.value.length - 1], 0x0a);
});

test("readSidecar returns parsed sidecar, original bytes, path, and revision", async () => {
	const { dir, path } = tempPath();
	const rawBytes = Buffer.from(`${JSON.stringify(baseSidecar())}\n`, "utf8");
	writeFileSync(path, rawBytes);
	try {
		const result = await readSidecar(path);

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.value.sidecar, baseSidecar());
		assert.deepEqual(Buffer.from(result.value.rawBytes), rawBytes);
		assert.equal(result.value.path, path);
		assert.equal(result.value.revision, sidecarRevision(rawBytes));
	} finally {
		removeTemp(dir);
	}
});

test("readSidecar classifies unreadable paths without fabricating raw bytes", async () => {
	const { dir } = tempPath();
	try {
		const result = await readSidecar(dir);
		assertBlocked(result, "unreadable");
		if (!result.ok) assert.equal("rawBytes" in result.error, false);
	} finally {
		removeTemp(dir);
	}
});

test("sidecarRevision is stable for identical bytes and differs on change", () => {
	const bytes = new TextEncoder().encode("sidecar bytes\n");
	const changed = new TextEncoder().encode("sidecar bytes!\n");
	const expected = createHash("sha256").update(bytes).digest("hex").slice(0, 16);

	assert.equal(sidecarRevision(bytes), expected);
	assert.equal(sidecarRevision(bytes), sidecarRevision(new Uint8Array(bytes)));
	assert.notEqual(sidecarRevision(bytes), sidecarRevision(changed));
});
