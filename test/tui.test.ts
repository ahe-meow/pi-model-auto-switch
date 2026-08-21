import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ModelRef, ReasoningEffort } from "../src/types.ts";
import {
	FailoverEditor,
	type FailoverTuiActions,
	type FailoverTuiView,
} from "../src/tui.ts";

function makeView(
	models: Array<{ provider: string; id: string }>,
): FailoverTuiView {
	return {
		config: {
			version: 5,
			enabled: true,
			paused: false,
			models,
			reasoningEffort: "medium",
			cooldownMinutes: 30,
			errorHandlingMode: "smart",
			maxRetries: 1,
			noProgressTimeoutSeconds: 90,
			manualRecovery: {},
			modelParameters: {},
			modelReasoningEfforts: {},
		},
		models,
		available: models,
		current: models[0],
		mode: "enabled",
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
		onAdd: noop,
		onRemove: noop,
		onMove: noop,
		onSelect: noop,
		onToggleEnabled: noop,
		onSetCooldownMinutes: noop,
		onSetErrorHandlingMode: noop,
		onSetMaxRetries: noop,
		onSetTimeout: noop,
		onSetReasoningEffort: noop,
		onSetModelReasoningEffort: noop,
		onSetModelParameter: noop,
		onRestore: noop,
		...overrides,
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

test("reasoning selection stays inside the failover editor", async () => {
	const models = [{ provider: "p", id: "model" }];
	const view = makeView(models);
	let selected: unknown;
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onSetReasoningEffort: async (effort) => {
			selected = effort;
		},
	});

	editor.handleInput("i");
	assert.ok(
		editor.render(120).some((line) => line.includes("Select reasoning")),
	);
	editor.handleInput("\x1b[A");
	editor.handleInput("\r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(selected, "low");
	assert.ok(
		editor.render(120).every((line) => !line.includes("Select reasoning")),
	);
});

test("t opens settings and edits the no-result timeout", async () => {
	const models = [{ provider: "p", id: "model" }];
	const view = makeView(models);
	let value: unknown;
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onSetTimeout: async (next) => {
			value = next;
		},
	});

	editor.handleInput("t");
	const settings = editor.render(120);
	assert.ok(settings.some((line) => line.includes("Failover Settings")));
	assert.ok(settings.some((line) => line.includes("Max retries: 1")));
	editor.handleInput("\x1b[B");
	editor.handleInput("\x1b[B");
	editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	assert.ok(
		editor.render(120).some((line) => line.includes("Enter No-result timeout")),
	);
	editor.handleInput("\x7f");
	editor.handleInput("\x7f");
	editor.handleInput("120");
	editor.handleInput("\r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(value, "120");
});

test("reorder actions move the item selected when the key was pressed", async () => {
	const models = Array.from({ length: 4 }, (_, index) => ({
		provider: "p",
		id: `model-${index}`,
	}));
	const view = makeView(models);
	const moves: Array<{ index: number; direction: -1 | 1 }> = [];
	let releaseFirst!: () => void;
	const firstPending = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onMove: async (index, direction) => {
			moves.push({ index, direction });
			if (moves.length === 1) await firstPending;
		},
	});

	editor.handleInput("\x1b[B");
	editor.handleInput("]");
	editor.handleInput("[");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(moves, [{ index: 1, direction: 1 }]);

	releaseFirst();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(moves, [
		{ index: 1, direction: 1 },
		{ index: 2, direction: -1 },
	]);
});

test("large model lists render a bounded viewport for responsive arrow navigation", () => {
	const models = Array.from({ length: 1_000 }, (_, index) => ({
		provider: "p",
		id: `model-${index}`,
	}));
	const view = makeView(models);
	const editor = new FailoverEditor(theme, () => view, makeActions());

	assert.equal(
		editor.render(120).filter((line) => /\d+\. p\/model-/.test(line)).length,
		20,
	);
	for (let index = 0; index < 25; index++) editor.handleInput("\x1b[B");
	assert.ok(editor.render(120).some((line) => line.includes("model-25")));
});

test("settings opens per-model parameter toggles and toggles via Enter", async () => {
	const models = [
		{ provider: "p", id: "a" },
		{ provider: "p", id: "b" },
	];
	const view = makeView(models);
	const calls: Array<[string, string, boolean]> = [];
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onSetModelParameter: async (model, parameter, enabled) => {
			calls.push([`${model.provider}/${model.id}`, parameter, enabled]);
		},
	});

	editor.handleInput("t");
	for (let index = 0; index < 4; index++) editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	const rendered = editor.render(120);
	assert.ok(rendered.some((line) => line.includes("Model Parameters")));
	assert.ok(rendered.some((line) => line.includes("Model: p/a")));
	assert.ok(rendered.some((line) => line.includes("Reasoning level: inherit")));
	assert.ok(rendered.some((line) => line.includes("prompt_cache_key: on")));
	assert.ok(rendered.some((line) => line.includes("session headers: on")));

	editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(calls[0], ["p/a", "promptCacheKey", false]);

	editor.handleInput("\x1b[C");
	assert.ok(editor.render(120).some((line) => line.includes("Model: p/b")));
	editor.handleInput("\x1b[B");
	editor.handleInput("\x1b[B");
	editor.handleInput(" ");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(calls[1], ["p/b", "reasoningEffort", false]);

	editor.handleInput("\x1b");
	assert.ok(
		editor.render(120).some((line) => line.includes("Failover Settings")),
	);
});

test("model parameters page selects reasoning override separately from boolean toggles", async () => {
	const models = [{ provider: "p", id: "a" }];
	const view = makeView(models);
	view.config.modelReasoningEfforts = { "p/a": "high" };
	let called = false;
	let selected: unknown;
	const onSetModelReasoningEffort = async (
		_model: ModelRef,
		effort: ReasoningEffort | undefined,
	): Promise<void> => {
		called = true;
		selected = effort;
	};
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onSetModelReasoningEffort,
	} as FailoverTuiActions);

	editor.handleInput("t");
	for (let index = 0; index < 4; index++) editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	assert.ok(
		editor.render(120).some((line) => line.includes("Reasoning level: high")),
	);
	assert.ok(
		editor.render(120).some((line) => line.includes("prompt_cache_key: on")),
	);

	editor.handleInput("\r");
	assert.ok(editor.render(120).some((line) => line.includes("inherit")));
	for (let index = 0; index < 4; index++) editor.handleInput("\x1b[A");
	editor.handleInput("\r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(called, true);
	assert.equal(selected, undefined);
});

test("main header shows selected model effective reasoning level", () => {
	const models = [
		{ provider: "p", id: "a" },
		{ provider: "p", id: "b" },
	];
	const view = makeView(models);
	view.config.modelReasoningEfforts = { "p/a": "max" };
	const editor = new FailoverEditor(theme, () => view, makeActions());
	assert.ok(editor.render(120).some((line) => line.includes("Reasoning: max")));
});

test("parameter page renders stored toggle values and guards empty models", () => {
	const models = [{ provider: "p", id: "a" }];
	const view = makeView(models);
	view.config.modelParameters = {
		"p/a": {
			promptCacheKey: false,
			promptCacheRetention: true,
			reasoningEffort: false,
			sessionAffinity: true,
		},
	};
	const editor = new FailoverEditor(theme, () => view, makeActions());
	editor.handleInput("t");
	for (let index = 0; index < 4; index++) editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	const rendered = editor.render(120);
	assert.ok(rendered.some((line) => line.includes("prompt_cache_key: off")));
	assert.ok(rendered.some((line) => line.includes("reasoning effort: off")));
	assert.ok(rendered.some((line) => line.includes("session headers: on")));

	const emptyView = makeView([]);
	const emptyEditor = new FailoverEditor(theme, () => emptyView, makeActions());
	emptyEditor.handleInput("t");
	for (let index = 0; index < 4; index++) emptyEditor.handleInput("\x1b[B");
	emptyEditor.handleInput("\r");
	assert.ok(
		emptyEditor.render(120).some((line) => line.includes("Failover Settings")),
	);
	assert.ok(
		emptyEditor.render(120).every((line) => !line.includes("Model Parameters")),
	);
});

test("settings model-parameters row falls back when selection is stale", () => {
	const models = [{ provider: "p", id: "a" }];
	const view = makeView(models);
	const editor = new FailoverEditor(theme, () => view, makeActions());
	editor.handleInput("\x1b[B"); // try to move down past the single model
	editor.handleInput("\x1b[B");
	editor.handleInput("t"); // stale selectedIndex
	const rendered = editor.render(120);
	assert.ok(
		rendered.some((line) => line.includes("Model parameters: \u2192 p/a")),
	);
});

test("parameter page renders safely if its model disappears", () => {
	const models = [{ provider: "p", id: "model" }];
	const view = makeView(models);
	const editor = new FailoverEditor(theme, () => view, makeActions());
	editor.handleInput("t");
	for (let index = 0; index < 4; index++) editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	(view.models as Array<{ provider: string; id: string }>).length = 0;
	assert.doesNotThrow(() => editor.render(120));
	assert.ok(
		editor.render(120).some((line) => line.includes("No model selected")),
	);
});
