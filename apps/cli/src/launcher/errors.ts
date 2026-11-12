import type { LauncherExitStatus } from "./exit-status.ts";
import { FileLockTimeoutError } from "./file-lock.ts";

export class LauncherError extends Error {
  readonly exitStatus: LauncherExitStatus;
  readonly remediation: string | undefined;

  constructor(
    message: string,
    exitStatus: LauncherExitStatus,
    options: { readonly cause?: unknown; readonly remediation?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LauncherError";
    this.exitStatus = exitStatus;
    this.remediation = options.remediation;
  }
}

function findLockTimeout(error: unknown): FileLockTimeoutError | undefined {
  for (let current = error, depth = 0; current !== undefined && depth < 8; depth += 1) {
    if (current instanceof FileLockTimeoutError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * The user-facing message and advice for a launcher failure. A lock timeout anywhere in the
 * cause chain contributes its owner status and remediation, which are more actionable than the
 * generic advice of whichever operation was waiting for the lock.
 */
export function describeLauncherFailure(error: LauncherError): {
  readonly message: string;
  readonly remediation: string | undefined;
} {
  const lockTimeout = findLockTimeout(error.cause);
  if (lockTimeout === undefined) return { message: error.message, remediation: error.remediation };
  return {
    message: `${error.message}: ${lockTimeout.message}`,
    remediation: lockTimeout.remediation,
  };
}
