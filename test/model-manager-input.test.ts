import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createProviderAlias } from "../src/model-manager-types.ts";
import {
	normalizeKey,
	parseEnvironmentKeys,
	parseRawKeys,
} from "../src/model-manager-input.ts";

function expectedFingerprint(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

test("normalizeKey trims whitespace and strips wrapping quotes", () => {
	assert.equal(normalizeKey("  sk-alpha  "), "sk-alpha");
	assert.equal(normalizeKey("  'sk-beta'  "), "sk-beta");
	assert.equal(normalizeKey('  "sk-gamma"  '), "sk-gamma");
	assert.equal(normalizeKey("'  sk-delta  '"), "sk-delta");
	assert.equal(normalizeKey("'sk-mismatch\""), "'sk-mismatch\"");
});

test("parseRawKeys rejects empty and blank only input", () => {
	const empty = parseRawKeys("");
	assert.equal(empty.accepted, false);
	assert.deepEqual(empty.entries, []);
	assert.deepEqual(
		empty.rejected.map(({ line }) => line),
		[1],
	);
	assert.match(empty.rejected[0]?.reason ?? "", /blank/i);

	const blank = parseRawKeys("  \r\n\t  \n");
	assert.equal(blank.accepted, false);
	assert.deepEqual(blank.entries, []);
	assert.deepEqual(
		blank.rejected.map(({ line }) => line),
		[1, 2],
	);
	for (const rejection of blank.rejected)
		assert.match(rejection.reason, /blank/i);
});

test("parseRawKeys rejects control characters", () => {
	const result = parseRawKeys(
		`sk-control-good\nsk-control-${String.fromCharCode(1)}bad\nsk-delete-${String.fromCharCode(127)}bad`,
	);

	assert.equal(result.accepted, false);
	assert.deepEqual(result.entries, []);
	assert.deepEqual(
		result.rejected.map(({ line }) => line),
		[2, 3],
	);
	for (const rejection of result.rejected) {
		assert.match(rejection.reason, /control/i);
		assert.doesNotMatch(rejection.reason, /sk-|bad/);
	}
});

test("parseRawKeys rejects command style lines starting with !", () => {
	const result = parseRawKeys("!command-secret-value\nsk-command-good");

	assert.equal(result.accepted, false);
	assert.deepEqual(result.entries, []);
	assert.deepEqual(
		result.rejected.map(({ line }) => line),
		[1],
	);
	assert.match(result.rejected[0]?.reason ?? "", /command/i);
	assert.doesNotMatch(result.rejected[0]?.reason ?? "", /command-secret-value/);
});

test("parseRawKeys rejects illegal characters and duplicates as a whole batch", () => {
	const duplicate = "sk-duplicate-unique";
	const result = parseRawKeys(
		`${duplicate}\nsk-illegal-${String.fromCharCode(0x80)}-unique\n${duplicate}`,
	);

	assert.equal(result.accepted, false);
	assert.deepEqual(result.entries, []);
	assert.deepEqual(
		result.rejected.map(({ line }) => line),
		[2, 3],
	);
	assert.match(result.rejected[0]?.reason ?? "", /printable|character|illegal/i);
	assert.match(result.rejected[1]?.reason ?? "", /duplicate/i);
});

test("parseRawKeys rejections never contain secret material", () => {
	const inputKeys = [
		"sk-secret-alpha-unique",
		"!sk-secret-command-unique",
		"sk-secret-alpha-unique",
	];
	const result = parseRawKeys(inputKeys.join("\n"));
	const serialized = JSON.stringify(result);

	assert.equal(result.accepted, false);
	assert.deepEqual(result.entries, []);
	for (const key of inputKeys) {
		assert.equal(serialized.includes(key), false, `leaked ${key}`);
	}
	for (const rejection of result.rejected) {
		for (const key of inputKeys)
			assert.equal(rejection.reason.includes(key), false);
	}
});

test("parseRawKeys accepts valid unique keys with one alias per key", () => {
	const result = parseRawKeys('  sk-valid-alpha  \r\n"sk-valid-beta"');

	assert.equal(result.accepted, true);
	assert.deepEqual(result.rejected, []);
	assert.deepEqual(
		result.entries.map(({ normalized }) => normalized),
		["sk-valid-alpha", "sk-valid-beta"],
	);
	for (const entry of result.entries) {
		const fingerprint = expectedFingerprint(entry.normalized);
		assert.equal(entry.fingerprint, fingerprint);
		assert.equal(entry.aliasHint, createProviderAlias("pending", fingerprint));
	}
});

test("parseEnvironmentKeys reads from provided env object only", () => {
	const name = "MODEL_MANAGER_INPUT_PROCESS_ONLY";
	const previous = process.env[name];
	process.env[name] = "process-secret-value";
	try {
		const result = parseEnvironmentKeys([name, "MODEL_MANAGER_INPUT_PROVIDED"], {
			[name]: "provided-secret-value",
			MODEL_MANAGER_INPUT_PROVIDED: "  provided-second-value  ",
		});

		assert.equal(result.accepted, true);
		assert.deepEqual(result.rejected, []);
		assert.deepEqual(
			result.entries.map(({ normalized }) => normalized),
			["provided-secret-value", "provided-second-value"],
		);
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
});

test("parseEnvironmentKeys rejects missing env vars as whole batch", () => {
	const variableName = "MODEL_MANAGER_INPUT_MISSING";
	const blankVariableName = "MODEL_MANAGER_INPUT_BLANK";
	const missingValue = "env-missing-secret-value";
	const result = parseEnvironmentKeys(
		[variableName, blankVariableName, "MODEL_MANAGER_INPUT_PRESENT"],
		{
			[blankVariableName]: " \t ",
			MODEL_MANAGER_INPUT_PRESENT: missingValue,
		},
	);

	assert.equal(result.accepted, false);
	assert.deepEqual(result.entries, []);
	assert.deepEqual(
		result.rejected.map(({ line }) => line),
		[1, 2],
	);
	assert.match(result.rejected[0]?.reason ?? "", /missing/i);
	assert.match(result.rejected[1]?.reason ?? "", /blank|empty/i);
	for (const rejection of result.rejected) {
		assert.doesNotMatch(rejection.reason, /env-missing-secret-value/);
		assert.doesNotMatch(rejection.reason, new RegExp(variableName));
		assert.doesNotMatch(rejection.reason, new RegExp(blankVariableName));
	}
	assert.doesNotMatch(JSON.stringify(result), new RegExp(variableName));
	assert.doesNotMatch(JSON.stringify(result), new RegExp(blankVariableName));
	assert.doesNotMatch(JSON.stringify(result), /env-missing-secret-value/);
});
