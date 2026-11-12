import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface FileLockOptions {
  readonly retryDelayMs?: number;
  /** Grace period for locks with missing or malformed ownership metadata. */
  readonly staleAfterMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface LockOwner {
  readonly createdAt: number;
  readonly pid: number;
  readonly token: string;
  /** Host fingerprint; absent for locks written before hosts were recorded. */
  readonly host?: string;
}

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const LEGACY_OWNER_FILE = "owner.json";
const OWNER_FILE_PATTERN = /^owner\.(\d+)\.(\d+)\.([a-f0-9-]{36})(?:\.([a-f0-9]{12}))?$/;
/**
 * PIDs are only meaningful on the host (and PID namespace) that issued them. A home shared
 * with a container or another machine must not treat "no such PID here" as a dead owner.
 * Hashed so the hostname never appears on disk or in errors.
 */
const HOST_ID = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);

export class FileLockTimeoutError extends Error {
  readonly remediation: string;

  constructor(
    lockPath: string,
    details: {
      readonly ownerPid?: number;
      readonly ownerAlive?: boolean | undefined;
    } = {},
  ) {
    const ownerDescription =
      details.ownerPid === undefined
        ? "The lock's owner process could not be determined."
        : details.ownerAlive === undefined
          ? `The lock's owner process (PID ${details.ownerPid}) could not be checked safely.`
          : `The lock's owner process (PID ${details.ownerPid}) is ${
              details.ownerAlive ? "still running" : "no longer running"
            }.`;
    super(`timed out waiting for lock: ${lockPath}. ${ownerDescription}`);
    this.name = "FileLockTimeoutError";
    this.remediation =
      details.ownerAlive === false
        ? "Retry; Axon will attempt to remove the abandoned lock automatically. If this persists, check the lock directory's permissions."
        : "Wait for the other operation using this lock to finish, then retry. Do not remove a lock that may still be in use.";
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isLockOwner(value: Partial<LockOwner>): value is LockOwner {
  return (
    typeof value.createdAt === "number" &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt > 0 &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.token === "string" &&
    (value.host === undefined || typeof value.host === "string")
  );
}

function ownerFileName(owner: LockOwner): string {
  return `owner.${owner.pid}.${owner.createdAt}.${owner.token}.${owner.host ?? HOST_ID}`;
}

function ownerFromFileName(name: string): LockOwner | undefined {
  const match = OWNER_FILE_PATTERN.exec(name);
  if (match === null || match[3] === undefined) return undefined;
  const owner = {
    pid: Number(match[1]),
    createdAt: Number(match[2]),
    token: match[3],
    ...(match[4] === undefined ? {} : { host: match[4] }),
  };
  return isLockOwner(owner) ? owner : undefined;
}

async function readLegacyOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(lockPath, LEGACY_OWNER_FILE), "utf8"),
    ) as Partial<LockOwner>;
    return isLockOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The atomic marker identifies the owner; owner.json alone identifies a pre-marker lock. */
async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const names = await readdir(lockPath);
    const markers = names.filter((name) => name !== LEGACY_OWNER_FILE);
    if (markers.length === 1 && markers[0] !== undefined) return ownerFromFileName(markers[0]);
    if (markers.length === 0 && names.length === 1) return readLegacyOwner(lockPath);
    return undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the owner is gone. EPERM and unexpected failures are inconclusive.
    return isFileSystemError(error, "ESRCH") ? false : undefined;
  }
}

/**
 * `true` alive, `false` provably gone, `undefined` unknown. An owner from another host cannot be
 * probed, so it is treated as gone only after the grace period, as before markers existed.
 */
function ownerAlive(owner: LockOwner, staleAfterMs: number): boolean | undefined {
  if (owner.host !== undefined && owner.host !== HOST_ID) {
    return Date.now() - owner.createdAt >= staleAfterMs ? false : undefined;
  }
  return isProcessAlive(owner.pid);
}

async function removeOwnerMarker(lockPath: string, name: string): Promise<void> {
  try {
    if (name === LEGACY_OWNER_FILE) await unlink(join(lockPath, name));
    else await rmdir(join(lockPath, name));
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

async function removeEmptyLock(lockPath: string): Promise<boolean> {
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return true;
    if (isFileSystemError(error, "ENOTEMPTY") || isFileSystemError(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
}

async function removeStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(lockPath);
  } catch (error) {
    return isFileSystemError(error, "ENOENT");
  }

  const getUserId = process.getuid;
  if (getUserId !== undefined && status.uid !== getUserId()) {
    throw new Error(`refusing to remove lock owned by uid ${status.uid}: ${lockPath}`);
  }
  if (!status.isDirectory()) {
    throw new Error(`refusing to remove lock that is not a regular directory: ${lockPath}`);
  }

  let names: string[];
  try {
    names = await readdir(lockPath);
  } catch (error) {
    return isFileSystemError(error, "ENOENT");
  }

  // Fresh empty/legacy locks may still be initializing; identified dead owners need no grace.
  const young = Date.now() - status.mtimeMs < staleAfterMs;
  if (names.length === 0 && young) return false;
  const markers = names.filter((name) => name !== LEGACY_OWNER_FILE);
  const hasLegacyOwner = markers.length !== names.length;
  const legacyOwner = hasLegacyOwner ? await readLegacyOwner(lockPath) : undefined;
  if (markers.length > 0) {
    // Marker locks also carry an owner.json copy for older Axon processes; the marker governs.
    for (const name of markers) {
      const owner = ownerFromFileName(name);
      // Never delete unrecognized files.
      if (owner === undefined || ownerAlive(owner, staleAfterMs) !== false) return false;
    }
  } else if (hasLegacyOwner) {
    if (legacyOwner !== undefined) {
      if (ownerAlive(legacyOwner, staleAfterMs) !== false) return false;
    } else if (young) {
      // The owner may still be getting written.
      return false;
    }
  }

  let latestStatus: Awaited<ReturnType<typeof lstat>>;
  try {
    latestStatus = await lstat(lockPath);
  } catch (error) {
    return isFileSystemError(error, "ENOENT");
  }
  if (
    status.dev !== latestStatus.dev ||
    status.ino !== latestStatus.ino ||
    status.uid !== latestStatus.uid ||
    status.mtimeMs !== latestStatus.mtimeMs
  ) {
    return false;
  }
  if (hasLegacyOwner) {
    const latestOwner = await readLegacyOwner(lockPath);
    if (
      legacyOwner?.token !== latestOwner?.token ||
      legacyOwner?.pid !== latestOwner?.pid ||
      legacyOwner?.createdAt !== latestOwner?.createdAt
    ) {
      return false;
    }
  }

  // Delete only the inspected generation's markers. rmdir refuses a newly acquired,
  // nonempty lock, unlike recursive removal or renaming the entire directory.
  for (const name of names) await removeOwnerMarker(lockPath, name);
  return removeEmptyLock(lockPath);
}

/**
 * Axon releases before atomic markers (and Pi extensions they loaded, which can outlive an
 * upgrade) only understand owner.json. Without it they treat a marker lock as ownerless and
 * reclaim it once it is older than their grace period, even while its owner is running.
 */
async function publishLegacyOwner(lockPath: string, owner: LockOwner): Promise<void> {
  await writeFile(join(lockPath, LEGACY_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions,
): Promise<() => Promise<void>> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const owner: LockOwner = {
    createdAt: Date.now(),
    pid: process.pid,
    token: crypto.randomUUID(),
    host: HOST_ID,
  };
  // An empty, uniquely named owner directory publishes identity atomically. Old
  // cleanup attempts cannot delete a new owner's marker or its nonempty parent.
  const name = ownerFileName(owner);
  let publishedLegacyOwner = false;
  const release = async () => {
    // owner.json goes first: the marker still protects the lock from new-format cleaners, and
    // the removal refreshes mtime so older cleaners see a fresh, ownerless lock.
    if (publishedLegacyOwner) await removeOwnerMarker(lockPath, LEGACY_OWNER_FILE);
    await removeOwnerMarker(lockPath, name);
    await removeEmptyLock(lockPath);
  };
  const releaseQuietly = async () => {
    try {
      await release();
    } catch {
      // Leave a dead-owner lock for later recovery; keep the original failure visible.
    }
  };

  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    options.signal?.throwIfAborted();
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }

    if (created) {
      try {
        await mkdir(join(lockPath, name), { mode: 0o700 });
        const names = await readdir(lockPath);
        // A delayed empty-directory cleanup may race initialization. Only the sole
        // published owner can enter the critical section; losing initializers retry.
        if (names.length === 1 && names[0] === name) {
          // Release removes even a partially written copy; nothing else writes owner.json here.
          publishedLegacyOwner = true;
          // Not best-effort: older processes that see no owner.json reclaim the lock once it
          // passes their grace period, so a marker-only lock is not exclusive. A failure
          // releases the marker below and propagates instead of entering the critical section.
          await publishLegacyOwner(lockPath, owner);
          return release;
        }
      } catch (error) {
        // APFS can report EINVAL, rather than ENOENT, if the empty parent is
        // removed while its owner marker is being created. Both safely retry.
        const initializationRaced =
          isFileSystemError(error, "ENOENT") ||
          (process.platform === "darwin" && isFileSystemError(error, "EINVAL"));
        if (!initializationRaced) {
          await releaseQuietly();
          throw error;
        }
      }
      await releaseQuietly();
    } else if (await removeStaleLock(lockPath, staleAfterMs)) {
      continue;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const currentOwner = await readOwner(lockPath);
      if (currentOwner === undefined) throw new FileLockTimeoutError(lockPath);
      throw new FileLockTimeoutError(lockPath, {
        ownerPid: currentOwner.pid,
        ownerAlive: ownerAlive(currentOwner, staleAfterMs),
      });
    }
    await sleep(retryDelayMs, undefined, { signal: options.signal });
  }
}

export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const release = await acquireFileLock(lockPath, options);
  let result: T;
  try {
    options.signal?.throwIfAborted();
    result = await operation();
  } catch (error) {
    try {
      await release();
    } catch {
      // The operation's failure is the root cause; a stuck lock is recovered once we exit.
    }
    throw error;
  }
  await release();
  return result;
}
