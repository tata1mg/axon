"""Worker-local OTel instruments and lifecycle; never replace global providers."""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from fastapi import FastAPI
from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.metrics import Histogram, UpDownCounter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import Tracer

from app.observability.event_loop import EventLoopMonitor

if TYPE_CHECKING:
    from app.telemetry import BackendTelemetrySettings


@dataclass
class ServiceTelemetry:
    tracer: Tracer
    duration: Histogram
    active: UpDownCounter
    instrumentors: list = field(default_factory=list)
    monitor: EventLoopMonitor | None = None


async def initialize_service_telemetry(
    app: FastAPI,
    settings: "BackendTelemetrySettings",
    traces: TracerProvider,
    metrics: MeterProvider,
) -> None:
    meter = metrics.get_meter("axon-backend")
    runtime = ServiceTelemetry(
        tracer=traces.get_tracer("axon-backend"),
        duration=meter.create_histogram(
            "http.server.request.duration",
            unit="s",
            explicit_bucket_boundaries_advisory=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
        ),
        active=meter.create_up_down_counter("http.server.active_requests", unit="{request}"),
    )
    app.state.service_telemetry = runtime
    # These libraries install process-wide wrappers. Own them explicitly so a
    # failed startup or reload doesn't leave stale providers/duplicate spans.
    for enabled, instrumentor in (
        (settings.httpx_enabled, HTTPXClientInstrumentor()),
        (settings.asyncpg_enabled, AsyncPGInstrumentor()),
    ):
        if not enabled:
            continue
        if instrumentor.is_instrumented_by_opentelemetry:
            raise RuntimeError("Backend dependency instrumentation is already owned by another application")
        instrumentor.instrument(tracer_provider=traces, meter_provider=metrics)
        runtime.instrumentors.append(instrumentor)
    if settings.metrics_enabled and settings.event_loop_monitoring:
        runtime.monitor = EventLoopMonitor(
            meter,
            settings.event_loop_monitor_interval,
            settings.event_loop_blocking_threshold,
        )
        runtime.monitor.start()


async def close_service_telemetry(app: FastAPI) -> None:
    runtime = getattr(app.state, "service_telemetry", None)
    app.state.service_telemetry = None
    if runtime is None:
        return
    try:
        if runtime.monitor is not None:
            await runtime.monitor.stop()
    finally:
        for instrumentor in reversed(runtime.instrumentors):
            instrumentor.uninstrument()
