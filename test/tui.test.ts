import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FailoverProviderState } from "../src/provider.ts";
import { createGeneratedModel } from "../src/generated-config.ts";
import type { GeneratedFailoverModel, ModelRef } from "../src/types.ts";

type FailoverHistoryEntry =
	NonNullable<FailoverProviderState["onTransition"]> extends (
		transition: infer Transition,
	) => void
		? Transition & { timestamp: number }
		: never;
import {
	FailoverEditor,
	FailoverHistoryPanel,
	type FailoverTuiActions,
	type FailoverTuiView,
} from "../src/tui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

function model(
	overrides: Partial<GeneratedFailoverModel> = {},
): GeneratedFailoverModel {
	return { ...createGeneratedModel([]), ...overrides };
}

function makeView(
	models: GeneratedFailoverModel[],
	available: ModelRef[] = [],
): FailoverTuiView {
	return {
		config: { version: 7, models },
		available,
		cooldowns: new Map(),
		manualRecovery: new Map(),
	};
}

function makeActions(
	overrides: Partial<FailoverTuiActions> = {},
): FailoverTuiActions {
	const noop = async () => undefined;
	return {
		onClose: () => undefined,
		onError: () => undefined,
		onAddModel: noop,
		onRemoveModel: noop,
		onToggleModel: noop,
		onRenameModel: noop,
		onAddTarget: noop,
		onRemoveTarget: noop,
		onMoveTarget: noop,
		onSetReasoning: noop,
		onResetCooldown: noop,
		onSetErrorHandling: noop,
		onSetMaxRetries: noop,
		onSetTimeout: noop,
		onSetTargetReasoning: noop,
		onSetTargetParameter: noop,
		onRestore: noop,
		...overrides,
	};
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("history panel renders entries and closes on q", () => {
	const history: FailoverHistoryEntry[] = [
		{
			timestamp: Date.parse("2026-08-22T08:00:00Z"),
			modelId: "default",
			source: { provider: "a", id: "m1" },
			target: { provider: "b", id: "m2" },
			effort: "high",
			mappedEffort: "high",
			reasoningControlled: true,
			reason: "HTTP 500",
		},
	];
	let closed = false;
	const panel = new FailoverHistoryPanel(
		theme,
		() => history,
		() => {
			closed = true;
		},
	);
	const rendered = panel.render(140).join("\n");
	assert.match(rendered, /Failover History/);
	assert.match(rendered, /default a\/m1 -> b\/m2 \[high\] HTTP 500/);
	panel.handleInput("q");
	assert.equal(closed, true);
});

test("history panel renders an empty state", () => {
	const panel = new FailoverHistoryPanel(
		theme,
		() => [],
		() => undefined,
	);
	assert.match(panel.render(100).join("\n"), /No failover transitions recorded/);
});

test("p opens target parameters directly from model detail", () => {
	const entry = model({ chain: [{ provider: "p", id: "a" }] });
	const view = makeView([entry]);
	const editor = new FailoverEditor(theme, () => view, makeActions());

	editor.handleInput("\r");
	editor.handleInput("p");
	assert.ok(
		editor
			.render(120)
			.some((line) => line.includes("Target Parameters: default")),
	);
});

test("Escape after p then t returns to model detail", () => {
	const entry = model({ chain: [{ provider: "p", id: "a" }] });
	const view = makeView([entry]);
	const editor = new FailoverEditor(theme, () => view, makeActions());

	editor.handleInput("\r");
	editor.handleInput("p");
	editor.handleInput("t");
	editor.handleInput("\x1b");
	assert.ok(
		editor.render(120).some((line) => line.includes("Failover Model: default")),
	);
	assert.equal(
		editor.render(120).some((line) => line.includes("Settings: default")),
		false,
	);
});

test("main list renders generated models and Enter opens the detail view", () => {
	const entry = model({ chain: [{ provider: "p", id: "a" }] });
	const view = makeView([entry], [{ provider: "p", id: "a" }]);
	const editor = new FailoverEditor(theme, () => view, makeActions());

	const main = editor.render(120);
	assert.ok(main.some((line) => line.includes('1. default "Default Failover"')));
	assert.ok(main.some((line) => line.includes("p/a")));

	editor.handleInput("\r");
	const detail = editor.render(120);
	assert.ok(detail.some((line) => line.includes("Failover Model: default")));
	assert.ok(detail.some((line) => line.includes("1. p/a")));
	assert.ok(detail.some((line) => line.includes("Retries: 1 (~1s total)")));
});

test("add target filters out already-configured targets and commits selection", async () => {
	const entry = model({ chain: [{ provider: "p", id: "a" }] });
	const available = [
		{ provider: "p", id: "a" },
		{ provider: "p", id: "b" },
	];
	const view = makeView([entry], available);
	const calls: Array<[string, ModelRef]> = [];
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onAddTarget: async (id, target) => {
			calls.push([id, target]);
		},
	});

	editor.handleInput("\r");
	editor.handleInput("a");
	const rendered = editor.render(120);
	assert.ok(rendered.some((line) => line.includes("Add target 1/1: p/b")));
	editor.handleInput("\r");
	await tick();
	assert.deepEqual(calls, [["default", { provider: "p", id: "b" }]]);
});

test("remove target dispatches the selected target", async () => {
	const entry = model({ chain: [{ provider: "p", id: "a" }] });
	const view = makeView([entry]);
	const calls: Array<[string, ModelRef]> = [];
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onRemoveTarget: async (id, target) => {
			calls.push([id, target]);
		},
	});

	editor.handleInput("\r");
	editor.handleInput("d");
	await tick();
	assert.deepEqual(calls, [["default", { provider: "p", id: "a" }]]);
});

test("reorder dispatches move for the selected target", async () => {
	const entry = model({
		chain: [
			{ provider: "p", id: "a" },
			{ provider: "p", id: "b" },
		],
	});
	const view = makeView([entry]);
	const calls: Array<[string, ModelRef, -1 | 1]> = [];
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onMoveTarget: async (id, target, direction) => {
			calls.push([id, target, direction]);
		},
	});

	editor.handleInput("\r");
	editor.handleInput("]");
	await tick();
	assert.deepEqual(calls, [["default", { provider: "p", id: "a" }, 1]]);
});

test("settings reset cooldown dispatches for the selected model", async () => {
	const entry = model();
	const view = makeView([entry]);
	let resetModelId: string | undefined;
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onResetCooldown: async (id) => {
			resetModelId = id;
		},
	});

	editor.handleInput("\r");
	assert.equal(
		editor.render(120).some((line) => line.includes("Cooldown:")),
		false,
	);
	editor.handleInput("t");
	const settings = editor.render(120).join("\n");
	assert.match(settings, /Reset cooldown/);
	assert.doesNotMatch(settings, /Cooldown:/);
	for (let index = 0; index < 4; index++) editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	await tick();
	assert.equal(resetModelId, "default");
});

test("settings selects a reasoning level inline", async () => {
	const entry = model({ reasoningEffort: "medium" });
	const view = makeView([entry]);
	let selected: unknown;
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onSetReasoning: async (_id, effort) => {
			selected = effort;
		},
	});

	editor.handleInput("\r");
	editor.handleInput("t");
	editor.handleInput("\r"); // reasoning (index 0)
	assert.ok(
		editor
			.render(120)
			.some(
				(line) =>
					line.includes("Reasoning level: off") && line.includes("[medium]"),
			),
	);
	editor.handleInput("\x1b[A"); // medium -> low
	editor.handleInput("\r");
	await tick();
	assert.equal(selected, "low");
});

test("target parameters toggles a boolean parameter", async () => {
	const entry = model({ chain: [{ provider: "p", id: "a" }] });
	const view = makeView([entry]);
	const calls: Array<[string, ModelRef, string, boolean]> = [];
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onSetTargetParameter: async (id, target, parameter, enabled) => {
			calls.push([id, target, parameter, enabled]);
		},
	});

	editor.handleInput("\r");
	editor.handleInput("t");
	for (let index = 0; index < 5; index++) editor.handleInput("\x1b[B");
	editor.handleInput("\r"); // target parameters
	assert.ok(
		editor
			.render(120)
			.some((line) => line.includes("Target Parameters: default")),
	);
	assert.ok(
		editor.render(120).some((line) => line.includes("prompt_cache_key: on")),
	);
	editor.handleInput("\x1b[B"); // promptCacheKey
	editor.handleInput("\r");
	await tick();
	assert.deepEqual(calls, [
		["default", { provider: "p", id: "a" }, "promptCacheKey", false],
	]);
});

test("rename edits the model name", async () => {
	const entry = model({ name: "Default Failover" });
	const view = makeView([entry]);
	let renamed: unknown;
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onRenameModel: async (_id, name) => {
			renamed = name;
		},
	});

	editor.handleInput("r");
	assert.ok(
		editor.render(120).some((line) => line.includes("Rename failover model")),
	);
	editor.handleInput("!");
	editor.handleInput("\r");
	await tick();
	assert.equal(renamed, "Default Failover!");
});

test("add model prompts for a name and creates it", async () => {
	const view = makeView([]);
	let created: unknown;
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onAddModel: async (name) => {
			created = name;
		},
	});

	editor.handleInput("a");
	assert.ok(
		editor.render(120).some((line) => line.includes("Add failover model")),
	);
	editor.handleInput("M");
	editor.handleInput("y");
	editor.handleInput("\r");
	await tick();
	assert.equal(created, "My");
	// The input mode exits after commit.
	assert.ok(
		editor.render(120).every((line) => !line.includes("Add failover model")),
	);
});

test("toggle dispatches for the selected model", async () => {
	const entry = model({});
	const view = makeView([entry]);
	let toggled: unknown;
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onToggleModel: async (id) => {
			toggled = id;
		},
	});

	editor.handleInput("e");
	await tick();
	assert.equal(toggled, "default");
});

test("large model lists render a bounded viewport", () => {
	const entries = Array.from({ length: 1_000 }, (_, index) =>
		model({ id: `model-${index}`, name: `Model ${index}` }),
	);
	const view = makeView(entries);
	const editor = new FailoverEditor(theme, () => view, makeActions());

	assert.equal(
		editor.render(120).filter((line) => /\d+\. model-/.test(line)).length,
		20,
	);
	for (let index = 0; index < 25; index++) editor.handleInput("\x1b[B");
	assert.ok(editor.render(120).some((line) => line.includes("model-25")));
});
