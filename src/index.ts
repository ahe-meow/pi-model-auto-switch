import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { uniqueModels } from "./catalog.ts";
import { isValidMaxRetries, isValidTimeoutSeconds } from "./config.ts";
import {
	copyGeneratedConfigV8,
	createGeneratedConfigV8,
	loadGeneratedConfigV8,
	saveGeneratedConfigV8,
	validateGeneratedConfigV8,
	type GeneratedConfigV8LoadResult,
} from "./generated-config.ts";
import type { ConfigSourceRevision } from "./json-file.ts";
import {
	FAILOVER_PROVIDER_ID,
	type TargetCatalogMetadata,
} from "./models-catalog.ts";
import {
	createFailoverProvider,
	type AssistantMessageEventStreamLike,
	type AssistantMessageLike,
	type Delegate,
	type FailoverChainModel,
	type FailoverProviderState,
	type TargetModelLike,
} from "./provider.ts";
import {
	createFileSharedState,
	type Inheritable,
	type LegacyTargetCandidate,
	type ReconcileRegistrationResult,
	type SharedChainSettingsPatch,
	type SharedCoordinationStatus,
	type SharedScopeRegistration,
	type SharedStateAdapter,
	type SharedStateDocument,
	type SharedTargetOverridePatch,
	type SharedTargetSettingsPatch,
} from "./shared-state.ts";
import {
	FailoverEditor,
	FailoverHistoryPanel,
	type FailoverTuiActions,
	type FailoverTuiView,
} from "./tui.ts";
import {
	modelKey,
	REASONING_EFFORTS,
	type ErrorHandlingMode,
	type GeneratedFailoverConfigV8,
	type GeneratedFailoverModelV8,
	type ModelParameterName,
	type ModelRef,
	type ReasoningEffort,
} from "./types.ts";

export const FAILOVER_CONFIG_PATH = join(getAgentDir(), "model-failover.json");
export const MODELS_JSON_PATH = join(getAgentDir(), "models.json");

const AGENT_DIRECTORY = resolve(getAgentDir());
const FAILOVER_TRANSITION_ENTRY_TYPE = "pi-model-failover/transition-v1";
const MAX_HISTORY_ENTRIES = 100;
const MAX_HISTORY_MODEL_REF_LENGTH = 256;
const MAX_HISTORY_REASON_LENGTH = 256;
const MAX_HISTORY_MAPPED_EFFORT_LENGTH = 256;
const MAX_HISTORY_TIMESTAMP = 8_640_000_000_000_000;
const MAX_GENERATED_ID_LENGTH = 64;
const MAX_GENERATED_NAME_LENGTH = 120;

type FailoverTargetStatus =
	NonNullable<FailoverProviderState["onTarget"]> extends (
		target: infer Target,
	) => void
		? Target
		: never;
type FailoverTransition =
	NonNullable<FailoverProviderState["onTransition"]> extends (
		transition: infer Transition,
	) => void
		? Transition
		: never;
type FailoverHistoryEntry = FailoverTransition & { timestamp: number };

interface TargetModelRecord extends TargetModelLike {
	input?: readonly ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
}

export interface TargetRuntime {
	initialAvailabilityKnown?: boolean;
	getModel(provider: string, modelId: string): TargetModelRecord | undefined;
	getAvailableSnapshot(): readonly TargetModelRecord[];
	hasConfiguredAuth(provider: string): boolean;
	refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
	completeSimple(
		model: TargetModelRecord,
		context: unknown,
		options: unknown,
	): Promise<AssistantMessageLike>;
	streamSimple(
		model: TargetModelRecord,
		context: unknown,
		options: unknown,
	): AssistantMessageEventStreamLike;
}

export interface RegisterFailoverExtensionOptions {
	targetRuntime?: TargetRuntime;
	sharedState?: SharedStateAdapter;
}

interface RuntimeState {
	config: GeneratedFailoverConfigV8;
	chainRevision: ConfigSourceRevision;
	chainBlocked: string | undefined;
	chainWarning: string | undefined;
	targetRuntime: TargetRuntime;
	sharedState: SharedStateAdapter;
	sharedSnapshot: SharedStateDocument;
	sharedStatus: SharedCoordinationStatus;
	providerState: FailoverProviderState;
	warnings: string[];
	history: FailoverHistoryEntry[];
	currentTarget: FailoverTargetStatus | undefined;
	lastTransition: FailoverTransition | undefined;
	sessionContext: ExtensionContext | undefined;
	sessionPersistable: boolean;
}

function scopeKeyForModel(id: string): string {
	return `${encodeURIComponent(AGENT_DIRECTORY)}:${id}`;
}

function providerModels(
	config: GeneratedFailoverConfigV8,
): FailoverChainModel[] {
	return config.models.map((model) => ({
		...model,
		chain: model.chain.map((target) => ({ ...target })),
		scopeKey: scopeKeyForModel(model.id),
	}));
}

function scopeRegistrations(
	config: GeneratedFailoverConfigV8,
): SharedScopeRegistration[] {
	return config.models.map((model) => ({
		key: scopeKeyForModel(model.id),
		targets: model.chain.map((target) => ({ ...target })),
	}));
}

function footerThinking(target: FailoverTargetStatus): string {
	if (!target.reasoningControlled) return "inherited";
	if (!target.mappedEffort) return "unsupported";
	if (target.mappedEffort === "none") return "off";
	return target.mappedEffort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHistoryString(
	value: unknown,
	maxLength: number,
): string | undefined {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maxLength ||
		/[\u0000-\u001f\u007f-\u009f]/.test(value)
	)
		return undefined;
	return value;
}

function readHistoryModelRef(value: unknown): ModelRef | undefined {
	if (!isRecord(value)) return undefined;
	const provider = readHistoryString(
		value.provider,
		MAX_HISTORY_MODEL_REF_LENGTH,
	);
	const id = readHistoryString(value.id, MAX_HISTORY_MODEL_REF_LENGTH);
	return provider && id ? { provider, id } : undefined;
}

function readHistoryEntry(value: unknown): FailoverHistoryEntry | undefined {
	if (!isRecord(value)) return undefined;
	const modelId = readHistoryString(value.modelId, MAX_GENERATED_ID_LENGTH);
	const target = readHistoryModelRef(value.target);
	const source =
		value.source === undefined ? undefined : readHistoryModelRef(value.source);
	const reason = readHistoryString(value.reason, MAX_HISTORY_REASON_LENGTH);
	const mappedEffort =
		value.mappedEffort === undefined
			? undefined
			: readHistoryString(value.mappedEffort, MAX_HISTORY_MAPPED_EFFORT_LENGTH);
	if (
		!modelId ||
		!target ||
		(value.source !== undefined && !source) ||
		!reason ||
		(value.mappedEffort !== undefined && !mappedEffort) ||
		typeof value.reasoningControlled !== "boolean" ||
		!REASONING_EFFORTS.includes(value.effort as ReasoningEffort) ||
		!Number.isSafeInteger(value.timestamp) ||
		(value.timestamp as number) < 0 ||
		(value.timestamp as number) > MAX_HISTORY_TIMESTAMP
	)
		return undefined;
	return {
		modelId,
		target,
		effort: value.effort as ReasoningEffort,
		reasoningControlled: value.reasoningControlled,
		...(mappedEffort === undefined ? {} : { mappedEffort }),
		...(source === undefined ? {} : { source }),
		reason,
		timestamp: value.timestamp as number,
	};
}

function historyEntryForTransition(
	transition: FailoverTransition,
	timestamp: number,
): FailoverHistoryEntry | undefined {
	return readHistoryEntry({
		modelId: transition.modelId,
		target: {
			provider: transition.target.provider,
			id: transition.target.id,
		},
		effort: transition.effort,
		reasoningControlled: transition.reasoningControlled,
		...(transition.mappedEffort === undefined
			? {}
			: { mappedEffort: transition.mappedEffort }),
		...(transition.source === undefined
			? {}
			: {
					source: {
						provider: transition.source.provider,
						id: transition.source.id,
					},
				}),
		reason: transition.reason,
		timestamp,
	});
}

function restoreHistory(entries: readonly unknown[]): FailoverHistoryEntry[] {
	const history: FailoverHistoryEntry[] = [];
	const seen = new Set<string>();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const sessionEntry = entries[index];
		if (
			!isRecord(sessionEntry) ||
			sessionEntry.type !== "custom" ||
			sessionEntry.customType !== FAILOVER_TRANSITION_ENTRY_TYPE
		)
			continue;
		const historyEntry = readHistoryEntry(sessionEntry.data);
		if (!historyEntry) continue;
		const key = JSON.stringify(historyEntry);
		if (seen.has(key)) continue;
		seen.add(key);
		history.push(historyEntry);
		if (history.length === MAX_HISTORY_ENTRIES) break;
	}
	return history;
}

function setFooterStatus(ctx: ExtensionContext, runtime: RuntimeState): void {
	const current = runtime.currentTarget;
	if (!current) return;
	const transition = runtime.lastTransition;
	let transitionText = "";
	if (
		transition &&
		transition.modelId === current.modelId &&
		modelKey(transition.target) === modelKey(current.target)
	) {
		const source = transition.source ? modelKey(transition.source) : "start";
		transitionText = `${source} → ${modelKey(transition.target)} (${transition.reason}) | `;
	}
	ctx.ui.setStatus(
		"failover",
		`${transitionText}real ${modelKey(current.target)} | thinking ${footerThinking(current)}`,
	);
}

function installProviderCallbacks(
	pi: ExtensionAPI,
	runtime: RuntimeState,
): void {
	runtime.providerState.onTarget = (target) => {
		runtime.currentTarget = target;
		if (runtime.sessionContext) setFooterStatus(runtime.sessionContext, runtime);
	};
	runtime.providerState.onTransition = (transition) => {
		runtime.lastTransition = transition;
		runtime.currentTarget = transition;
		const entry = historyEntryForTransition(transition, Date.now());
		if (entry) {
			runtime.history.unshift(entry);
			if (runtime.history.length > MAX_HISTORY_ENTRIES)
				runtime.history.length = MAX_HISTORY_ENTRIES;
		}
		if (runtime.sessionContext) setFooterStatus(runtime.sessionContext, runtime);
		if (entry && runtime.sessionPersistable)
			pi.appendEntry(FAILOVER_TRANSITION_ENTRY_TYPE, entry);
	};
}

function refreshHasErrors(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	const errors = (result as { errors?: unknown }).errors;
	return Boolean(
		errors &&
			typeof errors === "object" &&
			typeof (errors as { size?: unknown }).size === "number" &&
			(errors as { size: number }).size > 0,
	);
}

async function createOwnedTargetRuntime(): Promise<TargetRuntime> {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(getAgentDir(), "auth.json"),
		modelsPath: MODELS_JSON_PATH,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const refreshResult = await modelRuntime.refresh({ allowNetwork: false });
	// SAFETY: ModelRuntime implements this structural interface; the cast avoids
	// importing Pi's nested model package at the extension seam.
	const targetRuntime = modelRuntime as unknown as TargetRuntime;
	targetRuntime.initialAvailabilityKnown = !refreshHasErrors(refreshResult);
	return targetRuntime;
}

function collectMetadata(
	config: { models: readonly FailoverChainModel[] },
	targetRuntime: TargetRuntime,
): TargetCatalogMetadata[] {
	const seen = new Map<string, TargetCatalogMetadata>();
	for (const model of config.models) {
		for (const target of model.chain) {
			const key = modelKey(target);
			if (seen.has(key) || target.provider === FAILOVER_PROVIDER_ID) continue;
			const real = targetRuntime.getModel(target.provider, target.id);
			seen.set(key, {
				ref: { ...target },
				input: real?.input ? [...real.input] : undefined,
				reasoning: real?.reasoning,
				thinkingLevelMap: real?.thinkingLevelMap,
				contextWindow: real?.contextWindow,
				maxTokens: real?.maxTokens,
			});
		}
	}
	return [...seen.values()];
}

function collectAvailableKeys(
	config: { models: readonly FailoverChainModel[] },
	targetRuntime: TargetRuntime,
): Set<string> {
	const keys = new Set<string>();
	for (const model of config.models) {
		for (const target of model.chain) {
			if (target.provider === FAILOVER_PROVIDER_ID) continue;
			const real = targetRuntime.getModel(target.provider, target.id);
			if (real && targetRuntime.hasConfiguredAuth(target.provider))
				keys.add(modelKey(target));
		}
	}
	return keys;
}

function availableTargets(targetRuntime: TargetRuntime): ModelRef[] {
	return uniqueModels(targetRuntime.getAvailableSnapshot()).filter(
		(target) => target.provider !== FAILOVER_PROVIDER_ID,
	);
}

function uniqueChainTargets(config: {
	models: readonly FailoverChainModel[];
}): ModelRef[] {
	const targets = new Map<string, ModelRef>();
	for (const model of config.models) {
		for (const target of model.chain) {
			if (!targets.has(modelKey(target)))
				targets.set(modelKey(target), { ...target });
		}
	}
	return [...targets.values()];
}

function queueWarning(runtime: RuntimeState, warning: string): void {
	if (!runtime.warnings.includes(warning)) runtime.warnings.push(warning);
}

function coordinationWarning(
	status: SharedCoordinationStatus,
): string | undefined {
	if (status.coordination === "shared") return undefined;
	return `Shared failover coordination is degraded (${status.reason}); automation and writes are blocked until shared state is repaired. Repair the shared state file, then reopen /failover or restart.`;
}

function rememberCoordinationWarning(runtime: RuntimeState): void {
	const warning = coordinationWarning(runtime.sharedStatus);
	if (warning) queueWarning(runtime, warning);
}

async function refreshSharedSnapshot(runtime: RuntimeState): Promise<boolean> {
	try {
		const snapshot = await runtime.sharedState.snapshot();
		runtime.sharedSnapshot = snapshot.document;
		runtime.sharedStatus = snapshot.status;
		rememberCoordinationWarning(runtime);
		return true;
	} catch {
		queueWarning(
			runtime,
			"Shared failover state could not be refreshed; automation and writes remain blocked while the last safe snapshot is shown.",
		);
		return false;
	}
}

function applyConfig(
	runtime: RuntimeState,
	config: GeneratedFailoverConfigV8,
	revision: ConfigSourceRevision,
): void {
	const copy = copyGeneratedConfigV8(config);
	runtime.config = copy;
	runtime.chainRevision = revision;
	runtime.chainBlocked = undefined;
	runtime.providerState.config = { models: providerModels(copy) };
	runtime.providerState.metadata = collectMetadata(copy, runtime.targetRuntime);
	runtime.providerState.availableTargetKeys = collectAvailableKeys(
		copy,
		runtime.targetRuntime,
	);
}

async function refreshOwnedTargetRuntime(
	runtime: RuntimeState,
): Promise<boolean> {
	try {
		const result = await runtime.targetRuntime.refresh({ allowNetwork: false });
		const healthy = !refreshHasErrors(result);
		runtime.providerState.availabilityKnown = healthy;
		if (healthy) {
			runtime.providerState.metadata = collectMetadata(
				runtime.config,
				runtime.targetRuntime,
			);
			runtime.providerState.availableTargetKeys = collectAvailableKeys(
				runtime.config,
				runtime.targetRuntime,
			);
		}
		return healthy;
	} catch {
		runtime.providerState.availabilityKnown = false;
		return false;
	}
}

async function reconcileRegistration(
	runtime: RuntimeState,
	config: GeneratedFailoverConfigV8,
	legacyCandidates?: readonly LegacyTargetCandidate[],
): Promise<ReconcileRegistrationResult> {
	const input = {
		agentDirectory: AGENT_DIRECTORY,
		targets: uniqueChainTargets(config),
		scopes: scopeRegistrations(config),
		...(legacyCandidates ? { legacyCandidates } : {}),
	};
	let result = await runtime.sharedState.reconcileRegistration(input);
	await refreshSharedSnapshot(runtime);
	if (
		result.coordination === "degraded" &&
		runtime.sharedStatus.coordination === "shared"
	) {
		result = await runtime.sharedState.reconcileRegistration(input);
		await refreshSharedSnapshot(runtime);
	}
	if (result.coordination === "degraded") rememberCoordinationWarning(runtime);
	return result;
}

async function reconcileApplyAndRefresh(
	runtime: RuntimeState,
	config: GeneratedFailoverConfigV8,
	revision: ConfigSourceRevision,
): Promise<boolean> {
	const registration = await reconcileRegistration(runtime, config);
	if (
		registration.kind !== "reconciled" ||
		registration.coordination !== "shared"
	) {
		queueWarning(
			runtime,
			"Failover target registration was rejected; the new chain configuration was not applied in this process.",
		);
		return false;
	}
	applyConfig(runtime, config, revision);
	await refreshOwnedTargetRuntime(runtime);
	return true;
}

function initialRuntime(
	targetRuntime: TargetRuntime,
	sharedState: SharedStateAdapter,
	sharedSnapshot: SharedStateDocument,
	sharedStatus: SharedCoordinationStatus,
): RuntimeState {
	const config = createGeneratedConfigV8([]);
	const providerState: FailoverProviderState = {
		config: { models: providerModels(config) },
		metadata: [],
		// SAFETY: the real delegate is installed synchronously before startup work
		// or provider registration can expose this state.
		delegate: null as unknown as Delegate,
		availableTargetKeys: new Set(),
		availabilityKnown: targetRuntime.initialAvailabilityKnown ?? false,
		cooldowns: new Map(),
		cooldownLevels: new Map(),
		manualRecovery: new Map(),
		unsupportedCacheFields: new Map(),
		sharedState,
	};
	return {
		config,
		chainRevision: { kind: "absent" },
		chainBlocked: undefined,
		chainWarning: undefined,
		targetRuntime,
		sharedState,
		sharedSnapshot,
		sharedStatus,
		providerState,
		warnings: [],
		history: [],
		currentTarget: undefined,
		lastTransition: undefined,
		sessionContext: undefined,
		sessionPersistable: false,
	};
}

async function applyLegacyConfig(
	runtime: RuntimeState,
	loaded: Extract<GeneratedConfigV8LoadResult, { kind: "legacy" }>,
): Promise<void> {
	const migrationWarning =
		"Legacy failover migration is blocked; model-failover.json was preserved and provider routing and editing remain disabled. Repair shared failover state or resolve file write conflicts, then restart.";
	const blockMigration = (): void => {
		blockChain(runtime, "legacy migration could not be verified", {
			config: loaded.v8,
			revision: loaded.revision,
		});
		queueWarning(runtime, migrationWarning);
	};
	const registration = await reconcileRegistration(
		runtime,
		loaded.v8,
		loaded.candidates,
	);
	if (
		registration.kind !== "reconciled" ||
		registration.coordination !== "shared"
	) {
		blockMigration();
		return;
	}

	let saved: Awaited<ReturnType<typeof saveGeneratedConfigV8>>;
	try {
		saved = await saveGeneratedConfigV8(
			FAILOVER_CONFIG_PATH,
			loaded.v8,
			loaded.revision,
		);
	} catch {
		blockMigration();
		return;
	}
	if (saved.kind !== "saved") {
		blockMigration();
		return;
	}

	const authoritative = await loadGeneratedConfigV8(FAILOVER_CONFIG_PATH);
	if (authoritative.kind !== "loaded-v8") {
		blockMigration();
		return;
	}
	if (
		!(await reconcileApplyAndRefresh(
			runtime,
			authoritative.config,
			authoritative.revision,
		))
	) {
		blockChain(runtime, "target registration could not be verified", {
			config: authoritative.config,
			revision: authoritative.revision,
		});
		queueWarning(
			runtime,
			"The migrated v8 chain is blocked because shared target registration could not be verified. Repair shared failover state, then restart.",
		);
	}
}

async function loadAndApplyInitialConfig(runtime: RuntimeState): Promise<void> {
	let loaded = await loadGeneratedConfigV8(FAILOVER_CONFIG_PATH);
	if (loaded.kind === "missing") {
		const empty = createGeneratedConfigV8([]);
		const missingRevision = loaded.revision;
		try {
			const saved = await saveGeneratedConfigV8(
				FAILOVER_CONFIG_PATH,
				empty,
				missingRevision,
			);
			if (saved.kind === "saved") {
				loaded = await loadGeneratedConfigV8(FAILOVER_CONFIG_PATH);
			} else {
				loaded = await loadGeneratedConfigV8(FAILOVER_CONFIG_PATH);
				if (loaded.kind === "missing") {
					queueWarning(
						runtime,
						"The initial v8 chain file could not be created because the path changed concurrently.",
					);
					await reconcileApplyAndRefresh(runtime, empty, loaded.revision);
					return;
				}
			}
		} catch {
			queueWarning(
				runtime,
				"The initial v8 chain file could not be written; failover is running with an empty in-memory chain.",
			);
			await reconcileApplyAndRefresh(runtime, empty, missingRevision);
			return;
		}
	}

	if (loaded.kind === "loaded-v8") {
		if (
			!(await reconcileApplyAndRefresh(runtime, loaded.config, loaded.revision))
		) {
			blockChain(runtime, "target registration could not be verified", {
				config: loaded.config,
				revision: loaded.revision,
			});
			queueWarning(
				runtime,
				"Failover target registration failed; the loaded chain was not applied and editing is disabled until shared state is repaired.",
			);
		}
		return;
	}
	if (loaded.kind === "legacy") {
		await applyLegacyConfig(runtime, loaded);
		return;
	}
	if (loaded.kind === "missing") {
		await reconcileApplyAndRefresh(
			runtime,
			createGeneratedConfigV8([]),
			loaded.revision,
		);
		return;
	}

	loadBlockedConfig(runtime, loaded.reason);
}

type BlockedConfigReason = Extract<
	GeneratedConfigV8LoadResult,
	{ kind: "blocked" }
>["reason"];

function blockedConfigDescription(reason: BlockedConfigReason): string {
	switch (reason) {
		case "malformed":
			return "the configuration file is malformed";
		case "invalid":
			return "the configuration format is invalid";
		case "unreadable":
			return "the configuration file is unavailable";
		case "future-version":
			return "the configuration uses an unsupported future version";
		default:
			return "the configuration is blocked for an unknown reason";
	}
}

function blockChain(
	runtime: RuntimeState,
	description: string,
	preserved?: {
		config: GeneratedFailoverConfigV8;
		revision: ConfigSourceRevision;
	},
): void {
	runtime.chainBlocked = description;
	if (preserved) {
		runtime.config = copyGeneratedConfigV8(preserved.config);
		runtime.chainRevision = preserved.revision;
	} else {
		runtime.chainRevision = { kind: "absent" };
		runtime.config = createGeneratedConfigV8([]);
	}
	runtime.providerState.config = { models: [] };
	runtime.providerState.metadata = [];
	runtime.providerState.availableTargetKeys = new Set();
}

function loadBlockedConfig(
	runtime: RuntimeState,
	reason: BlockedConfigReason,
): void {
	blockChain(runtime, blockedConfigDescription(reason));
}

function notify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	ctx.ui.notify(message, type);
}

function notifyPendingWarnings(
	ctx: ExtensionContext,
	runtime: RuntimeState,
): void {
	for (const warning of runtime.warnings.splice(0))
		notify(ctx, warning, "warning");
}

function notifyCurrentState(
	ctx: ExtensionContext,
	runtime: RuntimeState,
): void {
	if (runtime.chainBlocked)
		notify(
			ctx,
			`Failover config unavailable: ${runtime.chainBlocked}`,
			"warning",
		);
	if (runtime.chainWarning) notify(ctx, runtime.chainWarning, "warning");
	const warning = coordinationWarning(runtime.sharedStatus);
	if (warning) notify(ctx, warning, "warning");
}

function viewFor(runtime: RuntimeState): FailoverTuiView {
	const targets = new Map(
		Object.entries(runtime.sharedSnapshot.targets).map(([key, record]) => [
			key,
			{
				settings: {
					...record.settings,
					modelParameters: { ...record.settings.modelParameters },
				},
				runtime: {
					...record.runtime,
					manualRecovery: record.runtime.manualRecovery
						? { ...record.runtime.manualRecovery }
						: null,
				},
			},
		]),
	);
	const scopes = new Map(
		runtime.config.models.flatMap((model) => {
			const scope = runtime.sharedSnapshot.scopes[scopeKeyForModel(model.id)];
			if (!scope) return [];
			return [
				[
					model.id,
					{
						settings: {
							...scope.settings,
							modelParameters: { ...scope.settings.modelParameters },
						},
						targets: [...scope.targets],
						overrides: Object.fromEntries(
							Object.entries(scope.overrides).map(([key, override]) => [
								key,
								{
									...override,
									modelParameters: { ...override.modelParameters },
								},
							]),
						),
					},
				],
			];
		}),
	);
	return {
		config: copyGeneratedConfigV8(runtime.config),
		available: availableTargets(runtime.targetRuntime).map((target) => ({
			...target,
		})),
		targets,
		scopes,
		coordination: { ...runtime.sharedStatus },
	};
}

function parseNumericSetting(value: string): number | undefined {
	const text = value.trim();
	return /^\d+$/.test(text) ? Number(text) : undefined;
}

function parseInheritableNumericSetting(
	value: string,
): number | "inherit" | undefined {
	const text = value.trim().toLowerCase();
	if (text === "inherit") return text;
	return parseNumericSetting(text);
}

function slugify(name: string): string {
	const cleaned = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!cleaned) return "model";
	return (/^[a-z]/.test(cleaned) ? cleaned : `m${cleaned}`).slice(
		0,
		MAX_GENERATED_ID_LENGTH,
	);
}

function uniqueModelId(
	config: GeneratedFailoverConfigV8,
	name: string,
): string {
	const base = slugify(name);
	const ids = new Set(config.models.map((model) => model.id));
	if (!ids.has(base)) return base;
	for (let index = 2; ; index++) {
		const suffix = `-${index}`;
		const candidate = `${base.slice(0, MAX_GENERATED_ID_LENGTH - suffix.length)}${suffix}`;
		if (!ids.has(candidate)) return candidate;
	}
}

function updateModel(
	config: GeneratedFailoverConfigV8,
	id: string,
	update: (model: GeneratedFailoverModelV8) => GeneratedFailoverModelV8,
): GeneratedFailoverConfigV8 {
	const copy = copyGeneratedConfigV8(config);
	return createGeneratedConfigV8(
		copy.models.map((model) => (model.id === id ? update(model) : model)),
	);
}

async function persistChainConfig(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	config: GeneratedFailoverConfigV8,
): Promise<boolean> {
	if (runtime.chainBlocked) {
		notify(
			ctx,
			`Failover config unavailable: ${runtime.chainBlocked}`,
			"warning",
		);
		return false;
	}
	if (runtime.chainWarning) {
		notify(ctx, runtime.chainWarning, "warning");
		return false;
	}
	const validated = validateGeneratedConfigV8(config);
	if (!validated) {
		notify(ctx, "Failover chain change rejected: it would be invalid", "warning");
		return false;
	}
	let saved: Awaited<ReturnType<typeof saveGeneratedConfigV8>>;
	try {
		saved = await saveGeneratedConfigV8(
			FAILOVER_CONFIG_PATH,
			validated,
			runtime.chainRevision,
		);
	} catch {
		notify(
			ctx,
			"Failover chain could not be written; no change was applied.",
			"warning",
		);
		return false;
	}
	if (saved.kind === "conflict") {
		notify(
			ctx,
			"Failover chain changed on disk; reload and review before editing again.",
			"warning",
		);
		return false;
	}
	const loaded = await loadGeneratedConfigV8(FAILOVER_CONFIG_PATH);
	if (loaded.kind !== "loaded-v8") {
		notify(
			ctx,
			"Failover chain was written but the authoritative v8 file could not be reloaded.",
			"warning",
		);
		return false;
	}
	if (
		!(await reconcileApplyAndRefresh(runtime, loaded.config, loaded.revision))
	) {
		notify(
			ctx,
			"Failover chain was written but target registration failed; restart after repairing shared state.",
			"warning",
		);
		return false;
	}
	return true;
}

function modelById(
	runtime: RuntimeState,
	id: string,
): GeneratedFailoverModelV8 | undefined {
	return runtime.config.models.find((model) => model.id === id);
}

async function updateSharedTargets(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	targets: readonly ModelRef[],
	patch: SharedTargetSettingsPatch,
): Promise<boolean> {
	const unique = new Map(targets.map((target) => [modelKey(target), target]));
	if (unique.size === 0) {
		notify(
			ctx,
			"Add at least one target before changing target settings.",
			"warning",
		);
		return false;
	}
	for (const target of unique.values()) {
		const result = await runtime.sharedState.updateSettings(target, patch);
		if (result.kind !== "updated") {
			notify(ctx, "Shared target settings rejected an invalid update.", "warning");
			await refreshSharedSnapshot(runtime);
			return false;
		}
		if (result.coordination === "degraded") rememberCoordinationWarning(runtime);
	}
	await refreshSharedSnapshot(runtime);
	return true;
}

async function updateScopePolicy(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	modelId: string,
	patch: SharedChainSettingsPatch,
): Promise<boolean> {
	const update = runtime.sharedState.updateScopeSettings;
	if (!update) {
		notify(
			ctx,
			"Chain settings are unavailable in this shared-state version.",
			"warning",
		);
		return false;
	}
	const result = await update.call(
		runtime.sharedState,
		scopeKeyForModel(modelId),
		patch,
	);
	await refreshSharedSnapshot(runtime);
	if (result.kind !== "updated") {
		notify(ctx, "Chain settings rejected an invalid update.", "warning");
		return false;
	}
	if (result.coordination === "degraded") rememberCoordinationWarning(runtime);
	return true;
}

async function updateTargetPolicy(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	modelId: string,
	target: ModelRef,
	patch: SharedTargetOverridePatch,
): Promise<boolean> {
	const update = runtime.sharedState.updateTargetOverride;
	if (!update) {
		notify(
			ctx,
			"Target overrides are unavailable in this shared-state version.",
			"warning",
		);
		return false;
	}
	const result = await update.call(
		runtime.sharedState,
		scopeKeyForModel(modelId),
		target,
		patch,
	);
	await refreshSharedSnapshot(runtime);
	if (result.kind !== "updated") {
		notify(ctx, "Target override rejected an invalid update.", "warning");
		return false;
	}
	if (result.coordination === "degraded") rememberCoordinationWarning(runtime);
	return true;
}

async function resetSharedTargets(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	targets: readonly ModelRef[],
): Promise<boolean> {
	if (targets.length === 0) {
		notify(ctx, "This chain has no targets to reset.", "warning");
		return false;
	}
	const result = await runtime.sharedState.resetTargets(targets);
	await refreshSharedSnapshot(runtime);
	if (result.kind !== "reset") {
		notify(ctx, "Shared target reset was rejected.", "warning");
		return false;
	}
	return true;
}

function createFailoverActions(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	close: () => void,
): FailoverTuiActions {
	const mutate = async (
		change: (config: GeneratedFailoverConfigV8) => GeneratedFailoverConfigV8,
	): Promise<void> => {
		try {
			const applied = await persistChainConfig(
				ctx,
				runtime,
				change(runtime.config),
			);
			if (!applied)
				notify(ctx, "Failover chain change was not applied", "warning");
		} finally {
			await refreshSharedSnapshot(runtime);
		}
	};
	const update = (
		id: string,
		change: (model: GeneratedFailoverModelV8) => GeneratedFailoverModelV8,
	): Promise<void> => mutate((config) => updateModel(config, id, change));

	return {
		onClose: close,
		onError: () => notify(ctx, "Failover action failed", "error"),
		onAddModel: async (name) => {
			const label = name.slice(0, MAX_GENERATED_NAME_LENGTH);
			const id = uniqueModelId(runtime.config, label);
			await mutate((config) =>
				createGeneratedConfigV8([
					...config.models,
					{ id, name: label, enabled: false, chain: [] },
				]),
			);
		},
		onRemoveModel: async (id) =>
			mutate((config) =>
				createGeneratedConfigV8(config.models.filter((model) => model.id !== id)),
			),
		onToggleModel: async (id) => {
			const current = modelById(runtime, id);
			if (current && !current.enabled && current.chain.length === 0) {
				notify(
					ctx,
					`Add at least one target before enabling "${current.name}"`,
					"warning",
				);
				await refreshSharedSnapshot(runtime);
				return;
			}
			await update(id, (model) => ({ ...model, enabled: !model.enabled }));
		},
		onRenameModel: async (id, name) =>
			update(id, (model) => ({
				...model,
				name: name.slice(0, MAX_GENERATED_NAME_LENGTH),
			})),
		onAddTarget: async (id, target) =>
			update(id, (model) => {
				if (model.chain.some((entry) => modelKey(entry) === modelKey(target)))
					return model;
				return { ...model, chain: [...model.chain, { ...target }] };
			}),
		onRemoveTarget: async (id, target) =>
			update(id, (model) => {
				const targetKey = modelKey(target);
				const chain = model.chain.filter((entry) => modelKey(entry) !== targetKey);
				return {
					...model,
					enabled: chain.length === 0 ? false : model.enabled,
					chain,
				};
			}),
		onMoveTarget: async (id, target, direction) =>
			update(id, (model) => {
				const index = model.chain.findIndex(
					(entry) => modelKey(entry) === modelKey(target),
				);
				const targetIndex = index + direction;
				if (index < 0 || targetIndex < 0 || targetIndex >= model.chain.length)
					return model;
				const chain = [...model.chain];
				[chain[index], chain[targetIndex]] = [chain[targetIndex], chain[index]];
				return { ...model, chain };
			}),
		onSetTargetReasoning: async (
			target: ModelRef,
			effort: Inheritable<ReasoningEffort>,
			modelId: string,
		) => {
			await updateTargetPolicy(ctx, runtime, modelId, target, {
				reasoningEffort: effort,
			});
		},
		onSetTargetErrorHandling: async (
			target: ModelRef,
			mode: Inheritable<ErrorHandlingMode>,
			modelId: string,
		) => {
			await updateTargetPolicy(ctx, runtime, modelId, target, {
				errorHandlingMode: mode,
			});
		},
		onSetTargetMaxRetries: async (
			target: ModelRef,
			value: string,
			modelId: string,
		) => {
			const maxRetries = parseInheritableNumericSetting(value);
			if (
				maxRetries === undefined ||
				(maxRetries !== "inherit" && !isValidMaxRetries(maxRetries))
			) {
				notify(
					ctx,
					"Max retries must be inherit or an integer from 0 to 10",
					"warning",
				);
				await refreshSharedSnapshot(runtime);
				return;
			}
			await updateTargetPolicy(ctx, runtime, modelId, target, { maxRetries });
		},
		onSetTargetTimeout: async (
			target: ModelRef,
			value: string,
			modelId: string,
		) => {
			const seconds = parseInheritableNumericSetting(value);
			if (
				seconds === undefined ||
				(seconds !== "inherit" && !isValidTimeoutSeconds(seconds))
			) {
				notify(
					ctx,
					"Timeout must be inherit, 0, or an integer from 15 to 900 seconds",
					"warning",
				);
				await refreshSharedSnapshot(runtime);
				return;
			}
			await updateTargetPolicy(ctx, runtime, modelId, target, {
				noProgressTimeoutSeconds: seconds,
			});
		},
		onSetTargetParameter: async (
			target: ModelRef,
			parameter: ModelParameterName,
			enabled: Inheritable<boolean>,
			modelId: string,
		) => {
			await updateTargetPolicy(ctx, runtime, modelId, target, {
				modelParameters: { [parameter]: enabled },
			});
		},
		onSetScopeReasoning: async (modelId: string, effort: ReasoningEffort) => {
			await updateScopePolicy(ctx, runtime, modelId, { reasoningEffort: effort });
		},
		onSetScopeErrorHandling: async (modelId: string, mode: ErrorHandlingMode) => {
			await updateScopePolicy(ctx, runtime, modelId, { errorHandlingMode: mode });
		},
		onSetScopeMaxRetries: async (modelId: string, value: string) => {
			const maxRetries = parseNumericSetting(value);
			if (maxRetries === undefined || !isValidMaxRetries(maxRetries)) {
				notify(ctx, "Max retries must be an integer from 0 to 10", "warning");
				await refreshSharedSnapshot(runtime);
				return;
			}
			await updateScopePolicy(ctx, runtime, modelId, { maxRetries });
		},
		onSetScopeTimeout: async (modelId: string, value: string) => {
			const seconds = parseNumericSetting(value);
			if (seconds === undefined || !isValidTimeoutSeconds(seconds)) {
				notify(
					ctx,
					"Timeout must be 0 or an integer from 15 to 900 seconds",
					"warning",
				);
				await refreshSharedSnapshot(runtime);
				return;
			}
			await updateScopePolicy(ctx, runtime, modelId, {
				noProgressTimeoutSeconds: seconds,
			});
		},
		onSetScopeParameter: async (
			modelId: string,
			parameter: ModelParameterName,
			enabled: boolean,
		) => {
			await updateScopePolicy(ctx, runtime, modelId, {
				modelParameters: { [parameter]: enabled },
			});
		},
		onToggleTarget: async (target, enabled) => {
			await updateSharedTargets(ctx, runtime, [target], { enabled });
		},
		onResetTarget: async (target) => {
			await resetSharedTargets(ctx, runtime, [target]);
		},
	};
}

function resolveDelegateTarget(
	runtime: RuntimeState,
	model: ModelRef,
): { targetRuntime: TargetRuntime; real: TargetModelRecord } {
	const targetRuntime = runtime.targetRuntime;
	const real = targetRuntime.getModel(model.provider, model.id);
	if (!real)
		throw new Error(`Target unavailable: ${model.provider}/${model.id}`);
	return { targetRuntime, real };
}

function createDelegate(runtime: RuntimeState): Delegate {
	return {
		resolveModel: (target) => {
			if (target.provider === FAILOVER_PROVIDER_ID) return undefined;
			const model = runtime.targetRuntime.getModel(target.provider, target.id);
			if (!model) return undefined;
			const compat = model.compat;
			return {
				provider: model.provider,
				id: model.id,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap
					? { ...model.thinkingLevelMap }
					: undefined,
				...(compat
					? {
							compat: {
								supportsLongCacheRetention: compat.supportsLongCacheRetention,
								sendSessionAffinityHeaders: compat.sendSessionAffinityHeaders,
								sessionAffinityFormat: compat.sessionAffinityFormat,
							},
						}
					: {}),
			};
		},
		complete: async (model, context, options) => {
			const { targetRuntime, real } = resolveDelegateTarget(runtime, model);
			return targetRuntime.completeSimple(real, context, options);
		},
		stream: (model, context, options) => {
			const { targetRuntime, real } = resolveDelegateTarget(runtime, model);
			return targetRuntime.streamSimple(real, context, options);
		},
	};
}

function registerFailoverCommand(
	pi: ExtensionAPI,
	runtime: RuntimeState,
): void {
	pi.registerCommand("failover", {
		description: "Configure Pi model failover",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "/failover requires interactive TUI mode", "warning");
				return;
			}
			const subcommand = args.trim().split(/\s+/)[0];
			if (subcommand === "history") {
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
					const panel = new FailoverHistoryPanel(
						theme,
						() => runtime.history,
						() => done(),
					);
					return {
						render: (width: number) => panel.render(width),
						invalidate: () => panel.invalidate(),
						handleInput: (data: string) => {
							panel.handleInput(data);
							tui.requestRender();
						},
					};
				});
				return;
			}
			await refreshSharedSnapshot(runtime);
			notifyPendingWarnings(ctx, runtime);
			notifyCurrentState(ctx, runtime);
			if (runtime.chainBlocked) return;
			const refreshed = await refreshOwnedTargetRuntime(runtime);
			if (!refreshed)
				notify(
					ctx,
					"Failover target availability refresh failed; using the last known target snapshot.",
					"warning",
				);
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const actions = createFailoverActions(ctx, runtime, () => done());
				const editor = new FailoverEditor(theme, () => viewFor(runtime), actions);
				return {
					render: (width: number) => editor.render(width),
					invalidate: () => editor.invalidate(),
					whenIdle: () => editor.whenIdle(),
					handleInput: (data: string) => {
						editor.handleInput(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}

function isTargetRuntime(value: unknown): value is TargetRuntime {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.getModel === "function" &&
		typeof record.getAvailableSnapshot === "function" &&
		typeof record.refresh === "function" &&
		typeof record.completeSimple === "function" &&
		typeof record.streamSimple === "function"
	);
}

function isSharedStateAdapter(value: unknown): value is SharedStateAdapter {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.snapshot === "function" &&
		typeof record.reconcileRegistration === "function" &&
		typeof record.claim === "function" &&
		typeof record.settle === "function" &&
		typeof record.updateSettings === "function" &&
		typeof record.resetTargets === "function"
	);
}

function resolveRegistrationOptions(
	targetRuntimeOrOptions?: TargetRuntime | RegisterFailoverExtensionOptions,
	sharedStateOrOptions?:
		| SharedStateAdapter
		| Pick<RegisterFailoverExtensionOptions, "sharedState">,
): RegisterFailoverExtensionOptions {
	const options = isTargetRuntime(targetRuntimeOrOptions)
		? { targetRuntime: targetRuntimeOrOptions }
		: { ...(targetRuntimeOrOptions ?? {}) };
	if (isSharedStateAdapter(sharedStateOrOptions))
		options.sharedState = sharedStateOrOptions;
	else if (sharedStateOrOptions?.sharedState)
		options.sharedState = sharedStateOrOptions.sharedState;
	return options;
}

export function registerFailoverExtension(
	pi: ExtensionAPI,
	options?: RegisterFailoverExtensionOptions,
): Promise<void>;
export function registerFailoverExtension(
	pi: ExtensionAPI,
	targetRuntime?: TargetRuntime,
	sharedStateOrOptions?:
		| SharedStateAdapter
		| Pick<RegisterFailoverExtensionOptions, "sharedState">,
): Promise<void>;
export async function registerFailoverExtension(
	pi: ExtensionAPI,
	targetRuntimeOrOptions?: TargetRuntime | RegisterFailoverExtensionOptions,
	sharedStateOrOptions?:
		| SharedStateAdapter
		| Pick<RegisterFailoverExtensionOptions, "sharedState">,
): Promise<void> {
	const options = resolveRegistrationOptions(
		targetRuntimeOrOptions,
		sharedStateOrOptions,
	);
	const targetRuntime =
		options.targetRuntime ?? (await createOwnedTargetRuntime());
	const sharedState = options.sharedState ?? createFileSharedState();
	const initialShared = await sharedState.snapshot();
	const runtime = initialRuntime(
		targetRuntime,
		sharedState,
		initialShared.document,
		initialShared.status,
	);
	installProviderCallbacks(pi, runtime);
	runtime.providerState.delegate = createDelegate(runtime);
	rememberCoordinationWarning(runtime);
	await loadAndApplyInitialConfig(runtime);

	// The provider must be complete before registration because child sessions may
	// issue requests without receiving session_start in this process.
	runtime.providerState.sharedState = runtime.sharedState;
	pi.registerProvider(createFailoverProvider(runtime.providerState) as never);

	pi.on("session_start", async (_event, ctx) => {
		runtime.history = restoreHistory(ctx.sessionManager.getEntries());
		runtime.lastTransition = runtime.history[0];
		runtime.currentTarget = undefined;
		runtime.sessionContext = ctx;
		runtime.sessionPersistable = Boolean(ctx.sessionManager.getSessionFile());
		await refreshSharedSnapshot(runtime);
		notifyPendingWarnings(ctx, runtime);
		notifyCurrentState(ctx, runtime);
		if (runtime.chainBlocked) return;
		await refreshOwnedTargetRuntime(runtime);
	});
	pi.on("session_shutdown", () => {
		runtime.sessionContext = undefined;
		runtime.sessionPersistable = false;
	});
	registerFailoverCommand(pi, runtime);
}

export default async function modelFailoverExtension(
	pi: ExtensionAPI,
): Promise<void> {
	await registerFailoverExtension(pi);
}
