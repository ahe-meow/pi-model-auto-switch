import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FailoverProviderState } from "../src/provider.ts";
import type {
	Inheritable,
	SharedChainScope,
	SharedChainSettings,
	SharedCoordinationStatus,
	SharedTargetOverride,
	SharedTargetRuntime,
	SharedTargetSettings,
} from "../src/shared-state.ts";
import { createGeneratedConfigV8 } from "../src/generated-config.ts";
import type {
	GeneratedFailoverModelV8,
	ModelRef,
	ReasoningEffort,
} from "../src/types.ts";
import {
	FailoverEditor,
	FailoverHistoryPanel,
	type FailoverTuiActions,
	type FailoverTuiView,
} from "../src/tui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

const targetA = { provider: "openai", id: "gpt-5" } as const;
const targetB = { provider: "openai", id: "gpt-4o" } as const;

const defaultSettings: SharedTargetSettings = {
	enabled: true,
	errorHandlingMode: "smart",
	maxRetries: 5,
	noProgressTimeoutSeconds: 90,
	reasoningEffort: "medium",
	modelParameters: {
		promptCacheKey: true,
		promptCacheRetention: true,
		reasoningEffort: true,
		sessionAffinity: true,
	},
};

function runtime(
	overrides: Partial<SharedTargetRuntime> = {},
): SharedTargetRuntime {
	return {
		consecutiveFailures: 0,
		nextEligibleAt: null,
		cooldownUntil: null,
		cooldownLevel: 0,
		cumulativeCooldownMs: 0,
		manualRecovery: null,
		lastFailureReason: null,
		lastFailureAt: null,
		updatedAt: Date.now(),
		...overrides,
	};
}

function record(
	settings: Partial<SharedTargetSettings> = {},
	runtimeOverrides: Partial<SharedTargetRuntime> = {},
) {
	return {
		settings: {
			...defaultSettings,
			...settings,
			modelParameters: {
				...defaultSettings.modelParameters,
				...(settings.modelParameters ?? {}),
			},
		},
		runtime: runtime(runtimeOverrides),
	};
}

function model(
	overrides: Partial<GeneratedFailoverModelV8> = {},
): GeneratedFailoverModelV8 {
	return {
		id: "default",
		name: "Default Failover",
		enabled: true,
		chain: [{ ...targetA }],
		...overrides,
	};
}

function copyChainSettings(
	settings: SharedTargetSettings,
): SharedChainSettings {
	const { enabled: _enabled, ...scopeSettings } = settings;
	return {
		...scopeSettings,
		modelParameters: { ...scopeSettings.modelParameters },
	};
}

function inheritOverride(): SharedTargetOverride {
	return {
		errorHandlingMode: "inherit",
		maxRetries: "inherit",
		noProgressTimeoutSeconds: "inherit",
		reasoningEffort: "inherit",
		modelParameters: {
			promptCacheKey: "inherit",
			promptCacheRetention: "inherit",
			reasoningEffort: "inherit",
			sessionAffinity: "inherit",
		},
	};
}

function scopesFor(
	models: readonly GeneratedFailoverModelV8[],
	targetRecords: ReadonlyMap<string, ReturnType<typeof record>>,
): ReadonlyMap<string, SharedChainScope> {
	return new Map(
		models.map((entry) => {
			const first = entry.chain[0];
			const settings = first
				? (targetRecords.get(`${first.provider}/${first.id}`)?.settings ??
					defaultSettings)
				: defaultSettings;
			return [
				entry.id,
				{
					settings: copyChainSettings(settings),
					targets: entry.chain.map((target) => `${target.provider}/${target.id}`),
					overrides: Object.fromEntries(
						entry.chain.map((target) => [
							`${target.provider}/${target.id}`,
							inheritOverride(),
						]),
					),
				},
			];
		}),
	);
}

function makeView(
	models: GeneratedFailoverModelV8[],
	targetRecords: ReadonlyMap<string, ReturnType<typeof record>> = new Map(),
	available: readonly ModelRef[] = [],
	coordination: SharedCoordinationStatus = { coordination: "shared" },
): FailoverTuiView {
	return {
		config: createGeneratedConfigV8(models),
		available,
		targets: targetRecords,
		scopes: scopesFor(models, targetRecords),
		coordination,
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
		onSetTargetReasoning: noop,
		onSetTargetErrorHandling: noop,
		onSetTargetMaxRetries: noop,
		onSetTargetTimeout: noop,
		onSetTargetParameter: noop,
		onSetScopeReasoning: noop,
		onSetScopeErrorHandling: noop,
		onSetScopeMaxRetries: noop,
		onSetScopeTimeout: noop,
		onSetScopeParameter: noop,
		onToggleTarget: noop,
		onResetTarget: noop,
		...overrides,
	};
}

function openDetail(editor: FailoverEditor): void {
	editor.handleInput("\r");
}

function openSettings(editor: FailoverEditor): void {
	openDetail(editor);
	editor.handleInput("\r");
}

function moveSettingsSelection(editor: FailoverEditor, count: number): void {
	for (let index = 0; index < count; index++) editor.handleInput("\x1b[B");
}

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
	const local = new Date(history[0]!.timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	const localTimestamp = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
	assert.match(rendered, new RegExp(localTimestamp));
	assert.match(rendered, /default a\/m1 -> b\/m2 \[high\] HTTP 500/);
	panel.handleInput("q");
	assert.equal(closed, true);
});

test("history panel empty state is unchanged", () => {
	const panel = new FailoverHistoryPanel(
		theme,
		() => [],
		() => undefined,
	);
	assert.match(panel.render(100).join("\n"), /No failover transitions recorded/);
});

test("main list uses v8 chain fields and coordination status", () => {
	const view = makeView([model()], new Map([["openai/gpt-5", record()]]), [
		targetA,
	]);
	const editor = new FailoverEditor(theme, () => view, makeActions());
	const rendered = editor.render(120).join("\n");
	assert.match(rendered, /Coordination: shared/);
	assert.match(rendered, /1\. default "Default Failover"/);
	assert.match(rendered, /openai\/gpt-5/);
	assert.doesNotMatch(rendered, /Retries:|Error:|Reasoning:/);
});

test("main model list stays within the 20-row viewport", () => {
	const models = Array.from({ length: 100 }, (_, index) =>
		model({ id: `model-${index}`, name: `Model ${index}` }),
	);
	const targets = new Map([["openai/gpt-5", record()]]);
	const view = makeView(models, targets);
	const editor = new FailoverEditor(theme, () => view, makeActions());
	let rendered = editor.render(120).join("\n");
	assert.match(rendered, /Models: 100 {2}Showing 1-20/);
	assert.equal(rendered.includes("21. model-20"), false);
	for (let index = 0; index < 25; index++) editor.handleInput("\x1b[B");
	rendered = editor.render(120).join("\n");
	assert.match(rendered, /Models: 100 {2}Showing 7-26/);
	assert.match(rendered, /> 26\. model-25/);
});
test("detail contains only name/enabled and bounded target chain", () => {
	const chain = Array.from({ length: 100 }, (_, index) => ({
		provider: "p",
		id: `target-${index}`,
	}));
	const targets = new Map(
		chain.map((target) => [`${target.provider}/${target.id}`, record()]),
	);
	const view = makeView([model({ chain })], targets);
	const editor = new FailoverEditor(theme, () => view, makeActions());
	openDetail(editor);
	let rendered = editor.render(120).join("\n");
	assert.match(rendered, /Targets: 100 {2}Showing 1-20/);
	assert.doesNotMatch(rendered, /Retries:|Error behavior|Reasoning:/);
	assert.equal(rendered.includes("p/target-20"), false);
	for (let index = 0; index < 25; index++) editor.handleInput("\x1b[B");
	rendered = editor.render(120).join("\n");
	assert.match(rendered, /Targets: 100 {2}Showing 7-26/);
	assert.match(rendered, /> 26\. p\/target-25/);
});

test("rapid reorder inputs move the same selected target sequentially", async () => {
	const targetC = { provider: "anthropic", id: "claude" } as const;
	const view = makeView([
		model({ chain: [{ ...targetA }, { ...targetB }, { ...targetC }] }),
	]);
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onMoveTarget: async (_id, target, direction) => {
			await Promise.resolve();
			const current = view.config.models[0]!;
			const index = current.chain.findIndex(
				(entry) =>
					`${entry.provider}/${entry.id}` === `${target.provider}/${target.id}`,
			);
			const next = index + direction;
			if (index < 0 || next < 0 || next >= current.chain.length) return;
			[current.chain[index], current.chain[next]] = [
				current.chain[next]!,
				current.chain[index]!,
			];
		},
	});
	openDetail(editor);
	editor.handleInput("]");
	editor.handleInput("]");
	await editor.whenIdle();
	assert.deepEqual(view.config.models[0]!.chain, [targetB, targetC, targetA]);
	assert.match(editor.render(120).join("\n"), /> 3\. openai\/gpt-5/);
});

test("detail commands open chain settings, ignore p, and open target overrides", () => {
	const view = makeView([model()], new Map([["openai/gpt-5", record()]]));

	const chainSettings = new FailoverEditor(theme, () => view, makeActions());
	openDetail(chainSettings);
	chainSettings.handleInput("t");
	const chainRendered = chainSettings.render(120).join("\n");
	assert.match(chainRendered, /Chain Settings: default/);
	assert.match(chainRendered, /Max retries: 5/);
	assert.doesNotMatch(chainRendered, /Max retries: inherit/);
	assert.doesNotMatch(chainRendered, /Target Settings:/);

	const ignored = new FailoverEditor(theme, () => view, makeActions());
	openDetail(ignored);
	ignored.handleInput("p");
	const detailRendered = ignored.render(120).join("\n");
	assert.match(detailRendered, /Failover Model: default/);
	assert.doesNotMatch(detailRendered, /(?:Target|Chain) Settings:/);

	const targetSettings = new FailoverEditor(theme, () => view, makeActions());
	openDetail(targetSettings);
	targetSettings.handleInput("\r");
	const targetRendered = targetSettings.render(120).join("\n");
	assert.match(targetRendered, /Target Settings: openai\/gpt-5/);
	assert.match(targetRendered, /Reasoning: inherit/);
	assert.match(targetRendered, /Error behavior: inherit/);
	assert.match(targetRendered, /Max retries: inherit/);
	assert.match(targetRendered, /No-result timeout: inherit/);
	assert.match(targetRendered, /prompt_cache_key: inherit/);
});

test("target e toggles enabled state and renders disabled marker", async () => {
	const view = makeView([model()], new Map([["openai/gpt-5", record()]]));
	const calls: Array<[ModelRef, boolean]> = [];
	const editor = new FailoverEditor(
		theme,
		() => view,
		makeActions({
			onToggleTarget: async (target, enabled) => {
				calls.push([target, enabled]);
				const current = view.targets.get("openai/gpt-5");
				if (current) {
					(view.targets as Map<string, ReturnType<typeof record>>).set(
						"openai/gpt-5",
						{ ...current, settings: { ...current.settings, enabled } },
					);
				}
			},
		}),
	);
	openDetail(editor);
	editor.handleInput("e");
	await editor.whenIdle();
	assert.deepEqual(calls, [[targetA, false]]);
	assert.match(editor.render(120).join("\n"), /openai\/gpt-5 \[disabled\]/);
});

test("rapid target e inputs toggle the same target sequentially", async () => {
	const targets = new Map([["openai/gpt-5", record()]]);
	const view = makeView([model()], targets);
	let releaseFirst!: () => void;
	let signalFirstStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		signalFirstStarted = resolve;
	});
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const calls: Array<{ target: ModelRef; enabled: boolean }> = [];
	const errors: unknown[] = [];
	const editor = new FailoverEditor(
		theme,
		() => view,
		makeActions({
			onError: (error) => errors.push(error),
			onToggleTarget: async (target, enabled) => {
				calls.push({ target, enabled });
				if (calls.length === 1) {
					signalFirstStarted();
					await firstGate;
				}
				const key = `${target.provider}/${target.id}`;
				const current = targets.get(key);
				if (!current) throw new Error("target record missing");
				targets.set(key, {
					...current,
					settings: { ...current.settings, enabled },
				});
			},
		}),
	);
	openDetail(editor);
	editor.handleInput("e");
	editor.handleInput("e");
	await firstStarted;
	releaseFirst();
	await editor.whenIdle();

	assert.deepEqual(
		calls.map((call) => call.enabled),
		[false, true],
	);
	assert.deepEqual(
		calls.map((call) => call.target),
		[targetA, targetA],
	);
	assert.equal(targets.get("openai/gpt-5")?.settings.enabled, true);
	assert.deepEqual(errors, []);
});

test("empty chains cannot open settings", () => {
	const view = makeView([model({ chain: [] })]);
	const editor = new FailoverEditor(theme, () => view, makeActions());
	openDetail(editor);
	editor.handleInput("\r");
	assert.match(editor.render(120).join("\n"), /No targets configured/);
	assert.doesNotMatch(editor.render(120).join("\n"), /Target Settings:/);
});

test("same target in two chains shares one settings record and one exact-target action", async () => {
	const view = makeView(
		[
			model({ id: "first", chain: [{ ...targetA }] }),
			model({ id: "second", chain: [{ ...targetA }] }),
		],
		new Map([["openai/gpt-5", record()]]),
	);
	const calls: Array<[ModelRef, Inheritable<ReasoningEffort>]> = [];
	const actions = makeActions({
		onSetTargetReasoning: async (target, effort) => {
			calls.push([target, effort]);
		},
	});
	const first = new FailoverEditor(theme, () => view, actions);
	openSettings(first);
	moveSettingsSelection(first, 0);
	first.handleInput("\r");
	first.handleInput("\x1b[A");
	first.handleInput("\r");
	await first.whenIdle();

	const second = new FailoverEditor(theme, () => view, makeActions());
	second.handleInput("\x1b[B");
	openSettings(second);
	assert.match(second.render(120).join("\n"), /Target Settings: openai\/gpt-5/);
});

test("target settings dispatch inheritable overrides and reset action", async () => {
	const view = makeView([model()], new Map([["openai/gpt-5", record()]]));
	const calls: string[] = [];
	const actions = makeActions({
		onSetTargetReasoning: async (target, effort) => {
			calls.push(`reasoning:${target.id}:${effort}`);
		},
		onSetTargetErrorHandling: async (target, mode) => {
			calls.push(`error:${target.id}:${mode}`);
		},
		onSetTargetMaxRetries: async (target, value) => {
			calls.push(`retries:${target.id}:${value}`);
		},
		onSetTargetTimeout: async (target, value) => {
			calls.push(`timeout:${target.id}:${value}`);
		},
		onSetTargetParameter: async (target, parameter, enabled) => {
			calls.push(`parameter:${target.id}:${parameter}:${enabled}`);
		},
		onResetTarget: async (target) => {
			calls.push(`reset:${target.id}`);
		},
	});

	const reasoning = new FailoverEditor(theme, () => view, actions);
	openSettings(reasoning);
	reasoning.handleInput("\r");
	for (let index = 0; index < 4; index++) reasoning.handleInput("\x1b[B");
	reasoning.handleInput("\r");

	const error = new FailoverEditor(theme, () => view, actions);
	openSettings(error);
	moveSettingsSelection(error, 1);
	error.handleInput("\r");
	for (let index = 0; index < 2; index++) error.handleInput("\x1b[B");
	error.handleInput("\r");

	const retries = new FailoverEditor(theme, () => view, actions);
	openSettings(retries);
	moveSettingsSelection(retries, 2);
	retries.handleInput("\r");
	retries.handleInput("3");
	retries.handleInput("\r");

	const timeout = new FailoverEditor(theme, () => view, actions);
	openSettings(timeout);
	moveSettingsSelection(timeout, 3);
	timeout.handleInput("\r");
	timeout.handleInput("\x7f");
	timeout.handleInput("\x7f");
	timeout.handleInput("4");
	timeout.handleInput("5");
	timeout.handleInput("\r");

	const parameter = new FailoverEditor(theme, () => view, actions);
	openSettings(parameter);
	moveSettingsSelection(parameter, 5);
	parameter.handleInput("\r");

	const reset = new FailoverEditor(theme, () => view, actions);
	openSettings(reset);
	moveSettingsSelection(reset, 4);
	reset.handleInput("\r");
	await Promise.all([
		reasoning.whenIdle(),
		error.whenIdle(),
		retries.whenIdle(),
		timeout.whenIdle(),
		parameter.whenIdle(),
		reset.whenIdle(),
	]);

	assert.deepEqual(calls, [
		"reasoning:gpt-5:high",
		"error:gpt-5:switch",
		"retries:gpt-5:3",
		"timeout:gpt-5:45",
		"parameter:gpt-5:promptCacheKey:true",
		"reset:gpt-5",
	]);
});

test("rapid parameter toggles use the latest queued override", async () => {
	const settingsRecord = record();
	const targets = new Map([["openai/gpt-5", settingsRecord]]);
	const view = makeView([model()], targets);
	const enabledValues: Inheritable<boolean>[] = [];
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onSetTargetParameter: async (target, parameter, enabled) => {
			enabledValues.push(enabled);
			await Promise.resolve();
			const scope = view.scopes.get("default");
			if (scope)
				scope.overrides[`${target.provider}/${target.id}`]!.modelParameters[
					parameter
				] = enabled;
		},
	});
	openSettings(editor);
	moveSettingsSelection(editor, 5);
	editor.handleInput("\r");
	editor.handleInput("\r");
	await editor.whenIdle();

	assert.deepEqual(enabledValues, [true, false]);
	assert.equal(
		view.scopes.get("default")?.overrides["openai/gpt-5"]?.modelParameters
			.promptCacheKey,
		false,
	);
});

test("queued parameter update retains its original target after settings switch", async () => {
	const targets = new Map([
		["openai/gpt-5", record()],
		["openai/gpt-4o", record()],
	]);
	const view = makeView(
		[model({ chain: [{ ...targetA }, { ...targetB }] })],
		targets,
	);
	let release!: () => void;
	let signalStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: string[] = [];
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onSetTargetReasoning: async () => {
			signalStarted();
			await gate;
		},
		onSetTargetParameter: async (target, parameter, enabled) => {
			calls.push(`${target.provider}/${target.id}:${parameter}:${enabled}`);
			const scope = view.scopes.get("default");
			if (!scope) throw new Error("target override missing");
			scope.overrides[`${target.provider}/${target.id}`]!.modelParameters[
				parameter
			] = enabled;
		},
	});

	openSettings(editor);
	editor.handleInput("\r");
	editor.handleInput("\r");
	await started;
	moveSettingsSelection(editor, 5);
	editor.handleInput("\r");
	editor.handleInput("\x1b");
	editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	release();
	await editor.whenIdle();

	assert.deepEqual(calls, ["openai/gpt-5:promptCacheKey:true"]);
	const scope = view.scopes.get("default");
	assert.equal(
		scope?.overrides["openai/gpt-5"]?.modelParameters.promptCacheKey,
		true,
	);
	assert.equal(
		scope?.overrides["openai/gpt-4o"]?.modelParameters.promptCacheKey,
		"inherit",
	);
});

test("runtime statuses show eligible, retry, cooldown, probe, manual, and cumulative duration", () => {
	const now = Date.now();
	const chain = [
		targetA,
		targetB,
		{ provider: "p", id: "cool" },
		{ provider: "p", id: "probe" },
		{ provider: "p", id: "manual" },
		{ provider: "p", id: "eligible" },
	];
	const targets = new Map([
		["openai/gpt-5", record({}, { nextEligibleAt: now + 25_000 })],
		[
			"openai/gpt-4o",
			record({}, { cooldownUntil: now + 120_000, cumulativeCooldownMs: 300_000 }),
		],
		["p/cool", record({}, { cooldownUntil: now + 10_000 })],
		["p/probe", record({}, { nextEligibleAt: now + 30_000 })],
		[
			"p/manual",
			record({}, { manualRecovery: { reason: "HTTP 401", updatedAt: now } }),
		],
		["p/eligible", record()],
	]);
	const view = makeView([model({ chain })], targets);
	const editor = new FailoverEditor(theme, () => view, makeActions());
	openDetail(editor);
	const rendered = editor.render(200).join("\n");
	assert.match(rendered, /retry delay/);
	assert.match(rendered, /cooldown/);
	assert.match(rendered, /cumulative cooldown/);
	assert.match(rendered, /retry delay/);
	assert.match(rendered, /manual recovery: HTTP 401/);
	assert.match(rendered, /p\/eligible eligible/);
});

test("degraded coordination warning is visible in main, detail, and settings", () => {
	const degraded: SharedCoordinationStatus = {
		coordination: "degraded",
		reason: "malformed",
		detail: "raw detail must not be shown",
	};
	const view = makeView(
		[model()],
		new Map([["openai/gpt-5", record()]]),
		[],
		degraded,
	);
	const editor = new FailoverEditor(theme, () => view, makeActions());
	assert.match(
		editor.render(120).join("\n"),
		/Coordination: local-only \(malformed\)/,
	);
	openDetail(editor);
	assert.match(
		editor.render(120).join("\n"),
		/Coordination: local-only \(malformed\)/,
	);
	editor.handleInput("\r");
	const settings = editor.render(120).join("\n");
	assert.match(settings, /Coordination: local-only \(malformed\)/);
	assert.doesNotMatch(settings, /raw detail/);
});

test("settings closes safely when its target disappears", () => {
	const records = new Map([["openai/gpt-5", record()]]);
	const view = makeView([model()], records);
	const editor = new FailoverEditor(theme, () => view, makeActions());
	openSettings(editor);
	records.delete("openai/gpt-5");
	view.config.models[0]!.chain = [];
	assert.doesNotMatch(editor.render(120).join("\n"), /Target Settings:/);
	assert.match(editor.render(120).join("\n"), /No targets configured/);
});

test("add-target candidates hide long detail chains in an independent bounded view", () => {
	const chain = Array.from({ length: 100 }, (_, index) => ({
		provider: "p",
		id: `chain-target-${index}`,
	}));
	const targets = new Map(
		chain.map((target) => [`${target.provider}/${target.id}`, record()]),
	);
	const available = Array.from({ length: 6 }, (_, index) => ({
		provider: "p",
		id: `candidate-${index}`,
	}));
	const view = makeView([model({ chain })], targets, available);
	const editor = new FailoverEditor(
		theme,
		() => view,
		makeActions(),
		{ maxVisibleRows: 3 },
	);

	openDetail(editor);
	editor.handleInput("a");
	let rendered = editor.render(120).join("\n");
	assert.match(rendered, /Candidates: 6/);
	assert.ok(rendered.includes("> 1. p/candidate-0"));
	assert.doesNotMatch(rendered, /Targets: 100/);
	assert.doesNotMatch(rendered, /p\/chain-target-99/);

	for (let index = 0; index < 3; index++) editor.handleInput("\x1b[B");
	rendered = editor.render(120).join("\n");
	assert.match(rendered, /Showing 2-4/);
	assert.ok(rendered.includes("> 4. p/candidate-3"));
});

test("add-target candidates respect max visible rows and scroll selection into view", () => {
	const available = Array.from({ length: 6 }, (_, index) => ({
		provider: "p",
		id: `candidate-${index}`,
	}));
	const view = makeView([model({ chain: [] })], new Map(), available);
	const editor = new FailoverEditor(
		theme,
		() => view,
		makeActions(),
		{ maxVisibleRows: 3 },
	);
	openDetail(editor);
	editor.handleInput("a");
	let rendered = editor.render(120).join("\n");
	assert.match(rendered, /Candidates: 6 {2}Showing 1-3/);
	assert.equal(
		rendered
			.split("\n")
			.filter((line) => line.includes("candidate-"))
			.length,
		3,
	);
	assert.equal(rendered.includes("p/candidate-3"), false);

	for (let index = 0; index < 3; index++) editor.handleInput("\x1b[B");
	rendered = editor.render(120).join("\n");
	assert.match(rendered, /Candidates: 6 {2}Showing 2-4/);
	assert.ok(rendered.includes("> 4. p/candidate-3"));
});

test("add-target search filters directly and backspace broadens matches", () => {
	const available = [
		{ provider: "openai", id: "gpt-5" },
		{ provider: "openai", id: "gpt-4" },
		{ provider: "openai", id: "gpt-4o" },
		{ provider: "anthropic", id: "claude" },
	];
	const view = makeView([model({ chain: [] })], new Map(), available);
	const editor = new FailoverEditor(
		theme,
		() => view,
		makeActions(),
		{ maxVisibleRows: 5 },
	);
	openDetail(editor);
	editor.handleInput("a");
	editor.handleInput("4");
	editor.handleInput("O");
	let rendered = editor.render(120).join("\n");
	assert.ok(rendered.includes("Search: 4O"));
	assert.ok(rendered.includes("Candidates: 1"));
	assert.ok(rendered.includes("openai/gpt-4o"));
	assert.equal(rendered.includes("openai/gpt-5"), false);
	assert.equal(
		rendered
			.split("\n")
			.some((line) => /(?:^| )openai\/gpt-4\s*$/.test(line)),
		false,
	);
	assert.equal(rendered.includes("anthropic/claude"), false);

	editor.handleInput("\x7f");
	rendered = editor.render(120).join("\n");
	assert.ok(rendered.includes("Search: 4"));
	assert.ok(rendered.includes("Candidates: 2"));
	assert.equal(
		rendered.split("\n").some((line) => line.trim().endsWith("openai/gpt-4")),
		true,
	);
	assert.ok(rendered.includes("openai/gpt-4o"));

	editor.handleInput("q");
	rendered = editor.render(120).join("\n");
	assert.ok(rendered.includes("Search: 4q"));
	assert.ok(rendered.includes("Candidates: 0"));
});

test("add-target search does not add when there are no matches", async () => {
	const available = [{ provider: "openai", id: "gpt-5" }];
	const view = makeView([model({ chain: [] })], new Map(), available);
	const calls: ModelRef[] = [];
	const editor = new FailoverEditor(
		theme,
		() => view,
		makeActions({
			onAddTarget: async (_id, target) => {
				calls.push(target);
			},
		}),
		{ maxVisibleRows: 3 },
	);
	openDetail(editor);
	editor.handleInput("a");
	for (const character of "zzz") editor.handleInput(character);
	assert.ok(editor.render(120).join("\n").includes("No matching targets"));
	editor.handleInput("\r");
	await editor.whenIdle();
	assert.deepEqual(calls, []);
});

test("add-target search uses the first Escape to clear and the second to close", () => {
	const available = [{ provider: "openai", id: "gpt-5" }];
	const view = makeView([model({ chain: [] })], new Map(), available);
	const editor = new FailoverEditor(
		theme,
		() => view,
		makeActions(),
		{ maxVisibleRows: 3 },
	);
	openDetail(editor);
	editor.handleInput("a");
	editor.handleInput("g");
	assert.ok(editor.render(120).join("\n").includes("Search: g"));

	editor.handleInput("\x1b");
	let rendered = editor.render(120).join("\n");
	assert.equal(rendered.includes("Search: g"), false);
	assert.ok(rendered.includes("Candidates:"));

	editor.handleInput("\x1b");
	rendered = editor.render(120).join("\n");
	assert.equal(rendered.includes("Candidates:"), false);
});

test("add-target candidates remain bounded and Enter dispatches selected item", async () => {
	const available = Array.from({ length: 100 }, (_, index) => ({
		provider: "p",
		id: `candidate-${index}`,
	}));
	const view = makeView([model({ chain: [] })], new Map(), available);
	const calls: Array<[string, ModelRef]> = [];
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onAddTarget: async (id, target) => {
			calls.push([id, target]);
		},
	});
	openDetail(editor);
	editor.handleInput("a");
	assert.match(editor.render(120).join("\n"), /Candidates: 100 {2}Showing 1-20/);
	for (let index = 0; index < 25; index++) editor.handleInput("\x1b[B");
	assert.match(editor.render(120).join("\n"), /Candidates: 100 {2}Showing 7-26/);
	editor.handleInput("\r");
	await editor.whenIdle();
});

test("main CRUD actions retain v8 model shape", async () => {
	const view = makeView([]);
	const calls: string[] = [];
	const editor = new FailoverEditor(theme, () => view, {
		...makeActions(),
		onAddModel: async (name) => {
			calls.push(`add:${name}`);
		},
		onToggleModel: async (id) => {
			calls.push(`toggle:${id}`);
		},
	});
	editor.handleInput("a");
	editor.handleInput("X");
	editor.handleInput("\r");
	await editor.whenIdle();
});

type FailoverHistoryEntry =
	NonNullable<FailoverProviderState["onTransition"]> extends (
		transition: infer Transition,
	) => void
		? Transition & { timestamp: number }
		: never;
