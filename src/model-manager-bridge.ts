import type { ModelManagerCatalogSnapshot } from "./model-manager-catalog.ts";
import type { CatalogImpact } from "./model-manager-impact.ts";
import type { ModelManagerRecord } from "./model-manager-types.ts";

export interface ModelManagerBridge {
	onDeleteRecord(recordId: string, impact: CatalogImpact): Promise<void>;
}

const registeredFailoverChains = new Map<string, Set<symbol>>();
const SAFE_CHAIN_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_PROVIDER_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

let modelManagerBridge:
	| { bridge: ModelManagerBridge; token: symbol }
	| undefined;

function isSafeChainId(value: unknown): value is string {
	return typeof value === "string" && SAFE_CHAIN_ID.test(value);
}

function isSafeProviderAlias(value: unknown): value is string {
	return typeof value === "string" && SAFE_PROVIDER_ALIAS.test(value);
}

export function registerFailoverChain(chainId: string): () => void {
	if (!isSafeChainId(chainId)) return () => undefined;
	const token = Symbol(chainId);
	const registrations = registeredFailoverChains.get(chainId) ?? new Set<symbol>();
	registrations.add(token);
	registeredFailoverChains.set(chainId, registrations);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		const current = registeredFailoverChains.get(chainId);
		if (!current) return;
		current.delete(token);
		if (current.size === 0) registeredFailoverChains.delete(chainId);
	};
}

export function clearFailoverChains(): void {
	registeredFailoverChains.clear();
}

export function registerModelManagerBridge(
	bridge: ModelManagerBridge,
): () => void {
	const registration = { bridge, token: Symbol("model-manager-bridge") };
	modelManagerBridge = registration;
	return () => {
		if (modelManagerBridge?.token === registration.token)
			modelManagerBridge = undefined;
	};
}

export function clearModelManagerBridge(): void {
	modelManagerBridge = undefined;
}

export async function notifyModelManagerDelete(
	recordId: string,
	impact: CatalogImpact,
): Promise<void> {
	if (!modelManagerBridge) return;
	await modelManagerBridge.bridge.onDeleteRecord(recordId, impact);
}

export function selectCatalogRecordsForChains(
	snapshot: ModelManagerCatalogSnapshot,
): ModelManagerRecord[] {
	if (!Array.isArray(snapshot.records) || !(snapshot.byId instanceof Map)) {
		return [];
	}
	return snapshot.records
		.filter((record) => snapshot.byId.get(record.id) === record)
		.map((record) => structuredClone(record));
}

export function buildVirtualModel(
	chainId: string,
	records: readonly ModelManagerRecord[],
): { id: string; provider: string } | null {
	if (
		!isSafeChainId(chainId) ||
		!registeredFailoverChains.has(chainId) ||
		!Array.isArray(records) ||
		records.length === 0 ||
		records.some((record) => !isSafeProviderAlias(record?.providerAlias))
	)
		return null;
	const provider = records[0]?.providerAlias;
	if (!isSafeProviderAlias(provider)) return null;
	return { id: `mm-${chainId}`, provider };
}
