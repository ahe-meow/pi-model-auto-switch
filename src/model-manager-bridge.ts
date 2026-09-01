import type { ModelManagerCatalogSnapshot } from "./model-manager-catalog.ts";
import type { CatalogImpact } from "./model-manager-impact.ts";
import type { ModelManagerRecord } from "./model-manager-types.ts";

export interface ModelManagerBridge {
	onDeleteRecord(recordId: string, impact: CatalogImpact): Promise<void>;
}

const registeredFailoverChains = new Set<string>();
const SAFE_CHAIN_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_PROVIDER_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

let modelManagerBridge: ModelManagerBridge | undefined;

function isSafeChainId(value: unknown): value is string {
	return typeof value === "string" && SAFE_CHAIN_ID.test(value);
}

function isSafeProviderAlias(value: unknown): value is string {
	return typeof value === "string" && SAFE_PROVIDER_ALIAS.test(value);
}

export function registerFailoverChain(chainId: string): void {
	if (isSafeChainId(chainId)) registeredFailoverChains.add(chainId);
}

export function registerModelManagerBridge(bridge: ModelManagerBridge): void {
	modelManagerBridge = bridge;
}

export async function notifyModelManagerDelete(
	recordId: string,
	impact: CatalogImpact,
): Promise<void> {
	if (!modelManagerBridge) return;
	await modelManagerBridge.onDeleteRecord(recordId, impact);
}

export function selectCatalogRecordsForChains(
	snapshot: ModelManagerCatalogSnapshot,
): ModelManagerRecord[] {
	if (!Array.isArray(snapshot.records) || !(snapshot.byId instanceof Map)) {
		return [];
	}
	return snapshot.records.filter(
		(record) => snapshot.byId.get(record.id) === record,
	);
}

export function buildVirtualModel(
	chainId: string,
	records: readonly ModelManagerRecord[],
): { id: string; provider: string } | null {
	if (!isSafeChainId(chainId) || !registeredFailoverChains.has(chainId)) {
		return null;
	}
	const provider = records[0]?.providerAlias;
	if (!isSafeProviderAlias(provider)) return null;
	return { id: `mm-${chainId}`, provider };
}
