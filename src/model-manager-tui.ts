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

export const TAB_ORDER: readonly ManagerTab[] = Object.freeze([
	"model-manager",
	"failover-chains",
	"history",
]);

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
			status: "conflict" | "failed";
			conflicts: SafeTransactionConflict[];
	  };

export type SafeTuiDraft = Omit<ModelManagerDraft, "secret">;

export interface TuiState {
	tab: ManagerTab;
	snapshot: ModelManagerCatalogSnapshot | null;
	blocked: ModelManagerBlockedState | null;
	conflict: SafeTransactionResult | null;
	message: string | null;
	pendingDraft: SafeTuiDraft | null;
	pendingImpact: CatalogImpact | null;
	failoverSummary: FailoverSummary | null;
	history: string[];
}

export type TuiAction =
	| { type: "switch-tab"; tab: ManagerTab }
	| { type: "select-record"; recordId: string }
	| { type: "raw-input-submit"; text: string }
	| {
			type: "environment-submit";
			names: readonly string[];
		env?: Readonly<Record<string, string | undefined>>;
	  }
	| { type: "request-delete"; recordId: string }
	| { type: "confirm-cascade"; ack: boolean }
	| { type: "commit-draft" }
	| { type: "cancel-draft" }
	| { type: "transaction-result"; result: TransactionResult };

const TAB_LABELS: Readonly<Record<ManagerTab, string>> = Object.freeze({
	"model-manager": "Model Manager",
	"failover-chains": "Failover Chains",
	history: "History",
});

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
const SAFE_REVISION = /^(?:missing|[a-f0-9]{16,64})$/i;
const SECRET_FIELD_NAME =
	/(?:secret|api[_-]?key|token|password|bearer|credential|authorization|private[_-]?key)/i;
const MAX_SAFE_COUNT = 100_000;

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function containsKnownSecret(
	value: string,
	secrets: readonly string[],
): boolean {
	return secrets.some(
		(secret) => secret.length > 0 && value.includes(secret),
	);
}

function safeBoundedText(
	value: unknown,
	pattern: RegExp,
	secrets: readonly string[] = [],
): string {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= 128 &&
		!containsKnownSecret(value, secrets) &&
		pattern.test(value)
		? value
		: REDACTED_MESSAGE;
}

function safeDisplay(value: unknown, secrets: readonly string[] = []): string {
	return safeBoundedText(value, SAFE_DISPLAY, secrets);
}

function safeIdentity(value: unknown, secrets: readonly string[] = []): string {
	return safeBoundedText(value, SAFE_IDENTITY, secrets);
}

function safePath(value: unknown, secrets: readonly string[] = []): string {
	if (typeof value !== "string") return REDACTED_MESSAGE;
	const basename = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
	return basename.length <= 128 &&
		!containsKnownSecret(basename, secrets) &&
		SAFE_JSON_BASENAME.test(basename)
		? basename
		: REDACTED_MESSAGE;
}

function safeRevision(
	value: unknown,
	secrets: readonly string[] = [],
): string {
	return typeof value === "string" &&
		!containsKnownSecret(value, secrets) &&
		SAFE_REVISION.test(value)
		? value
		: REDACTED_MESSAGE;
}

function safeCount(value: unknown): string {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= MAX_SAFE_COUNT
		? String(value)
		: REDACTED_MESSAGE;
}

function safeMessage(
	value: unknown,
	secrets: readonly string[] = [],
): string {
	if (typeof value !== "string" || containsKnownSecret(value, secrets)) {
		return REDACTED_MESSAGE;
	}
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
	const match = /^(Raw|Environment) input accepted \((\d{1,6}) key\(s\)\)$/.exec(
		value,
	);
	if (match && Number(match[2]) <= MAX_SAFE_COUNT) return value;
	if (
		/^(Raw|Environment) input rejected: invalid batch; sensitive values omitted$/.test(
			value,
		)
	) {
		return value;
	}
	if (/^Transaction (prepare|commit) failed$/.test(value)) return value;
	return REDACTED_MESSAGE;
}

function safeHistoryEntry(
	value: unknown,
	secrets: readonly string[] = [],
): string {
	if (
		value === "Transaction committed" ||
		(typeof value === "string" &&
			/^Transaction (prepare|commit) failed$/.test(value))
	) {
		return safeMessage(value, secrets);
	}
	const message = safeMessage(value, secrets);
	return /^(Raw|Environment) input /.test(message)
		? message
		: REDACTED_MESSAGE;
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
	secrets: readonly string[],
	seen = new WeakSet<object>(),
): SanitizedDraftValue {
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return containsKnownSecret(value, secrets) ? REDACTED_MESSAGE : value;
	}
	if (value === undefined) return value;
	if (typeof value !== "object" || seen.has(value)) return undefined;
	seen.add(value);
	if (Array.isArray(value)) {
		const sanitized = value.map((item) =>
			sanitizeAdvancedValue(item, secrets, seen),
		);
		seen.delete(value);
		return sanitized;
	}
	const sanitized: { [key: string]: SanitizedDraftValue } = {};
	for (const [key, item] of Object.entries(value)) {
		if (SECRET_FIELD_NAME.test(key)) continue;
		const next = sanitizeAdvancedValue(item, secrets, seen);
		if (next !== undefined) sanitized[key] = next;
	}
	seen.delete(value);
	return sanitized;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDraftText(value: unknown, secrets: readonly string[]): string {
	return typeof value === "string" && !containsKnownSecret(value, secrets)
		? value
		: REDACTED_MESSAGE;
}

function knownDraftSecrets(state: TuiState): readonly string[] {
	const secret = (state.pendingDraft as SafeTuiDraft & { secret?: unknown })
		?.secret;
	return typeof secret === "string" && secret.length > 0 ? [secret] : [];
}

export function sanitizeDraftForState(
	draft: ModelManagerDraft | null,
): SafeTuiDraft | null {
	if (!draft) return null;
	const secrets =
		typeof draft.secret === "string" && draft.secret.length > 0
			? [draft.secret]
			: [];
	const draftFields: Record<string, unknown> = isObjectRecord(draft.fields)
		? draft.fields
		: {};
	const fields: ModelManagerDraft["fields"] = {
		providerAlias: safeDraftText(draftFields.providerAlias, secrets),
		providerName: safeDraftText(draftFields.providerName, secrets),
		modelId: safeDraftText(draftFields.modelId, secrets),
	};
	for (const key of ["label", "remoteGroup"] as const) {
		const value = draftFields[key];
		if (value !== undefined) fields[key] = safeDraftText(value, secrets);
	}
	if (typeof draftFields.groupOwner === "boolean") {
		fields.groupOwner = draftFields.groupOwner;
	}
	if (typeof draftFields.multiplier === "number") {
		fields.multiplier = draftFields.multiplier;
	}
	const advanced = sanitizeAdvancedValue(draft.advanced, secrets);
	const sanitized: ModelManagerDraft = {
		kind:
			draft.kind === "edit" || draft.kind === "clone" ? draft.kind : "create",
		fields,
		advanced:
			advanced && typeof advanced === "object" && !Array.isArray(advanced)
				? (advanced as Record<string, unknown>)
				: {},
	};
	if (typeof draft.recordId === "string") {
		sanitized.recordId = safeDraftText(draft.recordId, secrets);
	}
	return sanitized;
}

function sanitizeSnapshotForState(
	snapshot: ModelManagerCatalogSnapshot | null,
	secrets: readonly string[],
): ModelManagerCatalogSnapshot | null {
	if (!snapshot) return null;
	const records: ModelManagerRecord[] = [];
	if (Array.isArray(snapshot.records)) {
		for (const record of snapshot.records) {
			const sanitized = sanitizeAdvancedValue(record, secrets);
			if (isObjectRecord(sanitized)) {
				records.push(sanitized as ModelManagerRecord);
			}
		}
	}
	const providers: ModelManagerCatalogSnapshot["providers"] = [];
	if (Array.isArray(snapshot.providers)) {
		for (const provider of snapshot.providers) {
			const sanitized = sanitizeAdvancedValue(provider, secrets);
			if (isObjectRecord(sanitized)) {
				providers.push({ ...sanitized, apiKey: "" } as (typeof providers)[number]);
			}
		}
	}
	return {
		records,
		byId: new Map(records.map((record) => [record.id, record])),
		providers,
		failoverUntouched: true,
	};
}

function sanitizeBlockedForState(
	blocked: ModelManagerBlockedState | null,
	secrets: readonly string[],
): ModelManagerBlockedState | null {
	if (!blocked) return null;
	const sanitized: ModelManagerBlockedState = {
		reason: BLOCKED_REASONS.includes(blocked.reason) ? blocked.reason : "unreadable",
		message: REDACTED_MESSAGE,
	};
	if (blocked.rawBytes instanceof Uint8Array) sanitized.rawBytes = blocked.rawBytes;
	if (blocked.compatibilityImport) {
		sanitized.compatibilityImport = {
			available: blocked.compatibilityImport.available === true,
			sourcePaths: Array.isArray(blocked.compatibilityImport.sourcePaths)
				? blocked.compatibilityImport.sourcePaths.map((path) => safePath(path, secrets))
				: [],
		};
	}
	return sanitized;
}

function sanitizeFailoverSummary(
	summary: FailoverSummary | null,
	secrets: readonly string[],
): FailoverSummary | null {
	if (!summary) return null;
	return {
		chainCount:
			typeof summary.chainCount === "number" && Number.isFinite(summary.chainCount)
				? summary.chainCount
				: 0,
		entries: Array.isArray(summary.entries)
			? summary.entries.map((entry) => ({
					chainId: safeDraftText(entry?.chainId, secrets),
					model: safeDraftText(entry?.model, secrets),
				}))
			: [],
	};
}

function sanitizeImpactForState(
	impact: CatalogImpact | null,
	secrets: readonly string[],
): CatalogImpact | null {
	if (!isObjectRecord(impact)) return null;
	const chains: CatalogImpact["chains"] = [];
	if (Array.isArray(impact.chains)) {
		for (const entry of impact.chains) {
			if (!isObjectRecord(entry)) continue;
			const kind =
				entry.kind === "model-entry" || entry.kind === "generated-block"
					? entry.kind
					: null;
			if (!kind) continue;
			chains.push({
				file: safePath(entry.file, secrets),
				chainId: safeIdentity(entry.chainId, secrets),
				kind,
			});
		}
	}
	const stateReferences: CatalogImpact["state"] = [];
	if (Array.isArray(impact.state)) {
		for (const entry of impact.state) {
			if (!isObjectRecord(entry)) continue;
			stateReferences.push({
				file: safePath(entry.file, secrets),
				key: safeIdentity(entry.key, secrets),
			});
		}
	}
	return {
		recordId: safeIdentity(impact.recordId, secrets),
		chains,
		state: stateReferences,
		referenced: impact.referenced === true,
	};
}

function boundedCount(value: unknown): number {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0
		? value
		: 0;
}

function sanitizeTransactionResult(
	result: unknown,
	secrets: readonly string[],
): SafeTransactionResult | null {
	if (!isObjectRecord(result)) return null;
	if (result.ok === true) {
		return { ok: true, committedCount: boundedCount(result.committedCount) };
	}
	const rawConflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
	const conflicts = rawConflicts.map((entry) => {
		const conflict = isObjectRecord(entry) ? entry : {};
		return {
			path: safePath(conflict.path, secrets),
			expectRevision: safeRevision(conflict.expectRevision, secrets),
			actualRevision: safeRevision(conflict.actualRevision, secrets),
		};
	});
	return {
		ok: false,
		phase: result.phase === "commit" ? "commit" : "prepare",
		status: conflicts.length > 0 ? "conflict" : "failed",
		conflicts,
	};
}

function renderTabs(active: ManagerTab): string {
	return TAB_ORDER.map(
		(tab) => `${tab === active ? ">" : " "} ${TAB_LABELS[tab]}`,
	).join(" | ");
}

function renderMessage(
	state: TuiState,
	lines: string[],
	secrets: readonly string[],
): void {
	if (state.message) lines.push(`Message: ${safeMessage(state.message, secrets)}`);
}

function renderTransactionResult(
	result: SafeTransactionResult,
	lines: string[],
	secrets: readonly string[],
): void {
	if (result.ok) {
		lines.push(
			`Transaction committed: ${safeCount(result.committedCount)} file(s)`,
		);
		return;
	}

	const phase = result.phase === "commit" ? "commit" : "prepare";
	const status = result.status === "conflict" ? "conflict" : "failed";
	lines.push(`Transaction failed during ${phase}`);
	lines.push(`Status: ${status}`);
	if (status !== "conflict" || !Array.isArray(result.conflicts)) return;
	for (const [index, conflict] of result.conflicts.entries()) {
		lines.push(
			`Conflict ${index + 1} ${safePath(conflict?.path, secrets)} expect=${safeRevision(conflict?.expectRevision, secrets)} actual=${safeRevision(conflict?.actualRevision, secrets)}`,
		);
	}
}

function renderBlocked(
	blocked: ModelManagerBlockedState,
	lines: string[],
): void {
	const reason = BLOCKED_REASONS.includes(blocked.reason)
		? blocked.reason
		: "unknown";
	lines.push(`Catalog blocked: ${reason}`);
	lines.push("Details withheld to protect sensitive input.");
	lines.push("原始字节已保留 / raw bytes preserved");
}

export function renderManagerScreen(state: TuiState): string {
	const secrets = knownDraftSecrets(state);
	const lines = [renderTabs(state.tab), "Model Manager"];
	if (state.snapshot) {
		for (const group of groupRecordsForDisplay(state.snapshot.records)) {
			lines.push(`Group: ${safeIdentity(group.title, secrets)}`);
			for (const record of group.items) {
				const label = record.label ?? record.modelId;
				lines.push(
					`- ${safeDisplay(label, secrets)} (${safeIdentity(record.id, secrets)}) ${safeIdentity(record.providerAlias, secrets)}`,
				);
			}
		}
	} else {
		lines.push("No catalog snapshot");
	}
	if (state.blocked) renderBlocked(state.blocked, lines);
	if (state.conflict) renderTransactionResult(state.conflict, lines, secrets);
	renderMessage(state, lines, secrets);
	return lines.join("\n");
}

export function renderFailoverScreen(state: TuiState): string {
	const secrets = knownDraftSecrets(state);
	const lines = [renderTabs(state.tab), "Failover Chains"];
	const summary = state.failoverSummary;
	if (summary) {
		lines.push(`Chains: ${safeCount(summary.chainCount)} chain(s)`);
		if (Array.isArray(summary.entries))
			for (const entry of summary.entries) {
				lines.push(
					`- ${safeIdentity(entry?.chainId, secrets)}: ${safeIdentity(entry?.model, secrets)}`,
				);
			}
	} else {
		lines.push("No failover summary");
	}
	renderMessage(state, lines, secrets);
	return lines.join("\n");
}

export function renderHistoryScreen(state: TuiState): string {
	const secrets = knownDraftSecrets(state);
	const lines = [renderTabs(state.tab), "History"];
	if (state.history.length === 0) {
		lines.push("No history");
	} else {
		for (const [index, entry] of state.history.slice().reverse().entries()) {
			lines.push(`${index + 1}. ${safeHistoryEntry(entry, secrets)}`);
		}
	}
	renderMessage(state, lines, secrets);
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
				.sort(
					(left, right) =>
						compareText(
							left.record.label ?? left.record.modelId,
							right.record.label ?? right.record.modelId,
						) ||
						compareText(left.record.id, right.record.id) ||
						left.index - right.index,
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
	const secrets = knownDraftSecrets(state);
	const current: TuiState = {
		tab: TAB_ORDER.includes(state.tab) ? state.tab : "model-manager",
		snapshot: sanitizeSnapshotForState(state.snapshot, secrets),
		blocked: sanitizeBlockedForState(state.blocked, secrets),
		conflict: sanitizeTransactionResult(state.conflict, secrets),
		message: state.message == null ? null : safeMessage(state.message, secrets),
		pendingDraft: sanitizeDraftForState(state.pendingDraft),
		pendingImpact: sanitizeImpactForState(state.pendingImpact, secrets),
		failoverSummary: sanitizeFailoverSummary(state.failoverSummary, secrets),
		history: Array.isArray(state.history)
			? state.history.map((entry) => safeHistoryEntry(entry, secrets))
			: [],
	};
	switch (action.type) {
		case "switch-tab":
			return TAB_ORDER.includes(action.tab)
				? { ...current, tab: action.tab }
				: current;
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
			const result = parseEnvironmentKeys(action.names, action.env ?? {});
			return {
				...current,
				message: parserMessage(
					"Environment input",
					result.accepted,
					result.entries.length,
				),
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
				message: action.ack
					? current.pendingDraft && current.pendingImpact
						? "commit-draft: ready after cascade confirmation"
						: "Cascade confirmation ignored; draft and impact required"
					: "Cascade confirmation declined",
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
					conflict: {
						ok: true,
						committedCount: Array.isArray(action.result.committed)
							? action.result.committed.length
							: 0,
					},
					pendingDraft: null,
					pendingImpact: null,
					message: "Transaction committed",
				};
			}
			const transaction = sanitizeTransactionResult(action.result, secrets);
			if (!transaction || transaction.ok) {
				return { ...current, message: "Transaction failed" };
			}
			return {
				...current,
				conflict: transaction,
				message: `Transaction ${transaction.phase} failed`,
			};
		}
		default:
			return exhaustive(action);
	}
}
