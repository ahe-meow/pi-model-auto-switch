import { readFile } from "node:fs/promises";
import {
	readSidecar,
	type SidecarReadSuccess,
} from "./model-manager-sidecar.ts";
import {
	createStableId,
	type ModelManagerRecord,
	type ModelManagerResult,
} from "./model-manager-types.ts";

export interface PiProviderModel {
	id: string;
	name?: string;
	[key: string]: unknown;
}

export interface PiProviderDraft {
	name: string;
	baseUrl?: string;
	apiKey: string;
	models: PiProviderModel[];
	[key: string]: unknown;
}

export interface ModelManagerCatalogSnapshot {
	records: ModelManagerRecord[];
	byId: Map<string, ModelManagerRecord>;
	providers: PiProviderDraft[];
	failoverUntouched: true;
}

export interface CatalogEdits {
	add?: ModelManagerRecord[];
	edit?: Array<{ id: string; fields: Partial<ModelManagerRecord> }>;
	remove?: string[];
}

type JsonObject = Record<string, unknown>;
type SanitizedValue =
	| null
	| string
	| number
	| boolean
	| SanitizedValue[]
	| { [key: string]: SanitizedValue };

const secretKeys = new Set(["apiKey", "api_key", "token", "secret"]);
const managerRecordKeys = new Set([
	"id",
	"providerAlias",
	"providerName",
	"modelId",
	"label",
	"remoteGroup",
	"groupOwner",
	"multiplier",
]);

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripSecrets(value: unknown): SanitizedValue {
	if (value === null) return null;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (Array.isArray(value)) return value.map(stripSecrets);
	if (!isObject(value)) return null;

	const result: { [key: string]: SanitizedValue } = {};
	for (const [key, child] of Object.entries(value)) {
		if (secretKeys.has(key)) continue;
		result[key] = stripSecrets(child);
	}
	return result;
}

function unreadableModels(): ModelManagerResult<never> {
	return {
		ok: false,
		error: {
			code: "unreadable-models",
			message: "models.json could not be read as a supported catalog",
		},
	};
}

function sanitizeRecord(record: ModelManagerRecord): ModelManagerRecord {
	return stripSecrets(record) as ModelManagerRecord;
}

function recordIndex(
	records: readonly ModelManagerRecord[],
): Map<string, ModelManagerRecord> {
	const byId = new Map<string, ModelManagerRecord>();
	for (const record of records) byId.set(record.id, record);
	return byId;
}

function modelFromRecord(record: ModelManagerRecord): PiProviderModel {
	const model: JsonObject = { id: record.modelId };
	if (record.label !== undefined) model.name = record.label;
	for (const [key, value] of Object.entries(record)) {
		if (managerRecordKeys.has(key) || secretKeys.has(key)) continue;
		model[key] = stripSecrets(value);
	}
	return model as PiProviderModel;
}

function providerForRecords(
	records: readonly ModelManagerRecord[],
	previous: readonly PiProviderDraft[],
): PiProviderDraft[] {
	const providers = previous.map((provider) => {
		const safe = stripSecrets(provider) as PiProviderDraft;
		safe.apiKey = "";
		safe.models = provider.models.map(
			(model) => stripSecrets(model) as PiProviderModel,
		);
		return safe;
	});
	const providerIndexes = new Map<string, number>();
	for (let index = 0; index < providers.length; index += 1) {
		const provider = providers[index]!;
		if (!providerIndexes.has(provider.name))
			providerIndexes.set(provider.name, index);
	}
	const modelOccurrences = new Map<string, number>();

	for (const record of records) {
		let providerIndex = providerIndexes.get(record.providerAlias);
		if (providerIndex === undefined) {
			providerIndex = providers.length;
			providers.push({ name: record.providerAlias, apiKey: "", models: [] });
			providerIndexes.set(record.providerAlias, providerIndex);
		}
		const provider = providers[providerIndex]!;
		const occurrenceKey = `${record.providerAlias}\u0000${record.modelId}`;
		const occurrence = modelOccurrences.get(occurrenceKey) ?? 0;
		modelOccurrences.set(occurrenceKey, occurrence + 1);
		let modelIndex = -1;
		let matchedOccurrence = 0;
		for (let index = 0; index < provider.models.length; index += 1) {
			if (provider.models[index]?.id !== record.modelId) continue;
			if (matchedOccurrence === occurrence) {
				modelIndex = index;
				break;
			}
			matchedOccurrence += 1;
		}
		const projected = modelFromRecord(record);
		if (modelIndex === -1) {
			provider.models.push(projected);
		} else {
			provider.models[modelIndex] = {
				...provider.models[modelIndex],
				...projected,
			};
		}
	}
	return providers;
}

function parseProviderModels(
	provider: JsonObject,
): PiProviderModel[] | undefined {
	if (!Array.isArray(provider.models)) return undefined;
	const models: PiProviderModel[] = [];
	for (const value of provider.models) {
		if (
			!isObject(value) ||
			typeof value.id !== "string" ||
			value.id.trim() === ""
		) {
			return undefined;
		}
		const safe = stripSecrets(value) as JsonObject;
		models.push(safe as PiProviderModel);
	}
	return models;
}

function parseProviders(document: unknown): PiProviderDraft[] | undefined {
	if (!isObject(document) || !Array.isArray(document.providers))
		return undefined;
	const providers: PiProviderDraft[] = [];
	for (const providerValue of document.providers) {
		if (
			!isObject(providerValue) ||
			typeof providerValue.name !== "string" ||
			providerValue.name.trim() === ""
		) {
			return undefined;
		}
		if (
			providerValue.baseUrl !== undefined &&
			typeof providerValue.baseUrl !== "string"
		) {
			return undefined;
		}
		if (
			providerValue.apiKey === undefined ||
			typeof providerValue.apiKey !== "string"
		) {
			return undefined;
		}
		const models = parseProviderModels(providerValue);
		if (!models) return undefined;
		const safe = stripSecrets(providerValue) as JsonObject;
		safe.apiKey = "";
		safe.models = models;
		providers.push(safe as PiProviderDraft);
	}
	return providers;
}

function buildRecords(
	providers: readonly PiProviderDraft[],
	sidecar: SidecarReadSuccess["sidecar"],
): ModelManagerRecord[] {
	const identities = new Set(
		providers.flatMap((provider) =>
			provider.models.map((model) => `${provider.name}\u0000${model.id}`),
		),
	);
	return sidecar.models
		.filter((record) =>
			identities.has(`${record.providerAlias}\u0000${record.modelId}`),
		)
		.map(sanitizeRecord);
}

export async function readModelCatalog(
	modelsPath: string,
	sidecarPath: string,
): Promise<ModelManagerResult<ModelManagerCatalogSnapshot>> {
	const [modelsRead, sidecarRead] = await Promise.all([
		readFile(modelsPath).catch(() => undefined),
		readSidecar(sidecarPath),
	]);

	if (!sidecarRead.ok) return sidecarRead;
	if (!modelsRead) return unreadableModels();

	let parsed: unknown;
	try {
		parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(modelsRead),
		);
	} catch {
		return unreadableModels();
	}
	const providers = parseProviders(parsed);
	if (!providers) return unreadableModels();

	const records = buildRecords(providers, sidecarRead.value.sidecar);
	return {
		ok: true,
		value: {
			records,
			byId: recordIndex(records),
			providers,
			failoverUntouched: true,
		},
	};
}

export function toPiProviderAlias(record: ModelManagerRecord): PiProviderDraft {
	const provider: PiProviderDraft = {
		name: record.providerAlias,
		...(typeof record.baseUrl === "string" ? { baseUrl: record.baseUrl } : {}),
		apiKey: "",
		models: [modelFromRecord(record)],
	};
	return provider;
}

export function toSidecarRecord(
	providerName: string,
	modelId: string,
	fields: Partial<ModelManagerRecord>,
): ModelManagerRecord {
	const copiedFields = structuredClone(fields);
	const providerAlias =
		typeof copiedFields.providerAlias === "string" &&
		copiedFields.providerAlias.length > 0
			? copiedFields.providerAlias
			: providerName;
	return sanitizeRecord({
		...copiedFields,
		id: createStableId(providerAlias, modelId),
		providerAlias,
		providerName,
		modelId,
		multiplier: copiedFields.multiplier ?? 1,
		groupOwner: copiedFields.groupOwner ?? false,
	});
}

export function applyCatalogDraft(
	snapshot: ModelManagerCatalogSnapshot,
	edits: CatalogEdits,
): ModelManagerCatalogSnapshot {
	let records = snapshot.records.map(sanitizeRecord);
	const taken = new Set(records.map((record) => record.id));
	for (const record of edits.add ?? []) {
		const safeRecord = sanitizeRecord(record);
		const id = taken.has(safeRecord.id)
			? createStableId(safeRecord.providerAlias, safeRecord.modelId, taken)
			: safeRecord.id;
		const added = id === safeRecord.id ? safeRecord : { ...safeRecord, id };
		records.push(added);
		taken.add(id);
	}

	for (const edit of edits.edit ?? []) {
		const index = records.findIndex((record) => record.id === edit.id);
		if (index === -1) continue;
		const editableFields: JsonObject = {};
		for (const [key, value] of Object.entries(edit.fields)) {
			if (
				key === "id" ||
				key === "providerAlias" ||
				key === "providerName" ||
				key === "modelId"
			)
				continue;
			editableFields[key] = value;
		}
		records[index] = structuredClone({
			...records[index],
			...(stripSecrets(editableFields) as JsonObject),
		});
	}
	const removed = new Set(edits.remove ?? []);
	if (removed.size > 0)
		records = records.filter((record) => !removed.has(record.id));

	return {
		records,
		byId: recordIndex(records),
		providers: providerForRecords(records, snapshot.providers),
		failoverUntouched: true,
	};
}
