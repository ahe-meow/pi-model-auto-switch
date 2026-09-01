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
	type TuiAction,
	type TuiState,
} from "../src/model-manager-tui.ts";
import type { TransactionResult } from "../src/model-manager-store.ts";
import type { ModelManagerRecord } from "../src/model-manager-types.ts";

const record = (
	overrides: Partial<ModelManagerRecord> = {},
): ModelManagerRecord => ({
	id: "record-a",
	providerAlias: "provider-a",
	providerName: "Provider A",
	modelId: "model-a",
	...overrides,
});

function snapshot(
	records: readonly ModelManagerRecord[] = [record()],
): ModelManagerCatalogSnapshot {
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
	assert.deepEqual(
		[...TAB_ORDER],
		["model-manager", "failover-chains", "history"],
	);
	const rendered = renderManagerScreen(state());
	assert.ok(
		rendered.indexOf("Model Manager") < rendered.indexOf("Failover Chains"),
	);
	assert.ok(rendered.indexOf("Failover Chains") < rendered.indexOf("History"));
	assert.match(rendered, /> Model Manager/);
	assert.doesNotMatch(rendered, /> Failover Chains/);
});

test("groupRecordsForDisplay groups by remote group or provider alias and stably sorts copies", () => {
	const records = [
		record({
			id: "z",
			providerAlias: "provider-z",
			modelId: "same",
			label: "Same",
		}),
		record({
			id: "b",
			providerAlias: "provider-a",
			modelId: "z-model",
			label: "Z",
			remoteGroup: "shared",
		}),
		record({
			id: "a",
			providerAlias: "provider-a",
			modelId: "a-model",
			label: "A",
			remoteGroup: "shared",
		}),
		record({
			id: "c",
			providerAlias: "provider-a",
			modelId: "a-model",
			label: "A",
			remoteGroup: "shared",
		}),
		record({
			id: "y",
			providerAlias: "provider-y",
			modelId: "same",
			label: "Same",
		}),
	];
	const before = structuredClone(records);
	const groups = groupRecordsForDisplay(records);

	assert.deepEqual(
		groups.map(({ title }) => title),
		["provider-y", "provider-z", "shared"],
	);
	assert.deepEqual(
		groups.find(({ title }) => title === "shared")?.items.map(({ id }) => id),
		["a", "c", "b"],
	);
	assert.deepEqual(
		groups.find(({ title }) => title === "provider-y")?.items.map(({ id }) => id),
		["y"],
	);
	assert.deepEqual(records, before);
});

test("manager renders blocked hints and basename-only conflict projections", () => {
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
	assert.doesNotMatch(
		renderManagerScreen(blocked),
		/private blocked explanation/,
	);

	const result: TransactionResult = {
		ok: false,
		phase: "prepare",
		code: "catalog-read-conflict",
		conflicts: [
			{
				path: "/mnt/sdcard/AI Workplace/.pi/agent/models.json",
				expectRevision: "0123456789abcdef",
				actualRevision: "fedcba9876543210",
			},
			{
				path: "/private/hunter2/not-json.txt",
				expectRevision: "missing",
				actualRevision: "arbitrary-revision",
			},
		],
		message: "prepare conflict",
	};
	const updated = applyTuiAction(state(), {
		type: "transaction-result",
		result,
	});
	assert.deepEqual(updated.conflict, {
		ok: false,
		phase: "prepare",
		status: "conflict",
		conflicts: [
			{
				path: "models.json",
				expectRevision: "0123456789abcdef",
				actualRevision: "fedcba9876543210",
			},
			{
				path: "[redacted]",
				expectRevision: "missing",
				actualRevision: "[redacted]",
			},
		],
	});
	const rendered = renderManagerScreen(updated);
	assert.match(rendered, /prepare/);
	assert.match(rendered, /Status: conflict/);
	assert.doesNotMatch(
		rendered,
		/catalog-read-conflict|prepare conflict|AI Workplace|private|hunter2/,
	);
	assert.match(rendered, /models\.json/);
	assert.match(rendered, /expect=0123456789abcdef/);
	assert.match(rendered, /actual=fedcba9876543210/);
});

test("failover and history screens render validated identities and known internal history", () => {
	const current = state({
		tab: "history",
		failoverSummary: {
			chainCount: 2,
			entries: [
				{ chainId: "mm-provider-a-fingerprint", model: "Claude 3.5 Sonnet" },
				{ chainId: "backup@2026-09-01", model: "provider-b/model-b" },
			],
		},
		history: ["Raw input accepted (2 key(s))", "Transaction committed"],
	});
	const failover = renderFailoverScreen(current);
	assert.match(failover, /Failover Chains/);
	assert.match(failover, /2 chain/);
	assert.match(failover, /mm-provider-a-fingerprint.*Claude 3\.5 Sonnet/);
	assert.match(failover, /backup@2026-09-01.*provider-b\/model-b/);
	const history = renderHistoryScreen(current);
	assert.ok(
		history.indexOf("Transaction committed") <
			history.indexOf("Raw input accepted"),
	);
});

test("applyTuiAction handles parser, delete, and confirmation semantics without ambient I/O", () => {
	let current = applyTuiAction(state(), { type: "switch-tab", tab: "history" });
	assert.equal(current.tab, "history");
	current = applyTuiAction(current, {
		type: "select-record",
		recordId: "hunter2",
	});
	assert.match(current.message ?? "", /selected/i);
	assert.doesNotMatch(JSON.stringify(current), /hunter2/);

	current = applyTuiAction(current, {
		type: "raw-input-submit",
		text: "valid-a\nvalid-b",
	});
	assert.match(current.message ?? "", /accepted/i);
	assert.equal(typeof process.env.PATH, "string");
	current = applyTuiAction(current, {
		type: "environment-submit",
		names: ["PATH"],
	});
	assert.match(current.message ?? "", /rejected/i);

	const requested = applyTuiAction(state({ pendingImpact: impact }), {
		type: "request-delete",
		recordId: "hunter2",
	});
	assert.equal(requested.pendingImpact, null);
	assert.match(requested.message ?? "", /delete requested/i);
	assert.doesNotMatch(JSON.stringify(requested), /hunter2/);

	const confirmed = applyTuiAction(
		state({ pendingDraft: draft, pendingImpact: impact }),
		{ type: "confirm-cascade", ack: true },
	);
	assert.deepEqual(confirmed.pendingDraft, draft);
	assert.deepEqual(confirmed.pendingImpact, impact);
	assert.match(confirmed.message ?? "", /ready/i);

	for (const incomplete of [
		state(),
		state({ pendingDraft: draft }),
		state({ pendingImpact: impact }),
	]) {
		const ignored = applyTuiAction(incomplete, {
			type: "confirm-cascade",
			ack: true,
		});
		assert.match(ignored.message ?? "", /ignored|required/i);
		assert.doesNotMatch(ignored.message ?? "", /ready/i);
	}

	const declined = applyTuiAction(
		state({ pendingDraft: draft, pendingImpact: impact }),
		{ type: "confirm-cascade", ack: false },
	);
	assert.deepEqual(declined.pendingDraft, draft);
	assert.deepEqual(declined.pendingImpact, impact);
	assert.doesNotMatch(declined.message ?? "", /ready|write/i);
});

test("applyTuiAction keeps invalid batches safe and never includes the submitted key", () => {
	const secret = "tui-secret-value";
	const raw = applyTuiAction(state(), {
		type: "raw-input-submit",
		text: `${secret}\n${secret}`,
	});
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
	const missing = applyTuiAction(state(), { type: "commit-draft" });
	assert.match(missing.message ?? "", /no draft/i);
	assert.doesNotMatch(missing.message ?? "", /submitting/i);

	const submitting = applyTuiAction(state({ pendingDraft: draft }), {
		type: "commit-draft",
	});
	assert.deepEqual(submitting.pendingDraft, draft);
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
	const updated = applyTuiAction(state({ pendingDraft: draft }), {
		type: "transaction-result",
		result,
	});
	assert.deepEqual(updated.pendingDraft, draft);
	assert.deepEqual(updated.conflict, {
		ok: false,
		phase: "commit",
		status: "failed",
		conflicts: [],
	});
	assert.match(updated.message ?? "", /commit|failed/i);
	assert.doesNotMatch(JSON.stringify(updated), /commit-failed/);

	const succeeded = applyTuiAction(
		state({ pendingDraft: draft, pendingImpact: impact }),
		{
			type: "transaction-result",
			result: { ok: true, committed: ["/private/hunter2/models.json"] },
		},
	);
	assert.equal(succeeded.pendingDraft, null);
	assert.equal(succeeded.pendingImpact, null);
	assert.deepEqual(succeeded.conflict, { ok: true, committedCount: 1 });
	assert.doesNotMatch(JSON.stringify(succeeded), /private|hunter2|models\.json/);
});

test("all reducer actions remove secret-shaped draft fields from state", () => {
	const secret = "hunter2";
	const unsafeDraft = {
		...draft,
		secret,
		fields: { ...draft.fields, apiKey: secret },
		advanced: {
			safe: "kept",
			password: secret,
			nested: { visible: "kept", accessToken: secret },
		},
	} as ModelManagerDraft;
	const failure: TransactionResult = {
		ok: false,
		phase: "prepare",
		code: secret,
		message: secret,
		conflicts: [
			{
				path: `/private/${secret}/models.json`,
				expectRevision: secret,
				actualRevision: secret,
			},
		],
	};
	const actions: TuiAction[] = [
		{ type: "switch-tab", tab: "history" },
		{ type: "select-record", recordId: "record-a" },
		{ type: "raw-input-submit", text: secret },
		{ type: "environment-submit", names: ["PATH"] },
		{ type: "request-delete", recordId: "record-a" },
		{ type: "confirm-cascade", ack: true },
		{ type: "commit-draft" },
		{ type: "cancel-draft" },
		{ type: "transaction-result", result: failure },
		{
			type: "transaction-result",
			result: { ok: true, committed: [`/${secret}/models.json`] },
		},
	];
	for (const action of actions) {
		const updated = applyTuiAction(
			state({ pendingDraft: unsafeDraft, pendingImpact: impact }),
			action,
		);
		assert.equal(JSON.stringify(updated).includes(secret), false, action.type);
	}

	const sanitized = applyTuiAction(state({ pendingDraft: unsafeDraft }), {
		type: "switch-tab",
		tab: "history",
	});
	assert.deepEqual(sanitized.pendingDraft, {
		...draft,
		advanced: { safe: "kept", nested: { visible: "kept" } },
	});
});

test("all three screens omit low-entropy secrets from untrusted state shapes", () => {
	const secret = "hunter2";
	const unsafe = state({
		snapshot: snapshot([record({ unknownField: secret })]),
		blocked: { reason: "unreadable", message: secret },
		message: `Selected record: ${secret}`,
		pendingDraft: { ...draft, secret } as ModelManagerDraft,
		failoverSummary: {
			chainCount: 0,
			entries: [],
			unknownField: secret,
		} as TuiState["failoverSummary"],
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

test("transaction-result stores only a safe conflict projection", () => {
	const secret = "opaque-canary-8f42c17b";
	const result: TransactionResult = {
		ok: false,
		phase: "prepare",
		code: secret,
		message: secret,
		conflicts: [{ path: secret, expectRevision: secret, actualRevision: secret }],
	};
	const updated = applyTuiAction(state(), {
		type: "transaction-result",
		result,
	});

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

test("renderers use trusted field shapes without opaque-value heuristics", () => {
	const unsafe = state({
		snapshot: snapshot([
			record({
				id: "record-2026-09-01",
				providerAlias: "mm-provider-a-fingerprint",
				providerName: "Provider A",
				modelId: "claude-3.5-sonnet",
				label: "Claude 3.5 Sonnet",
				remoteGroup: "release-2026-09-01",
				unknownField: "hunter2",
			}),
		]),
		message: "hunter2",
		history: [
			"hunter2",
			"Environment input rejected: invalid batch; sensitive values omitted",
		],
	});
	const manager = renderManagerScreen(unsafe);
	assert.match(manager, /Claude 3\.5 Sonnet/);
	assert.match(manager, /mm-provider-a-fingerprint/);
	assert.match(manager, /2026-09-01/);
	assert.doesNotMatch(manager, /hunter2/);
	assert.doesNotMatch(renderHistoryScreen(unsafe), /hunter2/);
});

test("failover chainCount is rendered only when it is a bounded finite integer", () => {
	const hostile = state({
		failoverSummary: {
			chainCount: "hunter2" as unknown as number,
			entries: [],
		},
	});
	const rendered = renderFailoverScreen(hostile);
	assert.match(rendered, /Chains: \[redacted\]/);
	assert.doesNotMatch(rendered, /hunter2/);
	assert.match(
		renderFailoverScreen(
			state({
				failoverSummary: { chainCount: 100_000, entries: [] },
			}),
		),
		/Chains: 100000/,
	);
});

test("transaction projection keeps safe status, revisions, and committed count", () => {
	const failed = applyTuiAction(state(), {
		type: "transaction-result",
		result: {
			ok: false,
			phase: "commit",
			code: "commit-failed",
			message: "private failure details",
		},
	});
	assert.deepEqual(failed.conflict, {
		ok: false,
		phase: "commit",
		status: "failed",
		conflicts: [],
	});

	const conflict = applyTuiAction(state(), {
		type: "transaction-result",
		result: {
			ok: false,
			phase: "prepare",
			code: "catalog-read-conflict",
			message: "private conflict details",
			conflicts: [
				{
					path: "/private/models.json",
					expectRevision: "missing",
					actualRevision: "0123456789abcdef",
				},
			],
		},
	});
	assert.deepEqual(conflict.conflict, {
		ok: false,
		phase: "prepare",
		status: "conflict",
		conflicts: [
				{
					path: "models.json",
					expectRevision: "missing",
					actualRevision: "0123456789abcdef",
				},
			],
	});

	const committed = applyTuiAction(state({ pendingDraft: draft }), {
		type: "transaction-result",
		result: {
			ok: true,
			committed: ["/private/models.json", "/private/model-manager.json"],
		},
	});
	assert.deepEqual(committed.conflict, { ok: true, committedCount: 2 });
	assert.equal(committed.pendingDraft, null);
	assert.match(renderManagerScreen(committed), /Transaction committed: 2 file/);
});

test("environment action reads only its optional read-only env object", () => {
	const secret = "environment-secret-value";
	const updated = applyTuiAction(state(), {
		type: "environment-submit",
		names: ["MODEL_MANAGER_TUI_TEST_KEY"],
		env: { MODEL_MANAGER_TUI_TEST_KEY: "valid-environment-value" },
	} as TuiAction);
	assert.match(updated.message ?? "", /accepted/i);
	assert.equal(JSON.stringify(updated).includes(secret), false);
});

test("known draft secrets stay out of state, conflict projections, and all screens", () => {
	const secret = "hunter2";
	const unsafeDraft = {
		...draft,
		secret,
		fields: { ...draft.fields, label: secret, modelId: secret },
		advanced: { safe: secret, normal: "kept" },
	} as ModelManagerDraft;
	const unsafe = state({
		snapshot: snapshot([
			record({
				id: "secret-record",
				providerAlias: secret,
				modelId: secret,
				label: secret,
			}),
			record({
				id: "normal-record",
				providerAlias: "provider-normal",
				modelId: "gpt-4o",
				label: "GPT-4o",
			}),
		]),
		blocked: { reason: "unreadable", message: `blocked ${secret}` },
		message: `Selected record: ${secret}`,
		pendingDraft: unsafeDraft,
		conflict: {
			ok: false,
			phase: "prepare",
			status: "conflict",
			conflicts: [
				{
					path: `/private/${secret}.json`,
					expectRevision: secret,
					actualRevision: "fedcba9876543210",
				},
			],
		},
		history: [`saved ${secret}`],
	});
	const projected = applyTuiAction(unsafe, { type: "switch-tab", tab: "history" });
	assert.equal(JSON.stringify(projected).includes(secret), false);
	assert.equal(projected.pendingDraft?.fields.modelId, "[redacted]");
	assert.deepEqual(projected.pendingDraft?.advanced, {
		safe: "[redacted]",
		normal: "kept",
	});
	assert.match(renderManagerScreen(unsafe), /GPT-4o/);
	for (const rendered of [
		renderManagerScreen(unsafe),
		renderFailoverScreen(unsafe),
		renderHistoryScreen(unsafe),
	]) {
		assert.equal(rendered.includes(secret), false);
		assert.doesNotMatch(rendered, /blocked hunter2|\/private\//);
	}
});


test("reducer sanitizes unsafe pending impact before returning or rendering", () => {
	const secret = "impact-secret-9f42c17b";
	const unsafeDraft = { ...draft, secret } as ModelManagerDraft;
	const unsafeImpact = {
		recordId: secret,
		chains: [
			{
				file: `/private/${secret}/chains.json`,
				chainId: secret,
				kind: "model-entry",
			},
			{
				file: "/safe/chains.json",
				chainId: "safe-chain",
				kind: "generated-block",
			},
		],
		state: [
			{ file: `/private/${secret}/state.json`, key: secret },
			{ file: "/safe/state.json", key: "targets.provider/model" },
		],
		referenced: true,
	} as unknown as CatalogImpact;
	const unsafe = state({ pendingDraft: unsafeDraft, pendingImpact: unsafeImpact });
	const actions: TuiAction[] = [
		{ type: "switch-tab", tab: "history" },
		{ type: "select-record", recordId: "record-a" },
		{ type: "raw-input-submit", text: "valid-a" },
		{ type: "environment-submit", names: ["PATH"], env: {} },
		{ type: "request-delete", recordId: "record-a" },
		{ type: "confirm-cascade", ack: true },
		{ type: "commit-draft" },
		{ type: "cancel-draft" },
		{
			type: "transaction-result",
			result: { ok: true, committed: [`/private/${secret}/models.json`] },
		},
	];
	for (const action of actions) {
		const updated = applyTuiAction(unsafe, action);
		assert.equal(JSON.stringify(updated).includes(secret), false, action.type);
		for (const rendered of [
			renderManagerScreen(updated),
			renderFailoverScreen(updated),
			renderHistoryScreen(updated),
		]) {
			assert.equal(rendered.includes(secret), false, action.type);
			assert.doesNotMatch(rendered, /\/private\//, action.type);
		}
	}

	const sanitized = applyTuiAction(unsafe, {
		type: "confirm-cascade",
		ack: true,
	});
	assert.deepEqual(sanitized.pendingImpact, {
		recordId: "[redacted]",
		chains: [
			{ file: "chains.json", chainId: "[redacted]", kind: "model-entry" },
			{ file: "chains.json", chainId: "safe-chain", kind: "generated-block" },
		],
		state: [
			{ file: "state.json", key: "[redacted]" },
			{ file: "state.json", key: "targets.provider/model" },
		],
		referenced: true,
	});
	assert.match(sanitized.message ?? "", /ready/);
});

test("pending impact keeps legal scanner syntax and strips path-shaped identities", () => {
	const unsafeImpact = {
		recordId: "provider/model",
		chains: [
			{
				file: "/mnt/sdcard/AI Workplace/foo/models.json",
				chainId: "provider/model",
				kind: "model-entry",
			},
			{
				file: "/safe/chains.json",
				chainId: "/private/hunter2",
				kind: "generated-block",
			},
		],
		state: [
			{
				file: "/safe/state.json",
				key: "registrations./agent/project.targets[0]",
			},
		],
		referenced: true,
	} as CatalogImpact;
	const projected = applyTuiAction(state({ pendingImpact: unsafeImpact }), {
		type: "switch-tab",
		tab: "history",
	});

	assert.deepEqual(projected.pendingImpact, {
		recordId: "provider/model",
		chains: [
			{ file: "models.json", chainId: "provider/model", kind: "model-entry" },
			{ file: "chains.json", chainId: "[redacted]", kind: "generated-block" },
		],
		state: [
			{ file: "state.json", key: "registrations./agent/project.targets[0]" },
		],
		referenced: true,
	});
	assert.equal(JSON.stringify(projected).includes("/private/hunter2"), false);
});

test("known pending impact secrets stay redacted in reducer state", () => {
	const secret = "hunter2";
	const projected = applyTuiAction(
		state({
			pendingDraft: { ...draft, secret } as ModelManagerDraft,
			pendingImpact: {
				recordId: `provider/${secret}`,
				chains: [],
				state: [
					{
						file: "/safe/state.json",
						key: `registrations.safe.targets[0]/${secret}`,
					},
				],
				referenced: true,
			},
		}),
		{ type: "confirm-cascade", ack: true },
	);

	assert.equal(JSON.stringify(projected).includes(secret), false);
	assert.equal(projected.pendingImpact?.recordId, "[redacted]");
	assert.equal(projected.pendingImpact?.state[0]?.key, "[redacted]");
});

test("reducer uses pending impact only as safe confirmation state", () => {
	const secret = "raw-impact-secret";
	const projected = applyTuiAction(
		state({
			pendingDraft: { ...draft, secret } as ModelManagerDraft,
			pendingImpact: {
				recordId: `/private/${secret}`,
				chains: [
					{
						file: `/private/${secret}/models.json`,
						chainId: `/private/${secret}`,
						kind: "model-entry",
					},
				],
				state: [],
				referenced: true,
			},
		}),
		{ type: "confirm-cascade", ack: true },
	);
	assert.match(projected.message ?? "", /ready/);
	assert.equal(JSON.stringify(projected).includes(secret), false);
	assert.doesNotMatch(JSON.stringify(projected), /\/private\//);

	const submitting = applyTuiAction(projected, { type: "commit-draft" });
	assert.match(submitting.message ?? "", /submitting/i);
	assert.equal(JSON.stringify(submitting).includes(secret), false);
	assert.doesNotMatch(JSON.stringify(submitting), /\/private\//);
});

test("blocked raw bytes remain opaque and are never rendered as text", () => {
	const rawBytes = new Uint8Array([0x68, 0x75, 0x6e, 0x74, 0x65, 0x72, 0x32]);
	const projected = applyTuiAction(
		state({ blocked: { reason: "malformed", message: "private", rawBytes } }),
		{ type: "switch-tab", tab: "model-manager" },
	);

	assert.ok(projected.blocked?.rawBytes instanceof Uint8Array);
	assert.deepEqual([...projected.blocked?.rawBytes ?? []], [...rawBytes]);
	const rendered = renderManagerScreen(projected);
	assert.doesNotMatch(rendered, /104,117,110,116,101,114,50|hunter2/);
	assert.match(rendered, /raw bytes preserved/);
});
