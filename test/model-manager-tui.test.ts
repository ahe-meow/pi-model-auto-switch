import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelManagerCatalogSnapshot } from "../src/model-manager-catalog.ts";
import type { CatalogImpact } from "../src/model-manager-impact.ts";
import type { ModelManagerDraft } from "../src/model-manager-operations.ts";
import {
	TAB_ORDER,
	applyTuiAction,
	groupRecordsForDisplay,
	renderFailoverScreen,
	renderHistoryScreen,
	renderManagerScreen,
	type TuiState,
} from "../src/model-manager-tui.ts";
import type { TransactionResult } from "../src/model-manager-store.ts";
import type { ModelManagerRecord } from "../src/model-manager-types.ts";

const record = (overrides: Partial<ModelManagerRecord> = {}): ModelManagerRecord => ({
	id: "record-a",
	providerAlias: "provider-a",
	providerName: "Provider A",
	modelId: "model-a",
	...overrides,
});

function snapshot(records: readonly ModelManagerRecord[] = [record()]): ModelManagerCatalogSnapshot {
	const copied = [...records];
	return {
		records: copied,
		byId: new Map(copied.map((entry) => [entry.id, entry])),
		providers: [],
		failoverUntouched: true,
	};
}

const draft: ModelManagerDraft = {
	kind: "create",
	recordId: "draft-id",
	fields: {
		providerAlias: "provider-a",
		providerName: "Provider A",
		modelId: "model-a",
	},
	advanced: {},
};

const impact: CatalogImpact = {
	recordId: "record-a",
	chains: [],
	state: [],
	referenced: false,
};

function state(overrides: Partial<TuiState> = {}): TuiState {
	return {
		tab: "model-manager",
		snapshot: snapshot(),
		blocked: null,
		conflict: null,
		message: null,
		pendingDraft: null,
		pendingImpact: null,
		failoverSummary: { chainCount: 0, entries: [] },
		history: [],
		...overrides,
	};
}

test("TAB_ORDER and manager tabs stay in the fixed order with an active marker", () => {
	assert.deepEqual([...TAB_ORDER], ["model-manager", "failover-chains", "history"]);
	const rendered = renderManagerScreen(state());
	assert.ok(rendered.indexOf("Model Manager") < rendered.indexOf("Failover Chains"));
	assert.ok(rendered.indexOf("Failover Chains") < rendered.indexOf("History"));
	assert.match(rendered, /> Model Manager/);
	assert.doesNotMatch(rendered, /> Failover Chains/);
});

test("groupRecordsForDisplay groups by remote group or provider alias and stably sorts copies", () => {
	const records = [
		record({ id: "z", providerAlias: "provider-z", modelId: "same", label: "Same" }),
		record({ id: "b", providerAlias: "provider-a", modelId: "z-model", label: "Z", remoteGroup: "shared" }),
		record({ id: "a", providerAlias: "provider-a", modelId: "a-model", label: "A", remoteGroup: "shared" }),
		record({ id: "c", providerAlias: "provider-a", modelId: "a-model", label: "A", remoteGroup: "shared" }),
		record({ id: "y", providerAlias: "provider-y", modelId: "same", label: "Same" }),
	];
	const before = structuredClone(records);
	const groups = groupRecordsForDisplay(records);

	assert.deepEqual(groups.map(({ title }) => title), ["provider-y", "provider-z", "shared"]);
	assert.deepEqual(groups.find(({ title }) => title === "shared")?.items.map(({ id }) => id), ["a", "c", "b"]);
	assert.deepEqual(groups.find(({ title }) => title === "provider-y")?.items.map(({ id }) => id), ["y"]);
	assert.deepEqual(records, before);
});

test("manager renders blocked reason, preserved raw bytes hint, conflict paths and revisions", () => {
	const blocked = state({
		blocked: {
			reason: "malformed",
			message: "private blocked explanation",
			rawBytes: new Uint8Array([1, 2]),
		},
	});
	assert.match(renderManagerScreen(blocked), /malformed/);
	assert.match(renderManagerScreen(blocked), /原始字节已保留/);
	assert.match(renderManagerScreen(blocked), /raw bytes preserved/);

	const result: TransactionResult = {
		ok: false,
		phase: "prepare",
		code: "catalog-read-conflict",
		conflicts: [{ path: "models.json", expectRevision: "expected-1", actualRevision: "actual-2" }],
		message: "prepare conflict",
	};
	const updated = applyTuiAction(state(), { type: "transaction-result", result });
	const rendered = renderManagerScreen(updated);
	assert.match(rendered, /prepare/);
	assert.match(rendered, /Status: failed/);
	assert.doesNotMatch(rendered, /catalog-read-conflict|prepare conflict/);
	assert.match(rendered, /models\.json/);
	assert.match(rendered, /expected-1/);
	assert.match(rendered, /actual-2/);
});

test("failover and history screens render their state, with history newest first", () => {
	const current = state({
		tab: "history",
		failoverSummary: {
			chainCount: 2,
			entries: [
				{ chainId: "primary", model: "provider-a/model-a" },
				{ chainId: "backup", model: "provider-b/model-b" },
			],
		},
		history: ["oldest", "newest"],
	});
	const failover = renderFailoverScreen(current);
	assert.match(failover, /Failover Chains/);
	assert.match(failover, /2 chain/);
	assert.match(failover, /primary.*provider-a\/model-a/);
	const history = renderHistoryScreen(current);
	assert.ok(history.indexOf("newest") < history.indexOf("oldest"));
});

test("applyTuiAction handles tabs, selection, parser submissions, delete request, and confirmation without I/O", () => {
	const originalEnv = process.env.MODEL_MANAGER_TUI_TEST_KEY;
	process.env.MODEL_MANAGER_TUI_TEST_KEY = "valid-environment-value";
	try {
		let current = applyTuiAction(state(), { type: "switch-tab", tab: "history" });
		assert.equal(current.tab, "history");
		current = applyTuiAction(current, { type: "select-record", recordId: "record-a" });
		assert.match(current.message ?? "", /record-a/);

		current = applyTuiAction(current, { type: "raw-input-submit", text: "valid-a\nvalid-b" });
		assert.match(current.message ?? "", /accepted/i);
		current = applyTuiAction(current, {
			type: "environment-submit",
			names: ["MODEL_MANAGER_TUI_TEST_KEY"],
		});
		assert.match(current.message ?? "", /accepted/i);

		const requested = applyTuiAction(state(), { type: "request-delete", recordId: "record-a" });
		assert.equal(requested.pendingImpact, null);
		assert.match(requested.message ?? "", /record-a/);

		const confirmed = applyTuiAction(
			state({ pendingDraft: draft, pendingImpact: impact }),
			{ type: "confirm-cascade", ack: true },
		);
		assert.equal(confirmed.pendingDraft, draft);
		assert.equal(confirmed.pendingImpact, impact);
		assert.match(confirmed.message ?? "", /commit/i);

		const declined = applyTuiAction(
			state({ pendingDraft: draft, pendingImpact: impact }),
			{ type: "confirm-cascade", ack: false },
		);
		assert.equal(declined.pendingDraft, draft);
		assert.equal(declined.pendingImpact, impact);
		assert.doesNotMatch(declined.message ?? "", /commit|write/i);
	} finally {
		if (originalEnv === undefined) delete process.env.MODEL_MANAGER_TUI_TEST_KEY;
		else process.env.MODEL_MANAGER_TUI_TEST_KEY = originalEnv;
	}
});

test("applyTuiAction keeps invalid batches safe and never includes the submitted key", () => {
	const secret = "tui-secret-value";
	const raw = applyTuiAction(state(), { type: "raw-input-submit", text: `${secret}\n${secret}` });
	assert.match(raw.message ?? "", /rejected|invalid/i);
	assert.equal(JSON.stringify(raw).includes(secret), false);

	const missing = applyTuiAction(state(), {
		type: "environment-submit",
		names: ["MODEL_MANAGER_TUI_MISSING_SECRET"],
	});
	assert.match(missing.message ?? "", /rejected|invalid/i);
	assert.doesNotMatch(missing.message ?? "", /MODEL_MANAGER_TUI_MISSING_SECRET/);
});

test("applyTuiAction commit, cancel, and transaction-result markers are pure state changes", () => {
	const submitting = applyTuiAction(state({ pendingDraft: draft }), { type: "commit-draft" });
	assert.equal(submitting.pendingDraft, draft);
	assert.match(submitting.message ?? "", /submitting/i);

	const cancelled = applyTuiAction(
		state({ pendingDraft: draft, pendingImpact: impact }),
		{ type: "cancel-draft" },
	);
	assert.equal(cancelled.pendingDraft, null);
	assert.equal(cancelled.pendingImpact, null);
	assert.match(cancelled.message ?? "", /已取消，未写入/);
	assert.doesNotMatch(cancelled.message ?? "", /write/i);

	const result: TransactionResult = {
		ok: false,
		phase: "commit",
		code: "commit-failed",
		message: "commit failed",
	};
	const updated = applyTuiAction(state(), { type: "transaction-result", result });
	assert.deepEqual(updated.conflict, {
		ok: false,
		phase: "commit",
		status: "failed",
		conflicts: [],
	});
	assert.match(updated.message ?? "", /commit|failed/i);
	assert.doesNotMatch(JSON.stringify(updated), /commit-failed/);
});

test("all three screens omit secret material from untrusted state", () => {
	const secret = "screen-secret-value";
	const unsafe = state({
		snapshot: snapshot([record({ unknownField: secret })]),
		blocked: { reason: "unreadable", message: `cannot show ${secret}` },
		pendingDraft: { ...draft, secret },
		history: [`saved ${secret}`, "safe event"],
	});
	for (const rendered of [
		renderManagerScreen(unsafe),
		renderFailoverScreen(unsafe),
		renderHistoryScreen(unsafe),
	]) {
		assert.equal(rendered.includes(secret), false);
	}
});

test("transaction-result stores only a safe conflict projection", () => {
	const secret = "opaque-canary-8f42c17b";
	const result: TransactionResult = {
		ok: false,
		phase: "prepare",
		code: secret,
		message: secret,
		conflicts: [{ path: secret, expectRevision: secret, actualRevision: secret }],
	};
	const updated = applyTuiAction(state(), { type: "transaction-result", result });

	assert.equal(JSON.stringify(updated).includes(secret), false);
	assert.match(updated.message ?? "", /failed/i);
	for (const rendered of [
		renderManagerScreen(updated),
		renderFailoverScreen(updated),
		renderHistoryScreen(updated),
	]) {
		assert.equal(rendered.includes(secret), false);
	}
});

test("all three screens structurally redact untrusted visible values", () => {
	const secret = "opaque-canary-8f42c17b";
	const unsafe = state({
		snapshot: snapshot([
			record({
				id: secret,
				providerAlias: secret,
				providerName: secret,
				modelId: secret,
				label: secret,
				remoteGroup: secret,
				unknownField: secret,
			}),
		]),
		message: secret,
		failoverSummary: {
			chainCount: 1,
			entries: [{ chainId: secret, model: secret }],
		},
		history: [secret],
	});
	for (const rendered of [
		renderManagerScreen(unsafe),
		renderFailoverScreen(unsafe),
		renderHistoryScreen(unsafe),
	]) {
		assert.equal(rendered.includes(secret), false);
	}
});
