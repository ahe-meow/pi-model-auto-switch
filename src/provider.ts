import type {
	GeneratedFailoverModel,
	ModelParameterToggles,
	ModelRef,
	ReasoningEffort,
} from "./types.ts";
import { DEFAULT_PARAMETER_TOGGLES, modelKey } from "./types.ts";
import {
	classifyFailure,
	createRequestState,
	isAutomaticFailure,
	markAttempt,
	nextUnattemptedModel,
	recordFailure,
	requestSummary,
	shouldRetryCurrentModel,
} from "./state.ts";
import {
	type CacheField,
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

export const FAILOVER_MODEL_API = "openai-responses";
export const FAILOVER_BASE_URL = "https://failover.invalid/v1";

/** Minimal structural view of a Pi target model (runtime boundary cast). */
export interface TargetModelLike {
	provider: string;
	id: string;
	api: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ReasoningEffort, string | null>>;
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
	diagnostics?: unknown[];
	timestamp: number;
}

export interface RequestOptions {
	signal?: AbortSignal;
	sessionId?: string;
	reasoning?: string;
	headers?: Record<string, string | null>;
	maxRetries?: number;
	timeoutMs?: number;
	onPayload?: (payload: unknown, model?: unknown) => unknown | void;
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

/** A switch from one failed chain target to the next. */
export interface FailoverTransition {
	source?: ModelRef;
	target: ModelRef;
	reason: string;
}

export interface FailoverProviderState {
	config: { models: GeneratedFailoverModel[] };
	metadata: readonly TargetCatalogMetadata[];
	delegate: Delegate;
	/** Target keys known to be authenticated; empty means "not yet determined". */
	availableTargetKeys: ReadonlySet<string>;
	/** Whether the registry has supplied an authoritative availability snapshot. */
	availabilityKnown: boolean;
	cooldowns: Map<string, number>;
	manualRecovery: Map<string, string>;
	unsupportedCacheFields: Map<string, Set<CacheField>>;
	/** Optional callback invoked when the router switches chain targets. */
	onTransition?: (transition: FailoverTransition) => void;
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

function errorMessage(error: unknown): AssistantMessageLike {
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
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
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
): Promise<{ result: AssistantMessageLike; timedOut: boolean }> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
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
	const resetTimer = () => {
		if (timeoutMs === undefined) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
			timeoutReject(new NoProgressTimeoutError());
		}, timeoutMs);
	};
	const attemptOptions: RequestOptions = {
		...options,
		signal: controller.signal,
	};
	try {
		resetTimer();
		const work = delegate.stream
			? (async () => {
					const stream = delegate.stream!(model, context, attemptOptions);
					for await (const _event of stream) resetTimer();
					return (await stream.result()) as AssistantMessageLike;
				})()
			: delegate.complete(model, context, attemptOptions);
		// Keep consuming a timed-out stream in the background so its rejection is handled.
		void work.catch(() => undefined);
		const result = await Promise.race([work, timeout, aborted]);
		return { result, timedOut: false };
	} catch (error) {
		if (timedOut) return { result: errorMessage(error), timedOut: true };
		// Auth, transport, and delegate throws become classifiable failures so the
		// chain can advance; only a real cancellation stops it.
		const failed = errorMessage(error);
		if (outerAborted) failed.stopReason = "aborted";
		return { result: failed, timedOut: false };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
	}
}

export function runFailoverRequest(
	generated: GeneratedFailoverModel,
	context: RequestContext,
	options: RequestOptions,
	state: FailoverProviderState,
): AssistantMessageEventStreamLike {
	const signal = options.signal;
	const chain = generated.chain;
	const cacheKey = promptCacheKeyFromSessionId(options.sessionId);
	const request = createRequestState(Date.now());
	const requestCooldowns = new Map<string, number>(
		chain.map((target) => [
			modelKey(target),
			state.cooldowns.get(genKey(generated.id, target)) ?? 0,
		]),
	);

	return createBufferedStream(async (emit, end) => {
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
		for (;;) {
			if (signal?.aborted) {
				const message = errorMessage("Request cancelled");
				message.stopReason = "aborted";
				emit({ type: "error", reason: "aborted", error: message });
				end(message);
				return;
			}

			if (!current) {
				const now = Date.now();
				const candidates = chain.filter(
					(target) => !state.manualRecovery.has(genKey(generated.id, target)),
				);
				current = nextUnattemptedModel(
					candidates,
					request.attempted,
					requestCooldowns,
					now,
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
				if (previousTarget && modelKey(previousTarget) !== modelKey(current)) {
					state.onTransition?.({
						source: previousTarget,
						target: current,
						reason: previousReason ?? "failure",
					});
				}
				previousTarget = undefined;
				previousReason = undefined;
			}

			const target = current;
			const targetModel = state.delegate.resolveModel(target);
			if (!targetModel) {
				recordFailure(request, target, "model unavailable");
				state.manualRecovery.set(genKey(generated.id, target), "model unavailable");
				previousTarget = target;
				previousReason = "model unavailable";
				current = undefined;
				continue;
			}

			const targetKey = modelKey(target);
			const override = generated.targetOverrides[targetKey];
			const toggles = mergeToggles(
				generated.modelParameters,
				override?.modelParameters,
			);
			const effort = override?.reasoningEffort ?? generated.reasoningEffort;
			const capabilityKey = `${generated.id}:${targetKey}:${targetModel.api}`;
			const unsupported =
				state.unsupportedCacheFields.get(capabilityKey) ?? EMPTY_UNSUPPORTED;
			const timeoutMs =
				generated.noProgressTimeoutSeconds > 0
					? generated.noProgressTimeoutSeconds * 1000
					: undefined;

			let status: number | undefined;
			const {
				apiKey: _droppedApiKey,
				signal: _outerSignal,
				timeoutMs: _outerTimeoutMs,
				onPayload: outerOnPayload,
				onResponse: outerOnResponse,
				transformHeaders: outerTransformHeaders,
				...forward
			} = options;
			const attemptOptions: RequestOptions = {
				...forward,
				reasoning: effort,
				onPayload: (payload: unknown, model?: unknown) => {
					const forwarded = outerOnPayload?.(payload, model);
					const next = forwarded === undefined ? payload : forwarded;
					applyRequestParameters(next, {
						api: targetModel.api,
						toggles,
						cacheKey,
						unsupported,
						reasoningEffort: mappedReasoning(targetModel, effort),
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
					const next = outerTransformHeaders
						? await outerTransformHeaders(headers)
						: headers;
					replaceSessionAffinityHeaders(next, { toggles, cacheKey });
					return next;
				},
			};
			void _droppedApiKey;
			void _outerSignal;
			void _outerTimeoutMs;

			const { result, timedOut } = await executeTarget(
				state.delegate,
				targetModel,
				context,
				attemptOptions,
				timeoutMs,
				signal,
			);
			const failure = classifyFailure({
				status,
				message: result.errorMessage,
				stopReason: result.stopReason,
				timedOut,
			});

			if (failure.kind === "none") {
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

			// Cache-field negotiation runs before policy accounting and never consumes it.
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
					continue;
				}
			}

			recordFailure(request, target, failure.reason);
			const key = genKey(generated.id, target);
			if (failure.kind === "cooldown")
				state.cooldowns.set(key, Date.now() + generated.cooldownMinutes * 60_000);
			if (failure.kind === "persistent")
				state.manualRecovery.set(key, failure.reason);

			if (
				shouldRetryCurrentModel(failure.kind, generated.errorHandlingMode) &&
				sameRetries < generated.maxRetries
			) {
				sameRetries++;
				continue;
			}
			previousTarget = target;
			previousReason = failure.reason;
			current = undefined;
		}
	});
}

function buildVirtualModel(
	generated: GeneratedFailoverModel,
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
		return runFailoverRequest(generated, context, options, state);
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
