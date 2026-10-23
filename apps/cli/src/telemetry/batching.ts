import type { TelemetryConfig } from "../cli/client-config.ts";

/** Shared managed batching for Pi and launcher telemetry; neither signal inherits local tuning. */
export function createTelemetryBatchEnvironment(
  telemetry: TelemetryConfig,
): Record<string, string> {
  const settings = {
    SCHEDULE_DELAY: telemetry.batchScheduleDelayMs,
    MAX_EXPORT_BATCH_SIZE: telemetry.maxExportBatchSize,
    MAX_QUEUE_SIZE: telemetry.maxQueueSize,
  };
  return Object.fromEntries(
    ["BSP", "BLRP"].flatMap((processor) =>
      Object.entries(settings).map(([suffix, value]) => [
        `OTEL_${processor}_${suffix}`,
        String(value),
      ]),
    ),
  );
}
