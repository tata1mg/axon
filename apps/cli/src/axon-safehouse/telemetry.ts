import { join } from "node:path";

import type { AxonPaths } from "../product/paths.ts";
import { atomicJson, readJson } from "../sessions/files.ts";
import {
  emitProductEvent,
  type PRODUCT_STAGES,
  type ProductEvent,
  type ProductOutcome,
  type SafehouseChange,
  type SafehouseSource,
} from "../telemetry/product-events.ts";
import type { AxonSafehousePolicy } from "./contracts.ts";
import type { FilesystemPreferences } from "./filesystem.ts";

// Content-free by design: stages, outcomes and fixed reason codes only. Never pass paths,
// hosts, rule contents or policy contents. `policyId` is a backend-defined, validated slug.

type SafehouseStage = (typeof PRODUCT_STAGES)["safehouse"][number];
type SafehouseDetails = Pick<
  ProductEvent,
  "reason" | "durationMs" | "policyVersion" | "safehouseSource" | "safehouseChange"
>;

export function recordSafehouseEvent(
  stage: SafehouseStage,
  outcome: ProductOutcome,
  details: SafehouseDetails = {},
): void {
  emitProductEvent({ category: "safehouse", stage, outcome, ...details });
}

const failureReasons = new WeakMap<object, string>();

/** Attach a fixed telemetry reason code to an error without changing its message. */
export function withSafehouseReason<T extends object>(error: T, reason: string): T {
  failureReasons.set(error, reason);
  return error;
}

export function safehouseFailureReason(error: unknown): string {
  return (
    (error !== null && typeof error === "object" && failureReasons.get(error)) || "unavailable"
  );
}

/** Times one Safehouse authorization and records its outcome and policy version. */
export async function measureSafehouseAuthorization<
  T extends { readonly policy: AxonSafehousePolicy },
>(authorize: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const authorization = await authorize();
    recordSafehouseEvent("authorize", "success", {
      durationMs: Date.now() - startedAt,
      policyVersion: authorization.policy.policyId,
    });
    return authorization;
  } catch (error) {
    recordSafehouseEvent("authorize", "failed", {
      reason: safehouseFailureReason(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

/**
 * Record when this machine first sees a backend policy or sees a different one. Only the
 * policy ID is stored. Best effort: telemetry state never affects a launch.
 */
export async function recordSafehousePolicySeen(
  paths: AxonPaths,
  policy: AxonSafehousePolicy,
): Promise<void> {
  const path = join(paths.home, "safehouse-policy-seen.json");
  try {
    let previous: unknown;
    try {
      previous = ((await readJson(path)) as { policyId?: unknown } | undefined)?.policyId;
    } catch {
      previous = undefined;
    }
    if (previous === policy.policyId) return;
    recordSafehouseEvent("policy", "success", {
      reason: typeof previous === "string" ? "changed" : "first_seen",
      policyVersion: policy.policyId,
    });
    await atomicJson(path, { schemaVersion: 1, policyId: policy.policyId });
  } catch {
    /* Telemetry state is optional. */
  }
}

/** The kinds of change between two saved settings, in a stable order. */
export function safehouseSettingsChanges(
  original: FilesystemPreferences,
  updated: FilesystemPreferences,
): SafehouseChange[] {
  const added = (before: readonly string[], after: readonly string[]) =>
    after.some((entry) => !before.includes(entry));
  const changes: SafehouseChange[] = [];
  if (original.projectMode !== updated.projectMode) changes.push("mode");
  if (added(original.readPaths, updated.readPaths)) changes.push("rule_read");
  if (added(original.writePaths, updated.writePaths)) changes.push("rule_write");
  if (added(original.denyPaths, updated.denyPaths)) changes.push("rule_deny");
  const rules = (preferences: FilesystemPreferences) => [
    ...preferences.readPaths,
    ...preferences.writePaths,
    ...preferences.denyPaths,
  ];
  // A path moved between lists is a change of kind, not a revocation.
  if (added(rules(updated), rules(original))) changes.push("rule_revoke");
  if (
    JSON.stringify([...original.blockedHosts].sort()) !==
    JSON.stringify([...updated.blockedHosts].sort())
  )
    changes.push("blocked_hosts");
  return changes;
}

/** One event per kind of change, so dashboards can count edits without seeing their content. */
export function recordSafehouseSettingsChanges(
  original: FilesystemPreferences,
  updated: FilesystemPreferences,
  source: SafehouseSource,
  outcome: ProductOutcome,
  reason?: string,
): void {
  for (const change of safehouseSettingsChanges(original, updated))
    recordSafehouseEvent("config_change", outcome, {
      safehouseSource: source,
      safehouseChange: change,
      ...(reason ? { reason } : {}),
    });
}
