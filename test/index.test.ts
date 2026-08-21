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

function makeRegistry() {
	return {
		find: (provider: string, id: string) =>
			provider === "openai" && id === "gpt-5" ? realModel : undefined,
		getAvailable: () => [realModel],
		hasConfiguredAuth: () => true,
		refresh: async () => undefined,
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
}

async function createHarness(): Promise<Harness> {
	const providers: unknown[] = [];
	const commands: Harness["commands"] = [];
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (
			name: string,
			options: { handler: Harness["commands"][number]["handler"] },
		) => commands.push({ name, handler: options.handler }),
		registerProvider: (provider: unknown) => providers.push(provider),
	} as unknown as ExtensionAPI;
	const { default: register } = (await import("../src/index.ts")) as {
		default: RegisterExtension;
	};
	await register(pi);
	return { register, providers, commands, handlers };
}

test("migrates a v5 config into a v6 generated model and registers the provider", async () => {
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
	assert.equal(raw.version, 6);
	assert.equal(raw.models.length, 1);
	assert.equal(raw.models[0].id, "default");
	assert.deepEqual(raw.models[0].chain, legacy);
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

test("first run without a config writes an empty v6 config", async () => {
	await rm(configPath, { force: true });
	await rm(modelsPath, { force: true });

	const { providers } = await createHarness();
	const provider = providers[0] as { getModels: () => Array<{ id: string }> };
	assert.deepEqual(provider.getModels(), []);

	const raw = JSON.parse(await readFile(configPath, "utf8")) as {
		version: number;
		models: unknown[];
	};
	assert.equal(raw.version, 6);
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
		JSON.stringify({ version: 6, models: [] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const { commands, handlers } = await createHarness();
	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart);
	const notifications: string[] = [];
	const ctx = {
		mode: "tui",
		modelRegistry: makeRegistry(),
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
				editor.handleInput("a");
				for (const character of "Named model") editor.handleInput(character);
				editor.handleInput("\r");
				for (let attempt = 0; attempt < 50; attempt++) {
					const raw = JSON.parse(await readFile(configPath, "utf8")) as {
						models: unknown[];
					};
					if (raw.models.length > 0 || notifications.length > 0) return;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			},
		},
	};
	await sessionStart({ reason: "startup" }, ctx);
	await commands[0]!.handler("", ctx);

	const raw = JSON.parse(await readFile(configPath, "utf8")) as {
		models: Array<{ name: string; enabled: boolean; chain: ModelRef[] }>;
	};
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
		JSON.stringify({ version: 6, models: [generated] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const { commands, handlers } = await createHarness();
	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart);
	const notifications: string[] = [];
	const ctx = {
		mode: "tui",
		modelRegistry: makeRegistry(),
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
				editor.handleInput("\r"); // open model detail
				editor.handleInput("d"); // remove the selected target
				for (let attempt = 0; attempt < 50; attempt++) {
					const raw = JSON.parse(await readFile(configPath, "utf8")) as {
						models: Array<{ enabled: boolean; chain: unknown[] }>;
					};
					if (raw.models[0]?.chain.length === 0 || notifications.length > 0) return;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			},
		},
	};
	await sessionStart({ reason: "startup" }, ctx);
	await commands[0]!.handler("", ctx);

	const raw = JSON.parse(await readFile(configPath, "utf8")) as {
		models: Array<{
			enabled: boolean;
			chain: ModelRef[];
			targetOverrides: Record<string, unknown>;
		}>;
	};
	assert.deepEqual(
		notifications.filter((message) => message.includes("Failover error")),
		[],
	);
	assert.equal(raw.models[0]!.enabled, false);
	assert.deepEqual(raw.models[0]!.chain, []);
	assert.deepEqual(raw.models[0]!.targetOverrides, {});
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

test.after(async () => {
	process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});
