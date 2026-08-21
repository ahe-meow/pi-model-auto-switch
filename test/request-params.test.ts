import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createDefaultConfig } from "../src/config.ts";

type Handler = (event: any, context: ExtensionContext) => unknown;
type RegisterExtension = (pi: ExtensionAPI) => void;

const agentDir = await mkdtemp(join(tmpdir(), "pi-failover-request-params-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const configPath = join(agentDir, "model-failover.json");

async function createHarness(
	model: Record<string, unknown>,
	modelReasoningEfforts: Record<string, string> = {},
) {
	await writeFile(
		configPath,
		JSON.stringify({
			...createDefaultConfig(),
			enabled: false,
			modelReasoningEfforts,
		}),
		"utf8",
	);
	const handlers = new Map<string, Handler>();
	const context = {
		cwd: agentDir,
		mode: "tui",
		hasUI: true,
		model,
		modelRegistry: {
			refresh: async () => undefined,
			getAll: () => [model],
			getAvailable: () => [model],
			find: () => undefined,
		},
		ui: {
			setStatus: () => undefined,
			notify: () => undefined,
			custom: async () => undefined,
			select: async () => undefined,
			input: async () => undefined,
		},
		isIdle: () => false,
		sessionManager: { getSessionId: () => "session-plaintext-id" },
		abort: () => undefined,
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => undefined,
		setModel: async () => true,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const { default: registerExtension } = (await import("../src/index.ts")) as {
		default: RegisterExtension;
	};
	registerExtension(pi);
	return {
		context,
		emit: (event: string, value: unknown = {}) =>
			handlers.get(event)?.(value, context),
	};
}

async function startedHarness(
	model: Record<string, unknown>,
	modelReasoningEfforts: Record<string, string> = {},
) {
	const harness = await createHarness(model, modelReasoningEfforts);
	await harness.emit("session_start", { reason: "startup" });
	return harness;
}

test("provider reasoning uses the configured model override and global fallback", async () => {
	const model = {
		provider: "openai",
		id: "test-model",
		api: "openai-responses",
		reasoning: true,
	};
	const harness = await startedHarness(model, { "openai/test-model": "high" });
	const overridden: Record<string, unknown> = {};
	await harness.emit("before_provider_request", { payload: overridden });
	assert.deepEqual(overridden.reasoning, { effort: "high" });

	(harness.context as any).model = {
		provider: "openai",
		id: "other-model",
		api: "openai-responses",
		reasoning: true,
	};
	const inherited: Record<string, unknown> = {};
	await harness.emit("before_provider_request", { payload: inherited });
	assert.deepEqual(inherited.reasoning, { effort: "medium" });
});
test("injects hashed cache parameters and OpenAI reasoning fields", async () => {
	const harness = await startedHarness({
		provider: "openai",
		id: "test-model",
		api: "openai-responses",
		reasoning: true,
	});
	const payload: Record<string, any> = {
		reasoning: { effort: "low" },
		prompt_cache_key: "session-plaintext-id",
		prompt_cache_retention: "in_memory",
	};
	await harness.emit("before_provider_request", { payload });

	assert.deepEqual(payload.reasoning, { effort: "medium" });
	assert.equal(payload.prompt_cache_retention, "24h");
	assert.match(payload.prompt_cache_key, /^[0-9a-f]{64}$/);
	assert.notEqual(payload.prompt_cache_key, "session-plaintext-id");

	const headers = {
		session_id: "session-plaintext-id",
		"x-client-request-id": "session-plaintext-id",
		"x-session-affinity": "session-plaintext-id",
	};
	await harness.emit("before_provider_headers", { headers });
	assert.equal(headers.session_id, payload.prompt_cache_key);
	assert.equal(headers["x-client-request-id"], payload.prompt_cache_key);
	assert.equal(headers["x-session-affinity"], payload.prompt_cache_key);
});

test("hashes x-session-id across supported OpenAI request APIs only", async () => {
	const harness = await startedHarness({
		provider: "custom",
		id: "test-model",
		api: "openai-responses",
		reasoning: true,
	});
	const digests: string[] = [];
	for (const [api, headerName] of [
		["openai-responses", "x-session-id"],
		["openai-completions", "X-Session-Id"],
		["azure-openai-responses", "X-SESSION-ID"],
	] as const) {
		const headers = { [headerName]: "session-plaintext-id" };
		(harness.context as any).model = {
			provider: "custom",
			id: "test-model",
			api,
		};
		await harness.emit("before_provider_headers", { headers });
		assert.deepEqual(Object.keys(headers), [headerName]);
		assert.match(headers[headerName], /^[0-9a-f]{64}$/);
		digests.push(headers[headerName]);
	}
	assert.equal(new Set(digests).size, 1);

	const nonOpenAIHeaders = { "x-session-id": "leave-me" };
	(harness.context as any).model = {
		provider: "anthropic",
		id: "test-model",
		api: "anthropic-messages",
	};
	await harness.emit("before_provider_headers", { headers: nonOpenAIHeaders });
	assert.equal(nonOpenAIHeaders["x-session-id"], "leave-me");

	const noSessionHeaders = { "x-session-id": "leave-me-too" };
	(harness.context as any).model = {
		provider: "custom",
		id: "test-model",
		api: "openai-responses",
	};
	(harness.context as any).sessionManager.getSessionId = () => "";
	await harness.emit("before_provider_headers", { headers: noSessionHeaders });
	assert.equal(noSessionHeaders["x-session-id"], "leave-me-too");
});

test("uses Chat Completions reasoning_effort and leaves other providers alone", async () => {
	const harness = await startedHarness({
		provider: "openai",
		id: "test-model",
		api: "openai-completions",
		reasoning: true,
	});
	const payload: Record<string, any> = {};
	await harness.emit("before_provider_request", { payload });
	assert.equal(payload.reasoning_effort, "medium");
	assert.equal(payload.prompt_cache_retention, "24h");

	(harness.context as any).model = {
		provider: "anthropic",
		id: "test-model",
		api: "anthropic-messages",
		reasoning: true,
	};
	const untouched = { reasoning_effort: "low" };
	await harness.emit("before_provider_request", { payload: untouched });
	assert.deepEqual(untouched, { reasoning_effort: "low" });
});

test("injects parameters for custom OpenAI-compatible providers", async () => {
	const harness = await startedHarness({
		provider: "sunian-0-075",
		id: "test-model",
		api: "openai-responses",
		reasoning: true,
	});
	(harness.context as any).sessionManager.getSessionId = () =>
		"custom-session-id";
	const payload: Record<string, any> = {};
	await harness.emit("before_provider_request", { payload });

	assert.deepEqual(payload.reasoning, { effort: "medium" });
	assert.equal(payload.prompt_cache_retention, "24h");
	assert.match(payload.prompt_cache_key, /^[0-9a-f]{64}$/);
	assert.notEqual(payload.prompt_cache_key, "custom-session-id");

	const headers = { "x-client-request-id": "custom-session-id" };
	await harness.emit("before_provider_headers", { headers });
	assert.equal(headers["x-client-request-id"], payload.prompt_cache_key);
});

test("provider hooks ignore malformed event payloads", async () => {
	const harness = await startedHarness({
		provider: "openai",
		id: "test-model",
		api: "openai-responses",
		reasoning: true,
	});
	await assert.doesNotReject(async () => {
		await harness.emit("before_provider_request", null);
		await harness.emit("before_provider_headers", { headers: null });
	});
});

test.after(async () => {
	process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});
