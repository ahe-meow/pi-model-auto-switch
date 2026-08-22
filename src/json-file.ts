import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 20;

/** Identity of the bytes a caller read, used as a compare-and-swap guard. */
export type ConfigSourceRevision =
	| { kind: "absent" }
	| {
			kind: "present";
			device: string;
			inode: string;
			size: string;
			mtimeNanoseconds: string;
			digest: string;
	  };

export interface SourceRead {
	bytes?: Buffer;
	revision: ConfigSourceRevision;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function readSource(path: string): Promise<SourceRead> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { revision: { kind: "absent" } };
		throw error;
	}
	try {
		const bytes = await handle.readFile();
		const metadata = await handle.stat({ bigint: true });
		return {
			bytes,
			revision: {
				kind: "present",
				device: String(metadata.dev),
				inode: String(metadata.ino),
				size: String(metadata.size),
				mtimeNanoseconds: String(metadata.mtimeNs),
				digest: digest(bytes),
			},
		};
	} finally {
		await handle.close();
	}
}

/** Reasons a JSON file could not be turned into a value. */
export type JsonReadResult =
	| { kind: "missing"; revision: ConfigSourceRevision }
	| { kind: "parsed"; value: unknown; revision: ConfigSourceRevision }
	| { kind: "blocked"; reason: "malformed" | "unreadable"; detail: string };

export async function readJsonSource(
	path: string,
	label: string,
): Promise<JsonReadResult> {
	let source: SourceRead;
	try {
		source = await readSource(path);
	} catch (error) {
		return { kind: "blocked", reason: "unreadable", detail: String(error) };
	}
	if (!source.bytes) return { kind: "missing", revision: source.revision };
	try {
		return {
			kind: "parsed",
			value: JSON.parse(source.bytes.toString("utf8")),
			revision: source.revision,
		};
	} catch {
		return {
			kind: "blocked",
			reason: "malformed",
			detail: `${label} is not valid JSON`,
		};
	}
}

/** Shared by both config schemas: keys mapped to non-empty reason strings. */
export function readManualRecovery(
	value: unknown,
): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, reason] of Object.entries(value)) {
		if (
			key.trim().length === 0 ||
			typeof reason !== "string" ||
			reason.trim().length === 0
		)
			return undefined;
		result[key] = reason;
	}
	return result;
}

function sameRevision(
	a: ConfigSourceRevision,
	b: ConfigSourceRevision,
): boolean {
	if (a.kind !== b.kind) return false;
	return (
		a.kind === "absent" ||
		(b.kind === "present" &&
			a.device === b.device &&
			a.inode === b.inode &&
			a.size === b.size &&
			a.mtimeNanoseconds === b.mtimeNanoseconds &&
			a.digest === b.digest)
	);
}

interface LockRecord {
	pid: number;
	createdAt: number;
	owner: string;
}

async function releaseOwnedLock(path: string, owner: string): Promise<void> {
	try {
		const lock = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
		if (lock.owner === owner) await unlink(path);
	} catch {
		// Never delete a lock whose ownership cannot be verified.
	}
}

async function acquireLock(
	path: string,
	label: string,
	record: LockRecord,
): Promise<void> {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const handle = await open(path, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(record), "utf8");
				await handle.sync();
			} catch (error) {
				try {
					await handle.close();
				} catch {
					// Preserve the original lock creation failure.
				}
				try {
					await unlink(path);
				} catch {
					// A partial lock is safer left for manual review than hidden by cleanup.
				}
				throw error;
			}
			await handle.close();
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline)
				throw new Error(
					`Timed out waiting for ${label} lock: ${path}. Verify no Pi process is writing, then remove the stale lock if necessary.`,
				);
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
}

export type AtomicWriteResult = { kind: "saved" } | { kind: "conflict" };

/**
 * Lock the target, verify it still matches `expectedRevision`, then atomically
 * replace it with `build(current)` serialized as pretty JSON. `build` returning
 * undefined reports a conflict, letting callers reject unexpected file content.
 */
export async function writeJsonAtomically<T>(
	path: string,
	label: string,
	expectedRevision: ConfigSourceRevision,
	build: (current: SourceRead) => T | undefined,
): Promise<AtomicWriteResult> {
	try {
		await mkdir(dirname(path), { recursive: true });
	} catch (error) {
		throw new Error(
			`Unable to prepare ${label} directory: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		);
	}
	const owner = randomUUID();
	const lockPath = `${path}.lock`;
	const tempPath = `${path}.${process.pid}.${owner}.tmp`;
	let tempCreated = false;
	await acquireLock(lockPath, label, {
		pid: process.pid,
		createdAt: Date.now(),
		owner,
	});
	try {
		const current = await readSource(path);
		if (!sameRevision(current.revision, expectedRevision))
			return { kind: "conflict" };
		const next = build(current);
		if (next === undefined) return { kind: "conflict" };
		const handle = await open(tempPath, "wx", 0o600);
		tempCreated = true;
		try {
			const serialized = JSON.stringify(next, null, 2);
			if (serialized === undefined)
				throw new Error(`Unable to serialize ${label} as JSON`);
			await handle.writeFile(`${serialized}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, path);
		try {
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} catch {
			// Directory fsync is not supported by every filesystem.
		}
		return { kind: "saved" };
	} finally {
		if (tempCreated) {
			try {
				await unlink(tempPath);
			} catch {
				// A crash artifact must not replace or remove the target.
			}
		}
		await releaseOwnedLock(lockPath, owner);
	}
}
