import { loadEncryptedSession, refreshEncryptedSession } from "../cli/auth/session.ts";
import {
  type ClientConfig,
  fetchAxonSafehouseBootstrap,
  fetchClientConfig,
} from "../cli/client-config.ts";
import { LauncherError } from "../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../launcher/exit-status.ts";
import type { AxonPaths } from "../product/paths.ts";
import { type AxonSafehousePolicy, axonSafehousePolicySchema } from "./contracts.ts";

export { type AxonSafehousePolicy, axonSafehousePolicySchema } from "./contracts.ts";
export interface AxonSafehouseAuthorization {
  readonly policy: AxonSafehousePolicy;
  readonly expiresAt: number;
  readonly session?: string;
  readonly clientConfig?: ClientConfig;
  /** Starts the RPC login UI only; operations still need authenticated authorization. */
  readonly bootstrap?: boolean;
}

export function axonSafehouseFailure(message: string, cause?: unknown): LauncherError {
  return new LauncherError(message, LAUNCHER_EXIT_STATUS.profileFailure, {
    ...(cause === undefined ? {} : { cause }),
    remediation:
      "Check Axon login and backend Axon Safehouse policy, then restart axon pi. Axon Safehouse cannot be disabled.",
  });
}

export function assertAxonSafehouseSupported(): void {
  if (process.platform !== "darwin") {
    throw new LauncherError(
      "Axon Safehouse requires Agent Safehouse on macOS; this platform is not supported",
      LAUNCHER_EXIT_STATUS.unsupportedEnvironment,
    );
  }
}

/** Signed-out RPC still fetches a fresh backend policy; no local fallback or Axon Safehouse bypass. */
export async function authorizeAxonSafehouseBootstrap(): Promise<AxonSafehouseAuthorization> {
  const requestedAt = Date.now();
  const policy = await fetchAxonSafehouseBootstrap({ timeoutMs: 5_000 });
  if (!policy)
    throw axonSafehouseFailure(
      "Required backend Axon Safehouse bootstrap policy is missing or invalid",
    );
  return {
    policy,
    expiresAt: requestedAt + policy.maxSessionSeconds * 1_000,
    bootstrap: true,
  };
}

/** Security policy is required, never cached or replaced with optional preferences. */
export async function authorizeAxonSafehouse(
  paths: AxonPaths,
): Promise<AxonSafehouseAuthorization> {
  let session = await loadEncryptedSession(paths);
  if (!session)
    throw axonSafehouseFailure("A verified Axon session is required for Axon Safehouse policy");
  const requestedAt = Date.now();
  const result = await fetchClientConfig(session, { timeoutMs: 5_000 });
  if (result.sessionRefreshToken) {
    if (!(await refreshEncryptedSession(paths, session, result.sessionRefreshToken))) {
      throw axonSafehouseFailure("Axon identity changed while fetching Axon Safehouse policy");
    }
    session = result.sessionRefreshToken;
  }
  if ((await loadEncryptedSession(paths)) !== session) {
    throw axonSafehouseFailure("Axon identity changed while fetching Axon Safehouse policy");
  }
  const parsed = axonSafehousePolicySchema.safeParse(result.config?.axonSafehouse);
  if (!parsed.success)
    throw axonSafehouseFailure("Required backend Axon Safehouse policy is missing or invalid");
  return {
    policy: parsed.data,
    expiresAt: requestedAt + parsed.data.maxSessionSeconds * 1_000,
    session,
    ...(result.config ? { clientConfig: result.config } : {}),
  };
}
