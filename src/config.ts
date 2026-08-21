import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
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

export const CONFIG_VERSION = 5 as const;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function readManualRecovery(
	value: unknown,
): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, reason] of Object.entries(value)) {
		if (
			key.trim().length === 0 ||
			typeof reason !== "string" ||
			reason.trim().length === 0
		)
			return undefined;
		result[key] = reason;
	}
	return result;
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
export function migrateConfig(value: unknown): unknown {
	if (!isRecord(value)) return value;
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
	return value;
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

export type ConfigLoadFailure =
	| { reason: "malformed" | "invalid" | "unreadable"; detail: string }
	| { reason: "future-version"; version: number; detail: string };

export type ConfigSourceRevision =
	| { kind: "absent" }
	| {
			kind: "present";
			device: string;
			inode: string;
			size: string;
			mtimeNanoseconds: string;
			digest: string;
	  };

interface ConfigSource {
	bytes?: Buffer;
	revision: ConfigSourceRevision;
}

export type ConfigLoadResult =
	| ({ kind: "missing" } & ConfigSource)
	| ({
			kind: "loaded";
			config: FailoverConfig;
			migrated: boolean;
	  } & ConfigSource)
	| { kind: "blocked"; failure: ConfigLoadFailure };

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function readSource(path: string): Promise<ConfigSource> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { revision: { kind: "absent" } };
		throw error;
	}
	try {
		const bytes = await handle.readFile();
		const metadata = await handle.stat({ bigint: true });
		return {
			bytes,
			revision: {
				kind: "present",
				device: String(metadata.dev),
				inode: String(metadata.ino),
				size: String(metadata.size),
				mtimeNanoseconds: String(metadata.mtimeNs),
				digest: digest(bytes),
			},
		};
	} finally {
		await handle.close();
	}
}

export async function loadConfig(path: string): Promise<ConfigLoadResult> {
	let source: ConfigSource;
	try {
		source = await readSource(path);
	} catch (error) {
		return {
			kind: "blocked",
			failure: { reason: "unreadable", detail: errorDetail(error) },
		};
	}
	if (!source.bytes) return { kind: "missing", ...source };

	let raw: unknown;
	try {
		raw = JSON.parse(source.bytes.toString("utf8"));
	} catch {
		return {
			kind: "blocked",
			failure: { reason: "malformed", detail: "Configuration is not valid JSON" },
		};
	}
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
		...source,
	};
}

export type SaveConfigResult = { kind: "saved" } | { kind: "conflict" };

const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 20;

interface LockRecord {
	pid: number;
	createdAt: number;
	owner: string;
}

function sameRevision(
	a: ConfigSourceRevision,
	b: ConfigSourceRevision,
): boolean {
	if (a.kind !== b.kind) return false;
	return (
		a.kind === "absent" ||
		(b.kind === "present" &&
			a.device === b.device &&
			a.inode === b.inode &&
			a.size === b.size &&
			a.mtimeNanoseconds === b.mtimeNanoseconds &&
			a.digest === b.digest)
	);
}

async function releaseOwnedLock(path: string, owner: string): Promise<void> {
	try {
		const lock = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
		if (lock.owner === owner) await unlink(path);
	} catch {
		// Never delete a lock whose ownership cannot be verified.
	}
}

async function acquireLock(path: string, record: LockRecord): Promise<void> {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const handle = await open(path, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(record), "utf8");
				await handle.sync();
			} catch (error) {
				try {
					await handle.close();
				} catch {
					// Preserve the original lock creation failure.
				}
				try {
					await unlink(path);
				} catch {
					// A partial lock is safer left for manual review than hidden by cleanup.
				}
				throw error;
			}
			await handle.close();
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline)
				throw new Error(
					`Timed out waiting for config lock: ${path}. Verify no Pi process is writing, then remove the stale lock if necessary.`,
				);
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
}

/** Lock, compare the retained source revision, then atomically replace the target. */
export async function saveConfig(
	path: string,
	config: FailoverConfig,
	expectedRevision: ConfigSourceRevision,
): Promise<SaveConfigResult> {
	const validated = validateConfig(config);
	if (!validated) throw new Error("Refusing to write invalid failover config");
	await mkdir(dirname(path), { recursive: true });
	const owner = randomUUID();
	const lockPath = `${path}.lock`;
	const tempPath = `${path}.${process.pid}.${owner}.tmp`;
	let tempCreated = false;
	await acquireLock(lockPath, {
		pid: process.pid,
		createdAt: Date.now(),
		owner,
	});
	try {
		const currentSource = await readSource(path);
		if (!sameRevision(currentSource.revision, expectedRevision))
			return { kind: "conflict" };
		const handle = await open(tempPath, "wx", 0o600);
		tempCreated = true;
		try {
			await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, path);
		try {
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} catch {
			// Directory fsync is not supported by every filesystem.
		}
		return { kind: "saved" };
	} finally {
		if (tempCreated) {
			try {
				await unlink(tempPath);
			} catch {
				// A crash artifact must not replace or remove the target.
			}
		}
		await releaseOwnedLock(lockPath, owner);
	}
}
