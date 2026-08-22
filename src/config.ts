import type { ConfigSourceRevision, SourceRead } from "./json-file.ts";
import {
	isRecord,
	readJsonSource,
	readManualRecovery,
	writeJsonAtomically,
} from "./json-file.ts";
import type {
	ErrorHandlingMode,
	FailoverConfig,
	ModelParameterToggles,
	ModelRef,
	ReasoningEffort,
} from "./types.ts";
import {
	ERROR_HANDLING_MODES,
	MODEL_PARAMETER_NAMES,
	REASONING_EFFORTS,
	modelKey,
} from "./types.ts";

export function resolveReasoningEffort(
	config: Pick<FailoverConfig, "reasoningEffort" | "modelReasoningEfforts">,
	model?: ModelRef,
): ReasoningEffort {
	return (
		(model && config.modelReasoningEfforts[modelKey(model)]) ??
		config.reasoningEffort
	);
}

const CONFIG_VERSION = 5 as const;
export const DEFAULT_COOLDOWN_MINUTES = 30;
export const DEFAULT_ERROR_HANDLING_MODE: ErrorHandlingMode = "smart";
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_NO_PROGRESS_TIMEOUT_SECONDS = 90;
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export function createDefaultConfig(models: ModelRef[] = []): FailoverConfig {
	return {
		version: CONFIG_VERSION,
		enabled: true,
		paused: false,
		models: models.map(copyModelRef),
		reasoningEffort: DEFAULT_REASONING_EFFORT,
		cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
		errorHandlingMode: DEFAULT_ERROR_HANDLING_MODE,
		maxRetries: DEFAULT_MAX_RETRIES,
		noProgressTimeoutSeconds: DEFAULT_NO_PROGRESS_TIMEOUT_SECONDS,
		manualRecovery: {},
		modelParameters: {},
		modelReasoningEfforts: {},
	};
}

function copyModelRef(model: ModelRef): ModelRef {
	return { provider: model.provider, id: model.id };
}

function isModelRef(value: unknown): value is ModelRef {
	if (!isRecord(value)) return false;
	return (
		typeof value.provider === "string" &&
		value.provider.trim().length > 0 &&
		typeof value.id === "string" &&
		value.id.trim().length > 0
	);
}

function readModels(value: unknown): ModelRef[] | undefined {
	if (!Array.isArray(value) || !value.every(isModelRef)) return undefined;
	const seen = new Set<string>();
	const models: ModelRef[] = [];
	for (const model of value) {
		const normalized = copyModelRef(model);
		const key = `${normalized.provider}/${normalized.id}`;
		if (seen.has(key)) return undefined;
		seen.add(key);
		models.push(normalized);
	}
	return models;
}

function readReasoningEffort(value: unknown): ReasoningEffort | undefined {
	return typeof value === "string" &&
		(REASONING_EFFORTS as readonly string[]).includes(value)
		? (value as ReasoningEffort)
		: undefined;
}

function readModelReasoningEfforts(
	value: unknown,
): Record<string, ReasoningEffort> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, ReasoningEffort> = {};
	for (const [key, effort] of Object.entries(value)) {
		if (key.trim().length === 0) return undefined;
		const parsed = readReasoningEffort(effort);
		if (!parsed) return undefined;
		result[key] = parsed;
	}
	return result;
}

function readModelParameters(
	value: unknown,
): Record<string, ModelParameterToggles> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, ModelParameterToggles> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key.trim().length === 0 || !isRecord(entry)) return undefined;
		const toggles: Record<string, unknown> = {};
		for (const name of MODEL_PARAMETER_NAMES) toggles[name] = entry[name];
		if (MODEL_PARAMETER_NAMES.some((name) => typeof toggles[name] !== "boolean"))
			return undefined;
		// SAFETY: each named field was checked to be boolean immediately above.
		result[key] = toggles as unknown as ModelParameterToggles;
	}
	return result;
}

function readErrorHandlingMode(value: unknown): ErrorHandlingMode | undefined {
	return typeof value === "string" &&
		(ERROR_HANDLING_MODES as readonly string[]).includes(value)
		? (value as ErrorHandlingMode)
		: undefined;
}

export function isValidCooldownMinutes(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= 1440
	);
}

export function isValidMaxRetries(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= 10
	);
}

export function isValidTimeoutSeconds(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		(value === 0 || (value >= 15 && value <= 900))
	);
}

/** Add defaults for older persisted shapes without preserving fields outside the contract. */
export function migrateConfig(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version === 1) {
		value = {
			...value,
			version: 2,
			paused: false,
			manualRecovery: {},
		};
	}
	if (isRecord(value) && value.version === 2) {
		value = {
			...value,
			version: 3,
			cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
			errorHandlingMode: DEFAULT_ERROR_HANDLING_MODE,
			maxRetries: DEFAULT_MAX_RETRIES,
		};
	}
	if (isRecord(value) && value.version === 3) {
		value = {
			...value,
			version: 4,
			modelParameters: {},
		};
	}
	if (isRecord(value) && value.version === 4) {
		return {
			...value,
			version: CONFIG_VERSION,
			modelReasoningEfforts: {},
		};
	}
	return isRecord(value) ? value : undefined;
}

/** Normalize trusted config input and discard fields outside the persisted contract. */
export function validateConfig(value: unknown): FailoverConfig | undefined {
	const migrated = migrateConfig(value);
	if (
		!isRecord(migrated) ||
		migrated.version !== CONFIG_VERSION ||
		typeof migrated.enabled !== "boolean" ||
		typeof migrated.paused !== "boolean"
	) {
		return undefined;
	}
	const models = readModels(migrated.models);
	const manualRecovery = readManualRecovery(migrated.manualRecovery);
	const modelParameters = readModelParameters(migrated.modelParameters);
	const modelReasoningEfforts = readModelReasoningEfforts(
		migrated.modelReasoningEfforts,
	);
	const reasoningEffort =
		migrated.reasoningEffort === undefined
			? DEFAULT_REASONING_EFFORT
			: readReasoningEffort(migrated.reasoningEffort);
	const errorHandlingMode = readErrorHandlingMode(migrated.errorHandlingMode);
	if (
		!models ||
		manualRecovery === undefined ||
		modelParameters === undefined ||
		modelReasoningEfforts === undefined ||
		!reasoningEffort ||
		!isValidCooldownMinutes(migrated.cooldownMinutes) ||
		errorHandlingMode === undefined ||
		!isValidMaxRetries(migrated.maxRetries) ||
		!isValidTimeoutSeconds(migrated.noProgressTimeoutSeconds)
	) {
		return undefined;
	}

	return {
		version: CONFIG_VERSION,
		enabled: migrated.enabled,
		paused: migrated.paused,
		models,
		reasoningEffort,
		cooldownMinutes: migrated.cooldownMinutes,
		errorHandlingMode,
		maxRetries: migrated.maxRetries,
		noProgressTimeoutSeconds: migrated.noProgressTimeoutSeconds,
		manualRecovery,
		modelParameters,
		modelReasoningEfforts,
	};
}

type ConfigLoadFailure =
	| { reason: "malformed" | "invalid" | "unreadable"; detail: string }
	| { reason: "future-version"; version: number; detail: string };

export type ConfigLoadResult =
	| ({ kind: "missing" } & SourceRead)
	| ({
			kind: "loaded";
			config: FailoverConfig;
			migrated: boolean;
	  } & SourceRead)
	| { kind: "blocked"; failure: ConfigLoadFailure };

export async function loadConfig(path: string): Promise<ConfigLoadResult> {
	const source = await readJsonSource(path, "Configuration");
	if (source.kind === "blocked")
		return {
			kind: "blocked",
			failure: { reason: source.reason, detail: source.detail },
		};
	if (source.kind === "missing")
		return { kind: "missing", revision: source.revision };
	const raw = source.value;
	if (
		isRecord(raw) &&
		Number.isInteger(raw.version) &&
		(raw.version as number) > CONFIG_VERSION
	) {
		return {
			kind: "blocked",
			failure: {
				reason: "future-version",
				version: raw.version as number,
				detail: `Configuration version ${String(raw.version)} is newer than supported version ${CONFIG_VERSION}`,
			},
		};
	}
	const config = validateConfig(raw);
	if (!config) {
		return {
			kind: "blocked",
			failure: {
				reason: "invalid",
				detail: "Configuration does not match a supported schema",
			},
		};
	}
	return {
		kind: "loaded",
		config,
		migrated: isRecord(raw) && raw.version !== CONFIG_VERSION,
		revision: source.revision,
	};
}

export type SaveConfigResult = { kind: "saved" } | { kind: "conflict" };

/** Lock, compare the retained source revision, then atomically replace the target. */
export async function saveConfig(
	path: string,
	config: FailoverConfig,
	expectedRevision: ConfigSourceRevision,
): Promise<SaveConfigResult> {
	const validated = validateConfig(config);
	if (!validated) throw new Error("Refusing to write invalid failover config");
	return writeJsonAtomically(path, "config", expectedRevision, () => validated);
}
