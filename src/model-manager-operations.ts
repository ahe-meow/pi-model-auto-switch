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
import { serializeSidecar } from "./model-manager-sidecar.ts";
import type {
	CatalogTransactionInput,
	TransactionResult,
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

function stripSecretFields(value: unknown): DraftValue {
	if (Array.isArray(value)) return value.map(stripSecretFields);
	if (value === null || value === undefined) return value;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) return value;
	if (typeof value !== "object") return null;
	const result: { [key: string]: DraftValue } = {};
	for (const [key, child] of Object.entries(value)) {
		if (secretKeys.has(key)) continue;
		result[key] = stripSecretFields(child);
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

function copyAdvanced(advanced: Record<string, unknown>): Record<string, unknown> {
	return stripSecretFields(structuredClone(advanced)) as Record<string, unknown>;
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
	const takenAliases = new Set(snapshot.records.map((entry) => entry.providerAlias));
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
				...copyAdvanced(draft.advanced),
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
			...copyAdvanced(draft.advanced),
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
		? { edit: [{ id: record.id, fields: { ...draft.advanced, ...draft.fields } }] }
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
	try {
		const record = recordForDraft(snapshot, draft);
		if (!record.ok) return record;
		const projected = previewProviders(snapshot, record.value, draft);
		const payload: PreviewPayload = { ...projected, impact: null };
		const text = redactSecrets(JSON.stringify(payload), secretList(draft));
		return { ok: true, value: JSON.parse(text) as PreviewPayload };
	} catch {
		return failure(
			"preview-invalid",
			"Draft preview could not be generated",
			secretList(draft),
		);
	}
}

function canonicalJson(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function providerBytes(
	preview: PreviewPayload,
	draft: ModelManagerDraft,
): ModelManagerResult<Uint8Array> {
	const secret = draft.secret;
	if (!secret) {
		return failure(
			"provider-secret-required",
			"A new provider requires a key for the native provider commit",
		);
	}
	const providers = structuredClone(preview.providerDrafts);
	const target = providers.find((provider) => provider.name === draft.fields.providerAlias);
	if (!target) return failure("provider-draft-missing", "Provider draft is missing");
	if (providers.some((provider) => provider !== target && provider.apiKey === "")) {
		return failure(
			"opaque-provider-bytes-required",
			"Existing provider bytes are required before adding or replacing a key",
		);
	}
	target.apiKey = secret;
	return { ok: true, value: canonicalJson({ providers }) };
}

export async function commitDraft(
	draft: ModelManagerDraft,
	io: CommitDraftIo,
): Promise<ModelManagerResult<{ committed: string[] }>> {
	const secrets = secretList(draft);
	if (io.impact?.referenced) {
		const confirmation = confirmCascade(io.impact, {
			recordId: io.impact.recordId,
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
	const sidecarBytes = serializeSidecar(preview.value.sidecarAfter);
	if (!sidecarBytes.ok) {
		return failure("sidecar-invalid", sidecarBytes.error.message, secrets);
	}
	const writes: CatalogTransactionInput["writes"] = [{
		path: io.sidecarPath,
		bytes: sidecarBytes.value,
		expectRevision: "missing",
	}];
	if (draft.secret) {
		const modelsBytes = providerBytes(preview.value, draft);
		if (!modelsBytes.ok) return modelsBytes;
		writes.push({
			path: join(dirname(io.sidecarPath), "models.json"),
			bytes: modelsBytes.value,
			expectRevision: "missing",
		});
	} else if (draft.kind !== "edit") {
		return failure(
			"provider-secret-required",
			"A new provider requires a key for the native provider commit",
		);
	}

	try {
		const committed = await io.commit({ writes });
		if (!committed.ok) {
			return failure(
				committed.code ?? committed.error?.code ?? `transaction-${committed.phase}-failed`,
				committed.message,
				secrets,
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
