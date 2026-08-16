import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { FailoverConfig, ModelRef } from "./types.ts";

export const CONFIG_VERSION = 2 as const;
export const DEFAULT_NO_PROGRESS_TIMEOUT_SECONDS = 90;

export function createDefaultConfig(models: ModelRef[] = []): FailoverConfig {
	return {
		version: CONFIG_VERSION,
		enabled: true,
		paused: false,
		models: models.map(copyModelRef),
		noProgressTimeoutSeconds: DEFAULT_NO_PROGRESS_TIMEOUT_SECONDS,
		manualRecovery: {},
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

export function isValidTimeoutSeconds(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		(value === 0 || (value >= 15 && value <= 900))
	);
}

/** Add defaults for the version-1 shape without preserving fields outside the persisted contract. */
export function migrateConfig(value: unknown): unknown {
	if (!isRecord(value) || value.version !== 1) return value;
	return {
		...value,
		version: CONFIG_VERSION,
		paused: false,
		manualRecovery: {},
	};
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
	if (
		!models ||
		manualRecovery === undefined ||
		!isValidTimeoutSeconds(migrated.noProgressTimeoutSeconds)
	) {
		return undefined;
	}

	return {
		version: CONFIG_VERSION,
		enabled: migrated.enabled,
		paused: migrated.paused,
		models,
		noProgressTimeoutSeconds: migrated.noProgressTimeoutSeconds,
		manualRecovery,
	};
}

export interface LoadedConfig {
	config: FailoverConfig;
	exists: boolean;
	valid: boolean;
	migrated: boolean;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
		const config = validateConfig(raw);
		if (config) {
			return {
				config,
				exists: true,
				valid: true,
				migrated: isRecord(raw) && raw.version === 1,
			};
		}
		return {
			config: createDefaultConfig(),
			exists: true,
			valid: false,
			migrated: false,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				config: createDefaultConfig(),
				exists: false,
				valid: true,
				migrated: false,
			};
		}
		return {
			config: createDefaultConfig(),
			exists: true,
			valid: false,
			migrated: false,
		};
	}
}

/** Write only the validated extension shape using a same-directory atomic rename. */
export async function saveConfig(
	path: string,
	config: FailoverConfig,
): Promise<void> {
	const validated = validateConfig(config);
	if (!validated) throw new Error("Refusing to write invalid failover config");

	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const content = `${JSON.stringify(validated, null, 2)}\n`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(tempPath, "w", 0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(tempPath, path);
	} catch (error) {
		if (handle) await handle.close().catch(() => undefined);
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}
