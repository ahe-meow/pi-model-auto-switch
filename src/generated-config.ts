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
	type GeneratedFailoverModel,
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
