import { loadEncryptedSession, refreshEncryptedSession } from "../cli/auth/session.ts";
import { type ClientConfig, fetchClientConfig } from "../cli/client-config.ts";
import { LauncherError } from "../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../launcher/exit-status.ts";
import type { AxonPaths } from "../product/paths.ts";
import { type SandboxPolicy, sandboxPolicySchema } from "./contracts.ts";

export { type SandboxPolicy, sandboxPolicySchema } from "./contracts.ts";
export interface SandboxAuthorization {
  readonly policy: SandboxPolicy;
  readonly expiresAt: number;
  readonly session?: string;
  readonly clientConfig?: ClientConfig;
}

export function sandboxFailure(message: string, cause?: unknown): LauncherError {
  return new LauncherError(message, LAUNCHER_EXIT_STATUS.profileFailure, {
    ...(cause === undefined ? {} : { cause }),
    remediation:
      "Check Axon login and backend sandbox policy, then restart axon pi. Sandboxing cannot be disabled.",
  });
}

export function assertSandboxSupported(): void {
  if (process.platform !== "darwin") {
    throw new LauncherError(
      "Axon requires Agent Safehouse on macOS; this platform has no supported sandbox",
      LAUNCHER_EXIT_STATUS.unsupportedEnvironment,
    );
  }
}

/** Security policy is required, never cached or replaced with optional preferences. */
export async function authorizeSandbox(paths: AxonPaths): Promise<SandboxAuthorization> {
  let session = await loadEncryptedSession(paths);
  if (!session) throw sandboxFailure("A verified Axon session is required for sandbox policy");
  const requestedAt = Date.now();
  const result = await fetchClientConfig(session, { timeoutMs: 5_000 });
  if (result.sessionRefreshToken) {
    if (!(await refreshEncryptedSession(paths, session, result.sessionRefreshToken))) {
      throw sandboxFailure("Axon identity changed while fetching sandbox policy");
    }
    session = result.sessionRefreshToken;
  }
  if ((await loadEncryptedSession(paths)) !== session) {
    throw sandboxFailure("Axon identity changed while fetching sandbox policy");
  }
  const parsed = sandboxPolicySchema.safeParse(result.config?.sandbox);
  if (!parsed.success)
    throw sandboxFailure("Required backend sandbox policy is missing or invalid");
  return {
    policy: parsed.data,
    expiresAt: requestedAt + parsed.data.maxSessionSeconds * 1_000,
    session,
    ...(result.config ? { clientConfig: result.config } : {}),
  };
}
