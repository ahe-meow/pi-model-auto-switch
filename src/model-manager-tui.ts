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
			status: "failed";
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
const SENSITIVE_MARKER = /(?:secret|api[_-]?key|access[_-]?token|password|bearer|sk-[a-z0-9])/i;
const SAFE_ID = /^[a-z][a-z0-9]*(?:[-_./][a-z0-9]+)*$/i;
const SAFE_PATH = /^(?:[a-z0-9._-]+\/)*[a-z0-9._-]+$/i;
const SAFE_REVISION = /^(?:missing|expected-\d+|actual-\d+|[a-f0-9]{8,64})$/i;

type SafeTextKind = "display" | "id" | "model" | "path" | "revision";

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function knownSecrets(state: TuiState): readonly string[] {
	const secret = state.pendingDraft?.secret;
	return typeof secret === "string" && secret.length > 0 ? [secret] : [];
}

function looksLikeOpaqueValue(value: string, _kind: SafeTextKind): boolean {
	const chunks = value.split(/[-_./]/).filter(Boolean);
	const longChunks = chunks.filter((chunk) => chunk.length >= 4).length;
	return (
		(value.length >= 16 && /[a-z]/i.test(value) && /\d/.test(value)) ||
		(!(_kind === "model" && value.includes("/")) &&
			value.length >= 18 && chunks.length >= 3 && longChunks >= 2)
	);
}

function safeText(
	value: unknown,
	secrets: readonly string[] = [],
	kind: SafeTextKind = "display",
): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 128) {
		return REDACTED_MESSAGE;
	}
	if (secrets.some((secret) => secret.length > 0 && value.includes(secret))) {
		return REDACTED_MESSAGE;
	}
	if (SENSITIVE_MARKER.test(value) || looksLikeOpaqueValue(value, kind)) {
		return REDACTED_MESSAGE;
	}
	const pattern =
		kind === "id" || kind === "model"
			? SAFE_ID
			: kind === "path"
				? SAFE_PATH
				: kind === "revision"
					? SAFE_REVISION
					: /^[A-Za-z0-9][A-Za-z0-9 ._:/(),'!?-]*$/;
	return pattern.test(value) ? value : REDACTED_MESSAGE;
}

function safeMessage(value: unknown, secrets: readonly string[]): string {
	if (typeof value !== "string") return REDACTED_MESSAGE;
	const staticMessages = new Set([
		"Transaction committed",
		"Submitting draft",
		"Cascade confirmation declined",
		"Cascade confirmed; no draft to commit",
		"commit-draft: ready after cascade confirmation",
		"已取消，未写入",
	]);
	if (staticMessages.has(value)) return value;
	let match = /^(Selected record): (.+)$/.exec(value);
	if (match) return `${match[1]}: ${safeText(match[2], secrets, "id")}`;
	match = /^(Delete requested for) (.+)(; impact analysis pending)$/.exec(value);
	if (match) {
		return `${match[1]} ${safeText(match[2], secrets, "id")}${match[3]}`;
	}
	if (/^(Raw|Environment) input accepted \(\d+ key\(s\)\)$/.test(value)) {
		return value;
	}
	if (/^(Raw|Environment) input rejected: invalid batch; sensitive values omitted$/.test(value)) {
		return value;
	}
	if (/^Transaction (prepare|commit) failed$/.test(value)) return value;
	return REDACTED_MESSAGE;
}

function renderTabs(active: ManagerTab): string {
	return TAB_ORDER
		.map((tab) => `${tab === active ? ">" : " "} ${TAB_LABELS[tab]}`)
		.join(" | ");
}

function renderMessage(state: TuiState, lines: string[]): void {
	if (state.message) lines.push(`Message: ${safeMessage(state.message, knownSecrets(state))}`);
}

function renderTransactionResult(
	result: SafeTransactionResult,
	lines: string[],
	secrets: readonly string[],
): void {
	if (result.ok) {
		const count = Number.isSafeInteger(result.committedCount) && result.committedCount >= 0
			? result.committedCount
			: 0;
		lines.push(`Transaction committed: ${count} file(s)`);
		return;
	}

	const phase = result.phase === "commit" ? "commit" : "prepare";
	lines.push(`Transaction failed during ${phase}`);
	lines.push("Status: failed");
	if (!Array.isArray(result.conflicts)) return;
	for (const [index, conflict] of result.conflicts.entries()) {
		lines.push(
			`Conflict ${index + 1} ${safeText(conflict?.path, secrets, "path")} expect=${safeText(conflict?.expectRevision, secrets, "revision")} actual=${safeText(conflict?.actualRevision, secrets, "revision")}`,
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
	const secrets = knownSecrets(state);
	if (state.snapshot) {
		for (const group of groupRecordsForDisplay(state.snapshot.records)) {
			lines.push(`Group: ${safeText(group.title, secrets, "id")}`);
			for (const record of group.items) {
				const label = record.label ?? record.modelId;
				lines.push(
					`- ${safeText(label, secrets)} (${safeText(record.id, secrets, "id")}) ${safeText(record.providerAlias, secrets, "id")}`,
				);
			}
		}
	} else {
		lines.push("No catalog snapshot");
	}
	if (state.blocked) renderBlocked(state.blocked, lines);
	if (state.conflict) renderTransactionResult(state.conflict, lines, secrets);
	renderMessage(state, lines);
	return lines.join("\n");
}

export function renderFailoverScreen(state: TuiState): string {
	const lines = [renderTabs(state.tab), "Failover Chains"];
	const summary = state.failoverSummary;
	if (summary) {
		lines.push(`Chains: ${summary.chainCount} chain(s)`);
		const secrets = knownSecrets(state);
		if (Array.isArray(summary.entries)) for (const entry of summary.entries) {
			lines.push(
				`- ${safeText(entry?.chainId, secrets, "id")}: ${safeText(entry?.model, secrets, "model")}`,
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
	const secrets = knownSecrets(state);
	if (state.history.length === 0) {
		lines.push("No history");
	} else {
		for (const [index, entry] of state.history.slice().reverse().entries()) {
			lines.push(`${index + 1}. ${safeText(entry, secrets)}`);
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
	switch (action.type) {
		case "switch-tab":
			return TAB_ORDER.includes(action.tab) ? { ...state, tab: action.tab } : state;
		case "select-record":
			return { ...state, message: `Selected record: ${safeText(action.recordId)}` };
		case "raw-input-submit": {
			const result = parseRawKeys(action.text);
			return {
				...state,
				message: parserMessage("Raw input", result.accepted, result.entries.length),
			};
		}
		case "environment-submit": {
			const result = parseEnvironmentKeys(action.names, process.env);
			return {
				...state,
				message: parserMessage("Environment input", result.accepted, result.entries.length),
			};
		}
		case "request-delete":
			return {
				...state,
				pendingImpact: null,
				message: `Delete requested for ${safeText(action.recordId)}; impact analysis pending`,
			};
		case "confirm-cascade":
			return {
				...state,
				message: action.ack
					? state.pendingDraft
						? "commit-draft: ready after cascade confirmation"
						: "Cascade confirmed; no draft to commit"
					: "Cascade confirmation declined",
			};
		case "commit-draft":
			return { ...state, message: "Submitting draft" };
		case "cancel-draft":
			return {
				...state,
				pendingDraft: null,
				pendingImpact: null,
				message: "已取消，未写入",
			};
		case "transaction-result": {
			const conflict: SafeTransactionResult = action.result.ok
				? {
						ok: true,
						committedCount: Array.isArray(action.result.committed)
							? action.result.committed.length
							: 0,
				  }
				: {
						ok: false,
						phase: action.result.phase === "commit" ? "commit" : "prepare",
						status: "failed",
						conflicts: Array.isArray(action.result.conflicts)
							? action.result.conflicts.map((entry) => ({
									path: safeText(entry.path, [], "path"),
									expectRevision: safeText(entry.expectRevision, [], "revision"),
									actualRevision: safeText(entry.actualRevision, [], "revision"),
								  }))
							: [],
				  };
			return {
				...state,
				conflict,
				message: conflict.ok ? "Transaction committed" : `Transaction ${conflict.phase} failed`,
			};
		}
		default:
			return exhaustive(action);
	}
}
