import type { ModelRef } from "./types.ts";
import { modelKey } from "./types.ts";

export interface RegistryModel {
	provider: string;
	id: string;
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
