import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	applyCatalogDraft,
	toPiProviderAlias,
	type ModelManagerCatalogSnapshot,
	type PiProviderDraft,
} from "./model-manager-catalog.ts";
import {
	confirmCascade,
	type CatalogImpact,
} from "./model-manager-impact.ts";
import { serializeSidecar, validateSidecar } from "./model-manager-sidecar.ts";
import {
	readRevision,
	type CatalogTransactionInput,
	type TransactionResult,
} from "./model-manager-store.ts";
import {
	cloneRecord,
	createProviderAlias,
	createStableId,
	type ModelManagerRecord,
	type ModelManagerResult,
	type ModelManagerSidecar,
	type Multiplier,
} from "./model-manager-types.ts";

export interface RecordDraftFields {
	providerAlias: string;
	providerName: string;
	modelId: string;
	label?: string;
	remoteGroup?: string;
	groupOwner?: boolean;
	multiplier?: Multiplier;
}

export interface ModelManagerDraft {
	kind: "create" | "edit" | "clone";
	recordId?: string;
	fields: RecordDraftFields;
	advanced: Record<string, unknown>;
	secret?: string;
}

export interface PreviewPayload {
	sidecarAfter: ModelManagerSidecar;
	providerDrafts: PiProviderDraft[];
	impact: CatalogImpact | null;
}

export interface CommitDraftIo {
	snapshot: ModelManagerCatalogSnapshot;
	sidecarPath: string;
	commit: (input: CatalogTransactionInput) => Promise<TransactionResult>;
	impact: CatalogImpact | null;
	confirmed: boolean;
}

const fieldKeys = new Set([
	"id",
	"providerAlias",
	"providerName",
	"modelId",
	"label",
	"remoteGroup",
	"groupOwner",
	"multiplier",
]);
const secretKeys = new Set(["apiKey", "api_key", "token", "secret"]);
type DraftValue =
	| null
	| string
	| number
	| boolean
	| undefined
	| DraftValue[]
	| { [key: string]: DraftValue };

function stripSecretFields(
	value: unknown,
	secrets: readonly string[] = [],
): DraftValue {
	if (Array.isArray(value)) return value.map((child) => stripSecretFields(child, secrets));
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return redactSecrets(value, secrets);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value !== "object") return null;
	const result: { [key: string]: DraftValue } = {};
	for (const [key, child] of Object.entries(value)) {
		if (secretKeys.has(key)) continue;
		result[key] = stripSecretFields(child, secrets);
	}
	return result;
}

function copyFields(fields: RecordDraftFields): RecordDraftFields {
	return {
		providerAlias: fields.providerAlias,
		providerName: fields.providerName,
		modelId: fields.modelId,
		...(fields.label === undefined ? {} : { label: fields.label }),
		...(fields.remoteGroup === undefined ? {} : { remoteGroup: fields.remoteGroup }),
		...(fields.groupOwner === undefined ? {} : { groupOwner: fields.groupOwner }),
		...(fields.multiplier === undefined ? {} : { multiplier: fields.multiplier }),
	};
}

function copyAdvanced(
	advanced: Record<string, unknown>,
	secrets: readonly string[] = [],
): Record<string, unknown> {
	return stripSecretFields(structuredClone(advanced), secrets) as Record<string, unknown>;
}

function splitRecord(record: ModelManagerRecord): {
	fields: RecordDraftFields;
	advanced: Record<string, unknown>;
} {
	const fields = copyFields(record);
	const advanced: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (fieldKeys.has(key) || secretKeys.has(key)) continue;
		advanced[key] = structuredClone(value);
	}
	return { fields, advanced: copyAdvanced(advanced) };
}

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
	let safe = text;
	for (const secret of secrets) {
		if (secret.length > 0) safe = safe.split(secret).join("[redacted]");
	}
	return safe;
}

function failure<T>(
	code: string,
	message: string,
	secrets: readonly string[] = [],
): ModelManagerResult<T> {
	return {
		ok: false,
		error: { code, message: redactSecrets(message, secrets) },
	};
}

function secretList(draft: ModelManagerDraft): string[] {
	return draft.secret ? [draft.secret] : [];
}

export function createDraft(
	fields: RecordDraftFields,
	advanced: Record<string, unknown> = {},
): ModelManagerDraft {
	return { kind: "create", fields: copyFields(fields), advanced: copyAdvanced(advanced) };
}

export function editDraft(
	snapshot: ModelManagerCatalogSnapshot,
	recordId: string,
	fields: Partial<RecordDraftFields>,
): ModelManagerResult<ModelManagerDraft> {
	const record = snapshot.byId.get(recordId);
	if (!record) {
		return failure(
			"record-not-found",
			"The requested catalog record is not present in the snapshot",
		);
	}
	for (const key of ["providerAlias", "providerName", "modelId"] as const) {
		if (Object.hasOwn(fields, key) && fields[key] !== record[key]) {
			return failure(
				"immutable-identity",
				"Provider alias, provider name, and model ID cannot be changed by edit",
			);
		}
	}
	const copied = splitRecord(record);
	return {
		ok: true,
		value: {
			kind: "edit",
			recordId,
			fields: copyFields({ ...copied.fields, ...structuredClone(fields) }),
			advanced: copied.advanced,
		},
	};
}

export function cloneDraft(
	snapshot: ModelManagerCatalogSnapshot,
	recordId: string,
	keyFingerprint: string,
	overrides: Partial<RecordDraftFields> = {},
): ModelManagerResult<ModelManagerDraft> {
	const record = snapshot.byId.get(recordId);
	if (!record) {
		return failure(
			"record-not-found",
			"The requested catalog record is not present in the snapshot",
		);
	}
	const fingerprint = keyFingerprint.trim();
	const providerName = overrides.providerName ?? record.providerName;
	const derivedAlias = createProviderAlias(providerName, fingerprint);
	if (fingerprint.length === 0 || derivedAlias === record.providerAlias) {
		return failure(
			"clone-key-fingerprint-required",
			"Cloning requires a new non-empty key fingerprint",
		);
	}

	const hasRemoteGroup = Object.hasOwn(overrides, "remoteGroup");
	const remoteGroup = hasRemoteGroup ? overrides.remoteGroup : undefined;
	if (remoteGroup !== undefined && overrides.groupOwner !== true) {
		const knownGroups = new Set(
			snapshot.records.map((entry) => entry.remoteGroup ?? entry.providerAlias),
		);
		if (!knownGroups.has(remoteGroup)) {
			return failure(
				"remote-group-unknown",
				"The requested remote group is not present in the snapshot",
			);
		}
	}

	const copied = splitRecord(record);
	const takenAliases = new Set([
		...snapshot.records.map((entry) => entry.providerAlias),
		...snapshot.providers.map((provider) => provider.name),
	]);
	const providerAlias = createProviderAlias(providerName, fingerprint, takenAliases);
	const fields: RecordDraftFields = {
		...copied.fields,
		...structuredClone(overrides),
		providerAlias,
		providerName,
		label: overrides.label ?? `${record.label ?? ""} (copy)`.trim(),
	};
	delete fields.remoteGroup;
	delete fields.groupOwner;
	if (remoteGroup !== undefined) fields.remoteGroup = remoteGroup;
	if (Object.hasOwn(overrides, "groupOwner") && overrides.groupOwner !== undefined) {
		fields.groupOwner = overrides.groupOwner;
	}
	const id = createStableId(
		providerAlias,
		fields.modelId,
		new Set(snapshot.records.map((entry) => entry.id)),
	);
	return {
		ok: true,
		value: {
			kind: "clone",
			recordId: id,
			fields: copyFields(fields),
			advanced: copied.advanced,
		},
	};
}

function recordForDraft(
	snapshot: ModelManagerCatalogSnapshot,
	draft: ModelManagerDraft,
): ModelManagerResult<ModelManagerRecord> {
	if (draft.kind === "edit") {
		if (!draft.recordId || !snapshot.byId.has(draft.recordId)) {
			return failure(
				"record-not-found",
				"The requested catalog record is not present in the snapshot",
				secretList(draft),
			);
		}
		return {
			ok: true,
			value: {
				...copyAdvanced(draft.advanced, secretList(draft)),
				...copyFields(draft.fields),
				id: draft.recordId,
			},
		};
	}
	const id = draft.recordId ?? createStableId(
		draft.fields.providerAlias,
		draft.fields.modelId,
		new Set(snapshot.records.map((entry) => entry.id)),
	);
	return {
		ok: true,
		value: {
			...copyAdvanced(draft.advanced, secretList(draft)),
			...copyFields(draft.fields),
			id,
		},
	};
}

function previewProviders(
	snapshot: ModelManagerCatalogSnapshot,
	record: ModelManagerRecord,
	draft: ModelManagerDraft,
): { sidecarAfter: ModelManagerSidecar; providerDrafts: PiProviderDraft[] } {
	const applied = applyCatalogDraft(snapshot, draft.kind === "edit"
		? { edit: [{ id: record.id, fields: record }] }
		: { add: [record] });
	const target = applied.records.find((entry) => entry.id === record.id) ?? record;
	const targetProvider = toPiProviderAlias(target);
	const providerDrafts = applied.providers.map((provider) => ({
		...(provider.name === targetProvider.name ? targetProvider : {}),
		...provider,
		apiKey: "",
	}));
	if (!providerDrafts.some((provider) => provider.name === targetProvider.name)) {
		providerDrafts.push(targetProvider);
	}
	return {
		sidecarAfter: { version: 1, models: applied.records.map(cloneRecord) },
		providerDrafts,
	};
}

export function buildPreview(
	snapshot: ModelManagerCatalogSnapshot,
	draft: ModelManagerDraft,
): ModelManagerResult<PreviewPayload> {
	const secrets = secretList(draft);
	try {
		const record = recordForDraft(snapshot, draft);
		if (!record.ok) return record;
		const projected = previewProviders(snapshot, record.value, draft);
		const sidecarAfter = stripSecretFields(
			projected.sidecarAfter,
			secrets,
		) as ModelManagerSidecar;
		const providerDrafts = stripSecretFields(
			projected.providerDrafts,
			secrets,
		) as PiProviderDraft[];
		for (const provider of providerDrafts) provider.apiKey = "";
		return {
			ok: true,
			value: { sidecarAfter, providerDrafts, impact: null },
		};
	} catch {
		return failure(
			"preview-invalid",
			"Draft preview could not be generated",
			secrets,
		);
	}
}

type JsonObject = Record<string, unknown>;

type CurrentJson = {
	revision: string;
	document?: JsonObject;
};

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revisionFor(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function validModelsDocument(value: JsonObject): boolean {
	if (!Array.isArray(value.providers)) return false;
	return value.providers.every((provider) =>
		isJsonObject(provider) &&
		typeof provider.name === "string" &&
		provider.name.trim().length > 0 &&
		Array.isArray(provider.models) &&
		provider.models.every((model) =>
			isJsonObject(model) &&
			typeof model.id === "string" &&
			model.id.trim().length > 0
		)
	);
}

async function readCurrentJson(
	path: string,
	kind: "sidecar" | "models",
	secrets: readonly string[],
): Promise<ModelManagerResult<CurrentJson>> {
	let revision: string;
	try {
		revision = (await readRevision(path)).revision;
	} catch {
		return failure(`${kind}-read-failed`, `${kind} could not be read`, secrets);
	}
	if (revision === "missing") return { ok: true, value: { revision } };

	let bytes: Uint8Array;
	try {
		bytes = await readFile(path);
	} catch {
		return failure(`${kind}-read-failed`, `${kind} could not be read`, secrets);
	}
	if (revisionFor(bytes) !== revision) {
		return failure(
			"catalog-read-conflict",
			"Catalog changed while preparing the commit",
			secrets,
		);
	}

	let document: unknown;
	try {
		document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return failure(`${kind}-malformed`, `${kind} is not valid JSON`, secrets);
	}
	if (!isJsonObject(document)) {
		return failure(`${kind}-malformed`, `${kind} has an unsupported shape`, secrets);
	}
	if (kind === "sidecar") {
		if (!validateSidecar(document).ok) {
			return failure("sidecar-malformed", "sidecar has an unsupported shape", secrets);
		}
	} else if (!validModelsDocument(document)) {
		return failure("models-malformed", "models has an unsupported shape", secrets);
	}
	return { ok: true, value: { revision, document } };
}

function canonicalJson(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function mergedModels(
	existingProvider: JsonObject | undefined,
	projectedProvider: PiProviderDraft,
): unknown[] {
	const existing = Array.isArray(existingProvider?.models)
		? [...existingProvider.models]
		: [];
	const used = new Set<number>();
	for (const projected of projectedProvider.models) {
		let match = -1;
		for (let index = 0; index < existing.length; index += 1) {
			if (used.has(index)) continue;
			const candidate = existing[index];
			if (isJsonObject(candidate) && candidate.id === projected.id) {
				match = index;
				break;
			}
		}
		if (match === -1) {
			existing.push(structuredClone(projected));
			used.add(existing.length - 1);
		} else {
			existing[match] = {
				...(existing[match] as JsonObject),
				...structuredClone(projected),
			};
			used.add(match);
		}
	}
	return existing;
}

function providerBytes(
	preview: PreviewPayload,
	draft: ModelManagerDraft,
	current: JsonObject | undefined,
): ModelManagerResult<Uint8Array> {
	const secrets = secretList(draft);
	const secret = draft.secret;
	if (!secret) {
		return failure(
			"provider-secret-required",
			"A new provider requires a key for the native provider commit",
			secrets,
		);
	}
	const target = preview.providerDrafts.find(
		(provider) => provider.name === draft.fields.providerAlias,
	);
	if (!target) {
		return failure("provider-draft-missing", "Provider draft is missing", secrets);
	}
	const document = current ?? { providers: [] };
	const providers = [...(document.providers as JsonObject[])];
	const index = providers.findIndex((provider) => provider.name === target.name);
	const existing = index === -1 ? undefined : providers[index];
	const updated: JsonObject = {
		...existing,
		...structuredClone(target),
		models: mergedModels(existing, target),
		apiKey: secret,
	};
	if (index === -1) providers.push(updated);
	else providers[index] = updated;
	return {
		ok: true,
		value: canonicalJson({ ...document, providers }),
	};
}

export async function commitDraft(
	draft: ModelManagerDraft,
	io: CommitDraftIo,
): Promise<ModelManagerResult<{ committed: string[] }>> {
	const secrets = secretList(draft);
	const target = recordForDraft(io.snapshot, draft);
	if (!target.ok) return target;
	if (io.impact?.referenced) {
		const confirmation = confirmCascade(io.impact, {
			recordId: target.value.id,
			ack: io.confirmed,
		});
		if (!confirmation.ok) {
			return failure(
				"cascade-not-confirmed",
				confirmation.error.message,
				secrets,
			);
		}
	}

	const preview = buildPreview(io.snapshot, draft);
	if (!preview.ok) return preview;
	if (!draft.secret && draft.kind !== "edit") {
		return failure(
			"provider-secret-required",
			"A new provider requires a key for the native provider commit",
			secrets,
		);
	}

	const modelsPath = join(dirname(io.sidecarPath), "models.json");
	const [sidecarCurrent, modelsCurrent] = await Promise.all([
		readCurrentJson(io.sidecarPath, "sidecar", secrets),
		readCurrentJson(modelsPath, "models", secrets),
	]);
	if (!sidecarCurrent.ok) return sidecarCurrent;
	if (!modelsCurrent.ok) return modelsCurrent;

	const sidecarAfter = sidecarCurrent.value.document
		? {
			...sidecarCurrent.value.document,
			models: preview.value.sidecarAfter.models,
		} as ModelManagerSidecar
		: preview.value.sidecarAfter;
	const sidecarBytes = serializeSidecar(sidecarAfter);
	if (!sidecarBytes.ok) {
		return failure("sidecar-invalid", sidecarBytes.error.message, secrets);
	}
	const writes: CatalogTransactionInput["writes"] = [{
		path: io.sidecarPath,
		bytes: sidecarBytes.value,
		expectRevision: sidecarCurrent.value.revision,
	}];
	if (draft.secret) {
		const modelsBytes = providerBytes(
			preview.value,
			draft,
			modelsCurrent.value.document,
		);
		if (!modelsBytes.ok) return modelsBytes;
		writes.push({
			path: modelsPath,
			bytes: modelsBytes.value,
			expectRevision: modelsCurrent.value.revision,
		});
	}

	try {
		const committed = await io.commit({ writes });
		if (!committed.ok) {
			return failure(
				committed.code ?? committed.error?.code ?? `transaction-${committed.phase}-failed`,
				committed.message,
				[...secrets, io.sidecarPath, modelsPath],
			);
		}
		return { ok: true, value: { committed: committed.committed } };
	} catch {
		return failure("commit-failed", "Catalog commit failed", secrets);
	}
}

export function cancelDraft(draft: ModelManagerDraft): { cancelled: true } {
	void draft;
	return { cancelled: true };
}
