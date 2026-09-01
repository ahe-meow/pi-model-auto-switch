import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	validateMultiplier,
	type BlockedReason,
	type ModelManagerBlockedState,
	type ModelManagerResult,
	type ModelManagerSidecar,
} from "./model-manager-types.ts";

export interface SidecarReadSuccess {
	sidecar: ModelManagerSidecar;
	rawBytes: Uint8Array;
	revision: string;
	path: string;
}

const secretKeys = new Set(["apiKey", "api_key", "token", "secret"]);

type BlockedExtra = Partial<
	Pick<ModelManagerBlockedState, "rawBytes" | "compatibilityImport">
>;

function blocked(
	reason: BlockedReason,
	message: string,
	extra: BlockedExtra = {},
): ModelManagerResult<never> {
	return { ok: false, error: { reason, message, ...extra } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function invalid(path: string, rule: string): ModelManagerResult<never> {
	return blocked("invalid", `${path}: ${rule}`);
}

function containsSecretKey(
	value: Record<string, unknown>,
	path: string,
): string | null {
	for (const key of Object.keys(value)) {
		if (secretKeys.has(key)) return `${path}.${key}`;
	}
	return null;
}

export function validateSidecar(
	value: unknown,
): ModelManagerResult<ModelManagerSidecar> {
	if (!isPlainObject(value)) return invalid("sidecar", "must be a plain object");

	const topLevelSecret = containsSecretKey(value, "sidecar");
	if (topLevelSecret)
		return invalid(topLevelSecret, "secret fields are not allowed");

	if (typeof value.version !== "number" || !Number.isFinite(value.version)) {
		return invalid("version", "must be a finite number");
	}
	if (value.version > 1)
		return blocked("future", "version is newer than supported");
	if (value.version !== 1) return invalid("version", "must equal 1");
	if (!Array.isArray(value.models)) return invalid("models", "must be an array");

	for (let index = 0; index < value.models.length; index += 1) {
		const path = `models[${index}]`;
		const recordValue = value.models[index];
		if (!isPlainObject(recordValue))
			return invalid(path, "must be a plain object");

		const recordSecret = containsSecretKey(recordValue, path);
		if (recordSecret)
			return invalid(recordSecret, "secret fields are not allowed");

		for (const field of ["id", "providerAlias", "providerName", "modelId"]) {
			const fieldValue = recordValue[field];
			if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
				return invalid(`${path}.${field}`, "must be a non-empty string");
			}
		}

		const multiplier = validateMultiplier(recordValue.multiplier);
		if (!multiplier.ok) {
			return invalid(`${path}.multiplier`, "must satisfy multiplier rules");
		}
	}

	return { ok: true, value: value as ModelManagerSidecar };
}

function compatibilityImport(): { available: true; sourcePaths: string[] } {
	const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return {
		available: true,
		sourcePaths: [join(agentDir, "auth.json"), join(agentDir, "models.json")],
	};
}

export async function readSidecar(
	path: string,
): Promise<ModelManagerResult<SidecarReadSuccess>> {
	let rawBytes: Uint8Array;
	try {
		rawBytes = new Uint8Array(await readFile(path));
	} catch (error: unknown) {
		const code =
			error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
		if (code === "ENOENT") {
			return blocked("missing", "sidecar is missing", {
				compatibilityImport: compatibilityImport(),
			});
		}
		return blocked("unreadable", "sidecar could not be read");
	}

	if (rawBytes.length === 0) {
		return blocked("malformed", "sidecar is empty", { rawBytes });
	}

	let parsed: unknown;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
		parsed = JSON.parse(text);
	} catch {
		return blocked("malformed", "sidecar is not valid JSON", { rawBytes });
	}

	const validated = validateSidecar(parsed);
	if (!validated.ok) {
		if ("reason" in validated.error) {
			return blocked(validated.error.reason, validated.error.message, {
				rawBytes,
			});
		}
		return { ok: false, error: validated.error };
	}

	return {
		ok: true,
		value: {
			sidecar: validated.value,
			rawBytes,
			revision: sidecarRevision(rawBytes),
			path,
		},
	};
}

export function serializeSidecar(
	sidecar: ModelManagerSidecar,
): ModelManagerResult<Uint8Array> {
	const validated = validateSidecar(sidecar);
	if (!validated.ok) return { ok: false, error: validated.error };

	try {
		const json = JSON.stringify(validated.value, null, 2);
		if (typeof json !== "string")
			return invalid("sidecar", "must be JSON-serializable");
		return { ok: true, value: new TextEncoder().encode(`${json}\n`) };
	} catch {
		return invalid("sidecar", "must be JSON-serializable");
	}
}

export function sidecarRevision(rawBytes: Uint8Array): string {
	return createHash("sha256").update(rawBytes).digest("hex").slice(0, 16);
}
