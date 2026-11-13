import type { AxonSafehouseSession, DoctorFinding } from "../launcher/contracts.ts";
import { LauncherError } from "../launcher/errors.ts";

/** Safehouse could not start, so a check that must execute something was skipped. */
export class AxonSafehouseUnavailableError extends LauncherError {}

/**
 * A session that refuses every launch. Diagnostics use it when Safehouse cannot start,
 * so checks that execute nothing still report while every execution is skipped,
 * never retried outside Axon Safehouse.
 */
export function unavailableAxonSafehouse(reason: LauncherError): AxonSafehouseSession {
  const refuse = async (): Promise<never> => {
    throw new AxonSafehouseUnavailableError(reason.message, reason.exitStatus, {
      cause: reason,
    });
  };
  return {
    disabled: false,
    configurationPolicy: refuse,
    clientConfig: () => undefined,
    wrap: refuse,
    run: refuse,
    dispose() {},
  };
}

export function axonSafehouseSkippedFinding(label: string): DoctorFinding {
  return { level: "warning", message: `${label} skipped: Axon Safehouse is unavailable` };
}

/** Report a check that needs Safehouse as skipped instead of losing the whole report. */
export async function skipWithoutAxonSafehouse(
  label: string,
  check: () => Promise<readonly DoctorFinding[]>,
): Promise<readonly DoctorFinding[]> {
  try {
    return await check();
  } catch (error) {
    if (!(error instanceof AxonSafehouseUnavailableError)) throw error;
    return [axonSafehouseSkippedFinding(label)];
  }
}
