import assert from "node:assert/strict";
import { test } from "node:test";
import { uniqueModels } from "../src/catalog.ts";

test("uniqueModels de-duplicates and drops malformed registry entries", () => {
	assert.deepEqual(
		uniqueModels([
			{ provider: "p", id: "one" },
			{ provider: "p", id: "one" },
			{ provider: "p", id: "two" },
			{ provider: "", id: "blank-provider" },
			{ provider: "p", id: "" },
		]),
		[
			{ provider: "p", id: "one" },
			{ provider: "p", id: "two" },
		],
	);
	assert.deepEqual(uniqueModels([]), []);
});

test("uniqueModels copies refs instead of returning registry objects", () => {
	const source = { provider: "p", id: "one" };
	const [copy] = uniqueModels([source]);
	assert.deepEqual(copy, source);
	assert.notEqual(copy, source);
});
