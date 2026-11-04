import { mock } from "bun:test";
import { createFixtureAxonSafehouse, withFixtureAxonSafehouse } from "./launcher-axon-safehouse.ts";

// Explicitly loaded by test subprocesses, never by the product entry point.
const sessionModule = await import("../../src/axon-safehouse/session.ts");
mock.module("../../src/axon-safehouse/session.ts", () => ({
  ...sessionModule,
  createAxonSafehouseSession: createFixtureAxonSafehouse,
  withAxonSafehouseSession: withFixtureAxonSafehouse,
}));
