import assert from "node:assert/strict";
import { test } from "node:test";
import {
	discoverModels,
	seedModelList,
} from "../src/catalog.ts";

const available = [
	{ provider: "p", id: "one" },
	{ provider: "p", id: "one" },
	{ provider: "p", id: "two" },
];

test("discovery distinguishes success, empty, and failure snapshots", async () => {
	let refreshed = 0;
	assert.deepEqual(
		await discoverModels({
			async refresh() { refreshed++; },
			getAll: () => [],
			getAvailable: () => available,
		}),
		{
			kind: "success",
			available: [
				{ provider: "p", id: "one" },
				{ provider: "p", id: "two" },
			],
		},
	);
	assert.equal(refreshed, 1);

	assert.deepEqual(
		await discoverModels({ getAll: () => [], getAvailable: () => [] }),
		{ kind: "success", available: [] },
	);

	const refreshError = new Error("refresh failed");
	const fallback = await discoverModels({
		refresh: async () => { throw refreshError; },
		getAll: () => [],
		getAvailable: () => available,
	});
	assert.equal(fallback.kind, "failure");
	assert.equal(fallback.error, refreshError);
	assert.deepEqual(fallback.available, [
		{ provider: "p", id: "one" },
		{ provider: "p", id: "two" },
	]);

	let reads = 0;
	const snapshotError = new Error("snapshot failed");
	const failed = await discoverModels({
		getAll: () => [],
		getAvailable: () => {
			reads++;
			throw snapshotError;
		},
	});
	assert.equal(reads, 2);
	assert.deepEqual(failed, {
		kind: "failure",
		available: [],
		error: snapshotError,
	});
});

test("first run authorizes only a copied current model", () => {
	const current = { provider: "auth", id: "ready" };
	const seeded = seedModelList(current);
	assert.deepEqual(seeded, [current]);
	assert.notEqual(seeded[0], current);
	assert.deepEqual(seedModelList(undefined), []);
});
