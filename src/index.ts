import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { uniqueModels } from "./catalog.ts";
import type { ConfigSourceRevision } from "./config.ts";
import {
	isValidCooldownMinutes,
	isValidMaxRetries,
	isValidTimeoutSeconds,
} from "./config.ts";
import {
	createGeneratedConfig,
	createGeneratedModel,
	loadGeneratedConfig,
	saveGeneratedConfig,
	validateGeneratedConfig,
} from "./generated-config.ts";
import {
	FAILOVER_PROVIDER_ID,
	buildFailoverCatalogModels,
	loadModelsJson,
	reconcileFailoverCatalog,
	type TargetCatalogMetadata,
} from "./models-catalog.ts";
import {
	createFailoverProvider,
	type AssistantMessageEventStreamLike,
	type AssistantMessageLike,
	type Delegate,
	type FailoverProviderState,
	type TargetModelLike,
} from "./provider.ts";
import {
	FailoverEditor,
	type FailoverTuiActions,
	type FailoverTuiView,
} from "./tui.ts";
import type {
	ErrorHandlingMode,
	GeneratedFailoverConfig,
	GeneratedFailoverModel,
	ModelParameterName,
	ModelRef,
	ReasoningEffort,
} from "./types.ts";
import { modelKey } from "./types.ts";

export const FAILOVER_CONFIG_PATH = join(getAgentDir(), "model-failover.json");
export const MODELS_JSON_PATH = join(getAgentDir(), "models.json");

interface RuntimeState {
	config: GeneratedFailoverConfig;
	configRevision: ConfigSourceRevision;
	configBlocked: string | undefined;
	registry: ModelRegistry | undefined;
	providerState: FailoverProviderState;
}

type ModelRegistry = ExtensionContext["modelRegistry"];

function initialRuntime(): RuntimeState {
	const config = createGeneratedConfig([]);
	const providerState: FailoverProviderState = {
		config: { models: config.models },
		metadata: [],
		// SAFETY: assigned to the real delegate right after initialRuntime() in the factory.
		delegate: null as unknown as Delegate,
		availableTargetKeys: new Set(),
		availabilityKnown: false,
		cooldowns: new Map(),
		manualRecovery: new Map(),
		unsupportedCacheFields: new Map(),
	};
	return {
		config,
		configRevision: { kind: "absent" },
		configBlocked: undefined,
		registry: undefined,
		providerState,
	};
}

function notify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	ctx.ui.notify(message, type);
}

function collectMetadata(
	config: GeneratedFailoverConfig,
	registry: ModelRegistry | undefined,
): TargetCatalogMetadata[] {
	if (!registry) return [];
	const seen = new Map<string, TargetCatalogMetadata>();
	for (const model of config.models) {
		for (const target of model.chain) {
			const key = modelKey(target);
			if (seen.has(key) || target.provider === FAILOVER_PROVIDER_ID) continue;
			const real = registry.find(target.provider, target.id);
			seen.set(key, {
				ref: target,
				input: real ? [...real.input] : undefined,
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
	config: GeneratedFailoverConfig,
	registry: ModelRegistry | undefined,
): Set<string> {
	const keys = new Set<string>();
	if (!registry) return keys;
	for (const model of config.models) {
		for (const target of model.chain) {
			if (target.provider === FAILOVER_PROVIDER_ID) continue;
			const real = registry.find(target.provider, target.id);
			if (real && registry.hasConfiguredAuth(real)) keys.add(modelKey(target));
		}
	}
	return keys;
}

/** Targets a user may add to a chain: authenticated real models, excluding failover itself. */
function availableTargets(registry: ModelRegistry | undefined): ModelRef[] {
	if (!registry) return [];
	return uniqueModels(registry.getAvailable()).filter(
		(target) => target.provider !== FAILOVER_PROVIDER_ID,
	);
}

function seedManualRecovery(runtime: RuntimeState): void {
	for (const model of runtime.config.models) {
		for (const [targetKey, reason] of Object.entries(model.manualRecovery)) {
			const runtimeKey = `${model.id}:${targetKey}`;
			if (!runtime.providerState.manualRecovery.has(runtimeKey)) {
				runtime.providerState.manualRecovery.set(runtimeKey, reason);
			}
		}
	}
}

function applyConfig(
	runtime: RuntimeState,
	config: GeneratedFailoverConfig,
	revision: ConfigSourceRevision,
): void {
	runtime.config = config;
	runtime.configRevision = revision;
	runtime.providerState.config = { models: config.models };
	runtime.providerState.metadata = collectMetadata(config, runtime.registry);
	runtime.providerState.availableTargetKeys = collectAvailableKeys(
		config,
		runtime.registry,
	);
	seedManualRecovery(runtime);
}

async function reconcileCatalog(
	ctx: ExtensionContext,
	runtime: RuntimeState,
): Promise<void> {
	if (runtime.configBlocked) return;
	if (!runtime.registry) return;
	const loaded = await loadModelsJson(MODELS_JSON_PATH);
	if (loaded.kind === "blocked") {
		notify(ctx, `Failover catalog not updated: ${loaded.detail}`, "warning");
		return;
	}
	const models = buildFailoverCatalogModels(
		runtime.config,
		runtime.providerState.metadata,
	);
	const result = await reconcileFailoverCatalog(
		MODELS_JSON_PATH,
		models,
		loaded.revision,
	);
	if (result.kind === "conflict") {
		notify(
			ctx,
			"models.json changed externally; failover catalog not written. Reload to retry.",
			"warning",
		);
	}
	await runtime.registry.refresh({ allowNetwork: false });
	runtime.providerState.metadata = collectMetadata(
		runtime.config,
		runtime.registry,
	);
	runtime.providerState.availableTargetKeys = collectAvailableKeys(
		runtime.config,
		runtime.registry,
	);
}

/** Persist the current config, reload a canonical copy, then refresh provider + catalog. */
async function persist(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	config: GeneratedFailoverConfig,
): Promise<boolean> {
	if (runtime.configBlocked) {
		notify(
			ctx,
			`Failover config unavailable: ${runtime.configBlocked}`,
			"warning",
		);
		return false;
	}
	if (!validateGeneratedConfig(config)) {
		notify(ctx, "Failover change rejected: it would be invalid", "warning");
		return false;
	}
	const saved = await saveGeneratedConfig(
		FAILOVER_CONFIG_PATH,
		config,
		runtime.configRevision,
	);
	if (saved.kind === "conflict") {
		notify(
			ctx,
			"Failover config changed on disk; reload and review before editing again.",
			"warning",
		);
		return false;
	}
	const reloaded = await loadGeneratedConfig(FAILOVER_CONFIG_PATH);
	if (reloaded.kind !== "loaded") {
		notify(ctx, `Failover config saved but could not be reloaded.`, "warning");
		return false;
	}
	applyConfig(runtime, reloaded.config, reloaded.revision);
	await reconcileCatalog(ctx, runtime);
	return true;
}

function updateModel(
	config: GeneratedFailoverConfig,
	id: string,
	fn: (model: GeneratedFailoverModel) => GeneratedFailoverModel,
): GeneratedFailoverConfig {
	return createGeneratedConfig(
		config.models.map((model) => (model.id === id ? fn(model) : model)),
	);
}

/** Generated ids must match /^[a-z][a-z0-9_-]{0,63}$/ to pass config validation. */
const MAX_GENERATED_ID_LENGTH = 64;
const MAX_GENERATED_NAME_LENGTH = 120;

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

function uniqueModelId(config: GeneratedFailoverConfig, name: string): string {
	const base = slugify(name);
	const ids = new Set(config.models.map((model) => model.id));
	if (!ids.has(base)) return base;
	for (let index = 2; ; index++) {
		const suffix = `-${index}`;
		const candidate = `${base.slice(0, MAX_GENERATED_ID_LENGTH - suffix.length)}${suffix}`;
		if (!ids.has(candidate)) return candidate;
	}
}

function setTargetReasoning(
	model: GeneratedFailoverModel,
	target: ModelRef,
	effort: ReasoningEffort | undefined,
): GeneratedFailoverModel {
	const key = modelKey(target);
	const overrides = { ...model.targetOverrides };
	const existing = { ...(overrides[key] ?? {}) };
	if (effort === undefined) delete existing.reasoningEffort;
	else existing.reasoningEffort = effort;
	if (Object.keys(existing).length === 0) delete overrides[key];
	else overrides[key] = existing;
	return { ...model, targetOverrides: overrides };
}

function setTargetParameter(
	model: GeneratedFailoverModel,
	target: ModelRef,
	parameter: ModelParameterName,
	enabled: boolean,
): GeneratedFailoverModel {
	const key = modelKey(target);
	const overrides = { ...model.targetOverrides };
	const existing = { ...(overrides[key] ?? {}) };
	const toggles = {
		...(existing.modelParameters ?? { ...model.modelParameters }),
	};
	toggles[parameter] = enabled;
	existing.modelParameters = toggles;
	overrides[key] = existing;
	return { ...model, targetOverrides: overrides };
}

function clearRuntimeRecovery(runtime: RuntimeState, id: string): void {
	for (const key of [...runtime.providerState.cooldowns.keys()]) {
		if (key.startsWith(`${id}:`)) runtime.providerState.cooldowns.delete(key);
	}
	for (const key of [...runtime.providerState.manualRecovery.keys()]) {
		if (key.startsWith(`${id}:`))
			runtime.providerState.manualRecovery.delete(key);
	}
	for (const key of [...runtime.providerState.unsupportedCacheFields.keys()]) {
		if (key.startsWith(`${id}:`))
			runtime.providerState.unsupportedCacheFields.delete(key);
	}
}

/** Clear runtime state scoped to one removed target, not the whole model. */
function clearTargetRuntimeState(
	runtime: RuntimeState,
	id: string,
	target: ModelRef,
): void {
	const prefix = `${id}:${modelKey(target)}`;
	for (const key of [...runtime.providerState.cooldowns.keys()]) {
		if (key === prefix) runtime.providerState.cooldowns.delete(key);
	}
	for (const key of [...runtime.providerState.manualRecovery.keys()]) {
		if (key === prefix) runtime.providerState.manualRecovery.delete(key);
	}
	for (const key of [...runtime.providerState.unsupportedCacheFields.keys()]) {
		if (key.startsWith(`${prefix}:`))
			runtime.providerState.unsupportedCacheFields.delete(key);
	}
}

function createDelegate(runtime: RuntimeState): Delegate {
	return {
		resolveModel: (target) => {
			if (target.provider === FAILOVER_PROVIDER_ID) return undefined;
			const model = runtime.registry?.find(target.provider, target.id);
			if (!model) return undefined;
			const targetModel: TargetModelLike = {
				provider: model.provider,
				id: model.id,
				api: model.api,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
			};
			return targetModel;
		},
		complete: async (model, context, options) => {
			const registry = runtime.registry;
			if (!registry) throw new Error("Model registry is not available");
			const real = registry.find(model.provider, model.id);
			if (!real)
				throw new Error(`Target unavailable: ${model.provider}/${model.id}`);
			// SAFETY: the compatibility facade exposes Pi's concrete runtime at runtime.
			const registryRuntime = (
				registry as unknown as {
					runtime?: {
						completeSimple?: (
							model: unknown,
							context: unknown,
							options: unknown,
						) => Promise<unknown>;
					};
				}
			).runtime;
			const message = registryRuntime?.completeSimple
				? await registryRuntime.completeSimple(real, context, options)
				: await registry.complete(
						real as never,
						context as never,
						options as never,
					);
			// SAFETY: Pi's runtime stream emits the structural event-stream contract.
			return message as unknown as AssistantMessageLike;
		},
		stream: (model, context, options) => {
			const registry = runtime.registry;
			if (!registry) throw new Error("Model registry is not available");
			const real = registry.find(model.provider, model.id);
			if (!real)
				throw new Error(`Target unavailable: ${model.provider}/${model.id}`);
			// SAFETY: the compatibility facade exposes Pi's concrete runtime at runtime.
			const registryRuntime = (
				registry as unknown as {
					runtime?: {
						streamSimple?: (
							model: unknown,
							context: unknown,
							options: unknown,
						) => unknown;
					};
				}
			).runtime;
			if (registryRuntime?.streamSimple) {
				// SAFETY: Pi's runtime stream emits the structural event-stream contract.
				return registryRuntime.streamSimple(
					real,
					context,
					options,
				) as AssistantMessageEventStreamLike;
			}
			let resultPromise: Promise<AssistantMessageLike> | undefined;
			const getResult = () =>
				(resultPromise ??= registry
					.complete(real as never, context as never, options as never)
					.then((message) => message as AssistantMessageLike));
			return {
				async *[Symbol.asyncIterator]() {
					const message = await getResult();
					yield { type: "done", reason: message.stopReason, message };
				},
				result: getResult,
			};
		},
	};
}

async function loadAndApplyInitialConfig(
	pi: ExtensionAPI,
	runtime: RuntimeState,
): Promise<void> {
	const loaded = await loadGeneratedConfig(FAILOVER_CONFIG_PATH);
	if (loaded.kind === "loaded") {
		runtime.configBlocked = undefined;
		applyConfig(runtime, loaded.config, loaded.revision);
		if (loaded.migrated) {
			// Persist the migrated v6 shape so later runs skip re-migration.
			const saved = await saveGeneratedConfig(
				FAILOVER_CONFIG_PATH,
				loaded.config,
				loaded.revision,
			);
			if (saved.kind === "saved") {
				const reloaded = await loadGeneratedConfig(FAILOVER_CONFIG_PATH);
				if (reloaded.kind === "loaded") {
					applyConfig(runtime, reloaded.config, reloaded.revision);
				}
			}
		}
	} else if (loaded.kind === "missing") {
		runtime.configBlocked = undefined;
		const config = createGeneratedConfig([]);
		const saved = await saveGeneratedConfig(
			FAILOVER_CONFIG_PATH,
			config,
			loaded.revision,
		);
		if (saved.kind === "saved") {
			const reloaded = await loadGeneratedConfig(FAILOVER_CONFIG_PATH);
			if (reloaded.kind === "loaded") {
				applyConfig(runtime, reloaded.config, reloaded.revision);
			}
		} else {
			applyConfig(runtime, config, loaded.revision);
		}
	} else {
		runtime.configBlocked = loaded.detail;
		const config = createGeneratedConfig([]);
		runtime.config = config;
		runtime.configRevision = { kind: "absent" };
		runtime.providerState.config = { models: [] };
		runtime.providerState.metadata = [];
		runtime.providerState.availableTargetKeys = new Set();
	}
	pi.registerProvider(createFailoverProvider(runtime.providerState) as never);
}

function viewFor(runtime: RuntimeState): FailoverTuiView {
	return {
		config: runtime.config,
		available: availableTargets(runtime.registry),
		cooldowns: runtime.providerState.cooldowns,
		manualRecovery: runtime.providerState.manualRecovery,
	};
}

/** Empty or non-numeric input must never silently resolve to 0. */
function parseNumericSetting(value: string): number | undefined {
	const text = value.trim();
	return /^\d+$/.test(text) ? Number(text) : undefined;
}

function createFailoverActions(
	ctx: ExtensionContext,
	runtime: RuntimeState,
	close: () => void,
): FailoverTuiActions {
	const mutate = (
		fn: (config: GeneratedFailoverConfig) => GeneratedFailoverConfig,
	): Promise<void> =>
		Promise.resolve()
			.then(() => persist(ctx, runtime, fn(runtime.config)))
			.then((ok) => {
				if (!ok) notify(ctx, "Failover config change was not applied", "warning");
			});

	const update = (
		id: string,
		fn: (model: GeneratedFailoverModel) => GeneratedFailoverModel,
	): Promise<void> => mutate((config) => updateModel(config, id, fn));

	return {
		onClose: close,
		onError: (error) => notify(ctx, `Failover error: ${String(error)}`, "error"),
		onAddModel: async (name) => {
			const label = name.slice(0, MAX_GENERATED_NAME_LENGTH);
			const id = uniqueModelId(runtime.config, label);
			await mutate((config) =>
				createGeneratedConfig([
					...config.models,
					{
						...createGeneratedModel([]),
						id,
						name: label,
						enabled: false,
					},
				]),
			);
		},
		onRemoveModel: async (id) => {
			clearRuntimeRecovery(runtime, id);
			await mutate((config) =>
				createGeneratedConfig(config.models.filter((model) => model.id !== id)),
			);
		},
		onToggleModel: async (id) => {
			const current = runtime.config.models.find((entry) => entry.id === id);
			if (current && !current.enabled && current.chain.length === 0) {
				notify(
					ctx,
					`Add at least one target before enabling "${current.name}"`,
					"warning",
				);
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
				return { ...model, chain: [...model.chain, target] };
			}),
		onRemoveTarget: async (id, target) => {
			clearTargetRuntimeState(runtime, id, target);
			await update(id, (model) => {
				const targetKey = modelKey(target);
				const chain = model.chain.filter((entry) => modelKey(entry) !== targetKey);
				const targetOverrides = { ...model.targetOverrides };
				delete targetOverrides[targetKey];
				const manualRecovery = { ...model.manualRecovery };
				delete manualRecovery[targetKey];
				return {
					...model,
					// An enabled model with an empty chain is invalid; keep it as a
					// disabled draft so the user can re-add targets before enabling.
					enabled: chain.length === 0 ? false : model.enabled,
					chain,
					targetOverrides,
					manualRecovery,
				};
			});
		},
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
		onSetReasoning: async (id, effort) =>
			update(id, (model) => ({ ...model, reasoningEffort: effort })),
		onSetCooldown: async (id, value) => {
			const minutes = parseNumericSetting(value);
			if (minutes === undefined || !isValidCooldownMinutes(minutes)) {
				notify(
					ctx,
					"Cooldown must be an integer from 0 to 1440 minutes",
					"warning",
				);
				return;
			}
			await update(id, (model) => ({ ...model, cooldownMinutes: minutes }));
		},
		onSetErrorHandling: async (id, mode: ErrorHandlingMode) =>
			update(id, (model) => ({ ...model, errorHandlingMode: mode })),
		onSetMaxRetries: async (id, value) => {
			const maxRetries = parseNumericSetting(value);
			if (maxRetries === undefined || !isValidMaxRetries(maxRetries)) {
				notify(ctx, "Max retries must be an integer from 0 to 10", "warning");
				return;
			}
			await update(id, (model) => ({ ...model, maxRetries }));
		},
		onSetTimeout: async (id, value) => {
			const seconds = parseNumericSetting(value);
			if (seconds === undefined || !isValidTimeoutSeconds(seconds)) {
				notify(
					ctx,
					"Timeout must be 0 or an integer from 15 to 900 seconds",
					"warning",
				);
				return;
			}
			await update(id, (model) => ({
				...model,
				noProgressTimeoutSeconds: seconds,
			}));
		},
		onSetTargetReasoning: async (id, target, effort) =>
			update(id, (model) => setTargetReasoning(model, target, effort)),
		onSetTargetParameter: async (id, target, parameter, enabled) =>
			update(id, (model) => setTargetParameter(model, target, parameter, enabled)),
		onRestore: async (id) => {
			clearRuntimeRecovery(runtime, id);
			await update(id, (model) => ({ ...model, manualRecovery: {} }));
		},
	};
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
			if (runtime.configBlocked) {
				notify(
					ctx,
					`Failover config unavailable: ${runtime.configBlocked}`,
					"warning",
				);
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const actions = createFailoverActions(ctx, runtime, () => done());
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

export default async function modelFailoverExtension(
	pi: ExtensionAPI,
): Promise<void> {
	const runtime = initialRuntime();
	runtime.providerState.delegate = createDelegate(runtime);
	await loadAndApplyInitialConfig(pi, runtime);
	pi.on("session_start", async (_event, ctx) => {
		runtime.registry = ctx.modelRegistry;
		runtime.providerState.onTransition = (transition) => {
			const source = transition.source ? modelKey(transition.source) : "start";
			ctx.ui.setStatus(
				"failover",
				`Failover: ${source} → ${modelKey(transition.target)} (${transition.reason})`,
			);
		};
		runtime.providerState.availabilityKnown = true;
		if (runtime.configBlocked) {
			notify(
				ctx,
				`Failover config unavailable: ${runtime.configBlocked}`,
				"warning",
			);
			return;
		}
		applyConfig(runtime, runtime.config, runtime.configRevision);
		await reconcileCatalog(ctx, runtime);
	});
	registerFailoverCommand(pi, runtime);
}
