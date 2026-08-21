import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConfigSourceRevision } from "./config.ts";
import {
	REASONING_EFFORTS,
	modelKey,
	type GeneratedFailoverConfig,
	type GeneratedFailoverModel,
	type ModelRef,
	type ReasoningEffort,
} from "./types.ts";

export const FAILOVER_PROVIDER_ID = "failover";
export const FAILOVER_PROVIDER_NAME = "Failover";

type InputType = "text" | "image";

export interface TargetCatalogMetadata {
	ref: ModelRef;
	input?: readonly InputType[];
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ReasoningEffort, string | null>>;
	contextWindow?: number;
	maxTokens?: number;
}

export interface FailoverCatalogModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: InputType[];
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: 0;
		output: 0;
		cacheRead: 0;
		cacheWrite: 0;
	};
	thinkingLevelMap?: Partial<Record<ReasoningEffort, string | null>>;
}

export interface ModelsJsonDocument {
	[key: string]: unknown;
	providers?: Record<string, unknown>;
}

export type ModelsJsonLoadResult =
	| { kind: "missing"; revision: ConfigSourceRevision }
	| {
			kind: "loaded";
			document: ModelsJsonDocument;
			revision: ConfigSourceRevision;
	  }
	| {
			kind: "blocked";
			reason: "malformed" | "invalid" | "unreadable";
			detail: string;
	  };

export type CatalogWriteResult = { kind: "saved" } | { kind: "conflict" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyRef(ref: ModelRef): ModelRef {
	return { provider: ref.provider, id: ref.id };
}

function metadataFor(
	model: ModelRef,
	metadata: readonly TargetCatalogMetadata[],
): TargetCatalogMetadata {
	return (
		metadata.find((entry) => modelKey(entry.ref) === modelKey(model)) ?? {
			ref: copyRef(model),
		}
	);
}

function supportsLevel(
	target: TargetCatalogMetadata,
	level: ReasoningEffort,
): string | null | undefined {
	if (!target.reasoning) return null;
	const map = target.thinkingLevelMap;
	if (map && Object.hasOwn(map, level)) return map[level];
	if (level === "xhigh" || level === "max") return null;
	return level === "off" ? "none" : level;
}

function safeThinkingLevelMap(
	targets: readonly TargetCatalogMetadata[],
): Partial<Record<ReasoningEffort, string | null>> | undefined {
	if (targets.length === 0 || !targets.every((target) => target.reasoning))
		return undefined;
	const map: Partial<Record<ReasoningEffort, string | null>> = {};
	for (const level of REASONING_EFFORTS) {
		const values = targets.map((target) => supportsLevel(target, level));
		if (values.some((value) => value === null || value === undefined)) continue;
		map[level] = values[0];
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

/** Build metadata that never exceeds the capabilities of any configured target. */
export function buildFailoverCatalogModel(
	model: GeneratedFailoverModel,
	metadata: readonly TargetCatalogMetadata[] = [],
): FailoverCatalogModel {
	const targets = model.chain.map((target) => metadataFor(target, metadata));
	const input: InputType[] = (["text", "image"] as const).filter((kind) =>
		targets.every((target) => (target.input ?? ["text"]).includes(kind)),
	);
	const contextWindow = Math.min(
		...targets.map((target) =>
			Number.isFinite(target.contextWindow) && (target.contextWindow ?? 0) > 0
				? (target.contextWindow as number)
				: 128_000,
		),
	);
	const maxTokens = Math.min(
		...targets.map((target) =>
			Number.isFinite(target.maxTokens) && (target.maxTokens ?? 0) > 0
				? (target.maxTokens as number)
				: 16_384,
		),
	);
	const thinkingLevelMap = safeThinkingLevelMap(targets);
	return {
		id: model.id,
		name: model.name,
		reasoning:
			targets.length > 0 && targets.every((target) => target.reasoning === true),
		input,
		contextWindow,
		maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
}

export function buildFailoverCatalogModels(
	config: GeneratedFailoverConfig,
	metadata: readonly TargetCatalogMetadata[] = [],
): FailoverCatalogModel[] {
	return config.models
		.filter((model) => model.enabled)
		.map((model) => buildFailoverCatalogModel(model, metadata));
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function readSource(
	path: string,
): Promise<{ bytes?: Buffer; revision: ConfigSourceRevision }> {
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

export async function loadModelsJson(
	path: string,
): Promise<ModelsJsonLoadResult> {
	let source: { bytes?: Buffer; revision: ConfigSourceRevision };
	try {
		source = await readSource(path);
	} catch (error) {
		return { kind: "blocked", reason: "unreadable", detail: String(error) };
	}
	if (!source.bytes) return { kind: "missing", revision: source.revision };
	let value: unknown;
	try {
		value = JSON.parse(source.bytes.toString("utf8"));
	} catch {
		return {
			kind: "blocked",
			reason: "malformed",
			detail: "models.json is not valid JSON",
		};
	}
	if (!isRecord(value))
		return {
			kind: "blocked",
			reason: "invalid",
			detail: "models.json must contain an object",
		};
	if (value.providers !== undefined && !isRecord(value.providers))
		return {
			kind: "blocked",
			reason: "invalid",
			detail: "models.json.providers must contain an object",
		};
	return {
		kind: "loaded",
		document: value as ModelsJsonDocument,
		revision: source.revision,
	};
}

function managedProvider(
	models: readonly FailoverCatalogModel[],
): Record<string, unknown> {
	return {
		name: FAILOVER_PROVIDER_NAME,
		models: models.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: [...model.input],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			cost: { ...model.cost },
			...(model.thinkingLevelMap
				? { thinkingLevelMap: { ...model.thinkingLevelMap } }
				: {}),
		})),
	};
}

function withManagedProvider(
	document: ModelsJsonDocument,
	models: readonly FailoverCatalogModel[],
): ModelsJsonDocument {
	const providers = isRecord(document.providers)
		? { ...document.providers }
		: {};
	providers[FAILOVER_PROVIDER_ID] = managedProvider(models);
	return { ...document, providers };
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
				throw new Error(`Timed out waiting for models catalog lock: ${path}`);
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

/** Replace only providers.failover, with a revision check and atomic write. */
export async function reconcileFailoverCatalog(
	path: string,
	models: readonly FailoverCatalogModel[],
	expectedRevision: ConfigSourceRevision,
): Promise<CatalogWriteResult> {
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
		let document: ModelsJsonDocument = { providers: {} };
		if (current.bytes) {
			try {
				const value: unknown = JSON.parse(current.bytes.toString("utf8"));
				if (
					!isRecord(value) ||
					(value.providers !== undefined && !isRecord(value.providers))
				)
					return { kind: "conflict" };
				document = value as ModelsJsonDocument;
			} catch {
				return { kind: "conflict" };
			}
		}
		const next = withManagedProvider(document, models);
		const handle = await open(tempPath, "wx", 0o600);
		tempCreated = true;
		try {
			await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
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
