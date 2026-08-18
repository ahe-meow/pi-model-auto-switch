import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelRegistryReader } from "./catalog.ts";
import {
	discoverModels,
	filterConfiguredModels,
	seedModelList,
	uniqueModels,
} from "./catalog.ts";
import {
	createDefaultConfig,
	isValidTimeoutSeconds,
	loadConfig,
	saveConfig,
} from "./config.ts";
import {
	canArmProgressTimer,
	classifyFailure,
	createRequestState,
	isAutomaticFailure,
	markAttempt,
	nextUnattemptedModel,
	recordFailure,
	requestSummary,
} from "./state.ts";
import {
	FailoverEditor,
	type FailoverTuiActions,
	type FailoverTuiView,
} from "./tui.ts";
import type {
	AutomationMode,
	FailoverConfig,
	FailureInput,
	ModelRef,
	ProgressAttemptKind,
	ReasoningEffort,
	RequestState,
	Transition,
} from "./types.ts";
import { modelKey, REASONING_EFFORTS } from "./types.ts";

export const FAILOVER_CONFIG_PATH = join(getAgentDir(), "model-failover.json");
const COOLDOWN_MS = 30 * 60 * 1000;
const CONTINUATION_TYPE = "model-failover-continuation";
const OPENAI_REQUEST_APIS = new Set([
	"openai-responses",
	"openai-completions",
	"azure-openai-responses",
]);
const SESSION_AFFINITY_HEADERS = new Set([
	"session_id",
	"x-client-request-id",
	"x-session-affinity",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOfficialOpenAIModel(model: ExtensionContext["model"]): boolean {
	return Boolean(
		model &&
			((model.provider === "openai" && OPENAI_REQUEST_APIS.has(model.api)) ||
				(model.provider === "azure-openai-responses" &&
					model.api === "azure-openai-responses")),
	);
}

function promptCacheKey(ctx: ExtensionContext): string | undefined {
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionId) return undefined;
	return createHash("sha256")
		.update("pi-model-failover/prompt-cache-key/v1:")
		.update(sessionId)
		.digest("hex");
}

function reasoningEffortForModel(
	model: NonNullable<ExtensionContext["model"]>,
	requested: (typeof REASONING_EFFORTS)[number],
): string | undefined {
	if (!model.reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[requested];
	if (mapped === null) return undefined;
	return mapped ?? (requested === "off" ? "none" : requested);
}

function applyOpenAIRequestParameters(
	payload: unknown,
	ctx: ExtensionContext,
	runtime: RuntimeState,
): void {
	if (!isOfficialOpenAIModel(ctx.model) || !isRecord(payload)) return;
	const key = promptCacheKey(ctx);
	if (key) payload.prompt_cache_key = key;
	payload.prompt_cache_retention = "24h";

	const effort = reasoningEffortForModel(
		ctx.model,
		runtime.config.reasoningEffort,
	);
	if (effort === undefined) return;
	if (ctx.model.api === "openai-completions") {
		payload.reasoning_effort = effort;
		return;
	}
	const reasoning = isRecord(payload.reasoning) ? { ...payload.reasoning } : {};
	reasoning.effort = effort;
	payload.reasoning = reasoning;
}

function replaceOpenAISessionHeaders(
	headers: Record<string, string | null>,
	ctx: ExtensionContext,
): void {
	if (!isOfficialOpenAIModel(ctx.model)) return;
	const key = promptCacheKey(ctx);
	if (!key) return;
	for (const name of Object.keys(headers)) {
		if (SESSION_AFFINITY_HEADERS.has(name.toLowerCase())) headers[name] = key;
	}
}

interface RuntimeState {
	config: FailoverConfig;
	available: ModelRef[];
	current?: ModelRef;
	mode: AutomationMode;
	request?: RequestState;
	requestSequence: number;
	phase:
		| "ready"
		| "requesting"
		| "settled"
		| "switching"
		| "succeeded"
		| "cancelled"
		| "exhausted";
	attemptKind: ProgressAttemptKind;
	attemptGeneration: number;
	nativeRetryPending: boolean;
	lastStatus?: number;
	lastFailure?: { stopReason?: string; message?: string };
	toolFailure: boolean;
	timeoutRequested: boolean;
	timer?: ReturnType<typeof setTimeout>;
	cooldowns: Map<string, number>;
	manualRecovery: Map<string, string>;
	latestTransition?: Transition;
	exhaustionSummary?: string;
	internalSelection?: string;
	pendingContinuation?: "same" | "switch";
	contextFilterArmed: boolean;
	initialized: boolean;
}

function initialRuntime(): RuntimeState {
	return {
		config: createDefaultConfig(),
		available: [],
		mode: "enabled",
		requestSequence: 0,
		phase: "ready",
		attemptKind: "initial",
		attemptGeneration: 0,
		nativeRetryPending: false,
		toolFailure: false,
		timeoutRequested: false,
		cooldowns: new Map(),
		manualRecovery: new Map(),
		contextFilterArmed: false,
		initialized: false,
	};
}

function refOf(model: ExtensionContext["model"]): ModelRef | undefined {
	return model ? { provider: model.provider, id: model.id } : undefined;
}

function textFromMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = message as {
		role?: unknown;
		stopReason?: unknown;
		errorMessage?: unknown;
	};
	if (value.role !== "assistant") return undefined;
	return typeof value.errorMessage === "string" ? value.errorMessage : undefined;
}

function failureFromMessages(
	messages: AgentEndEvent["messages"],
): { stopReason?: string; message?: string } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as unknown as {
			role?: unknown;
			stopReason?: unknown;
			errorMessage?: unknown;
		};
		if (message?.role !== "assistant") continue;
		const stopReason =
			typeof message.stopReason === "string" ? message.stopReason : undefined;
		const messageText = textFromMessage(message);
		if (stopReason === "error" || stopReason === "aborted" || messageText) {
			return { stopReason, message: messageText };
		}
		return undefined;
	}
	return undefined;
}

function isFailedAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const value = message as {
		role?: unknown;
		stopReason?: unknown;
		errorMessage?: unknown;
	};
	return (
		value.role === "assistant" &&
		(value.stopReason === "error" ||
			value.stopReason === "aborted" ||
			typeof value.errorMessage === "string")
	);
}

function describeModel(model: ModelRef | undefined): string {
	return model ? modelKey(model) : "none";
}

function updateStatus(ctx: ExtensionContext, runtime: RuntimeState): void {
	const current = runtime.current ? ` ${modelKey(runtime.current)}` : "";
	ctx.ui.setStatus("model-failover", `${runtime.mode}${current}`);
}

function notify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

async function persist(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	config: FailoverConfig,
): Promise<void> {
	const nextConfig: FailoverConfig = {
		...config,
		manualRecovery: Object.fromEntries(runtime.manualRecovery),
	};
	try {
		await saveConfig(FAILOVER_CONFIG_PATH, nextConfig);
		runtime.config = nextConfig;
		updateStatus(ctx, runtime);
	} catch (error) {
		notify(
			ctx,
			`Could not save ${FAILOVER_CONFIG_PATH}: ${String(error)}`,
			"error",
		);
	}
}

async function discoverWithFallback(
	ctx: ExtensionContext,
): Promise<ModelRef[]> {
	try {
		return await discoverModels(
			ctx.modelRegistry as unknown as ModelRegistryReader,
		);
	} catch (error) {
		notify(ctx, `Model catalog refresh failed: ${String(error)}`, "warning");
		try {
			return uniqueModels(ctx.modelRegistry.getAvailable());
		} catch {
			return [];
		}
	}
}

async function refreshCatalog(
	ctx: ExtensionContext,
	runtime: RuntimeState,
): Promise<void> {
	const loaded = await loadConfig(FAILOVER_CONFIG_PATH);
	const discovered = await discoverWithFallback(ctx);
	const current = refOf(ctx.model);
	runtime.available = discovered;
	runtime.current = current;

	if (!loaded.exists || !loaded.valid) {
		runtime.manualRecovery.clear();
		const config = createDefaultConfig(seedModelList(current, discovered));
		await persist(ctx, runtime, config);
	} else {
		runtime.config = {
			...loaded.config,
			models: filterConfiguredModels(loaded.config.models, discovered),
		};
		runtime.manualRecovery = new Map(
			Object.entries(loaded.config.manualRecovery),
		);
		if (
			loaded.migrated ||
			runtime.config.models.length !== loaded.config.models.length
		) {
			await persist(ctx, runtime, runtime.config);
		}
	}

	runtime.mode = runtime.config.enabled
		? runtime.config.paused
			? "paused"
			: "enabled"
		: "disabled";
	runtime.initialized = true;
	updateStatus(ctx, runtime);
}

function clearTimer(runtime: RuntimeState): void {
	if (runtime.timer) clearTimeout(runtime.timer);
	runtime.timer = undefined;
}

function startProgressTimer(
	ctx: ExtensionContext,
	runtime: RuntimeState,
): void {
	clearTimer(runtime);
	const seconds = runtime.config.noProgressTimeoutSeconds;
	const request = runtime.request;
	if (
		seconds === 0 ||
		!canArmProgressTimer(
			runtime.mode,
			runtime.phase,
			runtime.attemptKind,
			Boolean(request),
		)
	)
		return;
	const requestId = request!.id;
	const generation = runtime.attemptGeneration;
	runtime.timer = setTimeout(() => {
		if (
			runtime.request?.id !== requestId ||
			runtime.attemptGeneration !== generation ||
			!canArmProgressTimer(
				runtime.mode,
				runtime.phase,
				runtime.attemptKind,
				true,
			) ||
			ctx.isIdle()
		)
			return;
		runtime.timeoutRequested = true;
		clearTimer(runtime);
		ctx.abort();
	}, seconds * 1000);
}

function noteProgress(ctx: ExtensionContext, runtime: RuntimeState): void {
	if (
		canArmProgressTimer(
			runtime.mode,
			runtime.phase,
			runtime.attemptKind,
			Boolean(runtime.request),
		)
	) {
		startProgressTimer(ctx, runtime);
	}
}

async function markManualPause(
	ctx: ExtensionContext,
	runtime: RuntimeState,
): Promise<void> {
	runtime.mode = runtime.config.enabled ? "paused" : "disabled";
	runtime.request = undefined;
	runtime.phase = "cancelled";
	runtime.nativeRetryPending = false;
	runtime.pendingContinuation = undefined;
	runtime.attemptGeneration++;
	clearTimer(runtime);
	await persist(ctx, runtime, { ...runtime.config, paused: true });
}

async function setModelInternally(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RuntimeState,
	model: NonNullable<ExtensionContext["model"]>,
): Promise<boolean> {
	runtime.internalSelection = modelKey(model);
	try {
		const selected = await pi.setModel(model);
		if (selected) runtime.current = refOf(model);
		return selected;
	} finally {
		runtime.internalSelection = undefined;
		updateStatus(ctx, runtime);
	}
}

async function selectHealthyModelAtStartup(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RuntimeState,
): Promise<void> {
	if (runtime.mode !== "enabled" || !ctx.model) return;
	if (!runtime.manualRecovery.has(modelKey(ctx.model))) return;
	const now = Date.now();
	for (const candidate of runtime.config.models) {
		const key = modelKey(candidate);
		if (runtime.manualRecovery.has(key)) continue;
		const cooldownUntil = runtime.cooldowns.get(key);
		if (cooldownUntil !== undefined && cooldownUntil > now) continue;
		if (key === modelKey(ctx.model)) continue;
		const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
		if (!model) continue;
		if (await setModelInternally(pi, ctx, runtime, model)) return;
	}
}

function transition(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	source: ModelRef | undefined,
	target: ModelRef | undefined,
	reason: string,
): void {
	runtime.latestTransition = { source, target, reason, at: Date.now() };
	notify(
		ctx,
		`Failover: ${describeModel(source)} -> ${describeModel(target)} (${reason})`,
		"warning",
	);
	updateStatus(ctx, runtime);
}

function exhausted(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	request: RequestState,
): void {
	runtime.exhaustionSummary = requestSummary(request, runtime.config.models);
	runtime.phase = "exhausted";
	request.completed = true;
	clearTimer(runtime);
	notify(
		ctx,
		`Failover exhausted: ${runtime.exhaustionSummary || "no attempted models"}`,
		"error",
	);
	updateStatus(ctx, runtime);
}

function sendContinuation(
	pi: ExtensionAPI,
	runtime: RuntimeState,
	type: "same" | "switch",
	target: ModelRef,
): void {
	runtime.pendingContinuation = type;
	runtime.contextFilterArmed = true;
	runtime.phase = "requesting";
	pi.sendMessage(
		{
			customType: CONTINUATION_TYPE,
			content:
				"Continue the current user request from the existing conversation context. Do not repeat completed tool calls unless necessary.",
			display: false,
			details: { model: target, kind: type },
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

async function advanceToNextModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RuntimeState,
	reason: string,
): Promise<void> {
	const request = runtime.request;
	if (!request || request.completed || runtime.mode !== "enabled") return;
	const source = runtime.current ?? request.activeModel;
	recordFailure(request, source, reason);
	const now = Date.now();

	while (true) {
		const candidates = runtime.config.models.filter(
			(model) => !runtime.manualRecovery.has(modelKey(model)),
		);
		const target = nextUnattemptedModel(
			candidates,
			request.attempted,
			runtime.cooldowns,
			now,
		);
		if (!target) {
			exhausted(ctx, runtime, request);
			return;
		}
		markAttempt(request, target, reason);
		transition(ctx, runtime, source, target, reason);
		const model = ctx.modelRegistry.find(target.provider, target.id);
		if (!model) {
			runtime.manualRecovery.set(modelKey(target), "model unavailable");
			await persist(ctx, runtime, { ...runtime.config });
			continue;
		}
		runtime.phase = "switching";
		const selected = await setModelInternally(pi, ctx, runtime, model);
		if (!selected) {
			runtime.manualRecovery.set(modelKey(target), "authentication unavailable");
			await persist(ctx, runtime, { ...runtime.config });
			continue;
		}
		runtime.current = target;
		sendContinuation(pi, runtime, "switch", target);
		return;
	}
}

async function handleSettled(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RuntimeState,
): Promise<void> {
	clearTimer(runtime);
	if (
		!runtime.request ||
		runtime.request.completed ||
		runtime.mode !== "enabled"
	)
		return;

	const input: FailureInput = {
		status: runtime.lastStatus,
		message: runtime.lastFailure?.message,
		stopReason: runtime.lastFailure?.stopReason,
		timedOut: runtime.timeoutRequested,
		toolError: runtime.toolFailure,
	};
	const result = classifyFailure(input);
	runtime.phase = "settled";
	runtime.timeoutRequested = false;

	if (result.kind === "none") {
		runtime.request.completed = true;
		runtime.phase = "succeeded";
		runtime.exhaustionSummary = undefined;
		updateStatus(ctx, runtime);
		return;
	}
	if (!isAutomaticFailure(result.kind)) {
		runtime.request.completed = true;
		runtime.phase = "cancelled";
		updateStatus(ctx, runtime);
		return;
	}

	const request = runtime.request;
	const source = runtime.current ?? request.activeModel;
	recordFailure(request, source, result.reason);
	if (source) {
		const key = modelKey(source);
		if (result.kind === "cooldown")
			runtime.cooldowns.set(key, Date.now() + COOLDOWN_MS);
		if (result.kind === "persistent")
			runtime.manualRecovery.set(key, result.reason);
	}

	if (result.kind === "persistent" && source) {
		await persist(ctx, runtime, { ...runtime.config });
	}

	if (
		(result.kind === "unknown" || result.kind === "no-progress") &&
		!request.sameModelContinuationUsed
	) {
		request.sameModelContinuationUsed = true;
		if (source) transition(ctx, runtime, source, source, result.reason);
		sendContinuation(
			pi,
			runtime,
			"same",
			source ?? { provider: "unknown", id: "unknown" },
		);
		return;
	}
	await advanceToNextModel(pi, ctx, runtime, result.reason);
}

function viewFor(runtime: RuntimeState): FailoverTuiView {
	return {
		config: runtime.config,
		models: runtime.config.models,
		available: runtime.available,
		current: runtime.current,
		mode: runtime.mode,
		cooldowns: runtime.cooldowns,
		manualRecovery: runtime.manualRecovery,
		latestTransition: runtime.latestTransition,
		exhaustionSummary: runtime.exhaustionSummary,
	};
}

export default function modelFailoverExtension(pi: ExtensionAPI): void {
	const runtime = initialRuntime();

	pi.on("before_provider_request", (event, ctx) => {
		applyOpenAIRequestParameters(event.payload, ctx, runtime);
	});

	pi.on("before_provider_headers", (event, ctx) => {
		replaceOpenAISessionHeaders(event.headers, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshCatalog(ctx, runtime);
		await selectHealthyModelAtStartup(pi, ctx, runtime);
	});

	pi.on("context", async (event) => {
		if (!runtime.contextFilterArmed) return;
		runtime.contextFilterArmed = false;
		const messages = [...event.messages];
		for (let index = messages.length - 1; index >= 0; index--) {
			if (isFailedAssistantMessage(messages[index])) {
				messages.splice(index, 1);
				break;
			}
		}
		return { messages };
	});

	pi.on("session_shutdown", async () => {
		clearTimer(runtime);
		runtime.request = undefined;
	});

	pi.on("model_select", async (event, ctx) => {
		const selected = refOf(event.model);
		runtime.current = selected;
		if (
			runtime.internalSelection === (selected ? modelKey(selected) : undefined)
		) {
			updateStatus(ctx, runtime);
			return;
		}
		if (event.source === "set" || event.source === "cycle")
			await markManualPause(ctx, runtime);
		updateStatus(ctx, runtime);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		clearTimer(runtime);
		runtime.contextFilterArmed = false;
		runtime.pendingContinuation = undefined;
		await selectHealthyModelAtStartup(pi, ctx, runtime);
		runtime.request = createRequestState(
			++runtime.requestSequence,
			refOf(ctx.model),
		);
		runtime.exhaustionSummary = undefined;
		runtime.lastStatus = undefined;
		runtime.lastFailure = undefined;
		runtime.toolFailure = false;
		runtime.timeoutRequested = false;
		runtime.phase = "ready";
		runtime.attemptKind = "initial";
		runtime.nativeRetryPending = false;
		runtime.pendingContinuation = undefined;
		runtime.attemptGeneration++;
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!runtime.request || runtime.mode !== "enabled") return;
		runtime.attemptKind = runtime.pendingContinuation
			? "extension-continuation"
			: runtime.nativeRetryPending
				? "native-retry"
				: "initial";
		runtime.pendingContinuation = undefined;
		runtime.nativeRetryPending = false;
		runtime.attemptGeneration++;
		runtime.phase = "requesting";
		runtime.lastStatus = undefined;
		runtime.lastFailure = undefined;
		runtime.timeoutRequested = false;
		startProgressTimer(ctx, runtime);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (runtime.request && runtime.phase === "requesting") {
			runtime.lastStatus = event.status;
			noteProgress(ctx, runtime);
		}
	});

	pi.on("agent_end", async (event) => {
		if (!runtime.request) return;
		runtime.lastFailure = failureFromMessages(event.messages);
		clearTimer(runtime);
		runtime.nativeRetryPending =
			Boolean(runtime.lastFailure) &&
			!runtime.toolFailure &&
			!runtime.timeoutRequested &&
			runtime.mode === "enabled";
	});

	pi.on("message_update", async (_event, ctx) => noteProgress(ctx, runtime));
	pi.on("turn_start", async (_event, ctx) => noteProgress(ctx, runtime));
	pi.on("tool_execution_start", async (_event, ctx) =>
		noteProgress(ctx, runtime),
	);
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.isError) runtime.toolFailure = true;
		noteProgress(ctx, runtime);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await handleSettled(pi, ctx, runtime);
	});

	pi.registerCommand("failover", {
		description: "Configure Pi model failover",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "/failover requires interactive TUI mode", "warning");
				return;
			}
			await refreshCatalog(ctx, runtime);
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const actions: FailoverTuiActions = {
					onClose: () => done(),
					onError: (error) =>
						notify(ctx, `Failover action failed: ${String(error)}`, "error"),
					onAdd: async () => {
						const configured = new Set(runtime.config.models.map(modelKey));
						const candidates = runtime.available.filter(
							(model) => !configured.has(modelKey(model)),
						);
						if (candidates.length === 0) {
							notify(ctx, "No undiscovered models are available to add", "info");
							return;
						}
						const choice = await ctx.ui.select(
							"Add failover model",
							candidates.map(modelKey),
						);
						if (!choice) return;
						const model = candidates.find(
							(candidate) => modelKey(candidate) === choice,
						);
						if (!model) return;
						await persist(ctx, runtime, {
							...runtime.config,
							models: [...runtime.config.models, { ...model }],
						});
					},
					onRemove: async (index) => {
						const models = runtime.config.models.filter(
							(_model, modelIndex) => modelIndex !== index,
						);
						await persist(ctx, runtime, { ...runtime.config, models });
					},
					onMove: async (index, direction) => {
						const target = index + direction;
						if (index < 0 || target < 0 || target >= runtime.config.models.length)
							return;
						const models = [...runtime.config.models];
						[models[index], models[target]] = [models[target]!, models[index]!];
						await persist(ctx, runtime, { ...runtime.config, models });
					},
					onSelect: async (model) => {
						const selected = ctx.modelRegistry.find(model.provider, model.id);
						if (
							!selected ||
							!(await setModelInternally(pi, ctx, runtime, selected))
						) {
							notify(
								ctx,
								`Model is not currently available: ${modelKey(model)}`,
								"warning",
							);
							return;
						}
						await markManualPause(ctx, runtime);
					},
					onToggleEnabled: async () => {
						const enabled = !runtime.config.enabled;
						runtime.mode = enabled
							? runtime.config.paused
								? "paused"
								: "enabled"
							: "disabled";
						await persist(ctx, runtime, { ...runtime.config, enabled });
						updateStatus(ctx, runtime);
					},
					onSetTimeout: async () => {
						const value = await ctx.ui.input(
							"No-progress timeout seconds",
							String(runtime.config.noProgressTimeoutSeconds),
						);
						if (value === undefined) return;
						const seconds = Number(value.trim());
						if (!isValidTimeoutSeconds(seconds)) {
							notify(
								ctx,
								"Timeout must be 0 or an integer from 15 to 900 seconds",
								"warning",
							);
							return;
						}
						await persist(ctx, runtime, {
							...runtime.config,
							noProgressTimeoutSeconds: seconds,
						});
					},
					onSetReasoningEffort: async () => {
						const choice = await ctx.ui.select("Reasoning effort", [
							...REASONING_EFFORTS,
						]);
						if (!choice) return;
						const reasoningEffort = choice as ReasoningEffort;
						if (!REASONING_EFFORTS.includes(reasoningEffort)) return;
						await persist(ctx, runtime, {
							...runtime.config,
							reasoningEffort,
						});
					},
					onRestore: async () => {
						const target = runtime.config.models[0];
						if (!target) {
							notify(ctx, "No primary model is configured", "warning");
							return;
						}
						const model = ctx.modelRegistry.find(target.provider, target.id);
						if (!model) {
							notify(
								ctx,
								`Could not find ${modelKey(target)} in Pi's model catalog`,
								"warning",
							);
							return;
						}
						if (!(await setModelInternally(pi, ctx, runtime, model))) {
							notify(ctx, `Could not restore ${modelKey(target)}`, "warning");
							return;
						}
						runtime.mode = "enabled";
						runtime.request = undefined;
						runtime.phase = "ready";
						runtime.nativeRetryPending = false;
						runtime.pendingContinuation = undefined;
						runtime.timeoutRequested = false;
						runtime.attemptGeneration++;
						clearTimer(runtime);
						runtime.manualRecovery.clear();
						runtime.cooldowns.clear();
						await persist(ctx, runtime, {
							...runtime.config,
							enabled: true,
							paused: false,
						});
						updateStatus(ctx, runtime);
						notify(ctx, "Failover automation restored", "info");
					},
				};

				const editor = new FailoverEditor(theme, () => viewFor(runtime), actions);
				return {
					render: (width: number) => editor.render(width),
					invalidate: () => editor.invalidate(),
					handleInput: (data: string) => {
						editor.handleInput(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}
