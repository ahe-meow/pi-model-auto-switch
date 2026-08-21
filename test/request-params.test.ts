import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelParameterToggles } from "../src/types.ts";
import { DEFAULT_PARAMETER_TOGGLES } from "../src/types.ts";
import {
	applyRequestParameters,
	promptCacheKeyFromSessionId,
	rejectedCacheFields,
	replaceSessionAffinityHeaders,
	requestStatus,
} from "../src/request-params.ts";

function toggles(
	overrides: Partial<ModelParameterToggles> = {},
): ModelParameterToggles {
	return { ...DEFAULT_PARAMETER_TOGGLES, ...overrides };
}

test("promptCacheKeyFromSessionId hashes and returns undefined for empty input", () => {
	const digest = promptCacheKeyFromSessionId("session-plaintext-id");
	assert.match(digest!, /^[0-9a-f]{64}$/);
	assert.notEqual(digest, "session-plaintext-id");
	assert.equal(promptCacheKeyFromSessionId(""), undefined);
	assert.equal(promptCacheKeyFromSessionId(undefined), undefined);
});

test("applyRequestParameters injects reasoning effort for openai-responses", () => {
	const payload: Record<string, unknown> = {};
	applyRequestParameters(payload, {
		api: "openai-responses",
		toggles: toggles(),
		unsupported: new Set(),
		reasoningEffort: "high",
	});
	assert.deepEqual(payload.reasoning, { effort: "high" });
});

test("applyRequestParameters uses reasoning_effort for openai-completions", () => {
	const payload: Record<string, unknown> = {};
	applyRequestParameters(payload, {
		api: "openai-completions",
		toggles: toggles(),
		unsupported: new Set(),
		reasoningEffort: "medium",
	});
	assert.equal(payload.reasoning_effort, "medium");
	assert.equal("reasoning" in payload, false);
});

test("applyRequestParameters injects cache key and retention", () => {
	const payload: Record<string, unknown> = {};
	applyRequestParameters(payload, {
		api: "openai-responses",
		toggles: toggles(),
		unsupported: new Set(),
		cacheKey: "deadbeef",
	});
	assert.equal(payload.prompt_cache_key, "deadbeef");
	assert.equal(payload.prompt_cache_retention, "24h");
});

test("applyRequestParameters leaves non-OpenAI payloads untouched", () => {
	const payload: Record<string, unknown> = { reasoning_effort: "low" };
	applyRequestParameters(payload, {
		api: "anthropic-messages",
		toggles: toggles(),
		unsupported: new Set(),
		cacheKey: "deadbeef",
		reasoningEffort: "high",
	});
	assert.deepEqual(payload, { reasoning_effort: "low" });
});

test("applyRequestParameters honors disabled toggles and undefined reasoning", () => {
	const payload: Record<string, unknown> = {
		reasoning: { effort: "low" },
		prompt_cache_key: "plaintext",
	};
	applyRequestParameters(payload, {
		api: "openai-responses",
		toggles: toggles({ promptCacheKey: false, reasoningEffort: false }),
		unsupported: new Set(),
		cacheKey: "deadbeef",
		reasoningEffort: "high",
	});
	assert.equal(payload.prompt_cache_key, "plaintext");
	assert.deepEqual(payload.reasoning, { effort: "low" });

	const noReasoning: Record<string, unknown> = {};
	applyRequestParameters(noReasoning, {
		api: "openai-responses",
		toggles: toggles(),
		unsupported: new Set(),
		reasoningEffort: undefined,
	});
	assert.equal("reasoning" in noReasoning, false);
});

test("applyRequestParameters deletes rejected cache fields", () => {
	const payload: Record<string, unknown> = {
		prompt_cache_key: "x",
		prompt_cache_retention: "y",
	};
	applyRequestParameters(payload, {
		api: "openai-responses",
		toggles: toggles(),
		unsupported: new Set(["prompt_cache_key"]),
		cacheKey: "deadbeef",
	});
	assert.equal("prompt_cache_key" in payload, false);
	assert.equal(payload.prompt_cache_retention, "24h");
});

test("replaceSessionAffinityHeaders rewrites affinity headers case-insensitively", () => {
	const headers: Record<string, string | null> = {
		session_id: "plaintext",
		"X-Session-Id": "plaintext",
		"x-client-request-id": "plaintext",
		authorization: "Bearer keep",
	};
	replaceSessionAffinityHeaders(headers, {
		toggles: toggles(),
		cacheKey: "deadbeef",
	});
	assert.equal(headers.session_id, "deadbeef");
	assert.equal(headers["X-Session-Id"], "deadbeef");
	assert.equal(headers["x-client-request-id"], "deadbeef");
	assert.equal(headers.authorization, "Bearer keep");
});

test("replaceSessionAffinityHeaders skips when toggle off or no cache key", () => {
	const off: Record<string, string | null> = { session_id: "plaintext" };
	replaceSessionAffinityHeaders(off, {
		toggles: toggles({ sessionAffinity: false }),
		cacheKey: "deadbeef",
	});
	assert.equal(off.session_id, "plaintext");

	const missing: Record<string, string | null> = { session_id: "plaintext" };
	replaceSessionAffinityHeaders(missing, {
		toggles: toggles(),
		cacheKey: undefined,
	});
	assert.equal(missing.session_id, "plaintext");
});

test("requestStatus parses explicit, HTTP-error, and JSON status forms", () => {
	assert.equal(requestStatus({ status: 503 }), 503);
	assert.equal(
		requestStatus({ message: "HTTP error (502) from upstream" }),
		502,
	);
	assert.equal(
		requestStatus({ message: "request failed 429: rate limited" }),
		429,
	);
	assert.equal(
		requestStatus({ message: '{"status":400,"type":"invalid_request_error"}' }),
		400,
	);
	assert.equal(requestStatus({}), undefined);
});

test("rejectedCacheFields identifies a rejected prompt cache key", () => {
	const fields = rejectedCacheFields({
		status: 400,
		message: JSON.stringify({
			type: "invalid_request_error",
			code: "unknown_parameter",
			param: "prompt_cache_key",
		}),
	});
	assert.deepEqual(fields, ["prompt_cache_key"]);
});

test("rejectedCacheFields ignores auth failures and value-validation errors", () => {
	assert.deepEqual(
		rejectedCacheFields({ status: 401, message: "unauthorized" }),
		[],
	);
	assert.deepEqual(
		rejectedCacheFields({
			status: 400,
			message: JSON.stringify({
				type: "invalid_request_error",
				param: "max_tokens",
				code: "invalid_value",
			}),
		}),
		[],
	);
});
