import assert from "node:assert/strict";
import { test } from "node:test";
import {
	COOLDOWN_LADDER_MINUTES,
	classifyFailure,
	cooldownMinutesForLevel,
	createRequestState,
	estimatedRetryDurationMs,
	markAttempt,
	nextCooldownLevel,
	nextUnattemptedModel,
	recordFailure,
	requestSummary,
	retryDelayMs,
	shouldRetryCurrentModel,
} from "../src/state.ts";

test("cooldown ladder uses fixed durations and caps invalid levels", () => {
	assert.deepEqual(COOLDOWN_LADDER_MINUTES, [10, 20, 40, 60, 90, 180, 360]);
	assert.equal(cooldownMinutesForLevel(0), 10);
	assert.equal(cooldownMinutesForLevel(5), 180);
	assert.equal(cooldownMinutesForLevel(6), 360);
	assert.equal(cooldownMinutesForLevel(99), 360);
	assert.equal(cooldownMinutesForLevel(-1), 360);
	assert.equal(cooldownMinutesForLevel(Number.NaN), 360);
	assert.equal(nextCooldownLevel(0), 1);
	assert.equal(nextCooldownLevel(5), 6);
	assert.equal(nextCooldownLevel(6), 6);
});

test("extension retry backoff grows exponentially up to 60 seconds", () => {
	assert.equal(retryDelayMs(0), 1000);
	assert.equal(retryDelayMs(1), 2000);
	assert.equal(retryDelayMs(4), 16_000);
	assert.equal(retryDelayMs(5), 32_000);
	assert.equal(retryDelayMs(6), 60_000);
	assert.equal(retryDelayMs(20), 60_000);
});

test("retry duration estimate sums one backoff delay per retry", () => {
	assert.equal(estimatedRetryDurationMs(0), 0);
	assert.equal(estimatedRetryDurationMs(1), 1000);
	assert.equal(estimatedRetryDurationMs(9), 243_000);
});

test("failure classification follows native-settled extension policy", () => {
	assert.equal(classifyFailure({ status: 401 }).kind, "persistent");
	assert.equal(classifyFailure({ status: 403 }).kind, "persistent");
	assert.equal(classifyFailure({ status: 404 }).kind, "persistent");
	assert.equal(
		classifyFailure({ message: "quota exceeded" }).kind,
		"persistent",
	);
	assert.equal(
		classifyFailure({ message: "insufficient_quota" }).kind,
		"persistent",
	);
	assert.equal(
		classifyFailure({ message: "insufficient funds" }).kind,
		"persistent",
	);
	assert.equal(
		classifyFailure({ message: "billing account is disabled" }).kind,
		"persistent",
	);
	assert.equal(
		classifyFailure({ status: 429, message: "rate limit exceeded" }).kind,
		"cooldown",
	);
	assert.equal(classifyFailure({ status: 503 }).kind, "cooldown");
	assert.deepEqual(
		classifyFailure({
			message: "OpenAI API error (502): upstream access forbidden",
		}),
		{ kind: "cooldown", reason: "HTTP 502" },
	);
	assert.equal(
		classifyFailure({ message: "database error (503): record unavailable" }).kind,
		"unknown",
	);
	assert.deepEqual(
		classifyFailure({
			status: 401,
			message: "OpenAI API error (502): upstream access forbidden",
		}),
		{ kind: "persistent", reason: "HTTP 401" },
	);
	assert.equal(
		classifyFailure({ message: "fetch failed: ECONNRESET" }).kind,
		"cooldown",
	);
	assert.equal(
		classifyFailure({
			stopReason: "error",
			message: "provider returned something unexpected",
		}).kind,
		"unknown",
	);
	assert.equal(
		classifyFailure({ timedOut: true, stopReason: "aborted" }).kind,
		"no-progress",
	);
	assert.equal(
		classifyFailure({ timedOut: true, toolError: true }).kind,
		"tool-failure",
	);
	assert.equal(classifyFailure({ stopReason: "aborted" }).kind, "cancelled");
	assert.equal(
		classifyFailure({ toolError: true, stopReason: "error" }).kind,
		"tool-failure",
	);
});

test("error behavior modes choose retries before switching", () => {
	assert.equal(shouldRetryCurrentModel("persistent", "smart"), false);
	assert.equal(shouldRetryCurrentModel("cooldown", "smart"), true);
	assert.equal(shouldRetryCurrentModel("unknown", "smart"), true);
	assert.equal(shouldRetryCurrentModel("no-progress", "smart"), true);
	assert.equal(shouldRetryCurrentModel("cooldown", "switch"), false);
	assert.equal(shouldRetryCurrentModel("persistent", "retry"), true);
	assert.equal(shouldRetryCurrentModel("cancelled", "retry"), false);
});

test("each request starts with a fresh attempted set and continuation allowance", () => {
	const first = createRequestState(1, { provider: "p", id: "one" });
	first.sameModelRetries = 1;
	const second = createRequestState(2, { provider: "p", id: "one" });
	assert.notEqual(first, second);
	assert.deepEqual([...second.attempted], ["p/one"]);
	assert.equal(second.sameModelRetries, 0);
});

test("traversal skips attempted and cooling models and has no revisit path", () => {
	const models = [
		{ provider: "p", id: "one" },
		{ provider: "p", id: "two" },
		{ provider: "p", id: "three" },
	];
	const request = createRequestState(1, models[0]);
	const cooldowns = new Map([["p/two", 2_000]]);
	assert.deepEqual(
		nextUnattemptedModel(models, request.attempted, cooldowns, 1_000),
		models[2],
	);
	assert.deepEqual(
		nextUnattemptedModel(models, request.attempted, cooldowns, 2_000),
		models[1],
	);
	assert.equal(markAttempt(request, models[1]), true);
	assert.equal(markAttempt(request, models[1]), false);
	assert.deepEqual(
		nextUnattemptedModel(models, request.attempted, new Map(), 2_000),
		models[2],
	);
});

test("request summaries retain the attempted chain and reasons", () => {
	const models = [
		{ provider: "p", id: "one" },
		{ provider: "p", id: "two" },
	];
	const request = createRequestState(1, models[0]);
	recordFailure(request, models[0], "HTTP 429");
	assert.equal(markAttempt(request, models[1], "HTTP 429"), true);
	assert.equal(
		requestSummary(request, models),
		"p/one (HTTP 429) -> p/two (HTTP 429)",
	);
});
