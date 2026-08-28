import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
	AtomicWriteResult,
	ConfigSourceRevision,
	SourceRead,
} from "./json-file.ts";
import { isRecord, readJsonSource, writeJsonAtomically } from "./json-file.ts";
import { isValidMaxRetries, isValidTimeoutSeconds } from "./config.ts";
import { COOLDOWN_LADDER_MINUTES, retryDelayMs } from "./state.ts";
import {
	DEFAULT_PARAMETER_TOGGLES,
	ERROR_HANDLING_MODES,
	MODEL_PARAMETER_NAMES,
	REASONING_EFFORTS,
	type ErrorHandlingMode,
	type ModelParameterName,
	type ModelParameterToggles,
	type ModelRef,
	type ReasoningEffort,
} from "./types.ts";

export const SHARED_STATE_VERSION = 1 as const;

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_TIMEOUT_SECONDS = 90;
const DEFAULT_ERROR_HANDLING_MODE: ErrorHandlingMode = "smart";
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
const DEFAULT_ENABLED = true;
const DEFAULT_MAX_CAS_ATTEMPTS = 3;
const MAX_CAS_ATTEMPTS = 20;
const UNSAFE_MAP_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const COORDINATION_FAILURE_DETAIL =
	"Shared failover coordination is unavailable; repair shared state and retry";

export function getFailoverStatePath(home = homedir()): string {
	return join(home, ".pi", "agent", "failover-state.json");
}

export const FAILOVER_STATE_PATH = getFailoverStatePath();

export interface SharedTargetSettings {
	enabled: boolean;
	errorHandlingMode: ErrorHandlingMode;
	maxRetries: number;
	noProgressTimeoutSeconds: number;
	reasoningEffort: ReasoningEffort;
	modelParameters: ModelParameterToggles;
}

export type Inheritable<T> = T | "inherit";

export type SharedChainSettings = Omit<SharedTargetSettings, "enabled">;

export interface SharedTargetOverride {
	errorHandlingMode: Inheritable<ErrorHandlingMode>;
	maxRetries: Inheritable<number>;
	noProgressTimeoutSeconds: Inheritable<number>;
	reasoningEffort: Inheritable<ReasoningEffort>;
	modelParameters: Record<ModelParameterName, Inheritable<boolean>>;
}

export interface SharedChainScope {
	settings: SharedChainSettings;
	targets: string[];
	overrides: Record<string, SharedTargetOverride>;
}

export interface SharedScopeRegistration {
	key: string;
	targets: readonly SharedTargetReference[];
}

export type SharedChainSettingsPatch = Partial<
	Omit<SharedChainSettings, "modelParameters">
> & {
	modelParameters?: Partial<ModelParameterToggles>;
};

export type SharedTargetOverridePatch = Partial<
	Omit<SharedTargetOverride, "modelParameters">
> & {
	modelParameters?: Partial<SharedTargetOverride["modelParameters"]>;
};

export interface SharedManualRecovery {
	reason: string;
	updatedAt: number;
}

export interface SharedTargetRuntime {
	consecutiveFailures: number;
	nextEligibleAt: number | null;
	cooldownUntil: number | null;
	cooldownLevel: number;
	cumulativeCooldownMs: number;
	manualRecovery: SharedManualRecovery | null;
	lastFailureReason: string | null;
	lastFailureAt: number | null;
	updatedAt: number;
}

export interface SharedTargetRecord {
	settings: SharedTargetSettings;
	runtime: SharedTargetRuntime;
}

export interface SharedRegistration {
	targets: string[];
	scopeKeys: string[];
	updatedAt: number;
}

export interface SharedStateDocument {
	version: typeof SHARED_STATE_VERSION;
	revision: number;
	targets: Record<string, SharedTargetRecord>;
	registrations: Record<string, SharedRegistration>;
	scopes: Record<string, SharedChainScope>;
}

export type SharedDegradedReason =
	| "malformed"
	| "invalid"
	| "future-version"
	| "unreadable"
	| "write-failed"
	| "cas-exhausted";

export type SharedCoordinationStatus =
	| { coordination: "shared" }
	| {
			coordination: "degraded";
			reason: SharedDegradedReason;
			detail: string;
	  };

export type SharedTargetReference = string | ModelRef;

export type SharedTargetSelector =
	| { targetKey: string; target?: never }
	| { target: ModelRef; targetKey?: never };

export type SharedTargetSettingsPatch = Partial<
	Omit<SharedTargetSettings, "modelParameters">
> & {
	modelParameters?: Partial<ModelParameterToggles>;
};

export interface LegacyTargetCandidate {
	target: SharedTargetReference;
	settings: SharedTargetSettings;
	manualRecoveryReason?: string;
	source: string;
}

export type SharedSettleOutcome =
	| { kind: "success" }
	| { kind: "automatic-failure"; reason?: string }
	| { kind: "persistent-failure"; reason?: string }
	| { kind: "compatibility-retry" };

export type ClaimInput = SharedTargetSelector & {
	effectiveRequestTimeoutMs: number;
	scopeKey?: string;
};

export type SettleInput = SharedTargetSelector & {
	outcome: SharedSettleOutcome;
	scopeKey?: string;
	effectiveSettings?: SharedTargetSettings;
};

export interface ReconcileRegistrationInput {
	agentDirectory: string;
	targets: readonly SharedTargetReference[];
	legacyCandidates?: readonly LegacyTargetCandidate[];
	scopes?: readonly SharedScopeRegistration[];
}

type Coordinated<T> = T extends unknown ? T & SharedCoordinationStatus : never;
type InvalidResult = { kind: "invalid"; detail: string };

type ClaimCoreResult =
	| {
			kind: "claimed";
			targetKey: string;
			settings: SharedTargetSettings;
			runtime: SharedTargetRuntime;
	  }
	| {
			kind: "skipped";
			targetKey: string;
			skipReason:
				| "disabled"
				| "manual-recovery"
				| "cooldown"
				| "retry"
				| "unknown-target";
			until?: number;
			manualRecovery?: SharedManualRecovery;
			runtime: SharedTargetRuntime | null;
	  }
	| InvalidResult;

export type ClaimResult = Coordinated<ClaimCoreResult>;

type SettledCoreResult = (
	| { kind: "settled"; action: "success"; targetKey: string }
	| {
			kind: "settled";
			action: "retry" | "compatibility-retry";
			targetKey: string;
			nextEligibleAt?: number;
			failureReason?: string;
	  }
	| {
			kind: "settled";
			action: "cooldown";
			targetKey: string;
			cooldownUntil: number;
			failureReason: string;
	  }
	| {
			kind: "settled";
			action: "manual-recovery";
			targetKey: string;
			manualRecovery: SharedManualRecovery;
	  }
) & { runtime: SharedTargetRuntime };

type SettleCoreResult =
	| SettledCoreResult
	| {
			kind: "stale";
			targetKey: string;
			runtime: SharedTargetRuntime | null;
	  }
	| InvalidResult;

export type SettleResult = Coordinated<SettleCoreResult>;

type UpdateSettingsCoreResult =
	| {
			kind: "updated";
			targetKey: string;
			settings: SharedTargetSettings;
	  }
	| InvalidResult;

export type UpdateSettingsResult = Coordinated<UpdateSettingsCoreResult>;

export type UpdateScopeSettingsResult = Coordinated<
	| { kind: "updated"; scopeKey: string; settings: SharedChainSettings }
	| InvalidResult
>;

export type UpdateTargetOverrideResult = Coordinated<
	| {
			kind: "updated";
			scopeKey: string;
			targetKey: string;
			override: SharedTargetOverride;
	  }
	| InvalidResult
>;

type ResetTargetsCoreResult =
	| { kind: "reset"; targetKeys: string[] }
	| InvalidResult;

export type ResetTargetsResult = Coordinated<ResetTargetsCoreResult>;

type ReconcileRegistrationCoreResult =
	| {
			kind: "reconciled";
			registrationKey: string;
			targets: string[];
	  }
	| InvalidResult;

export type ReconcileRegistrationResult =
	Coordinated<ReconcileRegistrationCoreResult>;

export interface SharedStateAdapter {
	status(): SharedCoordinationStatus;
	snapshot(): Promise<{
		document: SharedStateDocument;
		status: SharedCoordinationStatus;
	}>;
	reconcileRegistration(
		input: ReconcileRegistrationInput,
	): Promise<ReconcileRegistrationResult>;
	claim(input: ClaimInput): Promise<ClaimResult>;
	settle(input: SettleInput): Promise<SettleResult>;
	updateSettings(
		target: SharedTargetReference,
		patch: SharedTargetSettingsPatch,
	): Promise<UpdateSettingsResult>;
	updateScopeSettings?: (
		scopeKey: string,
		patch: SharedChainSettingsPatch,
	) => Promise<UpdateScopeSettingsResult>;
	updateTargetOverride?: (
		scopeKey: string,
		target: SharedTargetReference,
		patch: SharedTargetOverridePatch,
	) => Promise<UpdateTargetOverrideResult>;
	resetTargets(
		targets: readonly SharedTargetReference[],
	): Promise<ResetTargetsResult>;
}

export type SharedStateCas = <T>(
	path: string,
	label: string,
	expectedRevision: ConfigSourceRevision,
	build: (current: SourceRead) => T | undefined,
) => Promise<AtomicWriteResult>;

interface CommonAdapterOptions {
	now?: () => number;
	warn?: (message: string) => void;
}

export interface FileSharedStateOptions extends CommonAdapterOptions {
	path?: string;
	cas?: SharedStateCas;
	maxAttempts?: number;
}

export interface MemorySharedStateOptions extends CommonAdapterOptions {
	document?: unknown;
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const keys = Object.keys(value);
	return (
		keys.length === expected.length &&
		expected.every((key) => Object.hasOwn(value, key))
	);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isTimestamp(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isValidRevision(value: unknown): value is number {
	return isNonNegativeInteger(value) && value < Number.MAX_SAFE_INTEGER;
}

function isSafeMapKey(value: string): boolean {
	return (
		value.length > 0 &&
		!/[\u0000-\u001f\u007f]/.test(value) &&
		!UNSAFE_MAP_KEYS.has(value)
	);
}

function isCleanIdentifier(value: string, allowSlash: boolean): boolean {
	return (
		value.length > 0 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value) &&
		(allowSlash || !value.includes("/")) &&
		!UNSAFE_MAP_KEYS.has(value)
	);
}

function parseTargetKey(value: unknown): string | undefined {
	if (typeof value !== "string" || !isSafeMapKey(value)) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	const provider = value.slice(0, slash);
	const model = value.slice(slash + 1);
	if (
		provider === "failover" ||
		!isCleanIdentifier(provider, false) ||
		!isCleanIdentifier(model, true)
	)
		return undefined;
	return value;
}

function parseTargetReference(value: unknown): string | undefined {
	if (typeof value === "string") return parseTargetKey(value);
	if (!isRecord(value) || !hasExactKeys(value, ["provider", "id"]))
		return undefined;
	if (typeof value.provider !== "string" || typeof value.id !== "string")
		return undefined;
	if (
		value.provider === "failover" ||
		!isCleanIdentifier(value.provider, false) ||
		!isCleanIdentifier(value.id, true)
	)
		return undefined;
	return parseTargetKey(`${value.provider}/${value.id}`);
}

function parseErrorHandlingMode(value: unknown): ErrorHandlingMode | undefined {
	return typeof value === "string" &&
		(ERROR_HANDLING_MODES as readonly string[]).includes(value)
		? (value as ErrorHandlingMode)
		: undefined;
}

function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
	return typeof value === "string" &&
		(REASONING_EFFORTS as readonly string[]).includes(value)
		? (value as ReasoningEffort)
		: undefined;
}

function parseModelParameters(
	value: unknown,
): ModelParameterToggles | undefined {
	if (!isRecord(value) || !hasExactKeys(value, MODEL_PARAMETER_NAMES))
		return undefined;
	for (const name of MODEL_PARAMETER_NAMES) {
		if (typeof value[name] !== "boolean") return undefined;
	}
	return {
		promptCacheKey: value.promptCacheKey as boolean,
		promptCacheRetention: value.promptCacheRetention as boolean,
		reasoningEffort: value.reasoningEffort as boolean,
		sessionAffinity: value.sessionAffinity as boolean,
	};
}

function parseSettings(value: unknown): SharedTargetSettings | undefined {
	if (!isRecord(value)) return undefined;
	const keys = Object.keys(value);
	const legacyKeys = [
		"errorHandlingMode",
		"maxRetries",
		"noProgressTimeoutSeconds",
		"reasoningEffort",
		"modelParameters",
	];
	if (
		(keys.length !== legacyKeys.length &&
			keys.length !== legacyKeys.length + 1) ||
		!legacyKeys.every((key) => Object.hasOwn(value, key)) ||
		(keys.length === legacyKeys.length + 1 && !Object.hasOwn(value, "enabled"))
	)
		return undefined;
	const errorHandlingMode = parseErrorHandlingMode(value.errorHandlingMode);
	const reasoningEffort = parseReasoningEffort(value.reasoningEffort);
	const modelParameters = parseModelParameters(value.modelParameters);
	if (
		!errorHandlingMode ||
		!reasoningEffort ||
		!modelParameters ||
		!isValidMaxRetries(value.maxRetries) ||
		!isValidTimeoutSeconds(value.noProgressTimeoutSeconds) ||
		(value.enabled !== undefined && typeof value.enabled !== "boolean")
	)
		return undefined;
	return {
		enabled: value.enabled === undefined ? true : value.enabled,
		errorHandlingMode,
		maxRetries: value.maxRetries,
		noProgressTimeoutSeconds: value.noProgressTimeoutSeconds,
		reasoningEffort,
		modelParameters,
	};
}

function parseEffectiveSettings(
	value: unknown,
): SharedTargetSettings | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"enabled",
			"errorHandlingMode",
			"maxRetries",
			"noProgressTimeoutSeconds",
			"reasoningEffort",
			"modelParameters",
		])
	)
		return undefined;
	const settings = parseSettings(value);
	return settings && Object.hasOwn(value, "enabled") ? settings : undefined;
}

const PERSISTENT_REASONS = new Set([
	"HTTP 401",
	"HTTP 403",
	"HTTP 404",
	"balance/quota/usage failure",
	"model unavailable",
	"persistent provider failure",
]);

function isAutomaticReason(value: string): boolean {
	return (
		value === "automatic provider failure" ||
		value === "network failure" ||
		value === "no-progress timeout" ||
		value === "HTTP 429" ||
		/^HTTP 5\d\d$/.test(value)
	);
}

function isPersistableReason(value: unknown): value is string {
	return (
		typeof value === "string" &&
		(PERSISTENT_REASONS.has(value) || isAutomaticReason(value))
	);
}

function parseManualRecovery(
	value: unknown,
): SharedManualRecovery | null | undefined {
	if (value === null) return null;
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["reason", "updatedAt"]) ||
		!isTimestamp(value.updatedAt) ||
		typeof value.reason !== "string" ||
		!PERSISTENT_REASONS.has(value.reason)
	)
		return undefined;
	return { reason: value.reason, updatedAt: value.updatedAt };
}

function parseRuntime(value: unknown): SharedTargetRuntime | undefined {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"consecutiveFailures",
			"nextEligibleAt",
			"cooldownUntil",
			"cooldownLevel",
			"cumulativeCooldownMs",
			"manualRecovery",
			"lastFailureReason",
			"lastFailureAt",
			"updatedAt",
			"lease",
		]) ||
		!Object.hasOwn(value, "consecutiveFailures") ||
		!isNonNegativeInteger(value.consecutiveFailures) ||
		!isNonNegativeInteger(value.cumulativeCooldownMs) ||
		!Number.isInteger(value.cooldownLevel) ||
		(value.cooldownLevel as number) < 0 ||
		(value.cooldownLevel as number) >= COOLDOWN_LADDER_MINUTES.length ||
		!isTimestamp(value.updatedAt)
	)
		return undefined;
	if (
		(value.nextEligibleAt !== null && !isTimestamp(value.nextEligibleAt)) ||
		(value.cooldownUntil !== null && !isTimestamp(value.cooldownUntil)) ||
		(value.lastFailureAt !== null && !isTimestamp(value.lastFailureAt)) ||
		(value.lastFailureReason !== null &&
			!isPersistableReason(value.lastFailureReason))
	)
		return undefined;
	if ((value.lastFailureReason === null) !== (value.lastFailureAt === null))
		return undefined;
	const manualRecovery = parseManualRecovery(value.manualRecovery);
	if (manualRecovery === undefined) return undefined;
	return {
		consecutiveFailures: value.consecutiveFailures,
		nextEligibleAt: value.nextEligibleAt as number | null,
		cooldownUntil: value.cooldownUntil as number | null,
		cooldownLevel: value.cooldownLevel as number,
		cumulativeCooldownMs: value.cumulativeCooldownMs,
		manualRecovery,
		lastFailureReason: value.lastFailureReason as string | null,
		lastFailureAt: value.lastFailureAt as number | null,
		updatedAt: value.updatedAt,
	};
}

function parseRegistration(value: unknown): SharedRegistration | undefined {
	if (
		!isRecord(value) ||
		(!hasExactKeys(value, ["targets", "updatedAt"]) &&
			!hasExactKeys(value, ["targets", "scopeKeys", "updatedAt"])) ||
		!Array.isArray(value.targets) ||
		(value.scopeKeys !== undefined && !Array.isArray(value.scopeKeys)) ||
		!isTimestamp(value.updatedAt)
	)
		return undefined;
	const targets: string[] = [];
	for (const entry of value.targets) {
		const key = parseTargetKey(entry);
		if (!key) return undefined;
		targets.push(key);
	}
	const scopeKeys: string[] = [];
	for (const entry of value.scopeKeys ?? []) {
		const key = parseScopeKey(entry);
		if (!key) return undefined;
		scopeKeys.push(key);
	}
	// pi-lens-ignore: no-sort-without-comparator
	const sortedTargets = [...new Set(targets)].sort();
	// pi-lens-ignore: no-sort-without-comparator
	const sortedScopeKeys = [...new Set(scopeKeys)].sort();
	if (
		sortedTargets.length !== targets.length ||
		sortedTargets.some((entry, index) => entry !== targets[index]) ||
		sortedScopeKeys.length !== scopeKeys.length ||
		sortedScopeKeys.some((entry, index) => entry !== scopeKeys[index])
	)
		return undefined;
	return { targets, scopeKeys, updatedAt: value.updatedAt };
}

function parseChainSettings(value: unknown): SharedChainSettings | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"errorHandlingMode",
			"maxRetries",
			"noProgressTimeoutSeconds",
			"reasoningEffort",
			"modelParameters",
		])
	)
		return undefined;
	const errorHandlingMode = parseErrorHandlingMode(value.errorHandlingMode);
	const reasoningEffort = parseReasoningEffort(value.reasoningEffort);
	const modelParameters = parseModelParameters(value.modelParameters);
	if (
		!errorHandlingMode ||
		!reasoningEffort ||
		!modelParameters ||
		!isValidMaxRetries(value.maxRetries) ||
		!isValidTimeoutSeconds(value.noProgressTimeoutSeconds)
	)
		return undefined;
	return {
		errorHandlingMode,
		maxRetries: value.maxRetries,
		noProgressTimeoutSeconds: value.noProgressTimeoutSeconds,
		reasoningEffort,
		modelParameters,
	};
}

function parseInheritable<T>(
	value: unknown,
	parse: (value: unknown) => T | undefined,
): Inheritable<T> | undefined {
	if (value === "inherit") return "inherit";
	return parse(value);
}

function parseTargetOverride(value: unknown): SharedTargetOverride | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"errorHandlingMode",
			"maxRetries",
			"noProgressTimeoutSeconds",
			"reasoningEffort",
			"modelParameters",
		]) ||
		!isRecord(value.modelParameters) ||
		!hasExactKeys(value.modelParameters, MODEL_PARAMETER_NAMES)
	)
		return undefined;
	const errorHandlingMode = parseInheritable(
		value.errorHandlingMode,
		parseErrorHandlingMode,
	);
	const maxRetries = parseInheritable(value.maxRetries, (entry) =>
		isValidMaxRetries(entry) ? entry : undefined,
	);
	const noProgressTimeoutSeconds = parseInheritable(
		value.noProgressTimeoutSeconds,
		(entry) => (isValidTimeoutSeconds(entry) ? entry : undefined),
	);
	const reasoningEffort = parseInheritable(
		value.reasoningEffort,
		parseReasoningEffort,
	);
	if (
		errorHandlingMode === undefined ||
		maxRetries === undefined ||
		noProgressTimeoutSeconds === undefined ||
		reasoningEffort === undefined
	)
		return undefined;
	const modelParameters = {} as SharedTargetOverride["modelParameters"];
	for (const name of MODEL_PARAMETER_NAMES) {
		const parsed = parseInheritable(value.modelParameters[name], (entry) =>
			typeof entry === "boolean" ? entry : undefined,
		);
		if (parsed === undefined) return undefined;
		modelParameters[name] = parsed;
	}
	return {
		errorHandlingMode,
		maxRetries,
		noProgressTimeoutSeconds,
		reasoningEffort,
		modelParameters,
	};
}

function parseScope(value: unknown): SharedChainScope | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["settings", "targets", "overrides"]) ||
		!Array.isArray(value.targets) ||
		!isRecord(value.overrides)
	)
		return undefined;
	const settings = parseChainSettings(value.settings);
	if (!settings) return undefined;
	const targets: string[] = [];
	for (const entry of value.targets) {
		const key = parseTargetKey(entry);
		if (!key || targets.includes(key)) return undefined;
		targets.push(key);
	}
	const overrides: Record<string, SharedTargetOverride> = {};
	for (const [key, entry] of Object.entries(value.overrides)) {
		if (!targets.includes(key)) return undefined;
		const override = parseTargetOverride(entry);
		if (!override) return undefined;
		overrides[key] = override;
	}
	for (const targetKey of targets) {
		if (!overrides[targetKey]) overrides[targetKey] = createInheritOverride();
	}
	return { settings, targets, overrides };
}

function parseScopeKey(value: unknown): string | undefined {
	return typeof value === "string" && isCleanIdentifier(value, false)
		? value
		: undefined;
}

function parseDocument(value: unknown): SharedStateDocument | undefined {
	if (
		!isRecord(value) ||
		(value.scopes === undefined
			? !hasExactKeys(value, ["version", "revision", "targets", "registrations"])
			: !hasExactKeys(value, [
					"version",
					"revision",
					"targets",
					"registrations",
					"scopes",
				])) ||
		value.version !== SHARED_STATE_VERSION ||
		!isValidRevision(value.revision) ||
		!isRecord(value.targets) ||
		!isRecord(value.registrations) ||
		(value.scopes !== undefined && !isRecord(value.scopes))
	)
		return undefined;
	const targets: Record<string, SharedTargetRecord> = {};
	for (const [key, entry] of Object.entries(value.targets)) {
		if (
			!parseTargetKey(key) ||
			!isRecord(entry) ||
			!hasExactKeys(entry, ["settings", "runtime"])
		)
			return undefined;
		const settings = parseSettings(entry.settings);
		const runtime = parseRuntime(entry.runtime);
		if (!settings || !runtime) return undefined;
		targets[key] = { settings, runtime };
	}
	const registrations: Record<string, SharedRegistration> = {};
	for (const [key, entry] of Object.entries(value.registrations)) {
		if (!isSafeMapKey(key) || !isAbsolute(key) || resolve(key) !== key)
			return undefined;
		const registration = parseRegistration(entry);
		if (!registration) return undefined;
		registrations[key] = registration;
	}
	for (const registration of Object.values(registrations)) {
		for (const targetKey of registration.targets) {
			if (!Object.hasOwn(targets, targetKey)) return undefined;
		}
	}
	const scopes: Record<string, SharedChainScope> = {};
	if (value.scopes !== undefined) {
		for (const [key, entry] of Object.entries(value.scopes)) {
			if (!parseScopeKey(key)) return undefined;
			const scope = parseScope(entry);
			if (
				!scope ||
				scope.targets.some((targetKey) => !Object.hasOwn(targets, targetKey))
			)
				return undefined;
			scopes[key] = scope;
		}
	}
	return {
		version: SHARED_STATE_VERSION,
		revision: value.revision,
		targets,
		registrations,
		scopes,
	};
}

function createDefaultDocument(): SharedStateDocument {
	return {
		version: SHARED_STATE_VERSION,
		revision: 0,
		targets: {},
		registrations: {},
		scopes: {},
	};
}

function createDefaultSettings(): SharedTargetSettings {
	return {
		enabled: DEFAULT_ENABLED,
		errorHandlingMode: DEFAULT_ERROR_HANDLING_MODE,
		maxRetries: DEFAULT_MAX_RETRIES,
		noProgressTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
		reasoningEffort: DEFAULT_REASONING_EFFORT,
		modelParameters: { ...DEFAULT_PARAMETER_TOGGLES },
	};
}

function createDefaultRuntime(now: number): SharedTargetRuntime {
	return {
		consecutiveFailures: 0,
		nextEligibleAt: null,
		cooldownUntil: null,
		cooldownLevel: 0,
		cumulativeCooldownMs: 0,
		manualRecovery: null,
		lastFailureReason: null,
		lastFailureAt: null,
		updatedAt: now,
	};
}

function copyChainSettings(settings: SharedChainSettings): SharedChainSettings {
	return { ...settings, modelParameters: { ...settings.modelParameters } };
}

function createInheritOverride(): SharedTargetOverride {
	const modelParameters = {} as SharedTargetOverride["modelParameters"];
	for (const name of MODEL_PARAMETER_NAMES) modelParameters[name] = "inherit";
	return {
		errorHandlingMode: "inherit",
		maxRetries: "inherit",
		noProgressTimeoutSeconds: "inherit",
		reasoningEffort: "inherit",
		modelParameters,
	};
}

function copyTargetOverride(
	override: SharedTargetOverride,
): SharedTargetOverride {
	return {
		...override,
		modelParameters: { ...override.modelParameters },
	};
}

function copyChainScope(scope: SharedChainScope): SharedChainScope {
	const overrides: Record<string, SharedTargetOverride> = {};
	for (const [key, override] of Object.entries(scope.overrides))
		overrides[key] = copyTargetOverride(override);
	return {
		settings: copyChainSettings(scope.settings),
		targets: [...scope.targets],
		overrides,
	};
}

function copySettings(settings: SharedTargetSettings): SharedTargetSettings {
	return { ...settings, modelParameters: { ...settings.modelParameters } };
}

function copyRuntime(runtime: SharedTargetRuntime): SharedTargetRuntime {
	return {
		...runtime,
		manualRecovery: runtime.manualRecovery ? { ...runtime.manualRecovery } : null,
	};
}

function copyDocument(document: SharedStateDocument): SharedStateDocument {
	const targets: Record<string, SharedTargetRecord> = {};
	for (const [key, record] of Object.entries(document.targets)) {
		targets[key] = {
			settings: copySettings(record.settings),
			runtime: copyRuntime(record.runtime),
		};
	}
	const registrations: Record<string, SharedRegistration> = {};
	for (const [key, registration] of Object.entries(document.registrations)) {
		registrations[key] = {
			targets: [...registration.targets],
			scopeKeys: [...registration.scopeKeys],
			updatedAt: registration.updatedAt,
		};
	}
	const scopes: Record<string, SharedChainScope> = {};
	for (const [key, scope] of Object.entries(document.scopes))
		scopes[key] = copyChainScope(scope);
	return {
		version: SHARED_STATE_VERSION,
		revision: document.revision,
		targets,
		registrations,
		scopes,
	};
}

function chainSettingsFrom(
	settings: SharedTargetSettings,
): SharedChainSettings {
	const { enabled: _enabled, ...chainSettings } = copySettings(settings);
	return chainSettings;
}

function inherited<T>(value: Inheritable<T>, fallback: T): T {
	return value === "inherit" ? fallback : value;
}

function resolveEffectiveSettings(
	document: SharedStateDocument,
	targetKey: string,
	scopeKey: string | undefined,
): SharedTargetSettings | InvalidResult | undefined {
	const record = document.targets[targetKey];
	if (!record) return undefined;
	if (scopeKey === undefined) return copySettings(record.settings);
	const scope = document.scopes[scopeKey];
	if (!scope || !scope.targets.includes(targetKey)) {
		return {
			kind: "invalid",
			detail: "The chain scope does not contain this target",
		};
	}
	const override = scope.overrides[targetKey] ?? createInheritOverride();
	const modelParameters = {} as ModelParameterToggles;
	for (const name of MODEL_PARAMETER_NAMES) {
		modelParameters[name] = inherited(
			override.modelParameters[name],
			scope.settings.modelParameters[name],
		);
	}
	return {
		enabled: record.settings.enabled,
		errorHandlingMode: inherited(
			override.errorHandlingMode,
			scope.settings.errorHandlingMode,
		),
		maxRetries: inherited(override.maxRetries, scope.settings.maxRetries),
		noProgressTimeoutSeconds: inherited(
			override.noProgressTimeoutSeconds,
			scope.settings.noProgressTimeoutSeconds,
		),
		reasoningEffort: inherited(
			override.reasoningEffort,
			scope.settings.reasoningEffort,
		),
		modelParameters,
	};
}

function chainSettingsEqual(
	a: SharedChainSettings,
	b: SharedChainSettings,
): boolean {
	return (
		a.errorHandlingMode === b.errorHandlingMode &&
		a.maxRetries === b.maxRetries &&
		a.noProgressTimeoutSeconds === b.noProgressTimeoutSeconds &&
		a.reasoningEffort === b.reasoningEffort &&
		MODEL_PARAMETER_NAMES.every(
			(name) => a.modelParameters[name] === b.modelParameters[name],
		)
	);
}

function targetOverrideEqual(
	a: SharedTargetOverride,
	b: SharedTargetOverride,
): boolean {
	return (
		a.errorHandlingMode === b.errorHandlingMode &&
		a.maxRetries === b.maxRetries &&
		a.noProgressTimeoutSeconds === b.noProgressTimeoutSeconds &&
		a.reasoningEffort === b.reasoningEffort &&
		MODEL_PARAMETER_NAMES.every(
			(name) => a.modelParameters[name] === b.modelParameters[name],
		)
	);
}

function safePersistentReason(reason: string | undefined): string {
	const text = (reason ?? "").replace(/[\r\n]+/g, " ").trim();
	const status = text.match(/\b(?:HTTP|status)\s*(401|403|404)\b/i);
	if (status) return `HTTP ${status[1]}`;
	if (/\bmodel(?:\s+is)?\s+unavailable\b/i.test(text))
		return "model unavailable";
	if (/\b(balance|quota|usage|billing|credit|payment|spending)\b/i.test(text))
		return "balance/quota/usage failure";
	return "persistent provider failure";
}

function safeAutomaticReason(reason: string | undefined): string {
	const text = (reason ?? "").replace(/[\r\n]+/g, " ").trim();
	const status = text.match(/\b(?:HTTP|status)\s*(429|5\d\d)\b/i);
	if (status) return `HTTP ${status[1]}`;
	if (/\b(network|socket|connection|dns|fetch|timed?\s*out)\b/i.test(text))
		return "network failure";
	if (/\bno[ -]progress\b/i.test(text)) return "no-progress timeout";
	return "automatic provider failure";
}

function settingsEqual(
	a: SharedTargetSettings,
	b: SharedTargetSettings,
): boolean {
	return (
		a.enabled === b.enabled &&
		a.errorHandlingMode === b.errorHandlingMode &&
		a.maxRetries === b.maxRetries &&
		a.noProgressTimeoutSeconds === b.noProgressTimeoutSeconds &&
		a.reasoningEffort === b.reasoningEffort &&
		MODEL_PARAMETER_NAMES.every(
			(name) => a.modelParameters[name] === b.modelParameters[name],
		)
	);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function safeAdd(a: number, b: number): number | undefined {
	const result = a + b;
	return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function normalizeChainSettingsPatch(
	current: SharedChainSettings,
	patch: unknown,
): SharedChainSettings | InvalidResult {
	if (isRecord(patch) && Object.hasOwn(patch, "enabled"))
		return { kind: "invalid", detail: "Chain settings cannot set enabled" };
	const normalized = normalizeSettingsPatch(
		{ enabled: true, ...current },
		patch,
	);
	if ("kind" in normalized) return normalized;
	return chainSettingsFrom(normalized);
}

function normalizeTargetOverridePatch(
	current: SharedTargetOverride,
	patch: unknown,
): SharedTargetOverride | InvalidResult {
	if (
		!isRecord(patch) ||
		!hasOnlyKeys(patch, [
			"errorHandlingMode",
			"maxRetries",
			"noProgressTimeoutSeconds",
			"reasoningEffort",
			"modelParameters",
		])
	)
		return { kind: "invalid", detail: "Override patch contains unknown fields" };
	const next = copyTargetOverride(current);
	if (patch.errorHandlingMode !== undefined) {
		const value = parseInheritable(
			patch.errorHandlingMode,
			parseErrorHandlingMode,
		);
		if (value === undefined)
			return { kind: "invalid", detail: "Invalid errorHandlingMode" };
		next.errorHandlingMode = value;
	}
	if (patch.maxRetries !== undefined) {
		const value = parseInheritable(patch.maxRetries, (entry) =>
			isValidMaxRetries(entry) ? entry : undefined,
		);
		if (value === undefined)
			return { kind: "invalid", detail: "Invalid maxRetries" };
		next.maxRetries = value;
	}
	if (patch.noProgressTimeoutSeconds !== undefined) {
		const value = parseInheritable(patch.noProgressTimeoutSeconds, (entry) =>
			isValidTimeoutSeconds(entry) ? entry : undefined,
		);
		if (value === undefined)
			return { kind: "invalid", detail: "Invalid noProgressTimeoutSeconds" };
		next.noProgressTimeoutSeconds = value;
	}
	if (patch.reasoningEffort !== undefined) {
		const value = parseInheritable(patch.reasoningEffort, parseReasoningEffort);
		if (value === undefined)
			return { kind: "invalid", detail: "Invalid reasoningEffort" };
		next.reasoningEffort = value;
	}
	if (patch.modelParameters !== undefined) {
		if (
			!isRecord(patch.modelParameters) ||
			!hasOnlyKeys(patch.modelParameters, MODEL_PARAMETER_NAMES)
		)
			return { kind: "invalid", detail: "Invalid modelParameters patch" };
		for (const [name, entry] of Object.entries(patch.modelParameters)) {
			const value = parseInheritable(entry, (candidate) =>
				typeof candidate === "boolean" ? candidate : undefined,
			);
			if (value === undefined)
				return { kind: "invalid", detail: "Invalid modelParameters patch" };
			next.modelParameters[name as ModelParameterName] = value;
		}
	}
	return next;
}

function normalizeSettingsPatch(
	current: SharedTargetSettings,
	patch: unknown,
): SharedTargetSettings | InvalidResult {
	if (
		!isRecord(patch) ||
		!hasOnlyKeys(patch, [
			"enabled",
			"errorHandlingMode",
			"maxRetries",
			"noProgressTimeoutSeconds",
			"reasoningEffort",
			"modelParameters",
		])
	)
		return { kind: "invalid", detail: "Settings patch contains unknown fields" };
	const next = copySettings(current);
	if (patch.enabled !== undefined) {
		if (typeof patch.enabled !== "boolean")
			return { kind: "invalid", detail: "Invalid enabled" };
		next.enabled = patch.enabled;
	}
	if (patch.errorHandlingMode !== undefined) {
		const mode = parseErrorHandlingMode(patch.errorHandlingMode);
		if (!mode) return { kind: "invalid", detail: "Invalid errorHandlingMode" };
		next.errorHandlingMode = mode;
	}
	if (patch.maxRetries !== undefined) {
		if (!isValidMaxRetries(patch.maxRetries))
			return { kind: "invalid", detail: "Invalid maxRetries" };
		next.maxRetries = patch.maxRetries;
	}
	if (patch.noProgressTimeoutSeconds !== undefined) {
		if (!isValidTimeoutSeconds(patch.noProgressTimeoutSeconds))
			return { kind: "invalid", detail: "Invalid noProgressTimeoutSeconds" };
		next.noProgressTimeoutSeconds = patch.noProgressTimeoutSeconds;
	}
	if (patch.reasoningEffort !== undefined) {
		const effort = parseReasoningEffort(patch.reasoningEffort);
		if (!effort) return { kind: "invalid", detail: "Invalid reasoningEffort" };
		next.reasoningEffort = effort;
	}
	if (patch.modelParameters !== undefined) {
		if (
			!isRecord(patch.modelParameters) ||
			!hasOnlyKeys(patch.modelParameters, MODEL_PARAMETER_NAMES)
		)
			return { kind: "invalid", detail: "Invalid modelParameters patch" };
		for (const [name, enabled] of Object.entries(patch.modelParameters)) {
			if (typeof enabled !== "boolean")
				return { kind: "invalid", detail: "Invalid modelParameters patch" };
			next.modelParameters[name as keyof ModelParameterToggles] = enabled;
		}
	}
	return next;
}

interface TransitionContext {
	now: number;
}

interface ParsedLegacyCandidate {
	targetKey: string;
	settings: SharedTargetSettings;
	manualRecoveryReason?: string;
	source: string;
}

interface ParsedScopeRegistration {
	scopeKey: string;
	targetKeys: string[];
}

type ClaimTransitionOperation = {
	kind: "claim";
	targetKey: string;
	effectiveRequestTimeoutMs: number;
	scopeKey?: string;
};

type SettleTransitionOperation = {
	kind: "settle";
	targetKey: string;
	scopeKey?: string;
	effectiveSettings?: SharedTargetSettings;
	outcome: SharedSettleOutcome;
};

type ParsedClaimOperation = ClaimTransitionOperation;

type ParsedSettleOperation = SettleTransitionOperation;

type UpdateScopeCoreResult =
	| { kind: "updated"; scopeKey: string; settings: SharedChainSettings }
	| InvalidResult;

type UpdateOverrideCoreResult =
	| {
			kind: "updated";
			scopeKey: string;
			targetKey: string;
			override: SharedTargetOverride;
	  }
	| InvalidResult;

type TransitionOperation =
	| ClaimTransitionOperation
	| SettleTransitionOperation
	| {
			kind: "settings";
			targetKey: string;
			patch: SharedTargetSettingsPatch;
	  }
	| {
			kind: "scope-settings";
			scopeKey: string;
			patch: SharedChainSettingsPatch;
	  }
	| {
			kind: "target-override";
			scopeKey: string;
			targetKey: string;
			patch: SharedTargetOverridePatch;
	  }
	| { kind: "reset"; targetKeys: string[] }
	| {
			kind: "registration";
			registrationKey: string;
			targetKeys: string[];
			legacyCandidates: ParsedLegacyCandidate[];
			scopes: ParsedScopeRegistration[];
	  };

type CoreResult =
	| ClaimCoreResult
	| SettleCoreResult
	| UpdateSettingsCoreResult
	| UpdateScopeCoreResult
	| UpdateOverrideCoreResult
	| ResetTargetsCoreResult
	| ReconcileRegistrationCoreResult;

interface TransitionResult<T extends CoreResult = CoreResult> {
	document: SharedStateDocument;
	result: T;
	changed: boolean;
	warnings: string[];
}

function unchanged<T extends CoreResult>(
	document: SharedStateDocument,
	result: T,
): TransitionResult<T> {
	return { document, result, changed: false, warnings: [] };
}

function committed<T extends CoreResult>(
	input: SharedStateDocument,
	document: SharedStateDocument,
	result: T,
	warnings: string[] = [],
): TransitionResult<T> {
	const revision = safeAdd(input.revision, 1);
	if (revision === undefined || revision >= Number.MAX_SAFE_INTEGER) {
		return unchanged(copyDocument(input), {
			kind: "invalid",
			detail: "Shared state revision is exhausted",
		} as T);
	}
	document.revision = revision;
	return { document, result, changed: true, warnings };
}

function getOrCreateTarget(
	document: SharedStateDocument,
	targetKey: string,
	now: number,
): { record: SharedTargetRecord; created: boolean } {
	const existing = document.targets[targetKey];
	if (existing) return { record: existing, created: false };
	const record = {
		settings: createDefaultSettings(),
		runtime: createDefaultRuntime(now),
	};
	document.targets[targetKey] = record;
	return { record, created: true };
}

function claimTransition(
	input: SharedStateDocument,
	operation: ClaimTransitionOperation,
	context: TransitionContext,
): TransitionResult<ClaimCoreResult> {
	const document = copyDocument(input);
	const existing = document.targets[operation.targetKey];
	if (!existing) {
		return unchanged(document, {
			kind: "skipped",
			targetKey: operation.targetKey,
			skipReason: "unknown-target",
			runtime: null,
		});
	}
	const effectiveSettings = resolveEffectiveSettings(
		document,
		operation.targetKey,
		operation.scopeKey,
	);
	if (effectiveSettings === undefined) {
		return unchanged(document, {
			kind: "skipped",
			targetKey: operation.targetKey,
			skipReason: "unknown-target",
			runtime: null,
		});
	}
	if ("kind" in effectiveSettings) return unchanged(document, effectiveSettings);
	if (existing.settings.enabled === false) {
		return unchanged(document, {
			kind: "skipped",
			targetKey: operation.targetKey,
			skipReason: "disabled",
			runtime: copyRuntime(existing.runtime),
		});
	}
	if (existing.runtime.manualRecovery) {
		return unchanged(document, {
			kind: "skipped",
			targetKey: operation.targetKey,
			skipReason: "manual-recovery",
			manualRecovery: { ...existing.runtime.manualRecovery },
			runtime: copyRuntime(existing.runtime),
		});
	}
	if (
		existing.runtime.cooldownUntil !== null &&
		existing.runtime.cooldownUntil > context.now
	) {
		return unchanged(document, {
			kind: "skipped",
			targetKey: operation.targetKey,
			skipReason: "cooldown",
			until: existing.runtime.cooldownUntil,
			runtime: copyRuntime(existing.runtime),
		});
	}
	if (
		existing.runtime.nextEligibleAt !== null &&
		existing.runtime.nextEligibleAt > context.now
	) {
		return unchanged(document, {
			kind: "skipped",
			targetKey: operation.targetKey,
			skipReason: "retry",
			until: existing.runtime.nextEligibleAt,
			runtime: copyRuntime(existing.runtime),
		});
	}
	existing.runtime.nextEligibleAt = null;
	existing.runtime.cooldownUntil = null;
	existing.runtime.updatedAt = context.now;
	return committed(input, document, {
		kind: "claimed",
		targetKey: operation.targetKey,
		settings: effectiveSettings,
		runtime: copyRuntime(existing.runtime),
	});
}

function persistentTransition(
	input: SharedStateDocument,
	operation: SettleTransitionOperation,
	context: TransitionContext,
): TransitionResult<SettleCoreResult> {
	const document = copyDocument(input);
	let record = document.targets[operation.targetKey];
	const outcome = operation.outcome as Extract<
		SharedSettleOutcome,
		{ kind: "persistent-failure" }
	>;
	const reason = safePersistentReason(outcome.reason);
	let created = false;
	if (!record) {
		const createdTarget = getOrCreateTarget(
			document,
			operation.targetKey,
			context.now,
		);
		record = createdTarget.record;
		created = true;
	}
	let changed = created;
	if (record.runtime.manualRecovery === null) {
		record.runtime.manualRecovery = { reason, updatedAt: context.now };
		record.runtime.lastFailureReason = reason;
		record.runtime.lastFailureAt = context.now;
		changed = true;
	}
	if (changed) record.runtime.updatedAt = context.now;
	const result: SettleCoreResult = {
		kind: "settled",
		action: "manual-recovery",
		targetKey: operation.targetKey,
		manualRecovery: { ...record.runtime.manualRecovery },
		runtime: copyRuntime(record.runtime),
	};
	return changed
		? committed(input, document, result)
		: unchanged(document, result);
}

function settleTransition(
	input: SharedStateDocument,
	operation: SettleTransitionOperation,
	context: TransitionContext,
): TransitionResult<SettleCoreResult> {
	if (operation.outcome.kind === "persistent-failure")
		return persistentTransition(input, operation, context);
	const document = copyDocument(input);
	const record = document.targets[operation.targetKey];
	if (!record) {
		return unchanged(document, {
			kind: "stale",
			targetKey: operation.targetKey,
			runtime: null,
		});
	}
	const effectiveSettings =
		operation.effectiveSettings ??
		resolveEffectiveSettings(document, operation.targetKey, operation.scopeKey);
	if (effectiveSettings === undefined) {
		return unchanged(document, {
			kind: "stale",
			targetKey: operation.targetKey,
			runtime: null,
		});
	}
	if ("kind" in effectiveSettings) return unchanged(document, effectiveSettings);
	if (operation.outcome.kind === "success") {
		record.runtime = createDefaultRuntime(context.now);
		return committed(input, document, {
			kind: "settled",
			action: "success",
			targetKey: operation.targetKey,
			runtime: copyRuntime(record.runtime),
		});
	}
	if (operation.outcome.kind === "compatibility-retry") {
		record.runtime.updatedAt = context.now;
		return committed(input, document, {
			kind: "settled",
			action: "compatibility-retry",
			targetKey: operation.targetKey,
			runtime: copyRuntime(record.runtime),
		});
	}
	const failureCount = safeAdd(record.runtime.consecutiveFailures, 1);
	if (failureCount === undefined)
		return unchanged(document, {
			kind: "invalid",
			detail: "Automatic failure counter is exhausted",
		});
	const failureReason = safeAutomaticReason(operation.outcome.reason);
	const retryAllowed =
		effectiveSettings.errorHandlingMode !== "switch" &&
		failureCount <= effectiveSettings.maxRetries;
	if (retryAllowed) {
		const nextEligibleAt = safeAdd(context.now, retryDelayMs(failureCount - 1));
		if (nextEligibleAt === undefined)
			return unchanged(document, {
				kind: "invalid",
				detail: "Retry deadline exceeds the supported timestamp range",
			});
		record.runtime.consecutiveFailures = failureCount;
		record.runtime.nextEligibleAt = nextEligibleAt;
		record.runtime.lastFailureReason = failureReason;
		record.runtime.lastFailureAt = context.now;
		record.runtime.updatedAt = context.now;
		return committed(input, document, {
			kind: "settled",
			action: "retry",
			targetKey: operation.targetKey,
			nextEligibleAt,
			failureReason,
			runtime: copyRuntime(record.runtime),
		});
	}
	const level = record.runtime.cooldownLevel;
	const cooldownMs = COOLDOWN_LADDER_MINUTES[level] * 60_000;
	const cooldownUntil = safeAdd(context.now, cooldownMs);
	const cumulativeCooldownMs = safeAdd(
		record.runtime.cumulativeCooldownMs,
		cooldownMs,
	);
	if (cooldownUntil === undefined || cumulativeCooldownMs === undefined)
		return unchanged(document, {
			kind: "invalid",
			detail: "Cooldown state exceeds the supported numeric range",
		});
	record.runtime.consecutiveFailures = 0;
	record.runtime.nextEligibleAt = cooldownUntil;
	record.runtime.cooldownUntil = cooldownUntil;
	record.runtime.cooldownLevel = Math.min(
		level + 1,
		COOLDOWN_LADDER_MINUTES.length - 1,
	);
	record.runtime.cumulativeCooldownMs = cumulativeCooldownMs;
	record.runtime.lastFailureReason = failureReason;
	record.runtime.lastFailureAt = context.now;
	record.runtime.updatedAt = context.now;
	return committed(input, document, {
		kind: "settled",
		action: "cooldown",
		targetKey: operation.targetKey,
		cooldownUntil,
		failureReason,
		runtime: copyRuntime(record.runtime),
	});
}

function settingsTransition(
	input: SharedStateDocument,
	operation: Extract<TransitionOperation, { kind: "settings" }>,
	context: TransitionContext,
): TransitionResult<UpdateSettingsCoreResult> {
	const document = copyDocument(input);
	const { record, created } = getOrCreateTarget(
		document,
		operation.targetKey,
		context.now,
	);
	const settings = normalizeSettingsPatch(record.settings, operation.patch);
	if ("kind" in settings) return unchanged(copyDocument(input), settings);
	const changed = created || !settingsEqual(record.settings, settings);
	if (changed) {
		record.settings = settings;
		record.runtime.updatedAt = context.now;
	}
	const result: UpdateSettingsCoreResult = {
		kind: "updated",
		targetKey: operation.targetKey,
		settings: copySettings(settings),
	};
	return changed
		? committed(input, document, result)
		: unchanged(document, result);
}

function scopeSettingsTransition(
	input: SharedStateDocument,
	operation: Extract<TransitionOperation, { kind: "scope-settings" }>,
): TransitionResult<UpdateScopeCoreResult> {
	const document = copyDocument(input);
	const scope = document.scopes[operation.scopeKey];
	if (!scope)
		return unchanged(document, {
			kind: "invalid",
			detail: "The chain scope does not exist",
		});
	const settings = normalizeChainSettingsPatch(scope.settings, operation.patch);
	if ("kind" in settings) return unchanged(document, settings);
	const result: UpdateScopeCoreResult = {
		kind: "updated",
		scopeKey: operation.scopeKey,
		settings: copyChainSettings(settings),
	};
	if (chainSettingsEqual(scope.settings, settings))
		return unchanged(document, result);
	scope.settings = settings;
	return committed(input, document, result);
}

function targetOverrideTransition(
	input: SharedStateDocument,
	operation: Extract<TransitionOperation, { kind: "target-override" }>,
): TransitionResult<UpdateOverrideCoreResult> {
	const document = copyDocument(input);
	const scope = document.scopes[operation.scopeKey];
	if (!scope || !scope.targets.includes(operation.targetKey))
		return unchanged(document, {
			kind: "invalid",
			detail: "The chain scope does not contain this target",
		});
	const current =
		scope.overrides[operation.targetKey] ?? createInheritOverride();
	const override = normalizeTargetOverridePatch(current, operation.patch);
	if ("kind" in override) return unchanged(document, override);
	const result: UpdateOverrideCoreResult = {
		kind: "updated",
		scopeKey: operation.scopeKey,
		targetKey: operation.targetKey,
		override: copyTargetOverride(override),
	};
	if (targetOverrideEqual(current, override)) return unchanged(document, result);
	scope.overrides[operation.targetKey] = override;
	return committed(input, document, result);
}

function resetTransition(
	input: SharedStateDocument,
	operation: Extract<TransitionOperation, { kind: "reset" }>,
	context: TransitionContext,
): TransitionResult<ResetTargetsCoreResult> {
	const document = copyDocument(input);
	const resetKeys: string[] = [];
	for (const key of operation.targetKeys) {
		const record = document.targets[key];
		if (!record) continue;
		record.runtime = createDefaultRuntime(context.now);
		resetKeys.push(key);
	}
	const result: ResetTargetsCoreResult = {
		kind: "reset",
		targetKeys: resetKeys,
	};
	return resetKeys.length > 0
		? committed(input, document, result)
		: unchanged(document, result);
}

function candidateSettingFields(
	winner: SharedTargetSettings,
	conflicting: SharedTargetSettings,
): string[] {
	const fields: string[] = [];
	if (winner.errorHandlingMode !== conflicting.errorHandlingMode)
		fields.push("errorHandlingMode");
	if (winner.maxRetries !== conflicting.maxRetries) fields.push("maxRetries");
	if (winner.noProgressTimeoutSeconds !== conflicting.noProgressTimeoutSeconds)
		fields.push("noProgressTimeoutSeconds");
	if (winner.reasoningEffort !== conflicting.reasoningEffort)
		fields.push("reasoningEffort");
	for (const name of MODEL_PARAMETER_NAMES) {
		if (winner.modelParameters[name] !== conflicting.modelParameters[name])
			fields.push(`modelParameters.${name}`);
	}
	return fields;
}

function legacyRecord(
	targetKey: string,
	candidates: readonly ParsedLegacyCandidate[],
	now: number,
): { record: SharedTargetRecord; warnings: string[] } {
	const matches = candidates.filter(
		(candidate) => candidate.targetKey === targetKey,
	);
	if (matches.length === 0)
		return {
			record: {
				settings: createDefaultSettings(),
				runtime: createDefaultRuntime(now),
			},
			warnings: [],
		};
	const winner = matches[0];
	const warnings: string[] = [];
	for (const conflicting of matches.slice(1)) {
		const fields = candidateSettingFields(winner.settings, conflicting.settings);
		if (fields.length > 0) {
			warnings.push(
				`Legacy target conflict target=${targetKey} winner=${winner.source} conflicting=${conflicting.source} fields=${fields.join(",")}`,
			);
		}
	}
	const manualWinner = matches.find(
		(candidate) => candidate.manualRecoveryReason !== undefined,
	);
	if (manualWinner) {
		const winnerReason = safePersistentReason(manualWinner.manualRecoveryReason);
		for (const conflicting of matches) {
			if (conflicting === manualWinner) continue;
			const conflictingReason =
				conflicting.manualRecoveryReason === undefined
					? undefined
					: safePersistentReason(conflicting.manualRecoveryReason);
			if (conflictingReason !== undefined && conflictingReason !== winnerReason) {
				warnings.push(
					`Legacy target conflict target=${targetKey} winner=${manualWinner.source} conflicting=${conflicting.source} fields=manualRecovery`,
				);
			}
		}
	}
	const runtime = createDefaultRuntime(now);
	if (manualWinner) {
		const reason = safePersistentReason(manualWinner.manualRecoveryReason);
		runtime.manualRecovery = { reason, updatedAt: now };
		runtime.lastFailureReason = reason;
		runtime.lastFailureAt = now;
	}
	return {
		record: { settings: copySettings(winner.settings), runtime },
		warnings,
	};
}

function registrationTransition(
	input: SharedStateDocument,
	operation: Extract<TransitionOperation, { kind: "registration" }>,
	context: TransitionContext,
): TransitionResult<ReconcileRegistrationCoreResult> {
	const document = copyDocument(input);
	let changed = false;
	// pi-lens-ignore: no-sort-without-comparator
	const scopeKeys = operation.scopes.map((scope) => scope.scopeKey).sort();
	const current = document.registrations[operation.registrationKey];
	if (
		!current ||
		!sameStrings(current.targets, operation.targetKeys) ||
		!sameStrings(current.scopeKeys, scopeKeys)
	) {
		document.registrations[operation.registrationKey] = {
			targets: [...operation.targetKeys],
			scopeKeys,
			updatedAt: context.now,
		};
		changed = true;
	}
	const referencedTargets = new Set<string>();
	const referencedScopes = new Set<string>();
	for (const registration of Object.values(document.registrations)) {
		for (const targetKey of registration.targets)
			referencedTargets.add(targetKey);
		for (const scopeKey of registration.scopeKeys) referencedScopes.add(scopeKey);
	}
	const warnings: string[] = [];
	// pi-lens-ignore: no-sort-without-comparator
	for (const targetKey of [...referencedTargets].sort()) {
		if (document.targets[targetKey]) continue;
		const migrated = legacyRecord(
			targetKey,
			operation.legacyCandidates,
			context.now,
		);
		document.targets[targetKey] = migrated.record;
		warnings.push(...migrated.warnings);
		changed = true;
	}
	for (const scopeKey of Object.keys(document.scopes)) {
		if (referencedScopes.has(scopeKey)) continue;
		delete document.scopes[scopeKey];
		changed = true;
	}
	for (const registration of operation.scopes) {
		const existing = document.scopes[registration.scopeKey];
		if (!existing) {
			const firstTarget = registration.targetKeys[0];
			const settings = firstTarget
				? chainSettingsFrom(document.targets[firstTarget]!.settings)
				: chainSettingsFrom(createDefaultSettings());
			const overrides: Record<string, SharedTargetOverride> = {};
			for (const targetKey of registration.targetKeys)
				overrides[targetKey] = createInheritOverride();
			document.scopes[registration.scopeKey] = {
				settings,
				targets: [...registration.targetKeys],
				overrides,
			};
			changed = true;
			continue;
		}
		const overrides: Record<string, SharedTargetOverride> = {};
		let scopeChanged = !sameStrings(existing.targets, registration.targetKeys);
		for (const targetKey of registration.targetKeys) {
			const override = existing.overrides[targetKey] ?? createInheritOverride();
			overrides[targetKey] = copyTargetOverride(override);
			if (!existing.overrides[targetKey]) scopeChanged = true;
		}
		if (!scopeChanged) continue;
		document.scopes[registration.scopeKey] = {
			settings: copyChainSettings(existing.settings),
			targets: [...registration.targetKeys],
			overrides,
		};
		changed = true;
	}
	const retainedScopeTargets = new Set<string>();
	for (const scope of Object.values(document.scopes)) {
		for (const targetKey of scope.targets) retainedScopeTargets.add(targetKey);
	}
	for (const targetKey of Object.keys(document.targets)) {
		if (referencedTargets.has(targetKey) || retainedScopeTargets.has(targetKey))
			continue;
		delete document.targets[targetKey];
		changed = true;
	}
	const result: ReconcileRegistrationCoreResult = {
		kind: "reconciled",
		registrationKey: operation.registrationKey,
		targets: [...operation.targetKeys],
	};
	return changed
		? committed(input, document, result, warnings)
		: unchanged(document, result);
}

function transition(
	input: SharedStateDocument,
	operation: TransitionOperation,
	context: TransitionContext,
): TransitionResult {
	switch (operation.kind) {
		case "claim":
			return claimTransition(input, operation, context);
		case "settle":
			return settleTransition(input, operation, context);
		case "settings":
			return settingsTransition(input, operation, context);
		case "scope-settings":
			return scopeSettingsTransition(input, operation);
		case "target-override":
			return targetOverrideTransition(input, operation);
		case "reset":
			return resetTransition(input, operation, context);
		case "registration":
			return registrationTransition(input, operation, context);
		default:
			throw new Error("Unsupported shared-state transition");
	}
}

function parseSelector(value: Record<string, unknown>): string | undefined {
	const hasTargetKey = Object.hasOwn(value, "targetKey");
	const hasTarget = Object.hasOwn(value, "target");
	if (hasTargetKey === hasTarget) return undefined;
	return parseTargetReference(hasTargetKey ? value.targetKey : value.target);
}

function claimOperation(input: unknown): ParsedClaimOperation | InvalidResult {
	if (
		!isRecord(input) ||
		!hasOnlyKeys(input, [
			"targetKey",
			"target",
			"effectiveRequestTimeoutMs",
			"scopeKey",
		])
	)
		return { kind: "invalid", detail: "Invalid claim input" };
	const targetKey = parseSelector(input);
	if (!targetKey)
		return {
			kind: "invalid",
			detail: "A valid non-failover target is required",
		};
	if (
		!Number.isSafeInteger(input.effectiveRequestTimeoutMs) ||
		(input.effectiveRequestTimeoutMs as number) < 0
	)
		return { kind: "invalid", detail: "Invalid effectiveRequestTimeoutMs" };
	const scopeKey =
		input.scopeKey === undefined ? undefined : parseScopeKey(input.scopeKey);
	if (input.scopeKey !== undefined && !scopeKey)
		return { kind: "invalid", detail: "Invalid scopeKey" };
	return {
		kind: "claim",
		targetKey,
		effectiveRequestTimeoutMs: input.effectiveRequestTimeoutMs as number,
		...(scopeKey === undefined ? {} : { scopeKey }),
	};
}

function parseOutcome(value: unknown): SharedSettleOutcome | undefined {
	if (!isRecord(value) || typeof value.kind !== "string") return undefined;
	if (value.kind === "success" || value.kind === "compatibility-retry")
		return hasExactKeys(value, ["kind"])
			? ({ kind: value.kind } as SharedSettleOutcome)
			: undefined;
	if (value.kind !== "automatic-failure" && value.kind !== "persistent-failure")
		return undefined;
	if (!hasOnlyKeys(value, ["kind", "reason"])) return undefined;
	if (value.reason !== undefined && typeof value.reason !== "string")
		return undefined;
	const reason = value.reason;
	if (reason === undefined) return { kind: value.kind };
	return { kind: value.kind, reason };
}

function settleOperation(
	input: unknown,
): ParsedSettleOperation | InvalidResult {
	if (
		!isRecord(input) ||
		!hasOnlyKeys(input, [
			"targetKey",
			"target",
			"outcome",
			"scopeKey",
			"effectiveSettings",
		])
	)
		return { kind: "invalid", detail: "Invalid settle input" };
	const targetKey = parseSelector(input);
	const outcome = parseOutcome(input.outcome);
	if (!targetKey || !outcome)
		return { kind: "invalid", detail: "Invalid settle input" };
	const requestedScopeKey =
		input.scopeKey === undefined ? undefined : parseScopeKey(input.scopeKey);
	if (input.scopeKey !== undefined && !requestedScopeKey)
		return { kind: "invalid", detail: "Invalid scopeKey" };
	const effectiveSettings =
		input.effectiveSettings === undefined
			? undefined
			: parseEffectiveSettings(input.effectiveSettings);
	if (input.effectiveSettings !== undefined && !effectiveSettings)
		return { kind: "invalid", detail: "Invalid effectiveSettings" };
	return {
		kind: "settle",
		targetKey,
		outcome,
		...(requestedScopeKey === undefined ? {} : { scopeKey: requestedScopeKey }),
		...(effectiveSettings === undefined
			? {}
			: { effectiveSettings: copySettings(effectiveSettings) }),
	};
}

function settingsOperation(
	target: unknown,
	patch: unknown,
): TransitionOperation | InvalidResult {
	const targetKey = parseTargetReference(target);
	if (!targetKey)
		return {
			kind: "invalid",
			detail: "A valid non-failover target is required",
		};
	if (!isRecord(patch))
		return { kind: "invalid", detail: "Settings patch must be an object" };
	const clonedPatch: Record<string, unknown> = { ...patch };
	if (isRecord(patch.modelParameters))
		clonedPatch.modelParameters = { ...patch.modelParameters };
	return {
		kind: "settings",
		targetKey,
		patch: clonedPatch as SharedTargetSettingsPatch,
	};
}

function scopeSettingsOperation(
	scopeKey: unknown,
	patch: unknown,
): TransitionOperation | InvalidResult {
	const parsedScopeKey = parseScopeKey(scopeKey);
	if (!parsedScopeKey) return { kind: "invalid", detail: "Invalid scopeKey" };
	if (!isRecord(patch))
		return { kind: "invalid", detail: "Scope settings patch must be an object" };
	const clonedPatch: Record<string, unknown> = { ...patch };
	if (isRecord(patch.modelParameters))
		clonedPatch.modelParameters = { ...patch.modelParameters };
	return {
		kind: "scope-settings",
		scopeKey: parsedScopeKey,
		patch: clonedPatch as SharedChainSettingsPatch,
	};
}

function targetOverrideOperation(
	scopeKey: unknown,
	target: unknown,
	patch: unknown,
): TransitionOperation | InvalidResult {
	const parsedScopeKey = parseScopeKey(scopeKey);
	const targetKey = parseTargetReference(target);
	if (!parsedScopeKey || !targetKey)
		return {
			kind: "invalid",
			detail: "A valid chain scope and target are required",
		};
	if (!isRecord(patch))
		return { kind: "invalid", detail: "Target override patch must be an object" };
	const clonedPatch: Record<string, unknown> = { ...patch };
	if (isRecord(patch.modelParameters))
		clonedPatch.modelParameters = { ...patch.modelParameters };
	return {
		kind: "target-override",
		scopeKey: parsedScopeKey,
		targetKey,
		patch: clonedPatch as SharedTargetOverridePatch,
	};
}
function resetOperation(targets: unknown): TransitionOperation | InvalidResult {
	if (!Array.isArray(targets))
		return { kind: "invalid", detail: "Reset targets must be an array" };
	const targetKeys: string[] = [];
	for (const target of targets) {
		const targetKey = parseTargetReference(target);
		if (!targetKey)
			return { kind: "invalid", detail: "Reset contains an invalid target" };
		targetKeys.push(targetKey);
	}
	// pi-lens-ignore: no-sort-without-comparator
	return { kind: "reset", targetKeys: [...new Set(targetKeys)].sort() };
}

function parseLegacyCandidate(
	value: unknown,
): ParsedLegacyCandidate | undefined {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"target",
			"settings",
			"manualRecoveryReason",
			"source",
		]) ||
		!Object.hasOwn(value, "target") ||
		!Object.hasOwn(value, "settings") ||
		!Object.hasOwn(value, "source")
	)
		return undefined;
	const targetKey = parseTargetReference(value.target);
	const settings = parseSettings(value.settings);
	if (
		!targetKey ||
		!settings ||
		typeof value.source !== "string" ||
		value.source.trim().length === 0 ||
		value.source.trim() !== value.source ||
		/[\r\n]/.test(value.source) ||
		(value.manualRecoveryReason !== undefined &&
			(typeof value.manualRecoveryReason !== "string" ||
				value.manualRecoveryReason.trim().length === 0))
	)
		return undefined;
	return {
		targetKey,
		settings,
		...(value.manualRecoveryReason === undefined
			? {}
			: { manualRecoveryReason: value.manualRecoveryReason as string }),
		source: value.source,
	};
}

function parseScopeRegistration(
	value: unknown,
): ParsedScopeRegistration | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["key", "targets"]) ||
		!Array.isArray(value.targets)
	)
		return undefined;
	const scopeKey = parseScopeKey(value.key);
	if (!scopeKey) return undefined;
	const targetKeys: string[] = [];
	for (const target of value.targets) {
		const targetKey = parseTargetReference(target);
		if (!targetKey || targetKeys.includes(targetKey)) return undefined;
		targetKeys.push(targetKey);
	}
	return { scopeKey, targetKeys };
}

function registrationOperation(
	input: unknown,
): TransitionOperation | InvalidResult {
	if (
		!isRecord(input) ||
		!hasOnlyKeys(input, [
			"agentDirectory",
			"targets",
			"legacyCandidates",
			"scopes",
		]) ||
		typeof input.agentDirectory !== "string" ||
		input.agentDirectory.trim().length === 0 ||
		!Array.isArray(input.targets) ||
		(input.legacyCandidates !== undefined &&
			!Array.isArray(input.legacyCandidates)) ||
		(input.scopes !== undefined && !Array.isArray(input.scopes))
	)
		return { kind: "invalid", detail: "Invalid registration input" };
	let registrationKey: string;
	try {
		registrationKey = resolve(input.agentDirectory);
	} catch {
		return { kind: "invalid", detail: "Invalid agent directory" };
	}
	if (!isSafeMapKey(registrationKey) || !isAbsolute(registrationKey))
		return { kind: "invalid", detail: "Invalid agent directory" };
	const targetKeys: string[] = [];
	for (const target of input.targets) {
		const targetKey = parseTargetReference(target);
		if (!targetKey)
			return {
				kind: "invalid",
				detail: "Registration contains an invalid target",
			};
		targetKeys.push(targetKey);
	}
	const legacyCandidates: ParsedLegacyCandidate[] = [];
	for (const candidate of input.legacyCandidates ?? []) {
		const parsed = parseLegacyCandidate(candidate);
		if (!parsed)
			return {
				kind: "invalid",
				detail: "Registration contains an invalid legacy candidate",
			};
		legacyCandidates.push(parsed);
	}
	const scopes: ParsedScopeRegistration[] = [];
	const knownTargetKeys = new Set(targetKeys);
	const knownScopeKeys = new Set<string>();
	for (const scope of input.scopes ?? []) {
		const parsed = parseScopeRegistration(scope);
		if (
			!parsed ||
			knownScopeKeys.has(parsed.scopeKey) ||
			parsed.targetKeys.some((targetKey) => !knownTargetKeys.has(targetKey))
		)
			return {
				kind: "invalid",
				detail: "Registration contains an invalid chain scope",
			};
		knownScopeKeys.add(parsed.scopeKey);
		scopes.push(parsed);
	}
	return {
		kind: "registration",
		registrationKey,
		// pi-lens-ignore: no-sort-without-comparator
		targetKeys: [...new Set(targetKeys)].sort(),
		legacyCandidates,
		scopes,
	};
}

type CanonicalLoad =
	| {
			kind: "loaded";
			document: SharedStateDocument;
			sourceRevision: ConfigSourceRevision;
	  }
	| {
			kind: "blocked";
			reason: Extract<
				SharedDegradedReason,
				"malformed" | "invalid" | "future-version" | "unreadable"
			>;
			detail: string;
	  };

async function loadCanonical(path: string): Promise<CanonicalLoad> {
	let source: Awaited<ReturnType<typeof readJsonSource>>;
	try {
		source = await readJsonSource(path, "Shared failover state");
	} catch (error) {
		return { kind: "blocked", reason: "unreadable", detail: String(error) };
	}
	if (source.kind === "blocked")
		return {
			kind: "blocked",
			reason: source.reason,
			detail: source.detail,
		};
	if (source.kind === "missing") {
		return {
			kind: "loaded",
			document: createDefaultDocument(),
			sourceRevision: source.revision,
		};
	}
	if (
		isRecord(source.value) &&
		Number.isInteger(source.value.version) &&
		(source.value.version as number) > SHARED_STATE_VERSION
	) {
		return {
			kind: "blocked",
			reason: "future-version",
			detail: `Shared failover state version ${String(source.value.version)} is newer than supported version ${SHARED_STATE_VERSION}`,
		};
	}
	const document = parseDocument(source.value);
	if (!document) {
		return {
			kind: "blocked",
			reason: "invalid",
			detail: "Shared failover state does not match the version 1 schema",
		};
	}
	return { kind: "loaded", document, sourceRevision: source.revision };
}

function documentFromSource(
	source: SourceRead,
): SharedStateDocument | undefined {
	if (!source.bytes) return createDefaultDocument();
	try {
		return parseDocument(JSON.parse(source.bytes.toString("utf8")) as unknown);
	} catch {
		return undefined;
	}
}

function normalizeAttempts(value: number | undefined): number {
	if (!Number.isInteger(value) || (value as number) < 1)
		return DEFAULT_MAX_CAS_ATTEMPTS;
	return Math.min(value as number, MAX_CAS_ATTEMPTS);
}

function coordinated<T extends CoreResult>(
	result: T,
	status: SharedCoordinationStatus,
): Coordinated<T> {
	return { ...result, ...status } as Coordinated<T>;
}

class SharedStateController implements SharedStateAdapter {
	private document: SharedStateDocument;
	private coordinationStatus: SharedCoordinationStatus = {
		coordination: "shared",
	};
	private queue: Promise<void> = Promise.resolve();
	private readonly now: () => number;
	private readonly warn: (message: string) => void;

	constructor(
		private readonly file:
			| {
					path: string;
					cas: SharedStateCas;
					maxAttempts: number;
			  }
			| undefined,
		options: CommonAdapterOptions,
		initialDocument = createDefaultDocument(),
	) {
		this.document = copyDocument(initialDocument);
		this.now = options.now ?? (() => Date.now());
		this.warn = options.warn ?? (() => undefined);
	}

	status(): SharedCoordinationStatus {
		return { ...this.coordinationStatus };
	}

	private enqueue<T>(run: () => Promise<T>): Promise<T> {
		const result = this.queue.then(run, run);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private clock(): number {
		try {
			const value = this.now();
			if (isTimestamp(value)) return value;
		} catch {
			// Fall through to a safe local timestamp.
		}
		return Date.now();
	}

	private context(): TransitionContext {
		return { now: this.clock() };
	}

	private emitWarning(message: string): void {
		try {
			this.warn(message);
		} catch {
			// Diagnostics cannot change coordination behavior.
		}
	}

	private shared(): void {
		this.coordinationStatus = { coordination: "shared" };
	}

	private degraded(
		reason: SharedDegradedReason,
		diagnosticDetail: string,
	): void {
		this.coordinationStatus = {
			coordination: "degraded",
			reason,
			detail: COORDINATION_FAILURE_DETAIL,
		};
		this.emitWarning(`${reason}: ${diagnosticDetail}`);
	}

	private coordinationFailure<T extends CoreResult>(): Coordinated<T> {
		return coordinated(
			{ kind: "invalid", detail: COORDINATION_FAILURE_DETAIL } as T,
			this.status(),
		);
	}

	private emitTransitionWarnings(result: TransitionResult): void {
		for (const warning of result.warnings) this.emitWarning(warning);
	}

	async snapshot(): Promise<{
		document: SharedStateDocument;
		status: SharedCoordinationStatus;
	}> {
		return this.enqueue(async () => {
			if (this.file) {
				const needsWriteProbe = this.coordinationStatus.coordination === "degraded";
				for (let attempt = 0; attempt < this.file.maxAttempts; attempt += 1) {
					const loaded = await loadCanonical(this.file.path);
					if (loaded.kind === "blocked") {
						this.degraded(loaded.reason, loaded.detail);
						break;
					}
					if (!needsWriteProbe) {
						this.document = copyDocument(loaded.document);
						this.shared();
						break;
					}
					try {
						await mkdir(dirname(this.file.path), {
							recursive: true,
							mode: 0o700,
						});
					} catch (error) {
						this.degraded("write-failed", String(error));
						break;
					}
					let numericRevisionAccepted = false;
					let saved: AtomicWriteResult;
					try {
						saved = await this.file.cas(
							this.file.path,
							"shared failover state",
							loaded.sourceRevision,
							(source) => {
								const current = documentFromSource(source);
								if (!current || current.revision !== loaded.document.revision)
									return undefined;
								numericRevisionAccepted = true;
								return current;
							},
						);
					} catch (error) {
						this.degraded("write-failed", String(error));
						break;
					}
					if (saved.kind === "saved" && numericRevisionAccepted) {
						this.document = copyDocument(loaded.document);
						this.shared();
						break;
					}
					if (attempt === this.file.maxAttempts - 1) {
						this.degraded(
							"cas-exhausted",
							`Shared failover state compare-and-swap exceeded ${String(this.file.maxAttempts)} attempts`,
						);
					}
				}
			}
			return {
				document: copyDocument(this.document),
				status: this.status(),
			};
		});
	}

	private async mutate<T extends CoreResult>(
		operation: TransitionOperation,
	): Promise<Coordinated<T>> {
		if (!this.file) {
			const result = transition(this.document, operation, this.context());
			this.document = result.document;
			this.emitTransitionWarnings(result);
			return coordinated(result.result as T, this.status());
		}
		for (let attempt = 0; attempt < this.file.maxAttempts; attempt += 1) {
			const context = this.context();
			const loaded = await loadCanonical(this.file.path);
			if (loaded.kind === "blocked") {
				this.degraded(loaded.reason, loaded.detail);
				return this.coordinationFailure<T>();
			}
			const recovering = this.coordinationStatus.coordination === "degraded";
			const result = transition(loaded.document, operation, context);
			if (!result.changed && !recovering) {
				this.document = result.document;
				this.shared();
				this.emitTransitionWarnings(result);
				return coordinated(result.result as T, this.status());
			}
			try {
				await mkdir(dirname(this.file.path), { recursive: true, mode: 0o700 });
			} catch (error) {
				this.degraded("write-failed", String(error));
				return this.coordinationFailure<T>();
			}
			let numericRevisionAccepted = false;
			let saved: AtomicWriteResult;
			try {
				saved = await this.file.cas(
					this.file.path,
					"shared failover state",
					loaded.sourceRevision,
					(source) => {
						const current = documentFromSource(source);
						if (!current || current.revision !== loaded.document.revision)
							return undefined;
						numericRevisionAccepted = true;
						return result.document;
					},
				);
			} catch (error) {
				this.degraded("write-failed", String(error));
				return this.coordinationFailure<T>();
			}
			if (saved.kind === "saved") {
				if (!numericRevisionAccepted) {
					this.degraded(
						"write-failed",
						"Shared failover state write did not verify the numeric revision",
					);
					return this.coordinationFailure<T>();
				}
				this.document = result.document;
				this.shared();
				this.emitTransitionWarnings(result);
				return coordinated(result.result as T, this.status());
			}
		}
		const detail = `Shared failover state compare-and-swap exceeded ${String(this.file.maxAttempts)} attempts`;
		this.degraded("cas-exhausted", detail);
		return this.coordinationFailure<T>();
	}

	private invalid<T extends CoreResult>(
		result: InvalidResult,
	): Promise<Coordinated<T>> {
		return this.enqueue(async () => coordinated(result as T, this.status()));
	}

	claim(input: ClaimInput): Promise<ClaimResult> {
		const parsed = claimOperation(input);
		if (parsed.kind === "invalid") return this.invalid<ClaimCoreResult>(parsed);
		return this.enqueue(() =>
			this.mutate<ClaimCoreResult>(parsed),
		);
	}

	settle(input: SettleInput): Promise<SettleResult> {
		const parsed = settleOperation(input);
		if (parsed.kind === "invalid") return this.invalid<SettleCoreResult>(parsed);
		return this.enqueue(() => this.mutate<SettleCoreResult>(parsed));
	}

	updateSettings(
		target: SharedTargetReference,
		patch: SharedTargetSettingsPatch,
	): Promise<UpdateSettingsResult> {
		const operation = settingsOperation(target, patch);
		if (operation.kind === "invalid")
			return this.invalid<UpdateSettingsCoreResult>(operation);
		return this.enqueue(() => this.mutate<UpdateSettingsCoreResult>(operation));
	}

	updateScopeSettings(
		scopeKey: string,
		patch: SharedChainSettingsPatch,
	): Promise<UpdateScopeSettingsResult> {
		const operation = scopeSettingsOperation(scopeKey, patch);
		if (operation.kind === "invalid")
			return this.invalid<UpdateScopeCoreResult>(operation);
		return this.enqueue(() => this.mutate<UpdateScopeCoreResult>(operation));
	}

	updateTargetOverride(
		scopeKey: string,
		target: SharedTargetReference,
		patch: SharedTargetOverridePatch,
	): Promise<UpdateTargetOverrideResult> {
		const operation = targetOverrideOperation(scopeKey, target, patch);
		if (operation.kind === "invalid")
			return this.invalid<UpdateOverrideCoreResult>(operation);
		return this.enqueue(() => this.mutate<UpdateOverrideCoreResult>(operation));
	}

	resetTargets(
		targets: readonly SharedTargetReference[],
	): Promise<ResetTargetsResult> {
		const operation = resetOperation(targets);
		if (operation.kind === "invalid")
			return this.invalid<ResetTargetsCoreResult>(operation);
		return this.enqueue(() => this.mutate<ResetTargetsCoreResult>(operation));
	}

	reconcileRegistration(
		input: ReconcileRegistrationInput,
	): Promise<ReconcileRegistrationResult> {
		const operation = registrationOperation(input);
		if (operation.kind === "invalid")
			return this.invalid<ReconcileRegistrationCoreResult>(operation);
		return this.enqueue(() =>
			this.mutate<ReconcileRegistrationCoreResult>(operation),
		);
	}
}

export function createMemorySharedState(
	options: MemorySharedStateOptions = {},
): SharedStateAdapter {
	let document = createDefaultDocument();
	if (options.document !== undefined) {
		const parsed = parseDocument(options.document);
		if (!parsed)
			throw new Error(
				"Refusing to create memory shared state from an invalid document",
			);
		document = parsed;
	}
	return new SharedStateController(undefined, options, document);
}

export function createFileSharedState(
	options: FileSharedStateOptions = {},
): SharedStateAdapter {
	return new SharedStateController(
		{
			path: options.path ?? FAILOVER_STATE_PATH,
			cas: options.cas ?? writeJsonAtomically,
			maxAttempts: normalizeAttempts(options.maxAttempts),
		},
		options,
	);
}
