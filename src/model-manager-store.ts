import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { ModelManagerError } from "./model-manager-types.ts";

const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 20;

export interface FileRevision {
	path: string;
	revision: string;
}

export interface CatalogWrite {
	path: string;
	bytes: Uint8Array;
	expectRevision: string;
}

export interface CatalogTransactionInput {
	writes: CatalogWrite[];
}

export type TransactionResult =
	| { ok: true; committed: string[] }
	| {
			ok: false;
			phase: "prepare" | "commit";
			code?: string;
			error?: ModelManagerError;
			conflicts?: Array<{
				path: string;
				expectRevision: string;
				actualRevision: string;
			}>;
			rolledBack?: string[];
			rollbackFailure?: string[];
			message: string;
	  };

type OriginalFile = {
	path: string;
	bytes?: Buffer;
};

type RollbackResult = {
	rolledBack: string[];
	rollbackFailure: string[];
	failureName?: string;
};

function normalizedPath(path: string): string {
	return resolve(path);
}

function revisionFor(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export async function readRevision(path: string): Promise<FileRevision> {
	const normalized = normalizedPath(path);
	try {
		return {
			path: normalized,
			revision: revisionFor(await readFile(normalized)),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { path: normalized, revision: "missing" };
		}
		throw error;
	}
}

function lockPath(path: string): string {
	return `${path}.lock`;
}

async function releaseLock(path: string, token: string): Promise<void> {
	try {
		if ((await readFile(path, "utf8")) !== token) return;
		await unlink(path);
	} catch {
		// Keep a lock when ownership cannot be proven.
	}
}

type LockIdentity = {
	device: string;
	inode: string;
};

async function cleanupCreatedLock(
	path: string,
	identity: LockIdentity | undefined,
): Promise<void> {
	if (!identity) throw new Error("Lock ownership could not be verified");
	const current = await lstat(path, { bigint: true });
	if (
		String(current.dev) !== identity.device ||
		String(current.ino) !== identity.inode
	)
		throw new Error("Lock ownership changed before cleanup");
	await unlink(path);
}

async function acquireLock(
	path: string,
): Promise<{ path: string; token: string }> {
	const lock = lockPath(path);
	const token = randomUUID();
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	await mkdir(dirname(lock), { recursive: true });

	for (;;) {
		let created = false;
		let identity: LockIdentity | undefined;
		try {
			const handle = await open(lock, "wx", 0o600);
			created = true;
			try {
				const metadata = await handle.stat({ bigint: true });
				identity = {
					device: String(metadata.dev),
					inode: String(metadata.ino),
				};
				await handle.writeFile(token, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			return { path: lock, token };
		} catch (error) {
			if (created) {
				try {
					await cleanupCreatedLock(lock, identity);
				} catch (cleanupError) {
					throw new Error(
						`lock setup failed (${safeErrorName(error)}); cleanup failed (${safeErrorName(cleanupError)})`,
						{ cause: error },
					);
				}
				throw error;
			}
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline)
				throw new Error("Timed out waiting for file lock");
			await new Promise((resolvePromise) =>
				setTimeout(resolvePromise, LOCK_RETRY_MS),
			);
		}
	}
}

export async function withFileLocks<T>(
	paths: readonly string[],
	operation: () => Promise<T>,
): Promise<T> {
	const targets = [...new Set(paths.map(normalizedPath))].sort();
	const acquired: Array<{ path: string; token: string }> = [];
	try {
		for (const target of targets) acquired.push(await acquireLock(target));
		return await operation();
	} finally {
		for (let index = acquired.length - 1; index >= 0; index -= 1) {
			const held = acquired[index];
			if (held) await releaseLock(held.path, held.token);
		}
	}
}

function isCatalogPath(path: string): boolean {
	const normalized = normalizedPath(path);
	const segments = normalized.split(sep).map((segment) => segment.toLowerCase());
	const name = basename(normalized).toLowerCase();
	if (segments.includes("failover") || name.includes("failover")) return false;
	return name === "models.json" || name === "model-manager.json";
}

function safeErrorName(error: unknown): string {
	return error instanceof Error && error.name.length > 0
		? error.name
		: "UnknownError";
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
	const target = normalizedPath(path);
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	let created = false;
	try {
		const handle = await open(temp, "wx", 0o600);
		created = true;
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, target);
		try {
			const directory = await open(dirname(target), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} catch {
			// Directory fsync is unavailable on some filesystems.
		}
	} finally {
		if (created) {
			try {
				await unlink(temp);
			} catch {
				// The temporary file was renamed or is unavailable for cleanup.
			}
		}
	}
}

async function cacheOriginal(path: string): Promise<OriginalFile> {
	try {
		return { path, bytes: await readFile(path) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path };
		throw error;
	}
}

async function rollbackWrites(
	originals: readonly OriginalFile[],
	committed: readonly string[],
	write: (path: string, bytes: Uint8Array) => Promise<void>,
): Promise<RollbackResult> {
	const rolledBack: string[] = [];
	const rollbackFailure: string[] = [];
	let failureName: string | undefined;
	for (let index = committed.length - 1; index >= 0; index -= 1) {
		const path = committed[index];
		if (!path) continue;
		const original = originals.find((entry) => entry.path === path);
		if (!original) continue;
		try {
			if (original.bytes === undefined) await unlink(path);
			else await write(path, original.bytes);
			rolledBack.push(path);
		} catch (error) {
			rollbackFailure.push(path);
			failureName ??= safeErrorName(error);
		}
	}
	return { rolledBack, rollbackFailure, failureName };
}

export async function commitCatalogTransaction(
	input: CatalogTransactionInput,
	write: (path: string, bytes: Uint8Array) => Promise<void> = writeAtomically,
): Promise<TransactionResult> {
	const writes = input.writes.map((entry) => ({
		...entry,
		path: normalizedPath(entry.path),
		bytes: Buffer.from(entry.bytes),
	}));
	const notOwned = writes.some((entry) => !isCatalogPath(entry.path));
	if (notOwned) {
		const error: ModelManagerError = {
			code: "not-owner",
			message: "not-owner: target is outside Model Manager catalog ownership",
		};
		return {
			ok: false,
			phase: "prepare",
			code: error.code,
			error,
			message: error.message,
		};
	}
	if (new Set(writes.map((entry) => entry.path)).size !== writes.length) {
		const error: ModelManagerError = {
			code: "duplicate-path",
			message: "duplicate normalized write path",
		};
		return {
			ok: false,
			phase: "prepare",
			code: error.code,
			error,
			message: "prepare failed (duplicate write path)",
		};
	}

	try {
		return await withFileLocks(
			writes.map((entry) => entry.path),
			async () => {
				const conflicts: Array<{
					path: string;
					expectRevision: string;
					actualRevision: string;
				}> = [];
				const actualRevisions = new Map<string, string>();
				for (const entry of writes) {
					try {
						const actual = await readRevision(entry.path);
						actualRevisions.set(entry.path, actual.revision);
						if (actual.revision !== entry.expectRevision) {
							conflicts.push({
								path: entry.path,
								expectRevision: entry.expectRevision,
								actualRevision: actual.revision,
							});
						}
					} catch (error) {
						return {
							ok: false,
							phase: "prepare",
							message: `prepare failed (${safeErrorName(error)})`,
						} satisfies TransactionResult;
					}
				}
				if (conflicts.length > 0)
					return {
						ok: false,
						phase: "prepare",
						conflicts,
						message: "prepare conflict: catalog changed before commit",
					};

				const originals: OriginalFile[] = [];
				for (const entry of writes) {
					try {
						const original = await cacheOriginal(entry.path);
						originals.push(original);
						const actual =
							original.bytes === undefined ? "missing" : revisionFor(original.bytes);
						if (actual !== actualRevisions.get(entry.path)) {
							conflicts.push({
								path: entry.path,
								expectRevision: entry.expectRevision,
								actualRevision: actual,
							});
						}
					} catch (error) {
						return {
							ok: false,
							phase: "prepare",
							message: `prepare failed (${safeErrorName(error)})`,
						} satisfies TransactionResult;
					}
				}
				if (conflicts.length > 0)
					return {
						ok: false,
						phase: "prepare",
						conflicts,
						message: "prepare conflict: catalog changed before commit",
					};

				const committed: string[] = [];
				const attempted: string[] = [];
				for (const entry of writes) {
					attempted.push(entry.path);
					try {
						await write(entry.path, entry.bytes);
						committed.push(entry.path);
					} catch (error) {
						const rollback = await rollbackWrites(originals, attempted, write);
						const message =
							rollback.rollbackFailure.length === 0
								? `commit failed (${safeErrorName(error)}); earlier writes rolled back`
								: `commit failed (${safeErrorName(error)}); rollback failed (${rollback.failureName ?? "UnknownError"})`;
						return {
							ok: false,
							phase: "commit",
							rolledBack: rollback.rolledBack,
							...(rollback.rollbackFailure.length > 0
								? { rollbackFailure: rollback.rollbackFailure }
								: {}),
							message,
						};
					}
				}
				return { ok: true, committed };
			},
		);
	} catch (error) {
		return {
			ok: false,
			phase: "prepare",
			message: `prepare failed (${safeErrorName(error)})`,
		};
	}
}
