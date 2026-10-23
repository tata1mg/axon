import { afterEach, beforeEach } from "bun:test";
import type { Attributes, Context } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { LogSeverity, TelemetryRuntime } from "../src/telemetry-types.ts";

/** Keep fallback tests independent of the Axon session running the test command. */
export function isolateTelemetryEnvironment(): void {
  const isTelemetryVariable = (name: string) =>
    /^(OTEL_|PI_ORG_OTEL_)/.test(name) || name === "PI_AXON_CLI_VERSION";
  let previous: NodeJS.ProcessEnv = {};
  beforeEach(() => {
    previous = {};
    for (const name of Object.keys(process.env).filter(isTelemetryVariable)) {
      previous[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of Object.keys(process.env).filter(isTelemetryVariable)) {
      delete process.env[name];
    }
    Object.assign(process.env, previous);
  });
}

export interface RecordedMetric {
  readonly kind: "count" | "record";
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly attributes: Attributes;
}

export interface RecordedLog {
  readonly severity: LogSeverity;
  readonly eventName: string;
  readonly body: string;
  readonly attributes: Attributes;
  readonly context?: Context;
}

export interface TestRuntimeFixture {
  readonly runtime: TelemetryRuntime;
  readonly metrics: RecordedMetric[];
  readonly logs: RecordedLog[];
  spans(): ReadableSpan[];
}

export function createTestRuntime(): TestRuntimeFixture {
  const commonAttributes: Attributes = {
    "user.id": "developer@example.com",
    "user.email": "developer@example.com",
    "pi.identity.source": "git_email",
  };
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    resource: resourceFromAttributes(commonAttributes),
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const metrics: RecordedMetric[] = [];
  const logs: RecordedLog[] = [];

  const runtime: TelemetryRuntime = {
    tracer: provider.getTracer("test"),
    commonAttributes,
    metrics: {
      count(name, value = 1, attributes = {}) {
        metrics.push({
          kind: "count",
          name,
          value,
          attributes: { ...commonAttributes, ...attributes },
        });
      },
      record(name, value, unit, attributes = {}) {
        metrics.push({
          kind: "record",
          name,
          value,
          unit,
          attributes: { ...commonAttributes, ...attributes },
        });
      },
    },
    logs: {
      emit(severity, eventName, body, attributes = {}, context) {
        logs.push({
          severity,
          eventName,
          body,
          attributes: { ...commonAttributes, ...attributes },
          ...(context ? { context } : {}),
        });
      },
    },
    async shutdown() {
      await provider.shutdown();
    },
  };

  return { runtime, metrics, logs, spans: () => exporter.getFinishedSpans() };
}
