import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { withFileLock } from "../../launcher/file-lock.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import type { AxonPaths } from "../../product/paths.ts";

const AUTH_TOKEN_KEY = "extension_auth_token";
export const SESSION_FILE_NAME = PRODUCT_IDENTITY.sharedAuthFileName;
const MAX_SESSION_FILE_BYTES = 1024 * 1024;

/** Repairable file contents, distinct from unsafe entries and filesystem failures. */
export class InvalidSessionContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionContentError";
  }
}

function sessionPath(paths: AxonPaths): string {
  return paths.sharedAuthFile;
}

async function assertRegularDirectory(directory: string): Promise<void> {
  const directoryStatus = await lstat(directory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error("Shared authentication directory is not a regular directory");
  }
}

export function isEncryptedSession(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length < MAX_SESSION_FILE_BYTES &&
    /^[!-~]+$/.test(value)
  );
}

async function readSessionFile(
  destination: string,
  recoverInvalidJson = false,
): Promise<Record<string, unknown> | undefined> {
  try {
    const fileStatus = await lstat(destination);
    if (
      !fileStatus.isFile() ||
      fileStatus.isSymbolicLink() ||
      fileStatus.size > MAX_SESSION_FILE_BYTES
    ) {
      throw new Error("Saved session is not a regular file");
    }
    const serialized = await readFile(destination, "utf8");
    let payload: unknown;
    try {
      payload = JSON.parse(serialized);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (recoverInvalidJson) return {};
      // Do not retain the parser error: it may contain private session content.
      throw new InvalidSessionContentError("Saved session file is not valid JSON");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      if (recoverInvalidJson) return {};
      throw new InvalidSessionContentError("Saved session file is not a JSON object");
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Read DeputyDev's live extension token without exposing it in CLI output or Pi history. */
export async function loadEncryptedSession(paths: AxonPaths): Promise<string | undefined> {
  const destination = sessionPath(paths);
  try {
    await assertRegularDirectory(dirname(destination));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  // The VS Code binary may own this shared file with different permissions.
  const payload = await readSessionFile(destination);
  const encryptedSession = payload?.[AUTH_TOKEN_KEY];
  if (encryptedSession === undefined) return undefined;
  if (!isEncryptedSession(encryptedSession)) {
    throw new InvalidSessionContentError("Saved session token is invalid");
  }
  return encryptedSession;
}

/** Merge only our token into the shared session file and atomically set owner-only permissions. */
async function persistEncryptedSession(
  paths: AxonPaths,
  encryptedSession: string,
  expectedSession?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isEncryptedSession(encryptedSession)) throw new Error("Invalid encrypted session");
  const destination = sessionPath(paths);
  await mkdir(paths.sharedAuthDirectory, { recursive: true, mode: 0o700 });
  await assertRegularDirectory(paths.sharedAuthDirectory);

  return withFileLock(
    paths.sharedAuthLock,
    async () => {
      // A selected browser login can repair corrupt JSON, but never unsafe filesystem entries.
      const existingData = await readSessionFile(destination, expectedSession === undefined);
      // A late response must not overwrite a newer login or another process's refresh.
      if (expectedSession !== undefined && existingData?.[AUTH_TOKEN_KEY] !== expectedSession) {
        return false;
      }
      signal?.throwIfAborted();
      const data = { ...existingData, [AUTH_TOKEN_KEY]: encryptedSession };
      const serialized = `${JSON.stringify(data)}\n`;
      if (Buffer.byteLength(serialized) > MAX_SESSION_FILE_BYTES) {
        throw new Error("Saved session is too large");
      }
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
        signal?.throwIfAborted();
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
      return true;
    },
    signal ? { signal } : {},
  );
}

export async function saveEncryptedSession(
  paths: AxonPaths,
  encryptedSession: string,
  expectedSession?: string,
  signal?: AbortSignal,
): Promise<void> {
  await persistEncryptedSession(paths, encryptedSession, expectedSession, signal);
}

/** Clear the shared local credential, preserving DeputyDev's unrelated settings. */
export async function clearEncryptedSession(paths: AxonPaths): Promise<boolean> {
  const destination = sessionPath(paths);
  try {
    await assertRegularDirectory(paths.sharedAuthDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  return withFileLock(paths.sharedAuthLock, async () => {
    const data = await readSessionFile(destination);
    if (!data || !Object.hasOwn(data, AUTH_TOKEN_KEY)) return false;
    delete data[AUTH_TOKEN_KEY];
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    return true;
  });
}

/** Rotate only the credential that produced this response, never a newer login. */
export async function refreshEncryptedSession(
  paths: AxonPaths,
  expectedSession: string,
  refreshedSession: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return persistEncryptedSession(paths, refreshedSession, expectedSession, signal);
}
