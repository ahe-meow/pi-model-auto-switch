import type { ConfigSourceRevision } from "./json-file.ts";
import { isRecord, readJsonSource, writeJsonAtomically } from "./json-file.ts";
import {
	REASONING_EFFORTS,
	modelKey,
	type GeneratedFailoverConfig,
	type GeneratedFailoverModel,
	type ModelRef,
	type ReasoningEffort,
} from "./types.ts";

export const FAILOVER_PROVIDER_ID = "failover";
const FAILOVER_PROVIDER_NAME = "Failover";

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

interface ModelsJsonDocument {
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
	model: Pick<GeneratedFailoverModel, "id" | "name" | "enabled" | "chain">,
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

const MODELS_JSON_RETRY_WAIT_MS = 75;

type AfterMalformed = () => void | Promise<void>;

async function defaultAfterMalformed(): Promise<void> {
	await new Promise<void>((resolve) =>
		setTimeout(resolve, MODELS_JSON_RETRY_WAIT_MS),
	);
}

async function loadModelsJsonOnce(path: string): Promise<ModelsJsonLoadResult> {
	const source = await readJsonSource(path, "models.json");
	if (source.kind !== "parsed") return source;
	const value = source.value;
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

export async function loadModelsJson(
	path: string,
	afterMalformed: AfterMalformed = defaultAfterMalformed,
): Promise<ModelsJsonLoadResult> {
	const first = await loadModelsJsonOnce(path);
	if (first.kind !== "blocked" || first.reason !== "malformed") return first;
	try {
		await afterMalformed();
	} catch {
		return first;
	}
	const retry = await loadModelsJsonOnce(path);
	return retry.kind === "loaded" ? retry : first;
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

/** Replace only providers.failover, with a revision check and atomic write. */
export async function reconcileFailoverCatalog(
	path: string,
	models: readonly FailoverCatalogModel[],
	expectedRevision: ConfigSourceRevision,
): Promise<CatalogWriteResult> {
	return writeJsonAtomically(
		path,
		"models catalog",
		expectedRevision,
		(current) => {
			if (!current.bytes) return withManagedProvider({ providers: {} }, models);
			let value: unknown;
			try {
				value = JSON.parse(current.bytes.toString("utf8"));
			} catch {
				return undefined;
			}
			if (
				!isRecord(value) ||
				(value.providers !== undefined && !isRecord(value.providers))
			)
				return undefined;
			return withManagedProvider(value as ModelsJsonDocument, models);
		},
	);
}
