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

/** Read the models Pi currently considers authenticated. */
export async function discoverModels(
	registry: ModelRegistryReader,
): Promise<ModelRef[]> {
	await registry.refresh?.();
	return uniqueModels(registry.getAvailable());
}

export function seedModelList(
	current: ModelRef | undefined,
	catalog: readonly ModelRef[],
): ModelRef[] {
	const result: ModelRef[] = [];
	const seen = new Set<string>();
	if (current) {
		result.push({ ...current });
		seen.add(modelKey(current));
	}
	for (const model of catalog) {
		const key = modelKey(model);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({ ...model });
	}
	return result;
}

export function filterConfiguredModels(
	configured: readonly ModelRef[],
	available: readonly ModelRef[],
): ModelRef[] {
	const availableKeys = new Set(available.map(modelKey));
	return configured
		.filter((model) => availableKeys.has(modelKey(model)))
		.map((model) => ({ ...model }));
}

/** Preserve user order while keeping refreshed discovery available to add in the TUI. */
export function mergeDiscoveredModels(
	configured: readonly ModelRef[],
	discovered: readonly ModelRef[],
): ModelRef[] {
	const result = configured.map((model) => ({ ...model }));
	const seen = new Set(result.map(modelKey));
	for (const model of discovered) {
		const key = modelKey(model);
		if (!seen.has(key)) result.push({ ...model });
	}
	return result;
}
