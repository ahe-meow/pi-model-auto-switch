import { readFile } from "node:fs/promises";
import type { ModelManagerCatalogSnapshot } from "./model-manager-catalog.ts";
import type {
	ModelManagerError,
	ModelManagerRecord,
	ModelManagerResult,
} from "./model-manager-types.ts";

export interface ChainReference {
	file: string;
	chainId: string;
	kind: "model-entry" | "generated-block";
}

export interface StateReference {
	file: string;
	key: string;
}

export interface CatalogImpact {
	recordId: string;
	chains: ChainReference[];
	state: StateReference[];
	referenced: boolean;
}

type JsonObject = Record<string, unknown>;

const READ_ERROR: ModelManagerError = {
	code: "unreadable-failover-read-only",
	message: "Failover references could not be read for read-only analysis",
};

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identityPair(record: ModelManagerRecord): string {
	return `${record.providerAlias}/${record.modelId}`;
}

function stringField(
	value: JsonObject,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		if (typeof value[key] === "string") return value[key];
	}
	return undefined;
}

function isModelEntry(value: JsonObject, record: ModelManagerRecord): boolean {
	return (
		stringField(value, ["provider", "providerAlias"]) ===
			record.providerAlias &&
		stringField(value, ["modelId", "id"]) === record.modelId
	);
}

const CHAIN_CONTAINER_KEYS = new Set(["chain", "chains", "entries", "models"]);

function hasChainContainer(value: JsonObject): boolean {
	return [...CHAIN_CONTAINER_KEYS].some((key) => {
		const child = value[key];
		return Array.isArray(child) || isObject(child);
	});
}

function isGeneratedBlock(value: JsonObject, mapKey?: string): boolean {
	const id = stringField(value, ["id"]) ?? mapKey;
	return (
		id?.startsWith("mm-") === true ||
		value.generated === true ||
		value.virtual === true ||
		value.kind === "generated" ||
		value.kind === "virtual" ||
		value.type === "generated" ||
		value.type === "virtual"
	);
}

function compareChainReferences(a: ChainReference, b: ChainReference): number {
	return (
		a.file.localeCompare(b.file) ||
		a.chainId.localeCompare(b.chainId) ||
		a.kind.localeCompare(b.kind)
	);
}

function uniqueChainReferences(references: readonly ChainReference[]): ChainReference[] {
	const seen = new Set<string>();
	const result: ChainReference[] = [];
	for (const reference of references) {
		const key = `${reference.file}\u0000${reference.chainId}\u0000${reference.kind}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(reference);
	}
	return result.sort(compareChainReferences);
}

interface ChainScanContext {
	chainId?: string;
	mapKey?: string;
	entryCandidate: boolean;
	mapContainer: boolean;
}

function childContext(
	key: string,
	child: unknown,
	chainId: string | undefined,
): ChainScanContext {
	const container = CHAIN_CONTAINER_KEYS.has(key);
	return {
		chainId,
		entryCandidate:
			container && (key === "chain" || key === "entries") &&
			!isObject(child),
		mapContainer: container && isObject(child),
	};
}

function scanChain(
	value: unknown,
	file: string,
	record: ModelManagerRecord,
	context: ChainScanContext,
	result: ChainReference[],
): void {
	if (typeof value === "string") {
		if (context.entryCandidate && value === identityPair(record)) {
			result.push({
				file,
				chainId: context.chainId ?? "unknown",
				kind: "model-entry",
			});
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const child of value) {
			scanChain(child, file, record, {
				...context,
				mapKey: undefined,
				mapContainer: false,
			}, result);
		}
		return;
	}
	if (!isObject(value)) return;

	if (context.mapContainer) {
		for (const [key, child] of Object.entries(value)) {
			scanChain(child, file, record, {
				chainId: key,
				mapKey: key,
				entryCandidate: true,
				mapContainer: false,
			}, result);
		}
		return;
	}

	const wrapper = hasChainContainer(value);
	const chainId =
		context.mapKey ??
		(wrapper
			? stringField(value, ["chainId", "id"])
			: undefined) ??
		context.chainId;
	if (context.entryCandidate && isModelEntry(value, record)) {
		result.push({
			file,
			chainId: chainId ?? "unknown",
			kind: "model-entry",
		});
	}

	for (const [key, child] of Object.entries(value)) {
		scanChain(child, file, record, childContext(key, child, chainId), result);
	}
}

/** Scan model references without reading files or mutating the input document. */
export function scanModelEntries(
	document: unknown,
	file: string,
	record: ModelManagerRecord,
): ChainReference[] {
	const result: ChainReference[] = [];
	scanChain(
		document,
		file,
		record,
		{ entryCandidate: false, mapContainer: false },
		result,
	);
	return uniqueChainReferences(result);
}

function containsRecordReference(
	value: unknown,
	record: ModelManagerRecord,
): boolean {
	return scanModelEntries(value, "", record).length > 0;
}

function scanGenerated(
	value: unknown,
	file: string,
	record: ModelManagerRecord,
	context: ChainScanContext,
	result: ChainReference[],
): void {
	if (Array.isArray(value)) {
		for (const child of value) {
			scanGenerated(child, file, record, {
				...context,
				mapKey: undefined,
				mapContainer: false,
			}, result);
		}
		return;
	}
	if (!isObject(value)) return;

	if (context.mapContainer) {
		for (const [key, child] of Object.entries(value)) {
			scanGenerated(child, file, record, {
				chainId: key,
				mapKey: key,
				entryCandidate: true,
				mapContainer: false,
			}, result);
		}
		return;
	}

	const wrapper = hasChainContainer(value);
	const objectId = stringField(value, ["id"]);
	const chainId =
		context.mapKey ??
		(wrapper
			? stringField(value, ["chainId", "id"])
			: undefined) ??
		context.chainId;
	const blockId =
		(objectId?.startsWith("mm-") === true ? objectId : undefined) ??
		context.mapKey ??
		stringField(value, ["chainId", "id"]) ??
		context.chainId;
	if (
		blockId !== undefined &&
		isGeneratedBlock(value, context.mapKey) &&
		containsRecordReference(value, record)
	) {
		result.push({ file, chainId: blockId, kind: "generated-block" });
	}

	for (const [key, child] of Object.entries(value)) {
		scanGenerated(child, file, record, childContext(key, child, chainId), result);
	}
}

/** Scan generated virtual model blocks without reading files or sharing state. */
export function scanGeneratedBlocks(
	document: unknown,
	file: string,
	record: ModelManagerRecord,
): ChainReference[] {
	const result: ChainReference[] = [];
	scanGenerated(
		document,
		file,
		record,
		{ entryCandidate: false, mapContainer: false },
		result,
	);
	return uniqueChainReferences(result);
}

function statePath(parent: string, key: string, array: boolean): string {
	if (array) return `${parent}[${key}]`;
	if (parent.length === 0) return key;
	return `${parent}.${key}`;
}

function scanStateTargets(
	value: unknown,
	file: string,
	identity: string,
	path: string,
	result: StateReference[],
): void {
	if (!Array.isArray(value)) return;
	for (const [index, target] of value.entries()) {
		if (target === identity) {
			result.push({
				file,
				key: statePath(path, String(index), true),
			});
		}
	}
}

/** Scan state keys and associated values without reading files or exposing values. */
export function scanStateReferences(
	document: unknown,
	file: string,
	record: ModelManagerRecord,
): StateReference[] {
	if (!isObject(document)) return [];
	const identity = identityPair(record);
	const result: StateReference[] = [];
	if (isObject(document.targets) && Object.hasOwn(document.targets, identity)) {
		result.push({ file, key: `targets.${identity}` });
	}
	if (isObject(document.registrations)) {
		for (const [registrationKey, registration] of Object.entries(
			document.registrations,
		)) {
			if (!isObject(registration)) continue;
			scanStateTargets(
				registration.targets,
				file,
				identity,
				`registrations.${registrationKey}.targets`,
				result,
			);
		}
	}
	if (isObject(document.scopes)) {
		for (const [scopeKey, scope] of Object.entries(document.scopes)) {
			if (!isObject(scope)) continue;
			scanStateTargets(
				scope.targets,
				file,
				identity,
				`scopes.${scopeKey}.targets`,
				result,
			);
			if (isObject(scope.overrides) && Object.hasOwn(scope.overrides, identity)) {
				result.push({
					file,
					key: `scopes.${scopeKey}.overrides.${identity}`,
				});
			}
		}
	}
	const seen = new Set<string>();
	return result
		.filter((reference) => {
			const key = `${reference.file}\u0000${reference.key}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => a.file.localeCompare(b.file) || a.key.localeCompare(b.key));
}

async function readJson(
	path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: ModelManagerError }> {
	try {
		const bytes = await readFile(path);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false, error: { ...READ_ERROR } };
	}
}

export async function analyzeDeletionImpact(
	snapshot: ModelManagerCatalogSnapshot,
	recordId: string,
	readonlyPaths: { chainsPath: string; statePath: string },
): Promise<ModelManagerResult<CatalogImpact>> {
	const record = snapshot.records.find((entry) => entry.id === recordId);
	if (!record) {
		return {
			ok: false,
			error: {
				code: "record-not-found",
				message: "The requested catalog record is not present in the snapshot",
			},
		};
	}

	const [chainsRead, stateRead] = await Promise.all([
		readJson(readonlyPaths.chainsPath),
		readJson(readonlyPaths.statePath),
	]);
	if (!chainsRead.ok || !stateRead.ok) return { ok: false, error: { ...READ_ERROR } };

	const chainReferences = uniqueChainReferences([
		...scanModelEntries(chainsRead.value, readonlyPaths.chainsPath, record),
		...scanGeneratedBlocks(chainsRead.value, readonlyPaths.chainsPath, record),
	]);
	const stateReferences = scanStateReferences(stateRead.value, readonlyPaths.statePath, record);
	return {
		ok: true,
		value: {
			recordId,
			chains: chainReferences,
			state: stateReferences,
			referenced: chainReferences.length + stateReferences.length > 0,
		},
	};
}

export function confirmCascade(
	impact: CatalogImpact,
	confirmation: { recordId: string; ack: boolean },
): ModelManagerResult<"confirmed"> {
	if (confirmation.ack !== true || confirmation.recordId !== impact.recordId) {
		return {
			ok: false,
			error: {
				code: "cascade-not-confirmed",
				message: "Cascade confirmation was not acknowledged for this record",
			},
		};
	}
	return { ok: true, value: "confirmed" };
}
