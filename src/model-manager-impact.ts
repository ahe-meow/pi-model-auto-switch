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

function includesIdentity(value: string, identity: string): boolean {
	return value === identity || value.includes(identity);
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
	const provider = stringField(value, ["provider", "providerAlias"]);
	const model = stringField(value, ["modelId"]);
	const id = stringField(value, ["id"]);
	if (
		provider !== undefined &&
		model !== undefined &&
		includesIdentity(provider, record.providerAlias) &&
		includesIdentity(model, record.modelId)
	)
		return true;
	if (
		provider !== undefined &&
		id !== undefined &&
		includesIdentity(provider, record.providerAlias) &&
		includesIdentity(id, record.modelId)
	)
		return true;
	return Object.values(value).some(
		(entry) =>
			typeof entry === "string" &&
			includesIdentity(entry, identityPair(record)),
	);
}

function hasChainContainer(value: JsonObject): boolean {
	return ["chain", "chains", "entries", "models"].some((key) => {
		const child = value[key];
		return Array.isArray(child) || isObject(child);
	});
}

function isGeneratedMarker(value: JsonObject, keyHint: string | undefined): boolean {
	if (keyHint === "generated") return true;
	if (value.generated === true || value.virtual === true) return true;
	if (value.kind === "generated" || value.type === "generated") return true;
	return ["provider", "providerAlias", "providerName", "name"].some(
		(key) => value[key] === "failover",
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
	generated: boolean;
	inChain: boolean;
	keyHint?: string;
	mapKeyContainer: boolean;
}

function scanChain(
	value: unknown,
	file: string,
	record: ModelManagerRecord,
	context: ChainScanContext,
	result: ChainReference[],
): void {
	if (typeof value === "string") {
		if (context.inChain && includesIdentity(value, identityPair(record))) {
			result.push({
				file,
				chainId: context.chainId ?? "unknown",
				kind: "model-entry",
			});
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) {
			scanChain(child, file, record, {
				...context,
				keyHint: String(index),
				mapKeyContainer: false,
			}, result);
		}
		return;
	}
	if (!isObject(value)) return;

	const explicitId = stringField(value, ["chainId"]);
	const objectId = stringField(value, ["id"]);
	const mapId =
		context.mapKeyContainer && context.keyHint && !/^\d+$/.test(context.keyHint)
			? context.keyHint
			: undefined;
	const chainId =
		explicitId ??
		((hasChainContainer(value) || objectId?.startsWith("mm-"))
			? objectId
			: undefined) ??
		mapId ??
		context.chainId;
	const marker = context.generated || isGeneratedMarker(value, context.keyHint);
	const inChain = context.inChain || hasChainContainer(value) || chainId !== undefined;

	if (inChain && isModelEntry(value, record)) {
		result.push({
			file,
			chainId: chainId ?? "unknown",
			kind: "model-entry",
		});
	}

	for (const [key, child] of Object.entries(value)) {
		scanChain(child, file, record, {
			chainId,
			generated: marker || key === "generated",
			inChain,
			keyHint: key,
			mapKeyContainer:
				key === "chains" || key === "entries" || key === "models",
		}, result);
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
		{ generated: false, inChain: false, mapKeyContainer: false },
		result,
	);
	return uniqueChainReferences(
		result.filter((reference) => reference.kind === "model-entry"),
	);
}

function containsRecordReference(
	value: unknown,
	record: ModelManagerRecord,
): boolean {
	if (typeof value === "string") return value === identityPair(record);
	if (Array.isArray(value))
		return value.some((child) => containsRecordReference(child, record));
	if (!isObject(value)) return false;
	if (isModelEntry(value, record)) return true;
	return Object.values(value).some((child) => containsRecordReference(child, record));
}

function scanGenerated(
	value: unknown,
	file: string,
	record: ModelManagerRecord,
	context: ChainScanContext,
	result: ChainReference[],
): void {
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) {
			scanGenerated(child, file, record, {
				...context,
				keyHint: String(index),
				mapKeyContainer: false,
			}, result);
		}
		return;
	}
	if (!isObject(value)) return;

	const explicitId = stringField(value, ["chainId"]);
	const objectId = stringField(value, ["id"]);
	const mapId =
		context.mapKeyContainer && context.keyHint && !/^\d+$/.test(context.keyHint)
			? context.keyHint
			: undefined;
	const chainId = explicitId ?? objectId ?? mapId ?? context.chainId;
	const generated = context.generated || isGeneratedMarker(value, context.keyHint);
	if (
		chainId !== undefined &&
		(objectId?.startsWith("mm-") === true || generated) &&
		containsRecordReference(value, record)
	) {
		result.push({ file, chainId, kind: "generated-block" });
	}
	for (const [key, child] of Object.entries(value)) {
		scanGenerated(child, file, record, {
			chainId,
			generated: generated || key === "generated",
			inChain: context.inChain,
			keyHint: key,
			mapKeyContainer:
				key === "chains" || key === "entries" || key === "models" ||
				(key === "providers" && generated),
		}, result);
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
		{ generated: false, inChain: false, mapKeyContainer: false },
		result,
	);
	return uniqueChainReferences(
		result.filter((reference) => reference.kind === "generated-block"),
	);
}

function statePath(parent: string, key: string, array: boolean): string {
	if (array) return `${parent}[${key}]`;
	if (parent.length === 0) return key;
	return `${parent}.${key}`;
}

function isStateIdentity(value: string, record: ModelManagerRecord): boolean {
	return value === identityPair(record) || value === record.id;
}

function scanStateValue(
	value: unknown,
	file: string,
	record: ModelManagerRecord,
	path: string,
	result: StateReference[],
): void {
	if (typeof value === "string") {
		if (isStateIdentity(value, record)) result.push({ file, key: path });
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries())
			scanStateValue(child, file, record, statePath(path, String(index), true), result);
		return;
	}
	if (!isObject(value)) return;
	for (const [key, child] of Object.entries(value)) {
		const childPath = statePath(path, key, false);
		if (isStateIdentity(key, record)) result.push({ file, key: childPath });
		scanStateValue(child, file, record, childPath, result);
	}
}

/** Scan state keys and associated values without reading files or exposing values. */
export function scanStateReferences(
	document: unknown,
	file: string,
	record: ModelManagerRecord,
): StateReference[] {
	const result: StateReference[] = [];
	scanStateValue(document, file, record, "", result);
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
