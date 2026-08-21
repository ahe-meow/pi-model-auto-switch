import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelRegistryReader } from "./catalog.ts";
import { discoverModels, seedModelList } from "./catalog.ts";
import {
	type ConfigLoadFailure,
	type ConfigSourceRevision,
	createDefaultConfig,
	isValidCooldownMinutes,
	isValidMaxRetries,
	isValidTimeoutSeconds,
	loadConfig,
	resolveReasoningEffort,
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
	shouldRetryCurrentModel,
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
	ModelParameterName,
	ModelParameterToggles,
	ModelRef,
	ProgressAttemptKind,
	RequestState,
	Transition,
} from "./types.ts";
import { modelKey, type REASONING_EFFORTS } from "./types.ts";

export const FAILOVER_CONFIG_PATH = join(getAgentDir(), "model-failover.json");
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
	"x-session-id",
]);
const CACHE_FIELDS = ["prompt_cache_key", "prompt_cache_retention"] as const;
type CacheField = (typeof CACHE_FIELDS)[number];
const VALIDATION_TYPES = new Set([
	"invalid_request_error",
	"invalid_request",
	"request_validation_error",
]);
const UNSUPPORTED_FIELD_CODES = new Set([
	"unknown_field",
	"unknown_parameter",
	"unknown_request_field",
	"unknown_request_parameter",
	"unsupported_field",
	"unsupported_parameter",
	"unsupported_request_field",
	"unsupported_request_parameter",
]);
const REQUEST_STATUS_PATTERNS = [
	/\b(?:HTTP|API)\s+error\s*\((\d{3})\)/i,
	/\b(?:HTTP\s+)?(\d{3})\s*:/i,
];

const DEFAULT_PARAMETER_TOGGLES: ModelParameterToggles = {
	promptCacheKey: true,
	promptCacheRetention: true,
	reasoningEffort: true,
	sessionAffinity: true,
};

function modelParameterToggles(
	config: FailoverConfig,
	model: ExtensionContext["model"],
): ModelParameterToggles {
	if (!model) return DEFAULT_PARAMETER_TOGGLES;
	const stored = config.modelParameters[modelKey(model)];
	return stored
		? { ...DEFAULT_PARAMETER_TOGGLES, ...stored }
		: DEFAULT_PARAMETER_TOGGLES;
}

function clearModelRuntimeState(runtime: RuntimeState, key: string): void {
	runtime.manualRecovery.delete(key);
	runtime.cooldowns.delete(key);
	for (const capabilityKey of runtime.unsupportedCacheFields.keys()) {
		if (capabilityKey.startsWith(`${key}:`))
			runtime.unsupportedCacheFields.delete(capabilityKey);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAIRequestModel(model: ExtensionContext["model"]): boolean {
	return Boolean(model && OPENAI_REQUEST_APIS.has(model.api));
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

function cacheCapabilityKey(
	model: ExtensionContext["model"],
): string | undefined {
	return model ? `${modelKey(model)}:${model.api}` : undefined;
}

function extractJsonRecords(message: string): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (let start = message.indexOf("{"); start >= 0; ) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		let end = start;
		for (; end < message.length; end++) {
			const character = message[end];
			if (inString) {
				if (escaped) escaped = false;
				else if (character === "\\") escaped = true;
				else if (character === '"') inString = false;
				continue;
			}
			if (character === '"') {
				inString = true;
				continue;
			}
			if (character === "{") depth++;
			else if (character === "}" && --depth === 0) break;
		}
		if (depth === 0) {
			try {
				const parsed: unknown = JSON.parse(message.slice(start, end + 1));
				if (isRecord(parsed)) records.push(parsed);
			} catch {
				// Ignore balanced non-JSON braces and continue with the next object.
			}
			start = message.indexOf("{", end + 1);
		} else {
			start = message.indexOf("{", start + 1);
		}
	}
	return records;
}

function nestedRecords(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(nestedRecords);
	if (!isRecord(value)) return [];
	return [value, ...Object.values(value).flatMap(nestedRecords)];
}

function stringField(
	record: Record<string, unknown>,
	names: string[],
): string | undefined {
	for (const name of names) {
		const value = record[name];
		if (typeof value === "string") return value.toLowerCase();
	}
	return undefined;
}

function numericJsonStatus(message: string): number | undefined {
	for (const record of extractJsonRecords(message).flatMap(nestedRecords)) {
		for (const name of ["status", "status_code", "http_status", "code"]) {
			const value = record[name];
			let number: number | undefined;
			if (typeof value === "number") number = value;
			else if (typeof value === "string" && /^\d{3}$/.test(value))
				number = Number(value);
			if (number !== undefined) return number;
		}
	}
	return undefined;
}

function requestStatus(input: FailureInput): number | undefined {
	if (input.status !== undefined) return input.status;
	const jsonStatus = numericJsonStatus(input.message ?? "");
	if (jsonStatus !== undefined) return jsonStatus;
	for (const pattern of REQUEST_STATUS_PATTERNS) {
		const match = input.message?.match(pattern);
		if (match) return Number(match[1]);
	}
	return undefined;
}

function knownFieldFromMessage(message: string, field: CacheField): boolean {
	return new RegExp(`(?:^|[^a-z0-9_])${field}(?:$|[^a-z0-9_])`, "i").test(
		message,
	);
}

function rejectedCacheFields(input: FailureInput): CacheField[] {
	const status = requestStatus(input);
	if (status === 401 || status === 403 || (status !== 400 && status !== 422))
		return [];
	const records = extractJsonRecords(input.message ?? "").flatMap(nestedRecords);
	return CACHE_FIELDS.filter((field) =>
		records.some((record) => {
			const type = stringField(record, ["type", "error_type"]);
			const code = stringField(record, ["code", "error_code"]);
			const parameter = stringField(record, ["param", "parameter", "field"]);
			const codeValue = record.code;
			const numericCode =
				typeof codeValue === "number" ||
				(typeof codeValue === "string" && /^\d{3}$/.test(codeValue));
			const validationType = type ? VALIDATION_TYPES.has(type) : false;
			const unsupportedCode = code ? UNSUPPORTED_FIELD_CODES.has(code) : false;
			if (!validationType) return false;
			if (parameter === field) return unsupportedCode || numericCode;
			const recordMessage = stringField(record, ["message", "detail"]);
			return (
				!parameter &&
				!code &&
				!numericCode &&
				Boolean(recordMessage && knownFieldFromMessage(recordMessage, field))
			);
		}),
	);
}

function applyOpenAIRequestParameters(
	payload: unknown,
	ctx: ExtensionContext,
	runtime: RuntimeState,
): void {
	if (!isOpenAIRequestModel(ctx.model) || !isRecord(payload)) return;
	const capabilityKey = cacheCapabilityKey(ctx.model);
	const unsupported = capabilityKey
		? runtime.unsupportedCacheFields.get(capabilityKey)
		: undefined;
	const toggles = modelParameterToggles(runtime.config, ctx.model);
	const key = promptCacheKey(ctx);
	if (toggles.promptCacheKey) {
		if (unsupported?.has("prompt_cache_key"))
			Reflect.deleteProperty(payload, "prompt_cache_key");
		else if (key) payload.prompt_cache_key = key;
	}
	if (toggles.promptCacheRetention) {
		if (unsupported?.has("prompt_cache_retention"))
			Reflect.deleteProperty(payload, "prompt_cache_retention");
		else payload.prompt_cache_retention = "24h";
	}

	if (!toggles.reasoningEffort) return;
	const effort = reasoningEffortForModel(
		ctx.model,
		resolveReasoningEffort(runtime.config, ctx.model),
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
	runtime: RuntimeState,
): void {
	if (!isOpenAIRequestModel(ctx.model)) return;
	if (!modelParameterToggles(runtime.config, ctx.model).sessionAffinity) return;
	const key = promptCacheKey(ctx);
	if (!key) return;
	for (const name of Object.keys(headers)) {
		if (SESSION_AFFINITY_HEADERS.has(name.toLowerCase())) headers[name] = key;
	}
}

interface RuntimeState {
	configAccess: { kind: "ready" } | { kind: "blocked"; warning: string };
	configRevision?: ConfigSourceRevision;
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
	unsupportedCacheFields: Map<string, Set<CacheField>>;
	latestTransition?: Transition;
	exhaustionSummary?: string;
	internalSelection?: string;
	pendingContinuation?: "same" | "switch";
	contextFilterArmed: boolean;
	initialized: boolean;
	respectedSelection?: string;
	settling: boolean;
}

function initialRuntime(): RuntimeState {
	return {
		configAccess: {
			kind: "blocked",
			warning: "Configuration has not been loaded",
		},
		config: createDefaultConfig(),
		available: [],
		mode: "disabled",
		requestSequence: 0,
		phase: "ready",
		attemptKind: "initial",
		attemptGeneration: 0,
		nativeRetryPending: false,
		toolFailure: false,
		timeoutRequested: false,
		cooldowns: new Map(),
		manualRecovery: new Map(),
		unsupportedCacheFields: new Map(),
		contextFilterArmed: false,
		initialized: false,
		settling: false,
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
	messages: unknown,
): { stopReason?: string; message?: string } | undefined {
	if (!Array.isArray(messages)) return undefined;
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

function blockAfterPersistenceFailure(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	warning: string,
): void {
	runtime.configAccess = { kind: "blocked", warning };
	runtime.configRevision = undefined;
	runtime.mode = "disabled";
	runtime.request = undefined;
	runtime.pendingContinuation = undefined;
	runtime.contextFilterArmed = false;
	runtime.nativeRetryPending = false;
	runtime.timeoutRequested = false;
	runtime.respectedSelection = undefined;
	runtime.settling = false;
	runtime.lastStatus = undefined;
	runtime.lastFailure = undefined;
	runtime.toolFailure = false;
	runtime.internalSelection = undefined;
	runtime.phase = "cancelled";
	runtime.initialized = true;
	clearTimer(runtime);
	updateStatus(ctx, runtime);
}

async function persist(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	config: FailoverConfig,
): Promise<boolean> {
	if (runtime.configAccess.kind === "blocked" || !runtime.configRevision) {
		const warning =
			runtime.configAccess.kind === "blocked"
				? runtime.configAccess.warning
				: "Failover disabled: reload the configuration before saving again";
		notify(ctx, warning, "error");
		blockAfterPersistenceFailure(ctx, runtime, warning);
		return false;
	}
	const nextConfig: FailoverConfig = {
		...config,
		manualRecovery: Object.fromEntries(runtime.manualRecovery),
	};
	try {
		const result = await saveConfig(
			FAILOVER_CONFIG_PATH,
			nextConfig,
			runtime.configRevision,
		);
		if (result.kind === "conflict") {
			const warning = `Failover disabled: configuration changed at ${FAILOVER_CONFIG_PATH}; reload and review it before saving again`;
			notify(ctx, warning, "error");
			blockAfterPersistenceFailure(ctx, runtime, warning);
			return false;
		}
		const saved = await loadConfig(FAILOVER_CONFIG_PATH);
		if (
			saved.kind !== "loaded" ||
			JSON.stringify(saved.config) !== JSON.stringify(nextConfig)
		) {
			const warning = `Failover disabled: saved ${FAILOVER_CONFIG_PATH}, but its contents could not be verified; reload before continuing`;
			notify(ctx, warning, "error");
			blockAfterPersistenceFailure(ctx, runtime, warning);
			return false;
		}
		runtime.configRevision = saved.revision;
		runtime.config = nextConfig;
		updateStatus(ctx, runtime);
		return true;
	} catch (error) {
		const warning = `Failover disabled: could not save ${FAILOVER_CONFIG_PATH}: ${String(error)}`;
		notify(ctx, warning, "error");
		blockAfterPersistenceFailure(ctx, runtime, warning);
		return false;
	}
}

function configWarning(failure: ConfigLoadFailure): string {
	let action = "Repair or restore the configuration";
	if (failure.reason === "unreadable")
		action = "Fix permissions or storage access, or restore the file";
	else if (failure.reason === "future-version")
		action = "Upgrade the extension or restore a supported configuration";
	return `Failover disabled: ${FAILOVER_CONFIG_PATH}: ${failure.detail}. ${action}, then run /failover to reload`;
}

function automationMode(enabled: boolean, paused: boolean): AutomationMode {
	if (!enabled) return "disabled";
	return paused ? "paused" : "enabled";
}

function attemptKindFor(runtime: RuntimeState): ProgressAttemptKind {
	if (runtime.pendingContinuation) return "extension-continuation";
	if (runtime.nativeRetryPending) return "native-retry";
	return "initial";
}

async function refreshCatalog(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	allowRepair = false,
): Promise<void> {
	const loaded = await loadConfig(FAILOVER_CONFIG_PATH);
	const previousConfig = runtime.initialized
		? JSON.stringify(runtime.config)
		: undefined;
	const discovery = await discoverModels(
		ctx.modelRegistry as unknown as ModelRegistryReader,
	);
	const current = refOf(ctx.model);
	runtime.available = discovery.available;
	runtime.current = current;
	if (discovery.kind === "failure")
		notify(
			ctx,
			`Model catalog refresh failed: ${String(discovery.error)}`,
			"warning",
		);

	if (
		runtime.initialized &&
		runtime.configAccess.kind === "blocked" &&
		!allowRepair
	) {
		runtime.mode = "disabled";
		updateStatus(ctx, runtime);
		notify(ctx, runtime.configAccess.warning, "warning");
		return;
	}

	if (loaded.kind === "blocked") {
		const warning = configWarning(loaded.failure);
		runtime.config = createDefaultConfig();
		runtime.configRevision = undefined;
		runtime.configAccess = { kind: "blocked", warning };
		runtime.manualRecovery.clear();
		runtime.cooldowns.clear();
		runtime.unsupportedCacheFields.clear();
		runtime.request = undefined;
		runtime.pendingContinuation = undefined;
		runtime.nativeRetryPending = false;
		runtime.contextFilterArmed = false;
		runtime.respectedSelection = undefined;
		runtime.settling = false;
		runtime.lastStatus = undefined;
		runtime.lastFailure = undefined;
		runtime.toolFailure = false;
		runtime.timeoutRequested = false;
		clearTimer(runtime);
		runtime.mode = "disabled";
		runtime.initialized = true;
		updateStatus(ctx, runtime);
		notify(ctx, warning, "warning");
		return;
	}

	runtime.configRevision = loaded.revision;
	runtime.configAccess = { kind: "ready" };
	if (loaded.kind === "missing") {
		runtime.manualRecovery.clear();
		runtime.config = createDefaultConfig(seedModelList(current));
		if (!(await persist(ctx, runtime, runtime.config))) {
			const warning = `Failover disabled: first-run configuration could not be saved at ${FAILOVER_CONFIG_PATH}; fix access and run /failover to reload`;
			runtime.configAccess = { kind: "blocked", warning };
			runtime.request = undefined;
			runtime.pendingContinuation = undefined;
			runtime.nativeRetryPending = false;
			runtime.contextFilterArmed = false;
			runtime.respectedSelection = undefined;
			runtime.settling = false;
			runtime.lastStatus = undefined;
			runtime.lastFailure = undefined;
			runtime.toolFailure = false;
			runtime.timeoutRequested = false;
			clearTimer(runtime);
			runtime.mode = "disabled";
			runtime.initialized = true;
			updateStatus(ctx, runtime);
			return;
		}
	} else {
		runtime.config = loaded.config;
		if (
			previousConfig !== undefined &&
			previousConfig !== JSON.stringify(loaded.config)
		) {
			runtime.cooldowns.clear();
			runtime.unsupportedCacheFields.clear();
			runtime.respectedSelection = undefined;
		}
		runtime.manualRecovery = new Map(
			Object.entries(loaded.config.manualRecovery),
		);
		if (loaded.migrated && !(await persist(ctx, runtime, runtime.config))) return;
	}

	runtime.mode = automationMode(runtime.config.enabled, runtime.config.paused);
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
		!request ||
		!canArmProgressTimer(runtime.mode, runtime.phase, runtime.attemptKind, true)
	)
		return;
	const requestId = request.id;
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

async function selectPreferredHealthyModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RuntimeState,
): Promise<void> {
	if (runtime.mode !== "enabled" || !ctx.model) return;
	const now = Date.now();
	const currentKey = modelKey(ctx.model);
	for (const candidate of runtime.config.models) {
		const key = modelKey(candidate);
		if (runtime.manualRecovery.has(key)) continue;
		const cooldownUntil = runtime.cooldowns.get(key);
		if (cooldownUntil !== undefined && cooldownUntil > now) continue;
		if (key === currentKey) return;
		const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
		if (!model) continue;
		if (await setModelInternally(pi, ctx, runtime, model)) return;
	}
}

function transition(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	change: Omit<Transition, "at">,
): void {
	const { source, target, reason } = change;
	runtime.latestTransition = { ...change, at: Date.now() };
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
		transition(ctx, runtime, { source, target, reason });
		const model = ctx.modelRegistry.find(target.provider, target.id);
		if (!model) {
			runtime.manualRecovery.set(modelKey(target), "model unavailable");
			if (!(await persist(ctx, runtime, { ...runtime.config }))) return;
			continue;
		}
		runtime.phase = "switching";
		const selected = await setModelInternally(pi, ctx, runtime, model);
		if (!selected) {
			runtime.manualRecovery.set(modelKey(target), "authentication unavailable");
			if (!(await persist(ctx, runtime, { ...runtime.config }))) return;
			continue;
		}
		runtime.current = target;
		sendContinuation(pi, runtime, "switch", target);
		return;
	}
}

function finishSettledRequest(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	request: RequestState,
	kind: ReturnType<typeof classifyFailure>["kind"],
): boolean {
	if (kind === "none") {
		request.completed = true;
		runtime.phase = "succeeded";
		runtime.exhaustionSummary = undefined;
		updateStatus(ctx, runtime);
		return true;
	}
	if (isAutomaticFailure(kind)) return false;
	request.completed = true;
	runtime.phase = "cancelled";
	updateStatus(ctx, runtime);
	return true;
}

interface SettledFailureContext {
	ctx: ExtensionContext;
	runtime: RuntimeState;
	request: RequestState;
	source: ModelRef | undefined;
	result: ReturnType<typeof classifyFailure>;
}

async function recordSettledFailure(
	input: SettledFailureContext,
): Promise<boolean> {
	const { ctx, runtime, request, source, result } = input;
	recordFailure(request, source, result.reason);
	if (!source) return true;
	const key = modelKey(source);
	if (result.kind === "cooldown")
		runtime.cooldowns.set(
			key,
			Date.now() + runtime.config.cooldownMinutes * 60 * 1000,
		);
	if (result.kind !== "persistent") return true;
	runtime.manualRecovery.set(key, result.reason);
	return persist(ctx, runtime, { ...runtime.config });
}

function retryWithoutRejectedCacheFields(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RuntimeState,
	input: FailureInput,
): boolean {
	if (!isOpenAIRequestModel(ctx.model)) return false;
	const capabilityKey = cacheCapabilityKey(ctx.model);
	if (!capabilityKey) return false;
	const rejected = rejectedCacheFields(input);
	if (rejected.length === 0) return false;

	let unsupported = runtime.unsupportedCacheFields.get(capabilityKey);
	if (!unsupported) {
		unsupported = new Set();
		runtime.unsupportedCacheFields.set(capabilityKey, unsupported);
	}
	const newlyRejected = rejected.filter((field) => !unsupported.has(field));
	if (newlyRejected.length === 0) return false;
	for (const field of newlyRejected) unsupported.add(field);

	const source = runtime.current ?? runtime.request?.activeModel;
	if (source) {
		transition(ctx, runtime, {
			source,
			target: source,
			reason: `${newlyRejected.join(", ")} rejected, retrying without it`,
		});
	}
	sendContinuation(
		pi,
		runtime,
		"same",
		source ?? { provider: "unknown", id: "unknown" },
	);
	return true;
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
		runtime.mode !== "enabled" ||
		runtime.settling ||
		runtime.phase !== "requesting"
	)
		return;
	runtime.settling = true;

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

	const request = runtime.request;
	if (finishSettledRequest(ctx, runtime, request, result.kind)) return;

	const source = runtime.current ?? request.activeModel;
	if (retryWithoutRejectedCacheFields(pi, ctx, runtime, input)) return;
	if (!(await recordSettledFailure({ ctx, runtime, request, source, result })))
		return;

	if (
		shouldRetryCurrentModel(result.kind, runtime.config.errorHandlingMode) &&
		request.sameModelRetries < runtime.config.maxRetries
	) {
		request.sameModelRetries++;
		if (source) {
			transition(ctx, runtime, {
				source,
				target: source,
				reason: `${result.reason}, retry ${request.sameModelRetries}/${runtime.config.maxRetries}`,
			});
		}
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

async function moveFailoverModel(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	index: number,
	direction: -1 | 1,
): Promise<void> {
	const target = index + direction;
	if (index < 0 || target < 0 || target >= runtime.config.models.length) return;
	const models = [...runtime.config.models];
	const current = models[index];
	const next = models[target];
	if (!current || !next) return;
	[models[index], models[target]] = [next, current];
	await persist(ctx, runtime, { ...runtime.config, models });
}

async function selectFailoverModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RuntimeState,
	model: ModelRef,
): Promise<void> {
	const selected = ctx.modelRegistry.find(model.provider, model.id);
	if (!selected || !(await setModelInternally(pi, ctx, runtime, selected))) {
		notify(
			ctx,
			`Model is not currently available: ${modelKey(model)}`,
			"warning",
		);
		return;
	}
	await markManualPause(ctx, runtime);
}

function nextAutomationMode(mode: AutomationMode): AutomationMode {
	switch (mode) {
		case "enabled":
			return "paused";
		case "paused":
			return "disabled";
		case "disabled":
			return "enabled";
		default:
			return "enabled";
	}
}

async function cycleFailoverMode(
	ctx: ExtensionContext,
	runtime: RuntimeState,
): Promise<void> {
	runtime.mode = nextAutomationMode(runtime.mode);
	await persist(ctx, runtime, {
		...runtime.config,
		enabled: runtime.mode !== "disabled",
		paused: runtime.mode === "paused",
	});
}

async function setCooldownMinutes(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	value: string,
): Promise<void> {
	const minutes = Number(value.trim());
	if (!isValidCooldownMinutes(minutes)) {
		notify(ctx, "Cooldown must be an integer from 0 to 1440 minutes", "warning");
		return;
	}
	await persist(ctx, runtime, { ...runtime.config, cooldownMinutes: minutes });
}

async function setMaxRetries(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	value: string,
): Promise<void> {
	const maxRetries = Number(value.trim());
	if (!isValidMaxRetries(maxRetries)) {
		notify(ctx, "Max retries must be an integer from 0 to 10", "warning");
		return;
	}
	await persist(ctx, runtime, { ...runtime.config, maxRetries });
}

async function setNoProgressTimeout(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	value: string,
): Promise<void> {
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
}

async function restoreFailover(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RuntimeState,
): Promise<void> {
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
	const saved = await persist(ctx, runtime, {
		...runtime.config,
		enabled: true,
		paused: false,
	});
	if (!saved) return;
	updateStatus(ctx, runtime);
	notify(ctx, "Failover automation restored", "info");
}

function syncNativeThinkingLevel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RuntimeState,
): void {
	if (
		runtime.configAccess.kind !== "ready" ||
		!modelParameterToggles(runtime.config, ctx.model).reasoningEffort
	)
		return;
	const setThinkingLevel = (
		pi as unknown as { setThinkingLevel?: (level: string) => void }
	).setThinkingLevel;
	if (typeof setThinkingLevel === "function")
		setThinkingLevel.call(pi, resolveReasoningEffort(runtime.config, ctx.model));
}

function createFailoverActions(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RuntimeState,
	done: () => void,
): FailoverTuiActions {
	return {
		onClose: done,
		onError: (error) =>
			notify(ctx, `Failover action failed: ${String(error)}`, "error"),
		onAdd: async (model) => {
			clearModelRuntimeState(runtime, modelKey(model));
			await persist(ctx, runtime, {
				...runtime.config,
				models: [...runtime.config.models, { ...model }],
			});
		},
		onRemove: async (index) => {
			const removed = runtime.config.models[index];
			if (!removed) return;
			const removedKey = modelKey(removed);
			const modelParameters = { ...runtime.config.modelParameters };
			const modelReasoningEfforts = {
				...runtime.config.modelReasoningEfforts,
			};
			delete modelParameters[removedKey];
			delete modelReasoningEfforts[removedKey];
			clearModelRuntimeState(runtime, removedKey);
			const saved = await persist(ctx, runtime, {
				...runtime.config,
				models: runtime.config.models.filter(
					(_model, modelIndex) => modelIndex !== index,
				),
				modelParameters,
				modelReasoningEfforts,
			});
			if (saved && ctx.model && modelKey(ctx.model) === removedKey)
				syncNativeThinkingLevel(pi, ctx, runtime);
		},
		onMove: (index, direction) =>
			moveFailoverModel(ctx, runtime, index, direction),
		onSelect: (model) => selectFailoverModel(pi, ctx, runtime, model),
		onToggleEnabled: () => cycleFailoverMode(ctx, runtime),
		onSetCooldownMinutes: (value) => setCooldownMinutes(ctx, runtime, value),
		onSetErrorHandlingMode: async (errorHandlingMode) => {
			await persist(ctx, runtime, { ...runtime.config, errorHandlingMode });
		},
		onSetMaxRetries: (value) => setMaxRetries(ctx, runtime, value),
		onSetTimeout: (value) => setNoProgressTimeout(ctx, runtime, value),
		onSetReasoningEffort: async (reasoningEffort) => {
			const saved = await persist(ctx, runtime, {
				...runtime.config,
				reasoningEffort,
			});
			if (saved) {
				syncNativeThinkingLevel(pi, ctx, runtime);
				notify(ctx, `Reasoning effort set to ${reasoningEffort}`, "info");
			}
		},
		onSetModelReasoningEffort: async (model, reasoningEffort) => {
			const key = modelKey(model);
			const previous = runtime.config.modelReasoningEfforts[key];
			const modelReasoningEfforts = {
				...runtime.config.modelReasoningEfforts,
			};
			if (reasoningEffort === undefined) delete modelReasoningEfforts[key];
			else modelReasoningEfforts[key] = reasoningEffort;
			const saved = await persist(ctx, runtime, {
				...runtime.config,
				modelReasoningEfforts,
			});
			if (
				saved &&
				previous !== reasoningEffort &&
				ctx.model &&
				modelKey(ctx.model) === key
			)
				syncNativeThinkingLevel(pi, ctx, runtime);
		},
		onSetModelParameter: async (
			model,
			parameter: ModelParameterName,
			enabled,
		) => {
			const key = modelKey(model);
			const current = runtime.config.modelParameters[key] ?? {};
			const saved = await persist(ctx, runtime, {
				...runtime.config,
				modelParameters: {
					...runtime.config.modelParameters,
					[key]: { ...DEFAULT_PARAMETER_TOGGLES, ...current, [parameter]: enabled },
				},
			});
			if (saved && parameter === "reasoningEffort" && enabled)
				syncNativeThinkingLevel(pi, ctx, runtime);
		},
		onRestore: () => restoreFailover(pi, ctx, runtime),
	};
}

function registerProviderEvents(pi: ExtensionAPI, runtime: RuntimeState): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (runtime.configAccess.kind !== "ready" || !isRecord(event)) return;
		applyOpenAIRequestParameters(event.payload, ctx, runtime);
	});
	pi.on("before_provider_headers", (event, ctx) => {
		if (runtime.configAccess.kind !== "ready" || !isRecord(event)) return;
		if (!isRecord(event.headers)) return;
		replaceOpenAISessionHeaders(
			event.headers as Record<string, string | null>,
			ctx,
			runtime,
		);
	});
}

function registerSessionEvents(pi: ExtensionAPI, runtime: RuntimeState): void {
	pi.on("session_start", async (_event, ctx) => {
		await refreshCatalog(ctx, runtime);
		if (runtime.configAccess.kind === "ready") {
			await selectPreferredHealthyModel(pi, ctx, runtime);
			syncNativeThinkingLevel(pi, ctx, runtime);
		}
	});
	pi.on("context", (event) => {
		if (!runtime.contextFilterArmed || !isRecord(event)) return;
		runtime.contextFilterArmed = false;
		if (!Array.isArray(event.messages)) return;
		const messages = [...event.messages];
		for (let index = messages.length - 1; index >= 0; index--) {
			if (isFailedAssistantMessage(messages[index])) {
				messages.splice(index, 1);
				break;
			}
		}
		return { messages };
	});
	pi.on("session_shutdown", () => {
		clearTimer(runtime);
		runtime.request = undefined;
		runtime.pendingContinuation = undefined;
		runtime.contextFilterArmed = false;
		runtime.nativeRetryPending = false;
		runtime.timeoutRequested = false;
		runtime.respectedSelection = undefined;
		runtime.settling = false;
		runtime.lastStatus = undefined;
		runtime.lastFailure = undefined;
		runtime.toolFailure = false;
		runtime.internalSelection = undefined;
		runtime.phase = "ready";
	});
	pi.on("model_select", async (event, ctx) => {
		if (!isRecord(event) || !event.model || typeof event.model !== "object")
			return;
		const selected = refOf(event.model as ExtensionContext["model"]);
		runtime.current = selected;
		if (
			runtime.internalSelection === (selected ? modelKey(selected) : undefined)
		) {
			updateStatus(ctx, runtime);
			syncNativeThinkingLevel(pi, ctx, runtime);
			return;
		}
		if (event.source === "restore" && selected) {
			runtime.respectedSelection = modelKey(selected);
		} else if (event.source === "set" || event.source === "cycle") {
			runtime.respectedSelection = undefined;
			await markManualPause(ctx, runtime);
		}
		updateStatus(ctx, runtime);
		syncNativeThinkingLevel(pi, ctx, runtime);
	});
}

function registerAgentEvents(pi: ExtensionAPI, runtime: RuntimeState): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		clearTimer(runtime);
		if (runtime.configAccess.kind === "blocked") {
			runtime.request = undefined;
			return;
		}
		if (runtime.pendingContinuation) {
			runtime.lastStatus = undefined;
			runtime.lastFailure = undefined;
			runtime.toolFailure = false;
			runtime.timeoutRequested = false;
			runtime.settling = false;
			runtime.phase = "ready";
			runtime.attemptGeneration++;
			return;
		}
		runtime.contextFilterArmed = false;
		let currentKey: string | undefined;
		if (runtime.current) currentKey = modelKey(runtime.current);
		else if (ctx.model) currentKey = modelKey(ctx.model);
		const respectSelection =
			currentKey !== undefined && runtime.respectedSelection === currentKey;
		runtime.respectedSelection = undefined;
		if (!respectSelection) await selectPreferredHealthyModel(pi, ctx, runtime);
		runtime.request = createRequestState(
			++runtime.requestSequence,
			runtime.current ?? refOf(ctx.model),
		);
		runtime.settling = false;
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
	pi.on("agent_start", (_event, ctx) => {
		if (!runtime.request || runtime.mode !== "enabled") return;
		runtime.attemptKind = attemptKindFor(runtime);
		runtime.pendingContinuation = undefined;
		runtime.nativeRetryPending = false;
		runtime.attemptGeneration++;
		runtime.phase = "requesting";
		runtime.lastStatus = undefined;
		runtime.lastFailure = undefined;
		runtime.timeoutRequested = false;
		startProgressTimer(ctx, runtime);
	});
	pi.on("after_provider_response", (event, ctx) => {
		if (!runtime.request || runtime.phase !== "requesting" || !isRecord(event))
			return;
		runtime.lastStatus =
			typeof event.status === "number" ? event.status : undefined;
		noteProgress(ctx, runtime);
	});
	pi.on("agent_end", (event) => {
		if (!runtime.request || !isRecord(event)) return;
		runtime.lastFailure = failureFromMessages(event.messages);
		clearTimer(runtime);
		runtime.nativeRetryPending =
			Boolean(runtime.lastFailure) &&
			!runtime.toolFailure &&
			!runtime.timeoutRequested &&
			runtime.mode === "enabled";
	});
	pi.on("message_update", (_event, ctx) => noteProgress(ctx, runtime));
	pi.on("turn_start", (_event, ctx) => noteProgress(ctx, runtime));
	pi.on("tool_execution_start", (_event, ctx) => noteProgress(ctx, runtime));
	pi.on("tool_execution_end", (event, ctx) => {
		if (isRecord(event) && event.isError === true) runtime.toolFailure = true;
		noteProgress(ctx, runtime);
	});
	pi.on("agent_settled", (_event, ctx) => handleSettled(pi, ctx, runtime));
}

function registerFailoverCommand(
	pi: ExtensionAPI,
	runtime: RuntimeState,
): void {
	pi.registerCommand("failover", {
		description: "Configure Pi model failover",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "/failover requires interactive TUI mode", "warning");
				return;
			}
			await refreshCatalog(ctx, runtime, true);
			if (runtime.configAccess.kind === "blocked") return;
			syncNativeThinkingLevel(pi, ctx, runtime);
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const actions = createFailoverActions(pi, ctx, runtime, () => done());
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

export default function modelFailoverExtension(pi: ExtensionAPI): void {
	const runtime = initialRuntime();
	registerProviderEvents(pi, runtime);
	registerSessionEvents(pi, runtime);
	registerAgentEvents(pi, runtime);
	registerFailoverCommand(pi, runtime);
}
