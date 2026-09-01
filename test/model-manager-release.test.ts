import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";
import {
	readModelCatalog,
	type ModelManagerCatalogSnapshot,
} from "../src/model-manager-catalog.ts";
import {
	buildVirtualModel,
	clearFailoverChains,
	clearModelManagerBridge,
	notifyModelManagerDelete,
	registerFailoverChain,
	registerModelManagerBridge,
} from "../src/model-manager-bridge.ts";
import {
	analyzeDeletionImpact,
	confirmCascade,
	type CatalogImpact,
} from "../src/model-manager-impact.ts";
import {
	buildPreview,
	cloneDraft,
	commitDeleteDraft,
} from "../src/model-manager-operations.ts";
import {
	serializeSidecar,
	validateSidecar,
} from "../src/model-manager-sidecar.ts";
import {
	commitCatalogTransaction,
	readRevision,
} from "../src/model-manager-store.ts";
import { parseRawKeys } from "../src/model-manager-input.ts";
import {
	renderManagerScreen,
	type TuiState,
} from "../src/model-manager-tui.ts";
import { createMemorySharedState } from "../src/shared-state.ts";
import type { TargetRuntime } from "../src/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
	ModelManagerRecord,
	ModelManagerResult,
	ModelManagerSidecar,
} from "../src/model-manager-types.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(
	join(tmpdir(), "model-manager-release-agent-"),
);
let index: typeof import("../src/index.ts") | undefined;

async function getIndex(): Promise<typeof import("../src/index.ts")> {
	if (!index) {
		process.env.PI_CODING_AGENT_DIR = testAgentDir;
		index = await import(
			new URL("../src/index.ts?model-manager-release", import.meta.url).href
		);
	}
	const loaded = index;
	if (!loaded) throw new Error("release index did not load");
	return loaded;
}

type CommandHandler = (
	args: string,
	ctx: unknown,
) => unknown | Promise<unknown>;
type ManagerComponent = {
	render(width: number): string | string[];
	handleInput(data: string): void;
};
type ExtensionHarness = {
	commands: Array<{ name: string; handler: CommandHandler }>;
	shutdown: () => Promise<void>;
};
type RenderedScreen = {
	value: string;
	component?: ManagerComponent;
};

function emptyTargetRuntime(): TargetRuntime {
	return {
		initialAvailabilityKnown: true,
		getModel: () => undefined,
		getAvailableSnapshot: () => [],
		hasConfiguredAuth: () => false,
		refresh: async () => undefined,
		completeSimple: async () => ({}) as never,
		streamSimple: () => ({}) as never,
	};
}

async function createExtensionHarness(
	coordinator?: (recordId: string, impact: CatalogImpact) => Promise<void>,
	analyzeImpact: typeof analyzeDeletionImpact = analyzeDeletionImpact,
): Promise<ExtensionHarness> {
	const commands: Array<{ name: string; handler: CommandHandler }> = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(event, handler),
		registerCommand: (name: string, options: { handler: CommandHandler }) =>
			commands.push({ name, handler: options.handler }),
		registerProvider: () => undefined,
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;
	const currentIndex = await getIndex();
	await currentIndex.registerFailoverExtension(pi, {
		targetRuntime: emptyTargetRuntime(),
		sharedState: createMemorySharedState(),
		modelManagerAnalyzeDeletionImpact: analyzeImpact,
		...(coordinator ? { modelManagerDeleteCoordinator: coordinator } : {}),
	});
	let active = true;
	return {
		commands,
		shutdown: async () => {
			if (!active) return;
			active = false;
			await handlers.get("session_shutdown")?.({}, {});
		},
	};
}

function renderContext(
	rendered: RenderedScreen,
	notifications: string[] = [],
	onRender: () => void = () => undefined,
): unknown {
	let component: ManagerComponent | undefined;
	const refresh = (): void => {
		if (!component) return;
		const output = component.render(120);
		rendered.value = Array.isArray(output) ? output.join("\n") : output;
		onRender();
	};
	return {
		mode: "tui",
		cwd: testAgentDir,
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => undefined,
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
			custom: async (create: Function) => {
				component = create(
					{ requestRender: refresh },
					{ fg: (_color: string, text: string) => text },
					{},
					() => undefined,
				) as ManagerComponent;
				rendered.component = component;
				refresh();
			},
		},
	};
}
function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

afterEach(async () => {
	clearModelManagerBridge();
	if (index) {
		await rm(index.FAILOVER_CONFIG_PATH, { force: true });
		await rm(index.MODELS_JSON_PATH, { force: true });
		await rm(index.MODEL_MANAGER_SIDECAR_PATH, { force: true });
	}
});

after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(testAgentDir, { force: true, recursive: true });
});

const sourceRecord: ModelManagerRecord = {
	id: "source-record",
	providerAlias: "mm-provider-release-old-fingerprint",
	providerName: "Release Provider",
	modelId: "release-model",
	label: "Release model",
	multiplier: 2.5,
	baseUrl: "https://provider.example.test/v1",
	advancedConfig: { region: "test", limits: { context: 128000 } },
};

function snapshot(
	records: readonly ModelManagerRecord[] = [sourceRecord],
): ModelManagerCatalogSnapshot {
	const copied = structuredClone(records) as ModelManagerRecord[];
	return {
		records: copied,
		byId: new Map(copied.map((record) => [record.id, record])),
		providers:
			copied.length === 0
				? []
				: [
						{
							name: sourceRecord.providerAlias,
							apiKey: "",
							models: [{ id: sourceRecord.modelId }],
						},
					],
		failoverUntouched: true,
	};
}

function assertOk<T>(result: ModelManagerResult<T>): T {
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("expected successful result");
	return result.value;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "model-manager-release-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("missing and unreadable blocked catalogs show only safe recovery guidance", () => {
	const base = {
		tab: "model-manager" as const,
		snapshot: null,
		conflict: null,
		message: null,
		pendingDraft: null,
		pendingImpact: null,
		failoverSummary: null,
		history: [],
	};
	const missing = renderManagerScreen({
		...base,
		blocked: {
			reason: "missing",
			message: "/private/secret/missing details",
			compatibilityImport: {
				available: true,
				sourcePaths: ["/private/secret/auth.json", "models.json"],
			},
		},
	});
	assert.match(missing, /Catalog blocked: missing/);
	assert.match(
		missing,
		/Compatibility import available: auth\.json, models\.json/,
	);
	assert.doesNotMatch(missing, /raw bytes preserved/);
	assert.doesNotMatch(missing, /private|secret|missing details/);

	const unreadable = renderManagerScreen({
		...base,
		blocked: {
			reason: "unreadable",
			message: "/private/secret/unreadable details",
		},
	});
	assert.match(unreadable, /Catalog blocked: unreadable/);
	assert.match(
		unreadable,
		/Recovery: repair the sidecar, then reopen \/failover/,
	);
	assert.doesNotMatch(unreadable, /raw bytes preserved/);
	assert.doesNotMatch(unreadable, /private|secret|unreadable details/);
});

test("cancelled delete analysis cannot resurrect a pending commit", async () => {
	const currentIndex = await getIndex();
	await mkdir(dirname(currentIndex.MODELS_JSON_PATH), { recursive: true });
	await writeFile(
		currentIndex.MODELS_JSON_PATH,
		JSON.stringify({
			providers: [
				{
					name: sourceRecord.providerAlias,
					apiKey: "opaque",
					models: [{ id: sourceRecord.modelId, name: sourceRecord.label }],
				},
			],
		}),
	);
	await writeFile(
		currentIndex.MODEL_MANAGER_SIDECAR_PATH,
		`${JSON.stringify({ version: 1, models: [sourceRecord] })}\n`,
	);
	const impact: CatalogImpact = {
		recordId: sourceRecord.id,
		chains: [],
		state: [],
		referenced: false,
	};
	let analysisStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		analysisStarted = resolve;
	});
	let resolveAnalysis!: (result: ModelManagerResult<CatalogImpact>) => void;
	const delayedAnalysis = new Promise<ModelManagerResult<CatalogImpact>>(
		(resolve) => {
			resolveAnalysis = resolve;
		},
	);
	let analysisFinished!: () => void;
	const finished = new Promise<void>((resolve) => {
		analysisFinished = resolve;
	});
	const harness = await createExtensionHarness(
		async () => undefined,
		async () => {
			analysisStarted();
			const result = await delayedAnalysis;
			analysisFinished();
			return result;
		},
	);
	try {
		const command = harness.commands.find((entry) => entry.name === "failover");
		assert.ok(command);
		const rendered: RenderedScreen = { value: "" };
		await command.handler("", renderContext(rendered));
		assert.ok(rendered.component);
		rendered.component.handleInput("d");
		await started;
		rendered.component.handleInput("c");
		resolveAnalysis({ ok: true, value: impact });
		await finished;
		rendered.component.handleInput("y");
		await tick();
		rendered.component.handleInput("d");
		await tick();
		rendered.component.handleInput("n");
		await tick();
		rendered.component.handleInput("y");
		await tick();
		await tick();
		const current = assertOk(
			await readModelCatalog(
				currentIndex.MODELS_JSON_PATH,
				currentIndex.MODEL_MANAGER_SIDECAR_PATH,
			),
		);
		assert.equal(current.byId.has(sourceRecord.id), true);
	} finally {
		await harness.shutdown();
	}
});

test("production delete handler refreshes after a committed notification failure", async () => {
	const currentIndex = await getIndex();
	await mkdir(dirname(currentIndex.MODELS_JSON_PATH), { recursive: true });
	await writeFile(
		currentIndex.MODELS_JSON_PATH,
		JSON.stringify({
			providers: [
				{
					name: sourceRecord.providerAlias,
					apiKey: "opaque",
					models: [{ id: sourceRecord.modelId, name: sourceRecord.label }],
				},
			],
		}),
	);
	await writeFile(
		currentIndex.MODEL_MANAGER_SIDECAR_PATH,
		`${JSON.stringify({ version: 1, models: [sourceRecord] })}\n`,
	);
	const impact: CatalogImpact = {
		recordId: sourceRecord.id,
		chains: [],
		state: [],
		referenced: false,
	};
	let notificationStarted!: () => void;
	const notification = new Promise<void>((resolve) => {
		notificationStarted = resolve;
	});
	const notifications: string[] = [];
	let renderedWarning!: () => void;
	const warningRendered = new Promise<void>((resolve) => {
		renderedWarning = resolve;
	});
	const harness = await createExtensionHarness(
		async () => {
			notificationStarted();
			throw new Error("provider-secret-from-coordinator");
		},
		async () => ({ ok: true, value: impact }),
	);
	try {
		const command = harness.commands.find((entry) => entry.name === "failover");
		assert.ok(command);
		const rendered: RenderedScreen = { value: "" };
		await command.handler(
			"",
			renderContext(rendered, notifications, () => {
				if (
					rendered.value.includes("Delete committed; failover notification failed")
				)
					renderedWarning();
			}),
		);
		assert.ok(rendered.component);
		rendered.component.handleInput("d");
		await tick();
		rendered.component.handleInput("y");
		await notification;
		await warningRendered;
		const current = assertOk(
			await readModelCatalog(
				currentIndex.MODELS_JSON_PATH,
				currentIndex.MODEL_MANAGER_SIDECAR_PATH,
			),
		);
		assert.equal(current.byId.has(sourceRecord.id), false);
		assert.doesNotMatch(rendered.value, /Release model/);
		assert.match(
			rendered.value,
			/Delete committed; failover notification failed/,
		);
		assert.ok(
			notifications.some((message) => /notification failed/.test(message)),
		);
		assert.doesNotMatch(notifications.join("\n"), /provider-secret/);
	} finally {
		await harness.shutdown();
	}
});

test("sidecar unknown fields survive validate serialize validate round trip", () => {
	const sidecar: ModelManagerSidecar = {
		version: 1,
		futureTopLevel: { keep: true, values: [1, "two"] },
		models: [
			{
				...sourceRecord,
				futureRecordField: { nested: { keep: "value" } },
			},
		],
	};

	const validated = assertOk(validateSidecar(sidecar));
	const serialized = assertOk(serializeSidecar(validated));
	const roundTrip = assertOk(
		validateSidecar(JSON.parse(new TextDecoder().decode(serialized))),
	);

	assert.deepEqual(roundTrip, sidecar);
});

test("raw duplicate batch rejects all lines without key material in errors", () => {
	const secret = "release-raw-key-secret";
	const result = parseRawKeys(`${secret}\nsecond-valid-key\n${secret}`);

	assert.equal(result.accepted, false);
	assert.deepEqual(result.entries, []);
	assert.deepEqual(
		result.rejected.map(({ line }) => line),
		[3],
	);
	assert.equal(JSON.stringify(result).includes(secret), false);
});

test("clone keeps advanced fields through buildPreview without secret material", () => {
	const draft = assertOk(
		cloneDraft(snapshot(), sourceRecord.id, "release-clone-fingerprint"),
	);
	const secret = "release-clone-secret";
	draft.secret = secret;
	const preview = assertOk(buildPreview(snapshot(), draft));
	const cloned = preview.sidecarAfter.models.find(
		(record) => record.providerAlias === draft.fields.providerAlias,
	);
	const provider = preview.providerDrafts.find(
		(candidate) => candidate.name === draft.fields.providerAlias,
	);

	assert.deepEqual(cloned?.advancedConfig, sourceRecord.advancedConfig);
	assert.equal(cloned?.baseUrl, sourceRecord.baseUrl);
	assert.deepEqual(
		provider?.models.find((model) => model.id === sourceRecord.modelId)
			?.advancedConfig,
		sourceRecord.advancedConfig,
	);
	assert.equal(provider?.apiKey, "");
	assert.equal(JSON.stringify(preview).includes(secret), false);
});

test("cas conflict leaves every catalog file byte-identical", async () => {
	await withTempDir(async (dir) => {
		const modelsPath = join(dir, "models.json");
		const sidecarPath = join(dir, "model-manager.json");
		const originalModels = Buffer.from('{"providers":[]}\n');
		const originalSidecar = Buffer.from('{"version":1,"models":[]}\n');
		await writeFile(modelsPath, originalModels);
		await writeFile(sidecarPath, originalSidecar);
		const modelsRevision = (await readRevision(modelsPath)).revision;
		const sidecarRevision = (await readRevision(sidecarPath)).revision;
		await writeFile(modelsPath, '{"providers":[{"name":"changed"}]}\n');
		const before = [await readFile(modelsPath), await readFile(sidecarPath)];
		const writes: string[] = [];

		const result = await commitCatalogTransaction(
			{
				writes: [
					{
						path: sidecarPath,
						bytes: Buffer.from('{"version":1,"models":[{}]}\n'),
						expectRevision: sidecarRevision,
					},
					{
						path: modelsPath,
						bytes: Buffer.from('{"providers":[]}\n'),
						expectRevision: modelsRevision,
					},
				],
			},
			async (path, bytes) => {
				writes.push(path);
				await writeFile(path, bytes);
			},
		);

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.phase, "prepare");
		assert.deepEqual(writes, []);
		assert.deepEqual(await readFile(sidecarPath), before[1]);
		assert.deepEqual(await readFile(modelsPath), before[0]);
	});
});

test("blocked sidecar prevents catalog and TUI renders fixed recovery hint", async () => {
	await withTempDir(async (dir) => {
		const modelsPath = join(dir, "models.json");
		const sidecarPath = join(dir, "model-manager.json");
		const rawBytes = Buffer.from("{ malformed release sidecar", "utf8");
		await writeFile(modelsPath, JSON.stringify({ providers: [] }));
		await writeFile(sidecarPath, rawBytes);

		const catalog = await readModelCatalog(modelsPath, sidecarPath);
		assert.equal(catalog.ok, false);
		if (catalog.ok) return;
		assert.equal("reason" in catalog.error, true);
		if (!("reason" in catalog.error)) return;
		assert.equal(catalog.error.reason, "malformed");
		assert.deepEqual(Buffer.from(catalog.error.rawBytes ?? []), rawBytes);

		const state: TuiState = {
			tab: "model-manager",
			snapshot: null,
			blocked: catalog.error,
			conflict: null,
			message: null,
			pendingDraft: null,
			pendingImpact: null,
			failoverSummary: null,
			history: [],
		};
		const rendered = renderManagerScreen(state);
		assert.match(rendered, /Catalog blocked: malformed/);
		assert.match(rendered, /raw bytes preserved/);
		assert.doesNotMatch(rendered, /malformed release sidecar/);
	});
});

test("delete confirmation then notifies bridge with exact impact and no failover writes", async () => {
	await withTempDir(async (dir) => {
		const chainsPath = join(dir, "model-failover.json");
		const statePath = join(dir, "failover-state.json");
		const chainBytes = Buffer.from(
			JSON.stringify({
				chains: {
					primary: [
						{ provider: sourceRecord.providerAlias, modelId: sourceRecord.modelId },
					],
				},
			}) + "\n",
		);
		const stateBytes = Buffer.from(
			JSON.stringify({
				targets: { [`${sourceRecord.providerAlias}/${sourceRecord.modelId}`]: {} },
			}) + "\n",
		);
		await writeFile(chainsPath, chainBytes);
		await writeFile(statePath, stateBytes);
		const before = [await readFile(chainsPath), await readFile(statePath)];
		const impact = assertOk(
			await analyzeDeletionImpact(snapshot(), sourceRecord.id, {
				chainsPath,
				statePath,
			}),
		);
		assert.equal(impact.referenced, true);
		assert.equal(
			confirmCascade(impact, { recordId: sourceRecord.id, ack: true }).ok,
			true,
		);

		let received: { recordId: string; impact: CatalogImpact } | undefined;
		const cleanup = registerModelManagerBridge({
			onDeleteRecord: async (recordId, receivedImpact) => {
				received = { recordId, impact: receivedImpact };
			},
		});
		try {
			await notifyModelManagerDelete(sourceRecord.id, impact);
		} finally {
			cleanup();
		}

		assert.equal(received?.recordId, sourceRecord.id);
		assert.strictEqual(received?.impact, impact);
		assert.deepEqual(await readFile(chainsPath), before[0]);
		assert.deepEqual(await readFile(statePath), before[1]);
	});
});

test("/failover empty handler loads actual catalog records into the manager screen", async () => {
	const currentIndex = await getIndex();
	await mkdir(dirname(currentIndex.MODELS_JSON_PATH), { recursive: true });
	const sidecarPath = currentIndex.MODEL_MANAGER_SIDECAR_PATH;
	const modelsBytes = Buffer.from(
		`${JSON.stringify({
			providers: [
				{
					name: sourceRecord.providerAlias,
					apiKey: "opaque-native-reference",
					models: [{ id: sourceRecord.modelId, name: sourceRecord.label }],
				},
			],
		})}\n`,
	);
	const sidecarBytes = Buffer.from(
		`${JSON.stringify({ version: 1, models: [sourceRecord] })}\n`,
	);
	await writeFile(currentIndex.MODELS_JSON_PATH, modelsBytes);
	await writeFile(sidecarPath, sidecarBytes);
	const harness = await createExtensionHarness();
	try {
		const command = harness.commands.find((entry) => entry.name === "failover");
		assert.ok(command);
		const rendered = { value: "" };
		await command.handler("", renderContext(rendered));
		assert.match(rendered.value, /> Model Manager/);
		assert.match(rendered.value, /Failover Chains/);
		assert.match(rendered.value, /History/);
		assert.match(rendered.value, /Release model/);
		assert.match(rendered.value, /mm-provider-release-old-fingerprint/);
	} finally {
		await harness.shutdown();
		await rm(currentIndex.MODELS_JSON_PATH, { force: true });
		await rm(sidecarPath, { force: true });
	}
});

test("delete coordinator has a real zero-write rejection and confirmed sidecar commit", async () => {
	await withTempDir(async (dir) => {
		const modelsPath = join(dir, "models.json");
		const sidecarPath = join(dir, "model-manager.json");
		const chainsPath = join(dir, "model-failover.json");
		const statePath = join(dir, "failover-state.json");
		const modelsBytes = Buffer.from(
			`${JSON.stringify({
				providers: [
					{
						name: sourceRecord.providerAlias,
						apiKey: "opaque-native-reference",
						models: [{ id: sourceRecord.modelId, name: sourceRecord.label }],
					},
				],
			})}\n`,
		);
		const sidecarBytes = Buffer.from(
			`${JSON.stringify({ version: 1, models: [sourceRecord] })}\n`,
		);
		const chainBytes = Buffer.from(
			JSON.stringify({
				chains: {
					primary: [
						{ provider: sourceRecord.providerAlias, modelId: sourceRecord.modelId },
					],
				},
			}) + "\n",
		);
		const stateBytes = Buffer.from(
			JSON.stringify({
				targets: { [`${sourceRecord.providerAlias}/${sourceRecord.modelId}`]: {} },
			}) + "\n",
		);
		await writeFile(modelsPath, modelsBytes);
		await writeFile(sidecarPath, sidecarBytes);
		await writeFile(chainsPath, chainBytes);
		await writeFile(statePath, stateBytes);

		const catalog = await readModelCatalog(modelsPath, sidecarPath);
		const current = assertOk(catalog);
		const impact = assertOk(
			await analyzeDeletionImpact(current, sourceRecord.id, {
				chainsPath,
				statePath,
			}),
		);
		const before = {
			models: await readFile(modelsPath),
			sidecar: await readFile(sidecarPath),
			chains: await readFile(chainsPath),
			state: await readFile(statePath),
		};
		let notifications = 0;
		let receivedImpact: CatalogImpact | undefined;
		const harness = await createExtensionHarness(async (_recordId, received) => {
			notifications += 1;
			receivedImpact = received;
		});
		try {
			const rejected = await commitDeleteDraft(sourceRecord.id, {
				snapshot: current,
				sidecarPath,
				impact,
				confirmation: { recordId: sourceRecord.id, ack: false },
			});
			assert.equal(rejected.ok, false);
			if (!rejected.ok) {
				assert.equal(
					"code" in rejected.error ? rejected.error.code : undefined,
					"cascade-not-confirmed",
				);
			}
			assert.deepEqual(await readFile(sidecarPath), before.sidecar);
			assert.equal(notifications, 0);

			const mismatch = await commitDeleteDraft(sourceRecord.id, {
				snapshot: current,
				sidecarPath,
				impact,
				confirmation: { recordId: "wrong-record", ack: true },
			});
			assert.equal(mismatch.ok, false);
			assert.deepEqual(await readFile(sidecarPath), before.sidecar);
			assert.equal(notifications, 0);

			const committed = await commitDeleteDraft(sourceRecord.id, {
				snapshot: current,
				sidecarPath,
				impact,
				confirmation: { recordId: sourceRecord.id, ack: true },
			});
			assert.equal(committed.ok, true);
			const afterCatalog = assertOk(
				await readModelCatalog(modelsPath, sidecarPath),
			);
			assert.equal(afterCatalog.byId.has(sourceRecord.id), false);
			assert.deepEqual(await readFile(modelsPath), before.models);
			assert.deepEqual(await readFile(chainsPath), before.chains);
			assert.deepEqual(await readFile(statePath), before.state);
			assert.equal(notifications, 1);
			assert.strictEqual(receivedImpact, impact);
		} finally {
			await harness.shutdown();
		}
	});
});

test("delete notification failures return a safe result", async () => {
	await withTempDir(async (dir) => {
		const sidecarPath = join(dir, "model-manager.json");
		await writeFile(
			sidecarPath,
			Buffer.from(`${JSON.stringify({ version: 1, models: [sourceRecord] })}\n`),
		);
		const cleanup = registerModelManagerBridge({
			onDeleteRecord: async () => {
				throw new Error("provider-secret-from-coordinator");
			},
		});
		try {
			const result = await commitDeleteDraft(sourceRecord.id, {
				snapshot: snapshot(),
				sidecarPath,
				impact: {
					recordId: sourceRecord.id,
					chains: [],
					state: [],
					referenced: false,
				},
				confirmation: { recordId: sourceRecord.id, ack: true },
			});
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(
					"code" in result.error ? result.error.code : undefined,
					"delete-notification-failed",
				);
				assert.equal(result.error.message.includes("provider-secret"), false);
			}
		} finally {
			cleanup();
		}
		const afterSidecar = assertOk(
			validateSidecar(JSON.parse(await readFile(sidecarPath, "utf8"))),
		);
		assert.deepEqual(afterSidecar.models, []);
	});
});

test("virtual model exists only for an explicitly registered chain and is cleaned up", () => {
	clearFailoverChains();
	const records = [sourceRecord];
	assert.equal(buildVirtualModel("release-chain", records), null);

	const cleanup = registerFailoverChain("release-chain");
	try {
		assert.deepEqual(buildVirtualModel("release-chain", records), {
			id: "mm-release-chain",
			provider: sourceRecord.providerAlias,
		});
	} finally {
		cleanup();
		clearFailoverChains();
		clearModelManagerBridge();
	}
	assert.equal(buildVirtualModel("release-chain", records), null);
});
