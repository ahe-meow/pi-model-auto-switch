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

/** Drive the real /failover TUI with one key sequence, then wait for the queued action. */
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

async function driveFailoverTui(
	keys: readonly string[],
): Promise<{ notifications: string[]; config: () => Promise<RawConfig> }> {
	const { commands, handlers } = await createHarness();
	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart);
	const notifications: string[] = [];
	const readConfig = async (): Promise<RawConfig> =>
		JSON.parse(await readFile(configPath, "utf8")) as RawConfig;
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
				for (const key of keys) editor.handleInput(key);
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
		cooldownMinutes: number;
		targetOverrides: Record<string, unknown>;
	}>;
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
		JSON.stringify({ version: 6, models: [generated] }),
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
		JSON.stringify({ version: 6, models: [] }),
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
		JSON.stringify({ version: 6, models: [draft] }),
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
	entry.cooldownMinutes = 30;
	await writeFile(
		configPath,
		JSON.stringify({ version: 6, models: [entry] }),
		"utf8",
	);
	await rm(modelsPath, { force: true });

	const { notifications, config } = await driveFailoverTui([
		"\r", // open the model detail
		"t", // settings menu
		"\x1b[B", // move to Cooldown
		"\r", // start editing
		"\x7f",
		"\x7f", // clear "30"
		"\r", // commit an empty value
	]);
	const raw = await config();
	assert.equal(raw.models[0]!.cooldownMinutes, 30);
	assert.ok(notifications.some((message) => /cooldown/i.test(message)));
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
