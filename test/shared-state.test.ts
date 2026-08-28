import assert from "node:assert/strict";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
	FAILOVER_STATE_PATH,
	SHARED_STATE_VERSION,
	createFileSharedState,
	createMemorySharedState,
	getFailoverStatePath,
	type ClaimResult,
	type LegacyTargetCandidate,
	type SharedStateCas,
	type SharedStateAdapter,
	type SharedStateDocument,
	type SharedTargetReference,
	type SharedTargetSelector,
	type SharedTargetSettings,
	type SharedTargetSettingsPatch,
} from "../src/shared-state.ts";
import { writeJsonAtomically } from "../src/json-file.ts";

const targetA = { provider: "openai", id: "model/a" };
const targetB = { provider: "anthropic", id: "model-b" };
const targetC = { provider: "google", id: "model-c" };

function defaultSettings(): SharedTargetSettings {
	return {
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
}

function settings(
	patch: Partial<SharedTargetSettings> = {},
): SharedTargetSettings {
	return {
		...defaultSettings(),
		...patch,
		modelParameters: {
			...defaultSettings().modelParameters,
			...(patch.modelParameters ?? {}),
		},
	};
}

function emptyDocument(): SharedStateDocument {
	return {
		version: SHARED_STATE_VERSION,
		revision: 0,
		targets: {},
		registrations: {},
		scopes: {},
	};
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function clock(start = 1_000_000): {
	now: () => number;
	set: (value: number) => void;
	advance: (delta: number) => void;
	value: () => number;
} {
	let current = start;
	return {
		now: () => current,
		set: (value) => {
			current = value;
		},
		advance: (delta) => {
			current += delta;
		},
		value: () => current,
	};
}

async function withTempState(
	run: (path: string, root: string) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-shared-state-r3-"));
	try {
		await run(join(root, "state", "failover-state.json"), root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeState(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value), "utf8");
}

async function writeBytes(path: string, value: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, value, "utf8");
}

function selector(target: SharedTargetReference): SharedTargetSelector {
	return typeof target === "string" ? { targetKey: target } : { target };
}

function objectKeys(value: unknown, keys: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const entry of value) objectKeys(entry, keys);
		return keys;
	}
	if (typeof value !== "object" || value === null) return keys;
	for (const [key, entry] of Object.entries(value)) {
		keys.push(key);
		objectKeys(entry, keys);
	}
	return keys;
}

function claimed(result: ClaimResult) {
	assert.equal(result.kind, "claimed");
	if (result.kind !== "claimed") throw new Error("expected claim");
	return result;
}

function assertShared(value: { coordination: string }): void {
	assert.equal(value.coordination, "shared");
}

function assertCoordinationFailure(
	result: {
		kind: string;
		coordination: string;
		detail?: string;
		reason?: string;
	},
	reason: string,
): asserts result is {
	kind: "invalid";
	coordination: "degraded";
	detail: string;
	reason: string;
} {
	assert.equal(result.kind, "invalid");
	assert.equal(result.coordination, "degraded");
	assert.equal(result.reason, reason);
	assert.match(result.detail ?? "", /coordination is unavailable/i);
	assert.ok((result.detail?.length ?? Number.POSITIVE_INFINITY) <= 128);
}

async function claim(
	adapter: SharedStateAdapter,
	target: SharedTargetReference = targetA,
	effectiveRequestTimeoutMs = 0,
) {
	return claimed(
		await adapter.claim({
			...selector(target),
			effectiveRequestTimeoutMs,
		}),
	);
}

async function automaticFailure(
	adapter: SharedStateAdapter,
	target: SharedTargetReference = targetA,
	reason = "HTTP 429",
) {
	return adapter.settle({
		...selector(target),
		outcome: { kind: "automatic-failure", reason },
	});
}

function legacyCandidate(
	target: SharedTargetReference,
	candidateSettings: SharedTargetSettings,
	source: string,
	manualRecoveryReason?: string,
): LegacyTargetCandidate {
	return {
		target,
		settings: candidateSettings,
		source,
		...(manualRecoveryReason === undefined ? {} : { manualRecoveryReason }),
	};
}

async function snapshotDocument(
	adapter: SharedStateAdapter,
): Promise<SharedStateDocument> {
	return (await adapter.snapshot()).document;
}

test("disabled targets are skipped", async () => {
	const adapter = createMemorySharedState({
		now: () => 10_000,
	});
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/disabled-test",
		targets: [targetA],
		legacyCandidates: [],
	});
	await adapter.updateSettings(targetA, { enabled: false });
	const result = await adapter.claim({
		target: targetA,
		effectiveRequestTimeoutMs: 0,
	});
	assert.equal(result.kind, "skipped");
	if (result.kind === "skipped") {
		assert.equal(result.skipReason, "disabled");
	}
});

test("legacy runtime lease is accepted and stripped on the next write", async () => {
	await withTempState(async (path) => {
		const seed = createMemorySharedState({ now: () => 10_000 });
		await seed.updateSettings(targetA, {});
		const legacy = clone((await seed.snapshot()).document) as unknown as {
			targets: Record<string, { runtime: Record<string, unknown> }>;
		};
		legacy.targets["openai/model/a"].runtime.lease = {
			owner: "legacy-agent",
			expiresAt: 10_060,
		};
		await writeState(path, legacy);

		const adapter = createFileSharedState({ path, now: () => 10_000 });
		const snapshot = await adapter.snapshot();
		assertShared(snapshot.status);
		assert.equal(
			"lease" in snapshot.document.targets["openai/model/a"].runtime,
			false,
		);

		const reconciled = await adapter.reconcileRegistration({
			agentDirectory: "/tmp/legacy-lease-test",
			targets: [targetA],
		});
		assert.equal(reconciled.kind, "reconciled");
		assertShared(reconciled);
		const updated = await adapter.updateSettings(targetA, { maxRetries: 3 });
		assert.equal(updated.kind, "updated");
		assertShared(updated);
		const persisted = JSON.parse(await readFile(path, "utf8")) as {
			targets: Record<string, { runtime: Record<string, unknown> }>;
		};
		assert.equal(
			"lease" in persisted.targets["openai/model/a"].runtime,
			false,
		);
		assert.equal(persisted.targets["openai/model/a"].runtime.updatedAt, 10_000);
	});
});

test("R3-001 strict v1 schema rejects partial, unknown, future, unsafe, and bad data", async () => {
	await withTempState(async (path) => {
		const seed = createMemorySharedState({
			now: () => 10,
		});
		const initial = await seed.snapshot();
		assert.deepEqual(initial.document, emptyDocument());
		assertShared(initial.status);
		await seed.updateSettings(targetA, {});
		const defaultClaim = await claim(seed, targetA, 0);
		assert.deepEqual(defaultClaim.settings, defaultSettings());
		const valid = (await seed.snapshot()).document;
		assert.equal(valid.revision, 2);
		const cases: Array<{ name: string; value: unknown; reason: string }> = [
			{
				name: "missing revision",
				value: (() => {
					const value = clone(valid) as unknown as Record<string, unknown>;
					delete value.revision;
					return value;
				})(),
				reason: "invalid",
			},
			{
				name: "unknown root",
				value: { ...clone(valid), catalog: { providers: {} } },
				reason: "invalid",
			},
			{
				name: "future version",
				value: { ...clone(emptyDocument()), version: 2 },
				reason: "future-version",
			},
			{
				name: "partial settings",
				value: (() => {
					const value = clone(valid);
					delete (
						value.targets["openai/model/a"].settings as unknown as Record<
							string,
							unknown
						>
					).modelParameters;
					return value;
				})(),
				reason: "invalid",
			},
			{
				name: "unknown runtime field",
				value: (() => {
					const value = clone(valid);
					(
						value.targets["openai/model/a"].runtime as unknown as Record<
							string,
							unknown
						>
					).prompt = "secret";
					return value;
				})(),
				reason: "invalid",
			},
			{
				name: "bad required timestamp",
				value: (() => {
					const value = clone(valid);
					value.targets["openai/model/a"].runtime.updatedAt =
						null as unknown as number;
					return value;
				})(),
				reason: "invalid",
			},
			{
				name: "invalid cooldown ladder level",
				value: (() => {
					const value = clone(valid);
					value.targets["openai/model/a"].runtime.cooldownLevel = 7;
					return value;
				})(),
				reason: "invalid",
			},
			{
				name: "invalid maxRetries",
				value: (() => {
					const value = clone(valid);
					value.targets["openai/model/a"].settings.maxRetries = 11;
					return value;
				})(),
				reason: "invalid",
			},
			{
				name: "unknown runtime field",
				value: (() => {
					const value = clone(valid);
					(
						value.targets["openai/model/a"].runtime as unknown as Record<
							string,
							unknown
						>
					).requestId = "request-123";
					return value;
				})(),
				reason: "invalid",
			},
			{
				name: "unsafe target key",
				value: (() => {
					const value = clone(valid);
					value.targets["__proto__/model"] = value.targets["openai/model/a"];
					return value;
				})(),
				reason: "invalid",
			},
			{
				name: "control character in registration key",
				value: (() => {
					const value = clone(valid);
					value.registrations[`/tmp/registration-\u0001`] = {
						targets: ["openai/model/a"],
						scopeKeys: [],
						updatedAt: 10,
					};
					return value;
				})(),
				reason: "invalid",
			},
			{
				name: "failover target",
				value: (() => {
					const value = clone(valid);
					value.targets["failover/virtual"] = value.targets["openai/model/a"];
					return value;
				})(),
				reason: "invalid",
			},
		];
		for (const entry of cases) {
			const bytes = JSON.stringify(entry.value);
			await writeBytes(path, bytes);
			const adapter = createFileSharedState({ path });
			const result = await adapter.snapshot();
			assert.equal(result.status.coordination, "degraded", entry.name);
			if (result.status.coordination === "degraded")
				assert.equal(result.status.reason, entry.reason, entry.name);
			assert.equal(await readFile(path, "utf8"), bytes, entry.name);
		}

		const slashAdapter = createFileSharedState({ path });
		await writeState(path, emptyDocument());
		await slashAdapter.updateSettings(targetA, {});
		const slashClaim = await slashAdapter.claim({
			targetKey: "openai/model/a",
			effectiveRequestTimeoutMs: 0,
		});
		assert.equal(slashClaim.kind, "claimed");
		assertShared(slashClaim);
		const serialized = await readFile(path, "utf8");
		const persistedKeys = objectKeys(JSON.parse(serialized) as unknown);
		for (const sensitive of [
			"requestId",
			"prompt",
			"secret",
			"catalog",
			"baseUrl",
			"credentials",
		])
			assert.equal(persistedKeys.includes(sensitive), false, sensitive);
	});
});

test("R3-002 defaults maxRetries to 5, enforces exact budgets, and caps retry delay", async () => {
	const budgets = [0, 1, 5, 10];
	for (const budget of budgets) {
		const time = clock(2_000_000);
		const adapter = createMemorySharedState({
			now: time.now,
		});
		await adapter.updateSettings(targetA, { maxRetries: budget });
		const initial = await snapshotDocument(adapter);
		assert.equal(initial.targets["openai/model/a"].settings.maxRetries, budget);
		let retryCount = 0;
		for (let failureNumber = 1; failureNumber <= budget + 1; failureNumber += 1) {
			const result = await automaticFailure(adapter);
			assert.equal(result.kind, "settled");
			if (result.kind !== "settled") throw new Error("expected settlement");
			if (failureNumber <= budget) {
				assert.equal(result.action, "retry");
				if (result.action !== "retry") throw new Error("expected retry");
				retryCount += 1;
				assert.equal(
					result.nextEligibleAt,
					time.value() + Math.min(2 ** (failureNumber - 1) * 1_000, 60_000),
				);
				time.set(result.nextEligibleAt!);
			} else {
				assert.equal(result.action, "cooldown");
				break;
			}
		}
		assert.equal(retryCount, budget);
		const state = await snapshotDocument(adapter);
		assert.equal(state.targets["openai/model/a"].runtime.cooldownLevel, 1);
		assert.equal(state.targets["openai/model/a"].runtime.consecutiveFailures, 0);
	}

	await withTempState(async (path) => {
		const time = clock(3_000_000);
		const first = createFileSharedState({
			path,
			now: time.now,
		});
		const second = createFileSharedState({
			path,
			now: time.now,
		});
		await first.updateSettings(targetA, { maxRetries: 5 });
		for (let index = 0; index < 2; index += 1) {
			const result = await automaticFailure(first);
			assert.equal(result.kind, "settled");
			if (result.kind !== "settled" || result.action !== "retry")
				throw new Error("expected retry");
			time.set(result.nextEligibleAt!);
		}
		for (let index = 0; index < 4; index += 1) {
			const result = await automaticFailure(second);
			assert.equal(result.kind, "settled");
			if (result.kind !== "settled") throw new Error("expected settlement");
			if (index < 3) {
				assert.equal(result.action, "retry");
				if (result.action !== "retry") throw new Error("expected retry");
				time.set(result.nextEligibleAt!);
			} else {
				assert.equal(result.action, "cooldown");
			}
		}
		const snapshot = await second.snapshot();
		assertShared(snapshot.status);
		assert.equal(
			snapshot.document.targets["openai/model/a"].runtime.cooldownLevel,
			1,
		);
	});
});

test("R3-003 applies every cooldown rung, caps the ladder, and clears it on reset and success", async () => {
	const time = clock(4_000_000);
	const adapter = createMemorySharedState({
		now: time.now,
	});
	await adapter.updateSettings(targetA, { maxRetries: 0 });
	const ladderMinutes = [10, 20, 40, 60, 90, 180, 360, 360];
	let cumulative = 0;
	for (let index = 0; index < ladderMinutes.length; index += 1) {
		const result = await automaticFailure(adapter);
		assert.equal(result.kind, "settled");
		if (result.kind !== "settled" || result.action !== "cooldown")
			throw new Error("expected cooldown");
		const duration = ladderMinutes[index] * 60_000;
		cumulative += duration;
		assert.equal(result.cooldownUntil, time.value() + duration);
		time.set(result.cooldownUntil);
		const state = await snapshotDocument(adapter);
		const runtime = state.targets["openai/model/a"].runtime;
		assert.equal(runtime.cooldownLevel, Math.min(index + 1, 6));
		assert.equal(runtime.cumulativeCooldownMs, cumulative);
	}
	const reset = await adapter.resetTargets([targetA]);
	assert.equal(reset.kind, "reset");
	const afterReset = await snapshotDocument(adapter);
	assert.deepEqual(afterReset.targets["openai/model/a"].runtime, {
		consecutiveFailures: 0,
		nextEligibleAt: null,
		cooldownUntil: null,
		cooldownLevel: 0,
		cumulativeCooldownMs: 0,
		manualRecovery: null,
		lastFailureReason: null,
		lastFailureAt: null,
		updatedAt: time.value(),
	});
	const success = await adapter.settle({
		target: targetA,
		outcome: { kind: "success" },
	});
	assert.equal(success.kind, "settled");
	const afterSuccess = await snapshotDocument(adapter);
	assert.deepEqual(afterSuccess.targets["openai/model/a"].runtime, {
		consecutiveFailures: 0,
		nextEligibleAt: null,
		cooldownUntil: null,
		cooldownLevel: 0,
		cumulativeCooldownMs: 0,
		manualRecovery: null,
		lastFailureReason: null,
		lastFailureAt: null,
		updatedAt: time.value(),
	});
});

test("R3-004 file mutations fail closed for malformed state, write failures, locks, and bounded conflicts", async () => {
	await withTempState(async (path, root) => {
		const malformedBytes = "{not-json";
		await writeBytes(path, malformedBytes);
		const warnings: string[] = [];
		const malformed = createFileSharedState({
			path,
			warn: (message) => warnings.push(message),
			now: () => 5_000_000,
		});
		const blocked = await malformed.snapshot();
		assert.equal(blocked.status.coordination, "degraded");
		if (blocked.status.coordination === "degraded") {
			assert.equal(blocked.status.reason, "malformed");
			assert.equal(blocked.status.detail.includes(path), false);
		}
		const malformedUpdate = await malformed.updateSettings(targetA, {});
		assertCoordinationFailure(malformedUpdate, "malformed");
		const malformedClaim = await malformed.claim({
			target: targetA,
			effectiveRequestTimeoutMs: 0,
		});
		assertCoordinationFailure(malformedClaim, "malformed");
		const afterMalformed = await malformed.snapshot();
		assert.deepEqual(afterMalformed.document, blocked.document);
		assert.equal(await readFile(path, "utf8"), malformedBytes);
		assert.ok(warnings.length > 0);

		await writeState(path, emptyDocument());
		const repaired = await malformed.snapshot();
		assertShared(repaired.status);
		assert.deepEqual(repaired.document, emptyDocument());
		const emptyBytes = await readFile(path, "utf8");

		const privateDiagnostic = `${path}/private-token`;
		const throwingCas: SharedStateCas = async () => {
			throw new Error(privateDiagnostic);
		};
		const throwing = createFileSharedState({
			path,
			cas: throwingCas,
			now: () => 5_000_000,
		});
		const beforeThrow = await throwing.snapshot();
		const failedOperations = [
			await throwing.updateSettings(targetA, {}),
			await throwing.claim({
				target: targetA,
				effectiveRequestTimeoutMs: 0,
			}),
			await throwing.settle({
				target: targetA,
				outcome: { kind: "persistent-failure", reason: "model unavailable" },
			}),
			await throwing.resetTargets([targetA]),
			await throwing.reconcileRegistration({
				agentDirectory: "/tmp/throwing-registration",
				targets: [targetA],
			}),
		];
		for (const result of failedOperations) {
			assertCoordinationFailure(result, "write-failed");
			assert.equal(result.detail.includes(privateDiagnostic), false);
		}
		const afterThrow = await throwing.snapshot();
		assert.deepEqual(afterThrow.document, beforeThrow.document);
		assert.equal(await readFile(path, "utf8"), emptyBytes);

		const blockedParent = join(root, "not-a-directory");
		await writeFile(blockedParent, "preserve", "utf8");
		const unwritable = createFileSharedState({
			path: join(blockedParent, "state.json"),
			now: () => 5_000_000,
		});
		const writeFailure = await unwritable.updateSettings(targetC, {});
		assertCoordinationFailure(writeFailure, "unreadable");
		assert.equal(writeFailure.detail.includes(blockedParent), false);
		assert.deepEqual((await unwritable.snapshot()).document, emptyDocument());
		assert.equal(await readFile(blockedParent, "utf8"), "preserve");

		const lockPath = `${path}.lock`;
		const foreignLock = JSON.stringify({
			pid: 999_999,
			createdAt: 1,
			owner: "foreign-lock",
		});
		await writeBytes(lockPath, foreignLock);
		const locked = createFileSharedState({
			path,
			now: () => 5_000_000,
		});
		const beforeLock = await locked.snapshot();
		const lockFailure = await locked.updateSettings(targetC, {});
		assertCoordinationFailure(lockFailure, "write-failed");
		assert.deepEqual(beforeLock.document, emptyDocument());
		assert.deepEqual(await readFile(path, "utf8"), emptyBytes);
		assert.equal(await readFile(lockPath, "utf8"), foreignLock);
		await rm(lockPath);
		const lockRepaired = await locked.snapshot();
		assertShared(lockRepaired.status);
		assert.deepEqual(lockRepaired.document, emptyDocument());

		const savedWithoutBuild: SharedStateCas = async () => ({ kind: "saved" });
		const unverified = createFileSharedState({
			path,
			cas: savedWithoutBuild,
			now: () => 5_000_000,
		});
		const beforeUnverified = await unverified.snapshot();
		const unverifiedWrite = await unverified.updateSettings(targetA, {});
		assertCoordinationFailure(unverifiedWrite, "write-failed");
		assert.deepEqual(
			(await unverified.snapshot()).document,
			beforeUnverified.document,
		);
		assert.equal(await readFile(path, "utf8"), emptyBytes);

		const seed = createFileSharedState({
			path,
			now: () => 5_000_000,
		});
		const seeded = await seed.reconcileRegistration({
			agentDirectory: "/tmp/conflict-registration",
			targets: [targetB],
		});
		assert.equal(seeded.kind, "reconciled");
		const canonicalBeforeConflicts = (await seed.snapshot()).document;
		const bytesBeforeConflicts = await readFile(path, "utf8");
		let forceConflict = true;
		const recoveringCas: SharedStateCas = async (
			statePath,
			label,
			expectedRevision,
			build,
		) => {
			if (forceConflict) return { kind: "conflict" };
			return writeJsonAtomically(statePath, label, expectedRevision, build);
		};
		const firstConflict = createFileSharedState({
			path,
			cas: recoveringCas,
			maxAttempts: 2,
			now: () => 5_000_000,
		});
		const secondConflict = createFileSharedState({
			path,
			cas: recoveringCas,
			maxAttempts: 2,
			now: () => 5_000_000,
		});
		await Promise.all([firstConflict.snapshot(), secondConflict.snapshot()]);
		const [firstClaim, secondClaim] = await Promise.all([
			firstConflict.claim({
				target: targetB,
				effectiveRequestTimeoutMs: 0,
			}),
			secondConflict.claim({
				target: targetB,
				effectiveRequestTimeoutMs: 0,
			}),
		]);
		assertCoordinationFailure(firstClaim, "cas-exhausted");
		assertCoordinationFailure(secondClaim, "cas-exhausted");
		assert.equal(await readFile(path, "utf8"), bytesBeforeConflicts);
		assert.deepEqual(
			(await firstConflict.snapshot()).document,
			canonicalBeforeConflicts,
		);
		assert.deepEqual(
			(await secondConflict.snapshot()).document,
			canonicalBeforeConflicts,
		);

		forceConflict = false;
		const conflictRepaired = await firstConflict.snapshot();
		assertShared(conflictRepaired.status);
		assert.deepEqual(conflictRepaired.document, canonicalBeforeConflicts);
		const recoveredClaim = await firstConflict.claim({
			target: targetB,
			effectiveRequestTimeoutMs: 0,
		});
		assert.equal(recoveredClaim.kind, "claimed");
		assertShared(recoveredClaim);
		const recoveredSecond = await secondConflict.snapshot();
		assertShared(recoveredSecond.status);
		const recoveredSecondClaim = await secondConflict.claim({
			target: targetB,
			effectiveRequestTimeoutMs: 0,
		});
		assert.equal(recoveredSecondClaim.kind, "claimed");
	});
});

test("R3-005 snapshots are fresh, independent claims, and retry gating", async () => {
	await withTempState(async (path) => {
		const time = clock(6_000_000);
		const first = createFileSharedState({
			path,
			now: time.now,
		});
		const second = createFileSharedState({
			path,
			now: time.now,
		});
		await first.updateSettings(targetA, {});
		const [firstClaim, secondClaim] = await Promise.all([
			first.claim({ target: targetA, effectiveRequestTimeoutMs: 120_000 }),
			second.claim({ target: targetA, effectiveRequestTimeoutMs: 120_000 }),
		]);
		assert.equal(firstClaim.kind, "claimed");
		assert.equal(secondClaim.kind, "claimed");
		const fresh = await second.snapshot();
		assertShared(fresh.status);

		const failure = await automaticFailure(first);
		assert.equal(failure.kind, "settled");
		if (failure.kind !== "settled" || failure.action !== "retry")
			throw new Error("expected retry");
		time.set(failure.nextEligibleAt! - 1);
		const otherSkip = await second.claim({
			target: targetA,
			effectiveRequestTimeoutMs: 0,
		});
		assert.equal(otherSkip.kind, "skipped");
		if (otherSkip.kind === "skipped") assert.equal(otherSkip.skipReason, "retry");
		const sameAdapterSkip = await first.claim({
			target: targetA,
			effectiveRequestTimeoutMs: 120_000,
		});
		assert.equal(sameAdapterSkip.kind, "skipped");
		if (sameAdapterSkip.kind === "skipped")
			assert.equal(sameAdapterSkip.skipReason, "retry");
		time.set(failure.nextEligibleAt! + 1);
		const freshSuccess = await second.settle({
			target: targetA,
			outcome: { kind: "success" },
		});
		assert.equal(freshSuccess.kind, "settled");
	});

	const nonceTime = clock(6_500_000);
	const nonceAdapter = createMemorySharedState({
		now: nonceTime.now,
	});
	await nonceAdapter.updateSettings(targetA, {});
	const nonceFailure = await automaticFailure(nonceAdapter);
	assert.equal(nonceFailure.kind, "settled");
	if (nonceFailure.kind !== "settled" || nonceFailure.action !== "retry")
		throw new Error("expected nonce retry");
	nonceTime.set(nonceFailure.nextEligibleAt! - 1);
	const laterClaim = await nonceAdapter.claim({
		target: targetA,
		effectiveRequestTimeoutMs: 0,
	});
	assert.equal(laterClaim.kind, "skipped");
	if (laterClaim.kind === "skipped")
		assert.equal(laterClaim.skipReason, "retry");
	const continued = await nonceAdapter.settle({
		target: targetA,
		outcome: { kind: "success" },
	});
	assert.equal(continued.kind, "settled");
});

test("R3-006 persistent failures preserve automatic state, and compatibility is global no-op", async () => {
	const time = clock(7_000_000);
	const adapter = createMemorySharedState({
		now: time.now,
	});
	await adapter.updateSettings(targetA, { maxRetries: 5 });
	const retry = await automaticFailure(adapter, targetA, "network timeout");
	assert.equal(retry.kind, "settled");
	if (retry.kind !== "settled" || retry.action !== "retry")
		throw new Error("expected retry");
	const beforePersistent = (await adapter.snapshot()).document.targets[
		"openai/model/a"
	].runtime;
	const persistent = await adapter.settle({
		target: targetA,
		outcome: { kind: "persistent-failure", reason: "HTTP 401" },
	});
	assert.equal(persistent.kind, "settled");
	if (persistent.kind !== "settled" || persistent.action !== "manual-recovery")
		throw new Error("expected manual recovery");
	assert.equal(persistent.manualRecovery.reason, "HTTP 401");
	const afterPersistent = (await adapter.snapshot()).document.targets[
		"openai/model/a"
	].runtime;
	assert.equal(
		afterPersistent.consecutiveFailures,
		beforePersistent.consecutiveFailures,
	);
	assert.equal(afterPersistent.nextEligibleAt, beforePersistent.nextEligibleAt);
	assert.equal(afterPersistent.cooldownLevel, beforePersistent.cooldownLevel);
	assert.equal(
		afterPersistent.cumulativeCooldownMs,
		beforePersistent.cumulativeCooldownMs,
	);
	assert.equal(afterPersistent.cooldownUntil, null);
	assert.deepEqual(afterPersistent.manualRecovery, {
		reason: "HTTP 401",
		updatedAt: time.value(),
	});

	const noLease = await adapter.settle({
		target: targetB,
		outcome: { kind: "persistent-failure", reason: "model unavailable" },
	});
	assert.equal(noLease.kind, "settled");
	if (noLease.kind !== "settled" || noLease.action !== "manual-recovery")
		throw new Error("expected model unavailable settlement");
	assert.equal(noLease.manualRecovery.reason, "model unavailable");

	const compatibilityTarget = { provider: "cohere", id: "compat" };
	await adapter.updateSettings(compatibilityTarget, { maxRetries: 5 });
	const compatibilityFailure = await automaticFailure(
		adapter,
		compatibilityTarget,
		"automatic",
	);
	assert.equal(compatibilityFailure.kind, "settled");
	if (
		compatibilityFailure.kind !== "settled" ||
		compatibilityFailure.action !== "retry"
	)
		throw new Error("expected retry");
	const beforeCompatibility = (await adapter.snapshot()).document.targets[
		"cohere/compat"
	].runtime;
	const compatibility = await adapter.settle({
		target: compatibilityTarget,
		outcome: { kind: "compatibility-retry" },
	});
	assert.equal(compatibility.kind, "settled");
	if (
		compatibility.kind !== "settled" ||
		compatibility.action !== "compatibility-retry"
	)
		throw new Error("expected compatibility retry");
	const afterCompatibility = (await adapter.snapshot()).document.targets[
		"cohere/compat"
	].runtime;
	assert.equal(
		afterCompatibility.consecutiveFailures,
		beforeCompatibility.consecutiveFailures,
	);
	assert.equal(
		afterCompatibility.nextEligibleAt,
		beforeCompatibility.nextEligibleAt,
	);
	assert.equal(
		afterCompatibility.cumulativeCooldownMs,
		beforeCompatibility.cumulativeCooldownMs,
	);
	assert.equal(
		JSON.stringify(afterCompatibility).includes("compatibility"),
		false,
	);
	assert.equal(JSON.stringify(afterCompatibility).includes("request"), false);
});

test("R3-007 numeric revision increments once and CAS merge keeps settings and failures", async () => {
	await withTempState(async (path) => {
		const time = clock(8_000_000);
		const first = createFileSharedState({ path, now: time.now });
		const second = createFileSharedState({
			path,
			now: time.now,
		});
		await Promise.all([
			first.updateSettings(targetA, { maxRetries: 2 }),
			second.updateSettings(targetA, { reasoningEffort: "high" }),
		]);
		let snapshot = await first.snapshot();
		assertShared(snapshot.status);
		assert.equal(snapshot.document.revision, 2);
		assert.equal(
			snapshot.document.targets["openai/model/a"].settings.maxRetries,
			2,
		);
		assert.equal(
			snapshot.document.targets["openai/model/a"].settings.reasoningEffort,
			"high",
		);
		const failure = await automaticFailure(first);
		assert.equal(failure.kind, "settled");
		assert.equal((await first.snapshot()).document.revision, 3);
		await second.updateSettings(targetA, { noProgressTimeoutSeconds: 120 });
		snapshot = await second.snapshot();
		assert.equal(snapshot.document.revision, 4);
		const record = snapshot.document.targets["openai/model/a"];
		assert.equal(record.settings.maxRetries, 2);
		assert.equal(record.settings.reasoningEffort, "high");
		assert.equal(record.settings.noProgressTimeoutSeconds, 120);
		assert.equal(record.runtime.consecutiveFailures, 1);
	});
});

test("R3-008 registration canonicalization sorts, unions, collects, and deletes on last reference", async () => {
	const time = clock(9_000_000);
	const adapter = createMemorySharedState({
		now: time.now,
	});
	const first = await adapter.reconcileRegistration({
		agentDirectory: "/tmp/registration-r3/../registration-r3",
		targets: [targetB, targetA, targetA],
	});
	assert.equal(first.kind, "reconciled");
	if (first.kind !== "reconciled") throw new Error("expected registration");
	assert.deepEqual(first.targets, ["anthropic/model-b", "openai/model/a"]);
	let snapshot = await adapter.snapshot();
	assert.deepEqual(
		snapshot.document.registrations["/tmp/registration-r3"].targets,
		["anthropic/model-b", "openai/model/a"],
	);
	assert.deepEqual(Object.keys(snapshot.document.targets).sort(), [
		"anthropic/model-b",
		"openai/model/a",
	]);
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/other-registration-r3",
		targets: [targetB, targetC],
	});
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/registration-r3",
		targets: [targetA],
	});
	snapshot = await adapter.snapshot();
	assert.deepEqual(Object.keys(snapshot.document.targets).sort(), [
		"anthropic/model-b",
		"google/model-c",
		"openai/model/a",
	]);
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/other-registration-r3",
		targets: [targetC],
	});
	snapshot = await adapter.snapshot();
	assert.deepEqual(Object.keys(snapshot.document.targets).sort(), [
		"google/model-c",
		"openai/model/a",
	]);
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/registration-r3",
		targets: [],
	});
	snapshot = await adapter.snapshot();
	assert.deepEqual(Object.keys(snapshot.document.targets).sort(), [
		"google/model-c",
	]);
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/other-registration-r3",
		targets: [],
	});
	snapshot = await adapter.snapshot();
	assert.deepEqual(snapshot.document.targets, {});
});

test("R3-009 legacy candidates use precedence, warn on conflicts, preserve manual reason, and are idempotent", async () => {
	const time = clock(10_000_000);
	const warnings: string[] = [];
	const adapter = createMemorySharedState({
		now: time.now,
		warn: (message) => warnings.push(message),
	});
	const candidates = [
		legacyCandidate(targetA, settings({ maxRetries: 1 }), "legacy-one"),
		legacyCandidate(
			targetA,
			settings({ maxRetries: 2 }),
			"legacy-two",
			"balance/quota raw secret",
		),
		legacyCandidate(
			targetA,
			settings({ maxRetries: 3 }),
			"legacy-three",
			"HTTP 401",
		),
	];
	const first = await adapter.reconcileRegistration({
		agentDirectory: "/tmp/legacy-r3",
		targets: [targetA],
		legacyCandidates: candidates,
	});
	assert.equal(first.kind, "reconciled");
	const afterFirst = await snapshotDocument(adapter);
	const record = afterFirst.targets["openai/model/a"];
	assert.equal(record.settings.maxRetries, 1);
	assert.equal(
		record.runtime.manualRecovery?.reason,
		"balance/quota/usage failure",
	);
	assert.ok(
		warnings.some((message) => message.includes("target=openai/model/a")),
	);
	assert.ok(warnings.some((message) => message.includes("winner=legacy-one")));
	assert.ok(
		warnings.some((message) => message.includes("conflicting=legacy-two")),
	);
	assert.ok(warnings.some((message) => message.includes("fields=maxRetries")));
	const warningCount = warnings.length;
	const revision = afterFirst.revision;
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/legacy-r3",
		targets: [targetA],
		legacyCandidates: candidates,
	});
	const afterSecond = await snapshotDocument(adapter);
	assert.equal(afterSecond.revision, revision);
	assert.equal(warnings.length, warningCount);
	await adapter.updateSettings(targetA, { maxRetries: 4 });
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/legacy-r3",
		targets: [targetA],
		legacyCandidates: [
			legacyCandidate(targetA, settings({ maxRetries: 9 }), "newer"),
		],
	});
	const authoritative = await snapshotDocument(adapter);
	assert.equal(authoritative.targets["openai/model/a"].settings.maxRetries, 4);
});

test("R3-010 narrow operations reject unsafe targets, invalid settings, duplicate selectors, and bad outcomes", async () => {
	const adapter = createMemorySharedState({
		now: () => 11_000_000,
	});
	const invalidClaims: unknown[] = [
		{ targetKey: "failover/x", effectiveRequestTimeoutMs: 0 },
		{ targetKey: "__proto__/x", effectiveRequestTimeoutMs: 0 },
		{ targetKey: "openai", effectiveRequestTimeoutMs: 0 },
		{
			target: targetA,
			targetKey: "openai/model/a",
			effectiveRequestTimeoutMs: 0,
		},
		{ target: targetA, effectiveRequestTimeoutMs: -1 },
		{ target: targetA, effectiveRequestTimeoutMs: Number.POSITIVE_INFINITY },
	];
	for (const input of invalidClaims) {
		const result = await adapter.claim(input as never);
		assert.equal(result.kind, "invalid");
		assertShared(result);
	}
	for (const patch of [
		{ maxRetries: -1 },
		{ maxRetries: 11 },
		{ noProgressTimeoutSeconds: 14 },
		{ noProgressTimeoutSeconds: 901 },
		{ unknown: true },
		{ modelParameters: { promptCacheKey: "yes" } },
	]) {
		const result = await adapter.updateSettings(targetA, patch as never);
		assert.equal(result.kind, "invalid");
	}
	await adapter.updateSettings(targetA, {});
	const invalidSettle = await adapter.settle({
		target: targetA,
		outcome: { kind: "obsolete" } as never,
	});
	assert.equal(invalidSettle.kind, "invalid");
	const invalidReset = await adapter.resetTargets(["failover/x"]);
	assert.equal(invalidReset.kind, "invalid");
	const invalidRegistration = await adapter.reconcileRegistration({
		agentDirectory: "",
		targets: [],
	});
	assert.equal(invalidRegistration.kind, "invalid");
	const controlCharacterRegistration = await adapter.reconcileRegistration({
		agentDirectory: "/tmp/invalid-\u0001-registration",
		targets: [],
	});
	assert.equal(controlCharacterRegistration.kind, "invalid");
});

test("R3-011 creates restrictive missing directories and state files without chmodding existing directories", async () => {
	await withTempState(async (path, root) => {
		const time = clock(12_000_000);
		let observedLockMode: number | undefined;
		const inspectLock: SharedStateCas = (
			statePath,
			label,
			expectedRevision,
			build,
		) =>
			writeJsonAtomically(statePath, label, expectedRevision, (source) => {
				observedLockMode = statSync(`${statePath}.lock`).mode & 0o777;
				return build(source);
			});
		const adapter = createFileSharedState({
			path,
			now: time.now,
			cas: inspectLock,
		});
		await adapter.updateSettings(targetA, {});
		await claim(adapter);
		const directoryMode = (await stat(join(root, "state"))).mode & 0o777;
		const fileMode = (await stat(path)).mode & 0o777;
		assert.equal(directoryMode, 0o700);
		assert.equal(fileMode, 0o600);
		assert.equal(observedLockMode, 0o600);
		await assert.rejects(access(`${path}.lock`));

		const existingPath = join(root, "existing", "state.json");
		await mkdir(join(root, "existing"), { recursive: true, mode: 0o755 });
		const existingBefore = (await stat(join(root, "existing"))).mode & 0o777;
		const existing = createFileSharedState({
			path: existingPath,
			now: time.now,
		});
		await existing.updateSettings(targetB, {});
		await claim(existing, targetB);
		const existingAfter = (await stat(join(root, "existing"))).mode & 0o777;
		assert.equal(existingAfter, existingBefore);
		assert.notEqual(path, FAILOVER_STATE_PATH);
		assert.equal(
			getFailoverStatePath(root),
			join(root, ".pi", "agent", "failover-state.json"),
		);
	});
});

test("R3-012 memory and file factories execute the same pure transitions", async () => {
	await withTempState(async (path) => {
		const time = clock(13_000_000);
		const memory = createMemorySharedState({
			now: time.now,
		});
		const file = createFileSharedState({
			path,
			now: time.now,
		});
		await memory.updateSettings(targetA, {
			maxRetries: 2,
			reasoningEffort: "high",
		});
		await file.updateSettings(targetA, {
			maxRetries: 2,
			reasoningEffort: "high",
		});
		let memoryDoc = await snapshotDocument(memory);
		let fileDoc = (await file.snapshot()).document;
		assert.deepEqual(fileDoc, memoryDoc);
			const memoryClaim = await claim(memory);
		const fileClaim = await claim(file);
		assert.equal(memoryClaim.kind, "claimed");
		assert.equal(fileClaim.kind, "claimed");
		const memoryFailure = await automaticFailure(memory);
		const fileFailure = await automaticFailure(file);
		assert.deepEqual(fileFailure, memoryFailure);
		assert.equal(memoryFailure.kind, "settled");
		if (
			memoryFailure.kind !== "settled" ||
			memoryFailure.action !== "retry" ||
			fileFailure.kind !== "settled" ||
			fileFailure.action !== "retry"
		)
			throw new Error("expected retry");
		time.set(memoryFailure.nextEligibleAt!);
		memoryDoc = await snapshotDocument(memory);
		fileDoc = (await file.snapshot()).document;
		assert.deepEqual(fileDoc, memoryDoc);
		const memorySuccess = await memory.settle({
			target: targetA,
			outcome: { kind: "success" },
		});
		const fileSuccess = await file.settle({
			target: targetA,
			outcome: { kind: "success" },
		});
		assert.deepEqual(fileSuccess, memorySuccess);
	});
});

test("R3-013 settlements on unknown targets never mutate shared state", async () => {
	const time = clock(14_000_000);
	const adapter = createMemorySharedState({ now: time.now });
	await adapter.updateSettings(targetA, {});
	const before = await snapshotDocument(adapter);
	const unknown = await adapter.settle({
		target: targetC,
		outcome: { kind: "success" },
	});
	assert.equal(unknown.kind, "stale");
	assert.deepEqual(await snapshotDocument(adapter), before);
	const settled = await adapter.settle({
		target: targetA,
		outcome: { kind: "success" },
	});
	assert.equal(settled.kind, "settled");
	if (settled.kind === "settled") assert.equal(settled.action, "success");
	const after = await snapshotDocument(adapter);
	assert.equal(after.targets["openai/model/a"].runtime.consecutiveFailures, 0);
});

test("R3-014 persistent reasons serialize only sanitized state", async () => {
	await withTempState(async (path) => {
		const time = clock(15_000_000);
		const adapter = createFileSharedState({
			path,
			now: time.now,
		});
		await adapter.updateSettings(targetA, {});
		const activeDocument = JSON.parse(
			await readFile(path, "utf8"),
		) as SharedStateDocument;
		assert.equal("lease" in activeDocument.targets["openai/model/a"].runtime, false);
			const result = await adapter.settle({
			target: targetA,
			outcome: {
				kind: "persistent-failure",
				reason: "HTTP 403 apiKey=super-secret prompt=private",
			},
		});
		assert.equal(result.kind, "settled");
		if (result.kind !== "settled" || result.action !== "manual-recovery")
			throw new Error("expected manual recovery");
		assert.equal(result.manualRecovery.reason, "HTTP 403");
		const serialized = await readFile(path, "utf8");
		for (const secret of [
			"apiKey",
			"super-secret",
			"prompt=private",
			"requestId",
			"leaseDurationMs",
			"lease",
		])
			assert.equal(serialized.includes(secret), false, secret);
		const document = (await adapter.snapshot()).document;
		assert.deepEqual(
			document.targets["openai/model/a"].runtime.manualRecovery,
			{ reason: "HTTP 403", updatedAt: time.value() },
		);
		assert.equal(document.targets["openai/model/a"].runtime.cooldownUntil, null);
	});
});

test("R3-015 status recovers after canonical repair and last registration deletion removes target records", async () => {
	await withTempState(async (path) => {
		const time = clock(16_000_000);
		await writeBytes(
			path,
			JSON.stringify({ version: 99, targets: {}, registrations: {} }),
		);
		const adapter = createFileSharedState({
			path,
			now: time.now,
		});
		assert.equal(adapter.status().coordination, "shared");
		const blocked = await adapter.snapshot();
		assert.equal(blocked.status.coordination, "degraded");
		await writeState(path, emptyDocument());
		const repaired = await adapter.reconcileRegistration({
			agentDirectory: "/tmp/repaired-r3",
			targets: [targetA],
		});
		assert.equal(repaired.coordination, "shared");
		assert.equal((await adapter.snapshot()).document.revision, 1);
		await adapter.reconcileRegistration({
			agentDirectory: "/tmp/repaired-r3",
			targets: [],
		});
		const final = await adapter.snapshot();
		assertShared(final.status);
		assert.deepEqual(final.document.targets, {});
		assert.deepEqual(
			final.document.registrations["/tmp/repaired-r3"].targets,
			[],
		);
	});
});

test("R3-017 settlements apply regardless of adapter ownership", async () => {
	const time = clock(18_000_000);
	const adapter = createMemorySharedState({
		now: time.now,
	});
	await adapter.updateSettings(targetA, { maxRetries: 5 });

	const foreign = createMemorySharedState({
		document: await snapshotDocument(adapter),
		now: time.now,
	});
	const foreignSettle = await foreign.settle({
		target: targetA,
		outcome: { kind: "automatic-failure", reason: "HTTP 429" },
	});
	assert.equal(foreignSettle.kind, "settled");
	if (foreignSettle.kind !== "settled" || foreignSettle.action !== "retry")
		throw new Error("expected retry");
	time.set(foreignSettle.nextEligibleAt!);

	const completed = await adapter.settle({
		target: targetA,
		outcome: { kind: "success" },
	});
	assert.equal(completed.kind, "settled");
});

test("R3-025 claim and retry keep cooldown state across attempts", async () => {
	const time = clock(18_500_000);
	const adapter = createMemorySharedState({ now: time.now });

	await adapter.updateSettings(targetA, { maxRetries: 1 });
	const retry = await automaticFailure(adapter);
	assert.equal(retry.kind, "settled");
	if (retry.kind !== "settled" || retry.action !== "retry")
		throw new Error("expected retry");
	assert.equal(retry.runtime.consecutiveFailures, 1);
	time.set(retry.nextEligibleAt!);
	time.set(retry.nextEligibleAt! + 1);
	const cooldown = await automaticFailure(adapter);
	assert.equal(cooldown.kind, "settled");
	if (cooldown.kind !== "settled" || cooldown.action !== "cooldown")
		throw new Error("expected cooldown");
	assert.equal(cooldown.runtime.cumulativeCooldownMs, 600_000);
	assert.equal(cooldown.runtime.cooldownLevel, 1);
	time.set(cooldown.cooldownUntil!);
	const eligible = await claim(adapter);
	assert.equal(eligible.kind, "claimed");
});

test("R3-018 claim skips an unknown target after its last registration is deleted", async () => {
	const adapter = createMemorySharedState({
		now: () => 19_000_000,
	});
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/stale-registration-r3",
		targets: [targetA],
	});
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/stale-registration-r3",
		targets: [],
	});
	const before = await snapshotDocument(adapter);
	const staleClaim = await adapter.claim({
		target: targetA,
		effectiveRequestTimeoutMs: 0,
	});
	assert.equal(staleClaim.kind, "skipped");
	if (staleClaim.kind !== "skipped") throw new Error("expected unknown target");
	assert.equal(staleClaim.skipReason, "unknown-target");
	assert.equal(staleClaim.runtime, null);
	assert.deepEqual(await snapshotDocument(adapter), before);
	assert.equal(Object.hasOwn(before.targets, "openai/model/a"), false);
});

test("R3-019 claim and settlement results carry committed runtime snapshots", async () => {
	const time = clock(20_000_000);
	const adapter = createMemorySharedState({
		now: time.now,
	});
	await adapter.updateSettings(targetA, { maxRetries: 5 });
	const beforeClaim = await snapshotDocument(adapter);
	const active = await claim(adapter);
	const afterClaim = await snapshotDocument(adapter);
	assert.equal(afterClaim.revision, beforeClaim.revision + 1);
	assert.deepEqual(active.runtime, afterClaim.targets["openai/model/a"].runtime);

	const secondClaim = await adapter.claim({
		target: targetA,
		effectiveRequestTimeoutMs: 0,
	});
	assert.equal(secondClaim.kind, "claimed");
	const afterSecondClaim = await snapshotDocument(adapter);
	assert.equal(afterSecondClaim.revision, afterClaim.revision + 1);

	const retry = await automaticFailure(adapter);
	assert.equal(retry.kind, "settled");
	if (retry.kind !== "settled" || retry.action !== "retry")
		throw new Error("expected runtime retry");
	const afterRetry = await snapshotDocument(adapter);
	assert.equal(afterRetry.revision, afterSecondClaim.revision + 1);
	assert.deepEqual(retry.runtime, afterRetry.targets["openai/model/a"].runtime);

	const unknown = await adapter.settle({
		target: targetC,
		outcome: { kind: "success" },
	});
	assert.equal(unknown.kind, "stale");
	if (unknown.kind === "stale") assert.deepEqual(unknown.runtime, null);
});

test("R3-020 undefined later manual reasons do not conflict with the first defined reason", async () => {
	const warnings: string[] = [];
	const adapter = createMemorySharedState({
		now: () => 21_000_000,
		warn: (message) => warnings.push(message),
	});
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/manual-warning-r3",
		targets: [targetA],
		legacyCandidates: [
			legacyCandidate(targetA, settings(), "defined", "HTTP 401"),
			legacyCandidate(targetA, settings(), "undefined"),
		],
	});
	assert.deepEqual(warnings, []);
	assert.equal(
		(await snapshotDocument(adapter)).targets["openai/model/a"].runtime
			.manualRecovery?.reason,
		"HTTP 401",
	);
});

test("R3-021 model unavailable remains an actionable persistent reason", async () => {
	const adapter = createMemorySharedState({
		now: () => 22_000_000,
	});
	await adapter.updateSettings(targetA, {});
	const settled = await adapter.settle({
		target: targetA,
		outcome: {
			kind: "persistent-failure",
			reason: "provider says model is unavailable; private detail",
		},
	});
	assert.equal(settled.kind, "settled");
	if (settled.kind !== "settled" || settled.action !== "manual-recovery")
		throw new Error("expected manual recovery");
	assert.equal(settled.manualRecovery.reason, "model unavailable");
	assert.equal(settled.runtime.lastFailureReason, "model unavailable");
	const persisted = await snapshotDocument(adapter);
	const reloaded = createMemorySharedState({ document: persisted });
	assert.equal(
		(await snapshotDocument(reloaded)).targets["openai/model/a"].runtime
			.manualRecovery?.reason,
		"model unavailable",
	);
});

test("R3-022 max-safe revisions are rejected and file mutations leave the safe snapshot unchanged", async () => {
	await withTempState(async (path) => {
		const exhausted = {
			...emptyDocument(),
			revision: Number.MAX_SAFE_INTEGER,
		};
		const bytes = JSON.stringify(exhausted);
		await writeBytes(path, bytes);
		const adapter = createFileSharedState({ path, now: () => 23_000_000 });
		const snapshot = await adapter.snapshot();
		assert.equal(snapshot.status.coordination, "degraded");
		if (snapshot.status.coordination === "degraded")
			assert.equal(snapshot.status.reason, "invalid");
		const rejected = await adapter.updateSettings(targetA, { maxRetries: 2 });
		assertCoordinationFailure(rejected, "invalid");
		assert.equal(await readFile(path, "utf8"), bytes);
		assert.deepEqual(await snapshotDocument(adapter), snapshot.document);
		assert.throws(
			() => createMemorySharedState({ document: exhausted }),
			/invalid document/,
		);
	});
});

test("R3-023 settings patches are cloned before queued mutation", async () => {
	const adapter = createMemorySharedState({ now: () => 24_000_000 });
	const patch: SharedTargetSettingsPatch = {
		maxRetries: 2,
		modelParameters: { promptCacheKey: false },
	};
	const pending = adapter.updateSettings(targetA, patch);
	patch.maxRetries = 9;
	patch.modelParameters!.promptCacheKey = true;
	const result = await pending;
	assert.equal(result.kind, "updated");
	if (result.kind !== "updated") throw new Error("expected settings update");
	assert.equal(result.settings.maxRetries, 2);
	assert.equal(result.settings.modelParameters.promptCacheKey, false);
	const persisted = (await snapshotDocument(adapter)).targets["openai/model/a"]
		.settings;
	assert.equal(persisted.maxRetries, 2);
	assert.equal(persisted.modelParameters.promptCacheKey, false);
});

test("reset succeeds while a target is actively in use", async () => {
	const adapter = createMemorySharedState({ now: () => 26_000_000 });
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/active-registration-r1",
		targets: [targetA],
	});
	const active = await claim(adapter);
	assert.equal("lease" in active.runtime, false);
	const reset = await adapter.resetTargets([targetA]);
	assert.equal(reset.kind, "reset");
	const document = await snapshotDocument(adapter);
	assert.equal(document.targets["openai/model/a"].runtime.consecutiveFailures, 0);
	assert.equal(document.targets["openai/model/a"].runtime.nextEligibleAt, null);
});
test("chain scopes seed the first target policy and resolve inheritable overrides", async () => {
	const time = clock(18_000_000);
	const adapter = createMemorySharedState({ now: time.now });
	const first = settings({
		errorHandlingMode: "switch",
		maxRetries: 7,
		noProgressTimeoutSeconds: 120,
		reasoningEffort: "high",
		modelParameters: {
			promptCacheKey: false,
			promptCacheRetention: true,
			reasoningEffort: true,
			sessionAffinity: false,
		},
	});
	const second = settings({
		errorHandlingMode: "retry",
		maxRetries: 1,
		noProgressTimeoutSeconds: 30,
		reasoningEffort: "low",
		modelParameters: {
			promptCacheKey: true,
			promptCacheRetention: true,
			reasoningEffort: true,
			sessionAffinity: true,
		},
	});
	const reconciled = await adapter.reconcileRegistration({
		agentDirectory: "/tmp/scoped-chain",
		targets: [targetA, targetB],
		legacyCandidates: [
			legacyCandidate(targetA, first, "first"),
			legacyCandidate(targetB, second, "second"),
		],
		scopes: [{ key: "chain-a", targets: [targetA, targetB] }],
	});
	assert.equal(reconciled.kind, "reconciled");
	let document = await snapshotDocument(adapter);
	const scope = document.scopes["chain-a"];
	assert.ok(scope);
	if (!scope) throw new Error("expected chain scope");
	assert.deepEqual(scope.settings, {
		errorHandlingMode: "switch",
		maxRetries: 7,
		noProgressTimeoutSeconds: 120,
		reasoningEffort: "high",
		modelParameters: {
			promptCacheKey: false,
			promptCacheRetention: true,
			reasoningEffort: true,
			sessionAffinity: false,
		},
	});
	for (const override of Object.values(scope.overrides)) {
		assert.deepEqual(override, {
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
		});
	}
	const inherited = claimed(
		await adapter.claim({
			target: targetB,
			effectiveRequestTimeoutMs: 0,
			scopeKey: "chain-a",
		}),
	);
	assert.equal(inherited.settings.errorHandlingMode, "switch");
	assert.equal(inherited.settings.maxRetries, 7);
	assert.equal(inherited.settings.noProgressTimeoutSeconds, 120);
	assert.equal(inherited.settings.reasoningEffort, "high");
	assert.equal(inherited.settings.modelParameters.promptCacheKey, false);
	assert.equal(inherited.settings.modelParameters.sessionAffinity, false);
	await adapter.settle({
		target: targetB,
		outcome: { kind: "success" },
		scopeKey: "chain-a",
	});
	if (!adapter.updateScopeSettings || !adapter.updateTargetOverride)
		throw new Error("expected scope update operations");
	const updatedScope = await adapter.updateScopeSettings("chain-a", {
		maxRetries: 2,
	});
	assert.equal(updatedScope.kind, "updated");
	const updatedOverride = await adapter.updateTargetOverride(
		"chain-a",
		targetB,
		{
			reasoningEffort: "max",
			modelParameters: { promptCacheKey: true },
		},
	);
	assert.equal(updatedOverride.kind, "updated");
	const overridden = claimed(
		await adapter.claim({
			target: targetB,
			effectiveRequestTimeoutMs: 0,
			scopeKey: "chain-a",
		}),
	);
	assert.equal(overridden.settings.maxRetries, 2);
	assert.equal(overridden.settings.reasoningEffort, "max");
	assert.equal(overridden.settings.modelParameters.promptCacheKey, true);
	assert.equal(overridden.settings.modelParameters.sessionAffinity, false);
	await adapter.settle({
		target: targetB,
		outcome: { kind: "success" },
		scopeKey: "chain-a",
	});
	await adapter.reconcileRegistration({
		agentDirectory: "/tmp/scoped-chain",
		targets: [],
		scopes: [],
	});
	document = await snapshotDocument(adapter);
	assert.deepEqual(document.scopes, {});
	assert.deepEqual(document.targets, {});
});
