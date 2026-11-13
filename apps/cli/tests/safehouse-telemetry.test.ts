import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AxonSafehousePolicy } from "../src/axon-safehouse/contracts.ts";
import type { FilesystemPreferences } from "../src/axon-safehouse/filesystem.ts";
import {
  measureSafehouseAuthorization,
  recordSafehousePolicySeen,
  safehouseFailureReason,
  safehouseSettingsChanges,
  withSafehouseReason,
} from "../src/axon-safehouse/telemetry.ts";
import { describeEnvironment } from "../src/harnesses/pi/telemetry/src/environment.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import {
  type ProductEvent,
  sanitizeProductEvent,
  subscribeProductEvents,
  takeProductEvents,
} from "../src/telemetry/product-events.ts";

const policy = (policyId: string): AxonSafehousePolicy => ({
  schemaVersion: 1,
  required: true,
  engine: "safehouse",
  policyId,
  allowAdditionalReadPaths: true,
  allowAdditionalWritePaths: true,
  protectedPaths: [],
  readPaths: [],
  writePaths: [],
});

const preferences = (overrides: Partial<FilesystemPreferences> = {}): FilesystemPreferences => ({
  schemaVersion: 1,
  projectMode: "read-write",
  readPaths: [],
  writePaths: [],
  denyPaths: [],
  blockedHosts: [],
  ...overrides,
});

let events: ProductEvent[] = [];
let unsubscribe: () => void = () => {};
beforeEach(() => {
  takeProductEvents();
  events = [];
  unsubscribe = subscribeProductEvents((event) => events.push(event));
});
afterEach(() => unsubscribe());

describe("Safehouse product events", () => {
  test("keep only fixed Safehouse dimensions and drop content", () => {
    expect(
      sanitizeProductEvent({
        category: "safehouse",
        stage: "config_change",
        outcome: "success",
        reason: "discarded",
        safehouseSource: "menu",
        safehouseChange: "rule_write",
        policyVersion: "default-v2",
      }),
    ).toEqual({
      category: "safehouse",
      stage: "config_change",
      outcome: "success",
      reason: "discarded",
      safehouseSource: "menu",
      safehouseChange: "rule_write",
      policyVersion: "default-v2",
    });
    // Paths, hosts and unknown values never survive as labels.
    expect(
      sanitizeProductEvent({
        category: "safehouse",
        stage: "access_request",
        outcome: "blocked",
        reason: "/Users/someone/secret",
        safehouseSource: "/tmp",
        safehouseChange: "example.com",
      }),
    ).toEqual({ category: "safehouse", stage: "access_request", outcome: "blocked" });
    // Safehouse dimensions belong only to the Safehouse category.
    expect(
      sanitizeProductEvent({
        category: "update",
        stage: "install",
        outcome: "success",
        safehouseSource: "menu",
      }),
    ).toEqual({ category: "update", stage: "install", outcome: "success" });
    expect(
      sanitizeProductEvent({ category: "safehouse", stage: "network_block", outcome: "blocked" }),
    ).toBeUndefined();
  });

  test("authorization records duration, policy version and a fixed failure reason", async () => {
    await measureSafehouseAuthorization(async () => ({ policy: policy("default-v1") }));
    await expect(
      measureSafehouseAuthorization(async () => {
        throw withSafehouseReason(new Error("private detail /Users/x"), "no_session");
      }),
    ).rejects.toThrow("private detail");
    await expect(
      measureSafehouseAuthorization(async () => {
        throw new Error("untagged");
      }),
    ).rejects.toThrow("untagged");
    expect(events.map(({ durationMs, ...event }) => [event, typeof durationMs])).toEqual([
      [
        {
          category: "safehouse",
          stage: "authorize",
          outcome: "success",
          policyVersion: "default-v1",
        },
        "number",
      ],
      [
        { category: "safehouse", stage: "authorize", outcome: "failed", reason: "no_session" },
        "number",
      ],
      [
        { category: "safehouse", stage: "authorize", outcome: "failed", reason: "unavailable" },
        "number",
      ],
    ]);
    expect(safehouseFailureReason(undefined)).toBe("unavailable");
    expect(safehouseFailureReason("text")).toBe("unavailable");
  });

  test("policy changes are recorded once per new policy ID", async () => {
    const home = await mkdtemp(join(tmpdir(), "axon-safehouse-telemetry-"));
    try {
      const paths = resolveAxonPaths({ AXON_HOME: home, HOME: home });
      await recordSafehousePolicySeen(paths, policy("default-v1"));
      await recordSafehousePolicySeen(paths, policy("default-v1"));
      await recordSafehousePolicySeen(paths, policy("default-v2"));
      expect(events).toEqual([
        {
          category: "safehouse",
          stage: "policy",
          outcome: "success",
          reason: "first_seen",
          policyVersion: "default-v1",
        },
        {
          category: "safehouse",
          stage: "policy",
          outcome: "success",
          reason: "changed",
          policyVersion: "default-v2",
        },
      ]);
      // Only the policy ID is stored locally.
      expect(await Bun.file(join(home, "safehouse-policy-seen.json")).json()).toEqual({
        schemaVersion: 1,
        policyId: "default-v2",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("access reviews for unknown or expired requests record a failed decision", async () => {
    const { runFilesystemAccessPrompt } = await import("../src/axon-safehouse/access-requests.ts");
    const home = await mkdtemp(join(tmpdir(), "axon-safehouse-access-"));
    try {
      const paths = resolveAxonPaths({ AXON_HOME: home, HOME: home });
      await expect(
        runFilesystemAccessPrompt(paths, home, "missing", {} as never, {
          signal: new AbortController().signal,
          authorize: async () => policy("default-v1"),
          source: "rpc",
        }),
      ).rejects.toThrow("expired");
      expect(events).toEqual([
        expect.objectContaining({
          category: "safehouse",
          stage: "access_decision",
          outcome: "failed",
          reason: "expired",
          safehouseSource: "rpc",
        }),
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("Safehouse settings change kinds", () => {
  test("report each kind of change without paths or hosts", () => {
    expect(safehouseSettingsChanges(preferences(), preferences())).toEqual([]);
    expect(
      safehouseSettingsChanges(
        preferences({ readPaths: ["/a"], blockedHosts: ["b.test", "a.test"] }),
        preferences({
          projectMode: "read-only",
          readPaths: ["/a", "/b"],
          writePaths: ["/c"],
          denyPaths: ["/d"],
          blockedHosts: ["a.test", "b.test"],
        }),
      ),
    ).toEqual(["mode", "rule_read", "rule_write", "rule_deny"]);
    expect(
      safehouseSettingsChanges(
        preferences({ readPaths: ["/a"], denyPaths: ["/d"] }),
        preferences({ blockedHosts: ["a.test"] }),
      ),
    ).toEqual(["rule_revoke", "blocked_hosts"]);
  });

  test("moving a path between read and write is not a revocation", () => {
    expect(
      safehouseSettingsChanges(
        preferences({ readPaths: ["/a"] }),
        preferences({ writePaths: ["/a"] }),
      ),
    ).toEqual(["rule_write"]);
  });
});

describe("Safehouse telemetry label", () => {
  const original = {
    marker: process.env["PI_AXON_SAFEHOUSE"],
    version: process.env["PI_AXON_CLI_VERSION"],
  };
  afterEach(() => {
    for (const [name, value] of [
      ["PI_AXON_SAFEHOUSE", original.marker],
      ["PI_AXON_CLI_VERSION", original.version],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("is enabled in sandboxed Pi, disabled in unsandboxed Axon Pi, and absent outside Axon", () => {
    process.env["PI_AXON_CLI_VERSION"] = "1.0.4";
    process.env["PI_AXON_SAFEHOUSE"] = "safehouse";
    expect(describeEnvironment("1.0.0", "0.0.0").safehouse).toBe("enabled");
    delete process.env["PI_AXON_SAFEHOUSE"];
    expect(describeEnvironment("1.0.0", "0.0.0").safehouse).toBe("disabled");
    delete process.env["PI_AXON_CLI_VERSION"];
    expect(describeEnvironment("1.0.0", "0.0.0").safehouse).toBeUndefined();
  });
});
