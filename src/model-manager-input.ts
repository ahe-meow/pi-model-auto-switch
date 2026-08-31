import { createHash } from "node:crypto";
import { createProviderAlias } from "./model-manager-types.ts";

export interface RawKeyEntry {
	normalized: string;
	fingerprint: string;
	aliasHint: string;
}

export interface RawKeyRejection {
	line: number;
	reason: string;
}

export interface RawKeyBatchResult {
	entries: RawKeyEntry[];
	rejected: RawKeyRejection[];
	accepted: boolean;
}

export function normalizeKey(raw: string): string {
	let normalized = raw.trim();
	const first = normalized[0];
	const last = normalized.at(-1);
	if (
		normalized.length >= 2 &&
		((first === "'" && last === "'") || (first === '"' && last === '"'))
	) {
		normalized = normalized.slice(1, -1).trim();
	}
	return normalized;
}

function describeLine(line: number, rule: string): string {
	return `line ${line}: ${rule}`;
}

function fingerprint(normalized: string): string {
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function entryFor(normalized: string): RawKeyEntry {
	const keyFingerprint = fingerprint(normalized);
	return {
		normalized,
		fingerprint: keyFingerprint,
		aliasHint: createProviderAlias("pending", keyFingerprint),
	};
}

interface InputLine {
	line: number;
	raw: string;
}

function rejectionFor(line: InputLine, seen: ReadonlySet<string>): RawKeyRejection | undefined {
	const normalized = normalizeKey(line.raw);
	if (normalized.length === 0) return { line: line.line, reason: describeLine(line.line, "blank") };
	if (/[\x00-\x1f\x7f]/.test(normalized)) {
		return { line: line.line, reason: describeLine(line.line, "control character") };
	}
	if (normalized.startsWith("!")) {
		return { line: line.line, reason: describeLine(line.line, "command") };
	}
	if (/[^\x20-\x7e]/.test(normalized)) {
		return { line: line.line, reason: describeLine(line.line, "non-printable character") };
	}
	if (seen.has(normalized)) {
		return { line: line.line, reason: describeLine(line.line, "duplicate") };
	}
	return undefined;
}

function parseLines(lines: readonly InputLine[]): RawKeyBatchResult {
	const entries: RawKeyEntry[] = [];
	const rejected: RawKeyRejection[] = [];
	const seen = new Set<string>();

	for (const line of lines) {
		const normalized = normalizeKey(line.raw);
		const rejection = rejectionFor(line, seen);
		if (rejection) {
			rejected.push(rejection);
			continue;
		}
		seen.add(normalized);
		entries.push(entryFor(normalized));
	}

	return {
		entries: rejected.length === 0 ? entries : [],
		rejected,
		accepted: rejected.length === 0,
	};
}

function splitLines(text: string): string[] {
	if (text.length === 0) return [""];
	const lines = text.split(/\r?\n/);
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
}

export function parseRawKeys(text: string): RawKeyBatchResult {
	return parseLines(splitLines(text).map((raw, index) => ({ line: index + 1, raw })));
}

export function parseEnvironmentKeys(
	names: readonly string[],
	env: Record<string, string | undefined>,
): RawKeyBatchResult {
	const missingOrBlank: RawKeyRejection[] = [];
	const lines: InputLine[] = [];

	for (const [index, name] of names.entries()) {
		const line = index + 1;
		const value = env[name];
		if (value === undefined) {
			missingOrBlank.push({
				line,
				reason: describeLine(line, "missing environment variable"),
			});
			continue;
		}
		if (normalizeKey(value).length === 0) {
			missingOrBlank.push({
				line,
				reason: describeLine(line, "blank environment variable"),
			});
			continue;
		}
		lines.push({ line, raw: value });
	}

	const parsed = parseLines(lines);
	const rejected = [...missingOrBlank, ...parsed.rejected].sort((a, b) => a.line - b.line);
	return {
		entries: rejected.length === 0 ? parsed.entries : [],
		rejected,
		accepted: rejected.length === 0,
	};
}
