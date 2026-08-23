import type {
	FailureClassification,
	FailureInput,
	FailureKind,
	ModelRef,
	RequestState,
} from "./types.ts";
import { modelKey } from "./types.ts";

const PERSISTENT_ERROR =
	/\b(balance|quota|usage|billing|credit|insufficient (?:funds|quota|balance)|payment required|spending limit)\b/i;
const NETWORK_ERROR =
	/\b(network|fetch failed|econnreset|econnrefused|enotfound|etimedout|timeout|timed out|socket|connection|dns|stream read error|provider api error|upstream error)\b/i;
const API_ERROR_STATUS = /\b(?:HTTP|API)\s+error\s*\((\d{3})\)/i;

function statusFromMessage(message: string): number | undefined {
	const match = message.match(API_ERROR_STATUS);
	return match ? Number(match[1]) : undefined;
}

function persistentStatusFailure(
	status: number | undefined,
): FailureClassification | undefined {
	if (status === 401 || status === 403)
		return { kind: "persistent", reason: `HTTP ${status}` };
	if (status === 404) return { kind: "persistent", reason: "HTTP 404" };
	return undefined;
}

function cooldownStatusFailure(
	status: number | undefined,
): FailureClassification | undefined {
	if (status === 429) return { kind: "cooldown", reason: "HTTP 429" };
	if (status !== undefined && status >= 500 && status <= 599)
		return { kind: "cooldown", reason: `HTTP ${status}` };
	return undefined;
}

function providerCategoryFailure(
	input: FailureInput,
): FailureClassification | undefined {
	if (input.providerErrorCategory === "provider_auth_error")
		return {
			kind: "persistent",
			reason: input.message ?? "provider auth failure",
		};
	if (input.providerErrorCategory === "provider_rate_limit")
		return {
			kind: "cooldown",
			reason: input.message ?? "provider rate limit",
		};
	if (input.providerErrorCategory === "provider_network_error")
		return { kind: "cooldown", reason: "network failure" };
	return undefined;
}

export function classifyFailure(input: FailureInput): FailureClassification {
	if (input.toolError)
		return { kind: "tool-failure", reason: "tool execution failure" };
	if (input.timedOut)
		return { kind: "no-progress", reason: "no-progress timeout" };
	if (input.stopReason === "aborted")
		return { kind: "cancelled", reason: "user cancellation" };

	const message = (input.message ?? "").replace(/[_-]+/g, " ");
	const status = input.status ?? statusFromMessage(message);
	const persistentStatus = persistentStatusFailure(status);
	if (persistentStatus) return persistentStatus;
	const cooldownStatus = cooldownStatusFailure(status);
	if (cooldownStatus) return cooldownStatus;
	const categoryFailure = providerCategoryFailure(input);
	if (categoryFailure) return categoryFailure;
	if (PERSISTENT_ERROR.test(message))
		return { kind: "persistent", reason: "balance/quota/usage failure" };
	if (NETWORK_ERROR.test(message))
		return { kind: "cooldown", reason: "network failure" };
	if (input.stopReason === "error" || message.length > 0)
		return { kind: "unknown", reason: "unknown provider error" };
	return { kind: "none", reason: "" };
}

export function createRequestState(
	id: number,
	activeModel?: ModelRef,
): RequestState {
	const request: RequestState = {
		id,
		attempted: new Set<string>(),
		reasons: new Map<string, string>(),
		sameModelRetries: 0,
		activeModel: activeModel ? { ...activeModel } : undefined,
		completed: false,
	};
	if (activeModel) request.attempted.add(modelKey(activeModel));
	return request;
}

export function markAttempt(
	request: RequestState,
	model: ModelRef,
	reason?: string,
): boolean {
	const key = modelKey(model);
	if (request.attempted.has(key)) return false;
	request.attempted.add(key);
	request.activeModel = { ...model };
	if (reason) request.reasons.set(key, reason);
	return true;
}

export function recordFailure(
	request: RequestState,
	model: ModelRef | undefined,
	reason: string,
): void {
	if (model) request.reasons.set(modelKey(model), reason);
}

export function nextUnattemptedModel(
	models: readonly ModelRef[],
	attempted: ReadonlySet<string>,
	cooldowns: ReadonlyMap<string, number>,
	now: number,
): ModelRef | undefined {
	for (const model of models) {
		const key = modelKey(model);
		if (attempted.has(key)) continue;
		const cooldownUntil = cooldowns.get(key);
		if (cooldownUntil !== undefined && cooldownUntil > now) continue;
		return { ...model };
	}
	return undefined;
}

export function requestSummary(
	request: RequestState,
	models: readonly ModelRef[],
): string {
	const labels: string[] = [];
	for (const model of models) {
		const key = modelKey(model);
		if (!request.attempted.has(key)) continue;
		const reason = request.reasons.get(key);
		labels.push(reason ? `${key} (${reason})` : key);
	}
	for (const key of request.attempted) {
		if (models.some((model) => modelKey(model) === key)) continue;
		const reason = request.reasons.get(key);
		labels.push(reason ? `${key} (${reason})` : key);
	}
	return labels.join(" -> ");
}

export function isAutomaticFailure(kind: FailureKind): boolean {
	return (
		kind === "persistent" ||
		kind === "cooldown" ||
		kind === "unknown" ||
		kind === "no-progress"
	);
}

export function shouldRetryCurrentModel(
	kind: FailureKind,
	mode: "smart" | "switch" | "retry",
): boolean {
	if (!isAutomaticFailure(kind)) return false;
	if (mode === "switch") return false;
	if (mode === "retry") return true;
	return kind !== "persistent";
}

export const COOLDOWN_LADDER_MINUTES = [10, 20, 40, 60, 90, 180, 360] as const;

export function cooldownMinutesForLevel(level: number): number {
	const maxLevel = COOLDOWN_LADDER_MINUTES.length - 1;
	const index =
		Number.isInteger(level) && level >= 0 ? Math.min(level, maxLevel) : maxLevel;
	return COOLDOWN_LADDER_MINUTES[index];
}

export function nextCooldownLevel(level: number): number {
	return Math.min(level + 1, COOLDOWN_LADDER_MINUTES.length - 1);
}

const EXTENSION_RETRY_BASE_DELAY_MS = 1000;
const EXTENSION_RETRY_MAX_DELAY_MS = 60_000;

/** Delay before the retry at retryIndex (0 = first retry after the initial attempt). */
export function retryDelayMs(retryIndex: number): number {
	if (retryIndex <= 0) return EXTENSION_RETRY_BASE_DELAY_MS;
	return Math.min(
		EXTENSION_RETRY_BASE_DELAY_MS * 2 ** retryIndex,
		EXTENSION_RETRY_MAX_DELAY_MS,
	);
}

/** Worst-case wait for all maxRetries retries of one target. */
export function estimatedRetryDurationMs(maxRetries: number): number {
	let total = 0;
	for (let retryIndex = 0; retryIndex < maxRetries; retryIndex++) {
		total += retryDelayMs(retryIndex);
	}
	return total;
}
