import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDefaultConfig } from "../src/config.ts";
import {
	createGeneratedConfigV8,
	createGeneratedModel,
} from "../src/generated-config.ts";
import {
	createFileSharedState,
	type SharedStateAdapter,
} from "../src/shared-state.ts";
import type {
	GeneratedFailoverModelV8,
	ModelRef,
	ReasoningEffort,
} from "../src/types.ts";

const agentDir = await mkdtemp(join(tmpdir(), "pi-failover-index-v8-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const configPath = join(agentDir, "model-failover.json");
const settingsPath = join(agentDir, "settings.json");
const modelsPath = join(agentDir, "models.json");
const sharedPath = join(agentDir, "shared-state.json");
const sessionPath = join(agentDir, "session.jsonl");
const transitionEntryType = "pi-model-failover/transition-v1";
const modelsBytes =
	'{"custom":{"keep":true},"providers":{"fixture":{"models":[]}}}\n';

const targetA = { provider: "openai", id: "gpt-5" } as const;
const targetB = { provider: "openai", id: "gpt-4o" } as const;
const targetC = { provider: "anthropic", id: "claude" } as const;
const targetD = { provider: "google", id: "gemini" } as const;

interface TestModel {
	provider: string;
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	reasoning: boolean;
	input: readonly ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Partial<Record<ReasoningEffort, string | null>>;
}

const modelA: TestModel = {
	provider: targetA.provider,
	id: targetA.id,
	name: targetA.id,
	api: "openai-responses",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 16_384,
};
const modelB: TestModel = { ...modelA, id: targetB.id, name: targetB.id };
const modelC: TestModel = {
	...modelA,
	provider: targetC.provider,
	id: targetC.id,
	name: targetC.id,
	api: "anthropic-messages",
};
const modelD: TestModel = {
	...modelA,
	provider: targetD.provider,
	id: targetD.id,
	name: targetD.id,
};

type Complete = (
	model: TestModel,
	context: unknown,
	options: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

type RegisterExtension = (
	pi: ExtensionAPI,
	targetRuntime?: unknown,
	sharedState?: SharedStateAdapter,
) => Promise<void>;

function providerMessage(
	model: TestModel,
	stopReason: "stop" | "error",
	errorMessage?: string,
	status?: number,
): Record<string, unknown> {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		...(status === undefined ? {} : { status }),
		timestamp: Date.now(),
	};
}

function makeTargetRuntime(
	models: readonly TestModel[] = [modelA, modelB, modelC],
	initialComplete?: Complete,
) {
	let available = [...models];
	let complete: Complete =
		initialComplete ?? (async (model) => providerMessage(model, "stop"));
	return {
		initialAvailabilityKnown: true,
		setModels(next: readonly TestModel[]) {
			available = [...next];
		},
		setComplete(next: Complete) {
			complete = next;
		},
		getModel(provider: string, id: string) {
			return available.find(
				(model) => model.provider === provider && model.id === id,
			);
		},
		getAvailableSnapshot() {
			return [...available];
		},
		hasConfiguredAuth(provider: string) {
			return available.some((model) => model.provider === provider);
		},
		async refresh() {
			return undefined;
		},
		completeSimple(model: TestModel, context: unknown, options: unknown) {
			return complete(model, context, options as Record<string, unknown>);
		},
		streamSimple(model: TestModel, context: unknown, options: unknown) {
			let resultPromise: Promise<Record<string, unknown>> | undefined;
			const result = () => {
				resultPromise ??= complete(
					model,
					context,
					options as Record<string, unknown>,
				);
				return resultPromise;
			};
			return {
				async *[Symbol.asyncIterator]() {
					const message = await result();
					yield { type: "done", reason: message.stopReason, message };
				},
				result,
			};
		},
	};
}

type TargetRuntimeHarness = ReturnType<typeof makeTargetRuntime>;

interface Harness {
	providers: unknown[];
	commands: Array<{
		name: string;
		handler: (args: string, ctx: unknown) => unknown | Promise<unknown>;
	}>;
	handlers: Map<string, Handler>;
	appendedEntries: Array<{ customType: string; data: unknown }>;
	targetRuntime: TargetRuntimeHarness;
	sharedState: SharedStateAdapter;
}

async function createHarness(
	options: {
		targetRuntime?: TargetRuntimeHarness;
		sharedState?: SharedStateAdapter;
	} = {},
): Promise<Harness> {
	const targetRuntime = options.targetRuntime ?? makeTargetRuntime();
	const sharedState =
		options.sharedState ??
		createFileSharedState({ path: sharedPath });
	const providers: unknown[] = [];
	const commands: Harness["commands"] = [];
	const handlers = new Map<string, Handler>();
	const appendedEntries: Harness["appendedEntries"] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (
			name: string,
			options: { handler: Harness["commands"][number]["handler"] },
		) => commands.push({ name, handler: options.handler }),
		registerProvider: (provider: unknown) => providers.push(provider),
		appendEntry: (customType: string, data: unknown) =>
			appendedEntries.push({ customType, data }),
	} as unknown as ExtensionAPI;
	const { registerFailoverExtension } = (await import("../src/index.ts")) as {
		registerFailoverExtension: RegisterExtension;
	};
	await registerFailoverExtension(pi, targetRuntime, sharedState);
	return {
		providers,
		commands,
		handlers,
		appendedEntries,
		targetRuntime,
		sharedState,
	};
}

function failoverProvider(harness: Harness) {
	return harness.providers[0] as {
		id: string;
		getModels(): Array<{ id: string }>;
		filterModels(models: Array<{ id: string }>): Array<{ id: string }>;
		stream(
			model: { id: string },
			context: unknown,
			options: unknown,
		): { result(): Promise<Record<string, unknown>> };
	};
}

async function resetFiles(): Promise<void> {
	for (const path of [
		configPath,
		`${configPath}.lock`,
		settingsPath,
		sharedPath,
		`${sharedPath}.lock`,
	])
		await rm(path, { force: true, recursive: true });
	await writeFile(modelsPath, modelsBytes, "utf8");
}

function createContext(
	options: {
		cwd?: string;
		notifications?: string[];
		statuses?: string[];
		custom?: (create: Function) => Promise<void>;
		sessionEntries?: readonly unknown[];
		sessionFile?: string | null;
	} = {},
) {
	const notifications = options.notifications ?? [];
	const statuses = options.statuses ?? [];
	const sessionEntries = options.sessionEntries ?? [];
	const sessionFile =
		options.sessionFile === null
			? undefined
			: (options.sessionFile ?? sessionPath);
	return {
		mode: "tui",
		cwd: options.cwd ?? agentDir,
		sessionManager: {
			getEntries: () => [...sessionEntries],
			getSessionFile: () => sessionFile,
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string) => statuses.push(value),
			custom:
				options.custom ??
				(async () => {
					return undefined;
				}),
		},
	};
}

async function startSession(
	harness: Harness,
	notifications: string[] = [],
	statuses: string[] = [],
	sessionEntries: readonly unknown[] = [],
	sessionFile: string | null = sessionPath,
): Promise<ReturnType<typeof createContext>> {
	const ctx = createContext({
		notifications,
		statuses,
		sessionEntries,
		sessionFile,
	});
	const handler = harness.handlers.get("session_start");
	assert.ok(handler);
	await handler({ reason: "startup" }, ctx);
	return ctx;
}

interface TestEditor {
	handleInput(data: string): void;
	render(width: number): string[];
	whenIdle(): Promise<void>;
}

async function openEditor(
	harness: Harness,
	notifications: string[] = [],
	onClose: () => void = () => undefined,
): Promise<TestEditor> {
	let editor: TestEditor | undefined;
	await harness.commands[0]!.handler(
		"",
		createContext({
			notifications,
			custom: async (create) => {
				editor = create(
					{ requestRender: () => undefined },
					{ fg: (_color: string, text: string) => text },
					{},
					onClose,
				) as TestEditor;
			},
		}),
	);
	if (!editor) throw new Error("failover editor was not created");
	return editor;
}

async function renderHistory(
	harness: Harness,
): Promise<{ rendered: string; closed: boolean }> {
	let rendered = "";
	let closed = false;
	await harness.commands[0]!.handler("history", {
		mode: "tui",
		ui: {
			notify: () => undefined,
			custom: async (create: Function) => {
				const panel = create(
					{ requestRender: () => undefined },
					{ fg: (_color: string, text: string) => text },
					{},
					() => {
						closed = true;
					},
				) as {
					render(width: number): string[];
					handleInput(data: string): void;
				};
				rendered = panel.render(120).join("\n");
				panel.handleInput("q");
			},
		},
	});
	return { rendered, closed };
}

function localHistoryTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function driveEditor(
	harness: Harness,
	keys: readonly string[],
): Promise<{ notifications: string[]; statuses: string[] }> {
	const notifications: string[] = [];
	const statuses: string[] = [];
	await startSession(harness, notifications, statuses);
	let editor:
		| {
				handleInput(data: string): void;
				render(width: number): string[];
				whenIdle(): Promise<void>;
		  }
		| undefined;
	const ctx = createContext({
		notifications,
		statuses,
		custom: async (create) => {
			const currentEditor = create(
				{ requestRender: () => undefined },
				{ fg: (_color: string, text: string) => text },
				{},
				() => undefined,
			) as {
				handleInput(data: string): void;
				render(width: number): string[];
				whenIdle(): Promise<void>;
			};
			editor = currentEditor;
			currentEditor.render(120);
			for (const key of keys) currentEditor.handleInput(key);
		},
	});
	await harness.commands[0]!.handler("", ctx);
	if (!editor) throw new Error("failover editor was not created");
	await editor.whenIdle();
	return { notifications, statuses };
}

function scopeKey(id: string): string {
	return `${encodeURIComponent(resolve(agentDir))}:${id}`;
}

function chainModel(
	id: string,
	chain: readonly ModelRef[],
	overrides: Partial<Pick<GeneratedFailoverModelV8, "name" | "enabled">> = {},
): GeneratedFailoverModelV8 {
	return {
		id,
		name: overrides.name ?? id,
		enabled: overrides.enabled ?? true,
		chain: chain.map((target) => ({ ...target })),
	};
}

async function writeV8(
	models: readonly GeneratedFailoverModelV8[],
): Promise<void> {
	await writeFile(
		configPath,
		JSON.stringify(createGeneratedConfigV8(models)),
		"utf8",
	);
}

function assertV8Only(value: unknown): void {
	assert.ok(value && typeof value === "object");
	const config = value as {
		version: number;
		models: Array<Record<string, unknown>>;
	};
	assert.equal(config.version, 8);
	assert.deepEqual(Object.keys(config).sort(), ["models", "version"]);
	for (const model of config.models)
		assert.deepEqual(Object.keys(model).sort(), [
			"chain",
			"enabled",
			"id",
			"name",
		]);
}

async function seedShared(
	targets: readonly ModelRef[],
	patches: ReadonlyMap<string, Record<string, unknown>> = new Map(),
	agentDirectory = "/tmp/pi-failover-index-seed",
): Promise<SharedStateAdapter> {
	const adapter = createFileSharedState({ path: sharedPath });
	const registration = await adapter.reconcileRegistration({
		agentDirectory,
		targets,
	});
	assert.equal(registration.kind, "reconciled");
	for (const target of targets) {
		const patch = patches.get(`${target.provider}/${target.id}`);
		if (patch) {
			const result = await adapter.updateSettings(target, patch);
			assert.equal(result.kind, "updated");
		}
	}
	return adapter;
}

async function reportStatus(
	options: Record<string, unknown>,
	status: number,
): Promise<void> {
	const onResponse = options.onResponse as
		| ((response: {
				status: number;
				headers: Record<string, string>;
		  }) => void | Promise<void>)
		| undefined;
	await onResponse?.({ status, headers: {} });
}

function countingSharedState(
	base: SharedStateAdapter,
	updates: Array<{
		scopeKey: string;
		target: ModelRef;
		patch: Record<string, unknown>;
	}>,
): SharedStateAdapter {
	const updateScopeSettings = base.updateScopeSettings;
	const updateTargetOverride = base.updateTargetOverride;
	return {
		status: () => base.status(),
		snapshot: () => base.snapshot(),
		reconcileRegistration: (input) => base.reconcileRegistration(input),
		claim: (input) => base.claim(input),
		settle: (input) => base.settle(input),
		updateSettings: (target, patch) => base.updateSettings(target, patch),
		...(updateScopeSettings
			? {
					updateScopeSettings: (scopeKey, patch) =>
						updateScopeSettings(scopeKey, patch),
				}
			: {}),
		...(updateTargetOverride
			? {
					updateTargetOverride: (scopeKey, target, patch) => {
						const parsedTarget =
							typeof target === "string"
								? {
										provider: target.split("/", 1)[0]!,
										id: target.slice(target.indexOf("/") + 1),
									}
								: target;
						updates.push({ scopeKey, target: parsedTarget, patch });
						return updateTargetOverride.call(base, scopeKey, target, patch);
					},
				}
			: {}),
		resetTargets: (targets) => base.resetTargets(targets),
	};
}

function degradedRegistrationSharedState(
	base: SharedStateAdapter,
): SharedStateAdapter {
	return {
		status: () => base.status(),
		snapshot: () => base.snapshot(),
		reconcileRegistration: async () => ({
			kind: "reconciled" as const,
			registrationKey: resolve(agentDir),
			targets: ["openai/gpt-5"],
			coordination: "degraded" as const,
			reason: "write-failed" as const,
			detail: "raw registration failure detail",
		}),
		claim: (input) => base.claim(input),
		settle: (input) => base.settle(input),
		updateSettings: (target, patch) => base.updateSettings(target, patch),
		resetTargets: (targets) => base.resetTargets(targets),
	};
}

function switchableRegistrationFailure(base: SharedStateAdapter): {
	adapter: SharedStateAdapter;
	failNext: () => void;
	recover: () => void;
} {
	let failNext = false;
	let degraded = false;
	const degradedStatus = {
		coordination: "degraded" as const,
		reason: "write-failed" as const,
		detail: "injected registration failure",
	};
	return {
		adapter: {
			status: () => (degraded ? degradedStatus : base.status()),
			snapshot: async () => {
				const snapshot = await base.snapshot();
				return degraded ? { ...snapshot, status: degradedStatus } : snapshot;
			},
			reconcileRegistration: async (input) => {
				if (failNext) {
					failNext = false;
					degraded = true;
					return {
						kind: "reconciled" as const,
						registrationKey: resolve(agentDir),
						targets: input.targets.map((target) =>
							typeof target === "string"
								? target
								: `${target.provider}/${target.id}`,
						),
						...degradedStatus,
					};
				}
				return base.reconcileRegistration(input);
			},
			claim: (input) => base.claim(input),
			settle: (input) => base.settle(input),
			updateSettings: (target, patch) => base.updateSettings(target, patch),
			resetTargets: (targets) => base.resetTargets(targets),
		},
		failNext: () => {
			failNext = true;
			degraded = false;
		},
		recover: () => {
			failNext = false;
			degraded = false;
		},
	};
}

test.beforeEach(async () => {
	await resetFiles();
});

test("first run writes an empty v8 config and leaves models.json byte-identical", async () => {
	const harness = await createHarness();
	assert.equal(failoverProvider(harness).id, "failover");
	assert.deepEqual(failoverProvider(harness).getModels(), []);
	assertV8Only(JSON.parse(await readFile(configPath, "utf8")));
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
	const snapshot = await harness.sharedState.snapshot();
	assert.deepEqual(
		snapshot.document.registrations[resolve(agentDir)].targets,
		[],
	);
});

test("v5, v6, and v7 migrate shared-first with exact candidate settings", async () => {
	const v5 = createDefaultConfig([{ ...targetA }]);
	v5.maxRetries = 3;
	v5.reasoningEffort = "high";
	v5.manualRecovery = { "openai/gpt-5": "HTTP 401" };

	const v6Model = createGeneratedModel([{ ...targetA }]);
	v6Model.maxRetries = 4;
	v6Model.reasoningEffort = "low";
	v6Model.manualRecovery = { "openai/gpt-5": "HTTP 401" };
	const v6 = { version: 6, models: [{ ...v6Model, cooldownMinutes: 30 }] };

	const first = createGeneratedModel([{ ...targetA }]);
	first.id = "first";
	first.name = "First";
	first.maxRetries = 2;
	first.manualRecovery = { "openai/gpt-5": "model unavailable" };
	const second = createGeneratedModel([{ ...targetA }]);
	second.id = "second";
	second.name = "Second";
	second.maxRetries = 9;
	second.manualRecovery = { "openai/gpt-5": "HTTP 401" };
	const v7 = { version: 7, models: [first, second] };

	for (const fixture of [
		{ source: v5, retries: 3, effort: "high", reason: "HTTP 401" },
		{ source: v6, retries: 4, effort: "low", reason: "HTTP 401" },
		{ source: v7, retries: 2, effort: "medium", reason: "model unavailable" },
	] as const) {
		await resetFiles();
		await seedShared([targetB]);
		await writeFile(configPath, JSON.stringify(fixture.source), "utf8");
		const harness = await createHarness();
		assertV8Only(JSON.parse(await readFile(configPath, "utf8")));
		const snapshot = await harness.sharedState.snapshot();
		assert.equal(
			snapshot.document.targets["openai/gpt-5"].settings.maxRetries,
			fixture.retries,
		);
		assert.equal(
			snapshot.document.targets["openai/gpt-5"].settings.reasoningEffort,
			fixture.effort,
		);
		assert.equal(
			snapshot.document.targets["openai/gpt-5"].runtime.manualRecovery?.reason,
			fixture.reason,
		);
		assert.equal(
			snapshot.document.targets["openai/gpt-4o"].settings.maxRetries,
			5,
		);
		assert.deepEqual(snapshot.document.registrations[resolve(agentDir)].targets, [
			"openai/gpt-5",
		]);
		assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
	}
});

test("malformed shared state preserves legacy bytes and blocks routing and editing", async () => {
	const legacy = createGeneratedModel([{ ...targetA }]);
	legacy.maxRetries = 0;
	const source = JSON.stringify({ version: 7, models: [legacy] });
	await writeFile(configPath, source, "utf8");
	await writeFile(sharedPath, "{malformed", "utf8");
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA]),
		sharedState: createFileSharedState({ path: sharedPath }),
	});
	assert.deepEqual(failoverProvider(harness).getModels(), []);
	const result = await failoverProvider(harness)
		.stream({ id: "default" }, {}, {})
		.result();
	assert.equal(result.stopReason, "error");
	assert.match(String(result.errorMessage), /Unknown failover model: default/);
	assert.equal(await readFile(configPath, "utf8"), source);
	assert.equal(await readFile(sharedPath, "utf8"), "{malformed");
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);

	let customCalls = 0;
	const notifications: string[] = [];
	await startSession(harness, notifications);
	await harness.commands[0]!.handler(
		"",
		createContext({
			notifications,
			custom: async () => {
				customCalls += 1;
			},
		}),
	);
	assert.equal(customCalls, 0);
	const warningText = notifications.join("\n");
	assert.match(warningText, /legacy failover migration is blocked/i);
	assert.match(warningText, /automation and writes are blocked/i);
	assert.match(warningText, /repair shared failover state/i);
	assert.equal(/local coordination/i.test(warningText), false);
	assert.equal(/Failover action failed/i.test(warningText), false);
});

test("legacy migration CAS conflict preserves source bytes and blocks the provider", async () => {
	const legacy = createGeneratedModel([{ ...targetA }]);
	legacy.maxRetries = 0;
	const source = `${JSON.stringify({ version: 7, models: [legacy] })}\n`;
	await writeFile(configPath, source, "utf8");
	const lockPath = `${configPath}.lock`;
	await writeFile(
		lockPath,
		JSON.stringify({
			pid: process.pid,
			createdAt: Date.now(),
			owner: "external",
		}),
		"utf8",
	);
	const release = new Promise<void>((done, reject) => {
		setTimeout(async () => {
			try {
				await writeFile(configPath, source, "utf8");
				await rm(lockPath);
				done();
			} catch (error) {
				reject(error);
			}
		}, 40);
	});
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA]),
	});
	await release;
	assert.equal(await readFile(configPath, "utf8"), source);
	assert.deepEqual(failoverProvider(harness).getModels(), []);
	const result = await failoverProvider(harness)
		.stream({ id: "default" }, {}, {})
		.result();
	assert.equal(result.stopReason, "error");
	assert.match(String(result.errorMessage), /Unknown failover model: default/);

	let customCalls = 0;
	const notifications: string[] = [];
	await startSession(harness, notifications);
	await harness.commands[0]!.handler(
		"",
		createContext({
			notifications,
			custom: async () => {
				customCalls += 1;
			},
		}),
	);
	assert.equal(customCalls, 0);
	const warningText = notifications.join("\n");
	assert.match(warningText, /legacy failover migration is blocked/i);
	assert.match(warningText, /resolve file write conflicts/i);
	assert.equal(/Failover action failed/i.test(warningText), false);
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
});

test("blocked chain config keeps registration and source bytes unchanged", async () => {
	const seed = await seedShared([targetA], new Map(), resolve(agentDir));
	assert.deepEqual(
		(await seed.snapshot()).document.registrations[resolve(agentDir)].targets,
		["openai/gpt-5"],
	);
	const source = "{broken";
	await writeFile(configPath, source, "utf8");
	const harness = await createHarness({
		sharedState: createFileSharedState({ path: sharedPath }),
	});
	assert.deepEqual(failoverProvider(harness).getModels(), []);
	assert.equal(await readFile(configPath, "utf8"), source);
	const snapshot = await harness.sharedState.snapshot();
	assert.deepEqual(snapshot.document.registrations[resolve(agentDir)].targets, [
		"openai/gpt-5",
	]);
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
	const warnings: string[] = [];
	await startSession(harness, warnings);
	assert.ok(warnings.some((message) => /config unavailable/i.test(message)));
});

test("degraded v8 target registration blocks routing and does not open the editor", async () => {
	await writeV8([chainModel("primary", [targetA], { name: "Primary" })]);
	const source = await readFile(configPath, "utf8");
	const shared = degradedRegistrationSharedState(
		createFileSharedState({ path: sharedPath }),
	);
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA]),
		sharedState: shared,
	});
	assert.deepEqual(failoverProvider(harness).getModels(), []);
	assert.equal(await readFile(configPath, "utf8"), source);

	let customCalls = 0;
	const notifications: string[] = [];
	await harness.commands[0]!.handler(
		"",
		createContext({
			notifications,
			custom: async () => {
				customCalls += 1;
			},
		}),
	);
	assert.equal(customCalls, 0);
	const text = notifications.join("\n");
	assert.match(
		text,
		/Failover config unavailable: target registration could not be verified/,
	);
	assert.equal(text.includes("raw registration failure detail"), false);
});
test("unreadable chain config uses a generic notification without raw read details", async () => {
	await mkdir(configPath);
	try {
		const harness = await createHarness();
		const notifications: string[] = [];
		await startSession(harness, notifications);
		let customCalls = 0;
		await harness.commands[0]!.handler(
			"",
			createContext({
				notifications,
				custom: async () => {
					customCalls += 1;
				},
			}),
		);
		assert.equal(customCalls, 0);
		const text = notifications.join("\n");
		assert.match(
			text,
			/Failover config unavailable: the configuration file is unavailable/,
		);
		assert.equal(text.includes(configPath), false);
		assert.doesNotMatch(
			text,
			/EISDIR|EACCES|EPERM|ENOTDIR|ENOENT|permission denied/i,
		);
	} finally {
		await rm(configPath, { recursive: true, force: true });
	}
});

test("registration includes disabled targets, preserves another directory, and retains settings", async () => {
	const seed = await seedShared([targetB], new Map(), "/tmp/another-agent");
	await seed.reconcileRegistration({
		agentDirectory: "/tmp/settings-owner",
		targets: [targetA],
	});
	await seed.updateSettings(targetA, { maxRetries: 9 });
	await writeV8([
		chainModel("enabled", [targetA], { name: "Enabled" }),
		chainModel("disabled", [targetC], { name: "Disabled", enabled: false }),
	]);
	const first = await createHarness();
	assert.deepEqual(
		failoverProvider(first)
			.getModels()
			.map((model) => model.id),
		["enabled"],
	);
	let snapshot = await first.sharedState.snapshot();
	assert.deepEqual(snapshot.document.registrations[resolve(agentDir)].targets, [
		"anthropic/claude",
		"openai/gpt-5",
	]);
	assert.deepEqual(
		snapshot.document.registrations["/tmp/another-agent"].targets,
		["openai/gpt-4o"],
	);
	assert.equal(snapshot.document.targets["openai/gpt-5"].settings.maxRetries, 9);
	const second = await createHarness({
		sharedState: createFileSharedState({ path: sharedPath }),
	});
	snapshot = await second.sharedState.snapshot();
	assert.equal(snapshot.document.targets["openai/gpt-5"].settings.maxRetries, 9);
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
});

test("TUI CRUD persists the v8 chain and reconciles shared registration", async () => {
	await seedShared([targetB], new Map(), "/tmp/other-agent");
	await writeV8([
		chainModel("primary", [targetA, targetB], { name: "Primary" }),
		chainModel("secondary", [targetC], {
			name: "Secondary",
			enabled: false,
		}),
	]);
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA, modelB, modelC, modelD]),
	});
	const ownTargets = async (): Promise<string[]> =>
		(await harness.sharedState.snapshot()).document.registrations[
			resolve(agentDir)
		]!.targets;
	const readConfig = async () =>
		JSON.parse(await readFile(configPath, "utf8")) as {
			version: number;
			models: GeneratedFailoverModelV8[];
		};

	await driveEditor(harness, ["r", ..."Renamed", "\r"]);
	let raw = await readConfig();
	assertV8Only(raw);
	assert.deepEqual(raw.models, [
		chainModel("primary", [targetA, targetB], { name: "PrimaryRenamed" }),
		chainModel("secondary", [targetC], {
			name: "Secondary",
			enabled: false,
		}),
	]);
	assert.deepEqual(await ownTargets(), [
		"anthropic/claude",
		"openai/gpt-4o",
		"openai/gpt-5",
	]);

	await driveEditor(harness, ["e"]);
	raw = await readConfig();
	assertV8Only(raw);
	assert.equal(raw.models[0]!.enabled, false);
	assert.deepEqual(await ownTargets(), [
		"anthropic/claude",
		"openai/gpt-4o",
		"openai/gpt-5",
	]);

	await driveEditor(harness, ["\r", "a", "\x1b[B", "\r"]);
	raw = await readConfig();
	assertV8Only(raw);
	assert.deepEqual(raw.models, [
		chainModel("primary", [targetA, targetB, targetD], {
			name: "PrimaryRenamed",
			enabled: false,
		}),
		chainModel("secondary", [targetC], {
			name: "Secondary",
			enabled: false,
		}),
	]);
	assert.deepEqual(await ownTargets(), [
		"anthropic/claude",
		"google/gemini",
		"openai/gpt-4o",
		"openai/gpt-5",
	]);

	await driveEditor(harness, ["\r", "]", "]"]);
	raw = await readConfig();
	assertV8Only(raw);
	assert.deepEqual(raw.models, [
		chainModel("primary", [targetB, targetD, targetA], {
			name: "PrimaryRenamed",
			enabled: false,
		}),
		chainModel("secondary", [targetC], {
			name: "Secondary",
			enabled: false,
		}),
	]);
	assert.deepEqual(await ownTargets(), [
		"anthropic/claude",
		"google/gemini",
		"openai/gpt-4o",
		"openai/gpt-5",
	]);

	await driveEditor(harness, ["\x1b[B", "d"]);
	raw = await readConfig();
	assertV8Only(raw);
	assert.deepEqual(raw.models, [
		chainModel("primary", [targetB, targetD, targetA], {
			name: "PrimaryRenamed",
			enabled: false,
		}),
	]);
	assert.deepEqual(await ownTargets(), [
		"google/gemini",
		"openai/gpt-4o",
		"openai/gpt-5",
	]);
	assert.deepEqual(
		(await harness.sharedState.snapshot()).document.registrations[
			"/tmp/other-agent"
		]!.targets,
		["openai/gpt-4o"],
	);
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
});

test("/failover uses Pi autocomplete rows for add-target candidates", async () => {
	await writeV8([chainModel("primary", [targetA], { name: "Primary" })]);
	await writeFile(
		settingsPath,
		JSON.stringify({ autocompleteMaxVisible: 7 }),
		"utf8",
	);
	const extraModels = Array.from({ length: 5 }, (_, index) => ({
		...modelA,
		id: `candidate-${index + 1}`,
		name: `candidate-${index + 1}`,
	}));
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([
			modelA,
			modelB,
			modelC,
			modelD,
			...extraModels,
		]),
	});
	const notifications: string[] = [];
	let editor:
		| {
				handleInput(data: string): void;
				render(width: number): string[];
			}
		| undefined;
	await harness.commands[0]!.handler(
		"",
		createContext({
			cwd: agentDir,
			notifications,
			custom: async (create) => {
				editor = create(
					{ requestRender: () => undefined },
					{ fg: (_color: string, text: string) => text },
					{},
					() => undefined,
				) as {
					handleInput(data: string): void;
					render(width: number): string[];
				};
			},
		}),
	);
	assert.ok(editor, notifications.join("\n"));
	editor.handleInput("\r");
	editor.handleInput("a");
	const rendered = editor.render(120).join("\n");
	assert.match(rendered, /Candidates: 8 {2}Showing 1-7/);
	assert.match(rendered, /(?:^| )7\. openai\/candidate-4\s*$/m);
	assert.equal(
		rendered
			.split("\n")
			.some((line) => /(?:^| )8\. openai\/candidate-5\s*$/.test(line)),
		false,
	);
});

test("TUI requests a render after an async target action settles", async () => {
	await writeV8([chainModel("primary", [targetA], { name: "Primary" })]);
	const base = createFileSharedState({ path: sharedPath });
	let release: (() => void) | undefined;
	let resolveStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const delayed = new Proxy(base, {
		get(target, property, receiver) {
			if (property === "updateSettings") {
				return async (
					target: Parameters<SharedStateAdapter["updateSettings"]>[0],
					patch: Parameters<SharedStateAdapter["updateSettings"]>[1],
				) => {
					resolveStarted?.();
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return base.updateSettings(target, patch);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	}) as SharedStateAdapter;
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA, modelB]),
		sharedState: delayed,
	});
	let renderCount = 0;
	let editor: TestEditor | undefined;
	await harness.commands[0]!.handler(
		"",
		createContext({
			custom: async (create) => {
				editor = create(
					{ requestRender: () => (renderCount += 1) },
					{ fg: (_color: string, text: string) => text },
					{},
					() => undefined,
				) as TestEditor;
			},
		}),
	);
	if (!editor) throw new Error("failover editor was not created");

	editor.handleInput("\r");
	renderCount = 0;
	editor.handleInput("e");
	await started;
	assert.equal(renderCount, 1);
	if (!release) throw new Error("target update was not suspended");
	release();
	await editor.whenIdle();
	assert.equal(renderCount, 2);
	assert.match(editor.render(120).join("\n"), /openai\/gpt-5 \[disabled\]/);
});

test("second session refreshes the chain after another session adds a target", async () => {
	await writeV8([chainModel("primary", [targetA], { name: "Primary" })]);
	const first = await createHarness({
		targetRuntime: makeTargetRuntime([modelA, modelB]),
		sharedState: createFileSharedState({ path: sharedPath }),
	});
	const second = await createHarness({
		targetRuntime: makeTargetRuntime([modelA, modelB]),
		sharedState: createFileSharedState({ path: sharedPath }),
	});

	// Session B starts before A changes the authoritative chain file.
	await startSession(second);
	await driveEditor(first, ["\r", "a", "\r"]);
	const afterFirst = JSON.parse(await readFile(configPath, "utf8")) as {
		models: Array<{ chain: ModelRef[] }>;
	};
	assert.deepEqual(afterFirst.models[0]!.chain, [targetA, targetB]);

	const notifications: string[] = [];
	let editor:
		| {
				handleInput(data: string): void;
				render(width: number): string[];
				whenIdle(): Promise<void>;
		  }
		| undefined;
	await second.commands[0]!.handler(
		"",
		createContext({
			notifications,
			custom: async (create) => {
				editor = create(
					{ requestRender: () => undefined },
					{ fg: (_color: string, text: string) => text },
					{},
					() => undefined,
				) as {
					handleInput(data: string): void;
					render(width: number): string[];
					whenIdle(): Promise<void>;
				};
			},
		}),
	);
	if (!editor) throw new Error("failover editor was not created");

	// /failover must show the chain written by A without rebuilding B or /reload.
	editor.handleInput("\r");
	assert.match(editor.render(120).join("\n"), /openai\/gpt-4o/);

	// B can save another change using the revision it just refreshed.
	editor.handleInput("\x1b");
	editor.handleInput("r");
	editor.handleInput("!");
	editor.handleInput("\r");
	await editor.whenIdle();
	assert.equal(
		notifications.some((message) =>
			/Failover chain changed on disk; reload and review before editing again\./.test(
				message,
			),
		),
		false,
	);
	const afterSecond = JSON.parse(await readFile(configPath, "utf8")) as {
		models: Array<{ name: string; chain: ModelRef[] }>;
	};
	assert.equal(afterSecond.models[0]!.name, "Primary!");
	assert.deepEqual(afterSecond.models[0]!.chain, [targetA, targetB]);
});

test("session_start refreshes the chain without a reload", async () => {
	await writeV8([chainModel("primary", [targetA], { name: "Primary" })]);
	const refreshedModelB = { ...modelB, contextWindow: 64_000, maxTokens: 8_192 };
	const first = await createHarness({
		targetRuntime: makeTargetRuntime([modelA, refreshedModelB]),
		sharedState: createFileSharedState({ path: sharedPath }),
	});
	const second = await createHarness({
		targetRuntime: makeTargetRuntime([modelA, refreshedModelB]),
		sharedState: createFileSharedState({ path: sharedPath }),
	});
	const notifications: string[] = [];

	await startSession(second, notifications);
	await driveEditor(first, ["\r", "a", "\r"]);
	await startSession(second, notifications);

	const models = failoverProvider(second).getModels() as Array<{
		id: string;
		contextWindow: number;
	}>;
	assert.deepEqual(models.map((model) => model.id), ["primary"]);
	assert.equal(models[0]!.contextWindow, 64_000);
	assert.equal(
		notifications.some(
			(message) =>
				message ===
				"Failover chain changed on disk; reload and review before editing again.",
		),
		false,
	);

	const editor = await openEditor(second, notifications);

	editor.handleInput("\r");
	assert.match(editor.render(120).join("\n"), /openai\/gpt-4o/);
});

test("malformed config blocks routing and recovers on session_start", async () => {
	await writeV8([chainModel("primary", [targetA], { name: "Primary" })]);
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA, modelB]),
	});
	await writeFile(configPath, "{malformed", "utf8");

	const notifications: string[] = [];
	await startSession(harness, notifications);
	assert.deepEqual(failoverProvider(harness).getModels(), []);
	const blocked = await failoverProvider(harness)
		.stream({ id: "primary" }, {}, {})
		.result();
	assert.equal(blocked.stopReason, "error");
	assert.match(String(blocked.errorMessage), /Unknown failover model: primary/);

	let customCalls = 0;
	await harness.commands[0]!.handler(
		"",
		createContext({
			notifications,
			custom: async () => {
				customCalls += 1;
			},
		}),
	);
	assert.equal(customCalls, 0);
	assert.ok(
		notifications.includes(
			"Failover config unavailable: the configuration file is malformed",
		),
	);
	assert.equal(notifications.some((message) => message.includes(configPath)), false);

	await writeV8([
		chainModel("recovered", [targetB], { name: "Recovered" }),
	]);
	notifications.length = 0;
	await startSession(harness, notifications);
	const recovered = failoverProvider(harness).getModels();
	assert.deepEqual(
		recovered.map((model) => model.id),
		["recovered"],
	);
	assert.equal(
		notifications.some((message) => /config unavailable/i.test(message)),
		false,
	);

	let editor:
		| {
				handleInput(data: string): void;
				render(width: number): string[];
			}
		| undefined;
	await harness.commands[0]!.handler(
		"",
		createContext({
			notifications,
			custom: async (create) => {
				editor = create(
					{ requestRender: () => undefined },
					{ fg: (_color: string, text: string) => text },
					{},
					() => undefined,
				) as {
					handleInput(data: string): void;
					render(width: number): string[];
				};
			},
		}),
	);
	if (!editor) throw new Error("failover editor was not created after recovery");
	editor.handleInput("\r");
	assert.match(editor.render(120).join("\n"), /openai\/gpt-4o/);
});

test("CAS conflict requires closing and reopening the editor", async () => {
	await writeV8([chainModel("primary", [targetA], { name: "Primary" })]);
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA, modelB]),
	});
	const notifications: string[] = [];
	let closed = false;
	const editor = await openEditor(harness, notifications, () => {
		closed = true;
	});

	editor.handleInput("\r");
	assert.match(editor.render(120).join("\n"), /openai\/gpt-5/);

	await writeV8([chainModel("primary", [targetB], { name: "External" })]);
	editor.handleInput("\x1b");
	editor.handleInput("r");
	editor.handleInput("!");
	editor.handleInput("\r");
	await editor.whenIdle();
	const staleWarning =
		"Failover chain changed on disk; reload and review before editing again.";
	assert.equal(notifications.filter((message) => message === staleWarning).length, 1);

	editor.handleInput("q");
	assert.equal(closed, true);

	const reopened = await openEditor(harness, notifications);

	reopened.handleInput("\r");
	assert.match(reopened.render(120).join("\n"), /openai\/gpt-4o/);
	reopened.handleInput("\x1b");
	reopened.handleInput("r");
	reopened.handleInput("!");
	reopened.handleInput("\r");
	await reopened.whenIdle();
	assert.equal(notifications.filter((message) => message === staleWarning).length, 1);
	const saved = JSON.parse(await readFile(configPath, "utf8")) as {
		models: Array<{ name: string; chain: ModelRef[] }>;
	};
	assert.equal(saved.models[0]!.name, "External!");
	assert.deepEqual(saved.models[0]!.chain, [targetB]);
});

test("recovered /failover does not leak a stale registration warning", async () => {
	await writeV8([chainModel("primary", [targetA], { name: "Primary" })]);
	const registration = switchableRegistrationFailure(
		createFileSharedState({ path: sharedPath }),
	);
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA]),
		sharedState: registration.adapter,
	});
	assert.deepEqual(harness.sharedState.status(), { coordination: "shared" });

	const saveNotifications: string[] = [];
	const editor = await openEditor(harness, saveNotifications);
	registration.failNext();
	editor.handleInput("r");
	editor.handleInput("!");
	editor.handleInput("\r");
	await editor.whenIdle();
	assert.ok(
		saveNotifications.some((message) =>
			message.includes(
				"Failover chain was written but target registration failed; restart after repairing shared state.",
			),
		),
	);

	registration.recover();
	const recoveryNotifications: string[] = [];
	await openEditor(harness, recoveryNotifications);
	assert.equal(
		recoveryNotifications.some((message) =>
			/Failover target registration (?:was rejected|failed);.*(?:new chain configuration was not applied|editing is disabled)/i.test(
				message,
			),
		),
		false,
	);
});

test("delegate routing remains usable with a frozen target thinking map", async () => {
	const thinkingLevelMap = Object.freeze({
		off: "none",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	}) as Partial<Record<ReasoningEffort, string | null>>;
	const frozenModel = { ...modelA, thinkingLevelMap };
	const runtime = makeTargetRuntime([frozenModel]);
	await writeV8([chainModel("primary", [targetA])]);
	const harness = await createHarness({ targetRuntime: runtime });
	const result = await failoverProvider(harness)
		.stream({ id: "primary" }, {}, {})
		.result();
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(thinkingLevelMap, {
		off: "none",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	});
	const virtual = failoverProvider(harness).getModels()[0] as {
		thinkingLevelMap?: object;
	};
	assert.notEqual(virtual.thinkingLevelMap, thinkingLevelMap);
});

test("v8 provider works before session_start and shares cooldown across instances", async () => {
	await seedShared(
		[targetA, targetB],
		new Map([["openai/gpt-5", { maxRetries: 0 }]]),
	);
	await writeV8([
		chainModel("primary", [targetA, targetB], { name: "Primary" }),
	]);
	const firstCalls: string[] = [];
	const firstRuntime = makeTargetRuntime(
		[modelA, modelB],
		async (model, _ctx, options) => {
			firstCalls.push(model.id);
			if (model.id === targetA.id) {
				await reportStatus(options, 500);
				return providerMessage(model, "error", "HTTP 500", 500);
			}
			return providerMessage(model, "stop");
		},
	);
	const first = await createHarness({
		targetRuntime: firstRuntime,
		sharedState: createFileSharedState({ path: sharedPath }),
	});
	const firstResult = await failoverProvider(first)
		.stream({ id: "primary" }, {}, {})
		.result();
	assert.equal(firstResult.stopReason, "stop");
	assert.deepEqual(firstCalls, ["gpt-5", "gpt-4o"]);
	assert.deepEqual(first.appendedEntries, []);
	const preSessionHistory = await renderHistory(first);
	assert.match(preSessionHistory.rendered, /openai\/gpt-5/);
	assert.match(preSessionHistory.rendered, /openai\/gpt-4o/);
	assert.match(preSessionHistory.rendered, /HTTP 500/);

	const secondCalls: string[] = [];
	const secondRuntime = makeTargetRuntime([modelA, modelB], async (model) => {
		secondCalls.push(model.id);
		return providerMessage(model, "stop");
	});
	const second = await createHarness({
		targetRuntime: secondRuntime,
		sharedState: createFileSharedState({ path: sharedPath }),
	});
	const secondResult = await failoverProvider(second)
		.stream({ id: "primary" }, {}, {})
		.result();
	assert.equal(secondResult.stopReason, "stop");
	assert.deepEqual(secondCalls, ["gpt-4o"]);
	const snapshot = await second.sharedState.snapshot();
	assert.ok(snapshot.document.targets["openai/gpt-5"].runtime.cooldownUntil);
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
});

test("ephemeral sessions capture history without appending custom entries", async () => {
	await seedShared(
		[targetA, targetB],
		new Map([["openai/gpt-5", { maxRetries: 0 }]]),
	);
	await writeV8([
		chainModel("primary", [targetA, targetB], { name: "Primary" }),
	]);
	const runtime = makeTargetRuntime(
		[modelA, modelB],
		async (model, _ctx, options) => {
			if (model.id === targetA.id) {
				await reportStatus(options, 500);
				return providerMessage(model, "error", "HTTP 500", 500);
			}
			return providerMessage(model, "stop");
		},
	);
	const harness = await createHarness({ targetRuntime: runtime });
	await startSession(harness, [], [], [], null);
	await failoverProvider(harness).stream({ id: "primary" }, {}, {}).result();
	assert.deepEqual(harness.appendedEntries, []);
	const history = await renderHistory(harness);
	assert.match(history.rendered, /openai\/gpt-5 -> openai\/gpt-4o/);
	assert.match(history.rendered, /HTTP 500/);
});

test("persistent recovery is written only to shared state without session_start", async () => {
	await seedShared([targetA], new Map([["openai/gpt-5", { maxRetries: 0 }]]));
	await writeV8([chainModel("primary", [targetA], { name: "Primary" })]);
	const before = await readFile(configPath, "utf8");
	const runtime = makeTargetRuntime([modelA], async (model) =>
		providerMessage(model, "error", "HTTP 401", 401),
	);
	const harness = await createHarness({ targetRuntime: runtime });
	const result = await failoverProvider(harness)
		.stream({ id: "primary" }, {}, {})
		.result();
	assert.equal(result.stopReason, "error");
	assert.equal(await readFile(configPath, "utf8"), before);
	const snapshot = await harness.sharedState.snapshot();
	const manualRecovery =
		snapshot.document.targets["openai/gpt-5"].runtime.manualRecovery;
	assert.equal(manualRecovery?.reason, "HTTP 401");
	assert.equal(typeof manualRecovery?.updatedAt, "number");
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
});

test("Enter updates one chain target override without changing global target settings", async () => {
	await writeV8([
		chainModel("primary", [targetA, targetB], { name: "Primary" }),
	]);
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA, modelB]),
	});
	const before = await readFile(configPath, "utf8");
	await driveEditor(harness, [
		"\r",
		"\r",
		"\x1b[B",
		"\x1b[B",
		"\r",
		"\x7f",
		"3",
		"\r",
	]);
	assert.equal(await readFile(configPath, "utf8"), before);
	const snapshot = await harness.sharedState.snapshot();
	assert.equal(snapshot.document.targets["openai/gpt-5"].settings.maxRetries, 5);
	assert.equal(
		snapshot.document.targets["openai/gpt-4o"].settings.maxRetries,
		5,
	);
	const scope = snapshot.document.scopes[scopeKey("primary")];
	assert.ok(scope);
	assert.equal(scope.settings.maxRetries, 5);
	assert.equal(scope.overrides["openai/gpt-5"].maxRetries, 3);
	assert.equal(scope.overrides["openai/gpt-4o"].maxRetries, "inherit");
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
});

test("same target in two chains receives only the selected chain override", async () => {
	await writeV8([
		chainModel("first", [targetA], { name: "First" }),
		chainModel("second", [targetA], { name: "Second" }),
	]);
	const base = createFileSharedState({
		path: sharedPath,
	});
	const updates: Array<{
		scopeKey: string;
		target: ModelRef;
		patch: Record<string, unknown>;
	}> = [];
	const shared = countingSharedState(base, updates);
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA]),
		sharedState: shared,
	});
	const before = await readFile(configPath, "utf8");
	await driveEditor(harness, ["\r", "\r", "\r", "\x1b[B", "\x1b[B", "\r"]);
	assert.equal(await readFile(configPath, "utf8"), before);
	assert.deepEqual(updates, [
		{
			scopeKey: scopeKey("first"),
			target: targetA,
			patch: { reasoningEffort: "low" },
		},
	]);
	const snapshot = await harness.sharedState.snapshot();
	assert.equal(
		snapshot.document.targets["openai/gpt-5"].settings.reasoningEffort,
		"medium",
	);
	assert.equal(
		snapshot.document.scopes[scopeKey("first")].overrides["openai/gpt-5"]
			.reasoningEffort,
		"low",
	);
	assert.equal(
		snapshot.document.scopes[scopeKey("second")].overrides["openai/gpt-5"]
			.reasoningEffort,
		"inherit",
	);
});

test("removing the final chain target disables the v8 model", async () => {
	await writeV8([chainModel("primary", [targetA], { name: "Primary" })]);
	const harness = await createHarness({
		targetRuntime: makeTargetRuntime([modelA]),
	});
	await driveEditor(harness, ["\r", "d"]);
	const raw = JSON.parse(await readFile(configPath, "utf8")) as {
		models: Array<{ enabled: boolean; chain: ModelRef[] }>;
	};
	assertV8Only(raw);
	assert.equal(raw.models[0].enabled, false);
	assert.deepEqual(raw.models[0].chain, []);
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
});

test("reset targets only the selected exact target during active use", async () => {
	const shared = await seedShared(
		[targetA, targetB, targetC],
		new Map([
			["openai/gpt-5", { maxRetries: 0 }],
			["openai/gpt-4o", { maxRetries: 0 }],
			["anthropic/claude", { maxRetries: 0 }],
		]),
	);
	const active = await shared.claim({
		target: targetA,
		effectiveRequestTimeoutMs: 0,
	});
	assert.equal(active.kind, "claimed");
	if (active.kind !== "claimed") throw new Error("expected claim");
	assert.equal("lease" in active.runtime, false);
	const cooling = await shared.claim({
		target: targetB,
		effectiveRequestTimeoutMs: 0,
	});
	assert.equal(cooling.kind, "claimed");
	if (cooling.kind !== "claimed") throw new Error("expected claim");
	await shared.settle({
		target: targetB,
		outcome: { kind: "automatic-failure", reason: "HTTP 500" },
	});
	const manual = await shared.claim({
		target: targetC,
		effectiveRequestTimeoutMs: 0,
	});
	assert.equal(manual.kind, "claimed");
	if (manual.kind !== "claimed") throw new Error("expected claim");
	await shared.settle({
		target: targetC,
		outcome: { kind: "persistent-failure", reason: "HTTP 401" },
	});
	await writeV8([
		chainModel("selected", [targetA, targetB], { name: "Selected" }),
		chainModel("other", [targetC], { name: "Other" }),
	]);
	const harness = await createHarness();
	const first = await driveEditor(harness, ["\r", "r"]);
	let snapshot = await harness.sharedState.snapshot();
	assert.equal(first.notifications.some((message) => /active lease/i.test(message)), false);
	assert.equal("lease" in snapshot.document.targets["openai/gpt-5"].runtime, false);
	assert.ok(snapshot.document.targets["openai/gpt-4o"].runtime.cooldownUntil);
	assert.equal(
		snapshot.document.targets["anthropic/claude"].runtime.manualRecovery?.reason,
		"HTTP 401",
	);
	assert.equal(
		typeof snapshot.document.targets["anthropic/claude"].runtime.manualRecovery
			?.updatedAt,
		"number",
	);

	const second = await driveEditor(harness, ["\r", "\x1b[B", "r"]);
	snapshot = await harness.sharedState.snapshot();
	assert.equal("lease" in snapshot.document.targets["openai/gpt-5"].runtime, false);
	assert.equal(
		snapshot.document.targets["openai/gpt-4o"].runtime.cooldownUntil,
		null,
	);
	assert.deepEqual(snapshot.document.targets["anthropic/claude"].runtime.manualRecovery, {
		reason: "HTTP 401",
		updatedAt: snapshot.document.targets["anthropic/claude"].runtime.manualRecovery?.updatedAt,
	});
	assert.equal(
		typeof snapshot.document.targets["anthropic/claude"].runtime.manualRecovery?.updatedAt,
		"number",
	);
	assert.equal(second.notifications.some((message) => /active lease/i.test(message)), false);
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
});

test("footer and history remain active through the shared v8 provider", async () => {
	await seedShared(
		[targetA, targetB],
		new Map([
			["openai/gpt-5", { maxRetries: 0, reasoningEffort: "high" }],
			["openai/gpt-4o", { maxRetries: 0, reasoningEffort: "high" }],
		]),
	);
	await writeV8([
		chainModel("primary", [targetA, targetB], { name: "Primary" }),
	]);
	const runtime = makeTargetRuntime(
		[modelA, modelB],
		async (model, _ctx, options) => {
			if (model.id === targetA.id) {
				await reportStatus(options, 500);
				return providerMessage(model, "error", "HTTP 500", 500);
			}
			return providerMessage(model, "stop");
		},
	);
	const harness = await createHarness({ targetRuntime: runtime });
	const statuses: string[] = [];
	await startSession(harness, [], statuses);
	await failoverProvider(harness).stream({ id: "primary" }, {}, {}).result();
	assert.ok(
		statuses.includes(
			"openai/gpt-5 → openai/gpt-4o (HTTP 500) | real openai/gpt-4o | thinking high",
		),
	);
	assert.equal(harness.appendedEntries.length, 1);
	const appended = harness.appendedEntries[0]!;
	assert.equal(appended.customType, transitionEntryType);
	assert.ok(appended.data && typeof appended.data === "object");
	const { timestamp, ...transitionData } = appended.data as Record<
		string,
		unknown
	>;
	assert.equal(typeof timestamp, "number");
	assert.deepEqual(transitionData, {
		modelId: "primary",
		target: targetB,
		effort: "high",
		reasoningControlled: true,
		mappedEffort: "high",
		source: targetA,
		reason: "HTTP 500",
	});

	const liveHistory = await renderHistory(harness);
	assert.match(liveHistory.rendered, /Failover History/);
	assert.ok(
		liveHistory.rendered.includes(localHistoryTimestamp(timestamp as number)),
	);
	assert.match(liveHistory.rendered, /openai\/gpt-5/);
	assert.match(liveHistory.rendered, /openai\/gpt-4o/);
	assert.match(liveHistory.rendered, /HTTP 500/);
	assert.equal(liveHistory.closed, true);

	const fresh = await createHarness({
		targetRuntime: makeTargetRuntime([modelA, modelB]),
		sharedState: createFileSharedState({
			path: sharedPath,
		}),
	});
	await startSession(
		fresh,
		[],
		[],
		[
			{
				type: "custom",
				customType: appended.customType,
				data: appended.data,
			},
		],
	);
	const restoredHistory = await renderHistory(fresh);
	assert.ok(
		restoredHistory.rendered.includes(localHistoryTimestamp(timestamp as number)),
	);
	assert.match(restoredHistory.rendered, /openai\/gpt-5/);
	assert.match(restoredHistory.rendered, /openai\/gpt-4o/);
	assert.match(restoredHistory.rendered, /HTTP 500/);
	assert.deepEqual(fresh.appendedEntries, []);
	assert.equal(await readFile(modelsPath, "utf8"), modelsBytes);
});

test("session history restore rejects controls and bad data, deduplicates, bounds, and resets", async () => {
	const harness = await createHarness();
	const valid = {
		modelId: "primary",
		target: targetB,
		effort: "high",
		reasoningControlled: true,
		mappedEffort: "high",
		source: targetA,
		reason: "HTTP 500",
		timestamp: 1_700_000_000_000,
	};
	const customEntry = (data: unknown, customType = transitionEntryType) => ({
		type: "custom",
		customType,
		data,
	});
	const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;
	await startSession(
		harness,
		[],
		[],
		[
			customEntry(valid),
			customEntry({ ...valid }),
			customEntry({
				...valid,
				reason: "HTTP 500\u001b]52;c;history-secret\u0007",
			}),
			customEntry({
				...valid,
				target: {
					...targetB,
					provider: "openai\u001b[31mhistory-provider",
				},
			}),
			customEntry({
				...valid,
				target: { ...targetB, id: "gpt-4o\u009bhistory-id" },
			}),
			customEntry({ ...valid, reason: "x".repeat(257) }),
			customEntry({ ...valid, timestamp: "not-a-number" }),
			customEntry({ ...valid, source: { provider: "openai" } }),
			customEntry(valid, "another-extension/transition-v1"),
		],
	);
	let history = await renderHistory(harness);
	assert.match(history.rendered, /Showing 1-1 of 1/);
	assert.match(history.rendered, /openai\/gpt-5 -> openai\/gpt-4o/);
	assert.match(history.rendered, /HTTP 500/);
	assert.doesNotMatch(history.rendered, /history-(?:secret|provider|id)/);
	for (const line of history.rendered.split("\n"))
		assert.doesNotMatch(line, controlCharacters);

	const boundedEntries = Array.from({ length: 101 }, (_, index) =>
		customEntry({
			...valid,
			reason: `failure-${index}`,
			timestamp: valid.timestamp + index,
		}),
	);
	await startSession(harness, [], [], boundedEntries);
	history = await renderHistory(harness);
	assert.match(history.rendered, /Showing 1-20 of 100/);
	assert.match(history.rendered, /failure-100/);

	await startSession(harness);
	history = await renderHistory(harness);
	assert.match(history.rendered, /No failover transitions recorded/);
	assert.deepEqual(harness.appendedEntries, []);
});

test.after(async () => {
	process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});
