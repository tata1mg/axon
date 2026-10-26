import { mock } from "bun:test";
import { createFixtureSandbox, withFixtureSandbox } from "./launcher-sandbox.ts";

// Explicitly loaded by test subprocesses, never by the product entry point.
const sessionModule = await import("../../src/sandbox/session.ts");
mock.module("../../src/sandbox/session.ts", () => ({
  ...sessionModule,
  createSandboxSession: createFixtureSandbox,
  withSandboxSession: withFixtureSandbox,
}));
