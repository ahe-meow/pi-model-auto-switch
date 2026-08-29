import assert from "node:assert/strict";
import { test } from "node:test";
import { createGeneratedModel } from "../src/generated-config.ts";
import {
	createFailoverProvider,
	type AssistantMessageLike,
	type Delegate,
	type FailoverProviderState,
	type RequestOptions,
	type TargetModelLike,
	runFailoverRequest,
} from "../src/provider.ts";
import { promptCacheKeyFromSessionId } from "../src/request-params.ts";
import {
	createMemorySharedState,
	type SharedStateAdapter,
	type SharedTargetSettingsPatch,
} from "../src/shared-state.ts";
import type {
	GeneratedFailoverModel,
	GeneratedFailoverModelV8,
	ModelRef,
} from "../src/types.ts";
import { modelKey } from "../src/types.ts";

interface Step {
	status?: number;
	result?: AssistantMessageLike;
	error?: Error;
}

function targetModel(ref: ModelRef): TargetModelLike {
	return {
		provider: ref.provider,
		id: ref.id,
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		thinkingLevelMap: {
			off: "none",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	};
}

function okMessage(ref: ModelRef): AssistantMessageLike {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider: ref.provider,
		model: ref.id,
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
		stopReason: "stop",
		timestamp: 1,
	};
}

function errorMessage(
	ref: ModelRef,
	message: string,
	stopReason = "error",
): AssistantMessageLike {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: ref.provider,
		model: ref.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason,
		errorMessage: message,
		timestamp: 1,
	};
}

function unsupportedCacheFieldMessage(
	ref: ModelRef,
	field: "prompt_cache_key" | "prompt_cache_retention",
): AssistantMessageLike {
	return errorMessage(
		ref,
		JSON.stringify({
			error: {
				type: "invalid_request_error",
				param: field,
				code: "unsupported_parameter",
			},
		}),
	);
}

function structuredError(
	category: string,
	message: string,
	details?: Record<string, unknown>,
	metadataStatus?: number,
): Error {
	const error = new Error("external delegate failure");
	Object.assign(error, {
		error_metadata: {
			category,
			message,
			...(metadataStatus === undefined ? {} : { status: metadataStatus }),
			...(details ? { details } : {}),
		},
	});
	return error;
}

interface Scripted {
	delegate: Delegate;
	calls: Array<{ model: TargetModelLike; options: RequestOptions }>;
}

function scriptedDelegate(
	models: Map<string, TargetModelLike>,
	steps: Step[],
): Scripted {
	const calls: Array<{ model: TargetModelLike; options: RequestOptions }> = [];
	let index = 0;
	return {
		calls,
		delegate: {
			resolveModel: (target) => models.get(modelKey(target)),
			complete: async (model, _context, options) => {
				calls.push({ model, options });
				const step = steps[index++] ?? {};
				if (step.status !== undefined)
					await options.onResponse?.({ status: step.status, headers: {} });
				if (step.error) throw step.error;
				return step.result as AssistantMessageLike;
			},
		},
	};
}

function makeState(
	models: GeneratedFailoverModel[],
	delegate: Delegate,
	sharedState?: SharedStateAdapter,
): FailoverProviderState {
	return {
		config: { models },
		metadata: [],
		delegate,
		availableTargetKeys: new Set(),
		availabilityKnown: false,
		cooldowns: new Map(),
		cooldownLevels: new Map(),
		manualRecovery: new Map(),
		unsupportedCacheFields: new Map(),
		sharedState,
	};
}

async function makeSharedState(
	chain: readonly ModelRef[],
	patch: SharedTargetSettingsPatch = {},
	options: NonNullable<Parameters<typeof createMemorySharedState>[0]> = {},
): Promise<SharedStateAdapter> {
	const shared = createMemorySharedState(options);
	const registration = await shared.reconcileRegistration({
		agentDirectory: "/tmp/provider-r3a-shared",
		targets: chain,
	});
	assert.equal(registration.kind, "reconciled");
	for (const target of chain) {
		const updated = await shared.updateSettings(target, patch);
		assert.equal(updated.kind, "updated");
	}
	return shared;
}

function mutableClock(start = Date.now()): {
	now: () => number;
	set: (value: number) => void;
	value: () => number;
} {
	let current = start;
	return {
		now: () => current,
		set: (value) => {
			current = value;
		},
		value: () => current,
	};
}

async function consume(
	stream: AsyncIterable<unknown> & { result(): Promise<unknown> },
): Promise<{ events: unknown[]; result: AssistantMessageLike }> {
	const events: unknown[] = [];
	for await (const event of stream) events.push(event);
	const result = (await stream.result()) as AssistantMessageLike;
	return { events, result };
}

test("known availability filters virtual models with no authenticated target", () => {
	const generated = createGeneratedModel([{ provider: "a", id: "m1" }]);
	generated.id = "primary";
	const state = makeState([generated], {
		resolveModel: () => targetModel({ provider: "a", id: "m1" }),
		complete: async () => okMessage({ provider: "a", id: "m1" }),
	});
	const provider = createFailoverProvider(state);
	assert.deepEqual(provider.filterModels([{ id: "primary" }]), [
		{ id: "primary" },
	]);
	state.availabilityKnown = true;
	assert.deepEqual(provider.filterModels([{ id: "primary" }]), []);
	state.availableTargetKeys = new Set(["a/m1"]);
	assert.deepEqual(provider.filterModels([{ id: "primary" }]), [
		{ id: "primary" },
	]);
});

test("no-progress timeout aborts a stalled target and advances", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.noProgressTimeoutSeconds = 0.01;
	generated.maxRetries = 0;
	let calls = 0;
	const delegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async () => okMessage(b),
		stream: (_model, _context, options) => {
			calls++;
			if (calls === 1) {
				return {
					async *[Symbol.asyncIterator]() {
						await new Promise<void>((resolve) =>
							options.signal?.addEventListener("abort", () => resolve(), {
								once: true,
							}),
						);
						yield* [];
					},
					result: async () => errorMessage(a, "stalled"),
				};
			}
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", reason: "stop", message: okMessage(b) };
				},
				result: async () => okMessage(b),
			};
		},
	};
	const { result } = await consume(
		runFailoverRequest(generated, {}, {}, makeState([generated], delegate)),
	);
	assert.equal(result.model, "m2");
	assert.equal(calls, 2);
});
test("success buffers a single done event and forwards the target message", async () => {
	const generated = createGeneratedModel([{ provider: "a", id: "m1" }]);
	generated.id = "primary";
	generated.name = "Primary";
	const { delegate, calls } = scriptedDelegate(
		new Map([["a/m1", targetModel({ provider: "a", id: "m1" })]]),
		[{ result: okMessage({ provider: "a", id: "m1" }) }],
	);
	const { events, result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{ sessionId: "s1" },
			makeState([generated], delegate),
		),
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(events.length, 1);
	assert.equal((events[0] as { type: string }).type, "done");
	assert.equal(calls.length, 1);
});

test("a thrown delegate error fails over to the next target", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const { delegate, calls } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[{ error: new Error('No API key found for "a"') }, { result: okMessage(b) }],
	);
	const state = makeState([generated], delegate);
	const { result } = await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(result.provider, "b");
	assert.equal(result.model, "m2");
	assert.equal(calls.length, 2);
});

test("transport stream-read errors are cooldown failures with a network transition reason", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.errorHandlingMode = "switch";
	generated.maxRetries = 0;
	const { delegate } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[{ error: new Error("stream_read_error") }, { result: okMessage(b) }],
	);
	const state = makeState([generated], delegate);
	const transitions: Array<{ reason: string }> = [];
	state.onTransition = (transition) =>
		transitions.push({ reason: transition.reason });

	const { result } = await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(result.provider, "b");
	assert.equal(result.model, "m2");
	assert.equal(state.cooldownLevels.get("primary:a/m1"), 1);
	assert.equal(transitions[0]?.reason, "network failure");
});

test("structured provider rate-limit errors fail over and arm cooldown", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.errorHandlingMode = "switch";
	generated.maxRetries = 0;
	const { delegate } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{
				error: structuredError(
					"provider_rate_limit",
					"provider rate limit exceeded",
				),
			},
			{ result: okMessage(b) },
		],
	);
	const state = makeState([generated], delegate);

	const { result } = await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(result.provider, "b");
	assert.equal(result.model, "m2");
	assert.equal(state.cooldownLevels.get("primary:a/m1"), 1);
});

test("structured provider auth errors fail over with manual recovery and no cooldown", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.errorHandlingMode = "switch";
	generated.maxRetries = 0;
	const { delegate } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{
				error: structuredError("provider_auth_error", "provider auth failure"),
			},
			{ result: okMessage(b) },
		],
	);
	const state = makeState([generated], delegate);

	const { result } = await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(result.provider, "b");
	assert.equal(result.model, "m2");
	assert.equal(
		state.manualRecovery.get("primary:a/m1"),
		"provider auth failure",
	);
	assert.equal(state.cooldowns.has("primary:a/m1"), false);
});

test("structured provider API errors preserve HTTP status for cooldown classification", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.errorHandlingMode = "switch";
	generated.maxRetries = 0;
	const { delegate } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{
				error: structuredError(
					"provider_api_error",
					"OpenAI API error (502): upstream error",
					{ status: 502 },
				),
			},
			{ result: okMessage(b) },
		],
	);
	const state = makeState([generated], delegate);
	const transitions: Array<{ reason: string }> = [];
	state.onTransition = (transition) =>
		transitions.push({ reason: transition.reason });

	const { result } = await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(result.provider, "b");
	assert.equal(result.model, "m2");
	assert.equal(state.cooldownLevels.get("primary:a/m1"), 1);
	assert.equal(transitions[0]?.reason, "HTTP 502");
});

test("structured provider API errors read direct metadata status", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "metadata-status";
	generated.errorHandlingMode = "switch";
	generated.maxRetries = 0;
	const { delegate } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{
				error: structuredError(
					"provider_api_error",
					"upstream failure",
					undefined,
					502,
				),
			},
			{ result: okMessage(b) },
		],
	);
	const state = makeState([generated], delegate);
	const transitions: Array<{ reason: string }> = [];
	state.onTransition = (transition) =>
		transitions.push({ reason: transition.reason });

	const { result } = await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(result.provider, "b");
	assert.equal(result.model, "m2");
	assert.equal(state.cooldownLevels.get("metadata-status:a/m1"), 1);
	assert.equal(transitions[0]?.reason, "HTTP 502");
});

test("explicit status takes precedence over structured provider categories", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };

	const persistentGenerated = createGeneratedModel([a, b]);
	persistentGenerated.id = "persistent-status";
	persistentGenerated.errorHandlingMode = "switch";
	persistentGenerated.maxRetries = 0;
	const persistentScript = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{
				status: 401,
				error: structuredError("provider_rate_limit", "rate limit exceeded"),
			},
			{ result: okMessage(b) },
		],
	);
	const persistentState = makeState(
		[persistentGenerated],
		persistentScript.delegate,
	);
	const persistentOutcome = await consume(
		runFailoverRequest(persistentGenerated, {}, {}, persistentState),
	);
	assert.equal(persistentOutcome.result.provider, "b");
	assert.equal(
		persistentState.manualRecovery.get("persistent-status:a/m1"),
		"HTTP 401",
	);
	assert.equal(persistentState.cooldowns.has("persistent-status:a/m1"), false);

	const cooldownGenerated = createGeneratedModel([a, b]);
	cooldownGenerated.id = "cooldown-status";
	cooldownGenerated.errorHandlingMode = "switch";
	cooldownGenerated.maxRetries = 0;
	const cooldownScript = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{
				status: 502,
				error: structuredError("provider_auth_error", "auth failure"),
			},
			{ result: okMessage(b) },
		],
	);
	const cooldownState = makeState([cooldownGenerated], cooldownScript.delegate);
	const cooldownTransitions: Array<{ reason: string }> = [];
	cooldownState.onTransition = (transition) =>
		cooldownTransitions.push({ reason: transition.reason });
	const cooldownOutcome = await consume(
		runFailoverRequest(cooldownGenerated, {}, {}, cooldownState),
	);
	assert.equal(cooldownOutcome.result.provider, "b");
	assert.equal(cooldownState.cooldownLevels.get("cooldown-status:a/m1"), 1);
	assert.equal(cooldownState.manualRecovery.has("cooldown-status:a/m1"), false);
	assert.equal(cooldownTransitions[0]?.reason, "HTTP 502");
});

test("a structured stream result error fails over to the next target", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "stream-primary";
	generated.errorHandlingMode = "switch";
	generated.maxRetries = 0;
	let calls = 0;
	const delegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async (model) =>
			okMessage({ provider: model.provider, id: model.id }),
		stream: () => {
			calls++;
			if (calls === 1) {
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "start" };
					},
					result: async () => {
						throw structuredError(
							"provider_api_error",
							"stream upstream failure",
							undefined,
							502,
						);
					},
				};
			}
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", reason: "stop", message: okMessage(b) };
				},
				result: async () => okMessage(b),
			};
		},
	};
	const state = makeState([generated], delegate);
	const transitions: Array<{ reason: string }> = [];
	state.onTransition = (transition) =>
		transitions.push({ reason: transition.reason });

	const { result } = await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(result.provider, "b");
	assert.equal(result.model, "m2");
	assert.equal(calls, 2);
	assert.equal(state.cooldownLevels.get("stream-primary:a/m1"), 1);
	assert.equal(transitions[0]?.reason, "HTTP 502");
});

test("a cooldown failure routes to the next target and records the cooldown", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const { delegate } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ result: okMessage(b) },
		],
	);
	const state = makeState([generated], delegate);
	const { result } = await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(result.provider, "b");
	assert.equal(result.model, "m2");
	assert.ok((state.cooldowns.get("primary:a/m1") ?? 0) > 0);
});

test("switching targets emits an onTransition callback", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const { delegate } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ result: okMessage(b) },
		],
	);
	const state = makeState([generated], delegate);
	const transitions: Array<{
		source?: ModelRef;
		target: ModelRef;
		reason: string;
	}> = [];
	state.onTransition = (transition) => transitions.push(transition);
	const { result } = await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(result.provider, "b");
	assert.equal(transitions.length, 1);
	assert.deepEqual(transitions[0], {
		modelId: "primary",
		source: a,
		target: b,
		effort: "medium",
		mappedEffort: "medium",
		reasoningControlled: true,
		reason: "HTTP 500",
	});
});

test("target attempts report the real model and effective thinking level", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.reasoningEffort = "high";
	const { delegate } = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{ result: okMessage(a) },
	]);
	const state = makeState([generated], delegate);
	const targets: unknown[] = [];
	state.onTarget = (target) => targets.push(target);

	await consume(runFailoverRequest(generated, {}, {}, state));
	assert.deepEqual(targets, [
		{
			modelId: "primary",
			target: a,
			effort: "high",
			mappedEffort: "high",
			reasoningControlled: true,
		},
	]);
});

test("target attempts report inherited thinking when reasoning injection is disabled", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.reasoningEffort = "high";
	generated.modelParameters.reasoningEffort = false;
	const { delegate } = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{ result: okMessage(a) },
	]);
	const state = makeState([generated], delegate);
	const targets: unknown[] = [];
	state.onTarget = (target) => targets.push(target);

	await consume(runFailoverRequest(generated, {}, {}, state));
	assert.deepEqual(targets, [
		{
			modelId: "primary",
			target: a,
			effort: "high",
			mappedEffort: undefined,
			reasoningControlled: false,
		},
	]);
});

test("unavailable fallback targets are not reported as real transitions", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const { delegate } = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{ status: 500, result: errorMessage(a, "HTTP error (500)") },
	]);
	const state = makeState([generated], delegate);
	const transitions: unknown[] = [];
	state.onTransition = (transition) => transitions.push(transition);

	await consume(runFailoverRequest(generated, {}, {}, state));
	assert.deepEqual(transitions, []);
});

test("retry mode re-attempts the same target up to maxRetries", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.errorHandlingMode = "retry";
	generated.maxRetries = 2;
	const { delegate, calls } = scriptedDelegate(
		new Map([["a/m1", targetModel(a)]]),
		[
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ result: okMessage(a) },
		],
	);
	const { result } = await consume(
		runFailoverRequest(generated, {}, {}, makeState([generated], delegate)),
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(calls.length, 3);
	assert.equal(
		calls.every((call) => call.model.id === "m1"),
		true,
	);
});

test("retry budget resets when failover moves to another target", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.errorHandlingMode = "retry";
	generated.maxRetries = 1;
	const { delegate, calls } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ status: 500, result: errorMessage(b, "HTTP error (500)") },
			{ status: 500, result: errorMessage(b, "HTTP error (500)") },
		],
	);
	const { result } = await consume(
		runFailoverRequest(generated, {}, {}, makeState([generated], delegate)),
	);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(
		calls.map((call) => `${call.model.provider}/${call.model.id}`),
		["a/m1", "a/m1", "b/m2", "b/m2"],
	);
});

test("retry mode waits before repeating a failed target", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.errorHandlingMode = "retry";
	generated.maxRetries = 2;
	const times: number[] = [];
	const { delegate } = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{ status: 500, result: errorMessage(a, "HTTP error (500)") },
		{ status: 500, result: errorMessage(a, "HTTP error (500)") },
		{ result: okMessage(a) },
	]);
	const timedDelegate: Delegate = {
		...delegate,
		complete: async (model, context, options) => {
			times.push(Date.now());
			return delegate.complete(model, context, options);
		},
	};
	await consume(
		runFailoverRequest(generated, {}, {}, makeState([generated], timedDelegate)),
	);
	assert.equal(times.length, 3);
	assert.ok(times[1]! - times[0]! >= 900);
	assert.ok(times[2]! - times[1]! >= 1900);
});

test("retry wait is interrupted by outer cancellation", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.errorHandlingMode = "retry";
	generated.maxRetries = 1;
	const controller = new AbortController();
	let calls = 0;
	const delegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async (model) => {
			calls += 1;
			if (calls === 1) {
				setTimeout(() => controller.abort(), 20);
				return errorMessage(model, "HTTP error (500)");
			}
			return okMessage(model);
		},
	};
	const started = Date.now();
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{ signal: controller.signal },
			makeState([generated], delegate),
		),
	);
	assert.equal(result.stopReason, "aborted");
	assert.equal(calls, 1);
	assert.ok(Date.now() - started < 500);
});

test("reasoning, cache, and affinity parameters apply per target", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.reasoningEffort = "high";
	let outerCallbackFinished = false;
	let adapterPayload: Record<string, unknown> | undefined;
	const scripted = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{ result: okMessage(a) },
	]);
	const delegate: Delegate = {
		...scripted.delegate,
		complete: async (model, context, options) => {
			const payload: Record<string, unknown> = {
				prompt_cache_retention: undefined,
			};
			const forwarded = await options.onPayload?.(payload, model);
			adapterPayload =
				forwarded === undefined ? payload : (forwarded as Record<string, unknown>);
			return scripted.delegate.complete(model, context, options);
		},
	};
	await consume(
		runFailoverRequest(
			generated,
			{},
			{
				sessionId: "s1",
				cacheRetention: "long",
				headers: {
					authorization: "Bearer keep",
					"x-unrelated": "keep",
				},
				onPayload: async (payload) => {
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
					outerCallbackFinished = true;
					return payload;
				},
			},
			makeState([generated], delegate),
		),
	);
	const options = scripted.calls[0].options;
	assert.equal(options.reasoning, "high");
	assert.equal(outerCallbackFinished, true);

	const payload = adapterPayload!;
	const digest = promptCacheKeyFromSessionId("s1");
	assert.equal(payload.prompt_cache_key, digest);
	assert.equal(payload.prompt_cache_retention, "24h");
	assert.deepEqual(payload.reasoning, { effort: "high" });

	assert.equal(options.sessionId, "s1");
	assert.equal(options.headers?.authorization, undefined);
	assert.equal(options.headers?.["x-unrelated"], undefined);
	assert.equal(options.headers?.session_id, digest);
	assert.equal(options.headers?.["x-client-request-id"], digest);
	assert.equal(options.headers?.["x-session-affinity"], null);
	assert.equal(options.headers?.["x-session-id"], null);
});

test("cache retention none drops outer headers and preserves target-owned final headers", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	const { delegate, calls } = scriptedDelegate(
		new Map([["a/m1", targetModel(a)]]),
		[{ result: okMessage(a) }],
	);
	await consume(
		runFailoverRequest(
			generated,
			{},
			{
				sessionId: "session-plaintext-id",
				cacheRetention: "none",
				headers: {
					"x-session-id": "plaintext",
					authorization: "Bearer keep",
				},
			},
			makeState([generated], delegate),
		),
	);
	const options = calls[0].options;
	const payload: Record<string, unknown> = {
		prompt_cache_key: "pi-native-key",
		prompt_cache_retention: "24h",
	};
	await options.onPayload?.(payload);
	assert.equal("prompt_cache_key" in payload, false);
	assert.equal("prompt_cache_retention" in payload, false);
	assert.equal(options.headers, undefined);

	const finalHeaders: Record<string, string | null> = {
		session_id: "session-plaintext-id",
		"x-client-request-id": "session-plaintext-id",
		"x-session-affinity": "session-plaintext-id",
		"x-session-id": "session-plaintext-id",
		authorization: "Bearer target",
		"x-target-native": "target-native",
	};
	const expectedFinalHeaders = { ...finalHeaders };
	await options.transformHeaders?.(finalHeaders);
	assert.deepEqual(finalHeaders, expectedFinalHeaders);
});

test("custom providers on OpenRouter replace every native affinity name", async () => {
	const a = { provider: "custom", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	const model: TargetModelLike = {
		...targetModel(a),
		baseUrl: "https://openrouter.ai/api/v1",
	};
	const { delegate, calls } = scriptedDelegate(new Map([["custom/m1", model]]), [
		{ result: okMessage(a) },
	]);
	await consume(
		runFailoverRequest(
			generated,
			{},
			{ sessionId: "session-plaintext-id" },
			makeState([generated], delegate),
		),
	);
	const digest = promptCacheKeyFromSessionId("session-plaintext-id");
	assert.equal(calls[0].options.headers?.["x-session-id"], digest);
	assert.equal(calls[0].options.headers?.session_id, null);
	assert.equal(calls[0].options.headers?.["x-client-request-id"], null);
	assert.equal(calls[0].options.headers?.["x-session-affinity"], null);
});

test("an outer payload callback can strip retention without failover re-adding it", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	const { delegate, calls } = scriptedDelegate(
		new Map([["a/m1", targetModel(a)]]),
		[{ result: okMessage(a) }],
	);
	await consume(
		runFailoverRequest(
			generated,
			{},
			{
				sessionId: "s1",
				cacheRetention: "long",
				onPayload: async (payload) => {
					if (payload && typeof payload === "object")
						delete (payload as Record<string, unknown>).prompt_cache_retention;
					return payload;
				},
			},
			makeState([generated], delegate),
		),
	);
	const payload: Record<string, unknown> = {
		prompt_cache_retention: undefined,
	};
	await calls[0].options.onPayload?.(payload);
	assert.equal(payload.prompt_cache_key, promptCacheKeyFromSessionId("s1"));
	assert.equal("prompt_cache_retention" in payload, false);
});

test("prompt_cache_retention rejection retries with remembered deletion", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const { delegate, calls } = scriptedDelegate(
		new Map([["a/m1", targetModel(a)]]),
		[
			{
				status: 400,
				result: unsupportedCacheFieldMessage(a, "prompt_cache_retention"),
			},
			{ result: okMessage(a) },
		],
	);
	const state = makeState([generated], delegate);
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{ sessionId: "s1", cacheRetention: "long" },
			state,
		),
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(calls.length, 2);
	assert.ok(
		state.unsupportedCacheFields
			.get("primary:a/m1:openai-responses")
			?.has("prompt_cache_retention"),
	);

	const retryPayload: Record<string, unknown> = {
		prompt_cache_key: "native-key",
		prompt_cache_retention: "24h",
	};
	await calls[1].options.onPayload?.(retryPayload);
	assert.equal(retryPayload.prompt_cache_key, promptCacheKeyFromSessionId("s1"));
	assert.equal("prompt_cache_retention" in retryPayload, false);
});

test("key then retention rejection gets two compatibility retries", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const scripted = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{
			status: 400,
			result: unsupportedCacheFieldMessage(a, "prompt_cache_key"),
		},
		{
			status: 400,
			result: unsupportedCacheFieldMessage(a, "prompt_cache_retention"),
		},
		{ result: okMessage(a) },
	]);
	const payloads: Record<string, unknown>[] = [];
	const delegate: Delegate = {
		...scripted.delegate,
		complete: async (model, context, options) => {
			const payload: Record<string, unknown> = {
				prompt_cache_key: "native-key",
				prompt_cache_retention: undefined,
			};
			await options.onPayload?.(payload, model);
			payloads.push(payload);
			return scripted.delegate.complete(model, context, options);
		},
	};
	const state = makeState([generated], delegate);
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{ sessionId: "s1", cacheRetention: "long" },
			state,
		),
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(scripted.calls.length, 3);
	assert.deepEqual(
		state.unsupportedCacheFields.get("primary:a/m1:openai-responses"),
		new Set(["prompt_cache_key", "prompt_cache_retention"]),
	);
	assert.equal(payloads[0].prompt_cache_key, promptCacheKeyFromSessionId("s1"));
	assert.equal(payloads[0].prompt_cache_retention, "24h");
	assert.equal("prompt_cache_key" in payloads[1], false);
	assert.equal(payloads[1].prompt_cache_retention, "24h");
	assert.equal("prompt_cache_key" in payloads[2], false);
	assert.equal("prompt_cache_retention" in payloads[2], false);
});

test("cache-field rejection stays remembered on later requests", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const { delegate, calls } = scriptedDelegate(
		new Map([["a/m1", targetModel(a)]]),
		[
			{
				status: 400,
				result: unsupportedCacheFieldMessage(a, "prompt_cache_retention"),
			},
			{ result: okMessage(a) },
			{ result: okMessage(a) },
		],
	);
	const state = makeState([generated], delegate);
	const options = { sessionId: "s1", cacheRetention: "long" as const };
	await consume(runFailoverRequest(generated, {}, options, state));
	await consume(runFailoverRequest(generated, {}, options, state));
	assert.equal(calls.length, 3);

	const laterPayload: Record<string, unknown> = {
		prompt_cache_retention: "24h",
	};
	await calls[2].options.onPayload?.(laterPayload);
	assert.equal("prompt_cache_retention" in laterPayload, false);
	assert.equal(laterPayload.prompt_cache_key, promptCacheKeyFromSessionId("s1"));
});

test("compatibility retries are free but bounded outside maxRetries", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const { delegate, calls } = scriptedDelegate(
		new Map([["a/m1", targetModel(a)]]),
		[
			{
				status: 400,
				result: unsupportedCacheFieldMessage(a, "prompt_cache_key"),
			},
			{
				status: 400,
				result: unsupportedCacheFieldMessage(a, "prompt_cache_retention"),
			},
			{
				status: 400,
				result: unsupportedCacheFieldMessage(a, "prompt_cache_key"),
			},
			{ result: okMessage(a) },
		],
	);
	const state = makeState([generated], delegate);
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{ sessionId: "s1", cacheRetention: "long" },
			state,
		),
	);
	assert.equal(result.stopReason, "error");
	assert.equal(calls.length, 3);
	assert.deepEqual(
		state.unsupportedCacheFields.get("primary:a/m1:openai-responses"),
		new Set(["prompt_cache_key", "prompt_cache_retention"]),
	);
});

test("disabled passive toggles leave Pi-owned payload and headers untouched", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.reasoningEffort = "high";
	generated.modelParameters = {
		promptCacheKey: true,
		promptCacheRetention: true,
		reasoningEffort: false,
		sessionAffinity: false,
	};
	const { delegate, calls } = scriptedDelegate(
		new Map([["a/m1", targetModel(a)]]),
		[{ result: okMessage(a) }],
	);
	await consume(
		runFailoverRequest(
			generated,
			{},
			{ sessionId: "s1" },
			makeState([generated], delegate),
		),
	);
	const options = calls[0].options;
	assert.equal(options.reasoning, undefined);
	assert.equal(options.sessionId, "s1");

	const payload: Record<string, unknown> = {
		prompt_cache_retention: "24h",
	};
	await options.onPayload?.(payload);
	assert.equal("reasoning" in payload, false);
	assert.equal(payload.prompt_cache_key, promptCacheKeyFromSessionId("s1"));
	assert.equal(payload.prompt_cache_retention, "24h");

	const headers: Record<string, string | null> = { "X-Session-Id": "plain" };
	await options.transformHeaders?.(headers);
	assert.equal(headers["X-Session-Id"], "plain");
});

test("non-OpenAI targets leave payload and target-owned final headers untouched", async () => {
	const a = { provider: "anthropic", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	const model = {
		...targetModel(a),
		api: "anthropic-messages",
	};
	const { delegate, calls } = scriptedDelegate(
		new Map([["anthropic/m1", model]]),
		[{ result: okMessage(a) }],
	);
	await consume(
		runFailoverRequest(
			generated,
			{},
			{
				sessionId: "s1",
				headers: {
					session_id: "plaintext",
					authorization: "Bearer keep",
				},
			},
			makeState([generated], delegate),
		),
	);
	const options = calls[0].options;
	assert.equal(options.sessionId, "s1");
	assert.equal(options.headers, undefined);
	const payload: Record<string, unknown> = {
		metadata: { keep: true },
	};
	await options.onPayload?.(payload);
	assert.deepEqual(payload, { metadata: { keep: true } });
	const finalHeaders: Record<string, string | null> = {
		session_id: "target-native",
		authorization: "Bearer target",
		"x-anthropic-native": "target-native",
	};
	const expectedFinalHeaders = { ...finalHeaders };
	await options.transformHeaders?.(finalHeaders);
	assert.deepEqual(finalHeaders, expectedFinalHeaders);
});

test("cross-provider attempts isolate virtual credentials and header transforms", async () => {
	const a = { provider: "openai", id: "m1" };
	const b = { provider: "openrouter", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "credential-boundary";
	generated.maxRetries = 0;
	const openRouterModel: TargetModelLike = {
		...targetModel(b),
		baseUrl: "https://openrouter.ai/api/v1",
	};
	const { delegate, calls } = scriptedDelegate(
		new Map([
			["openai/m1", targetModel(a)],
			["openrouter/m2", openRouterModel],
		]),
		[
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ result: okMessage(b) },
		],
	);
	let outerTransformCalls = 0;
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{
				apiKey: "fake-virtual-api-key",
				env: { FAKE_PROVIDER_TOKEN: "fake-env-token" },
				sessionId: "credential-boundary-session",
				headers: {
					Authorization: "Bearer fake-outer-authorization",
					"Proxy-Authorization": "Basic fake-outer-proxy",
					Cookie: "fake-cookie=value",
					"x-api-key": "fake-outer-api-key",
					"x-harmless": "fake-outer-harmless",
				},
				transformHeaders: async (headers) => {
					outerTransformCalls += 1;
					headers["x-outer-transform-secret"] = "fake-transform-secret";
					return headers;
				},
			},
			makeState([generated], delegate),
		),
	);
	assert.equal(result.model, "m2");
	assert.deepEqual(
		calls.map((call) => `${call.model.provider}/${call.model.id}`),
		["openai/m1", "openrouter/m2"],
	);

	const digest = promptCacheKeyFromSessionId("credential-boundary-session");
	for (const call of calls) {
		assert.equal(Object.hasOwn(call.options, "apiKey"), false);
		assert.equal(Object.hasOwn(call.options, "env"), false);
		const affinityHeaders =
			call.model.provider === "openrouter"
				? {
						session_id: null,
						"x-client-request-id": null,
						"x-session-affinity": null,
						"x-session-id": digest,
					}
				: {
						session_id: digest,
						"x-client-request-id": digest,
						"x-session-affinity": null,
						"x-session-id": null,
					};
		assert.deepEqual(call.options.headers, affinityHeaders);

		const finalHeaders: Record<string, string | null> = {
			Authorization: `Bearer target-${call.model.provider}`,
			"x-target-native": `native-${call.model.provider}`,
			session_id: "target-session",
			"x-client-request-id": "target-request",
			"x-session-affinity": "target-affinity",
			"x-session-id": "target-session-id",
		};
		const transformed = await call.options.transformHeaders?.(finalHeaders);
		assert.equal(transformed, finalHeaders);
		assert.deepEqual(finalHeaders, {
			Authorization: `Bearer target-${call.model.provider}`,
			"x-target-native": `native-${call.model.provider}`,
			...affinityHeaders,
		});
	}
	assert.equal(outerTransformCalls, 0);
});

test("persistent failures across the chain end in exhaustion", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const { delegate } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{ status: 401, result: errorMessage(a, "HTTP error (401)") },
			{ status: 401, result: errorMessage(b, "HTTP error (401)") },
		],
	);
	const state = makeState([generated], delegate);
	const { result } = await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /exhausted/);
	assert.ok(state.manualRecovery.has("primary:a/m1"));
	assert.ok(state.manualRecovery.has("primary:b/m2"));
});

test("cooldown ladder arms exact rungs and stays capped at six hours", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const failures = Array.from({ length: 8 }, () => ({
		status: 500,
		result: errorMessage(a, "HTTP error (500)"),
	}));
	const { delegate } = scriptedDelegate(
		new Map([["a/m1", targetModel(a)]]),
		failures,
	);
	const state = makeState([generated], delegate);
	const expectedMinutes = [10, 20, 40, 60, 90, 180, 360, 360];
	for (const [index, minutes] of expectedMinutes.entries()) {
		state.cooldowns.delete("primary:a/m1"); // Simulate the previous timer expiring.
		const started = Date.now();
		await consume(runFailoverRequest(generated, {}, {}, state));
		const duration = (state.cooldowns.get("primary:a/m1") ?? 0) - started;
		assert.ok(duration >= minutes * 60_000, `rung ${index}`);
		assert.ok(duration < minutes * 60_000 + 1_000, `rung ${index}`);
		assert.equal(
			state.cooldownLevels.get("primary:a/m1"),
			Math.min(index + 1, 6),
		);
	}
});

test("same-target retries do not arm or advance cooldown until exhaustion", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.errorHandlingMode = "smart";
	generated.maxRetries = 2;
	let calls = 0;
	let state: FailoverProviderState;
	const delegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async (model, _context, options) => {
			calls += 1;
			if (calls <= 2) {
				assert.equal(state.cooldowns.size, 0);
				assert.equal(state.cooldownLevels.size, 0);
			}
			await options.onResponse?.({ status: 429, headers: {} });
			return errorMessage(model, "HTTP error (429)");
		},
	};
	state = makeState([generated], delegate);
	const started = Date.now();
	await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(calls, 3);
	assert.equal(state.cooldownLevels.get("primary:a/m1"), 1);
	const duration = (state.cooldowns.get("primary:a/m1") ?? 0) - started;
	assert.ok(duration >= 10 * 60_000);
	assert.ok(duration < 10 * 60_000 + 4_000);
});

test("cooling targets are skipped without changing their timer or level", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "primary";
	const { delegate, calls } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[{ result: okMessage(b) }],
	);
	const state = makeState([generated], delegate);
	const expiry = Date.now() + 60 * 60_000;
	state.cooldowns.set("primary:a/m1", expiry);
	state.cooldownLevels.set("primary:a/m1", 4);
	await consume(runFailoverRequest(generated, {}, {}, state));
	assert.deepEqual(
		calls.map((call) => call.model.id),
		["m2"],
	);
	assert.equal(state.cooldowns.get("primary:a/m1"), expiry);
	assert.equal(state.cooldownLevels.get("primary:a/m1"), 4);
});

test("success resets one target so its next failure uses ten minutes", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const success = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{ result: okMessage(a) },
	]);
	const state = makeState([generated], success.delegate);
	state.cooldowns.set("primary:a/m1", Date.now() - 1);
	state.cooldownLevels.set("primary:a/m1", 5);
	await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(state.cooldowns.has("primary:a/m1"), false);
	assert.equal(state.cooldownLevels.has("primary:a/m1"), false);

	const failure = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{ status: 500, result: errorMessage(a, "HTTP error (500)") },
	]);
	state.delegate = failure.delegate;
	const started = Date.now();
	await consume(runFailoverRequest(generated, {}, {}, state));
	assert.equal(state.cooldownLevels.get("primary:a/m1"), 1);
	assert.ok(
		(state.cooldowns.get("primary:a/m1") ?? 0) - started < 10 * 60_000 + 1_000,
	);
});

test("persistent and unknown failures leave cooldown ladder state unchanged", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.errorHandlingMode = "switch";
	generated.maxRetries = 0;
	for (const step of [
		{ status: 401, result: errorMessage(a, "HTTP error (401)") },
		{ result: errorMessage(a, "unexpected provider failure") },
	]) {
		const { delegate } = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
			step,
		]);
		const state = makeState([generated], delegate);
		state.cooldowns.set("primary:a/m1", 123);
		state.cooldownLevels.set("primary:a/m1", 5);
		await consume(runFailoverRequest(generated, {}, {}, state));
		assert.equal(state.cooldowns.get("primary:a/m1"), 123);
		assert.equal(state.cooldownLevels.get("primary:a/m1"), 5);
	}
});

test("cooldown state is isolated by generated model id", async () => {
	const target = { provider: "a", id: "m1" };
	const first = createGeneratedModel([target]);
	first.id = "first";
	first.maxRetries = 0;
	const second = createGeneratedModel([target]);
	second.id = "second";
	second.maxRetries = 0;
	const { delegate } = scriptedDelegate(
		new Map([["a/m1", targetModel(target)]]),
		[
			{ status: 500, result: errorMessage(target, "HTTP error (500)") },
			{ status: 500, result: errorMessage(target, "HTTP error (500)") },
			{ status: 500, result: errorMessage(target, "HTTP error (500)") },
		],
	);
	const state = makeState([first, second], delegate);
	await consume(runFailoverRequest(first, {}, {}, state));
	state.cooldowns.delete("first:a/m1");
	await consume(runFailoverRequest(first, {}, {}, state));
	const started = Date.now();
	await consume(runFailoverRequest(second, {}, {}, state));
	assert.equal(state.cooldownLevels.get("first:a/m1"), 2);
	assert.equal(state.cooldownLevels.get("second:a/m1"), 1);
	assert.ok(
		(state.cooldowns.get("second:a/m1") ?? 0) - started < 10 * 60_000 + 1_000,
	);
});

test("disabled and empty-chain models do not touch cooldown state", async () => {
	const target = { provider: "a", id: "m1" };
	for (const generated of [
		{ ...createGeneratedModel([target]), enabled: false },
		{ ...createGeneratedModel([]), enabled: true },
	]) {
		generated.id = "primary";
		const { delegate, calls } = scriptedDelegate(
			new Map([["a/m1", targetModel(target)]]),
			[],
		);
		const state = makeState([generated], delegate);
		state.cooldowns.set("primary:a/m1", 123);
		state.cooldownLevels.set("primary:a/m1", 4);
		await consume(runFailoverRequest(generated, {}, {}, state));
		assert.equal(calls.length, 0);
		assert.equal(state.cooldowns.get("primary:a/m1"), 123);
		assert.equal(state.cooldownLevels.get("primary:a/m1"), 4);
	}
});

test("an aborted signal stops the chain immediately", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	const controller = new AbortController();
	controller.abort();
	const { delegate } = scriptedDelegate(new Map(), []);
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{ signal: controller.signal },
			makeState([generated], delegate),
		),
	);
	assert.equal(result.stopReason, "aborted");
});

test("R1-002 shared attempts use caller timeout claims and bound disabled no-progress settings", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "shared-timeout-safety";
	const shared = await makeSharedState([a], {
		maxRetries: 0,
		noProgressTimeoutSeconds: 0,
	});
	const claims: Array<{ effectiveRequestTimeoutMs: number }> = [];
	const adapter: SharedStateAdapter = {
		status: () => shared.status(),
		snapshot: () => shared.snapshot(),
		reconcileRegistration: (input) => shared.reconcileRegistration(input),
		claim: async (input) => {
			claims.push({ effectiveRequestTimeoutMs: input.effectiveRequestTimeoutMs });
			const result = await shared.claim(input);
			if (result.kind !== "claimed") return result;
			return result;
		},
		settle: (input) => shared.settle(input),
		updateSettings: (target, patch) => shared.updateSettings(target, patch),
		resetTargets: (targets) => shared.resetTargets(targets),
	};
	let calls = 0;
	const delegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async (_model, _context, options) => {
			calls += 1;
			return new Promise<AssistantMessageLike>((resolve) => {
				options.signal?.addEventListener(
					"abort",
					() => resolve(errorMessage(a, "bounded timeout")),
					{ once: true },
				);
			});
		},
	};
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{ timeoutMs: 45_000 },
			makeState([generated], delegate, adapter),
		),
	);
	assert.equal(calls, 1);
	assert.deepEqual(claims, [{ effectiveRequestTimeoutMs: 45_000 }]);
	assert.match(result.errorMessage ?? "", /no-progress timeout/);
});

test("transient shared claim coordination failures are retried", async () => {
	for (const reason of ["cas-exhausted", "write-failed"] as const) {
		const target = { provider: "a", id: "m1" };
		const generated = createGeneratedModel([target]);
		generated.id = `shared-claim-retry-${reason}`;
		const shared = await makeSharedState([target]);
		let claimCalls = 0;
		const adapter: SharedStateAdapter = {
			status: () => shared.status(),
			snapshot: () => shared.snapshot(),
			reconcileRegistration: (input) => shared.reconcileRegistration(input),
			claim: async (input) => {
				claimCalls += 1;
				if (claimCalls === 1) {
					return {
						kind: "invalid",
						detail:
							"Shared failover coordination is unavailable; repair shared state and retry",
						coordination: "degraded",
						reason,
					};
				}
				return shared.claim(input);
			},
			settle: (input) => shared.settle(input),
			updateSettings: (targetRef, patch) =>
				shared.updateSettings(targetRef, patch),
			resetTargets: (targets) => shared.resetTargets(targets),
		};
		let delegateCalls = 0;
		const delegate: Delegate = {
			resolveModel: (ref) => targetModel(ref),
			complete: async () => {
				delegateCalls += 1;
				return okMessage(target);
			},
		};
		const { result } = await consume(
			runFailoverRequest(
				generated,
				{},
				{},
				makeState([generated], delegate, adapter),
			),
		);
		assert.equal(result.stopReason, "stop");
		assert.equal(claimCalls, 2);
		assert.equal(delegateCalls, 1);
	}
});

test("R1-004 redacts provider secrets from results, callbacks, transitions, and shared state", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "secret-redaction";
	generated.errorHandlingMode = "switch";
	generated.maxRetries = 0;
	const sentinels = [
		"sk-1234567890SECRET",
		"bearer-secret-value",
		"query-secret-value",
		"metadata-token-abcdefghijklmnopqrstuvwxyz0123456789",
		"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef==",
		"sk-control-injection-secret-1234567890",
	];
	const controlInjection = `OSC52=\u001b]52;c;${sentinels[5]}\u0007 CSI=\u001b[31mred\u001b[0m BEL=\u0007 C1=\u009b31m`;
	const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;
	const raw = `HTTP 401 key ${sentinels[0]} Authorization: Bearer ${sentinels[1]}; api_key=${sentinels[2]} token=${sentinels[3]} credential ${sentinels[4]} ${controlInjection}`;
	const shared = await makeSharedState([a, b], { maxRetries: 0 });
	const scripted = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{
				error: structuredError(
					`provider_auth_error token=${sentinels[3]}`,
					raw,
					undefined,
					401,
				),
			},
			{
				result: {
					...errorMessage(b, raw, "aborted"),
					providerErrorCategory: `provider_auth_error token=${sentinels[3]}`,
				},
			},
		],
	);
	const state = makeState([generated], scripted.delegate, shared);
	const transitions: string[] = [];
	const recoveries: string[] = [];
	state.onTransition = (transition) => transitions.push(transition.reason);
	state.onManualRecovery = (_key, reason) => recoveries.push(reason);

	const outcome = await consume(runFailoverRequest(generated, {}, {}, state));
	const sharedDocument = (await shared.snapshot()).document;
	const sharedReason =
		sharedDocument.targets["a/m1"].runtime.manualRecovery?.reason;
	const exposed = JSON.stringify({
		result: outcome.result,
		events: outcome.events,
		transitions,
		recoveries,
		manualRecovery: [...state.manualRecovery.entries()],
		shared: sharedDocument,
	});
	for (const sentinel of sentinels)
		assert.equal(exposed.includes(sentinel), false, sentinel);
	assert.match(outcome.result.errorMessage ?? "", /HTTP 401|settlement stale/);
	assert.equal(transitions.length, 1);
	assert.equal(sharedReason, "HTTP 401");
	assert.equal(sharedDocument.targets["a/m1"].runtime.cooldownUntil, null);

	const legacy = createGeneratedModel([a]);
	legacy.id = "legacy-secret-redaction";
	legacy.errorHandlingMode = "switch";
	legacy.maxRetries = 0;
	const legacyScript = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{
			error: structuredError("provider_auth_error", raw),
		},
	]);
	const legacyState = makeState([legacy], legacyScript.delegate);
	const legacyRecoveries: string[] = [];
	legacyState.onManualRecovery = (_key, reason) => legacyRecoveries.push(reason);
	const legacyOutcome = await consume(
		runFailoverRequest(legacy, {}, {}, legacyState),
	);
	assert.equal(legacyRecoveries.length, 1);
	const legacyExposed = JSON.stringify({
		result: legacyOutcome.result,
		events: legacyOutcome.events,
		recoveries: legacyRecoveries,
		manualRecovery: [...legacyState.manualRecovery.entries()],
	});
	for (const sentinel of sentinels)
		assert.equal(legacyExposed.includes(sentinel), false, sentinel);
	const controlSurfaces = {
		terminal: outcome.result.errorMessage ?? "",
		callback: legacyRecoveries[0] ?? "",
		transition: transitions[0] ?? "",
		persisted: sharedReason ?? "",
	};
	for (const [surface, text] of Object.entries(controlSurfaces)) {
		assert.doesNotMatch(text, controlCharacters, surface);
		assert.equal(text.includes(sentinels[5]), false, surface);
	}
	assert.match(controlSurfaces.terminal, /\[REDACTED\]/);
});

test("authorization variants are redacted across failover surfaces", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const sentinels = {
		basic: "basicAuthMarker7Q",
		digest: "digestAuthMarker8R",
		proxy: "proxyAuthMarker9S",
		keyValue: "lowerAuthMarker2T",
		proxyKeyValue: "lowerProxyMarker5W",
		json: "jsonAuthMarker3U",
		jsonProxy: "jsonProxyMarker4V",
	};
	const raw = [
		"HTTP 401 upstream denied",
		`AUTHORIZATION: Basic ${sentinels.basic}`,
		`Authorization: Digest username="demo", response="${sentinels.digest}"`,
		`Proxy-Authorization: Unknown ${sentinels.proxy}`,
		`authorization=${sentinels.keyValue}&request_id=req-7`,
		`proxy_authorization=${sentinels.proxyKeyValue}&trace_id=trace-8`,
		`{"authorization":"${sentinels.json}","proxy-authorization":"${sentinels.jsonProxy}","status":"denied"}`,
		"safe_context=kept",
	].join("\n");

	const generated = createGeneratedModel([a, b]);
	generated.id = "authorization-redaction";
	generated.errorHandlingMode = "switch";
	generated.maxRetries = 0;
	const shared = await makeSharedState([a, b], { maxRetries: 0 });
	const sharedScript = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{ error: structuredError("provider_auth_error", raw) },
			{ error: structuredError("provider_auth_error", raw) },
		],
	);
	const sharedState = makeState([generated], sharedScript.delegate, shared);
	const transitions: string[] = [];
	sharedState.onTransition = (transition) => transitions.push(transition.reason);
	const sharedOutcome = await consume(
		runFailoverRequest(generated, {}, {}, sharedState),
	);

	const legacy = createGeneratedModel([a]);
	legacy.id = "authorization-redaction-legacy";
	legacy.errorHandlingMode = "switch";
	legacy.maxRetries = 0;
	const legacyScript = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{ error: structuredError("provider_auth_error", raw) },
	]);
	const legacyState = makeState([legacy], legacyScript.delegate);
	const manualCallbacks: string[] = [];
	legacyState.onManualRecovery = (_key, reason) => manualCallbacks.push(reason);
	const legacyOutcome = await consume(
		runFailoverRequest(legacy, {}, {}, legacyState),
	);

	const exposed = JSON.stringify({
		sharedResult: sharedOutcome.result,
		sharedEvents: sharedOutcome.events,
		legacyResult: legacyOutcome.result,
		transitions,
		manualCallbacks,
		sharedSnapshot: (await shared.snapshot()).document,
	});
	for (const sentinel of Object.values(sentinels))
		assert.equal(exposed.includes(sentinel), false, sentinel);
	assert.match(
		sharedOutcome.result.errorMessage ?? "",
		/HTTP 401|settlement stale/,
	);
	assert.ok((transitions[0] ?? "").length <= 256);
	assert.ok((manualCallbacks[0] ?? "").length <= 256);
});

test("shared settings drive selection, parameters, timeout, and retry budget", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "shared-settings";
	generated.reasoningEffort = "low";
	generated.maxRetries = 8;
	generated.noProgressTimeoutSeconds = 15;
	const shared = await makeSharedState([a, b], {
		reasoningEffort: "high",
		maxRetries: 0,
		noProgressTimeoutSeconds: 0,
		modelParameters: {
			promptCacheKey: false,
			promptCacheRetention: false,
			reasoningEffort: true,
			sessionAffinity: false,
		},
	});
	const calls: Array<{ model: TargetModelLike; options: RequestOptions }> = [];
	let firstPayload: Record<string, unknown> | undefined;
	const delegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async (model, _context, options) => {
			calls.push({ model, options });
			const payload: Record<string, unknown> = {
				prompt_cache_key: "native-key",
				prompt_cache_retention: "24h",
			};
			await options.onPayload?.(payload, model);
			if (model.id === "m1") {
				firstPayload = payload;
				return errorMessage(a, "stalled");
			}
			return okMessage(b);
		},
	};
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{ sessionId: "shared-session", cacheRetention: "long" },
			makeState([generated], delegate, shared),
		),
	);
	assert.equal(result.model, "m2");
	assert.deepEqual(
		calls.map((call) => call.model.id),
		["m1", "m2"],
	);
	assert.equal(calls[0]?.options.reasoning, "high");
	assert.ok(firstPayload);
	assert.equal(firstPayload!.prompt_cache_key, "native-key");
	assert.equal(firstPayload!.prompt_cache_retention, "24h");
	assert.deepEqual(firstPayload!.reasoning, { effort: "high" });
	assert.equal(calls[0]?.options.headers, undefined);
	const record = (await shared.snapshot()).document.targets["a/m1"];
	assert.equal(record.settings.reasoningEffort, "high");
	assert.equal(record.settings.maxRetries, 0);
	assert.equal(record.settings.noProgressTimeoutSeconds, 0);
	assert.deepEqual(record.settings.modelParameters, {
		promptCacheKey: false,
		promptCacheRetention: false,
		reasoningEffort: true,
		sessionAffinity: false,
	});
});

test("shared settlement keeps the V8 chain scope retry override", async () => {
	const target = { provider: "a", id: "m1" };
	const scopeKey = "chain-scope-override";
	const generated: GeneratedFailoverModelV8 & { scopeKey: string } = {
		id: "shared-scope-override",
		name: "Shared Scope Override",
		enabled: true,
		chain: [target],
		scopeKey,
	};
	const shared = await makeSharedState([target], { maxRetries: 5 });
	const registration = await shared.reconcileRegistration({
		agentDirectory: "/tmp/provider-r3a-shared",
		targets: [target],
		scopes: [{ key: scopeKey, targets: [target] }],
	});
	assert.equal(registration.kind, "reconciled");
	const override = await shared.updateTargetOverride?.(scopeKey, target, {
		maxRetries: 1,
	});
	assert.equal(override?.kind, "updated");

	const driftingAdapter: SharedStateAdapter = {
		status: () => shared.status(),
		snapshot: () => shared.snapshot(),
		reconcileRegistration: (input) => shared.reconcileRegistration(input),
		claim: async (input) => {
			const claim = await shared.claim(input);
			if (claim.kind === "claimed") {
				const changed = await shared.updateTargetOverride?.(scopeKey, target, {
					maxRetries: 0,
				});
				assert.equal(changed?.kind, "updated");
			}
			return claim;
		},
		settle: (input) => shared.settle(input),
		updateSettings: (targetRef, patch) => shared.updateSettings(targetRef, patch),
		updateTargetOverride: (key, targetRef, patch) =>
			shared.updateTargetOverride!(key, targetRef, patch),
		resetTargets: (targets) => shared.resetTargets(targets),
	};
	const scripted = scriptedDelegate(new Map([["a/m1", targetModel(target)]]), [
		{ status: 500, result: errorMessage(target, "HTTP error (500)") },
		{ result: okMessage(target) },
	]);
	const providerState: FailoverProviderState & {
		sharedState: SharedStateAdapter;
	} = {
		...makeState(
			[generated as unknown as GeneratedFailoverModel],
			scripted.delegate,
			driftingAdapter,
		),
		sharedState: driftingAdapter,
	};
	const { result } = await consume(
		runFailoverRequest(generated, {}, {}, providerState),
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(scripted.calls.length, 2);
});

test("shared retry budgets are isolated per target before chain advance", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const c = { provider: "c", id: "m3" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "shared-retry-isolation";
	const clock = mutableClock(Date.now() - 2_000);
	const shared = await makeSharedState(
		[a, b, c],
		{ maxRetries: 1 },
		{ now: clock.now },
	);
	const untouchedRuntime = (await shared.snapshot()).document.targets["c/m3"]
		.runtime;
	const { delegate, calls } = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ result: okMessage(b) },
		],
	);
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{},
			makeState([generated], delegate, shared),
		),
	);
	assert.equal(result.model, "m2");
	assert.deepEqual(
		calls.map((call) => `${call.model.provider}/${call.model.id}`),
		["a/m1", "a/m1", "b/m2"],
	);

	const runtime = (await shared.snapshot()).document.targets;
	assert.equal(runtime["a/m1"].runtime.consecutiveFailures, 0);
	assert.equal(runtime["a/m1"].runtime.cooldownUntil, clock.value() + 600_000);
	assert.equal(runtime["a/m1"].runtime.cooldownLevel, 1);
	assert.equal(runtime["a/m1"].runtime.cumulativeCooldownMs, 600_000);
	assert.equal(runtime["a/m1"].runtime.lastFailureReason, "HTTP 500");
	assert.deepEqual(runtime["b/m2"].runtime, untouchedRuntime);
	assert.deepEqual(runtime["c/m3"].runtime, untouchedRuntime);
});

test("shared cooldown state skips a failed target across adapters and falls through", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "shared-fallthrough";
	generated.maxRetries = 8;
	const sharedA = await makeSharedState([a, b], { maxRetries: 0 });
	const first = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ result: okMessage(b) },
		],
	);
	const firstOutcome = await consume(
		runFailoverRequest(
			generated,
			{},
			{},
			makeState([generated], first.delegate, sharedA),
		),
	);
	assert.equal(firstOutcome.result.model, "m2");
	const document = (await sharedA.snapshot()).document;
	assert.ok(document.targets["a/m1"].runtime.cooldownUntil);

	const sharedB = createMemorySharedState({ document });
	const second = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[{ result: okMessage(b) }],
	);
	const secondOutcome = await consume(
		runFailoverRequest(
			generated,
			{},
			{},
			makeState([generated], second.delegate, sharedB),
		),
	);
	assert.equal(secondOutcome.result.model, "m2");
	assert.deepEqual(
		second.calls.map((call) => call.model.id),
		["m2"],
	);
});

test("the shared max-retry budget is global across requests and adapters", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "global-budget";
	generated.errorHandlingMode = "retry";
	generated.maxRetries = 8;
	const sharedA = await makeSharedState([a], { maxRetries: 0 });
	const first = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{ status: 429, result: errorMessage(a, "HTTP error (429)") },
	]);
	const firstOutcome = await consume(
		runFailoverRequest(
			generated,
			{},
			{},
			makeState([generated], first.delegate, sharedA),
		),
	);
	assert.equal(firstOutcome.result.stopReason, "error");
	assert.equal(first.calls.length, 1);
	const document = (await sharedA.snapshot()).document;
	assert.equal(document.targets["a/m1"].runtime.cooldownLevel, 1);
	assert.equal(document.targets["a/m1"].runtime.cumulativeCooldownMs, 600_000);

	const sharedB = createMemorySharedState({ document });
	const second = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{ result: okMessage(a) },
	]);
	const secondOutcome = await consume(
		runFailoverRequest(
			generated,
			{},
			{},
			makeState([generated], second.delegate, sharedB),
		),
	);
	assert.equal(secondOutcome.result.stopReason, "error");
	assert.equal(second.calls.length, 0);
	assert.match(secondOutcome.result.errorMessage ?? "", /cooldown/);
});

test("shared retries and cancellation do not use lease release", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "retry-no-lease";
	const shared = await makeSharedState([a], { maxRetries: 2 });
	const settlements: string[] = [];
	const adapter: SharedStateAdapter = {
		status: () => shared.status(),
		snapshot: () => shared.snapshot(),
		reconcileRegistration: (input) => shared.reconcileRegistration(input),
		claim: (input) => shared.claim(input),
		settle: async (input) => {
			settlements.push(input.outcome.kind);
			return shared.settle(input);
		},
		updateSettings: (target, patch) => shared.updateSettings(target, patch),
		resetTargets: (targets) => shared.resetTargets(targets),
	};
	const controller = new AbortController();
	let calls = 0;
	const delegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async (model) => {
			calls += 1;
			setTimeout(() => controller.abort(), 20);
			return errorMessage(model, "HTTP error (500)");
		},
	};
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{ signal: controller.signal },
			makeState([generated], delegate, adapter),
		),
	);
	assert.equal(result.stopReason, "aborted");
	assert.equal(calls, 1);
	assert.deepEqual(settlements, ["automatic-failure"]);
	const runtime = (await shared.snapshot()).document.targets["a/m1"].runtime;
	assert.equal("lease" in runtime, false);
});
test("shared compatibility negotiation does not count as a runtime failure", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "shared-compatibility";
	const shared = await makeSharedState([a], { maxRetries: 0 });
	let compatibilityRuntime:
		| {
				consecutiveFailures: number;
				cooldownUntil: number | null;
				cumulativeCooldownMs: number;
		  }
		| undefined;
	const adapter: SharedStateAdapter = {
		status: () => shared.status(),
		snapshot: () => shared.snapshot(),
		reconcileRegistration: (input) => shared.reconcileRegistration(input),
		claim: (input) => shared.claim(input),
		settle: async (input) => {
			const result = await shared.settle(input);
			if (
				input.outcome.kind === "compatibility-retry" &&
				result.kind === "settled"
			)
				compatibilityRuntime = result.runtime;
			return result;
		},
		updateSettings: (target, patch) => shared.updateSettings(target, patch),
		resetTargets: (targets) => shared.resetTargets(targets),
	};
	const scripted = scriptedDelegate(new Map([["a/m1", targetModel(a)]]), [
		{
			status: 400,
			result: unsupportedCacheFieldMessage(a, "prompt_cache_retention"),
		},
		{ result: okMessage(a) },
	]);
	const state = makeState([generated], scripted.delegate, adapter);
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{ sessionId: "compatibility", cacheRetention: "long" },
			state,
		),
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(scripted.calls.length, 2);
	assert.ok(compatibilityRuntime);
	assert.equal(compatibilityRuntime!.consecutiveFailures, 0);
	assert.equal(compatibilityRuntime!.cooldownUntil, null);
	assert.equal(compatibilityRuntime!.cumulativeCooldownMs, 0);
	assert.equal("lease" in compatibilityRuntime!, false);
	assert.ok(
		state.unsupportedCacheFields
			.get("a/m1:openai-responses")
			?.has("prompt_cache_retention"),
	);
});

test("persistent model unavailability creates shared recovery across virtual models", async () => {
	const a = { provider: "a", id: "m1" };
	const first = createGeneratedModel([a]);
	first.id = "virtual-one";
	const second = createGeneratedModel([a]);
	second.id = "virtual-two";
	const shared = await makeSharedState([a], { maxRetries: 0 });
	let unavailableCalls = 0;
	const unavailable: Delegate = {
		resolveModel: () => undefined,
		complete: async () => {
			unavailableCalls += 1;
			return okMessage(a);
		},
	};
	const firstOutcome = await consume(
		runFailoverRequest(first, {}, {}, makeState([first], unavailable, shared)),
	);
	assert.equal(firstOutcome.result.stopReason, "error");
	assert.equal(unavailableCalls, 0);
	assert.equal(
		(await shared.snapshot()).document.targets["a/m1"].runtime.manualRecovery
			?.reason,
		"model unavailable",
	);

	let secondCalls = 0;
	const recoveredDelegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async () => {
			secondCalls += 1;
			return okMessage(a);
		},
	};
	const secondOutcome = await consume(
		runFailoverRequest(
			second,
			{},
			{},
			makeState([second], recoveredDelegate, shared),
		),
	);
	assert.equal(secondOutcome.result.stopReason, "error");
	assert.equal(secondCalls, 0);
	assert.match(secondOutcome.result.errorMessage ?? "", /manual-recovery/);
});

test("shared success clears cumulative cooldown and failure runtime", async () => {
	const a = { provider: "a", id: "m1" };
	const clock = mutableClock();
	const shared = await makeSharedState(
		[a],
		{ maxRetries: 0 },
		{ now: clock.now },
	);
	const claim = await shared.claim({ target: a, effectiveRequestTimeoutMs: 0 });
	assert.equal(claim.kind, "claimed");
	if (claim.kind !== "claimed") throw new Error("expected shared claim");
	const failure = await shared.settle({
		target: a,
		outcome: { kind: "automatic-failure", reason: "HTTP 500" },
	});
	assert.equal(failure.kind, "settled");
	if (failure.kind !== "settled" || failure.action !== "cooldown")
		throw new Error("expected shared cooldown");
	clock.set(failure.cooldownUntil + 1);

	const generated = createGeneratedModel([a]);
	generated.id = "runtime-success";
	const delegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async () => okMessage(a),
	};
	const { result } = await consume(
		runFailoverRequest(
			generated,
			{},
			{},
			makeState([generated], delegate, shared),
		),
	);
	assert.equal(result.stopReason, "stop");
	assert.deepEqual((await shared.snapshot()).document.targets["a/m1"].runtime, {
		consecutiveFailures: 0,
		nextEligibleAt: null,
		cooldownUntil: null,
		cooldownLevel: 0,
		cumulativeCooldownMs: 0,
		manualRecovery: null,
		lastFailureReason: null,
		lastFailureAt: null,
		updatedAt: clock.value(),
	});
});

test("shared skipped reasons reach exhaustion and real-target transitions", async () => {
	const unknown = { provider: "unknown", id: "missing" };
	const available = { provider: "available", id: "m2" };
	const cooling = { provider: "cooling", id: "m3" };
	const exhaustedGenerated = createGeneratedModel([unknown, available, cooling]);
	exhaustedGenerated.id = "skip-exhausted";
	const exhaustedShared = await makeSharedState([unknown, available, cooling], {
		maxRetries: 0,
	});
	await exhaustedShared.reconcileRegistration({
		agentDirectory: "/tmp/provider-r3a-shared",
		targets: [available, cooling],
	});
	const disabled = await exhaustedShared.updateSettings(available, {
		enabled: false,
	});
	assert.equal(disabled.kind, "updated");
	const coolingClaim = await exhaustedShared.claim({
		target: cooling,
		effectiveRequestTimeoutMs: 0,
	});
	assert.equal(coolingClaim.kind, "claimed");
	if (coolingClaim.kind !== "claimed") throw new Error("expected cooling claim");
	const coolingFailure = await exhaustedShared.settle({
		target: cooling,
		outcome: { kind: "automatic-failure", reason: "HTTP 500" },
	});
	assert.equal(coolingFailure.kind, "settled");
	if (coolingFailure.kind !== "settled" || coolingFailure.action !== "cooldown")
		throw new Error("expected cooling result");
	let exhaustedCalls = 0;
	const exhaustedDelegate: Delegate = {
		resolveModel: () => {
			exhaustedCalls += 1;
			return targetModel(unknown);
		},
		complete: async () => {
			exhaustedCalls += 1;
			return okMessage(unknown);
		},
	};
	const exhausted = await consume(
		runFailoverRequest(
			exhaustedGenerated,
			{},
			{},
			makeState([exhaustedGenerated], exhaustedDelegate, exhaustedShared),
		),
	);
	assert.equal(exhaustedCalls, 0);
	assert.match(exhausted.result.errorMessage ?? "", /unknown-target/);
	assert.match(exhausted.result.errorMessage ?? "", /cooldown/);

	const source = { provider: "source", id: "m1" };
	const destination = { provider: "destination", id: "m4" };
	const transitionChain = [source, unknown, available, cooling, destination];
	const transitionGenerated = createGeneratedModel(transitionChain);
	transitionGenerated.id = "skip-transition";
	const transitionShared = await makeSharedState(transitionChain, {
		maxRetries: 0,
	});
	await transitionShared.reconcileRegistration({
		agentDirectory: "/tmp/provider-r3a-shared",
		targets: [source, available, cooling, destination],
	});
	const transitionDisabled = await transitionShared.updateSettings(available, {
		enabled: false,
	});
	assert.equal(transitionDisabled.kind, "updated");
	const transitionCoolingClaim = await transitionShared.claim({
		target: cooling,
		effectiveRequestTimeoutMs: 0,
	});
	assert.equal(transitionCoolingClaim.kind, "claimed");
	if (transitionCoolingClaim.kind !== "claimed")
		throw new Error("expected transition cooling claim");
	const transitionCooling = await transitionShared.settle({
		target: cooling,
		outcome: { kind: "automatic-failure", reason: "HTTP 500" },
	});
	assert.equal(transitionCooling.kind, "settled");
	if (
		transitionCooling.kind !== "settled" ||
		transitionCooling.action !== "cooldown"
	)
		throw new Error("expected transition cooldown");
	const transitionScript = scriptedDelegate(
		new Map([
			["source/m1", targetModel(source)],
			["destination/m4", targetModel(destination)],
		]),
		[
			{ status: 500, result: errorMessage(source, "HTTP error (500)") },
			{ result: okMessage(destination) },
		],
	);
	const transitions: Array<{
		modelId: string;
		source?: ModelRef;
		target: ModelRef;
	}> = [];
	const transitionState = makeState(
		[transitionGenerated],
		transitionScript.delegate,
		transitionShared,
	);
	transitionState.onTransition = (transition) =>
		transitions.push({
			modelId: transition.modelId,
			source: transition.source,
			target: transition.target,
		});
	const transitionOutcome = await consume(
		runFailoverRequest(transitionGenerated, {}, {}, transitionState),
	);
	assert.equal(transitionOutcome.result.model, "m4");
	assert.deepEqual(
		transitionScript.calls.map((call) => call.model.id),
		["m1", "m4"],
	);
	assert.deepEqual(transitions, [
		{ modelId: "skip-transition", source, target: destination },
	]);
});

test("status hooks cannot abort legacy routing or shared lease settlement", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const legacy = createGeneratedModel([a, b]);
	legacy.id = "status-hook-safety";
	legacy.errorHandlingMode = "switch";
	legacy.maxRetries = 0;
	const longReason = `provider auth token=hook-secret ${"x".repeat(400)}`;
	const legacyScript = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{ error: structuredError("provider_auth_error", longReason) },
			{ result: okMessage(b) },
		],
	);
	const legacyState = makeState([legacy], legacyScript.delegate);
	legacyState.onTarget = () => {
		throw new Error("target UI destroyed");
	};
	const transitionReasons: string[] = [];
	legacyState.onTransition = (transition) => {
		transitionReasons.push(transition.reason);
		throw new Error("transition UI destroyed");
	};
	legacyState.onManualRecovery = () => {
		throw new Error("recovery UI destroyed");
	};
	const legacyOutcome = await consume(
		runFailoverRequest(legacy, {}, {}, legacyState),
	);
	assert.equal(legacyOutcome.result.model, "m2");
	assert.equal(legacyScript.calls.length, 2);
	assert.equal(transitionReasons.length, 1);
	assert.ok(transitionReasons[0]!.length <= 256);
	assert.equal(transitionReasons[0]!.includes("hook-secret"), false);
	const recoveryReason = legacyState.manualRecovery.get(
		"status-hook-safety:a/m1",
	);
	assert.ok(recoveryReason);
	assert.ok(recoveryReason!.length <= 256);
	assert.equal(recoveryReason!.includes("hook-secret"), false);

	const shared = await makeSharedState([a, b], { maxRetries: 0 });
	const sharedGenerated = createGeneratedModel([a, b]);
	sharedGenerated.id = "shared-hook-safety";
	const sharedScript = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[
			{ status: 500, result: errorMessage(a, "HTTP error (500)") },
			{ result: okMessage(b) },
		],
	);
	const sharedState = makeState(
		[sharedGenerated],
		sharedScript.delegate,
		shared,
	);
	sharedState.onTarget = () => {
		throw new Error("shared target UI destroyed");
	};
	sharedState.onTransition = () => {
		throw new Error("shared transition UI destroyed");
	};
	const sharedOutcome = await consume(
		runFailoverRequest(sharedGenerated, {}, {}, sharedState),
	);
	assert.equal(sharedOutcome.result.model, "m2");
	assert.equal(sharedScript.calls.length, 2);
	const snapshot = await shared.snapshot();
	assert.equal("lease" in snapshot.document.targets["a/m1"].runtime, false);
	assert.equal("lease" in snapshot.document.targets["b/m2"].runtime, false);
});

test("tool execution errors remain in context for the target model", async () => {
	const a = { provider: "a", id: "m1" };
	const b = { provider: "b", id: "m2" };
	const generated = createGeneratedModel([a, b]);
	generated.id = "tool-error-terminal";
	const context = {
		messages: [
			{ role: "assistant", content: [] },
			{ role: "toolResult", isError: true },
			{ role: "toolResult", isError: false },
		],
	};
	const legacyScript = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[{ result: okMessage(a) }, { result: okMessage(b) }],
	);
	const legacyState = makeState([generated], legacyScript.delegate);
	const legacyOutcome = await consume(
		runFailoverRequest(generated, context, {}, legacyState),
	);
	assert.equal(legacyOutcome.result.stopReason, "stop");
	assert.equal(legacyOutcome.result.errorMessage, undefined);
	assert.equal(legacyScript.calls.length, 1);
	assert.equal(legacyState.manualRecovery.size, 0);
	assert.equal(legacyState.cooldowns.size, 0);

	const shared = await makeSharedState([a, b], { maxRetries: 0 });
	const sharedScript = scriptedDelegate(
		new Map([
			["a/m1", targetModel(a)],
			["b/m2", targetModel(b)],
		]),
		[{ result: okMessage(a) }, { result: okMessage(b) }],
	);
	const sharedState = makeState([generated], sharedScript.delegate, shared);
	const sharedOutcome = await consume(
		runFailoverRequest(generated, context, {}, sharedState),
	);
	assert.equal(sharedOutcome.result.stopReason, "stop");
	assert.equal(sharedOutcome.result.errorMessage, undefined);
	assert.equal(sharedScript.calls.length, 1);
	assert.equal(
		"lease" in (await shared.snapshot()).document.targets["a/m1"].runtime,
		false,
	);

	const oldErrorContext = {
		messages: [
			{ role: "toolResult", isError: true },
			{ role: "assistant", content: [] },
		],
	};
	const cleanOutcome = await consume(
		runFailoverRequest(generated, oldErrorContext, {}, legacyState),
	);
	assert.equal(cleanOutcome.result.stopReason, "stop");
	assert.equal(legacyScript.calls.length, 2);
});

test("target-unavailable throws create manual recovery without retry or cooldown", async () => {
	const a = { provider: "a", id: "m1" };
	const legacy = createGeneratedModel([a]);
	legacy.id = "target-unavailable-legacy";
	legacy.maxRetries = 5;
	let legacyCalls = 0;
	const legacyDelegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async (model) => {
			legacyCalls++;
			throw new Error(`Target unavailable: ${model.provider}/${model.id}`);
		},
	};
	const legacyState = makeState([legacy], legacyDelegate);
	const legacyOutcome = await consume(
		runFailoverRequest(legacy, {}, {}, legacyState),
	);
	assert.equal(legacyOutcome.result.stopReason, "error");
	assert.equal(legacyCalls, 1);
	assert.equal(
		legacyState.manualRecovery.get("target-unavailable-legacy:a/m1"),
		"model unavailable",
	);
	assert.equal(legacyState.cooldowns.size, 0);
	assert.equal(legacyState.cooldownLevels.size, 0);

	const shared = await makeSharedState([a], { maxRetries: 5 });
	const sharedGenerated = createGeneratedModel([a]);
	sharedGenerated.id = "target-unavailable-shared";
	let sharedCalls = 0;
	const sharedDelegate: Delegate = {
		resolveModel: (target) => targetModel(target),
		complete: async (model) => {
			sharedCalls++;
			throw new Error(`Target unavailable: ${model.provider}/${model.id}`);
		},
	};
	const sharedOutcome = await consume(
		runFailoverRequest(
			sharedGenerated,
			{},
			{},
			makeState([sharedGenerated], sharedDelegate, shared),
		),
	);
	assert.equal(sharedOutcome.result.stopReason, "error");
	assert.equal(sharedCalls, 1);
	const runtime = (await shared.snapshot()).document.targets["a/m1"].runtime;
	assert.equal(runtime.manualRecovery?.reason, "model unavailable");
	assert.equal(runtime.cooldownUntil, null);
	assert.equal(runtime.nextEligibleAt, null);
	assert.equal("lease" in runtime, false);
});
