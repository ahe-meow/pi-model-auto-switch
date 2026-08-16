import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	FailoverEditor,
	runTuiAction,
	type FailoverTuiView,
} from "../src/tui.ts";

test("TUI actions report rejected promises through the visible error callback", async () => {
	const errors: unknown[] = [];
	runTuiAction(
		async () => {
			throw new Error("save failed");
		},
		(error) => errors.push(error),
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(errors.length, 1);
	assert.equal((errors[0] as Error).message, "save failed");
});

test("reorder actions move the item selected when the key was pressed", async () => {
	const models = Array.from({ length: 4 }, (_, index) => ({
		provider: "p",
		id: `model-${index}`,
	}));
	const view: FailoverTuiView = {
		config: {
			version: 2,
			enabled: true,
			paused: false,
			models,
			noProgressTimeoutSeconds: 90,
			manualRecovery: {},
		},
		models,
		available: models,
		current: models[0],
		mode: "enabled",
		cooldowns: new Map(),
		manualRecovery: new Map(),
	};
	const theme = {
		fg: (_color: string, text: string) => text,
	} as unknown as Theme;
	const moves: Array<{ index: number; direction: -1 | 1 }> = [];
	let releaseFirst!: () => void;
	const firstPending = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const noop = async () => undefined;
	const editor = new FailoverEditor(theme, () => view, {
		onClose: () => undefined,
		onError: () => undefined,
		onAdd: noop,
		onRemove: noop,
		onMove: async (index, direction) => {
			moves.push({ index, direction });
			if (moves.length === 1) await firstPending;
		},
		onSelect: noop,
		onToggleEnabled: noop,
		onSetTimeout: noop,
		onRestore: noop,
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
	const view: FailoverTuiView = {
		config: {
			version: 2,
			enabled: true,
			paused: false,
			models,
			noProgressTimeoutSeconds: 90,
			manualRecovery: {},
		},
		models,
		available: models,
		current: models[0],
		mode: "enabled",
		cooldowns: new Map(),
		manualRecovery: new Map(),
	};
	const theme = {
		fg: (_color: string, text: string) => text,
	} as unknown as Theme;
	const noop = async () => undefined;
	const editor = new FailoverEditor(theme, () => view, {
		onClose: () => undefined,
		onError: () => undefined,
		onAdd: noop,
		onRemove: noop,
		onMove: noop,
		onSelect: noop,
		onToggleEnabled: noop,
		onSetTimeout: noop,
		onRestore: noop,
	});

	assert.equal(
		editor.render(120).filter((line) => /\d+\. p\/model-/.test(line)).length,
		20,
	);
	for (let index = 0; index < 25; index++) editor.handleInput("\x1b[B");
	assert.ok(editor.render(120).some((line) => line.includes("model-25")));
});
