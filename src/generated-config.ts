import {
	DEFAULT_ERROR_HANDLING_MODE,
	DEFAULT_MAX_RETRIES,
	DEFAULT_NO_PROGRESS_TIMEOUT_SECONDS,
	DEFAULT_REASONING_EFFORT,
	isValidMaxRetries,
	isValidTimeoutSeconds,
	validateConfig,
} from "./config.ts";
import type { ConfigSourceRevision } from "./json-file.ts";
import type { LegacyTargetCandidate } from "./shared-state.ts";
import {
	isRecord,
	readJsonSource,
	readManualRecovery,
	writeJsonAtomically,
} from "./json-file.ts";
import {
	DEFAULT_PARAMETER_TOGGLES,
	ERROR_HANDLING_MODES,
	MODEL_PARAMETER_NAMES,
	REASONING_EFFORTS,
	modelKey,
	type ErrorHandlingMode,
	type GeneratedFailoverConfig,
	type GeneratedFailoverConfigV8,
	type GeneratedFailoverModel,
	type GeneratedFailoverModelV8,
	type GeneratedTargetOverride,
	type ModelParameterToggles,
	type ModelRef,
	type ReasoningEffort,
} from "./types.ts";

const GENERATED_CONFIG_VERSION = 7 as const;
const GENERATED_MODEL_KEYS = new Set([
	"id",
	"name",
	"enabled",
	"chain",
	"reasoningEffort",
	"errorHandlingMode",
	"maxRetries",
	"noProgressTimeoutSeconds",
	"modelParameters",
	"targetOverrides",
	"manualRecovery",
]);
const GENERATED_MODEL_V6_KEYS = new Set([
	...GENERATED_MODEL_KEYS,
	"cooldownMinutes",
]);
export const DEFAULT_GENERATED_MODEL_ID = "default";
export const DEFAULT_GENERATED_MODEL_NAME = "Default Failover";

export function createGeneratedModel(
	chain: readonly ModelRef[] = [],
	overrides: Partial<Omit<GeneratedFailoverModel, "id" | "name" | "chain">> = {},
): GeneratedFailoverModel {
	return {
		id: DEFAULT_GENERATED_MODEL_ID,
		name: DEFAULT_GENERATED_MODEL_NAME,
		enabled: true,
		chain: chain.map(copyModelRef),
		reasoningEffort: DEFAULT_REASONING_EFFORT,
		errorHandlingMode: DEFAULT_ERROR_HANDLING_MODE,
		maxRetries: DEFAULT_MAX_RETRIES,
		noProgressTimeoutSeconds: DEFAULT_NO_PROGRESS_TIMEOUT_SECONDS,
		modelParameters: { ...DEFAULT_PARAMETER_TOGGLES },
		targetOverrides: {},
		manualRecovery: {},
		...overrides,
	};
}

export function createGeneratedConfig(
	models: readonly GeneratedFailoverModel[] = [],
): GeneratedFailoverConfig {
	return {
		version: GENERATED_CONFIG_VERSION,
		models: models.map(copyGeneratedModel),
	};
}

function copyModelRef(model: ModelRef): ModelRef {
	return { provider: model.provider, id: model.id };
}

function copyToggles(value: ModelParameterToggles): ModelParameterToggles {
	return { ...DEFAULT_PARAMETER_TOGGLES, ...value };
}

function copyGeneratedModel(
	model: GeneratedFailoverModel,
): GeneratedFailoverModel {
	const targetOverrides: Record<string, GeneratedTargetOverride> = {};
	for (const [key, value] of Object.entries(model.targetOverrides)) {
		targetOverrides[key] = {
			...(value.reasoningEffort === undefined
				? {}
				: { reasoningEffort: value.reasoningEffort }),
			...(value.modelParameters === undefined
				? {}
				: { modelParameters: copyToggles(value.modelParameters) }),
		};
	}
	return {
		id: model.id,
		name: model.name,
		enabled: model.enabled,
		chain: model.chain.map(copyModelRef),
		reasoningEffort: model.reasoningEffort,
		errorHandlingMode: model.errorHandlingMode,
		maxRetries: model.maxRetries,
		noProgressTimeoutSeconds: model.noProgressTimeoutSeconds,
		modelParameters: copyToggles(model.modelParameters),
		targetOverrides,
		manualRecovery: { ...model.manualRecovery },
	};
}

function readReasoningEffort(value: unknown): ReasoningEffort | undefined {
	return typeof value === "string" &&
		(REASONING_EFFORTS as readonly string[]).includes(value)
		? (value as ReasoningEffort)
		: undefined;
}

function readErrorHandlingMode(value: unknown): ErrorHandlingMode | undefined {
	return typeof value === "string" &&
		(ERROR_HANDLING_MODES as readonly string[]).includes(value)
		? (value as ErrorHandlingMode)
		: undefined;
}

function readModelRef(value: unknown): ModelRef | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.provider !== "string" ||
		value.provider.trim().length === 0 ||
		typeof value.id !== "string" ||
		value.id.trim().length === 0
	)
		return undefined;
	return { provider: value.provider, id: value.id };
}

function readChain(value: unknown, allowEmpty = false): ModelRef[] | undefined {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
		return undefined;
	const result: ModelRef[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const model = readModelRef(entry);
		if (!model) return undefined;
		const key = modelKey(model);
		if (seen.has(key)) return undefined;
		seen.add(key);
		result.push(model);
	}
	return result;
}

function readToggles(value: unknown): ModelParameterToggles | undefined {
	if (!isRecord(value)) return undefined;
	if (
		Object.keys(value).some(
			(key) => !(MODEL_PARAMETER_NAMES as readonly string[]).includes(key),
		)
	)
		return undefined;
	const result = { ...DEFAULT_PARAMETER_TOGGLES };
	for (const name of MODEL_PARAMETER_NAMES) {
		if (typeof value[name] !== "boolean") return undefined;
		result[name] = value[name];
	}
	return result;
}

function readTargetOverrides(
	value: unknown,
	chain: readonly ModelRef[],
): Record<string, GeneratedTargetOverride> | undefined {
	if (value === undefined) return {};
	if (!isRecord(value)) return undefined;
	const chainKeys = new Set(chain.map(modelKey));
	const result: Record<string, GeneratedTargetOverride> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!chainKeys.has(key) || !isRecord(entry)) return undefined;
		if (
			Object.keys(entry).some(
				(entryKey) =>
					entryKey !== "reasoningEffort" && entryKey !== "modelParameters",
			)
		)
			return undefined;
		const override: GeneratedTargetOverride = {};
		if (entry.reasoningEffort !== undefined) {
			const effort = readReasoningEffort(entry.reasoningEffort);
			if (!effort) return undefined;
			override.reasoningEffort = effort;
		}
		if (entry.modelParameters !== undefined) {
			const toggles = readToggles(entry.modelParameters);
			if (!toggles) return undefined;
			override.modelParameters = toggles;
		}
		if (Object.keys(override).length === 0) return undefined;
		result[key] = override;
	}
	return result;
}

function validGeneratedId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function validGeneratedModelFields(
	value: Record<string, unknown>,
	chain: ModelRef[] | undefined,
	reasoningEffort: ReasoningEffort | undefined,
	errorHandlingMode: ErrorHandlingMode | undefined,
	modelParameters: ModelParameterToggles | undefined,
	manualRecovery: Record<string, string> | undefined,
):
	| {
			chain: ModelRef[];
			reasoningEffort: ReasoningEffort;
			errorHandlingMode: ErrorHandlingMode;
			modelParameters: ModelParameterToggles;
			manualRecovery: Record<string, string>;
	  }
	| undefined {
	if (
		!validGeneratedId(value.id) ||
		typeof value.name !== "string" ||
		value.name.trim().length === 0 ||
		value.name.length > 120 ||
		typeof value.enabled !== "boolean" ||
		!chain ||
		!reasoningEffort ||
		!errorHandlingMode ||
		!modelParameters ||
		manualRecovery === undefined ||
		!isValidMaxRetries(value.maxRetries) ||
		!isValidTimeoutSeconds(value.noProgressTimeoutSeconds)
	)
		return undefined;
	return {
		chain,
		reasoningEffort,
		errorHandlingMode,
		modelParameters,
		manualRecovery,
	};
}

function readGeneratedModel(
	value: unknown,
): GeneratedFailoverModel | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.keys(value).some((key) => !GENERATED_MODEL_KEYS.has(key)))
		return undefined;
	const chain = readChain(value.chain, value.enabled === false);
	const reasoningEffort = readReasoningEffort(value.reasoningEffort);
	const errorHandlingMode = readErrorHandlingMode(value.errorHandlingMode);
	const modelParameters = readToggles(value.modelParameters);
	const manualRecovery =
		value.manualRecovery === undefined
			? {}
			: readManualRecovery(value.manualRecovery);
	const fields = validGeneratedModelFields(
		value,
		chain,
		reasoningEffort,
		errorHandlingMode,
		modelParameters,
		manualRecovery,
	);
	if (!fields) return undefined;
	const targetOverrides = readTargetOverrides(
		value.targetOverrides,
		fields.chain,
	);
	if (!targetOverrides) return undefined;
	return {
		id: value.id as string,
		name: value.name as string,
		enabled: value.enabled as boolean,
		chain: fields.chain,
		reasoningEffort: fields.reasoningEffort,
		errorHandlingMode: fields.errorHandlingMode,
		maxRetries: value.maxRetries as number,
		noProgressTimeoutSeconds: value.noProgressTimeoutSeconds as number,
		modelParameters: fields.modelParameters,
		targetOverrides,
		manualRecovery: fields.manualRecovery,
	};
}

function migrateV6GeneratedModel(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.keys(value).some((key) => !GENERATED_MODEL_V6_KEYS.has(key)))
		return undefined;
	if (
		typeof value.cooldownMinutes !== "number" ||
		!Number.isInteger(value.cooldownMinutes) ||
		value.cooldownMinutes < 0 ||
		value.cooldownMinutes > 1440
	)
		return undefined;
	const { cooldownMinutes: _removed, ...migrated } = value;
	return readGeneratedModel(migrated) ? migrated : undefined;
}

/** Convert supported older configs into generated config v7. */
export function migrateGeneratedConfig(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version === GENERATED_CONFIG_VERSION) return value;
	if (value.version === 6) {
		if (!Array.isArray(value.models)) return undefined;
		const models: Record<string, unknown>[] = [];
		for (const entry of value.models) {
			const migrated = migrateV6GeneratedModel(entry);
			if (!migrated) return undefined;
			models.push(migrated);
		}
		return { version: GENERATED_CONFIG_VERSION, models };
	}
	const legacy = validateConfig(value);
	if (!legacy) return undefined;
	if (legacy.models.length === 0) {
		return { version: GENERATED_CONFIG_VERSION, models: [] };
	}
	const targetOverrides: Record<string, GeneratedTargetOverride> = {};
	for (const target of legacy.models) {
		const key = modelKey(target);
		const override: GeneratedTargetOverride = {};
		const reasoningEffort = legacy.modelReasoningEfforts[key];
		const modelParameters = legacy.modelParameters[key];
		if (reasoningEffort !== undefined) override.reasoningEffort = reasoningEffort;
		if (modelParameters !== undefined)
			override.modelParameters = copyToggles(modelParameters);
		if (Object.keys(override).length > 0) targetOverrides[key] = override;
	}
	return {
		version: GENERATED_CONFIG_VERSION,
		models: [
			{
				id: DEFAULT_GENERATED_MODEL_ID,
				name: DEFAULT_GENERATED_MODEL_NAME,
				enabled: legacy.enabled,
				chain: legacy.models.map(copyModelRef),
				reasoningEffort: legacy.reasoningEffort,
				errorHandlingMode: legacy.errorHandlingMode,
				maxRetries: legacy.maxRetries,
				noProgressTimeoutSeconds: legacy.noProgressTimeoutSeconds,
				modelParameters: { ...DEFAULT_PARAMETER_TOGGLES },
				targetOverrides,
				manualRecovery: { ...legacy.manualRecovery },
			},
		],
	};
}

export function validateGeneratedConfig(
	value: unknown,
): GeneratedFailoverConfig | undefined {
	const migrated = migrateGeneratedConfig(value);
	if (!migrated || migrated.version !== GENERATED_CONFIG_VERSION)
		return undefined;
	if (!Array.isArray(migrated.models)) return undefined;
	const models: GeneratedFailoverModel[] = [];
	const ids = new Set<string>();
	for (const entry of migrated.models) {
		const model = readGeneratedModel(entry);
		if (!model || ids.has(model.id)) return undefined;
		ids.add(model.id);
		models.push(model);
	}
	return createGeneratedConfig(models);
}

export type GeneratedConfigLoadResult =
	| { kind: "missing"; revision: ConfigSourceRevision }
	| {
			kind: "loaded";
			config: GeneratedFailoverConfig;
			migrated: boolean;
			revision: ConfigSourceRevision;
	  }
	| {
			kind: "blocked";
			reason: "malformed" | "invalid" | "unreadable";
			detail: string;
	  };

export async function loadGeneratedConfig(
	path: string,
): Promise<GeneratedConfigLoadResult> {
	const source = await readJsonSource(path, "Configuration");
	if (source.kind !== "parsed") return source;
	const raw = source.value;
	const config = validateGeneratedConfig(raw);
	if (!config)
		return {
			kind: "blocked",
			reason: "invalid",
			detail: "Configuration does not match the generated-model schema",
		};
	return {
		kind: "loaded",
		config,
		migrated: isRecord(raw) && raw.version !== GENERATED_CONFIG_VERSION,
		revision: source.revision,
	};
}

export type SaveGeneratedConfigResult =
	| { kind: "saved" }
	| { kind: "conflict" };

export async function saveGeneratedConfig(
	path: string,
	config: GeneratedFailoverConfig,
	expectedRevision: ConfigSourceRevision,
): Promise<SaveGeneratedConfigResult> {
	const validated = validateGeneratedConfig(config);
	if (!validated)
		throw new Error("Refusing to write invalid generated failover config");
	return writeJsonAtomically(
		path,
		"generated config",
		expectedRevision,
		() => validated,
	);
}

const GENERATED_CONFIG_VERSION_V8 = 8 as const;
const GENERATED_CONFIG_V8_KEYS = new Set(["version", "models"]);
const GENERATED_MODEL_V8_KEYS = new Set(["id", "name", "enabled", "chain"]);
const MODEL_REF_KEYS = new Set(["provider", "id"]);
const FAILOVER_PROVIDER_ID = "failover";

function hasExactKeys(
	value: Record<string, unknown>,
	expected: ReadonlySet<string>,
): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function copyGeneratedModelV8(
	model: GeneratedFailoverModelV8,
): GeneratedFailoverModelV8 {
	return {
		id: model.id,
		name: model.name,
		enabled: model.enabled,
		chain: model.chain.map(copyModelRef),
	};
}

/** Build a detached version 8 chain config while preserving model identity and order. */
export function createGeneratedConfigV8(
	models: readonly GeneratedFailoverModelV8[] = [],
): GeneratedFailoverConfigV8 {
	return {
		version: GENERATED_CONFIG_VERSION_V8,
		models: models.map(copyGeneratedModelV8),
	};
}

/** Deep-copy a version 8 config without normalizing IDs, names, or chain order. */
export function copyGeneratedConfigV8(
	config: GeneratedFailoverConfigV8,
): GeneratedFailoverConfigV8 {
	return createGeneratedConfigV8(config.models);
}

function readModelRefV8(value: unknown): ModelRef | undefined {
	if (!isRecord(value) || !hasExactKeys(value, MODEL_REF_KEYS)) return undefined;
	const model = readModelRef(value);
	if (!model || model.provider === FAILOVER_PROVIDER_ID) return undefined;
	return model;
}

function readChainV8(value: unknown, enabled: boolean): ModelRef[] | undefined {
	if (!Array.isArray(value) || (enabled && value.length === 0)) return undefined;
	const chain: ModelRef[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const target = readModelRefV8(entry);
		if (!target) return undefined;
		const key = modelKey(target);
		if (seen.has(key)) return undefined;
		seen.add(key);
		chain.push(target);
	}
	return chain;
}

function readGeneratedModelV8(
	value: unknown,
): GeneratedFailoverModelV8 | undefined {
	if (!isRecord(value) || !hasExactKeys(value, GENERATED_MODEL_V8_KEYS))
		return undefined;
	if (
		!validGeneratedId(value.id) ||
		typeof value.name !== "string" ||
		value.name.trim().length === 0 ||
		value.name.length > 120 ||
		typeof value.enabled !== "boolean"
	)
		return undefined;
	const chain = readChainV8(value.chain, value.enabled);
	if (!chain) return undefined;
	return {
		id: value.id,
		name: value.name,
		enabled: value.enabled,
		chain,
	};
}

/** Validate the exact version 8 chain-only schema and return a detached copy. */
export function validateGeneratedConfigV8(
	value: unknown,
): GeneratedFailoverConfigV8 | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, GENERATED_CONFIG_V8_KEYS) ||
		value.version !== GENERATED_CONFIG_VERSION_V8 ||
		!Array.isArray(value.models)
	)
		return undefined;
	const models: GeneratedFailoverModelV8[] = [];
	const ids = new Set<string>();
	for (const entry of value.models) {
		const model = readGeneratedModelV8(entry);
		if (!model || ids.has(model.id)) return undefined;
		ids.add(model.id);
		models.push(model);
	}
	return createGeneratedConfigV8(models);
}

/** Remove version 7 policy fields only when the result is a valid version 8 config. */
export function stripLegacyToV8(
	config: GeneratedFailoverConfig,
): GeneratedFailoverConfigV8 | undefined {
	const stripped = createGeneratedConfigV8(
		config.models.map((model) => ({
			id: model.id,
			name: model.name,
			enabled: model.enabled,
			chain: model.chain,
		})),
	);
	return validateGeneratedConfigV8(stripped);
}

function legacyCandidateSource(
	model: GeneratedFailoverModel,
	chainIndex: number,
): string {
	return `generated model ${JSON.stringify(model.name)} (${model.id}), chain position ${String(chainIndex + 1)}`;
}

/**
 * Preserve every version 7 target occurrence for shared-state first-wins migration.
 * Candidates are emitted in model-array order, then chain order.
 */
export function extractLegacyTargetCandidates(
	config: GeneratedFailoverConfig,
): LegacyTargetCandidate[] {
	const candidates: LegacyTargetCandidate[] = [];
	for (const model of config.models) {
		for (const [chainIndex, target] of model.chain.entries()) {
			const key = modelKey(target);
			const override = model.targetOverrides[key];
			const manualRecoveryReason = model.manualRecovery[key];
			candidates.push({
				target: copyModelRef(target),
				settings: {
					enabled: true,
					errorHandlingMode: model.errorHandlingMode,
					maxRetries: model.maxRetries,
					noProgressTimeoutSeconds: model.noProgressTimeoutSeconds,
					reasoningEffort: override?.reasoningEffort ?? model.reasoningEffort,
					modelParameters: {
						...(override?.modelParameters ?? model.modelParameters),
					},
				},
				...(manualRecoveryReason === undefined ? {} : { manualRecoveryReason }),
				source: legacyCandidateSource(model, chainIndex),
			});
		}
	}
	return candidates;
}

export type LegacyGeneratedConfigVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type GeneratedConfigV8LoadResult =
	| { kind: "missing"; revision: ConfigSourceRevision }
	| {
			kind: "loaded-v8";
			config: GeneratedFailoverConfigV8;
			revision: ConfigSourceRevision;
	  }
	| {
			kind: "legacy";
			config: GeneratedFailoverConfig;
			v8: GeneratedFailoverConfigV8;
			candidates: LegacyTargetCandidate[];
			revision: ConfigSourceRevision;
			sourceVersion: LegacyGeneratedConfigVersion;
	  }
	| {
			kind: "blocked";
			reason: "malformed" | "invalid" | "unreadable" | "future-version";
			detail: string;
	  };

function readLegacyGeneratedConfigVersion(
	value: unknown,
): LegacyGeneratedConfigVersion | undefined {
	return Number.isInteger(value) &&
		typeof value === "number" &&
		value >= 1 &&
		value <= GENERATED_CONFIG_VERSION
		? (value as LegacyGeneratedConfigVersion)
		: undefined;
}

/** Read v8 or migrate supported legacy config in memory without touching source bytes. */
export async function loadGeneratedConfigV8(
	path: string,
): Promise<GeneratedConfigV8LoadResult> {
	const source = await readJsonSource(path, "Configuration");
	if (source.kind !== "parsed") return source;
	const raw = source.value;
	if (
		isRecord(raw) &&
		typeof raw.version === "number" &&
		Number.isInteger(raw.version) &&
		raw.version > GENERATED_CONFIG_VERSION_V8
	) {
		return {
			kind: "blocked",
			reason: "future-version",
			detail: `Configuration version ${String(raw.version)} is newer than supported version ${GENERATED_CONFIG_VERSION_V8}`,
		};
	}
	if (isRecord(raw) && raw.version === GENERATED_CONFIG_VERSION_V8) {
		const config = validateGeneratedConfigV8(raw);
		return config
			? { kind: "loaded-v8", config, revision: source.revision }
			: {
					kind: "blocked",
					reason: "invalid",
					detail: "Configuration does not match the version 8 chain schema",
				};
	}
	const sourceVersion = isRecord(raw)
		? readLegacyGeneratedConfigVersion(raw.version)
		: undefined;
	if (!sourceVersion) {
		return {
			kind: "blocked",
			reason: "invalid",
			detail: "Configuration does not match a supported generated-model schema",
		};
	}
	const config = validateGeneratedConfig(raw);
	if (!config) {
		return {
			kind: "blocked",
			reason: "invalid",
			detail: "Configuration does not match a supported generated-model schema",
		};
	}
	const v8 = stripLegacyToV8(config);
	if (!v8) {
		return {
			kind: "blocked",
			reason: "invalid",
			detail:
				"Legacy configuration cannot be projected to the version 8 chain schema",
		};
	}
	return {
		kind: "legacy",
		config,
		v8,
		candidates: extractLegacyTargetCandidates(config),
		revision: source.revision,
		sourceVersion,
	};
}

/** Atomically persist only an exact, validated version 8 chain config. */
export async function saveGeneratedConfigV8(
	path: string,
	config: GeneratedFailoverConfigV8,
	expectedRevision: ConfigSourceRevision,
): Promise<SaveGeneratedConfigResult> {
	const validated = validateGeneratedConfigV8(config);
	if (!validated)
		throw new Error("Refusing to write invalid version 8 generated config");
	return writeJsonAtomically(
		path,
		"generated config v8",
		expectedRevision,
		() => validated,
	);
}
