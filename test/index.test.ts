import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDefaultConfig } from "../src/config.ts";
import { createGeneratedModel } from "../src/generated-config.ts";
import type { ModelRef } from "../src/types.ts";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type RegisterExtension = (pi: ExtensionAPI) => Promise<void>;

const agentDir = await mkdtemp(join(tmpdir(), "pi-failover-index-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const configPath = join(agentDir, "model-failover.json");
const modelsPath = join(agentDir, "models.json");

const realModel = {
	provider: "openai",
	id: "gpt-5",
	name: "gpt-5",
	api: "openai-responses",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

const secondaryModel = {
	...realModel,
	id: "gpt-4o",
	name: "gpt-4o",
};

function generatedV6Config(): Record<string, unknown> {
	const model = createGeneratedModel([{ provider: "openai", id: "gpt-5" }]);
	return {
		version: 6,
		models: [{ ...model, cooldownMinutes: 30 }],
	};
}

type TestModel = typeof realModel;
type RegistryComplete = (
	model: unknown,
	context: unknown,
	options: unknown,
) => Promise<unknown>;

function makeRegistry(
	models: readonly TestModel[] = [realModel],
	complete?: RegistryComplete,
) {
	return {
		find: (provider: string, id: string) =>
			models.find((model) => model.provider === provider && model.id === id),
		getAvailable: () => [...models],
		hasConfiguredAuth: () => true,
		refresh: async () => undefined,
		...(complete ? { complete } : {}),
	};
}

function providerMessage(
	model: TestModel,
	stopReason: "stop" | "error",
	errorMessage?: string,
): Record<string, unknown> {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

interface Harness {
	register: RegisterExtension;
	providers: unknown[];
	commands: Array<{
		name: string;
		handler: (args: string, ctx: unknown) => unknown;
	}>;
	handlers: Map<string, Handler>;
	modelSelections: unknown[];
}

async function createHarness(): Promise<Harness> {
	const providers: unknown[] = [];
	const commands: Harness["commands"] = [];
	const handlers = new Map<string, Handler>();
	const modelSelections: unknown[] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (
			name: string,
			options: { handler: Harness["commands"][number]["handler"] },
		) => commands.push({ name, handler: options.handler }),
		registerProvider: (provider: unknown) => providers.push(provider),
		setModel: async (model: unknown) => {
			modelSelections.push(model);
			return true;
		},
	} as unknown as ExtensionAPI;
	const { default: register } = (await import("../src/index.ts")) as {
		default: RegisterExtension;
	};
	await register(pi);
	return { register, providers, commands, handlers, modelSelections };
}

/** Snapshot both managed files so "work finished" means both stopped changing. */
async function stateSnapshot(): Promise<string> {
	const read = async (path: string) => {
		try {
			return await readFile(path, "utf8");
		} catch {
			return "";
		}
	};
	return `${await read(configPath)}\u0000${await read(modelsPath)}`;
}

interface TuiDriveOptions {
	harness?: Harness;
	registry?: unknown;
	waitForDisk?: boolean;
}

async function driveFailoverTui(
	keys: readonly string[],
	options: TuiDriveOptions = {},
): Promise<{ notifications: string[]; config: () => Promise<RawConfig> }> {
	const harness = options.harness ?? (await createHarness());
	const { commands, handlers } = harness;
	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart);
	const notifications: string[] = [];
	const readConfig = async (): Promise<RawConfig> =>
		JSON.parse(await readFile(configPath, "utf8")) as RawConfig;
	const ctx = {
		mode: "tui",
		modelRegistry: options.registry ?? makeRegistry(),
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
			custom: async (
				create: (
					tui: { requestRender(): void },
					theme: unknown,
					keybindings: unknown,
					done: () => void,
				) => { handleInput(data: string): void },
			) => {
				const editor = create(
					{ requestRender: () => undefined },
					{ fg: (_color: string, text: string) => text },
					{},
					() => undefined,
				);
				for (const key of keys) editor.handleInput(key);
				if (options.waitForDisk === false) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					return;
				}
				// Wait for queued persistence to finish: leaking writes into the next
				// test would overwrite its fixture.
				let previous = await stateSnapshot();
				let changed = false;
				let stable = 0;
				for (let attempt = 0; attempt < 200; attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 10));
					const current = await stateSnapshot();
					if (current !== previous) {
						previous = current;
						changed = true;
						stable = 0;
						continue;
					}
					if ((changed || notifications.length > 0) && ++stable >= 3) return;
				}
			},
		},
	};
	await sessionStart({ reason: "startup" }, ctx);
	await commands[0]!.handler("", ctx);
	return { notifications, config: readConfig };
}

interface RawConfig {
	version: number;
	models: Array<{
		id: string;
		name: string;
		enabled: boolean;
		chain: ModelRef[];
		maxRetries: number;
		targetOverrides: Record<string, unknown>;
		manualRecovery: Record<string, string>;
	}>;
}

test("migrates a v5 config into a v7 generated model and registers the provider", async () => {
	const legacy: ModelRef[] = [{ provider: "openai", id: "gpt-5" }];
	await writeFile(
		configPath,
		JSON.stringify({ ...createDefaultConfig(legacy), enabled: true }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const { providers } = await createHarness();

	assert.equal(providers.length, 1);
	const provider = providers[0] as {
		id: string;
		getModels: () => Array<{ id: string }>;
	};
	assert.equal(provider.id, "failover");
	const virtual = provider.getModels();
	assert.deepEqual(
		virtual.map((model) => model.id),
		["default"],
	);

	const raw = JSON.parse(await readFile(configPath, "utf8")) as {
		version: number;
		models: Array<{ id: string; chain: ModelRef[] }>;
	};
	assert.equal(raw.version, 7);
	assert.equal(raw.models.length, 1);
	assert.equal(raw.models[0].id, "default");
	assert.deepEqual(raw.models[0].chain, legacy);
});

test("v6 migration conflict keeps the validated provider and warns without overwriting newer config", async () => {
	const original = JSON.stringify(generatedV6Config());
	await writeFile(configPath, original, "utf8");
	await rm(modelsPath, { force: true });
	const lockPath = `${configPath}.lock`;
	await writeFile(
		lockPath,
		JSON.stringify({ pid: process.pid, createdAt: Date.now(), owner: "test" }),
		"utf8",
	);
	const newer = '{"version":7,"models":[]}\n';
	const release = new Promise<void>((resolve, reject) => {
		setTimeout(async () => {
			try {
				await writeFile(configPath, newer, "utf8");
				await rm(lockPath);
				resolve();
			} catch (error) {
				reject(error);
			}
		}, 25);
	});

	const { providers, handlers } = await createHarness();
	await release;
	const provider = providers[0] as { getModels: () => Array<{ id: string }> };
	assert.deepEqual(
		provider.getModels().map((model) => model.id),
		["default"],
	);

	const warnings: string[] = [];
	const handler = handlers.get("session_start");
	assert.ok(handler);
	await handler({ reason: "startup" }, {
		mode: "tui",
		modelRegistry: makeRegistry(),
		ui: { notify: (message: string) => warnings.push(message) },
	} as unknown);
	assert.ok(
		warnings.some((message) => /migration was not persisted/.test(message)),
	);
	assert.equal(await readFile(configPath, "utf8"), newer);
});

test("v6 migration save errors warn and still register the validated provider", async () => {
	const original = JSON.stringify(generatedV6Config());
	await writeFile(configPath, original, "utf8");
	await rm(modelsPath, { force: true });
	const lockPath = `${configPath}.lock`;
	await writeFile(
		lockPath,
		JSON.stringify({ pid: process.pid, createdAt: Date.now(), owner: "test" }),
		"utf8",
	);

	const { providers, handlers } = await createHarness();
	await rm(lockPath);
	const provider = providers[0] as { getModels: () => Array<{ id: string }> };
	assert.deepEqual(
		provider.getModels().map((model) => model.id),
		["default"],
	);

	const warnings: string[] = [];
	const handler = handlers.get("session_start");
	assert.ok(handler);
	await handler({ reason: "startup" }, {
		mode: "tui",
		modelRegistry: makeRegistry(),
		ui: { notify: (message: string) => warnings.push(message) },
	} as unknown);
	assert.ok(warnings.some((message) => /could not be persisted/.test(message)));
	assert.equal(await readFile(configPath, "utf8"), original);
});
test("reconciles models.json after session_start with a live registry", async () => {
	const legacy: ModelRef[] = [{ provider: "openai", id: "gpt-5" }];
	await writeFile(
		configPath,
		JSON.stringify({ ...createDefaultConfig(legacy), enabled: true }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const { handlers } = await createHarness();
	const handler = handlers.get("session_start");
	assert.ok(handler);
	await handler({ reason: "startup" }, {
		mode: "tui",
		modelRegistry: makeRegistry(),
		ui: { notify: () => undefined },
	} as unknown);

	const raw = JSON.parse(await readFile(modelsPath, "utf8")) as {
		providers: { failover: { name: string; models: Array<{ id: string }> } };
	};
	assert.equal(raw.providers.failover.name, "Failover");
	assert.deepEqual(
		raw.providers.failover.models.map((model) => model.id),
		["default"],
	);
});

test("first run without a config writes an empty v7 config", async () => {
	await rm(configPath, { force: true });
	await rm(modelsPath, { force: true });

	const { providers } = await createHarness();
	const provider = providers[0] as { getModels: () => Array<{ id: string }> };
	assert.deepEqual(provider.getModels(), []);

	const raw = JSON.parse(await readFile(configPath, "utf8")) as {
		version: number;
		models: unknown[];
	};
	assert.equal(raw.version, 7);
	assert.deepEqual(raw.models, []);
});

test("blocked config fails closed: no catalog writes, no provider models, warning kept", async () => {
	await writeFile(configPath, "{broken", "utf8");
	await rm(modelsPath, { force: true });

	const { providers, handlers } = await createHarness();
	const provider = providers[0] as { getModels: () => Array<{ id: string }> };
	assert.deepEqual(provider.getModels(), []);

	const warnings: string[] = [];
	const ctx = {
		mode: "tui",
		modelRegistry: makeRegistry(),
		ui: {
			notify: (message: string) => warnings.push(message),
			setStatus: () => undefined,
		},
	};
	const handler = handlers.get("session_start");
	assert.ok(handler);
	await handler({ reason: "startup" }, ctx);
	assert.ok(
		warnings.some((message) => message.includes("Failover config unavailable")),
	);
	await assert.rejects(readFile(modelsPath), /ENOENT/);
});

test("adding a named model persists a disabled draft before targets are selected", async () => {
	await writeFile(
		configPath,
		JSON.stringify({ version: 7, models: [] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const { notifications, config } = await driveFailoverTui([
		"a",
		..."Named model",
		"\r",
	]);
	const raw = await config();
	assert.deepEqual(
		notifications.filter((message) => message.includes("Failover error")),
		[],
	);
	assert.equal(raw.models.length, 1);
	assert.deepEqual(
		{
			name: raw.models[0]!.name,
			enabled: raw.models[0]!.enabled,
			chain: raw.models[0]!.chain,
		},
		{ name: "Named model", enabled: false, chain: [] },
	);
});

test("removing the last target disables the model instead of failing validation", async () => {
	const generated = createGeneratedModel([{ provider: "openai", id: "gpt-5" }]);
	generated.id = "default";
	generated.enabled = true;
	generated.targetOverrides = {
		"openai/gpt-5": { reasoningEffort: "high" },
	};
	await writeFile(
		configPath,
		JSON.stringify({ version: 7, models: [generated] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const { notifications, config } = await driveFailoverTui([
		"\r", // open the model detail
		"d", // remove the selected target
	]);

	const raw = await config();
	assert.deepEqual(
		notifications.filter((message) => message.includes("Failover error")),
		[],
	);
	assert.equal(raw.models[0]!.enabled, false);
	assert.deepEqual(raw.models[0]!.chain, []);
	assert.deepEqual(raw.models[0]!.targetOverrides, {});
});

test("a model name starting with a digit still persists a valid generated id", async () => {
	await writeFile(
		configPath,
		JSON.stringify({ version: 7, models: [] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const { notifications, config } = await driveFailoverTui([
		"a",
		..."2nd chain",
		"\r",
	]);
	const raw = await config();
	assert.deepEqual(
		notifications.filter((message) => message.includes("Failover error")),
		[],
	);
	assert.equal(raw.models.length, 1);
	assert.match(raw.models[0]!.id, /^[a-z][a-z0-9_-]*$/);
	assert.equal(raw.models[0]!.name, "2nd chain");
});

test("enabling a model without targets warns instead of throwing", async () => {
	const draft = createGeneratedModel([]);
	draft.id = "draft";
	draft.name = "Draft";
	draft.enabled = false;
	await writeFile(
		configPath,
		JSON.stringify({ version: 7, models: [draft] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const { notifications, config } = await driveFailoverTui(["e"]);
	const raw = await config();
	assert.equal(raw.models[0]!.enabled, false);
	assert.deepEqual(
		notifications.filter((message) => message.includes("Failover error")),
		[],
	);
	assert.ok(notifications.some((message) => /target/i.test(message)));
});

test("clearing a numeric setting is rejected instead of silently saving 0", async () => {
	const entry = createGeneratedModel([{ provider: "openai", id: "gpt-5" }]);
	entry.id = "default";
	entry.enabled = true;
	entry.maxRetries = 3;
	await writeFile(
		configPath,
		JSON.stringify({ version: 7, models: [entry] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const { notifications, config } = await driveFailoverTui([
		"\r", // open the model detail
		"t", // settings menu
		"\x1b[B",
		"\x1b[B", // move to Max retries
		"\r", // start editing
		"\x7f", // clear "3"
		"\r", // commit an empty value
	]);
	const raw = await config();
	assert.equal(raw.models[0]!.maxRetries, 3);
	assert.ok(notifications.some((message) => /max retries/i.test(message)));
});

test("registers the /failover command", async () => {
	await writeFile(
		configPath,
		JSON.stringify(createDefaultConfig([{ provider: "openai", id: "gpt-5" }])),
		"utf8",
	);
	const { commands } = await createHarness();
	assert.equal(commands.length, 1);
	assert.equal(commands[0]!.name, "failover");
});

test("footer reports the real target and effective thinking level", async () => {
	const entry = createGeneratedModel([{ provider: "openai", id: "gpt-5" }]);
	entry.reasoningEffort = "high";
	await writeFile(
		configPath,
		JSON.stringify({ version: 7, models: [entry] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });
	const { providers, handlers } = await createHarness();
	const statuses: string[] = [];
	const handler = handlers.get("session_start");
	assert.ok(handler);
	const result = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		stopReason: "stop",
		timestamp: 1,
	};
	const registry = {
		...makeRegistry(),
		complete: async () => result,
	};
	await handler({ reason: "startup" }, {
		mode: "tui",
		modelRegistry: registry,
		ui: {
			notify: () => undefined,
			setStatus: (_key: string, value: string) => statuses.push(value),
		},
	} as unknown);
	const provider = providers[0] as {
		stream: (
			model: { id: string },
			context: unknown,
			options: unknown,
		) => { result(): Promise<unknown> };
	};
	await provider.stream({ id: "default" }, {}, {}).result();
	assert.ok(
		statuses.some(
			(value) => value === "Failover: real openai/gpt-5 | thinking high",
		),
	);
});

test("/failover history opens a closable custom panel", async () => {
	const { commands } = await createHarness();
	let rendered = "";
	let closed = false;
	await commands[0]!.handler("history", {
		mode: "tui",
		ui: {
			notify: () => undefined,
			custom: async (
				create: (
					tui: { requestRender(): void },
					theme: unknown,
					keybindings: unknown,
					done: () => void,
				) => {
					render(width: number): string[];
					handleInput(data: string): void;
					invalidate(): void;
				},
			) => {
				const panel = create(
					{ requestRender: () => undefined },
					{ fg: (_color: string, text: string) => text },
					{},
					() => {
						closed = true;
					},
				);
				rendered = panel.render(120).join("\n");
				panel.handleInput("q");
			},
		},
	} as unknown);
	assert.match(rendered, /Failover History/);
	assert.equal(closed, true);
});

test("model-level Reset cooldown clears only the selected model without writing config", async () => {
	const primary = createGeneratedModel([{ provider: "openai", id: "gpt-5" }]);
	primary.id = "primary";
	primary.name = "Primary";
	primary.errorHandlingMode = "switch";
	primary.maxRetries = 0;
	const secondary = createGeneratedModel([{ provider: "openai", id: "gpt-5" }]);
	secondary.id = "secondary";
	secondary.name = "Secondary";
	secondary.errorHandlingMode = "switch";
	secondary.maxRetries = 0;
	await writeFile(
		configPath,
		JSON.stringify({ version: 7, models: [primary, secondary] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const completeCalls: string[] = [];
	let failuresRemaining = 2;
	const registry = makeRegistry(
		[realModel],
		async (model, _context, options) => {
			completeCalls.push((model as TestModel).id);
			if (failuresRemaining > 0) {
				failuresRemaining -= 1;
				await (
					options as {
						onResponse?: (response: {
							status: number;
							headers: Record<string, string>;
						}) => Promise<void>;
					}
				).onResponse?.({ status: 500, headers: {} });
				return providerMessage(realModel, "error", "HTTP error (500)");
			}
			return providerMessage(realModel, "stop");
		},
	);

	const harness = await createHarness();
	const { providers } = harness;
	const provider = providers[0] as {
		stream: (
			model: { id: string },
			context: unknown,
			options: unknown,
		) => { result(): Promise<{ stopReason: string; errorMessage?: string }> };
	};

	// Prime the registry through session_start, then arm one cooldown per model.
	await driveFailoverTui([], { harness, registry, waitForDisk: true });
	await provider.stream({ id: "primary" }, {}, {}).result();
	await provider.stream({ id: "secondary" }, {}, {}).result();
	assert.deepEqual(completeCalls, ["gpt-5", "gpt-5"]);

	const before = await stateSnapshot();
	await driveFailoverTui(
		[
			"\r", // open primary detail
			"t", // settings
			"\x1b[B",
			"\x1b[B",
			"\x1b[B",
			"\x1b[B", // down to Reset cooldown
			"\r", // trigger
		],
		{ harness, registry, waitForDisk: false },
	);
	assert.equal(await stateSnapshot(), before);

	const resetResult = await provider.stream({ id: "primary" }, {}, {}).result();
	assert.equal(resetResult.stopReason, "stop");
	const untouchedResult = await provider
		.stream({ id: "secondary" }, {}, {})
		.result();
	assert.equal(untouchedResult.stopReason, "error");
	assert.match(untouchedResult.errorMessage ?? "", /no eligible targets/);
	assert.deepEqual(completeCalls, ["gpt-5", "gpt-5", "gpt-5"]);
});

test("Restore clears cooldown and manual recovery without selecting Pi's model", async () => {
	const entry = createGeneratedModel([
		{ provider: "openai", id: "gpt-5" },
		{ provider: "openai", id: "gpt-4o" },
	]);
	entry.id = "default";
	entry.name = "Default Failover";
	entry.errorHandlingMode = "switch";
	entry.maxRetries = 0;
	entry.manualRecovery = { "openai/gpt-4o": "HTTP 401" };
	await writeFile(
		configPath,
		JSON.stringify({ version: 7, models: [entry] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const completeCalls: string[] = [];
	let firstCall = true;
	const registry = makeRegistry(
		[realModel],
		async (model, _context, options) => {
			completeCalls.push((model as TestModel).id);
			if (firstCall) {
				firstCall = false;
				await (
					options as {
						onResponse?: (response: {
							status: number;
							headers: Record<string, string>;
						}) => Promise<void>;
					}
				).onResponse?.({ status: 500, headers: {} });
				return providerMessage(realModel, "error", "HTTP error (500)");
			}
			return providerMessage(realModel, "stop");
		},
	);

	const harness = await createHarness();
	const { providers, modelSelections } = harness;
	const provider = providers[0] as {
		stream: (
			model: { id: string },
			context: unknown,
			options: unknown,
		) => { result(): Promise<{ stopReason: string }> };
	};

	await driveFailoverTui([], { harness, registry, waitForDisk: true });
	// Arm a runtime cooldown on the first target; the second target starts in
	// manual recovery from the persisted config.
	const armed = await provider.stream({ id: "default" }, {}, {}).result();
	assert.equal(armed.stopReason, "error");
	assert.deepEqual(completeCalls, ["gpt-5"]);

	const { config } = await driveFailoverTui(["\r", "r"], {
		harness,
		registry,
		waitForDisk: true,
	});
	const raw = await config();
	assert.deepEqual(raw.models[0]!.manualRecovery, {});
	assert.deepEqual(modelSelections, []);

	const restored = await provider.stream({ id: "default" }, {}, {}).result();
	assert.equal(restored.stopReason, "stop");
	assert.deepEqual(completeCalls, ["gpt-5", "gpt-5"]);
});

test("/failover history shows a real transition with both targets and the reason", async () => {
	const entry = createGeneratedModel([
		{ provider: "openai", id: "gpt-5" },
		{ provider: "openai", id: "gpt-4o" },
	]);
	entry.id = "default";
	entry.name = "Default Failover";
	entry.errorHandlingMode = "switch";
	entry.maxRetries = 0;
	await writeFile(
		configPath,
		JSON.stringify({ version: 7, models: [entry] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const registry = makeRegistry(
		[realModel, secondaryModel],
		async (model, _context, options) => {
			const modelId = (model as TestModel).id;
			if (modelId === "gpt-5") {
				await (
					options as {
						onResponse?: (response: {
							status: number;
							headers: Record<string, string>;
						}) => Promise<void>;
					}
				).onResponse?.({ status: 500, headers: {} });
				return providerMessage(realModel, "error", "HTTP error (500)");
			}
			return providerMessage(secondaryModel, "stop");
		},
	);

	const harness = await createHarness();
	const { providers, commands } = harness;
	const provider = providers[0] as {
		stream: (
			model: { id: string },
			context: unknown,
			options: unknown,
		) => { result(): Promise<unknown> };
	};

	// Fire session_start and drive a real transition.
	await driveFailoverTui([], { harness, registry, waitForDisk: true });
	await provider.stream({ id: "default" }, {}, {}).result();

	// Open /failover history and assert.
	let rendered = "";
	await commands[0]!.handler("history", {
		mode: "tui",
		ui: {
			notify: () => undefined,
			custom: async (
				create: (
					tui: { requestRender(): void },
					theme: unknown,
					keybindings: unknown,
					done: () => void,
				) => {
					render(width: number): string[];
					handleInput(data: string): void;
					invalidate(): void;
				},
			) => {
				const panel = create(
					{ requestRender: () => undefined },
					{ fg: (_color: string, text: string) => text },
					{},
					() => undefined,
				);
				rendered = panel.render(120).join("\n");
				panel.handleInput("q");
			},
		},
	} as unknown);
	assert.match(rendered, /Failover History/);
	assert.ok(rendered.includes("openai/gpt-5"), "should show first target name");
	assert.ok(
		rendered.includes("openai/gpt-4o"),
		"should show second target name",
	);
	assert.ok(rendered.includes("HTTP 500"), "should show the failure reason");
});

test.after(async () => {
	process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});
