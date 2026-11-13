import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxonSafehouseAuthorization } from "../src/axon-safehouse/policy.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

// Test only: never download or run the real Safehouse runtime; record that it was prepared.
let prepared = 0;
const launchModule = await import("../src/axon-safehouse/launch.ts");
mock.module("../src/axon-safehouse/launch.ts", () => ({
  ...launchModule,
  async createAxonSafehouseResources() {
    prepared += 1;
    return {
      baseline: "(version 1)",
      runDirectory: "/nonexistent",
      temporary: "/nonexistent",
      networkProxies: new Map(),
      certificateEnvironment: {},
      packageScans: new Map(),
      dispose() {},
    };
  },
}));
const { createAxonSafehouseSession } = await import("../src/axon-safehouse/session.ts");

let root: string;
let warnings: string[];
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "axon-safehouse-opt-out-")));
  prepared = 0;
  warnings = [];
  errorSpy = spyOn(console, "error").mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
});
afterEach(async () => {
  errorSpy.mockRestore();
  await rm(root, { recursive: true, force: true });
});
afterAll(() => mock.restore());

function authorization(
  overrides: Partial<AxonSafehouseAuthorization["policy"]>,
): AxonSafehouseAuthorization {
  return {
    policy: {
      schemaVersion: 1,
      required: true,
      engine: "safehouse",
      policyId: "test",
      allowAdditionalReadPaths: true,
      allowAdditionalWritePaths: true,
      protectedPaths: [],
      readPaths: [],
      writePaths: [],
      ...overrides,
    },
  };
}

async function session(
  policy: Partial<AxonSafehouseAuthorization["policy"]>,
  request: { flag?: boolean; env?: string } = {},
) {
  const paths = resolveAxonPaths({ HOME: join(root, "home") });
  const created = await createAxonSafehouseSession(
    {
      cwd: root,
      environment: request.env === undefined ? {} : { AXON_DISABLE_SAFEHOUSE: request.env },
      paths,
      ...(request.flag ? { safehouseOptOutRequested: true } : {}),
    },
    authorization(policy),
  );
  created.dispose();
  return created;
}

describe.skipIf(process.platform !== "darwin")("local Safehouse opt-out", () => {
  test("is ignored unless the backend allows it", async () => {
    for (const request of [{ flag: true }, { env: "true" }]) {
      expect((await session({}, request)).disabled).toBe(false);
    }
    expect(prepared).toBe(2);
    expect(warnings.some((line) => line.includes("--no-safehouse is ignored"))).toBe(true);
    expect(warnings.some((line) => line.includes("AXON_DISABLE_SAFEHOUSE is ignored"))).toBe(true);
  });

  test("is honored when the backend allows it", async () => {
    for (const request of [{ flag: true }, { env: "1" }]) {
      expect((await session({ allowLocalOptOut: true }, request)).disabled).toBe(true);
    }
    expect(prepared).toBe(0);
  });

  test("allowing it does not disable Safehouse without a request", async () => {
    expect((await session({ allowLocalOptOut: true })).disabled).toBe(false);
    expect(prepared).toBe(1);
    expect(warnings).toEqual([]);
  });

  test("a backend policy that does not require Safehouse disables it for everyone", async () => {
    expect((await session({ required: false })).disabled).toBe(true);
    expect(prepared).toBe(0);
  });
});
