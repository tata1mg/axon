import { test } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolveConfig } from "../src/config.ts";
import { createOtelRuntime } from "../src/otel/runtime.ts";
import { AgentTelemetryTracker } from "../src/tracker.ts";
import { isolateTelemetryEnvironment } from "./helpers.ts";

isolateTelemetryEnvironment();

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP server address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("exports traces, metrics, and logs to environment-configured OTLP HTTP endpoints", async () => {
  const paths: string[] = [];
  const organizationHeaders: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    const header = request.headers["x-org-token"];
    organizationHeaders.push(Array.isArray(header) ? header.join(",") : header);
    request.resume();
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  const port = await listen(server);
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-org-token=test";
  process.env.PI_ORG_OTEL_DIAGNOSTICS = "false";

  try {
    const config = resolveConfig();
    assert.ok(config);
    const runtime = createOtelRuntime(config, {
      userId: "engineer@example.com",
      email: "engineer@example.com",
      source: "git_email",
    });
    const tracker = new AgentTelemetryTracker(runtime);
    tracker.startSession({
      sessionId: "session-1",
      project: "project",
      mode: "tui",
      reason: "startup",
      ephemeral: false,
      cwd: "/work/project",
    });
    tracker.startInteraction(10, 0);
    tracker.startRun();
    tracker.startTurn(0);
    tracker.startLlm({ provider: "openai", model: "gpt-5" });
    tracker.endLlm({ stopReason: "stop", usage: { input: 5, output: 2 } });
    tracker.endTurn("ok", { stopReason: "stop" }, 0);
    tracker.endRun("stop");
    tracker.endInteraction();
    tracker.endSession("quit");
    await runtime.shutdown();

    assert.ok(paths.includes("/v1/traces"), `missing traces request: ${paths.join(", ")}`);
    assert.ok(paths.includes("/v1/metrics"), `missing metrics request: ${paths.join(", ")}`);
    assert.ok(paths.includes("/v1/logs"), `missing logs request: ${paths.join(", ")}`);
    assert.ok(organizationHeaders.every((value) => value === "test"));
  } finally {
    await close(server);
  }
});

test("accepts the shortest allowed metric export interval", async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9";
  const config = resolveConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
    OTEL_METRIC_EXPORT_INTERVAL: "1000",
    PI_ORG_OTEL_DIAGNOSTICS: "false",
  });
  assert.ok(config);
  assert.equal(config.metricExportIntervalMs, 1_000);
  const runtime = createOtelRuntime(config, { userId: "u", source: "installation_id" }, undefined, {
    quiet: true,
  });
  await runtime.shutdown();
});
