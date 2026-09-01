import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdtemp,
	open,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { test } from "node:test";
import {
	commitCatalogTransaction,
	readRevision,
	withFileLocks,
	type CatalogWrite,
} from "../src/model-manager-store.ts";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "model-manager-store-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function revision(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function write(
	path: string,
	bytes: string,
	expectRevision: string,
): CatalogWrite {
	return { path, bytes: Buffer.from(bytes, "utf8"), expectRevision };
}

function assertNoSecret(result: { message: string }, secret: string): void {
	assert.equal(result.message.includes(secret), false);
	assert.equal(result.message.includes("bytes"), false);
}

test("readRevision returns content hash and missing for absent file", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "models.json");
		const bytes = Buffer.from("catalog", "utf8");
		await writeFile(path, bytes);

		const relativePath = join(
			relative(process.cwd(), dir),
			"nested",
			"..",
			"models.json",
		);
		assert.deepEqual(await readRevision(relativePath), {
			path: resolve(relativePath),
			revision: revision(bytes),
		});

		const missingPath = join(
			relative(process.cwd(), dir),
			"nested",
			"..",
			"missing.json",
		);
		assert.deepEqual(await readRevision(missingPath), {
			path: resolve(missingPath),
			revision: "missing",
		});
	});
});

test("withFileLocks second request waits and releases lockfiles in finally", async () => {
	await withTempDir(async (dir) => {
		const firstPath = join(dir, "a", "models.json");
		const secondPath = join(dir, "b", "model-manager.json");
		const entered: string[] = [];
		const exited: string[] = [];
		let releaseFirst!: () => void;
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = withFileLocks([secondPath, firstPath, firstPath], async () => {
			entered.push("first");
			await firstReleased;
			exited.push("first");
			return "first";
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		const second = withFileLocks([firstPath, secondPath], async () => {
			entered.push("second");
			exited.push("second");
			return "second";
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(entered, ["first"]);
		releaseFirst();
		assert.equal(await first, "first");
		assert.equal(await second, "second");
		assert.deepEqual(exited, ["first", "second"]);

		const files = await readdir(dir, { recursive: true });
		assert.deepEqual(
			files.filter((file) => basename(String(file)).endsWith(".lock")),
			[],
		);
	});
});

test("withFileLocks times out while another request holds the lock", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "models.json");
		let releaseHeld!: () => void;
		const held = withFileLocks(
			[path],
			async () =>
				new Promise<void>((resolveHeld) => {
					releaseHeld = resolveHeld;
				}),
		);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));

		await assert.rejects(
			withFileLocks([path], async () => undefined),
			(error: Error) => {
				assert.match(error.message, /timed out waiting for file lock/i);
				assert.equal(error.message.includes(path), false);
				return true;
			},
		);
		releaseHeld();
		await held;
	});
});

test("withFileLocks removes a lock created before setup failure", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "models.json");
		const probeHandle = await open(join(dir, "probe"), "w");
		const prototype = Object.getPrototypeOf(probeHandle) as {
			writeFile: typeof probeHandle.writeFile;
		};
		const originalWriteFile = prototype.writeFile;
		const setupError = new Error("injected lock setup failure");
		prototype.writeFile = (() =>
			Promise.reject(setupError)) as typeof prototype.writeFile;

		try {
			await assert.rejects(
				withFileLocks([path], async () => undefined),
				(error: Error) => {
					assert.equal(error, setupError);
					return true;
				},
			);
		} finally {
			prototype.writeFile = originalWriteFile;
			await probeHandle.close();
		}

		const files = await readdir(dir, { recursive: true });
		assert.deepEqual(
			files.filter((file) => basename(String(file)).endsWith(".lock")),
			[],
		);
	});
});

test("withFileLocks leaves a replacement lock after setup failure", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "models.json");
		const lockPath = `${path}.lock`;
		const probeHandle = await open(join(dir, "probe"), "w");
		const prototype = Object.getPrototypeOf(probeHandle) as {
			writeFile: typeof probeHandle.writeFile;
		};
		const originalWriteFile = prototype.writeFile;
		const setupError = new Error("injected lock setup failure");
		const replacement = "replacement-lock-owner";
		prototype.writeFile = (async () => {
			await rm(lockPath);
			await writeFile(lockPath, replacement);
			throw setupError;
		}) as typeof prototype.writeFile;

		try {
			await assert.rejects(
				withFileLocks([path], async () => undefined),
				(error: Error) => {
					assert.equal(error.name, "Error");
					return true;
				},
			);
		} finally {
			prototype.writeFile = originalWriteFile;
			await probeHandle.close();
		}

		assert.equal(await readFile(lockPath, "utf8"), replacement);
	});
});

test("commitCatalogTransaction reports lock cleanup proof failure safely", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "models.json");
		const lockPath = `${path}.lock`;
		const probeHandle = await open(join(dir, "probe"), "w");
		const prototype = Object.getPrototypeOf(probeHandle) as {
			stat: typeof probeHandle.stat;
		};
		const originalStat = prototype.stat;
		const secret = "provider-api-secret";
		prototype.stat = (() =>
			Promise.reject(new Error(secret))) as typeof prototype.stat;

		try {
			const result = await commitCatalogTransaction({
				writes: [write(path, secret, "missing")],
			});

			assert.equal(result.ok, false);
			if (result.ok) return;
			assert.equal(result.phase, "prepare");
			assert.match(result.message, /^prepare failed \(Error\)$/);
			assertNoSecret(result, secret);
			assert.equal(result.message.includes(path), false);
			assert.equal(await readFile(lockPath, "utf8"), "");
		} finally {
			prototype.stat = originalStat;
			await probeHandle.close();
		}
	});
});

test(
	"withFileLocks cleans the original lock after close failure",
	{
		skip:
			(process.versions as unknown as { bun?: string }).bun === undefined
				? "Node 22 FileHandle.close is per-instance own method; prototype injection does not affect production handles - Bun covers close-failure cleanup"
				: false,
	},
	async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "models.json");
		const probeHandle = await open(join(dir, "probe"), "w");
		const prototype = Object.getPrototypeOf(probeHandle) as {
			close: typeof probeHandle.close;
		};
		const originalClose = prototype.close;
		const closeError = new Error("injected lock close failure");
		prototype.close = async function (this: typeof probeHandle) {
			if (this !== probeHandle) {
				await originalClose.call(this);
				throw closeError;
			}
			return originalClose.call(this);
		} as typeof prototype.close;

		try {
			await assert.rejects(
				withFileLocks([path], async () => undefined),
				(error: Error) => {
					assert.equal(error, closeError);
					return true;
				},
			);
		} finally {
			prototype.close = originalClose;
			await probeHandle.close();
		}

		const files = await readdir(dir, { recursive: true });
		assert.deepEqual(
			files.filter((file) => basename(String(file)).endsWith(".lock")),
			[],
		);
	});
});
test("commitCatalogTransaction converts lock timeout into a prepare result", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "models.json");
		let releaseHeld!: () => void;
		const held = withFileLocks(
			[path],
			async () =>
				new Promise<void>((resolveHeld) => {
					releaseHeld = resolveHeld;
				}),
		);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));

		const result = await commitCatalogTransaction({
			writes: [write(path, "replacement", "missing")],
		});

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.phase, "prepare");
		assert.match(result.message, /^prepare failed \(Error\)$/);
		assertNoSecret(result, "provider-api-secret");
		assert.equal(result.message.includes(path), false);
		releaseHeld();
		await held;
	});
});

test("commitCatalogTransaction converts lock mkdir errors into a prepare result", async () => {
	await withTempDir(async (dir) => {
		const parent = join(dir, "not-a-directory");
		await writeFile(parent, "file");
		const path = join(parent, "models.json");

		const result = await commitCatalogTransaction({
			writes: [write(path, "replacement", "missing")],
		});

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.phase, "prepare");
		assert.match(result.message, /^prepare failed \(Error\)$/);
		assert.equal(result.message.includes(path), false);
		assertNoSecret(result, "provider-api-secret");
	});
});

test("commitCatalogTransaction cas conflict writes nothing", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "models.json");
		const original = Buffer.from("original", "utf8");
		await writeFile(path, original);
		const writes: string[] = [];
		const result = await commitCatalogTransaction(
			{
				writes: [
					{
						path,
						bytes: Buffer.from("replacement"),
						expectRevision: "wrong-revision",
					},
				],
			},
			async (target: string) => {
				writes.push(target);
				await writeFile(target, "unexpected");
			},
		);

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.phase, "prepare");
		assert.equal(result.conflicts?.[0]?.actualRevision, revision(original));
		assert.deepEqual(writes, []);
		assert.deepEqual(await readFile(path), original);
	});
});

test("commitCatalogTransaction rolls back earlier writes when a later write fails", async () => {
	await withTempDir(async (dir) => {
		const firstPath = join(dir, "models.json");
		const secondPath = join(dir, "model-manager.json");
		const firstOriginal = Buffer.from("first-original", "utf8");
		const secondOriginal = Buffer.from("second-original", "utf8");
		await writeFile(firstPath, firstOriginal);
		await writeFile(secondPath, secondOriginal);
		const calls: string[] = [];
		const writes = [
			write(firstPath, "first-new", revision(firstOriginal)),
			write(secondPath, "second-new", revision(secondOriginal)),
		];
		const result = await commitCatalogTransaction(
			{ writes },
			async (path: string, bytes: Uint8Array) => {
				const text = Buffer.from(bytes).toString();
				calls.push(`${path}:${text}`);
				if (path === secondPath && text === "second-new") {
					await writeFile(path, bytes);
					throw new Error("injected commit failure after partial write");
				}
				await writeFile(path, bytes);
			},
		);

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.phase, "commit");
		assert.deepEqual(result.rolledBack, [secondPath, firstPath]);
		assert.equal(result.rollbackFailure, undefined);
		assert.deepEqual(await readFile(firstPath), firstOriginal);
		assert.deepEqual(await readFile(secondPath), secondOriginal);
		assert.deepEqual(calls, [
			`${firstPath}:first-new`,
			`${secondPath}:second-new`,
			`${secondPath}:second-original`,
			`${firstPath}:first-original`,
		]);
		assertNoSecret(result, "first-original");
	});
});

test("commitCatalogTransaction reports rollback failure distinctly", async () => {
	await withTempDir(async (dir) => {
		const firstPath = join(dir, "models.json");
		const secondPath = join(dir, "model-manager.json");
		await writeFile(firstPath, "first-original");
		await writeFile(secondPath, "second-original");
		const secret = "provider-api-secret";
		const result = await commitCatalogTransaction(
			{
				writes: [
					write(firstPath, secret, revision(Buffer.from("first-original"))),
					write(secondPath, "second-new", revision(Buffer.from("second-original"))),
				],
			},
			async (path: string, bytes: Uint8Array) => {
				const text = Buffer.from(bytes).toString();
				if (
					(path === secondPath && text === "second-new") ||
					(path === firstPath && text === "first-original")
				)
					throw new Error(`injected failure ${secret}`);
				await writeFile(path, bytes);
			},
		);

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.phase, "commit");
		assert.deepEqual(result.rolledBack, [secondPath]);
		assert.deepEqual(result.rollbackFailure, [firstPath]);
		assertNoSecret(result, secret);
		assert.deepEqual(await readFile(firstPath), Buffer.from(secret));
	});
});

test("commitCatalogTransaction rejects failover paths as not owner", async () => {
	await withTempDir(async (dir) => {
		const failoverPath = join(dir, "failover", "models.json");
		const basenameFailoverPath = join(dir, "model-failover.json");
		const calls: string[] = [];
		const writeFn = async (path: string): Promise<void> => {
			calls.push(path);
		};

		for (const path of [failoverPath, basenameFailoverPath]) {
			const result = await commitCatalogTransaction(
				{
					writes: [
						{ path, bytes: Buffer.from("blocked"), expectRevision: "missing" },
					],
				},
				async (target: string) => writeFn(target),
			);
			assert.equal(result.ok, false);
			if (result.ok) continue;
			assert.equal(result.phase, "prepare");
			assert.equal(result.error?.code, "not-owner");
			assert.equal(result.error?.message.includes(path), false);
			assert.equal(JSON.stringify(result.error).includes(path), false);
			assert.equal(result.message.includes(path), false);
		}
		assert.deepEqual(calls, []);
	});
});

test("commitCatalogTransaction rejects duplicate normalized paths before writing", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "models.json");
		const duplicatePath = join(dir, "nested", "..", "models.json");
		const original = Buffer.from("original", "utf8");
		await writeFile(path, original);
		const writes: string[] = [];

		const result = await commitCatalogTransaction(
			{
				writes: [
					write(path, "first", revision(original)),
					write(duplicatePath, "second", revision(original)),
				],
			},
			async (target: string, bytes: Uint8Array) => {
				writes.push(target);
				await writeFile(target, bytes);
			},
		);

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.phase, "prepare");
		assert.equal(result.error?.code, "duplicate-path");
		assert.match(result.message, /duplicate/i);
		assert.deepEqual(writes, []);
		assert.deepEqual(await readFile(path), original);
	});
});

test("commitCatalogTransaction success writes all and returns committed", async () => {
	await withTempDir(async (dir) => {
		const modelsPath = join(dir, "models.json");
		const sidecarPath = join(dir, "model-manager.json");
		const modelsBytes = Buffer.from("models-old", "utf8");
		await writeFile(modelsPath, modelsBytes);
		const calls: string[] = [];
		const writes = [
			write(modelsPath, "models-new", revision(modelsBytes)),
			{
				path: sidecarPath,
				bytes: Buffer.from("sidecar-new"),
				expectRevision: "missing",
			},
		];
		const result = await commitCatalogTransaction(
			{ writes },
			async (path: string, bytes: Uint8Array) => {
				calls.push(path);
				await writeFile(path, bytes);
			},
		);

		assert.deepEqual(result, { ok: true, committed: [modelsPath, sidecarPath] });
		assert.deepEqual(calls, [modelsPath, sidecarPath]);
		assert.deepEqual(await readFile(modelsPath), Buffer.from("models-new"));
		assert.deepEqual(await readFile(sidecarPath), Buffer.from("sidecar-new"));
		const files = await readdir(dir);
		assert.deepEqual(
			files.filter((file) => file.endsWith(".lock")),
			[],
		);
	});
});
