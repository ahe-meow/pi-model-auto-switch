export type Multiplier = number;

export interface ModelManagerRecord {
	id: string;
	providerAlias: string;
	providerName: string;
	modelId: string;
	label?: string;
	remoteGroup?: string;
	groupOwner?: boolean;
	multiplier?: Multiplier;
	[key: string]: unknown;
}

export interface ModelManagerSidecar {
	version: 1;
	models: ModelManagerRecord[];
	[key: string]: unknown;
}

export type BlockedReason =
	| "missing"
	| "malformed"
	| "invalid"
	| "future"
	| "unreadable";

export interface ModelManagerBlockedState {
	reason: BlockedReason;
	message: string;
	rawBytes?: Uint8Array;
	compatibilityImport?: { available: boolean; sourcePaths: string[] };
}

export interface ModelManagerError {
	code: string;
	message: string;
	details?: unknown;
}

export type ModelManagerResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: ModelManagerBlockedState | ModelManagerError };

export interface CatalogGroup {
	key: string;
	owner: ModelManagerRecord | null;
	records: ModelManagerRecord[];
}

/** Lowercase slug; anything not [a-z0-9] becomes "-". */
function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

export function createStableId(
	providerAlias: string,
	modelId: string,
	taken?: ReadonlySet<string>,
): string {
	const base = `${slug(providerAlias)}--${slug(modelId)}`;
	if (!taken || !taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n += 1;
	return `${base}-${n}`;
}

export function createProviderAlias(
	providerName: string,
	keyFingerprint: string,
): string {
	return `mm-${slug(providerName)}-${keyFingerprint.slice(0, 8)}`;
}

export function cloneRecord(record: ModelManagerRecord): ModelManagerRecord {
	return structuredClone(record);
}

/** Number of fractional digits in the shortest string form of a finite number. */
function decimalPlaces(value: number): number {
	const text = String(value);
	const dot = text.indexOf(".");
	return dot === -1 ? 0 : text.length - dot - 1;
}

export function validateMultiplier(value: unknown): ModelManagerResult<Multiplier> {
	if (value === undefined) return { ok: true, value: 1 };
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return {
			ok: false,
			error: { code: "invalid_multiplier", message: "multiplier must be a finite number" },
		};
	}
	if (value < 0.001 || value > 1000) {
		return {
			ok: false,
			error: {
				code: "out_of_range",
				message: "multiplier must be within 0.001 and 1000",
			},
		};
	}
	if (decimalPlaces(value) > 3) {
		return {
			ok: false,
			error: { code: "too_precise", message: "multiplier allows at most 3 decimals" },
		};
	}
	return { ok: true, value };
}

export function groupCatalog(records: readonly ModelManagerRecord[]): CatalogGroup[] {
	const groups = new Map<string, ModelManagerRecord[]>();
	for (const record of records) {
		const key = record.remoteGroup ?? record.providerAlias;
		const list = groups.get(key);
		if (list) list.push(record);
		else groups.set(key, [record]);
	}

	const result: CatalogGroup[] = [];
	for (const [key, list] of groups) {
		const owners = list.filter((r) => r.groupOwner === true);
		owners.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		result.push({ key, owner: owners[0] ?? null, records: list });
	}
	result.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return result;
}
