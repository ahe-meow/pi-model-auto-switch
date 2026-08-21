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
import type { FailoverConfig, ModelParameterToggles } from "../src/types.ts";

type Handler = (event: any, context: ExtensionContext) => unknown;
type Model = NonNullable<ExtensionContext["model"]>;
type RegisterExtension = (pi: ExtensionAPI) => void;

function makeModel(provider: string, id: string): Model {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_096,
	} as Model;
}

interface Harness {
	context: ExtensionContext;
	emit(event: string, value?: unknown): Promise<unknown[]>;
}

function createHarness(
	registerExtension: RegisterExtension,
	models: Model[],
	initialModel: Model,
): Harness {
	const handlers = new Map<string, Handler[]>();
	const context = {
		cwd: process.env.PI_CODING_AGENT_DIR,
		mode: "tui",
		hasUI: true,
		model: initialModel,
		modelRegistry: {
			refresh: async () => undefined,
			getAll: () => models,
			getAvailable: () => models,
			find: (provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id),
		},
		ui: {
			setStatus: () => undefined,
			notify: () => undefined,
			custom: async () => undefined,
			select: async () => undefined,
			input: async () => undefined,
		},
		isIdle: () => false,
		sessionManager: { getSessionId: () => "test-session" },
		abort: () => undefined,
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: () => undefined,
		setModel: async (model: Model) => {
			(context as { model: Model }).model = model;
			return true;
		},
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	registerExtension(pi);
	return {
		context,
		emit: async (event: string, value: unknown = {}) => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(value, context));
			}
			return results;
		},
	};
}

async function writeConfig(
	path: string,
	models: Model[],
	modelParameters: Record<string, ModelParameterToggles>,
): Promise<void> {
	const config: FailoverConfig = {
		...createDefaultConfig(models.map(({ provider, id }) => ({ provider, id }))),
		noProgressTimeoutSeconds: 0,
		modelParameters,
	};
	await writeFile(path, JSON.stringify(config), "utf8");
}

function toggleSet(
	overrides: Partial<ModelParameterToggles> = {},
): ModelParameterToggles {
	return {
		promptCacheKey: true,
		promptCacheRetention: true,
		reasoningEffort: true,
		sessionAffinity: true,
		...overrides,
	};
}

// FAILOVER_CONFIG_PATH is fixed at module load from PI_CODING_AGENT_DIR, so all
// tests in this file must share one agent directory.
const agentDir = await mkdtemp(join(tmpdir(), "pi-failover-toggles-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const configPath = join(agentDir, "model-failover.json");

test("per-model toggles disable injected cache, reasoning, and session headers", async () => {
	const modelA = makeModel("provider-a", "model-a");
	await writeConfig(configPath, [modelA], {
		"provider-a/model-a": toggleSet({
			promptCacheKey: false,
			promptCacheRetention: false,
			reasoningEffort: false,
			sessionAffinity: false,
		}),
	});
	const { default: registerExtension } = await import("../src/index.ts");
	const harness = createHarness(registerExtension, [modelA], modelA);
	await harness.emit("session_start", { reason: "startup" });

	const payload: Record<string, unknown> = {
		reasoning: { effort: "low" },
		prompt_cache_key: "plaintext-session",
		prompt_cache_retention: "in_memory",
	};
	await harness.emit("before_provider_request", { payload });
	assert.deepEqual(payload, {
		reasoning: { effort: "low" },
		prompt_cache_key: "plaintext-session",
		prompt_cache_retention: "in_memory",
	});

	const headers: Record<string, string | null> = {
		"x-session-id": "plaintext-session",
	};
	await harness.emit("before_provider_headers", { headers });
	assert.deepEqual(headers, { "x-session-id": "plaintext-session" });
});

test("toggles apply per model and other models keep default injection", async () => {
	const modelA = makeModel("provider-a", "model-a");
	const modelB = makeModel("provider-b", "model-b");
	await writeConfig(configPath, [modelA, modelB], {
		"provider-a/model-a": toggleSet({
			promptCacheKey: false,
			promptCacheRetention: false,
			reasoningEffort: false,
			sessionAffinity: false,
		}),
	});
	const { default: registerExtension } = await import("../src/index.ts");
	const harness = createHarness(registerExtension, [modelA, modelB], modelA);
	await harness.emit("session_start", { reason: "startup" });

	const offPayload: Record<string, unknown> = {};
	await harness.emit("before_provider_request", { payload: offPayload });
	assert.deepEqual(offPayload, {});

	(harness.context as { model: Model }).model = modelB;
	const onPayload: Record<string, unknown> = {};
	await harness.emit("before_provider_request", { payload: onPayload });
	assert.equal(onPayload.prompt_cache_retention, "24h");
	assert.match(onPayload.prompt_cache_key as string, /^[0-9a-f]{64}$/);
	assert.deepEqual(onPayload.reasoning, { effort: "medium" });

	const headers: Record<string, string | null> = { "x-session-id": "plain" };
	await harness.emit("before_provider_headers", { headers });
	assert.match(headers["x-session-id"] ?? "", /^[0-9a-f]{64}$/);
});

test("partial toggles leave disabled parameters untouched", async () => {
	const modelA = makeModel("provider-a", "model-a");
	await writeConfig(configPath, [modelA], {
		"provider-a/model-a": toggleSet({ promptCacheRetention: false }),
	});
	const { default: registerExtension } = await import("../src/index.ts");
	const harness = createHarness(registerExtension, [modelA], modelA);
	await harness.emit("session_start", { reason: "startup" });

	const payload: Record<string, unknown> = {
		prompt_cache_retention: "in_memory",
	};
	await harness.emit("before_provider_request", { payload });
	assert.equal(payload.prompt_cache_retention, "in_memory");
	assert.match(payload.prompt_cache_key as string, /^[0-9a-f]{64}$/);
	assert.deepEqual(payload.reasoning, { effort: "medium" });
});

test.after(async () => {
	process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});
