import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createDefaultConfig } from "../src/config.ts";
import { modelKey, type FailoverConfig, type ModelRef } from "../src/types.ts";

type Handler = (event: any, context: ExtensionContext) => unknown;
type Model = NonNullable<ExtensionContext["model"]>;
type RegisterExtension = (pi: ExtensionAPI) => void;

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

interface SentMessage {
	customType: string;
	details?: { model: ModelRef; kind: "same" | "switch" };
}

interface TestComponent {
	handleInput(data: string): void;
	render(width: number): string[];
}

interface CommandDefinition {
	handler(args: string, context: ExtensionContext): unknown;
}

function createHarness(
	registerExtension: RegisterExtension,
	models: Model[],
	initialModel: Model,
) {
	const handlers = new Map<string, Handler[]>();
	const messages: SentMessage[] = [];
	const selected: string[] = [];
	const thinkingLevels: string[] = [];
	const statuses: string[] = [];
	let abortCount = 0;
	let command: CommandDefinition | undefined;
	let component: TestComponent | undefined;

	const context = {
		cwd: process.env.PI_CODING_AGENT_DIR,
		mode: "tui",
		hasUI: true,
		model: initialModel,
		thinkingLevel: "medium",
		modelRegistry: {
			refresh: async () => undefined,
			getAll: () => models,
			getAvailable: () => models,
			find: (provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id),
		},
		ui: {
			setStatus: (_id: string, value: string) => statuses.push(value),
			notify: () => undefined,
			custom: (factory: (...args: any[]) => TestComponent) =>
				new Promise<void>((resolve) => {
					component = factory(
						{ requestRender: () => undefined },
						{ fg: (_color: string, text: string) => text },
						{},
						() => resolve(),
					);
				}),
			select: async () => undefined,
			input: async () => undefined,
		},
		isIdle: () => false,
		sessionManager: { getSessionId: () => "test-session" },
		abort: () => {
			abortCount++;
		},
	} as unknown as ExtensionContext;

	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (_name: string, definition: CommandDefinition) => {
			command = definition;
		},
		setModel: async (model: Model) => {
			selected.push(`${model.provider}/${model.id}`);
			(context as { model: Model }).model = model;
			return true;
		},
		setThinkingLevel: (level: string) => {
			thinkingLevels.push(level);
			(context as { thinkingLevel: string }).thinkingLevel = level;
		},
		sendMessage: (message: SentMessage) => {
			messages.push(message);
		},
	} as unknown as ExtensionAPI;

	registerExtension(pi);

	return {
		context,
		messages,
		selected,
		thinkingLevels,
		statuses,
		get abortCount() {
			return abortCount;
		},
		get component() {
			return component;
		},
		openCommand: async () => {
			assert.ok(command);
			await command.handler("", context);
		},
		emit: async (event: string, value: unknown = {}) => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(value, context));
			}
			return results;
		},
	};
}

type Harness = ReturnType<typeof createHarness>;

async function writeConfig(
	path: string,
	models: Model[],
	overrides: Partial<FailoverConfig>,
): Promise<void> {
	const config: FailoverConfig = {
		...createDefaultConfig(models.map(({ provider, id }) => ({ provider, id }))),
		noProgressTimeoutSeconds: 0,
		...overrides,
	};
	await writeFile(path, JSON.stringify(config), "utf8");
}

async function startRequest(harness: Harness): Promise<void> {
	await harness.emit("before_agent_start", { prompt: "test" });
	await harness.emit("agent_start");
}

async function settleFailure(
	harness: Harness,
	errorMessage: string,
	stopReason = "error",
): Promise<void> {
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason, errorMessage }],
	});
	await harness.emit("agent_settled");
}

async function completeContinuation(harness: Harness): Promise<void> {
	await harness.emit("before_agent_start", { prompt: "continuation" });
	await harness.emit("agent_start");
	await harness.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop" }],
	});
	await harness.emit("agent_settled");
}

function continuationKinds(harness: Harness): Array<"same" | "switch"> {
	return harness.messages.flatMap((message) =>
		message.details ? [message.details.kind] : [],
	);
}

async function waitForConfig(
	path: string,
	predicate: (config: FailoverConfig) => boolean,
): Promise<FailoverConfig> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const config = JSON.parse(await readFile(path, "utf8")) as FailoverConfig;
		if (predicate(config)) return config;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for failover settings to persist");
}

test("persisted failover settings control runtime decisions", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-failover-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const configPath = join(agentDir, "model-failover.json");
	const modelA = makeModel("provider-a", "model-a");
	const modelB = makeModel("provider-b", "model-b");
	const modelC = makeModel("provider-c", "model-c");
	const models = [modelA, modelB, modelC];

	try {
		const { default: registerExtension } = await import("../src/index.ts");

		await t.test("session startup synchronizes Pi thinking level", async () => {
			await writeConfig(configPath, models, { reasoningEffort: "max" });
			const harness = createHarness(registerExtension, models, modelA);
			await harness.emit("session_start", { reason: "startup" });
			assert.equal(harness.context.thinkingLevel, "max");
			assert.equal(harness.thinkingLevels.at(-1), "max");
		});

		await t.test(
			"session startup and model selection synchronize the selected model override",
			async () => {
				await writeConfig(configPath, models, {
					reasoningEffort: "medium",
					modelReasoningEfforts: {
						"provider-a/model-a": "high",
						"provider-b/model-b": "low",
					},
				});
				const harness = createHarness(registerExtension, models, modelA);
				await harness.emit("session_start", { reason: "startup" });
				assert.equal(harness.context.thinkingLevel, "high");

				(harness.context as { model: Model }).model = modelB;
				await harness.emit("model_select", { model: modelB, source: "restore" });
				assert.equal(harness.context.thinkingLevel, "low");
			},
		);

		await t.test(
			"changing a non-selected model override does not resynchronize native state",
			async () => {
				await writeConfig(configPath, models, { reasoningEffort: "medium" });
				const harness = createHarness(registerExtension, models, modelA);
				const commandPromise = harness.openCommand();
				for (let attempt = 0; !harness.component && attempt < 100; attempt++) {
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				const editor = harness.component;
				assert.ok(editor);
				const before = harness.thinkingLevels.length;

				editor.handleInput("t");
				for (let index = 0; index < 4; index++) editor.handleInput("\x1b[B");
				editor.handleInput("\r");
				editor.handleInput("\x1b[C");
				editor.handleInput("\r");
				for (let index = 0; index < 2; index++) editor.handleInput("\x1b[B");
				editor.handleInput("\r");
				await waitForConfig(
					configPath,
					(config) => config.modelReasoningEfforts["provider-b/model-b"] === "low",
				);
				assert.equal(harness.thinkingLevels.length, before);

				editor.handleInput("\x1b");
				editor.handleInput("\x1b");
				editor.handleInput("q");
				await commandPromise;
			},
		);

		await t.test(
			"uninitialized provider hook preserves child-native reasoning effort",
			async () => {
				const childModel = {
					...modelA,
					api: "openai-responses",
					reasoning: true,
					thinkingLevelMap: { medium: "medium", max: "max" },
				} as Model;
				const harness = createHarness(registerExtension, [childModel], childModel);
				const payload: Record<string, unknown> = {
					reasoning: { effort: "max", summary: "auto" },
				};
				await harness.emit("before_provider_request", { payload });
				assert.deepEqual(payload, {
					reasoning: { effort: "max", summary: "auto" },
				});
				const headers = { "x-session-id": "child-native-session" };
				await harness.emit("before_provider_headers", { headers });
				assert.deepEqual(headers, { "x-session-id": "child-native-session" });
			},
		);

		await t.test(
			"disabled reasoning toggle leaves native state untouched",
			async () => {
				await writeConfig(configPath, models, {
					reasoningEffort: "max",
					modelParameters: {
						"provider-a/model-a": {
							promptCacheKey: true,
							promptCacheRetention: true,
							reasoningEffort: false,
							sessionAffinity: true,
						},
					},
				});
				const harness = createHarness(registerExtension, models, modelA);
				await harness.emit("session_start", { reason: "startup" });
				assert.equal(harness.context.thinkingLevel, "medium");
				assert.deepEqual(harness.thinkingLevels, []);
			},
		);

		await t.test(
			"changing reasoning effort synchronizes native Pi state",
			async () => {
				await writeConfig(configPath, models, { reasoningEffort: "medium" });
				const harness = createHarness(registerExtension, models, modelA);
				const commandPromise = harness.openCommand();
				for (let attempt = 0; !harness.component && attempt < 100; attempt++) {
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				const editor = harness.component;
				assert.ok(editor);
				editor.handleInput("i");
				for (let index = 0; index < 3; index++) editor.handleInput("\x1b[B");
				editor.handleInput("\r");
				await waitForConfig(
					configPath,
					(config) => config.reasoningEffort === "max",
				);
				for (let attempt = 0; attempt < 100; attempt++) {
					if (harness.context.thinkingLevel === "max") break;
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				assert.equal(harness.context.thinkingLevel, "max");
				assert.equal(harness.thinkingLevels.at(-1), "max");
				editor.handleInput("q");
				await commandPromise;
			},
		);

		await t.test("e cycles enabled, paused, and disabled", async () => {
			await writeConfig(configPath, models, { enabled: true, paused: false });
			const harness = createHarness(registerExtension, models, modelA);
			const commandPromise = harness.openCommand();
			for (let attempt = 0; !harness.component && attempt < 100; attempt++) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			const editor = harness.component;
			assert.ok(editor);
			assert.ok(
				editor.render(120).some((line) => line.includes("Automation: enabled")),
			);

			editor.handleInput("e");
			await waitForConfig(configPath, (config) => config.enabled && config.paused);
			assert.ok(
				editor.render(120).some((line) => line.includes("Automation: paused")),
			);

			editor.handleInput("e");
			await waitForConfig(
				configPath,
				(config) => !config.enabled && !config.paused,
			);
			assert.ok(
				editor.render(120).some((line) => line.includes("Automation: disabled")),
			);

			editor.handleInput("e");
			await waitForConfig(
				configPath,
				(config) => config.enabled && !config.paused,
			);
			assert.ok(
				editor.render(120).some((line) => line.includes("Automation: enabled")),
			);

			editor.handleInput("q");
			await commandPromise;
		});

		await t.test("settings editor persists every runtime control", async () => {
			await writeConfig(configPath, models, {
				cooldownMinutes: 30,
				errorHandlingMode: "smart",
				maxRetries: 1,
				noProgressTimeoutSeconds: 90,
			});
			const harness = createHarness(registerExtension, models, modelA);
			const commandPromise = harness.openCommand();
			for (let attempt = 0; !harness.component && attempt < 100; attempt++) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			const editor = harness.component;
			assert.ok(editor);

			editor.handleInput("t");
			editor.handleInput("\r");
			editor.handleInput("\x7f");
			editor.handleInput("\x7f");
			editor.handleInput("5");
			editor.handleInput("\r");

			editor.handleInput("\x1b[B");
			editor.handleInput("\r");
			editor.handleInput("\x1b[B");
			editor.handleInput("\r");

			editor.handleInput("\x1b[B");
			editor.handleInput("\r");
			editor.handleInput("\x7f");
			editor.handleInput("3");
			editor.handleInput("\r");

			editor.handleInput("\x1b[B");
			editor.handleInput("\r");
			editor.handleInput("\x7f");
			editor.handleInput("\x7f");
			editor.handleInput("15");
			editor.handleInput("\r");

			const persisted = await waitForConfig(
				configPath,
				(config) =>
					config.cooldownMinutes === 5 &&
					config.errorHandlingMode === "switch" &&
					config.maxRetries === 3 &&
					config.noProgressTimeoutSeconds === 15,
			);
			assert.deepEqual(
				{
					cooldownMinutes: persisted.cooldownMinutes,
					errorHandlingMode: persisted.errorHandlingMode,
					maxRetries: persisted.maxRetries,
					noProgressTimeoutSeconds: persisted.noProgressTimeoutSeconds,
				},
				{
					cooldownMinutes: 5,
					errorHandlingMode: "switch",
					maxRetries: 3,
					noProgressTimeoutSeconds: 15,
				},
			);

			editor.handleInput("\x1b");
			editor.handleInput("q");
			await commandPromise;
		});

		await t.test(
			"model parameter toggles persist and gate injection",
			async () => {
				await writeConfig(configPath, models, {});
				const harness = createHarness(registerExtension, models, modelA);
				const commandPromise = harness.openCommand();
				for (let attempt = 0; !harness.component && attempt < 100; attempt++) {
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				const editor = harness.component;
				assert.ok(editor);

				editor.handleInput("t");
				for (let index = 0; index < 4; index++) editor.handleInput("\x1b[B");
				editor.handleInput("\r");
				assert.ok(
					editor.render(120).some((line) => line.includes("Model Parameters")),
				);

				editor.handleInput("\x1b[B");
				editor.handleInput("\r");
				const persisted = await waitForConfig(
					configPath,
					(config) =>
						config.modelParameters["provider-a/model-a"]?.promptCacheKey === false,
				);
				for (let attempt = 0; attempt < 200; attempt++) {
					if (
						editor.render(120).some((line) => line.includes("prompt_cache_key: off"))
					)
						break;
					await new Promise<void>((resolve) => setTimeout(resolve, 10));
				}
				assert.ok(
					editor.render(120).some((line) => line.includes("prompt_cache_key: off")),
				);
				assert.deepEqual(persisted.modelParameters["provider-a/model-a"], {
					promptCacheKey: false,
					promptCacheRetention: true,
					reasoningEffort: true,
					sessionAffinity: true,
				});

				(harness.context as { model: Model }).model = {
					...modelA,
					reasoning: true,
				} as Model;
				const payload: Record<string, unknown> = {};
				await harness.emit("before_provider_request", { payload });
				assert.equal("prompt_cache_key" in payload, false);
				assert.equal(payload.prompt_cache_retention, "24h");
				assert.equal(payload.reasoning_effort, "medium");

				(harness.context as { model: Model }).model = modelB;
				const otherPayload: Record<string, unknown> = {};
				await harness.emit("before_provider_request", { payload: otherPayload });
				assert.match(otherPayload.prompt_cache_key as string, /^[0-9a-f]{64}$/);

				editor.handleInput("\x1b");
				editor.handleInput("\x1b");
				editor.handleInput("q");
				await commandPromise;
			},
		);

		await t.test(
			"removing the active model override resynchronizes the global fallback",
			async () => {
				await writeConfig(configPath, models, {
					modelReasoningEfforts: { "provider-a/model-a": "high" },
				});
				const harness = createHarness(registerExtension, models, modelA);
				await harness.emit("session_start", { reason: "startup" });
				assert.equal(harness.context.thinkingLevel, "high");
				const commandPromise = harness.openCommand();
				for (let attempt = 0; !harness.component && attempt < 100; attempt++)
					await new Promise<void>((resolve) => setImmediate(resolve));
				const editor = harness.component;
				assert.ok(editor);
				editor.handleInput("d");
				await waitForConfig(
					configPath,
					(config) => config.models.length === models.length - 1,
				);
				for (let attempt = 0; attempt < 100; attempt++) {
					if (
						(harness.context as { thinkingLevel?: string }).thinkingLevel === "medium"
					)
						break;
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				assert.equal(harness.context.thinkingLevel, "medium");
				editor.handleInput("q");
				await commandPromise;
			},
		);

		await t.test("removing a model prunes its parameter toggles", async () => {
			await writeConfig(configPath, models, {
				modelParameters: {
					"provider-a/model-a": {
						promptCacheKey: false,
						promptCacheRetention: true,
						reasoningEffort: true,
						sessionAffinity: true,
					},
				},
				modelReasoningEfforts: { "provider-a/model-a": "high" },
				manualRecovery: { "provider-a/model-a": "HTTP 401" },
			});
			const harness = createHarness(registerExtension, models, modelA);
			const commandPromise = harness.openCommand();
			for (let attempt = 0; !harness.component && attempt < 100; attempt++) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			const editor = harness.component;
			assert.ok(editor);

			editor.handleInput("d");
			const persisted = await waitForConfig(
				configPath,
				(config) => config.models.length === models.length - 1,
			);
			assert.equal(
				persisted.models.some((model) => modelKey(model) === "provider-a/model-a"),
				false,
			);
			assert.equal("provider-a/model-a" in persisted.modelParameters, false);
			assert.equal("provider-a/model-a" in persisted.modelReasoningEfforts, false);
			assert.equal("provider-a/model-a" in persisted.manualRecovery, false);

			editor.handleInput("\x1b");
			editor.handleInput("q");
			await commandPromise;
		});

		await t.test("retries without rejected prompt cache retention", async () => {
			await writeConfig(configPath, models, {
				errorHandlingMode: "switch",
				maxRetries: 0,
				reasoningEffort: "high",
			});
			const reasoningModel = { ...modelA, reasoning: true } as Model;
			const harness = createHarness(
				registerExtension,
				[reasoningModel, modelB, modelC],
				reasoningModel,
			);
			await harness.emit("session_start", { reason: "startup" });
			await startRequest(harness);

			const firstPayload: Record<string, unknown> = {};
			await harness.emit("before_provider_request", {
				payload: firstPayload,
			});
			assert.equal(firstPayload.prompt_cache_retention, "24h");
			assert.equal(typeof firstPayload.prompt_cache_key, "string");
			assert.equal(firstPayload.reasoning_effort, "high");

			await settleFailure(
				harness,
				'OpenAI API error (422): {"error":{"code":"unsupported_parameter","type":"invalid_request_error","param":"prompt_cache_retention","message":"gateway validation"}}',
			);
			assert.deepEqual(continuationKinds(harness), ["same"]);
			assert.deepEqual(harness.selected, []);

			await harness.emit("before_agent_start", { prompt: "continuation" });
			await harness.emit("agent_start");
			const retryPayload: Record<string, unknown> = { ...firstPayload };
			await harness.emit("before_provider_request", {
				payload: retryPayload,
			});
			const expectedPayload = { ...firstPayload };
			delete expectedPayload.prompt_cache_retention;
			assert.deepEqual(retryPayload, expectedPayload);

			await settleFailure(harness, "OpenAI API error (502): upstream failed");
			assert.deepEqual(continuationKinds(harness), ["same", "switch"]);
			assert.deepEqual(harness.selected, ["provider-b/model-b"]);
		});

		await t.test(
			"negotiates legacy JSON validation with a known field token",
			async () => {
				await writeConfig(configPath, models, {
					errorHandlingMode: "switch",
					maxRetries: 0,
					reasoningEffort: "high",
				});
				const reasoningModel = { ...modelA, reasoning: true } as Model;
				const harness = createHarness(
					registerExtension,
					[reasoningModel, modelB, modelC],
					reasoningModel,
				);
				await harness.emit("session_start", { reason: "startup" });
				await startRequest(harness);

				const firstPayload: Record<string, unknown> = { custom: "keep" };
				await harness.emit("before_provider_request", {
					payload: firstPayload,
				});
				assert.equal(typeof firstPayload.prompt_cache_key, "string");
				assert.equal(firstPayload.prompt_cache_retention, "24h");
				assert.equal(firstPayload.reasoning_effort, "high");

				const exactRejection =
					'Error: 400: {"message":"未知请求字段：prompt_cache_key","type":"invalid_request_error"}';
				await settleFailure(harness, exactRejection);
				assert.deepEqual(continuationKinds(harness), ["same"]);
				assert.deepEqual(harness.selected, []);

				await harness.emit("before_agent_start", { prompt: "compatibility" });
				await harness.emit("agent_start");
				const compatibilityPayload = { ...firstPayload };
				await harness.emit("before_provider_request", {
					payload: compatibilityPayload,
				});
				assert.equal("prompt_cache_key" in compatibilityPayload, false);
				assert.equal(compatibilityPayload.prompt_cache_retention, "24h");
				assert.equal(compatibilityPayload.reasoning_effort, "high");
				assert.equal(compatibilityPayload.custom, "keep");

				await settleFailure(harness, exactRejection);
				assert.deepEqual(continuationKinds(harness), ["same", "switch"]);
				assert.deepEqual(harness.selected, ["provider-b/model-b"]);

				await harness.emit("before_agent_start", { prompt: "other target" });
				await harness.emit("agent_start");
				const otherTargetPayload: Record<string, unknown> = {};
				await harness.emit("before_provider_request", {
					payload: otherTargetPayload,
				});
				assert.equal(typeof otherTargetPayload.prompt_cache_key, "string");
				assert.equal(otherTargetPayload.prompt_cache_retention, "24h");
			},
		);

		await t.test("authentication wins over cache compatibility", async () => {
			for (const errorMessage of [
				'OpenAI API error (401): {"code":"unknown_parameter","type":"invalid_request_error","param":"prompt_cache_key"}',
				'Error: 400: {"status":403,"code":"unknown_parameter","type":"invalid_request_error","param":"prompt_cache_key"}',
			]) {
				await writeConfig(configPath, models, {
					errorHandlingMode: "switch",
					maxRetries: 0,
				});
				const harness = createHarness(registerExtension, models, modelA);
				await harness.emit("session_start", { reason: "startup" });
				await startRequest(harness);
				await settleFailure(harness, errorMessage);
				assert.deepEqual(continuationKinds(harness), ["switch"]);
				assert.deepEqual(harness.selected, ["provider-b/model-b"]);
			}
		});

		await t.test(
			"does not negotiate cache fields mentioned by unrelated validation",
			async () => {
				for (const errorMessage of [
					"OpenAI API error (400): Invalid parameter prompt_cache_key: wrong value format",
					'OpenAI API error (400): {"type":"invalid_request_error","message":"tools field rejected"} {"message":"request also contained prompt_cache_key"}',
				]) {
					await writeConfig(configPath, models, {
						errorHandlingMode: "switch",
						maxRetries: 0,
					});
					const harness = createHarness(registerExtension, models, modelA);
					await harness.emit("session_start", { reason: "startup" });
					await startRequest(harness);
					await settleFailure(harness, errorMessage);
					assert.deepEqual(continuationKinds(harness), ["switch"]);
				}
			},
		);

		await t.test(
			"matches structured code, type, and parameter fields",
			async () => {
				for (const { field, errorMessage } of [
					{
						field: "prompt_cache_key",
						errorMessage:
							'OpenAI API error (400): prefix { malformed {"code":"unknown_parameter","type":"invalid_request_error","param":"prompt_cache_key","message":"any language"}',
					},
					{
						field: "prompt_cache_retention",
						errorMessage:
							'Error: {"status":400,"errors":[{"code":"unsupported_parameter","type":"invalid_request_error","field":"prompt_cache_retention","message":"any language"}]}',
					},
				] as const) {
					await writeConfig(configPath, models, {
						errorHandlingMode: "switch",
						maxRetries: 0,
					});
					const harness = createHarness(registerExtension, models, modelA);
					await harness.emit("session_start", { reason: "startup" });
					await startRequest(harness);
					await settleFailure(harness, errorMessage);
					assert.deepEqual(continuationKinds(harness), ["same"]);

					await harness.emit("before_agent_start", { prompt: "compatibility" });
					await harness.emit("agent_start");
					const payload: Record<string, unknown> = {};
					await harness.emit("before_provider_request", { payload });
					assert.equal(field in payload, false);
					assert.equal(
						field === "prompt_cache_key"
							? payload.prompt_cache_retention
							: payload.prompt_cache_key !== undefined,
						field === "prompt_cache_key" ? "24h" : true,
					);
				}
			},
		);

		await t.test("does not negotiate a value-validation error", async () => {
			await writeConfig(configPath, models, {
				errorHandlingMode: "switch",
				maxRetries: 0,
			});
			const harness = createHarness(registerExtension, models, modelA);
			await harness.emit("session_start", { reason: "startup" });
			await startRequest(harness);
			await settleFailure(
				harness,
				'OpenAI API error (400): {"code":"invalid_parameter","type":"invalid_request_error","param":"prompt_cache_key","message":"wrong format"}',
			);
			assert.deepEqual(continuationKinds(harness), ["switch"]);
		});

		await t.test(
			"smart retries transient failures up to maxRetries",
			async () => {
				await writeConfig(configPath, models, {
					errorHandlingMode: "smart",
					maxRetries: 2,
				});
				const harness = createHarness(registerExtension, models, modelA);
				await harness.emit("session_start", { reason: "startup" });
				await startRequest(harness);

				await settleFailure(harness, "OpenAI API error (502): upstream failed");
				await harness.emit("before_agent_start", { prompt: "continuation" });
				await harness.emit("agent_start");
				await settleFailure(harness, "OpenAI API error (502): upstream failed");
				await harness.emit("before_agent_start", { prompt: "continuation" });
				await harness.emit("agent_start");
				await settleFailure(harness, "OpenAI API error (502): upstream failed");

				assert.deepEqual(continuationKinds(harness), ["same", "same", "switch"]);
				assert.deepEqual(harness.selected, ["provider-b/model-b"]);
			},
		);

		await t.test("smart switches persistent failures immediately", async () => {
			await writeConfig(configPath, models, {
				errorHandlingMode: "smart",
				maxRetries: 10,
			});
			const harness = createHarness(registerExtension, models, modelA);
			await harness.emit("session_start", { reason: "startup" });
			await startRequest(harness);
			await settleFailure(harness, "OpenAI API error (401): unauthorized");

			assert.deepEqual(continuationKinds(harness), ["switch"]);
			assert.deepEqual(harness.selected, ["provider-b/model-b"]);
		});

		await t.test("switch mode bypasses retries", async () => {
			await writeConfig(configPath, models, {
				errorHandlingMode: "switch",
				maxRetries: 10,
			});
			const harness = createHarness(registerExtension, models, modelA);
			await harness.emit("session_start", { reason: "startup" });
			await startRequest(harness);
			await settleFailure(harness, "OpenAI API error (502): upstream failed");

			assert.deepEqual(continuationKinds(harness), ["switch"]);
			assert.deepEqual(harness.selected, ["provider-b/model-b"]);
		});

		await t.test(
			"retry mode retries persistent failures before switching",
			async () => {
				await writeConfig(configPath, models, {
					errorHandlingMode: "retry",
					maxRetries: 2,
				});
				const harness = createHarness(registerExtension, models, modelA);
				await harness.emit("session_start", { reason: "startup" });
				await startRequest(harness);

				await settleFailure(harness, "OpenAI API error (401): unauthorized");
				await harness.emit("before_agent_start", { prompt: "continuation" });
				await harness.emit("agent_start");
				await settleFailure(harness, "OpenAI API error (401): unauthorized");
				await harness.emit("before_agent_start", { prompt: "continuation" });
				await harness.emit("agent_start");
				await settleFailure(harness, "OpenAI API error (401): unauthorized");

				assert.deepEqual(continuationKinds(harness), ["same", "same", "switch"]);
				const persisted = JSON.parse(
					await readFile(configPath, "utf8"),
				) as FailoverConfig;
				assert.equal(persisted.manualRecovery["provider-a/model-a"], "HTTP 401");
			},
		);

		await t.test(
			"restores the first healthy model after cooldown expiry",
			async () => {
				await writeConfig(configPath, models, {
					cooldownMinutes: 1,
					errorHandlingMode: "switch",
					maxRetries: 0,
				});
				const harness = createHarness(registerExtension, models, modelA);
				const originalNow = Date.now;
				let now = 1_000_000;
				Date.now = () => now;
				try {
					await harness.emit("session_start", { reason: "startup" });
					await startRequest(harness);
					await settleFailure(harness, "OpenAI API error (502): upstream failed");
					assert.deepEqual(harness.selected, ["provider-b/model-b"]);
					await completeContinuation(harness);

					await startRequest(harness);
					await settleFailure(harness, "OpenAI API error (401): unauthorized");
					assert.deepEqual(harness.selected, [
						"provider-b/model-b",
						"provider-c/model-c",
					]);
					await completeContinuation(harness);

					now += 60_001;
					await startRequest(harness);
					assert.deepEqual(harness.selected, [
						"provider-b/model-b",
						"provider-c/model-c",
						"provider-a/model-a",
					]);
					await settleFailure(harness, "OpenAI API error (401): unauthorized");
					assert.deepEqual(harness.selected, [
						"provider-b/model-b",
						"provider-c/model-c",
						"provider-a/model-a",
						"provider-c/model-c",
					]);
				} finally {
					Date.now = originalNow;
				}
			},
		);

		await t.test(
			"no-result timeout aborts and follows retry policy",
			async () => {
				await writeConfig(configPath, models, {
					errorHandlingMode: "smart",
					maxRetries: 1,
					noProgressTimeoutSeconds: 15,
				});
				const harness = createHarness(registerExtension, models, modelA);
				await harness.emit("session_start", { reason: "startup" });
				await harness.emit("before_agent_start", { prompt: "timeout" });

				const originalSetTimeout = globalThis.setTimeout;
				const originalClearTimeout = globalThis.clearTimeout;
				let timerCallback: (() => void) | undefined;
				let timerDelay: number | undefined;
				globalThis.setTimeout = ((callback: () => void, delay?: number) => {
					timerCallback = callback;
					timerDelay = delay;
					return 1 as unknown as ReturnType<typeof setTimeout>;
				}) as unknown as typeof setTimeout;
				globalThis.clearTimeout = (() =>
					undefined) as unknown as typeof clearTimeout;
				try {
					await harness.emit("agent_start");
					assert.equal(timerDelay, 15_000);
					assert.ok(timerCallback);
					timerCallback();
				} finally {
					globalThis.setTimeout = originalSetTimeout;
					globalThis.clearTimeout = originalClearTimeout;
				}

				assert.equal(harness.abortCount, 1);
				await settleFailure(harness, "request aborted", "aborted");
				assert.deepEqual(continuationKinds(harness), ["same"]);
			},
		);

		await t.test(
			"duplicate settlement does not duplicate continuation",
			async () => {
				await writeConfig(configPath, models, {
					errorHandlingMode: "switch",
					maxRetries: 0,
				});
				const harness = createHarness(registerExtension, models, modelA);
				await harness.emit("session_start", { reason: "startup" });
				await startRequest(harness);
				await settleFailure(harness, "OpenAI API error (502): upstream failed");
				await settleFailure(harness, "OpenAI API error (502): duplicate event");
				assert.deepEqual(continuationKinds(harness), ["switch"]);
			},
		);

		await t.test("zero timeout does not schedule an abort", async () => {
			await writeConfig(configPath, models, {
				noProgressTimeoutSeconds: 0,
			});
			const harness = createHarness(registerExtension, models, modelA);
			await harness.emit("session_start", { reason: "startup" });
			await harness.emit("before_agent_start", { prompt: "no timeout" });

			const originalSetTimeout = globalThis.setTimeout;
			let scheduled = false;
			globalThis.setTimeout = (() => {
				scheduled = true;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			}) as unknown as typeof setTimeout;
			try {
				await harness.emit("agent_start");
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}

			assert.equal(scheduled, false);
			assert.equal(harness.abortCount, 0);
		});
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});
