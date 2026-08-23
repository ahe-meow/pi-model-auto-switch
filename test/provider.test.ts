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
import type { GeneratedFailoverModel, ModelRef } from "../src/types.ts";
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
	assert.equal(options.reasoning, "high");

	const payload: Record<string, unknown> = {};
	options.onPayload?.(payload);
	const digest = promptCacheKeyFromSessionId("s1");
	assert.equal(payload.prompt_cache_key, digest);
	assert.equal(payload.prompt_cache_retention, "24h");
	assert.deepEqual(payload.reasoning, { effort: "high" });

	const headers: Record<string, string | null> = { "X-Session-Id": "plain" };
	options.transformHeaders?.(headers);
	assert.equal(headers["X-Session-Id"], digest);
});

test("cache-field rejection retries without consuming policy retries", async () => {
	const a = { provider: "a", id: "m1" };
	const generated = createGeneratedModel([a]);
	generated.id = "primary";
	generated.maxRetries = 0;
	const { delegate, calls } = scriptedDelegate(
		new Map([["a/m1", targetModel(a)]]),
		[
			{
				status: 400,
				result: errorMessage(
					a,
					'{"error":{"type":"invalid_request_error","param":"prompt_cache_key","code":"unsupported_parameter"}}',
				),
			},
			{ result: okMessage(a) },
		],
	);
	const state = makeState([generated], delegate);
	const { result } = await consume(
		runFailoverRequest(generated, {}, { sessionId: "s1" }, state),
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(calls.length, 2);
	assert.ok(
		state.unsupportedCacheFields
			.get("primary:a/m1:openai-responses")
			?.has("prompt_cache_key"),
	);

	const retryPayload: Record<string, unknown> = {};
	calls[1].options.onPayload?.(retryPayload);
	assert.equal("prompt_cache_key" in retryPayload, false);
	assert.equal(retryPayload.prompt_cache_retention, "24h");
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

	const payload: Record<string, unknown> = {};
	options.onPayload?.(payload);
	assert.equal("reasoning" in payload, false);
	assert.equal(payload.prompt_cache_key, promptCacheKeyFromSessionId("s1"));

	const headers: Record<string, string | null> = { "X-Session-Id": "plain" };
	options.transformHeaders?.(headers);
	assert.equal(headers["X-Session-Id"], "plain");
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
