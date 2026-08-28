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

const SUPPRESSED_AFFINITY_HEADERS = {
	session_id: null,
	"x-client-request-id": null,
	"x-session-affinity": null,
	"x-session-id": null,
} as const;

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

test("applyRequestParameters injects cache key and explicit long retention", () => {
	const payload: Record<string, unknown> = {};
	applyRequestParameters(payload, {
		api: "openai-responses",
		toggles: toggles(),
		unsupported: new Set(),
		cacheKey: "deadbeef",
		cacheRetention: "long",
	});
	assert.equal(payload.prompt_cache_key, "deadbeef");
	assert.equal(payload.prompt_cache_retention, "24h");
});

test("cache retention none deletes both cache fields for every OpenAI API", () => {
	for (const api of [
		"openai-responses",
		"openai-completions",
		"azure-openai-responses",
	]) {
		const payload: Record<string, unknown> = {
			prompt_cache_key: "plaintext",
			prompt_cache_retention: "24h",
		};
		applyRequestParameters(payload, {
			api,
			toggles: toggles(),
			unsupported: new Set(),
			cacheKey: "deadbeef",
			cacheRetention: "none",
		});
		assert.equal("prompt_cache_key" in payload, false, api);
		assert.equal("prompt_cache_retention" in payload, false, api);
	}
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

test("applyRequestParameters preserves native retention when its passive toggle is off", () => {
	for (const retention of ["24h", "1h"] as const) {
		const payload: Record<string, unknown> = {
			prompt_cache_key: "native-key",
			prompt_cache_retention: retention,
		};
		applyRequestParameters(payload, {
			api: "openai-responses",
			toggles: toggles({ promptCacheRetention: false }),
			unsupported: new Set(),
			cacheKey: "deadbeef",
		});
		assert.equal(payload.prompt_cache_key, "deadbeef");
		assert.equal(payload.prompt_cache_retention, retention);
	}
});

test("applyRequestParameters honors disabled reasoning and undefined reasoning", () => {
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

test("applyRequestParameters preserves native retention and does not re-add outer stripping", () => {
	const preserved: Record<string, unknown> = {
		prompt_cache_retention: "1h",
	};
	applyRequestParameters(preserved, {
		api: "openai-responses",
		toggles: toggles(),
		unsupported: new Set(),
		cacheKey: "deadbeef",
	});
	assert.equal(preserved.prompt_cache_retention, "1h");

	const stripped: Record<string, unknown> = {};
	applyRequestParameters(stripped, {
		api: "openai-responses",
		toggles: toggles(),
		unsupported: new Set(),
		cacheKey: "deadbeef",
		cacheRetention: "long",
		retentionRemovedByOuter: true,
	});
	assert.equal("prompt_cache_retention" in stripped, false);
});

test("applyRequestParameters preserves native retention across passive incompatibility checks", () => {
	const payload: Record<string, unknown> = {
		prompt_cache_retention: "1h",
	};
	applyRequestParameters(payload, {
		api: "openai-responses",
		toggles: toggles({ promptCacheRetention: false }),
		unsupported: new Set(["prompt_cache_retention"]),
		compat: { supportsLongCacheRetention: false },
		cacheRetention: "long",
	});
	assert.equal(payload.prompt_cache_retention, "1h");
});

test("applyRequestParameters removes unsupported or compat-disabled retention", () => {
	const compatDisabled: Record<string, unknown> = {
		prompt_cache_retention: "24h",
	};
	applyRequestParameters(compatDisabled, {
		api: "openai-responses",
		toggles: toggles(),
		unsupported: new Set(),
		compat: { supportsLongCacheRetention: false },
	});
	assert.equal("prompt_cache_retention" in compatDisabled, false);

	const rememberedRejected: Record<string, unknown> = {
		prompt_cache_retention: "24h",
	};
	applyRequestParameters(rememberedRejected, {
		api: "openai-responses",
		toggles: toggles(),
		unsupported: new Set(["prompt_cache_retention"]),
		cacheRetention: "long",
	});
	assert.equal("prompt_cache_retention" in rememberedRejected, false);
});

test("applyRequestParameters matches Pi long-retention defaults", () => {
	const defaults: Array<{
		api: string;
		provider: string;
		baseUrl: string;
		expected: "24h" | undefined;
	}> = [
		{
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.invalid/v1",
			expected: "24h",
		},
		{
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://example.invalid/v1",
			expected: "24h",
		},
		{
			api: "openai-completions",
			provider: "together",
			baseUrl: "https://example.invalid/v1",
			expected: undefined,
		},
		{
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://api.cloudflare.com/client/v4/accounts/id/ai/v1",
			expected: undefined,
		},
		{
			api: "openai-completions",
			provider: "cloudflare-ai-gateway",
			baseUrl: "https://example.invalid/v1",
			expected: undefined,
		},
		{
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			expected: undefined,
		},
		{
			api: "openai-completions",
			provider: "ant-ling",
			baseUrl: "https://example.invalid/v1",
			expected: undefined,
		},
		{
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "https://example.openai.azure.com/openai/v1",
			expected: undefined,
		},
	];
	for (const entry of defaults) {
		const payload: Record<string, unknown> = {
			prompt_cache_retention: undefined,
		};
		applyRequestParameters(payload, {
			...entry,
			toggles: toggles(),
			unsupported: new Set(),
			cacheRetention: "long",
		});
		assert.equal(payload.prompt_cache_retention, entry.expected);
		assert.equal(
			"prompt_cache_retention" in payload,
			entry.expected !== undefined,
			`${entry.provider}/${entry.baseUrl}`,
		);
	}

	for (const api of ["openai-completions", "azure-openai-responses"]) {
		const payload: Record<string, unknown> = {};
		applyRequestParameters(payload, {
			api,
			provider: "together",
			baseUrl: "https://api.together.ai/v1",
			toggles: toggles(),
			unsupported: new Set(),
			compat: { supportsLongCacheRetention: true },
			cacheRetention: "long",
		});
		assert.equal(payload.prompt_cache_retention, "24h", api);
	}
});

test("replaceSessionAffinityHeaders matches Responses defaults and OpenRouter URLs", () => {
	const headers: Record<string, string | null> = {
		"x-session-id": "plaintext",
		authorization: "Bearer keep",
		"x-unrelated": "keep",
	};
	replaceSessionAffinityHeaders(headers, {
		api: "openai-responses",
		provider: "custom",
		baseUrl: "https://example.invalid/v1",
		toggles: toggles(),
		cacheKey: "deadbeef",
	});
	assert.deepEqual(headers, {
		authorization: "Bearer keep",
		"x-unrelated": "keep",
		...SUPPRESSED_AFFINITY_HEADERS,
		session_id: "deadbeef",
		"x-client-request-id": "deadbeef",
	});

	const openrouter: Record<string, string | null> = {
		session_id: "plaintext",
		"x-client-request-id": "plaintext",
	};
	replaceSessionAffinityHeaders(openrouter, {
		api: "openai-responses",
		provider: "custom",
		baseUrl: "https://openrouter.ai/api/v1",
		toggles: toggles(),
		cacheKey: "deadbeef",
	});
	assert.deepEqual(openrouter, {
		...SUPPRESSED_AFFINITY_HEADERS,
		"x-session-id": "deadbeef",
	});
});

test("mixed-case active affinity headers reuse spelling without duplicates", () => {
	const headers: Record<string, string | null> = {
		"X-Session-Id": "old",
		"X-Client-Request-ID": "other",
		"x-session-id": "duplicate",
	};
	replaceSessionAffinityHeaders(headers, {
		api: "openai-responses",
		provider: "custom",
		baseUrl: "https://openrouter.ai/api/v1",
		toggles: toggles(),
		cacheKey: "digest",
	});
	assert.equal(headers["X-Session-Id"], "digest");
	assert.equal(headers["X-Client-Request-ID"], null);
	assert.equal(headers.session_id, null);
	assert.equal(headers["x-session-affinity"], null);
	assert.equal("x-session-id" in headers, false);
	const recognized = Object.keys(headers).filter((name) =>
		[
			"session_id",
			"x-client-request-id",
			"x-session-affinity",
			"x-session-id",
		].includes(name.toLowerCase()),
	);
	assert.equal(new Set(recognized.map((name) => name.toLowerCase())).size, 4);
});

test("Completions affinity requires an explicit compat opt-in", () => {
	const enabled: Record<string, string | null> = {};
	replaceSessionAffinityHeaders(enabled, {
		api: "openai-completions",
		compat: { sendSessionAffinityHeaders: true },
		toggles: toggles(),
		cacheKey: "deadbeef",
	});
	assert.deepEqual(enabled, {
		...SUPPRESSED_AFFINITY_HEADERS,
		session_id: "deadbeef",
		"x-client-request-id": "deadbeef",
		"x-session-affinity": "deadbeef",
	});

	const omitted: Record<string, string | null> = {
		"x-session-affinity": "plaintext",
		authorization: "Bearer keep",
	};
	replaceSessionAffinityHeaders(omitted, {
		api: "openai-completions",
		toggles: toggles(),
		cacheKey: "deadbeef",
	});
	assert.deepEqual(omitted, {
		authorization: "Bearer keep",
		...SUPPRESSED_AFFINITY_HEADERS,
	});

	const openrouter: Record<string, string | null> = {};
	replaceSessionAffinityHeaders(openrouter, {
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://openrouter.ai/api/v1",
		compat: { sendSessionAffinityHeaders: true },
		toggles: toggles(),
		cacheKey: "deadbeef",
	});
	assert.deepEqual(openrouter, {
		...SUPPRESSED_AFFINITY_HEADERS,
		"x-session-id": "deadbeef",
	});
});

test("openai-nosession uses Pi's API-specific header names", () => {
	const responses: Record<string, string | null> = {};
	replaceSessionAffinityHeaders(responses, {
		api: "openai-responses",
		compat: { sessionAffinityFormat: "openai-nosession" },
		toggles: toggles(),
		cacheKey: "deadbeef",
	});
	assert.deepEqual(responses, {
		...SUPPRESSED_AFFINITY_HEADERS,
		"x-client-request-id": "deadbeef",
	});

	const completions: Record<string, string | null> = {};
	replaceSessionAffinityHeaders(completions, {
		api: "openai-completions",
		compat: {
			sendSessionAffinityHeaders: true,
			sessionAffinityFormat: "openai-nosession",
		},
		toggles: toggles(),
		cacheKey: "deadbeef",
	});
	assert.deepEqual(completions, {
		...SUPPRESSED_AFFINITY_HEADERS,
		"x-client-request-id": "deadbeef",
		"x-session-affinity": "deadbeef",
	});
});

test("replaceSessionAffinityHeaders preserves caller headers without a cache key", () => {
	for (const cacheRetention of [undefined, "none" as const]) {
		const headers: Record<string, string | null> = {
			"X-Session-Id": "plaintext",
			session_id: "native-session",
			"x-client-request-id": "native-request",
			"x-session-affinity": null,
			authorization: "Bearer keep",
		};
		const expected = { ...headers };
		replaceSessionAffinityHeaders(headers, {
			api: "openai-responses",
			cacheRetention,
			cacheKey: undefined,
			toggles: toggles(),
		});
		assert.deepEqual(headers, expected, String(cacheRetention));
	}
});

test("Azure suppresses all native session-affinity names when a cache key exists", () => {
	const headers: Record<string, string | null> = {
		"X-Session-Id": "plaintext",
		authorization: "Bearer keep",
	};
	replaceSessionAffinityHeaders(headers, {
		api: "azure-openai-responses",
		cacheRetention: "short",
		cacheKey: "deadbeef",
		toggles: toggles(),
	});
	assert.deepEqual(headers, {
		authorization: "Bearer keep",
		session_id: null,
		"x-client-request-id": null,
		"x-session-affinity": null,
		"X-Session-Id": null,
	});
});

test("affinity shaping is a no-op when toggled off or non-OpenAI", () => {
	const off: Record<string, string | null> = { session_id: "plaintext" };
	replaceSessionAffinityHeaders(off, {
		api: "openai-responses",
		toggles: toggles({ sessionAffinity: false }),
		cacheKey: "deadbeef",
	});
	assert.deepEqual(off, { session_id: "plaintext" });

	const nonOpenAI: Record<string, string | null> = {
		session_id: "plaintext",
		authorization: "Bearer keep",
	};
	replaceSessionAffinityHeaders(nonOpenAI, {
		api: "anthropic-messages",
		toggles: toggles(),
		cacheKey: "deadbeef",
	});
	assert.deepEqual(nonOpenAI, {
		session_id: "plaintext",
		authorization: "Bearer keep",
	});
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
