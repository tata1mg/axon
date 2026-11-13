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
import { withSafehouseReason } from "./telemetry.ts";

export { type AxonSafehousePolicy, axonSafehousePolicySchema } from "./contracts.ts";
export interface AxonSafehouseAuthorization {
  readonly policy: AxonSafehousePolicy;
  readonly session?: string;
  readonly clientConfig?: ClientConfig;
  /** Starts the RPC login UI only; operations still need authenticated authorization. */
  readonly bootstrap?: boolean;
}

export function axonSafehouseFailure(message: string, cause?: unknown): LauncherError {
  return new LauncherError(message, LAUNCHER_EXIT_STATUS.profileFailure, {
    ...(cause === undefined ? {} : { cause }),
    remediation:
      "Check Axon login and backend Axon Safehouse policy, then restart axon pi. To run without sandbox protection, use axon --no-safehouse or AXON_DISABLE_SAFEHOUSE=1.",
  });
}

export function assertAxonSafehouseSupported(): void {
  if (process.platform !== "darwin") {
    throw withSafehouseReason(
      new LauncherError(
        "Axon Safehouse requires Agent Safehouse on macOS; this platform is not supported",
        LAUNCHER_EXIT_STATUS.unsupportedEnvironment,
      ),
      "unsupported",
    );
  }
}

/** Signed-out RPC fetches a fresh backend policy unless the invocation explicitly opts out. */
export async function authorizeAxonSafehouseBootstrap(): Promise<AxonSafehouseAuthorization> {
  const policy = await fetchAxonSafehouseBootstrap({ timeoutMs: 5_000 });
  if (!policy)
    throw withSafehouseReason(
      axonSafehouseFailure(
        "Required backend Axon Safehouse bootstrap policy is missing or invalid",
      ),
      "invalid_config",
    );
  return {
    policy,
    bootstrap: true,
  };
}

/** Security policy is required, never cached or replaced with optional preferences. */
export async function authorizeAxonSafehouse(
  paths: AxonPaths,
): Promise<AxonSafehouseAuthorization> {
  let session = await loadEncryptedSession(paths);
  if (!session)
    throw withSafehouseReason(
      axonSafehouseFailure("A verified Axon session is required for Axon Safehouse policy"),
      "no_session",
    );
  const result = await fetchClientConfig(session, { timeoutMs: 5_000 });
  if (result.sessionRefreshToken) {
    if (!(await refreshEncryptedSession(paths, session, result.sessionRefreshToken))) {
      throw withSafehouseReason(
        axonSafehouseFailure("Axon identity changed while fetching Axon Safehouse policy"),
        "account_changed",
      );
    }
    session = result.sessionRefreshToken;
  }
  if ((await loadEncryptedSession(paths)) !== session) {
    throw withSafehouseReason(
      axonSafehouseFailure("Axon identity changed while fetching Axon Safehouse policy"),
      "account_changed",
    );
  }
  const parsed = axonSafehousePolicySchema.safeParse(result.config?.axonSafehouse);
  // No config means the fetch failed (its config.fetch event has the cause); a config without
  // a valid policy is a backend configuration problem.
  if (!parsed.success)
    throw withSafehouseReason(
      axonSafehouseFailure("Required backend Axon Safehouse policy is missing or invalid"),
      result.config ? "invalid_config" : "unavailable",
    );
  return {
    policy: parsed.data,
    session,
    ...(result.config ? { clientConfig: result.config } : {}),
  };
}
