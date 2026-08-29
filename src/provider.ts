import type {
	GeneratedFailoverModel,
	GeneratedFailoverModelV8,
	ModelParameterToggles,
	ModelRef,
	ReasoningEffort,
} from "./types.ts";
import { DEFAULT_PARAMETER_TOGGLES, modelKey } from "./types.ts";
import {
	classifyFailure,
	cooldownMinutesForLevel,
	createRequestState,
	isAutomaticFailure,
	markAttempt,
	nextCooldownLevel,
	nextUnattemptedModel,
	recordFailure,
	requestSummary,
	retryDelayMs,
	shouldRetryCurrentModel,
} from "./state.ts";
import {
	type CacheField,
	type TargetCompatLike,
	applyRequestParameters,
	isOpenAIRequestApi,
	promptCacheKeyFromSessionId,
	rejectedCacheFields,
	replaceSessionAffinityHeaders,
} from "./request-params.ts";
import {
	FAILOVER_PROVIDER_ID,
	buildFailoverCatalogModel,
	type TargetCatalogMetadata,
} from "./models-catalog.ts";
import type {
	ClaimResult,
	SettleResult,
	SharedStateAdapter,
	SharedTargetSettings,
} from "./shared-state.ts";

const FAILOVER_MODEL_API = "openai-responses";
const FAILOVER_BASE_URL = "https://failover.invalid/v1";

/** Minimal structural view of a Pi target model (runtime boundary cast). */
export interface TargetModelLike {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ReasoningEffort, string | null>>;
	compat?: TargetCompatLike;
}

/** Minimal structural view of a Pi AssistantMessage (runtime boundary cast). */
export interface AssistantMessageLike {
	role: string;
	content: unknown[];
	api: string;
	provider: string;
	model: string;
	usage?: unknown;
	stopReason: string;
	errorMessage?: string;
	status?: number;
	providerErrorCategory?: string;
	diagnostics?: unknown[];
	timestamp: number;
}

export interface RequestOptions {
	signal?: AbortSignal;
	sessionId?: string;
	cacheRetention?: "none" | "short" | "long";
	reasoning?: string;
	headers?: Record<string, string | null>;
	maxRetries?: number;
	timeoutMs?: number;
	onPayload?: (
		payload: unknown,
		model?: unknown,
	) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (
		response: { status: number; headers: Record<string, string> },
		model?: unknown,
	) => void | Promise<void>;
	transformHeaders?: (
		headers: Record<string, string | null>,
	) => Record<string, string | null> | Promise<Record<string, string | null>>;
	[key: string]: unknown;
}

export interface RequestContext {
	systemPrompt?: string;
	messages?: unknown[];
	tools?: unknown[];
}

export interface Delegate {
	resolveModel(target: ModelRef): TargetModelLike | undefined;
	complete(
		model: TargetModelLike,
		context: RequestContext,
		options: RequestOptions,
	): Promise<AssistantMessageLike>;
	stream?(
		model: TargetModelLike,
		context: RequestContext,
		options: RequestOptions,
	): AssistantMessageEventStreamLike;
}

/** Chain-only model data used by shared routing and native model discovery. */
export type FailoverChainModel = Pick<
	GeneratedFailoverModelV8,
	"id" | "name" | "enabled" | "chain"
> & {
	scopeKey?: string;
};

/** The real target and effective thinking level used for one request attempt. */
interface FailoverTargetStatus {
	modelId: string;
	target: ModelRef;
	effort: ReasoningEffort;
	/** Whether this target receives the extension's reasoning value. */
	reasoningControlled: boolean;
	/** Target API thinking value; undefined means the target does not support reasoning. */
	mappedEffort?: string;
}

/** A switch from one failed chain target to the next. */
interface FailoverTransition extends FailoverTargetStatus {
	source?: ModelRef;
	reason: string;
}

export interface FailoverProviderState {
	config: { models: FailoverChainModel[] };
	metadata: readonly TargetCatalogMetadata[];
	delegate: Delegate;
	/** Target keys known to be authenticated; empty means "not yet determined". */
	availableTargetKeys: ReadonlySet<string>;
	/** Whether the registry has supplied an authoritative availability snapshot. */
	availabilityKnown: boolean;
	cooldowns: Map<string, number>;
	/** Next cooldown ladder rung by generated-model target key; absent means rung 0. */
	cooldownLevels: Map<string, number>;
	manualRecovery: Map<string, string>;
	unsupportedCacheFields: Map<string, Set<CacheField>>;
	/** Optional shared coordinator; absent means the legacy v7 policy owns runtime state. */
	sharedState?: SharedStateAdapter;
	/** Optional callback invoked when the router starts using a real target. */
	onTarget?: (target: FailoverTargetStatus) => void;
	/** Optional callback invoked when the router switches chain targets. */
	onTransition?: (transition: FailoverTransition) => void;
	onManualRecovery?: (key: string, reason: string) => void;
}

export interface AssistantMessageEventStreamLike {
	[Symbol.asyncIterator](): AsyncIterator<unknown>;
	result(): Promise<unknown>;
}

type StreamEvent =
	| {
			type: "start";
			partial: AssistantMessageLike;
	  }
	| {
			type: "done";
			reason: string;
			message: AssistantMessageLike;
	  }
	| {
			type: "error";
			reason: "error" | "aborted";
			error: AssistantMessageLike;
	  };

function createBufferedStream(
	run: (
		emit: (event: StreamEvent) => void,
		end: (result: unknown) => void,
	) => void | Promise<void>,
): AssistantMessageEventStreamLike {
	let ended = false;
	let resolveResult!: (value: unknown) => void;
	const resultPromise = new Promise<unknown>((resolve) => {
		resolveResult = resolve;
	});
	const queue: StreamEvent[] = [];
	const waiters: Array<() => void> = [];
	const notify = () => {
		for (const wake of waiters.splice(0)) wake();
	};
	const emit = (event: StreamEvent) => {
		queue.push(event);
		notify();
	};
	const end = (result: unknown) => {
		if (ended) return;
		ended = true;
		resolveResult(result);
		notify();
	};
	void (async () => {
		try {
			await run(emit, end);
		} catch (error) {
			const message = errorMessage(error);
			emit({ type: "error", reason: "error", error: message });
			end(message);
		}
	})();
	const iterator: AsyncIterator<unknown> = {
		next: async (): Promise<IteratorResult<unknown>> => {
			for (;;) {
				const next = queue.shift();
				if (next !== undefined) return { value: next, done: false };
				if (ended) return { value: undefined, done: true };
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
		},
	};
	return {
		[Symbol.asyncIterator]: () => iterator,
		result: () => resultPromise,
	};
}

const MAX_EXTERNAL_ERROR_CATEGORY_LENGTH = 128;
const MAX_EXTERNAL_ERROR_MESSAGE_LENGTH = 4096;
const MAX_PROVIDER_STATUS_REASON_LENGTH = 256;
const REDACTED_PROVIDER_TEXT = "[REDACTED]";
const SHARED_ATTEMPT_TIMEOUT_FLOOR_MS = 30_000;
const MAX_TRANSIENT_SHARED_CLAIM_RETRIES = 1;

interface NormalizedProviderError {
	message: string;
	status?: number;
	providerErrorCategory?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function sanitizeProviderText(value: string): string {
	let text = value.replace(
		/(\b(?:proxy[-_])?authorization\b[ \t]*:[ \t]*)(?:[^\r\n;]+)(\r\n|[\r\n;]|$)/gi,
		(_match, prefix: string, delimiter: string) => {
			const boundary =
				delimiter === ";" || delimiter === "" ? delimiter : `;${delimiter}`;
			return `${prefix}${REDACTED_PROVIDER_TEXT}${boundary}`;
		},
	);
	text = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
	text = text.replace(
		/\bBearer\s+["']?[^\s,;"']+["']?/gi,
		`Bearer ${REDACTED_PROVIDER_TEXT}`,
	);
	text = text.replace(
		/(["']?)(proxy[_-]?authorization|authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|query[_-]?secret|token|secret)\1(\s*[:=]\s*)(["'])(.*?)\4/gi,
		(
			_match,
			keyQuote: string,
			key: string,
			separator: string,
			valueQuote: string,
		) =>
			`${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED_PROVIDER_TEXT}${valueQuote}`,
	);
	text = text.replace(
		/(["']?)(proxy[_-]?authorization|authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|query[_-]?secret|token|secret)\1(\s*[:=]\s*)([^\s&#,;"']+)/gi,
		(_match, keyQuote: string, key: string, separator: string) =>
			`${keyQuote}${key}${keyQuote}${separator}${REDACTED_PROVIDER_TEXT}`,
	);
	text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, REDACTED_PROVIDER_TEXT);
	text = text.replace(
		/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
		REDACTED_PROVIDER_TEXT,
	);
	text = text.replace(
		/(^|[^A-Za-z0-9_+./=-])([A-Za-z0-9][A-Za-z0-9_+./=-]{31,})(?=$|[^A-Za-z0-9_+./=-])/g,
		(_match, prefix: string) => `${prefix}${REDACTED_PROVIDER_TEXT}`,
	);
	return text;
}

function boundedProviderText(
	value: unknown,
	maxLength: number,
): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const sample = value.slice(0, maxLength + 1_024);
	return boundedString(sanitizeProviderText(sample), maxLength);
}

function invokeProviderHookSafely<TArgs extends unknown[]>(
	callback: ((...args: TArgs) => void) | undefined,
	...args: TArgs
): void {
	try {
		callback?.(...args);
	} catch {
		// UI/status hooks must not affect routing or shared state.
	}
}

function numericStatus(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 100 &&
		value <= 599
		? value
		: undefined;
}

function fallbackErrorMessage(error: unknown): string {
	if (error instanceof Error && typeof error.message === "string")
		return error.message;
	try {
		return String(error);
	} catch {
		return "Unknown provider error";
	}
}

function normalizeProviderError(error: unknown): NormalizedProviderError {
	const record = isRecord(error) ? error : undefined;
	const metadata =
		record && isRecord(record.error_metadata) ? record.error_metadata : undefined;
	const details =
		metadata && isRecord(metadata.details) ? metadata.details : undefined;
	const providerErrorCategory = boundedProviderText(
		metadata?.category,
		MAX_EXTERNAL_ERROR_CATEGORY_LENGTH,
	);
	const metadataMessage = boundedProviderText(
		metadata?.message,
		MAX_EXTERNAL_ERROR_MESSAGE_LENGTH,
	);
	const message =
		metadataMessage ??
		boundedProviderText(
			fallbackErrorMessage(error),
			MAX_EXTERNAL_ERROR_MESSAGE_LENGTH,
		) ??
		"Unknown provider error";
	return {
		message,
		status:
			numericStatus(metadata?.status) ??
			numericStatus(record?.status) ??
			numericStatus(details?.status),
		...(providerErrorCategory ? { providerErrorCategory } : {}),
	};
}

function buildErrorMessage(
	message: string,
	metadata?: Pick<NormalizedProviderError, "status" | "providerErrorCategory">,
): AssistantMessageLike {
	const safeMessage =
		boundedProviderText(message, MAX_EXTERNAL_ERROR_MESSAGE_LENGTH) ??
		"Unknown provider error";
	const safeCategory = boundedProviderText(
		metadata?.providerErrorCategory,
		MAX_EXTERNAL_ERROR_CATEGORY_LENGTH,
	);
	return {
		role: "assistant",
		content: [],
		api: FAILOVER_MODEL_API,
		provider: FAILOVER_PROVIDER_ID,
		model: "failover",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: safeMessage,
		...(metadata?.status === undefined ? {} : { status: metadata.status }),
		...(safeCategory ? { providerErrorCategory: safeCategory } : {}),
		timestamp: Date.now(),
	};
}

function errorMessage(error: unknown): AssistantMessageLike {
	const normalized = normalizeProviderError(error);
	return buildErrorMessage(normalized.message, normalized);
}

function sanitizeAssistantMessage(
	message: AssistantMessageLike,
): AssistantMessageLike {
	const {
		errorMessage: rawErrorMessage,
		providerErrorCategory: rawCategory,
		...rest
	} = message;
	const safeErrorMessage = boundedProviderText(
		rawErrorMessage,
		MAX_EXTERNAL_ERROR_MESSAGE_LENGTH,
	);
	const safeCategory = boundedProviderText(
		rawCategory,
		MAX_EXTERNAL_ERROR_CATEGORY_LENGTH,
	);
	return {
		...rest,
		...(rawErrorMessage === undefined
			? {}
			: { errorMessage: safeErrorMessage ?? "Unknown provider error" }),
		...(safeCategory ? { providerErrorCategory: safeCategory } : {}),
	};
}

function genKey(generatedId: string, target: ModelRef): string {
	return `${generatedId}:${modelKey(target)}`;
}

function mergeToggles(
	base: ModelParameterToggles,
	override?: ModelParameterToggles,
): ModelParameterToggles {
	return override
		? { ...DEFAULT_PARAMETER_TOGGLES, ...base, ...override }
		: base;
}

/** Map an extension reasoning level through a target's thinkingLevelMap. */
function mappedReasoning(
	targetModel: TargetModelLike | undefined,
	effort: ReasoningEffort,
): string | undefined {
	if (!targetModel?.reasoning) return undefined;
	const mapped = targetModel.thinkingLevelMap?.[effort];
	if (mapped === null) return undefined;
	return mapped ?? (effort === "off" ? "none" : effort);
}

const EMPTY_UNSUPPORTED: ReadonlySet<CacheField> = new Set();

function negotiateDisabledFields(
	rejected: CacheField[],
	toggles: ModelParameterToggles,
): CacheField[] {
	return rejected.filter((field) => {
		if (field === "prompt_cache_key") return toggles.promptCacheKey;
		if (field === "prompt_cache_retention") return toggles.promptCacheRetention;
		return false;
	});
}

class NoProgressTimeoutError extends Error {
	constructor() {
		super("No progress timeout");
		this.name = "NoProgressTimeoutError";
	}
}

class RequestCancelledError extends Error {
	constructor() {
		super("Request cancelled");
		this.name = "RequestCancelledError";
	}
}

async function executeTarget(
	delegate: Delegate,
	model: TargetModelLike,
	context: RequestContext,
	options: RequestOptions,
	timeoutMs: number | undefined,
	outerSignal: AbortSignal | undefined,
	attemptTimeoutMs?: number,
): Promise<{
	result: AssistantMessageLike;
	timedOut: boolean;
	status?: number;
	providerErrorCategory?: string;
}> {
	const controller = new AbortController();
	let progressTimer: ReturnType<typeof setTimeout> | undefined;
	let attemptTimer: ReturnType<typeof setTimeout> | undefined;
	let timeoutReject!: (error: unknown) => void;
	let abortReject!: (error: unknown) => void;
	let timedOut = false;
	let outerAborted = outerSignal?.aborted ?? false;
	const timeout = new Promise<never>((_, reject) => {
		timeoutReject = reject;
	});
	const aborted = new Promise<never>((_, reject) => {
		abortReject = reject;
	});
	const onAbort = () => {
		outerAborted = true;
		controller.abort();
		abortReject(new RequestCancelledError());
	};
	if (outerSignal) {
		if (outerSignal.aborted) onAbort();
		else outerSignal.addEventListener("abort", onAbort, { once: true });
	}
	const expireAttempt = () => {
		if (timedOut) return;
		timedOut = true;
		controller.abort();
		timeoutReject(new NoProgressTimeoutError());
	};
	const resetTimer = () => {
		if (timeoutMs === undefined || timedOut) return;
		if (progressTimer !== undefined) clearTimeout(progressTimer);
		progressTimer = setTimeout(expireAttempt, timeoutMs);
	};
	const attemptOptions: RequestOptions = {
		...options,
		signal: controller.signal,
	};
	try {
		resetTimer();
		if (attemptTimeoutMs !== undefined)
			attemptTimer = setTimeout(expireAttempt, attemptTimeoutMs);
		const work = delegate.stream
			? (async () => {
					const stream = delegate.stream!(model, context, attemptOptions);
					for await (const _event of stream) resetTimer();
					return (await stream.result()) as AssistantMessageLike;
				})()
			: delegate.complete(model, context, attemptOptions);
		// Keep consuming a timed-out stream in the background so its rejection is handled.
		void work.catch(() => undefined);
		const result = sanitizeAssistantMessage(
			await Promise.race([work, timeout, aborted]),
		);
		return { result, timedOut: false };
	} catch (error) {
		const normalized = normalizeProviderError(error);
		if (timedOut)
			return {
				result: buildErrorMessage(normalized.message, normalized),
				timedOut: true,
				status: normalized.status,
				providerErrorCategory: normalized.providerErrorCategory,
			};
		// Auth, transport, and delegate throws become classifiable failures so the
		// chain can advance; only a real cancellation stops it.
		const failed = buildErrorMessage(normalized.message, normalized);
		if (outerAborted) failed.stopReason = "aborted";
		return {
			result: failed,
			timedOut: false,
			status: normalized.status,
			providerErrorCategory: normalized.providerErrorCategory,
		};
	} finally {
		if (progressTimer !== undefined) clearTimeout(progressTimer);
		if (attemptTimer !== undefined) clearTimeout(attemptTimer);
		if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
	}
}

interface TargetSelection extends FailoverTargetStatus {
	targetModel: TargetModelLike;
	targetKey: string;
	capabilityKey: string;
	toggles: ModelParameterToggles;
}

interface TargetAttempt {
	targetModel: TargetModelLike;
	targetKey: string;
	capabilityKey: string;
	toggles: ModelParameterToggles;
	status: number | undefined;
	result: AssistantMessageLike;
	failure: ReturnType<typeof classifyFailure>;
}

function resolveTargetSelection(
	generated: GeneratedFailoverModel,
	target: ModelRef,
	state: FailoverProviderState,
): TargetSelection | undefined {
	const targetModel = state.delegate.resolveModel(target);
	if (!targetModel) return undefined;
	const targetKey = modelKey(target);
	const override = generated.targetOverrides[targetKey];
	const toggles = mergeToggles(
		generated.modelParameters,
		override?.modelParameters,
	);
	const effort = override?.reasoningEffort ?? generated.reasoningEffort;
	return {
		modelId: generated.id,
		target,
		effort,
		mappedEffort: toggles.reasoningEffort
			? mappedReasoning(targetModel, effort)
			: undefined,
		reasoningControlled: toggles.reasoningEffort,
		targetModel,
		targetKey,
		capabilityKey: `${generated.id}:${targetKey}:${targetModel.api}`,
		toggles,
	};
}

function resolveSharedTargetSelection(
	generated: FailoverChainModel,
	target: ModelRef,
	state: FailoverProviderState,
	settings: SharedTargetSettings,
	reasoningInherited: boolean,
): TargetSelection | undefined {
	const targetModel = state.delegate.resolveModel(target);
	if (!targetModel) return undefined;
	const targetKey = modelKey(target);
	const toggles = { ...DEFAULT_PARAMETER_TOGGLES, ...settings.modelParameters };
	const effort = settings.reasoningEffort;
	return {
		modelId: generated.id,
		target,
		effort,
		mappedEffort:
			toggles.reasoningEffort && !reasoningInherited
				? mappedReasoning(targetModel, effort)
				: undefined,
		reasoningControlled: toggles.reasoningEffort && !reasoningInherited,
		targetModel,
		targetKey,
		capabilityKey: `${targetKey}:${targetModel.api}`,
		toggles,
	};
}

function emitTargetTransition(
	state: FailoverProviderState,
	selection: TargetSelection,
	previousTarget: ModelRef | undefined,
	previousReason: string | undefined,
): void {
	if (!previousTarget || modelKey(previousTarget) === modelKey(selection.target))
		return;
	const reason =
		boundedProviderText(
			previousReason ?? "failure",
			MAX_PROVIDER_STATUS_REASON_LENGTH,
		) ?? "failure";
	invokeProviderHookSafely(state.onTransition, {
		modelId: selection.modelId,
		target: selection.target,
		effort: selection.effort,
		mappedEffort: selection.mappedEffort,
		reasoningControlled: selection.reasoningControlled,
		source: previousTarget,
		reason,
	});
}

async function executeTargetAttempt(
	context: RequestContext,
	options: RequestOptions,
	state: FailoverProviderState,
	cacheKey: string | undefined,
	signal: AbortSignal | undefined,
	selection: TargetSelection | undefined,
	timeoutSeconds: number,
	attemptTimeoutMs?: number,
): Promise<TargetAttempt | undefined> {
	if (!selection) return undefined;
	const {
		targetModel,
		targetKey,
		capabilityKey,
		toggles,
		effort,
		mappedEffort,
	} = selection;
	invokeProviderHookSafely(state.onTarget, {
		modelId: selection.modelId,
		target: selection.target,
		effort,
		mappedEffort,
		reasoningControlled: selection.reasoningControlled,
	});
	const unsupported =
		state.unsupportedCacheFields.get(capabilityKey) ?? EMPTY_UNSUPPORTED;
	const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
	let status: number | undefined;
	const {
		apiKey: _droppedApiKey,
		env: _droppedEnv,
		headers: _droppedHeaders,
		signal: _outerSignal,
		timeoutMs: _outerTimeoutMs,
		onPayload: outerOnPayload,
		onResponse: outerOnResponse,
		transformHeaders: _droppedTransformHeaders,
		...forward
	} = options;
	const headers: Record<string, string | null> = {};
	replaceSessionAffinityHeaders(headers, {
		api: targetModel.api,
		provider: targetModel.provider,
		baseUrl: targetModel.baseUrl,
		compat: targetModel.compat,
		toggles,
		cacheKey,
		cacheRetention: forward.cacheRetention,
	});
	const attemptOptions: RequestOptions = {
		...forward,
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		...(selection.reasoningControlled ? { reasoning: effort } : {}),
		onPayload: async (payload: unknown, model?: unknown) => {
			const hadRetention =
				isRecord(payload) && Object.hasOwn(payload, "prompt_cache_retention");
			const forwarded = await outerOnPayload?.(payload, model);
			const next = forwarded === undefined ? payload : forwarded;
			applyRequestParameters(next, {
				api: targetModel.api,
				provider: targetModel.provider,
				baseUrl: targetModel.baseUrl,
				toggles,
				cacheKey,
				unsupported,
				compat: targetModel.compat,
				cacheRetention: forward.cacheRetention,
				retentionRemovedByOuter:
					Boolean(outerOnPayload) &&
					hadRetention &&
					isRecord(next) &&
					!Object.hasOwn(next, "prompt_cache_retention"),
				reasoningEffort: mappedEffort,
			});
			return next;
		},
		onResponse: async (
			response: { status: number; headers: Record<string, string> },
			model?: unknown,
		) => {
			status = response.status;
			await outerOnResponse?.(response, model);
		},
		transformHeaders: async (headers: Record<string, string | null>) => {
			replaceSessionAffinityHeaders(headers, {
				api: targetModel.api,
				provider: targetModel.provider,
				baseUrl: targetModel.baseUrl,
				compat: targetModel.compat,
				toggles,
				cacheKey,
				cacheRetention: forward.cacheRetention,
			});
			return headers;
		},
	};
	void _droppedApiKey;
	void _droppedEnv;
	void _droppedHeaders;
	void _outerSignal;
	void _outerTimeoutMs;
	void _droppedTransformHeaders;
	const {
		result,
		timedOut,
		status: thrownStatus,
		providerErrorCategory,
	} = await executeTarget(
		state.delegate,
		targetModel,
		context,
		attemptOptions,
		timeoutMs,
		signal,
		attemptTimeoutMs,
	);
	status ??= thrownStatus ?? result.status;
	return {
		targetModel,
		targetKey,
		capabilityKey,
		toggles,
		status,
		result,
		failure: classifyFailure({
			status,
			message: result.errorMessage,
			providerErrorCategory: providerErrorCategory ?? result.providerErrorCategory,
			stopReason: result.stopReason,
			timedOut,
		}),
	};
}

function waitForExtensionRetry(
	retryIndex: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	const delayMs = retryDelayMs(retryIndex);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function applyAutomaticFailure(
	generated: GeneratedFailoverModel,
	state: FailoverProviderState,
	request: ReturnType<typeof createRequestState>,
	target: ModelRef,
	targetModel: TargetModelLike,
	capabilityKey: string,
	toggles: ModelParameterToggles,
	status: number | undefined,
	result: AssistantMessageLike,
	failure: ReturnType<typeof classifyFailure>,
	sameRetries: number,
): { retry: boolean; sameRetries: number } {
	const rejected = negotiateDisabledFields(
		rejectedCacheFields({ status, message: result.errorMessage }),
		toggles,
	);
	if (rejected.length > 0 && isOpenAIRequestApi(targetModel.api)) {
		const remembered = state.unsupportedCacheFields.get(capabilityKey);
		const newly = rejected.filter(
			(field) => !remembered || !remembered.has(field),
		);
		if (newly.length > 0) {
			const set = remembered ?? new Set<CacheField>();
			for (const field of newly) set.add(field);
			state.unsupportedCacheFields.set(capabilityKey, set);
			return { retry: true, sameRetries };
		}
	}

	const safeFailureReason =
		boundedProviderText(failure.reason, MAX_PROVIDER_STATUS_REASON_LENGTH) ??
		"failure";
	recordFailure(request, target, safeFailureReason);
	const key = genKey(generated.id, target);
	if (failure.kind === "persistent") {
		state.manualRecovery.set(key, safeFailureReason);
		invokeProviderHookSafely(state.onManualRecovery, key, safeFailureReason);
	}
	const retry =
		shouldRetryCurrentModel(failure.kind, generated.errorHandlingMode) &&
		sameRetries < generated.maxRetries;
	if (!retry && failure.kind === "cooldown") {
		const level = state.cooldownLevels.get(key) ?? 0;
		state.cooldowns.set(
			key,
			Date.now() + cooldownMinutesForLevel(level) * 60_000,
		);
		state.cooldownLevels.set(key, nextCooldownLevel(level));
	}
	return { retry, sameRetries: retry ? sameRetries + 1 : sameRetries };
}

function sharedRequestTimeoutMs(value: unknown): number {
	return Number.isSafeInteger(value) && (value as number) > 0
		? Math.max(value as number, SHARED_ATTEMPT_TIMEOUT_FLOOR_MS)
		: SHARED_ATTEMPT_TIMEOUT_FLOOR_MS;
}

function sharedAttemptTimeouts(
	settings: SharedTargetSettings,
	effectiveRequestTimeoutMs: number,
): { noProgressTimeoutSeconds: number; attemptTimeoutMs: number } {
	const storedTimeoutMs =
		settings.noProgressTimeoutSeconds > 0
			? settings.noProgressTimeoutSeconds * 1_000
			: 0;
	const plannedAttemptTimeoutMs = Math.max(
		effectiveRequestTimeoutMs,
		storedTimeoutMs,
		SHARED_ATTEMPT_TIMEOUT_FLOOR_MS,
	);
	const noProgressTimeoutMs =
		storedTimeoutMs > 0 ? storedTimeoutMs : effectiveRequestTimeoutMs;
	return {
		noProgressTimeoutSeconds: noProgressTimeoutMs / 1_000,
		attemptTimeoutMs: plannedAttemptTimeoutMs,
	};
}

function isTransientSharedClaimFailure(result: ClaimResult): boolean {
	return (
		result.kind === "invalid" &&
		result.coordination === "degraded" &&
		(result.reason === "cas-exhausted" || result.reason === "write-failed")
	);
}

function sharedClaimFailure(
	result: Extract<ClaimResult, { kind: "invalid" }>,
): string {
	return `shared claim invalid: ${result.detail}`;
}

function sharedSettlementFailure(
	result: SettleResult,
	operation: string,
): string | undefined {
	if (result.kind === "stale") return `${operation} stale`;
	if (result.kind === "invalid") return `${operation} invalid: ${result.detail}`;
	return undefined;
}

function emitSharedTerminal(
	emit: (event: StreamEvent) => void,
	end: (result: unknown) => void,
	reason: string,
	mode: "error" | "aborted" = "error",
): void {
	const message = errorMessage(reason);
	if (mode === "aborted") message.stopReason = "aborted";
	emit({
		type: "error",
		reason: mode,
		error: message,
	});
	end(message);
}

async function settleSharedState(
	adapter: SharedStateAdapter,
	target: ModelRef,
	outcome: Parameters<SharedStateAdapter["settle"]>[0]["outcome"],
	effectiveSettings: SharedTargetSettings,
	scopeKey?: string,
): Promise<SettleResult | undefined> {
	try {
		return await adapter.settle({
			target,
			outcome,
			effectiveSettings,
			...(scopeKey === undefined ? {} : { scopeKey }),
		});
	} catch {
		return undefined;
	}
}

async function emitUnexpectedSharedTerminal(
	error: unknown,
	emit: (event: StreamEvent) => void,
	end: (result: unknown) => void,
): Promise<void> {
	const reason =
		boundedProviderText(
			normalizeProviderError(error).message,
			MAX_PROVIDER_STATUS_REASON_LENGTH,
		) ?? "Unknown provider error";
	emitSharedTerminal(emit, end, `Unexpected shared failover error: ${reason}`);
}

function nextSharedTarget(
	chain: readonly ModelRef[],
	attempted: ReadonlySet<string>,
): ModelRef | undefined {
	for (const target of chain) {
		if (!attempted.has(modelKey(target))) return { ...target };
	}
	return undefined;
}

function waitForSharedRetry(
	nextEligibleAt: number,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(true);
	const delayMs = Math.max(0, nextEligibleAt - Date.now());
	if (delayMs === 0) return Promise.resolve(false);
	return new Promise((resolve) => {
		let finished = false;
		const finish = (aborted: boolean) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(aborted);
		};
		const onAbort = () => finish(true);
		const timer = setTimeout(() => finish(false), delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function runSharedFailoverLoop(
	generated: FailoverChainModel,
	context: RequestContext,
	options: RequestOptions,
	state: FailoverProviderState,
	signal: AbortSignal | undefined,
	chain: readonly ModelRef[],
	cacheKey: string | undefined,
	request: ReturnType<typeof createRequestState>,
	emit: (event: StreamEvent) => void,
	end: (result: unknown) => void,
): Promise<void> {
	const sharedState = state.sharedState;
	if (!sharedState) {
		emitSharedTerminal(emit, end, "Shared failover state is not configured.");
		return;
	}
	if (!generated.enabled) {
		emitSharedTerminal(
			emit,
			end,
			`Failover model "${generated.name}" is disabled.`,
		);
		return;
	}
	if (chain.length === 0) {
		emitSharedTerminal(
			emit,
			end,
			`Failover model "${generated.name}" has no configured targets.`,
		);
		return;
	}

	let current: ModelRef | undefined;
	let selection: TargetSelection | undefined;
	let settings: SharedTargetSettings | undefined;
	let previousTarget: ModelRef | undefined;
	let previousReason: string | undefined;
	for (;;) {
		if (signal?.aborted) {
			emitSharedTerminal(emit, end, "Request cancelled", "aborted");
			return;
		}

		if (!current) {
			const target = nextSharedTarget(chain, request.attempted);
			if (!target) {
				const summary = requestSummary(request, chain);
				emitSharedTerminal(
					emit,
					end,
					`Failover exhausted for "${generated.name}": ${summary || "no eligible targets"}`,
				);
				return;
			}

			let claim: ClaimResult;
			for (let retry = 0; ; retry += 1) {
				try {
					claim = await sharedState.claim({
						target,
						effectiveRequestTimeoutMs: sharedRequestTimeoutMs(options.timeoutMs),
						...(generated.scopeKey === undefined
							? {}
							: { scopeKey: generated.scopeKey }),
					});
				} catch {
					markAttempt(request, target, "claim failure");
					emitSharedTerminal(emit, end, "Shared claim failed.");
					return;
				}
				if (
					!isTransientSharedClaimFailure(claim) ||
					retry >= MAX_TRANSIENT_SHARED_CLAIM_RETRIES
				)
					break;
				if (signal?.aborted) {
					emitSharedTerminal(emit, end, "Request cancelled", "aborted");
					return;
				}
			}
			if (claim.kind === "skipped") {
				markAttempt(request, target, claim.skipReason);
				continue;
			}
			if (claim.kind === "invalid") {
				markAttempt(request, target, "invalid");
				emitSharedTerminal(emit, end, sharedClaimFailure(claim));
				return;
			}
			if (signal?.aborted) {
				emitSharedTerminal(emit, end, "Request cancelled", "aborted");
				return;
			}
			markAttempt(request, target);

			current = target;
			try {
				settings = claim.settings;
				selection = resolveSharedTargetSelection(
					generated,
					target,
					state,
					claim.settings,
					claim.reasoningInherited,
				);
			} catch (error) {
				await emitUnexpectedSharedTerminal(error, emit, end);
				return;
			}
			if (!selection) {
				recordFailure(request, target, "model unavailable");
				const unavailable = await settleSharedState(
					sharedState,
					target,
					{
						kind: "persistent-failure",
						reason: "model unavailable",
					},
					claim.settings,
					generated.scopeKey,
				);
				if (!unavailable) {
					emitSharedTerminal(
						emit,
						end,
						"Shared model-unavailable settlement failed.",
					);
					return;
				}
				const unavailableIssue = sharedSettlementFailure(
					unavailable,
					"Shared model-unavailable settlement",
				);
				if (unavailableIssue) {
					emitSharedTerminal(emit, end, unavailableIssue);
					return;
				}
				if (
					unavailable.kind !== "settled" ||
					unavailable.action !== "manual-recovery"
				) {
					emitSharedTerminal(
						emit,
						end,
						"Shared model-unavailable settlement returned an unexpected result.",
					);
					return;
				}
				current = undefined;
				selection = undefined;
				settings = undefined;
				continue;
			}
			emitTargetTransition(state, selection, previousTarget, previousReason);
			previousTarget = undefined;
			previousReason = undefined;
		}

		const target = current;
		const targetSettings = settings;
		if (!target || !targetSettings || !selection) {
			emitSharedTerminal(emit, end, "Shared failover state is incomplete.");
			return;
		}
		let attempt: TargetAttempt | undefined;
		try {
			const sharedTimeouts = sharedAttemptTimeouts(
				targetSettings,
				sharedRequestTimeoutMs(options.timeoutMs),
			);
			attempt = await executeTargetAttempt(
				context,
				options,
				state,
				cacheKey,
				signal,
				selection,
				sharedTimeouts.noProgressTimeoutSeconds,
				sharedTimeouts.attemptTimeoutMs,
			);
		} catch (error) {
			await emitUnexpectedSharedTerminal(error, emit, end);
			return;
		}
		if (!attempt) {
			emitSharedTerminal(emit, end, "Shared target selection became unavailable.");
			return;
		}

		const { result, failure, targetModel, capabilityKey, toggles, status } =
			attempt;
		if (failure.kind === "none") {
			const settled = await settleSharedState(
				sharedState,
				target,
				{ kind: "success" },
				targetSettings,
				generated.scopeKey,
			);
			if (!settled) {
				emitSharedTerminal(emit, end, "Shared success settlement failed.");
				return;
			}
			const issue = sharedSettlementFailure(settled, "Shared success settlement");
			if (issue) {
				emitSharedTerminal(emit, end, issue);
				return;
			}
			if (settled.kind !== "settled" || settled.action !== "success") {
				emitSharedTerminal(
					emit,
					end,
					"Shared success settlement returned an unexpected result.",
				);
				return;
			}
			const withDiagnostics: AssistantMessageLike = {
				...result,
				diagnostics: [
					...(result.diagnostics ?? []),
					{ failoverModel: generated.id, target: attempt.targetKey },
				],
			};
			emit({ type: "done", reason: result.stopReason, message: withDiagnostics });
			end(withDiagnostics);
			return;
		}

		const rejected = negotiateDisabledFields(
			rejectedCacheFields({ status, message: result.errorMessage }),
			toggles,
		);
		if (rejected.length > 0 && isOpenAIRequestApi(targetModel.api)) {
			const remembered = state.unsupportedCacheFields.get(capabilityKey);
			const newly = rejected.filter(
				(field) => !remembered || !remembered.has(field),
			);
			if (newly.length > 0) {
				const unsupported = remembered ?? new Set<CacheField>();
				for (const field of newly) unsupported.add(field);
				state.unsupportedCacheFields.set(capabilityKey, unsupported);
				const compatibility = await settleSharedState(
					sharedState,
					target,
					{ kind: "compatibility-retry" },
					targetSettings,
					generated.scopeKey,
				);
				if (!compatibility) {
					emitSharedTerminal(emit, end, "Shared compatibility settlement failed.");
					return;
				}
				const compatibilityIssue = sharedSettlementFailure(
					compatibility,
					"Shared compatibility settlement",
				);
				if (compatibilityIssue) {
					emitSharedTerminal(emit, end, compatibilityIssue);
					return;
				}
				if (
					compatibility.kind !== "settled" ||
					compatibility.action !== "compatibility-retry"
				) {
					emitSharedTerminal(
						emit,
						end,
						"Shared compatibility settlement returned an unexpected result.",
					);
					return;
				}
				continue;
			}
		}
		const safeFailureReason =
			boundedProviderText(failure.reason, MAX_PROVIDER_STATUS_REASON_LENGTH) ??
			"failure";
		recordFailure(request, target, safeFailureReason);
		if (failure.kind === "persistent") {
			const settled = await settleSharedState(
				sharedState,
				target,
				{
					kind: "persistent-failure",
					reason: safeFailureReason,
				},
				targetSettings,
				generated.scopeKey,
			);
			if (!settled) {
				emitSharedTerminal(emit, end, "Shared persistent settlement failed.");
				return;
			}
			const issue = sharedSettlementFailure(
				settled,
				"Shared persistent settlement",
			);
			if (issue) {
				emitSharedTerminal(emit, end, issue);
				return;
			}
			if (settled.kind !== "settled" || settled.action !== "manual-recovery") {
				emitSharedTerminal(
					emit,
					end,
					"Shared persistent settlement returned an unexpected result.",
				);
				return;
			}
			previousTarget = target;
			previousReason = safeFailureReason;
			current = undefined;
			selection = undefined;
			settings = undefined;
			continue;
		}

		if (failure.kind === "cancelled") {
			const message = { ...result, stopReason: "aborted" as const };
			emit({
				type: "error",
				reason: "aborted",
				error: message,
			});
			end(message);
			return;
		}

		if (!isAutomaticFailure(failure.kind)) {
			emitSharedTerminal(emit, end, safeFailureReason);
			return;
		}

		const settled = await settleSharedState(
			sharedState,
			target,
			{
				kind: "automatic-failure",
				reason: safeFailureReason,
			},
			targetSettings,
			generated.scopeKey,
		);
		if (!settled) {
			emitSharedTerminal(emit, end, "Shared automatic settlement failed.");
			return;
		}
		const issue = sharedSettlementFailure(settled, "Shared automatic settlement");
		if (issue) {
			emitSharedTerminal(emit, end, issue);
			return;
		}
		if (settled.kind !== "settled") {
			emitSharedTerminal(
				emit,
				end,
				"Shared automatic settlement returned an unexpected result.",
			);
			return;
		}
		if (settled.action === "retry") {
			if (settled.nextEligibleAt === undefined) {
				emitSharedTerminal(
					emit,
					end,
					"Shared retry settlement omitted its eligibility time.",
				);
				return;
			}
			const retryAborted = await waitForSharedRetry(
				settled.nextEligibleAt,
				signal,
			);
			if (retryAborted) {
				emitSharedTerminal(emit, end, "Request cancelled", "aborted");
				return;
			}
			continue;
		}
		if (settled.action !== "cooldown") {
			emitSharedTerminal(
				emit,
				end,
				"Shared automatic settlement returned an unsupported action.",
			);
			return;
		}
		previousTarget = target;
		previousReason =
			boundedProviderText(
				settled.failureReason ?? safeFailureReason,
				MAX_PROVIDER_STATUS_REASON_LENGTH,
			) ?? "failure";
		current = undefined;
		selection = undefined;
		settings = undefined;
	}
}

async function runFailoverLoop(
	generated: GeneratedFailoverModel,
	context: RequestContext,
	options: RequestOptions,
	state: FailoverProviderState,
	signal: AbortSignal | undefined,
	chain: readonly ModelRef[],
	cacheKey: string | undefined,
	request: ReturnType<typeof createRequestState>,
	requestCooldowns: ReadonlyMap<string, number>,
	emit: (event: StreamEvent) => void,
	end: (result: unknown) => void,
): Promise<void> {
	if (!generated.enabled) {
		const message = errorMessage(
			`Failover model "${generated.name}" is disabled.`,
		);
		emit({ type: "error", reason: "error", error: message });
		end(message);
		return;
	}
	if (chain.length === 0) {
		const message = errorMessage(
			`Failover model "${generated.name}" has no configured targets.`,
		);
		emit({ type: "error", reason: "error", error: message });
		end(message);
		return;
	}

	let current: ModelRef | undefined;
	let sameRetries = 0;
	let previousTarget: ModelRef | undefined;
	let previousReason: string | undefined;
	let selection: TargetSelection | undefined;
	for (;;) {
		if (signal?.aborted) {
			const message = errorMessage("Request cancelled");
			message.stopReason = "aborted";
			emit({ type: "error", reason: "aborted", error: message });
			end(message);
			return;
		}

		if (!current) {
			const candidates = chain.filter(
				(target) => !state.manualRecovery.has(genKey(generated.id, target)),
			);
			current = nextUnattemptedModel(
				candidates,
				request.attempted,
				requestCooldowns,
				Date.now(),
			);
			if (!current) {
				const summary = requestSummary(request, chain);
				const message = errorMessage(
					`Failover exhausted for "${generated.name}": ${summary || "no eligible targets"}`,
				);
				emit({ type: "error", reason: "error", error: message });
				end(message);
				return;
			}
			markAttempt(request, current);
			sameRetries = 0;
			selection = resolveTargetSelection(generated, current, state);
			if (selection) {
				emitTargetTransition(state, selection, previousTarget, previousReason);
				previousTarget = undefined;
				previousReason = undefined;
			}
		}

		const target = current;
		const attempt = await executeTargetAttempt(
			context,
			options,
			state,
			cacheKey,
			signal,
			selection,
			generated.noProgressTimeoutSeconds,
		);
		if (!attempt) {
			recordFailure(request, target, "model unavailable");
			state.manualRecovery.set(genKey(generated.id, target), "model unavailable");
			current = undefined;
			continue;
		}

		const {
			result,
			failure,
			targetModel,
			targetKey,
			capabilityKey,
			toggles,
			status,
		} = attempt;
		if (failure.kind === "none") {
			const key = genKey(generated.id, target);
			if ((requestCooldowns.get(targetKey) ?? 0) > 0) {
				state.cooldowns.delete(key);
				state.cooldownLevels.delete(key);
			}
			const withDiagnostics: AssistantMessageLike = {
				...result,
				diagnostics: [
					...(result.diagnostics ?? []),
					{ failoverModel: generated.id, target: targetKey },
				],
			};
			emit({ type: "done", reason: result.stopReason, message: withDiagnostics });
			end(withDiagnostics);
			return;
		}
		if (!isAutomaticFailure(failure.kind)) {
			const message =
				failure.kind === "cancelled"
					? { ...result, stopReason: "aborted" as const }
					: result;
			emit({
				type: "error",
				reason: failure.kind === "cancelled" ? "aborted" : "error",
				error: message,
			});
			end(message);
			return;
		}

		const outcome = applyAutomaticFailure(
			generated,
			state,
			request,
			target,
			targetModel,
			capabilityKey,
			toggles,
			status,
			result,
			failure,
			sameRetries,
		);
		const previousSameRetries = sameRetries;
		sameRetries = outcome.sameRetries;
		if (outcome.retry) {
			if (sameRetries > previousSameRetries)
				await waitForExtensionRetry(sameRetries - 1, signal);
			continue;
		}
		previousTarget = target;
		previousReason = failure.reason;
		current = undefined;
	}
}

function isLegacyFailoverModel(
	generated: FailoverChainModel,
): generated is GeneratedFailoverModel {
	return (
		"reasoningEffort" in generated &&
		"errorHandlingMode" in generated &&
		"maxRetries" in generated &&
		"noProgressTimeoutSeconds" in generated &&
		"modelParameters" in generated &&
		"targetOverrides" in generated &&
		"manualRecovery" in generated
	);
}

function runFailoverRequestInternal(
	generated: FailoverChainModel,
	context: RequestContext,
	options: RequestOptions,
	state: FailoverProviderState,
): AssistantMessageEventStreamLike {
	const signal = options.signal;
	const chain = generated.chain;
	const cacheKey =
		options.cacheRetention === "none"
			? undefined
			: promptCacheKeyFromSessionId(options.sessionId);
	const request = createRequestState(Date.now());
	return createBufferedStream((emit, end) => {
		if (state.sharedState)
			return runSharedFailoverLoop(
				generated,
				context,
				options,
				state,
				signal,
				chain,
				cacheKey,
				request,
				emit,
				end,
			);
		if (!isLegacyFailoverModel(generated)) {
			emitSharedTerminal(
				emit,
				end,
				"Version 8 failover models require shared failover state.",
			);
			return;
		}
		const requestCooldowns = new Map<string, number>(
			chain.map((target) => [
				modelKey(target),
				state.cooldowns.get(genKey(generated.id, target)) ?? 0,
			]),
		);
		return runFailoverLoop(
			generated,
			context,
			options,
			state,
			signal,
			chain,
			cacheKey,
			request,
			requestCooldowns,
			emit,
			end,
		);
	});
}

export function runFailoverRequest(
	generated: GeneratedFailoverModelV8,
	context: RequestContext,
	options: RequestOptions,
	state: FailoverProviderState & { sharedState: SharedStateAdapter },
): AssistantMessageEventStreamLike;
export function runFailoverRequest(
	generated: GeneratedFailoverModel,
	context: RequestContext,
	options: RequestOptions,
	state: FailoverProviderState,
): AssistantMessageEventStreamLike;
export function runFailoverRequest(
	generated: FailoverChainModel,
	context: RequestContext,
	options: RequestOptions,
	state: FailoverProviderState,
): AssistantMessageEventStreamLike {
	return runFailoverRequestInternal(generated, context, options, state);
}

function buildVirtualModel(
	generated: FailoverChainModel,
	metadata: readonly TargetCatalogMetadata[],
): Record<string, unknown> {
	const catalog = buildFailoverCatalogModel(generated, metadata);
	return {
		...catalog,
		api: FAILOVER_MODEL_API,
		provider: FAILOVER_PROVIDER_ID,
		baseUrl: FAILOVER_BASE_URL,
		headers: undefined,
	};
}

/** Native Pi provider shape; cast to pi's Provider at the registration boundary. */
export interface FailoverProvider {
	id: string;
	name: string;
	auth: {
		apiKey: {
			name: string;
			resolve: () => Promise<{ auth: Record<string, never> }>;
		};
	};
	getModels(): Record<string, unknown>[];
	filterModels(models: Array<{ id: string }>): Array<{ id: string }>;
	stream(
		model: { id: string },
		context: RequestContext,
		options: RequestOptions,
	): AssistantMessageEventStreamLike;
	streamSimple(
		model: { id: string },
		context: RequestContext,
		options: RequestOptions,
	): AssistantMessageEventStreamLike;
}
/** Build a native Pi provider whose stream routes through the failover policy. */
export function createFailoverProvider(
	state: FailoverProviderState,
): FailoverProvider {
	const getModels = () =>
		state.config.models
			.filter((model) => model.enabled)
			.map((model) => buildVirtualModel(model, state.metadata));

	const route = (
		model: { id: string },
		context: RequestContext,
		options: RequestOptions,
	): AssistantMessageEventStreamLike => {
		const generated = state.config.models.find((entry) => entry.id === model.id);
		if (!generated) {
			return createBufferedStream((emit, end) => {
				const message = errorMessage(`Unknown failover model: ${model.id}`);
				emit({ type: "error", reason: "error", error: message });
				end(message);
			});
		}
		return runFailoverRequestInternal(generated, context, options, state);
	};

	return {
		id: FAILOVER_PROVIDER_ID,
		name: "Failover",
		auth: {
			apiKey: {
				name: "Failover virtual",
				// Virtual provider: real auth is resolved per-target inside the router.
				resolve: async () => ({ auth: {} }),
			},
		},
		getModels,
		filterModels: (models: Array<{ id: string }>) => {
			if (!state.availabilityKnown) return [...models];
			return models.filter((model) => {
				const generated = state.config.models.find(
					(entry) => entry.id === model.id,
				);
				return (
					generated &&
					generated.chain.some((target) =>
						state.availableTargetKeys.has(modelKey(target)),
					)
				);
			});
		},
		stream: route,
		streamSimple: route,
	};
}
