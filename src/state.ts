import type {
	AutomationMode,
	FailureClassification,
	FailureInput,
	FailureKind,
	ModelRef,
	ProgressAttemptKind,
	RequestState,
} from "./types.ts";
import { modelKey } from "./types.ts";

const PERSISTENT_ERROR =
	/\b(balance|quota|usage|billing|credit|insufficient (?:funds|quota|balance)|payment required|spending limit)\b/i;
const NETWORK_ERROR =
	/\b(network|fetch failed|econnreset|econnrefused|enotfound|etimedout|timeout|timed out|socket|connection|dns)\b/i;

export function canArmProgressTimer(
	mode: AutomationMode,
	phase:
		| "ready"
		| "requesting"
		| "settled"
		| "switching"
		| "succeeded"
		| "cancelled"
		| "exhausted",
	attemptKind: ProgressAttemptKind,
	hasRequest: boolean,
): boolean {
	return (
		hasRequest &&
		mode === "enabled" &&
		phase === "requesting" &&
		attemptKind !== "native-retry"
	);
}

export function classifyFailure(input: FailureInput): FailureClassification {
	if (input.toolError)
		return { kind: "tool-failure", reason: "tool execution failure" };
	if (input.timedOut)
		return { kind: "no-progress", reason: "no-progress timeout" };
	if (input.stopReason === "aborted") {
		return { kind: "cancelled", reason: "user cancellation" };
	}

	const message = (input.message ?? "").replace(/[_-]+/g, " ");
	if (input.status === 401 || input.status === 403) {
		return { kind: "persistent", reason: `HTTP ${input.status}` };
	}
	if (input.status === 404) return { kind: "persistent", reason: "HTTP 404" };
	if (PERSISTENT_ERROR.test(message)) {
		return { kind: "persistent", reason: "balance/quota/usage failure" };
	}
	if (input.status === 429) return { kind: "cooldown", reason: "HTTP 429" };
	if (input.status !== undefined && input.status >= 500 && input.status <= 599) {
		return { kind: "cooldown", reason: `HTTP ${input.status}` };
	}
	if (NETWORK_ERROR.test(message))
		return { kind: "cooldown", reason: "network failure" };
	if (input.stopReason === "error" || message.length > 0) {
		return { kind: "unknown", reason: "unknown provider error" };
	}
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
		sameModelContinuationUsed: false,
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
