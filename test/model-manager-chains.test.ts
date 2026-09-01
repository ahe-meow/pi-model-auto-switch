import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import type { ModelManagerCatalogSnapshot } from "../src/model-manager-catalog.ts";
import type { CatalogImpact } from "../src/model-manager-impact.ts";
import {
	buildVirtualModel,
	notifyModelManagerDelete,
	registerFailoverChain,
	registerModelManagerBridge,
	selectCatalogRecordsForChains,
} from "../src/model-manager-bridge.ts";
import type { ModelManagerRecord } from "../src/model-manager-types.ts";
import type { TargetRuntime } from "../src/index.ts";
import type { TuiState } from "../src/model-manager-tui.ts";
import { createMemorySharedState } from "../src/shared-state.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "model-manager-index-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
const index = await import("../src/index.ts");
const bridgeModule = (await import("../src/model-manager-bridge.ts")) as typeof import("../src/model-manager-bridge.ts") & {
	clearFailoverChains?: () => void;
	clearModelManagerBridge?: () => void;
};

const existingIndexExports = new Set([
	"FAILOVER_CONFIG_PATH",
	"MODELS_JSON_PATH",
	"registerFailoverExtension",
	"default",
]);

type CommandHandler = (args: string, ctx: unknown) => unknown | Promise<unknown>;

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
): Promise<{
	commands: Array<{ name: string; handler: CommandHandler }>;
}> {
	const commands: Array<{ name: string; handler: CommandHandler }> = [];
	const pi = {
		on: () => undefined,
		registerCommand: (name: string, options: { handler: CommandHandler }) =>
			commands.push({ name, handler: options.handler }),
		registerProvider: () => undefined,
		appendEntry: () => undefined,
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	await index.registerFailoverExtension(pi, {
		targetRuntime: emptyTargetRuntime(),
		sharedState: createMemorySharedState(),
		...(coordinator ? { modelManagerDeleteCoordinator: coordinator } : {}),
	});
	return { commands };
}

function renderContext(rendered: { value: string }): unknown {
	return {
		mode: "tui",
		cwd: testAgentDir,
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => undefined,
		},
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			custom: async (create: Function) => {
				const component = create(
					{ requestRender: () => undefined },
					{ fg: (_color: string, text: string) => text },
					{},
					() => undefined,
				) as { render(width: number): string | string[] };
				const output = component.render(120);
				rendered.value = Array.isArray(output) ? output.join("\n") : output;
			},
		},
	};
}

function registerChainWithCleanup(chainId: string): () => void {
	return (registerFailoverChain as unknown as (id: string) => () => void)(
		chainId,
	);
}

function registerBridgeWithCleanup(bridge: {
	onDeleteRecord(recordId: string, impact: CatalogImpact): Promise<void>;
}): () => void {
	return (
		registerModelManagerBridge as unknown as (value: typeof bridge) => () => void
	)(bridge);
}

afterEach(async () => {
	bridgeModule.clearFailoverChains?.();
	bridgeModule.clearModelManagerBridge?.();
	await rm(index.FAILOVER_CONFIG_PATH, { force: true });
});

after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(testAgentDir, { force: true, recursive: true });
});

function record(overrides: Partial<ModelManagerRecord> = {}): ModelManagerRecord {
	return {
		id: "record-a",
		providerAlias: "provider-a",
		providerName: "Provider A",
		modelId: "model-a",
		...overrides,
	};
}

function snapshot(
	records: readonly ModelManagerRecord[],
	byId: readonly ModelManagerRecord[] = records,
): ModelManagerCatalogSnapshot {
	return {
		records: [...records],
		byId: new Map(byId.map((entry) => [entry.id, entry])),
		providers: [],
		failoverUntouched: true,
	};
}

const impact: CatalogImpact = {
	recordId: "record-a",
	chains: [
		{ file: "model-failover.json", chainId: "primary", kind: "model-entry" },
	],
	state: [],
	referenced: true,
};



test("selectCatalogRecordsForChains filters to sidecar records only", () => {
	const sidecarA = record({
		id: "sidecar-a",
		unknown: { nested: { value: "original" } },
	});
	const sidecarB = record({ id: "sidecar-b", modelId: "model-b" });
	const providerOnly = record({ id: "provider-only", modelId: "orphan" });
	const current = snapshot([sidecarA, sidecarB], [sidecarA, sidecarB, providerOnly]);
	const beforeRecords = structuredClone(current.records);
	const beforeById = [...current.byId.entries()];

	const selected = selectCatalogRecordsForChains(current);

	assert.notStrictEqual(selected, current.records);
	assert.notStrictEqual(selected[0], sidecarA);
	assert.notStrictEqual(selected[0]?.unknown, sidecarA.unknown);
	assert.deepEqual(selected, [sidecarA, sidecarB]);
	assert.deepEqual(current.records, beforeRecords);
	assert.deepEqual([...current.byId.entries()], beforeById);
	assert.equal(selected.some((entry) => entry.id === providerOnly.id), false);
	const equivalentClone = structuredClone(sidecarA);
	assert.deepEqual(
		selectCatalogRecordsForChains(snapshot([sidecarA], [equivalentClone])),
		[],
	);
	const selectedUnknown = selected[0]?.unknown as { nested: { value: string } };
	selectedUnknown.nested.value = "changed";
	assert.equal(
		(sidecarA.unknown as { nested: { value: string } }).nested.value,
		"original",
	);
});

test("buildVirtualModel returns null for unregistered chain", () => {
	const records = [record({ providerAlias: "safe-provider" })];

	assert.equal(buildVirtualModel("not-registered", records), null);
	assert.equal(buildVirtualModel("unsafe/chain", records), null);
	assert.equal(buildVirtualModel("", records), null);
});

test("buildVirtualModel rejects unsafe records anywhere in selected chain", () => {
	const cleanup = registerChainWithCleanup("catalog-safe");
	try {
		assert.equal(
			buildVirtualModel("catalog-safe", [
				record({ providerAlias: "safe-provider" }),
				record({ id: "record-b", providerAlias: "unsafe provider" }),
			]),
			null,
		);
	} finally {
		cleanup();
	}
});

test("failover chain registration cleanup is scoped and duplicate-safe", () => {
	const firstCleanup = registerChainWithCleanup("temporary-chain");
	const duplicateCleanup = registerChainWithCleanup("temporary-chain");
	assert.deepEqual(
		buildVirtualModel("temporary-chain", [record({ providerAlias: "safe" })]),
		{ id: "mm-temporary-chain", provider: "safe" },
	);
	firstCleanup();
	assert.deepEqual(
		buildVirtualModel("temporary-chain", [record({ providerAlias: "safe" })]),
		{ id: "mm-temporary-chain", provider: "safe" },
	);
	duplicateCleanup();
	assert.equal(buildVirtualModel("temporary-chain", [record()]), null);
});

test("buildVirtualModel uses mm prefix for registered chain", () => {
	registerFailoverChain("catalog-primary");
	registerFailoverChain("catalog-primary");
	const records = [
		record({
			providerAlias: "safe-provider",
			apiKey: "do-not-return",
		}),
		record({ id: "record-b", providerAlias: "second-provider" }),
	];

	assert.deepEqual(buildVirtualModel("catalog-primary", records), {
		id: "mm-catalog-primary",
		provider: "safe-provider",
	});
	assert.deepEqual(buildVirtualModel("catalog-primary", records), {
		id: "mm-catalog-primary",
		provider: "safe-provider",
	});
	assert.equal(buildVirtualModel("catalog-primary", []), null);
});

test("bridge registration cleanup does not clear a replacement bridge", async () => {
	const calls: string[] = [];
	const firstCleanup = registerBridgeWithCleanup({
		onDeleteRecord: async () => {
			calls.push("first");
		},
	});
	const secondCleanup = registerBridgeWithCleanup({
		onDeleteRecord: async () => {
			calls.push("second");
		},
	});
	firstCleanup();
	await notifyModelManagerDelete("record-a", impact);
	assert.deepEqual(calls, ["second"]);
	secondCleanup();
	await notifyModelManagerDelete("record-a", impact);
	assert.deepEqual(calls, ["second"]);
});

test("/failover handler opens the Model Manager screen and keeps history panel", async () => {
	const harness = await createExtensionHarness();
	const command = harness.commands.find((entry) => entry.name === "failover");
	assert.ok(command);
	const managerRendered = { value: "" };
	await command.handler("", renderContext(managerRendered));
	assert.match(managerRendered.value, /> Model Manager/);
	assert.match(managerRendered.value, /Model Manager/);

	const historyRendered = { value: "" };
	await command.handler("history", renderContext(historyRendered));
	assert.match(historyRendered.value, /Failover History/);
});

test("index wires delete coordinator through the runtime chain queue", async () => {
	const events: string[] = [];
	let releaseFirst!: () => void;
	const firstFinished = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let firstStarted!: () => void;
	const firstStartedPromise = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});
	const coordinator = async (recordId: string, receivedImpact: CatalogImpact) => {
		assert.strictEqual(receivedImpact, impact);
		events.push(`start:${recordId}`);
		if (recordId === "first") {
			firstStarted();
			await firstFinished;
		}
		events.push(`end:${recordId}`);
	};
	await createExtensionHarness(coordinator);
	const first = notifyModelManagerDelete("first", impact);
	await firstStartedPromise;
	const second = notifyModelManagerDelete("second", impact);
	await Promise.resolve();
	assert.deepEqual(events, ["start:first"]);
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(events, [
		"start:first",
		"end:first",
		"start:second",
		"end:second",
	]);
});

test("delete coordinator callback leaves actual failover config bytes unchanged", async () => {
	const calls: string[] = [];
	await createExtensionHarness(async (recordId) => {
		calls.push(recordId);
	});
	const before = await readFile(index.FAILOVER_CONFIG_PATH);
	await notifyModelManagerDelete("record-a", impact);
	const after = await readFile(index.FAILOVER_CONFIG_PATH);
	assert.deepEqual(after, before);
	assert.deepEqual(calls, ["record-a"]);
});

test("notifyModelManagerDelete without a bridge is a safe no-op", async () => {
	await assert.doesNotReject(
		notifyModelManagerDelete("missing-bridge-record", impact),
	);
});

test("bridge delete routes through coordinator callback and leaves failover files byte identical", async () => {
	const directory = await mkdtemp(join(tmpdir(), "model-manager-bridge-"));
	const failoverPaths = [
		join(directory, "model-failover.json"),
		join(directory, "failover-state.json"),
	];
	const originalBytes = [
		Buffer.from('{"version":8,"models":[]}\n'),
		Buffer.from('{"targets":{}}\n'),
	];
	try {
		await Promise.all(
			failoverPaths.map((path, index) => writeFile(path, originalBytes[index])),
		);
		const before = await Promise.all(failoverPaths.map((path) => readFile(path)));
		const calls: Array<{ recordId: string; impact: CatalogImpact }> = [];
		registerModelManagerBridge({
			onDeleteRecord: async (
				recordId: string,
				receivedImpact: CatalogImpact,
			) => {
				calls.push({ recordId, impact: receivedImpact });
			},
		});

		await notifyModelManagerDelete("record-a", impact);

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.recordId, "record-a");
		assert.strictEqual(calls[0]?.impact, impact);
		const after = await Promise.all(failoverPaths.map((path) => readFile(path)));
		assert.deepEqual(after, before);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("bridge delete propagates coordinator callback errors", async () => {
	const failure = new Error("coordinator rejected delete");
	registerModelManagerBridge({
		onDeleteRecord: async () => {
			throw failure;
		},
	});

	await assert.rejects(
		notifyModelManagerDelete("record-a", impact),
		(error) => error === failure,
	);
});

test("index exports model manager api as a superset of previous exports", () => {
	const exported = new Set(Object.keys(index));
	for (const name of existingIndexExports) assert.equal(exported.has(name), true, name);
	for (const name of [
		"buildVirtualModel",
		"notifyModelManagerDelete",
		"registerFailoverChain",
		"registerModelManagerBridge",
		"selectCatalogRecordsForChains",
	]) {
		assert.equal(exported.has(name), true, name);
	}

	assert.equal(index.modelManagerCommand.name, "failover");
	assert.equal(index.modelManagerCommand.initialScreen, "Model Manager");
	const state: TuiState = {
		tab: "model-manager",
		snapshot: null,
		blocked: null,
		conflict: null,
		message: null,
		pendingDraft: null,
		pendingImpact: null,
		failoverSummary: null,
		history: [],
	};
	assert.match(index.modelManagerCommand.render(state), /Model Manager/);
});
