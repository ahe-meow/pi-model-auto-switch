import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ModelManagerCatalogSnapshot } from "../src/model-manager-catalog.ts";
import type { CatalogImpact } from "../src/model-manager-impact.ts";
import {
	buildPreview,
	cancelDraft,
	cloneDraft,
	commitDraft,
	createDraft,
	editDraft,
	type ModelManagerDraft,
} from "../src/model-manager-operations.ts";
import { commitCatalogTransaction } from "../src/model-manager-store.ts";
import {
	createStableId,
	type ModelManagerRecord,
	type ModelManagerResult,
} from "../src/model-manager-types.ts";

const source: ModelManagerRecord = {
	id: "source-id",
	providerAlias: "mm-provider-a-source-fingerprint",
	providerName: "Provider A",
	modelId: "model-a",
	label: "Source label",
	remoteGroup: "shared-remote",
	groupOwner: true,
	multiplier: 2,
	baseUrl: "https://api.example.test/v1",
	unknownField: { nested: [1, 2, 3] },
};

function snapshot(records: readonly ModelManagerRecord[] = [source]): ModelManagerCatalogSnapshot {
	const copied = structuredClone(records) as ModelManagerRecord[];
	return {
		records: copied,
		byId: new Map(copied.map((record) => [record.id, record])),
		providers: copied.length === 0 ? [] : [{
			name: source.providerAlias,
			baseUrl: "https://api.example.test/v1",
			apiKey: "",
			api: "openai-completions",
			models: [{ id: source.modelId, name: source.label, reasoning: true }],
		}],
		failoverUntouched: true,
	};
}

function assertOk<T>(result: ModelManagerResult<T>): T {
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("expected successful result");
	return result.value;
}

function assertError<T>(result: ModelManagerResult<T>, code: string): void {
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal("code" in result.error, true);
	if ("code" in result.error) assert.equal(result.error.code, code);
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "model-manager-operations-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function newDraft(secret?: string): ModelManagerDraft {
	return {
		...createDraft({
			providerAlias: "mm-provider-a-new-fingerprint",
			providerName: "Provider A",
			modelId: "model-new",
			label: "New model",
		}),
		...(secret === undefined ? {} : { secret }),
	};
}

const noImpact: CatalogImpact = {
	recordId: "new-record",
	chains: [],
	state: [],
	referenced: false,
};

test("createDraft builds draft with provided fields and empty advanced", () => {
	const fields = {
		providerAlias: "input-alias-hint",
		providerName: "Provider A",
		modelId: "model-a",
		label: "Model A",
	};
	const draft = createDraft(fields);

	assert.deepEqual(draft, { kind: "create", fields, advanced: {} });
	assert.notEqual(draft.fields, fields);
	assert.equal("secret" in draft.advanced, false);
	assert.equal("secret" in createDraft(fields, { secret: "must-not-enter-advanced" }).advanced, false);
});

test("editDraft clones existing record and unknown fields", () => {
	const catalog = snapshot();
	const original = structuredClone(catalog.records[0]);
	const draft = assertOk(editDraft(catalog, source.id, { label: "Edited label" }));

	assert.equal(draft.kind, "edit");
	assert.equal(draft.recordId, source.id);
	assert.deepEqual(draft.fields, {
		providerAlias: source.providerAlias,
		providerName: source.providerName,
		modelId: source.modelId,
		label: "Edited label",
		remoteGroup: source.remoteGroup,
		groupOwner: true,
		multiplier: 2,
	});
	assert.deepEqual(draft.advanced, {
		baseUrl: "https://api.example.test/v1",
		unknownField: { nested: [1, 2, 3] },
	});
	assert.deepEqual(catalog.records[0], original);
	assert.notEqual(draft.advanced.unknownField, source.unknownField);
});

test("cloneDraft copies advanced and unknown fields with new provider alias, stable id, and copy label", () => {
	const catalog = snapshot();
	const original = structuredClone(catalog.records[0]);
	const draft = assertOk(cloneDraft(catalog, source.id, "new-fingerprint"));

	assert.equal(draft.kind, "clone");
	assert.equal(draft.recordId, createStableId(draft.fields.providerAlias, source.modelId));
	assert.equal(draft.fields.providerAlias, "mm-provider-a-new-fingerprint");
	assert.equal(draft.fields.providerName, source.providerName);
	assert.equal(draft.fields.modelId, source.modelId);
	assert.equal(draft.fields.label, "Source label (copy)");
	assert.equal(draft.fields.multiplier, 2);
	assert.deepEqual(draft.advanced, {
		baseUrl: "https://api.example.test/v1",
		unknownField: { nested: [1, 2, 3] },
	});
	assert.notEqual(draft.recordId, source.id);
	assert.notEqual(draft.fields.providerAlias, source.providerAlias);
	assert.deepEqual(catalog.records[0], original);
});

test("cloneDraft defaults to independent group and alias; explicit remoteGroup copies its label", () => {
	const catalog = snapshot();
	const independent = assertOk(cloneDraft(catalog, source.id, "independent-fingerprint"));
	const grouped = assertOk(cloneDraft(catalog, source.id, "grouped-fingerprint", {
		remoteGroup: source.remoteGroup,
	}));

	assert.equal(independent.fields.remoteGroup, undefined);
	assert.equal(independent.fields.groupOwner, undefined);
	assert.notEqual(independent.fields.providerAlias, source.providerAlias);
	assert.equal(grouped.fields.remoteGroup, source.remoteGroup);
	assert.equal(grouped.fields.groupOwner, undefined);
	assert.notEqual(grouped.fields.providerAlias, source.providerAlias);
});

test("cloneDraft rejects missing new key fingerprint with clear error", () => {
	const catalog = snapshot();
	for (const fingerprint of ["", "   "]) {
		assertError(cloneDraft(catalog, source.id, fingerprint), "clone-key-fingerprint-required");
	}
	const reusedFingerprint = "source-fingerprint";
	const reused = cloneDraft(catalog, source.id, reusedFingerprint);
	assertError(reused, "clone-key-fingerprint-required");
	assert.equal(JSON.stringify(reused).includes(reusedFingerprint), false);
});

test("cloneDraft rejects unknown remote group without owner flag", () => {
	const rejected = cloneDraft(snapshot(), source.id, "new-fingerprint", {
		remoteGroup: "unknown-remote",
	});
	assertError(rejected, "remote-group-unknown");

	const owned = assertOk(cloneDraft(snapshot(), source.id, "owned-fingerprint", {
		remoteGroup: "new-owned-remote",
		groupOwner: true,
	}));
	assert.equal(owned.fields.remoteGroup, "new-owned-remote");
	assert.equal(owned.fields.groupOwner, true);
});

test("editDraft rejects missing record", () => {
	assertError(editDraft(snapshot(), "missing-record", { label: "Edited" }), "record-not-found");
});

test("buildPreview contains no secret material and performs zero writes", async () => {
	await withTempDir(async (dir) => {
		const markerPath = join(dir, "marker");
		await writeFile(markerPath, "unchanged", "utf8");
		const catalog = snapshot();
		const originalRecords = structuredClone(catalog.records);
		const originalProviders = structuredClone(catalog.providers);
		const originalIndex = [...catalog.byId.entries()];
		const secret = "preview-secret-must-not-escape";
		const draft = newDraft(secret);
		const originalDraft = structuredClone(draft);
		const beforeFiles = await readdir(dir);

		const preview = assertOk(buildPreview(catalog, draft));

		assert.equal(JSON.stringify(preview).includes(secret), false);
		assert.equal(JSON.stringify(preview.sidecarAfter).includes("apiKey"), false);
		assert.equal(preview.providerDrafts.every((provider) => provider.apiKey === ""), true);
		assert.equal(
			preview.providerDrafts.some((provider) => provider.name === draft.fields.providerAlias),
			true,
		);
		assert.deepEqual(preview.impact, null);
		assert.deepEqual(await readdir(dir), beforeFiles);
		assert.equal(await readFile(markerPath, "utf8"), "unchanged");
		assert.deepEqual(catalog.records, originalRecords);
		assert.deepEqual(catalog.providers, originalProviders);
		assert.deepEqual([...catalog.byId.entries()], originalIndex);
		assert.deepEqual(draft, originalDraft);
	});
});

test("commitDraft preserves existing apiKey bytes when key is unchanged and injects raw/environment key only on commit", async () => {
	await withTempDir(async (dir) => {
		const modelsPath = join(dir, "models.json");
		const sidecarPath = join(dir, "model-manager.json");
		const opaqueKey = "opaque-native-reference";
		const originalModels = Buffer.from(`${JSON.stringify({
			providers: [{ name: source.providerAlias, apiKey: opaqueKey, models: [{ id: source.modelId }] }],
		}, null, 2)}\n`, "utf8");
		await writeFile(modelsPath, originalModels);
		const edit = assertOk(editDraft(snapshot(), source.id, { label: "Edited" }));

		const unchanged = await commitDraft(edit, {
			snapshot: snapshot(),
			sidecarPath,
			commit: commitCatalogTransaction,
			impact: null,
			confirmed: true,
		});

		assert.equal(unchanged.ok, true);
		assert.deepEqual(await readFile(modelsPath), originalModels);
		assert.equal(JSON.stringify(unchanged).includes(opaqueKey), false);
	});

	for (const secret of ["raw-key-secret", "environment-key-secret"]) {
		await withTempDir(async (dir) => {
			const sidecarPath = join(dir, "model-manager.json");
			const draft = newDraft(secret);
			const preview = assertOk(buildPreview(snapshot([]), draft));
			assert.equal(JSON.stringify(preview).includes(secret), false);

			const result = await commitDraft(draft, {
				snapshot: snapshot([]),
				sidecarPath,
				commit: commitCatalogTransaction,
				impact: null,
				confirmed: true,
			});

			assert.equal(result.ok, true);
			const models = JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as {
				providers: Array<{ name: string; apiKey: string }>;
			};
			assert.equal(models.providers[0]?.name, draft.fields.providerAlias);
			assert.equal(models.providers[0]?.apiKey, secret);
			assert.equal((await readFile(sidecarPath, "utf8")).includes(secret), false);
			assert.equal(JSON.stringify(result).includes(secret), false);
		});
	}
});

test("commitDraft requires cascade confirmation when referenced", async () => {
	let commits = 0;
	const secret = "unconfirmed-secret";
	const impact: CatalogImpact = { ...noImpact, referenced: true };
	const result = await commitDraft(newDraft(secret), {
		snapshot: snapshot([]),
		sidecarPath: "/unused/model-manager.json",
		commit: async () => {
			commits += 1;
			return { ok: true, committed: [] };
		},
		impact,
		confirmed: false,
	});

	assertError(result, "cascade-not-confirmed");
	assert.equal(commits, 0);
	assert.equal(JSON.stringify(result).includes(secret), false);
});

test("commitDraft writes sidecar and provider config through commit callback", async () => {
	await withTempDir(async (dir) => {
		const sidecarPath = join(dir, "nested", "model-manager.json");
		const modelsPath = join(dirname(sidecarPath), "models.json");
		const secret = "commit-only-secret";
		let calls = 0;
		const result = await commitDraft(newDraft(secret), {
			snapshot: snapshot([]),
			sidecarPath,
			commit: async (input) => {
				calls += 1;
				assert.deepEqual(input.writes.map((write) => write.path), [sidecarPath, modelsPath]);
				assert.equal(input.writes.every((write) => write.expectRevision === "missing"), true);
				const sidecarText = Buffer.from(input.writes[0]!.bytes).toString("utf8");
				const modelsText = Buffer.from(input.writes[1]!.bytes).toString("utf8");
				assert.equal(sidecarText, `${JSON.stringify(JSON.parse(sidecarText), null, 2)}\n`);
				assert.equal(modelsText, `${JSON.stringify(JSON.parse(modelsText), null, 2)}\n`);
				assert.equal(sidecarText.includes(secret), false);
				assert.equal(modelsText.includes(secret), true);
				return { ok: true, committed: input.writes.map((write) => write.path) };
			},
			impact: noImpact,
			confirmed: true,
		});

		assert.equal(calls, 1);
		assert.deepEqual(result, { ok: true, value: { committed: [sidecarPath, modelsPath] } });
		assert.equal(JSON.stringify(result).includes(secret), false);
	});
});

test("commitDraft redacts secret from commit failures", async () => {
	const secret = "failure-secret-must-be-redacted";
	const result = await commitDraft(newDraft(secret), {
		snapshot: snapshot([]),
		sidecarPath: "/unused/model-manager.json",
		commit: async () => ({
			ok: false,
			phase: "commit",
			message: `write failed while handling ${secret}`,
		}),
		impact: null,
		confirmed: true,
	});

	assert.equal(result.ok, false);
	assert.equal(JSON.stringify(result).includes(secret), false);
	assert.equal(JSON.stringify(result).includes("[redacted]"), true);
});

test("cancelDraft returns without side effects", async () => {
	await withTempDir(async (dir) => {
		const markerPath = join(dir, "marker");
		await writeFile(markerPath, "unchanged", "utf8");
		const draft = newDraft("cancelled-secret");
		const original = structuredClone(draft);
		const before = await readdir(dir);

		assert.deepEqual(cancelDraft(draft), { cancelled: true });
		assert.deepEqual(draft, original);
		assert.deepEqual(await readdir(dir), before);
		assert.equal(await readFile(markerPath, "utf8"), "unchanged");
	});
});
