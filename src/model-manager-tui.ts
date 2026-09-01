import type { ModelManagerCatalogSnapshot } from "./model-manager-catalog.ts";
import type { CatalogImpact } from "./model-manager-impact.ts";
import { parseEnvironmentKeys, parseRawKeys } from "./model-manager-input.ts";
import type { ModelManagerDraft } from "./model-manager-operations.ts";
import type { TransactionResult } from "./model-manager-store.ts";
import type {
	ModelManagerBlockedState,
	ModelManagerRecord,
} from "./model-manager-types.ts";

export type ManagerTab = "model-manager" | "failover-chains" | "history";

export const TAB_ORDER: readonly ManagerTab[] = [
	"model-manager",
	"failover-chains",
	"history",
];

export interface FailoverSummary {
	chainCount: number;
	entries: Array<{ chainId: string; model: string }>;
}

export interface SafeTransactionConflict {
	path: string;
	expectRevision: string;
	actualRevision: string;
}

export type SafeTransactionResult =
	| { ok: true; committedCount: number }
	| {
			ok: false;
			phase: "prepare" | "commit";
			status: "conflict";
			conflicts: SafeTransactionConflict[];
	  };

export interface TuiState {
	tab: ManagerTab;
	snapshot: ModelManagerCatalogSnapshot | null;
	blocked: ModelManagerBlockedState | null;
	conflict: SafeTransactionResult | null;
	message: string | null;
	pendingDraft: ModelManagerDraft | null;
	pendingImpact: CatalogImpact | null;
	failoverSummary: FailoverSummary | null;
	history: string[];
}

export type TuiAction =
	| { type: "switch-tab"; tab: ManagerTab }
	| { type: "select-record"; recordId: string }
	| { type: "raw-input-submit"; text: string }
	| { type: "environment-submit"; names: readonly string[] }
	| { type: "request-delete"; recordId: string }
	| { type: "confirm-cascade"; ack: boolean }
	| { type: "commit-draft" }
	| { type: "cancel-draft" }
	| { type: "transaction-result"; result: TransactionResult };

const TAB_LABELS: Record<ManagerTab, string> = {
	"model-manager": "Model Manager",
	"failover-chains": "Failover Chains",
	history: "History",
};

const BLOCKED_REASONS: readonly string[] = [
	"missing",
	"malformed",
	"invalid",
	"future",
	"unreadable",
];
const REDACTED_MESSAGE = "[redacted]";
const SAFE_IDENTITY = /^[A-Za-z0-9._:/@ -]+$/;
const SAFE_DISPLAY = /^[A-Za-z0-9][A-Za-z0-9 ._:/@(),'!?-]*$/;
const SAFE_JSON_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/i;
const SAFE_REVISION = /^[a-f0-9]{16,64}$/i;
const SECRET_FIELD_NAME = /(?:secret|api[_-]?key|token|password|bearer|credential|authorization|private[_-]?key)/i;
const MAX_SAFE_COUNT = 100_000;

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function safeBoundedText(value: unknown, pattern: RegExp): string {
	return typeof value === "string" && value.length > 0 && value.length <= 128 && pattern.test(value)
		? value
		: REDACTED_MESSAGE;
}

function safeDisplay(value: unknown): string {
	return safeBoundedText(value, SAFE_DISPLAY);
}

function safeIdentity(value: unknown): string {
	return safeBoundedText(value, SAFE_IDENTITY);
}

function safePath(value: unknown): string {
	if (typeof value !== "string") return REDACTED_MESSAGE;
	const basename = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
	return basename.length <= 128 && SAFE_JSON_BASENAME.test(basename)
		? basename
		: REDACTED_MESSAGE;
}

function safeRevision(value: unknown): string {
	return typeof value === "string" && SAFE_REVISION.test(value)
		? value
		: REDACTED_MESSAGE;
}

function safeCount(value: unknown): string {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SAFE_COUNT
		? String(value)
		: REDACTED_MESSAGE;
}

function safeMessage(value: unknown): string {
	if (typeof value !== "string") return REDACTED_MESSAGE;
	const staticMessages = new Set([
		"Transaction committed",
		"Submitting draft",
		"No draft to submit",
		"Record selected",
		"Delete requested; impact analysis pending",
		"Cascade confirmation declined",
		"Cascade confirmation ignored; draft and impact required",
		"commit-draft: ready after cascade confirmation",
		"已取消，未写入",
	]);
	if (staticMessages.has(value)) return value;
	const match = /^(Raw|Environment) input accepted \((\d{1,6}) key\(s\)\)$/.exec(value);
	if (match && Number(match[2]) <= MAX_SAFE_COUNT) return value;
	if (/^(Raw|Environment) input rejected: invalid batch; sensitive values omitted$/.test(value)) {
		return value;
	}
	if (/^Transaction (prepare|commit) failed$/.test(value)) return value;
	return REDACTED_MESSAGE;
}

function safeHistoryEntry(value: unknown): string {
	if (
		value === "Transaction committed" ||
		(typeof value === "string" && /^Transaction (prepare|commit) failed$/.test(value))
	) {
		return safeMessage(value);
	}
	const message = safeMessage(value);
	return /^(Raw|Environment) input /.test(message) ? message : REDACTED_MESSAGE;
}

type SanitizedDraftValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| SanitizedDraftValue[]
	| { [key: string]: SanitizedDraftValue };

function sanitizeAdvancedValue(
	value: unknown,
	seen = new WeakSet<object>(),
): SanitizedDraftValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === undefined
	) {
		return value;
	}
	if (typeof value !== "object" || seen.has(value)) return undefined;
	seen.add(value);
	if (Array.isArray(value)) {
		const sanitized = value.map((item) => sanitizeAdvancedValue(item, seen));
		seen.delete(value);
		return sanitized;
	}
	const sanitized: { [key: string]: SanitizedDraftValue } = {};
	for (const [key, item] of Object.entries(value)) {
		if (SECRET_FIELD_NAME.test(key)) continue;
		const next = sanitizeAdvancedValue(item, seen);
		if (next !== undefined) sanitized[key] = next;
	}
	seen.delete(value);
	return sanitized;
}

export function sanitizeDraftForState(
	draft: ModelManagerDraft | null,
): ModelManagerDraft | null {
	if (!draft) return null;
	const fields: ModelManagerDraft["fields"] = {
		providerAlias: draft.fields.providerAlias,
		providerName: draft.fields.providerName,
		modelId: draft.fields.modelId,
	};
	if (draft.fields.label !== undefined) fields.label = draft.fields.label;
	if (draft.fields.remoteGroup !== undefined) fields.remoteGroup = draft.fields.remoteGroup;
	if (draft.fields.groupOwner !== undefined) fields.groupOwner = draft.fields.groupOwner;
	if (draft.fields.multiplier !== undefined) fields.multiplier = draft.fields.multiplier;
	const advanced = sanitizeAdvancedValue(draft.advanced);
	const sanitized: ModelManagerDraft = {
		kind: draft.kind,
		fields,
		advanced: advanced && typeof advanced === "object" && !Array.isArray(advanced)
			? advanced as Record<string, unknown>
			: {},
	};
	if (draft.recordId !== undefined) sanitized.recordId = draft.recordId;
	return sanitized;
}

function renderTabs(active: ManagerTab): string {
	return TAB_ORDER
		.map((tab) => `${tab === active ? ">" : " "} ${TAB_LABELS[tab]}`)
		.join(" | ");
}

function renderMessage(state: TuiState, lines: string[]): void {
	if (state.message) lines.push(`Message: ${safeMessage(state.message)}`);
}

function renderTransactionResult(
	result: SafeTransactionResult,
	lines: string[],
): void {
	if (result.ok) {
		lines.push(`Transaction committed: ${safeCount(result.committedCount)} file(s)`);
		return;
	}

	const phase = result.phase === "commit" ? "commit" : "prepare";
	lines.push(`Transaction failed during ${phase}`);
	lines.push("Status: conflict");
	if (!Array.isArray(result.conflicts)) return;
	for (const [index, conflict] of result.conflicts.entries()) {
		lines.push(
			`Conflict ${index + 1} ${safePath(conflict?.path)} expect=${safeRevision(conflict?.expectRevision)} actual=${safeRevision(conflict?.actualRevision)}`,
		);
	}
}

function renderBlocked(
	blocked: ModelManagerBlockedState,
	lines: string[],
): void {
	const reason = BLOCKED_REASONS.includes(blocked.reason) ? blocked.reason : "unknown";
	lines.push(`Catalog blocked: ${reason}`);
	lines.push("Details withheld to protect sensitive input.");
	lines.push("原始字节已保留 / raw bytes preserved");
}

export function renderManagerScreen(state: TuiState): string {
	const lines = [renderTabs(state.tab), "Model Manager"];
	if (state.snapshot) {
		for (const group of groupRecordsForDisplay(state.snapshot.records)) {
			lines.push(`Group: ${safeIdentity(group.title)}`);
			for (const record of group.items) {
				const label = record.label ?? record.modelId;
				lines.push(
					`- ${safeDisplay(label)} (${safeIdentity(record.id)}) ${safeIdentity(record.providerAlias)}`,
				);
			}
		}
	} else {
		lines.push("No catalog snapshot");
	}
	if (state.blocked) renderBlocked(state.blocked, lines);
	if (state.conflict) renderTransactionResult(state.conflict, lines);
	renderMessage(state, lines);
	return lines.join("\n");
}

export function renderFailoverScreen(state: TuiState): string {
	const lines = [renderTabs(state.tab), "Failover Chains"];
	const summary = state.failoverSummary;
	if (summary) {
		lines.push(`Chains: ${safeCount(summary.chainCount)} chain(s)`);
		if (Array.isArray(summary.entries)) for (const entry of summary.entries) {
			lines.push(
				`- ${safeIdentity(entry?.chainId)}: ${safeIdentity(entry?.model)}`,
			);
		}
	} else {
		lines.push("No failover summary");
	}
	renderMessage(state, lines);
	return lines.join("\n");
}

export function renderHistoryScreen(state: TuiState): string {
	const lines = [renderTabs(state.tab), "History"];
	if (state.history.length === 0) {
		lines.push("No history");
	} else {
		for (const [index, entry] of state.history.slice().reverse().entries()) {
			lines.push(`${index + 1}. ${safeHistoryEntry(entry)}`);
		}
	}
	renderMessage(state, lines);
	return lines.join("\n");
}

export function groupRecordsForDisplay(
	records: readonly ModelManagerRecord[],
): Array<{ title: string; items: ModelManagerRecord[] }> {
	const groups = new Map<string, ModelManagerRecord[]>();
	for (const record of records) {
		const title = record.remoteGroup ?? record.providerAlias;
		const items = groups.get(title);
		if (items) items.push(record);
		else groups.set(title, [record]);
	}

	return [...groups.entries()]
		.sort(([left], [right]) => compareText(left, right))
		.map(([title, items]) => ({
			title,
			items: items
				.map((record, index) => ({ record, index }))
				.sort((left, right) =>
					compareText(
						left.record.label ?? left.record.modelId,
						right.record.label ?? right.record.modelId,
					) || compareText(left.record.id, right.record.id) || left.index - right.index,
				)
				.map(({ record }) => record),
		}));
}

function parserMessage(
	kind: "Raw input" | "Environment input",
	accepted: boolean,
	count: number,
): string {
	return accepted
		? `${kind} accepted (${count} key(s))`
		: `${kind} rejected: invalid batch; sensitive values omitted`;
}

function exhaustive(action: never): never {
	throw new Error(`Unhandled TUI action: ${String(action)}`);
}

export function applyTuiAction(state: TuiState, action: TuiAction): TuiState {
	const current: TuiState = {
		...state,
		pendingDraft: sanitizeDraftForState(state.pendingDraft),
	};
	switch (action.type) {
		case "switch-tab":
			return TAB_ORDER.includes(action.tab) ? { ...current, tab: action.tab } : current;
		case "select-record":
			return { ...current, message: "Record selected" };
		case "raw-input-submit": {
			const result = parseRawKeys(action.text);
			return {
				...current,
				message: parserMessage("Raw input", result.accepted, result.entries.length),
			};
		}
		case "environment-submit": {
			const result = parseEnvironmentKeys(action.names, {});
			return {
				...current,
				message: parserMessage("Environment input", result.accepted, result.entries.length),
			};
		}
		case "request-delete":
			return {
				...current,
				pendingImpact: null,
				message: "Delete requested; impact analysis pending",
			};
		case "confirm-cascade":
			return {
				...current,
				message: !action.ack
					? "Cascade confirmation declined"
					: current.pendingDraft && current.pendingImpact
						? "commit-draft: ready after cascade confirmation"
						: "Cascade confirmation ignored; draft and impact required",
			};
		case "commit-draft":
			return {
				...current,
				message: current.pendingDraft ? "Submitting draft" : "No draft to submit",
			};
		case "cancel-draft":
			return {
				...current,
				pendingDraft: null,
				pendingImpact: null,
				message: "已取消，未写入",
			};
		case "transaction-result": {
			if (action.result.ok) {
				return {
					...current,
					conflict: null,
					pendingDraft: null,
					pendingImpact: null,
					message: "Transaction committed",
				};
			}
			const conflict: SafeTransactionResult = {
				ok: false,
				phase: action.result.phase === "commit" ? "commit" : "prepare",
				status: "conflict",
				conflicts: Array.isArray(action.result.conflicts)
					? action.result.conflicts.map((entry) => ({
							path: safePath(entry.path),
							expectRevision: safeRevision(entry.expectRevision),
							actualRevision: safeRevision(entry.actualRevision),
						  }))
					: [],
			};
			return {
				...current,
				conflict,
				message: `Transaction ${conflict.phase} failed`,
			};
		}
		default:
			return exhaustive(action);
	}
}
