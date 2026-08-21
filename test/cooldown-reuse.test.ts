import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, context: unknown) => unknown;
type Model = NonNullable<ExtensionContext["model"]>;

function makeModel(provider: string, id: string): Model {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_096,
	} as Model;
}

test("a model whose cooldown expired is eligible again in a later request", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-failover-cooldown-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const realDateNow = Date.now;
	let fakeNow = realDateNow();
	Date.now = () => fakeNow;

	try {
		const { default: registerExtension } = await import("../src/index.ts");
		const modelA = makeModel("provider-a", "model-a");
		const modelB = makeModel("provider-b", "model-b");
		const handlers = new Map<string, Handler[]>();
		const selected: string[] = [];

		const context = {
			cwd: agentDir,
			mode: "tui",
			hasUI: true,
			model: modelA,
			modelRegistry: {
				refresh: async () => {},
				getAll: () => [modelA, modelB],
				getAvailable: () => [modelA, modelB],
				find: (provider: string, id: string) =>
					[modelA, modelB].find(
						(model) => model.provider === provider && model.id === id,
					),
			},
			ui: {
				setStatus: () => undefined,
				notify: () => undefined,
				custom: async () => {},
				select: async () => undefined,
				input: async () => undefined,
			},
			isIdle: () => false,
			abort: () => undefined,
		} as unknown as ExtensionContext;

		const emit = async (event: string, value: unknown): Promise<unknown[]> => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(value, context));
			}
			return results;
		};

		const pi = {
			on: (event: string, handler: Handler) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerCommand: (_name: string, _definition: unknown) => {},
			setModel: async (model: Model) => {
				selected.push(`${model.provider}/${model.id}`);
				context.model = model;
				// Real Pi emits model_select synchronously during the internal switch,
				// while runtime.internalSelection is still set.
				await emit("model_select", { model, source: "set" });
				return true;
			},
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;

		registerExtension(pi);

		await emit("session_start", { reason: "startup" });
		const configPath = join(agentDir, "model-failover.json");
		const configured = {
			version: 4,
			enabled: true,
			paused: false,
			models: [
				{ provider: "provider-a", id: "model-a" },
				{ provider: "provider-b", id: "model-b" },
			],
			reasoningEffort: "medium",
			cooldownMinutes: 1,
			errorHandlingMode: "smart",
			maxRetries: 0,
			noProgressTimeoutSeconds: 90,
			manualRecovery: {},
			modelParameters: {},
		};
		await writeFile(configPath, `${JSON.stringify(configured, null, 2)}\n`);
		await emit("session_start", { reason: "startup" });

		// Request 1: A fails with 429 -> cooldown A -> switch to B -> B succeeds.
		await emit("before_agent_start", { prompt: "first" });
		await emit("agent_start", {});
		await emit("agent_end", {
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "OpenAI API error (429): rate limited",
				},
			],
		});
		await emit("agent_settled", {});
		await emit("before_agent_start", { prompt: "continuation" });
		await emit("agent_start", {});
		await emit("agent_end", {
			messages: [{ role: "assistant", stopReason: "stop" }],
		});
		await emit("agent_settled", {});
		assert.deepEqual(selected, ["provider-b/model-b"]);

		// Advance the clock past A's 1-minute cooldown.
		fakeNow += 61_000;

		// Request 2: B fails with 429 -> traversal must select A (cooldown expired).
		await emit("before_agent_start", { prompt: "second" });
		await emit("agent_start", {});
		await emit("agent_end", {
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "OpenAI API error (429): rate limited",
				},
			],
		});
		await emit("agent_settled", {});
		await emit("before_agent_start", { prompt: "continuation" });
		await emit("agent_start", {});
		await emit("agent_end", {
			messages: [{ role: "assistant", stopReason: "stop" }],
		});
		await emit("agent_settled", {});

		assert.ok(
			selected.includes("provider-a/model-a"),
			`expected A to be selected again after cooldown expiry, got: ${selected.join(", ")}`,
		);
	} finally {
		Date.now = realDateNow;
		process.env.PI_CODING_AGENT_DIR = previousAgentDir ?? "";
	}
});

test("a new request restores the first healthy model after cooldown expiry", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-failover-restore-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const realDateNow = Date.now;
	let fakeNow = realDateNow();
	Date.now = () => fakeNow;

	try {
		const { default: registerExtension } = await import("../src/index.ts");
		const modelA = makeModel("provider-a", "model-a");
		const modelB = makeModel("provider-b", "model-b");
		const handlers = new Map<string, Handler[]>();
		const selected: string[] = [];

		const context = {
			cwd: agentDir,
			mode: "tui",
			hasUI: true,
			model: modelA,
			modelRegistry: {
				refresh: async () => {},
				getAll: () => [modelA, modelB],
				getAvailable: () => [modelA, modelB],
				find: (provider: string, id: string) =>
					[modelA, modelB].find(
						(model) => model.provider === provider && model.id === id,
					),
			},
			ui: {
				setStatus: () => undefined,
				notify: () => undefined,
				custom: async () => {},
				select: async () => undefined,
				input: async () => undefined,
			},
			isIdle: () => false,
			abort: () => undefined,
		} as unknown as ExtensionContext;

		const emit = async (event: string, value: unknown): Promise<unknown[]> => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(value, context));
			}
			return results;
		};

		const pi = {
			on: (event: string, handler: Handler) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerCommand: (_name: string, _definition: unknown) => {},
			setModel: async (model: Model) => {
				selected.push(`${model.provider}/${model.id}`);
				context.model = model;
				await emit("model_select", { model, source: "set" });
				return true;
			},
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;

		registerExtension(pi);
		await emit("session_start", { reason: "startup" });
		const configPath = join(agentDir, "model-failover.json");
		const configured = {
			version: 4,
			enabled: true,
			paused: false,
			models: [
				{ provider: "provider-a", id: "model-a" },
				{ provider: "provider-b", id: "model-b" },
			],
			reasoningEffort: "medium",
			cooldownMinutes: 1,
			errorHandlingMode: "smart",
			maxRetries: 0,
			noProgressTimeoutSeconds: 90,
			manualRecovery: {},
			modelParameters: {},
		};
		await writeFile(configPath, `${JSON.stringify(configured, null, 2)}\n`);
		await emit("session_start", { reason: "startup" });

		// A fails with 429 -> cooldown A -> switch to B -> B succeeds.
		await emit("before_agent_start", { prompt: "first" });
		await emit("agent_start", {});
		await emit("agent_end", {
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "OpenAI API error (429): rate limited",
				},
			],
		});
		await emit("agent_settled", {});
		await emit("before_agent_start", { prompt: "continuation" });
		await emit("agent_start", {});
		await emit("agent_end", {
			messages: [{ role: "assistant", stopReason: "stop" }],
		});
		await emit("agent_settled", {});
		assert.deepEqual(selected, ["provider-b/model-b"]);

		// Cooldown of A expires while B is still healthy.
		fakeNow += 61_000;

		// A new request starts: the extension must restore the first healthy model (A).
		await emit("before_agent_start", { prompt: "second" });
		assert.ok(
			selected.includes("provider-a/model-a"),
			`expected A to be restored at request start after cooldown expiry, got: ${selected.join(", ")}`,
		);
	} finally {
		Date.now = realDateNow;
		process.env.PI_CODING_AGENT_DIR = previousAgentDir ?? "";
	}
});
