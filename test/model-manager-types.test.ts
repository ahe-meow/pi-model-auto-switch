import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cloneRecord,
	createProviderAlias,
	createStableId,
	groupCatalog,
	validateMultiplier,
	type ModelManagerRecord,
} from "../src/model-manager-types.ts";

function baseRecord(overrides: Partial<ModelManagerRecord> = {}): ModelManagerRecord {
	return {
		id: "r1",
		providerAlias: "provider-a",
		providerName: "Provider A",
		modelId: "model-a",
		...overrides,
	};
}

test("validateMultiplier defaults undefined to 1", () => {
	const result = validateMultiplier(undefined);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value, 1);
});

test("validateMultiplier accepts range bounds 0.001 and 1000", () => {
	for (const v of [0.001, 1, 42.5, 1000]) {
		const result = validateMultiplier(v);
		assert.equal(result.ok, true, `expected ${v} to be accepted`);
		if (!result.ok) continue;
		assert.equal(result.value, v);
	}
});

test("validateMultiplier rejects non finite and out of range", () => {
	for (const v of [Infinity, -Infinity, NaN, 0, -1, 0.0009, 1000.1]) {
		const result = validateMultiplier(v);
		assert.equal(result.ok, false, `expected ${v} to be rejected`);
		if (result.ok) continue;
		assert.equal("code" in result.error, true);
	}
});

test("validateMultiplier rejects more than 3 decimals", () => {
	for (const v of [0.0001, 1.00001, 2.1234]) {
		const result = validateMultiplier(v);
		assert.equal(result.ok, false, `expected ${v} to be rejected`);
	}
	// In-range values with >3 decimals must produce too_precise.
	const inRange = validateMultiplier(1.2345);
	assert.equal(inRange.ok, false);
	if (!inRange.ok) {
		assert.equal("code" in inRange.error, true);
		const error = inRange.error as { code: string };
		assert.equal(error.code, "too_precise");
	}
});

test("createStableId is deterministic and collision safe", () => {
	assert.equal(
		createStableId("Anthropic", "Claude 3.5"),
		"anthropic--claude-3-5",
	);
	assert.equal(
		createStableId("Anthropic", "Claude 3.5"),
		createStableId("anthropic", "claude-3-5"),
	);
	const taken = new Set(["provider-a--model-a"]);
	assert.equal(
		createStableId("provider-a", "model-a", taken),
		"provider-a--model-a-2",
	);
	const takenTwo = new Set(["x--y", "x--y-2"]);
	assert.equal(createStableId("x", "y", takenTwo), "x--y-3");
	// Ambiguity: slug losses cause collision without disambiguation.
	const c1 = createStableId("a", "b--c");
	const c2 = createStableId("a--b", "c");
	assert.notEqual(c1, c2, "slug collisions must differ");
	// Deterministic: same inputs always same output.
	assert.equal(createStableId("a", "b--c"), createStableId("a", "b--c"));
	assert.equal(createStableId("a--b", "c"), createStableId("a--b", "c"));
});

test("createProviderAlias sanitizes and differs per fingerprint", () => {
	const fp1 = "a1b2c3d4e5f6g7h8";
	const fp2 = "a1b2c3d4ffffffff";
	const a = createProviderAlias("Anthropic", fp1);
	const b = createProviderAlias("Anthropic", fp2);
	// Full fingerprint, not just first 8 chars.
	assert.equal(a, `mm-anthropic-${fp1}`);
	assert.notEqual(a, b);
	assert.ok(a.startsWith("mm-"));
	// Sanitize provider name with special chars.
	const c = createProviderAlias("OpenAI Inc.", "abcdef1234567890");
	assert.equal(c, "mm-openai-inc--abcdef1234567890");
	assert.ok(c.startsWith("mm-"));
	// Taken suffix keeps distinct fingerprints distinct and stays deterministic.
	const taken = new Set(["mm-openai-inc--abcdef1234567890"]);
	assert.equal(
		createProviderAlias("OpenAI Inc.", "abcdef1234567890", taken),
		"mm-openai-inc--abcdef1234567890-2",
	);
});

test("cloneRecord deep copies unknown fields", () => {
	const meta = { nested: { list: [1, 2, 3] } };
	const original = baseRecord({ extra: meta, multiplier: 2 });
	const copy = cloneRecord(original);

	assert.notEqual(copy, original);
	assert.deepEqual(copy, original);
	assert.notEqual(copy.extra, meta);
	assert.notEqual((copy.extra as { nested: unknown }).nested, meta.nested);
	// Mutating the copy must not affect the original.
	(copy.extra as { nested: { list: number[] } }).nested.list.push(4);
	assert.deepEqual(meta.nested.list, [1, 2, 3]);
});

test("groupCatalog groups by remoteGroup then providerAlias with owner flagged", () => {
	const records: ModelManagerRecord[] = [
		baseRecord({
			id: "z",
			providerAlias: "zebra",
			modelId: "m1",
			remoteGroup: "shared",
			groupOwner: true,
		}),
		baseRecord({
			id: "a",
			providerAlias: "alpha",
			modelId: "m2",
			remoteGroup: "shared",
			groupOwner: true,
		}),
		baseRecord({
			id: "b",
			providerAlias: "beta",
			modelId: "m3",
			remoteGroup: "solo",
		}),
		baseRecord({ id: "c", providerAlias: "gamma", modelId: "m4" }),
	];

	const groups = groupCatalog(records);

	// Sorted by group key.
	assert.deepEqual(
		groups.map((g) => g.key),
		["gamma", "shared", "solo"],
	);

	// "shared" has two owners -> smallest id wins.
	const shared = groups.find((g) => g.key === "shared");
	assert.ok(shared);
	assert.equal(shared.owner?.id, "a");
	assert.equal(shared.records.length, 2);

	// No remoteGroup -> key is providerAlias, no owner.
	const gamma = groups.find((g) => g.key === "gamma");
	assert.ok(gamma);
	assert.equal(gamma.owner, null);
	assert.equal(gamma.records.length, 1);

	// "solo" has no owner flagged.
	const solo = groups.find((g) => g.key === "solo");
	assert.ok(solo);
	assert.equal(solo.owner, null);
});
