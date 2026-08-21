import type { ModelRef } from "./types.ts";
import { modelKey } from "./types.ts";

export interface RegistryModel {
	provider: string;
	id: string;
}

export interface ModelRegistryReader {
	refresh?: () => Promise<unknown>;
	getAll(): readonly RegistryModel[];
	getAvailable(): readonly RegistryModel[];
}

function asRef(model: RegistryModel): ModelRef | undefined {
	if (typeof model.provider !== "string" || model.provider.length === 0)
		return undefined;
	if (typeof model.id !== "string" || model.id.length === 0) return undefined;
	return { provider: model.provider, id: model.id };
}

export function uniqueModels(models: readonly RegistryModel[]): ModelRef[] {
	const seen = new Set<string>();
	const result: ModelRef[] = [];
	for (const model of models) {
		const ref = asRef(model);
		if (!ref) continue;
		const key = modelKey(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(ref);
	}
	return result;
}

export type DiscoveryResult =
	| { kind: "success"; available: ModelRef[] }
	| { kind: "failure"; available: ModelRef[]; error: unknown };

/** Refresh and observe the models Pi currently considers authenticated. */
export async function discoverModels(
	registry: ModelRegistryReader,
): Promise<DiscoveryResult> {
	try {
		await registry.refresh?.();
		return { kind: "success", available: uniqueModels(registry.getAvailable()) };
	} catch (error) {
		try {
			return {
				kind: "failure",
				available: uniqueModels(registry.getAvailable()),
				error,
			};
		} catch {
			return { kind: "failure", available: [], error };
		}
	}
}

export function seedModelList(current: ModelRef | undefined): ModelRef[] {
	return current ? [{ ...current }] : [];
}
