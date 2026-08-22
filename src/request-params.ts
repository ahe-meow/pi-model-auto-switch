import { createHash } from "node:crypto";
import { isRecord } from "./json-file.ts";
import type { FailureInput, ModelParameterToggles } from "./types.ts";

const OPENAI_REQUEST_APIS = new Set([
	"openai-responses",
	"openai-completions",
	"azure-openai-responses",
]);

const SESSION_AFFINITY_HEADERS = new Set([
	"session_id",
	"x-client-request-id",
	"x-session-affinity",
	"x-session-id",
]);

const CACHE_FIELDS = ["prompt_cache_key", "prompt_cache_retention"] as const;
export type CacheField = (typeof CACHE_FIELDS)[number];

const VALIDATION_TYPES = new Set([
	"invalid_request_error",
	"invalid_request",
	"request_validation_error",
]);

const UNSUPPORTED_FIELD_CODES = new Set([
	"unknown_field",
	"unknown_parameter",
	"unknown_request_field",
	"unknown_request_parameter",
	"unsupported_field",
	"unsupported_parameter",
	"unsupported_request_field",
	"unsupported_request_parameter",
]);

const REQUEST_STATUS_PATTERNS = [
	/\b(?:HTTP|API)\s+error\s*\((\d{3})\)/i,
	/\b(?:HTTP\s+)?(\d{3})\s*:/i,
];

export function isOpenAIRequestApi(api: string): boolean {
	return OPENAI_REQUEST_APIS.has(api);
}

/** Never transmit the plaintext session id: derive a namespaced SHA-256 digest. */
export function promptCacheKeyFromSessionId(
	sessionId: string | undefined,
): string | undefined {
	if (!sessionId) return undefined;
	return createHash("sha256")
		.update("pi-model-failover/prompt-cache-key/v1:")
		.update(sessionId)
		.digest("hex");
}

function findJsonRecordEnd(message: string, start: number): number | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let end = start; end < message.length; end++) {
		const character = message[end];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{") depth++;
		else if (character === "}" && --depth === 0) return end;
	}
	return undefined;
}

function extractJsonRecords(message: string): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (let start = message.indexOf("{"); start >= 0; ) {
		const end = findJsonRecordEnd(message, start);
		if (end === undefined) {
			start = message.indexOf("{", start + 1);
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(message.slice(start, end + 1));
			if (isRecord(parsed)) records.push(parsed);
		} catch {
			// Ignore balanced non-JSON braces and continue with the next object.
		}
		start = message.indexOf("{", end + 1);
	}
	return records;
}

function nestedRecords(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(nestedRecords);
	if (!isRecord(value)) return [];
	return [value, ...Object.values(value).flatMap(nestedRecords)];
}

function stringField(
	record: Record<string, unknown>,
	names: string[],
): string | undefined {
	for (const name of names) {
		const value = record[name];
		if (typeof value === "string") return value.toLowerCase();
	}
	return undefined;
}

function numericJsonStatus(message: string): number | undefined {
	for (const record of extractJsonRecords(message).flatMap(nestedRecords)) {
		for (const name of ["status", "status_code", "http_status", "code"]) {
			const value = record[name];
			let number: number | undefined;
			if (typeof value === "number") number = value;
			else if (typeof value === "string" && /^\d{3}$/.test(value))
				number = Number(value);
			if (number !== undefined) return number;
		}
	}
	return undefined;
}

export function requestStatus(input: FailureInput): number | undefined {
	if (input.status !== undefined) return input.status;
	const jsonStatus = numericJsonStatus(input.message ?? "");
	if (jsonStatus !== undefined) return jsonStatus;
	for (const pattern of REQUEST_STATUS_PATTERNS) {
		const match = input.message?.match(pattern);
		if (match) return Number(match[1]);
	}
	return undefined;
}

/** Literal patterns per field: no dynamic RegExp construction at call time. */
const CACHE_FIELD_PATTERNS = {
	prompt_cache_key: /(?:^|[^a-z0-9_])prompt_cache_key(?:$|[^a-z0-9_])/i,
	prompt_cache_retention:
		/(?:^|[^a-z0-9_])prompt_cache_retention(?:$|[^a-z0-9_])/i,
} satisfies Record<CacheField, RegExp>;

function knownFieldFromMessage(message: string, field: CacheField): boolean {
	return CACHE_FIELD_PATTERNS[field].test(message);
}

/** Identify which cache fields a 400/422 validation response rejected. */
export function rejectedCacheFields(input: FailureInput): CacheField[] {
	const status = requestStatus(input);
	if (status === 401 || status === 403 || (status !== 400 && status !== 422))
		return [];
	const records = extractJsonRecords(input.message ?? "").flatMap(nestedRecords);
	return CACHE_FIELDS.filter((field) =>
		records.some((record) => {
			const type = stringField(record, ["type", "error_type"]);
			const code = stringField(record, ["code", "error_code"]);
			const parameter = stringField(record, ["param", "parameter", "field"]);
			const codeValue = record.code;
			const numericCode =
				typeof codeValue === "number" ||
				(typeof codeValue === "string" && /^\d{3}$/.test(codeValue));
			const validationType = type ? VALIDATION_TYPES.has(type) : false;
			const unsupportedCode = code ? UNSUPPORTED_FIELD_CODES.has(code) : false;
			if (!validationType) return false;
			if (parameter === field) return unsupportedCode || numericCode;
			const recordMessage = stringField(record, ["message", "detail"]);
			return (
				!parameter &&
				!code &&
				!numericCode &&
				Boolean(recordMessage && knownFieldFromMessage(recordMessage, field))
			);
		}),
	);
}

export interface RequestParameterOptions {
	api: string;
	toggles: ModelParameterToggles;
	/** Already-derived session digest; undefined disables key/affinity injection. */
	cacheKey?: string;
	/** Cache fields remembered as rejected for this target/API. */
	unsupported: ReadonlySet<CacheField>;
	/** Mapped reasoning value; undefined leaves payload reasoning untouched. */
	reasoningEffort?: string;
}

/** Apply the passive parameter toggles to an OpenAI-compatible request payload. */
export function applyRequestParameters(
	payload: unknown,
	options: RequestParameterOptions,
): void {
	if (!isOpenAIRequestApi(options.api) || !isRecord(payload)) return;
	if (options.toggles.promptCacheKey) {
		if (options.unsupported.has("prompt_cache_key"))
			Reflect.deleteProperty(payload, "prompt_cache_key");
		else if (options.cacheKey) payload.prompt_cache_key = options.cacheKey;
	}
	if (options.toggles.promptCacheRetention) {
		if (options.unsupported.has("prompt_cache_retention"))
			Reflect.deleteProperty(payload, "prompt_cache_retention");
		else payload.prompt_cache_retention = "24h";
	}
	if (!options.toggles.reasoningEffort) return;
	if (options.reasoningEffort === undefined) return;
	if (options.api === "openai-completions") {
		payload.reasoning_effort = options.reasoningEffort;
		return;
	}
	const reasoning = isRecord(payload.reasoning) ? { ...payload.reasoning } : {};
	reasoning.effort = options.reasoningEffort;
	payload.reasoning = reasoning;
}

export interface SessionAffinityOptions {
	toggles: Pick<ModelParameterToggles, "sessionAffinity">;
	cacheKey?: string;
}

/** Rewrite session-affinity headers in place, preserving original spelling/case. */
export function replaceSessionAffinityHeaders(
	headers: Record<string, string | null>,
	options: SessionAffinityOptions,
): void {
	if (!options.toggles.sessionAffinity) return;
	if (!options.cacheKey) return;
	for (const name of Object.keys(headers)) {
		if (SESSION_AFFINITY_HEADERS.has(name.toLowerCase()))
			headers[name] = options.cacheKey;
	}
}
