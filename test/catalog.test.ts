import assert from "node:assert/strict";
import { test } from "node:test";
import {
	discoverModels,
	filterConfiguredModels,
	mergeDiscoveredModels,
	seedModelList,
} from "../src/catalog.ts";

test("discovery returns authenticated models instead of the entire unauthenticated catalog", async () => {
	let refreshed = 0;
	const models = await discoverModels({
		async refresh() {
			refreshed++;
		},
		getAll: () => [
			{ provider: "catalog", id: "one" },
			{ provider: "catalog", id: "two" },
		],
		getAvailable: () => [
			{ provider: "auth", id: "ready" },
			{ provider: "catalog", id: "one" },
		],
	});
	assert.equal(refreshed, 1);
	assert.deepEqual(models, [
		{ provider: "auth", id: "ready" },
		{ provider: "catalog", id: "one" },
	]);
});

test("refresh removes models that lost authentication while preserving order", () => {
	assert.deepEqual(
		filterConfiguredModels(
			[
				{ provider: "p", id: "keep" },
				{ provider: "p", id: "remove" },
				{ provider: "p", id: "keep-two" },
			],
			[
				{ provider: "p", id: "keep-two" },
				{ provider: "p", id: "keep" },
			],
		),
		[
			{ provider: "p", id: "keep" },
			{ provider: "p", id: "keep-two" },
		],
	);
});

test("first setup puts the current model first without compatibility filtering", () => {
	const seeded = seedModelList({ provider: "auth", id: "ready" }, [
		{ provider: "catalog", id: "image-only" },
		{ provider: "auth", id: "ready" },
		{ provider: "catalog", id: "text" },
	]);
	assert.deepEqual(seeded, [
		{ provider: "auth", id: "ready" },
		{ provider: "catalog", id: "image-only" },
		{ provider: "catalog", id: "text" },
	]);
});

test("refresh discovery preserves explicit order and exposes new models", () => {
	assert.deepEqual(
		mergeDiscoveredModels(
			[
				{ provider: "user", id: "second" },
				{ provider: "user", id: "first" },
			],
			[
				{ provider: "catalog", id: "new" },
				{ provider: "user", id: "first" },
			],
		),
		[
			{ provider: "user", id: "second" },
			{ provider: "user", id: "first" },
			{ provider: "catalog", id: "new" },
		],
	);
});
