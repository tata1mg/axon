import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  describeEnvironment,
  normalizeWorkflowName,
  PI_ORG_TELEMETRY_VERSION,
  readExtensionVersion,
  readPiVersion,
} from "../src/environment.ts";
import { isolateTelemetryEnvironment } from "./helpers.ts";

isolateTelemetryEnvironment();

test("uses the version embedded in the standalone Axon extension", () => {
  assert.equal(readExtensionVersion(), PI_ORG_TELEMETRY_VERSION);
  assert.equal(readExtensionVersion(), "0.6.0-axon.1");
});

test("falls back when pi cannot be imported", async () => {
  assert.equal(
    await readPiVersion(async () => {
      throw new Error("not resolvable");
    }),
    undefined,
  );
  assert.equal(await readPiVersion(async () => ({ VERSION: 42 })), undefined);
  assert.equal(await readPiVersion(async () => ({ VERSION: "0.85.1" })), "0.85.1");
});

test("includes the configured CLI version without inheriting it into other tests", () => {
  process.env.PI_AXON_CLI_VERSION = "0.2.6";
  assert.equal(describeEnvironment().cliVersion, "0.2.6");
});

test("omits invalid CLI version values", () => {
  process.env.PI_AXON_CLI_VERSION = "invalid version";
  assert.equal("cliVersion" in describeEnvironment(), false);
});

test("reads the workflow tag from AXON_WORKFLOW and omits it when unset", () => {
  assert.equal("workflowName" in describeEnvironment(), false);
  process.env.AXON_WORKFLOW = " PR-Review ";
  assert.equal(describeEnvironment().workflowName, "pr-review");
});

test("accepts only short, label-safe workflow names", () => {
  assert.equal(normalizeWorkflowName("nightly.dependency_bump-v2"), "nightly.dependency_bump-v2");
  assert.equal(normalizeWorkflowName("a".repeat(64)), "a".repeat(64));
  for (const invalid of [
    undefined,
    "",
    "   ",
    "a".repeat(65),
    "pr review",
    "team/pr-review",
    "-leading-dash",
    ".hidden",
    "pr\nreview",
    "émoji",
  ])
    assert.equal(normalizeWorkflowName(invalid), undefined, JSON.stringify(invalid));
});

test("maps platform and arch to semantic-convention values", () => {
  const environment = describeEnvironment(
    "0.85.1",
    "0.2.0",
    "win32",
    "x64",
    { node: "22.19.0" } as NodeJS.ProcessVersions,
    "windows_terminal",
  );
  assert.deepEqual(environment, {
    extensionVersion: "0.2.0",
    piVersion: "0.85.1",
    osType: "windows",
    hostArch: "amd64",
    runtimeName: "node",
    runtimeVersion: "22.19.0",
    terminalType: "windows_terminal",
  });
  const bun = describeEnvironment(undefined, "0.2.0", "darwin", "arm64", {
    node: "22.0.0",
    bun: "1.2.0",
  } as unknown as NodeJS.ProcessVersions);
  assert.equal(bun.runtimeName, "bun");
  assert.equal(bun.runtimeVersion, "1.2.0");
  assert.equal(bun.osType, "darwin");
  assert.equal("piVersion" in bun, false);
});
