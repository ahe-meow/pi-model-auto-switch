import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canArmProgressTimer,
	classifyFailure,
	createRequestState,
	markAttempt,
	nextUnattemptedModel,
	recordFailure,
	requestSummary,
} from "../src/state.ts";

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

test("progress timers run only for active initial and extension continuation attempts", () => {
	assert.equal(
		canArmProgressTimer("enabled", "requesting", "initial", true),
		true,
	);
	assert.equal(
		canArmProgressTimer("enabled", "requesting", "extension-continuation", true),
		true,
	);
	assert.equal(
		canArmProgressTimer("enabled", "requesting", "native-retry", true),
		false,
	);
	assert.equal(
		canArmProgressTimer("paused", "requesting", "initial", true),
		false,
	);
	assert.equal(
		canArmProgressTimer("enabled", "settled", "initial", true),
		false,
	);
});

test("each request starts with a fresh attempted set and continuation allowance", () => {
	const first = createRequestState(1, { provider: "p", id: "one" });
	first.sameModelContinuationUsed = true;
	const second = createRequestState(2, { provider: "p", id: "one" });
	assert.notEqual(first, second);
	assert.deepEqual([...second.attempted], ["p/one"]);
	assert.equal(second.sameModelContinuationUsed, false);
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
