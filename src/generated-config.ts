import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
	DEFAULT_COOLDOWN_MINUTES,
	DEFAULT_ERROR_HANDLING_MODE,
	DEFAULT_MAX_RETRIES,
	DEFAULT_NO_PROGRESS_TIMEOUT_SECONDS,
	DEFAULT_REASONING_EFFORT,
	validateConfig,
	type ConfigSourceRevision,
} from "./config.ts";
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

export const GENERATED_CONFIG_VERSION = 6 as const;
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
		cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
		cooldownMinutes: model.cooldownMinutes,
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

function readManualRecovery(
	value: unknown,
): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, reason] of Object.entries(value)) {
		if (
			key.trim().length === 0 ||
			typeof reason !== "string" ||
			reason.trim() === ""
		)
			return undefined;
		result[key] = reason;
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

function readGeneratedModel(
	value: unknown,
): GeneratedFailoverModel | undefined {
	if (!isRecord(value)) return undefined;
	const allowedKeys = new Set([
		"id",
		"name",
		"enabled",
		"chain",
		"reasoningEffort",
		"cooldownMinutes",
		"errorHandlingMode",
		"maxRetries",
		"noProgressTimeoutSeconds",
		"modelParameters",
		"targetOverrides",
		"manualRecovery",
	]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined;
	const chain = readChain(value.chain, value.enabled === false);
	const reasoningEffort = readReasoningEffort(value.reasoningEffort);
	const errorHandlingMode = readErrorHandlingMode(value.errorHandlingMode);
	const modelParameters = readToggles(value.modelParameters);
	const manualRecovery =
		value.manualRecovery === undefined
			? {}
			: readManualRecovery(value.manualRecovery);
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
		!Number.isInteger(value.cooldownMinutes) ||
		(value.cooldownMinutes as number) < 0 ||
		(value.cooldownMinutes as number) > 1440 ||
		!Number.isInteger(value.maxRetries) ||
		(value.maxRetries as number) < 0 ||
		(value.maxRetries as number) > 10 ||
		!Number.isInteger(value.noProgressTimeoutSeconds) ||
		((value.noProgressTimeoutSeconds as number) !== 0 &&
			((value.noProgressTimeoutSeconds as number) < 15 ||
				(value.noProgressTimeoutSeconds as number) > 900))
	)
		return undefined;
	const targetOverrides = readTargetOverrides(value.targetOverrides, chain);
	if (!targetOverrides) return undefined;
	return {
		id: value.id,
		name: value.name,
		enabled: value.enabled,
		chain,
		reasoningEffort,
		cooldownMinutes: value.cooldownMinutes as number,
		errorHandlingMode,
		maxRetries: value.maxRetries as number,
		noProgressTimeoutSeconds: value.noProgressTimeoutSeconds as number,
		modelParameters,
		targetOverrides,
		manualRecovery,
	};
}

/** Convert the old v1-v5 config into one generated default model. */
export function migrateGeneratedConfig(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version === GENERATED_CONFIG_VERSION) return value;
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
				cooldownMinutes: legacy.cooldownMinutes,
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

interface SourceRead {
	bytes?: Buffer;
	revision: ConfigSourceRevision;
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function readSource(path: string): Promise<SourceRead> {
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
	let source: SourceRead;
	try {
		source = await readSource(path);
	} catch (error) {
		return { kind: "blocked", reason: "unreadable", detail: String(error) };
	}
	if (!source.bytes) return { kind: "missing", revision: source.revision };
	let raw: unknown;
	try {
		raw = JSON.parse(source.bytes.toString("utf8"));
	} catch {
		return {
			kind: "blocked",
			reason: "malformed",
			detail: "Configuration is not valid JSON",
		};
	}
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

async function acquireLock(path: string, owner: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	for (;;) {
		try {
			const handle = await open(path, "wx", 0o600);
			await handle.writeFile(
				JSON.stringify({ pid: process.pid, owner, createdAt: Date.now() }),
			);
			await handle.sync();
			await handle.close();
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline)
				throw new Error(`Timed out waiting for generated config lock: ${path}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

async function releaseLock(path: string, owner: string): Promise<void> {
	try {
		const record = JSON.parse(await readFile(path, "utf8")) as {
			owner?: unknown;
		};
		if (record.owner === owner) await unlink(path);
	} catch {
		// Never remove a lock whose owner cannot be verified.
	}
}

export async function saveGeneratedConfig(
	path: string,
	config: GeneratedFailoverConfig,
	expectedRevision: ConfigSourceRevision,
): Promise<SaveGeneratedConfigResult> {
	const validated = validateGeneratedConfig(config);
	if (!validated)
		throw new Error("Refusing to write invalid generated failover config");
	await mkdir(dirname(path), { recursive: true });
	const owner = randomUUID();
	const lockPath = `${path}.lock`;
	const tempPath = `${path}.${process.pid}.${owner}.tmp`;
	let tempCreated = false;
	await acquireLock(lockPath, owner);
	try {
		const current = await readSource(path);
		if (!sameRevision(current.revision, expectedRevision))
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
		return { kind: "saved" };
	} finally {
		if (tempCreated) {
			try {
				await unlink(tempPath);
			} catch {
				/* already renamed */
			}
		}
		await releaseLock(lockPath, owner);
	}
}
