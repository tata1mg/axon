"""App-owned backend service and product telemetry, never request content."""

import asyncio
import math
import os
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI, Request
from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

from app.core.cli_config import _proxy_headers, collector_url
from app.observability.exceptions import record_safe_exception


@dataclass(frozen=True, slots=True)
class BackendTelemetrySettings:
    endpoint: str
    service_name: str
    headers: dict[str, str] = field(default_factory=dict, repr=False)
    sampling_rate: float = 0.1
    metric_export_interval_ms: int = 10000
    protocol: str = "http/protobuf"
    metrics_enabled: bool = True
    httpx_enabled: bool = True
    asyncpg_enabled: bool = True
    event_loop_monitoring: bool = False
    event_loop_monitor_interval: float = 0.1
    event_loop_blocking_threshold: float = 0.05


def _telemetry_features(section: dict[str, Any]) -> dict[str, Any]:
    values = {}
    for key, default in (
        ("METRICS_ENABLED", True),
        ("HTTPX_ENABLED", True),
        ("ASYNCPG_ENABLED", True),
        ("EVENT_LOOP_MONITORING", False),
    ):
        value = section.get(key, default)
        if not isinstance(value, bool):
            raise ValueError("Invalid telemetry feature flag")
        values[key.lower()] = value
    for key, name, default in (
        ("EVENT_LOOP_MONITOR_INTERVAL", "event_loop_monitor_interval", 0.1),
        ("EVENT_LOOP_MONITOR_BLOCKING_THRESHOLD", "event_loop_blocking_threshold", 0.05),
    ):
        value = section.get(key, default)
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not math.isfinite(value)
            or not 0.01 <= value <= 60
        ):
            raise ValueError("Invalid event loop monitoring interval")
        values[name] = value
    return values


def parse_backend_telemetry(raw: dict[str, Any]) -> BackendTelemetrySettings | None:
    section = raw.get("OPEN_TELEMETRY")
    if section is None:
        return None
    if not isinstance(section, dict) or not isinstance(section.get("ENABLED", False), bool):
        raise ValueError("Invalid OPEN_TELEMETRY configuration")
    if not section.get("ENABLED", False):
        return None
    protocol = section.get("PROTOCOL", "http/protobuf")
    if protocol not in {"http/protobuf", "grpc"}:
        raise ValueError("Backend telemetry requires OTLP/HTTP protobuf or gRPC")
    name = section.get("SERVICE_NAME", raw.get("NAME"))
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Invalid telemetry service name")
    rate = section.get("SAMPLING_RATE", 0.1)
    if isinstance(rate, bool) or not isinstance(rate, int | float) or not math.isfinite(rate) or not 0 <= rate <= 1:
        raise ValueError("Invalid telemetry sampling rate")
    interval = section.get("METRICS_EXPORT_INTERVAL_MILLIS", 10000)
    if isinstance(interval, bool) or not isinstance(interval, int) or not 1000 <= interval <= 300000:
        raise ValueError("Invalid telemetry export interval")
    endpoint = collector_url(section.get("ENDPOINT"))
    if protocol == "grpc" and urlsplit(endpoint).path not in {"", "/"}:
        raise ValueError("gRPC collector requires an origin without a path")
    return BackendTelemetrySettings(
        endpoint=endpoint,
        service_name=name.strip(),
        headers=_proxy_headers(section),
        sampling_rate=rate,
        metric_export_interval_ms=interval,
        protocol=protocol,
        **_telemetry_features(section),
    )


@dataclass
class ProductOperation:
    skipped: bool = False


class ProductTelemetry:
    def __init__(self, tracer: trace.Tracer, meter: metrics.Meter) -> None:
        self.tracer = tracer
        self.events = meter.create_counter("axon.recommender.events", unit="{event}")
        self.durations = meter.create_histogram("axon.recommender.duration", unit="s")
        self.scores = {
            name: meter.create_histogram(f"axon.recommender.{name}", unit="1")
            for name in (
                "complexity",
                "confidence",
                "high_complexity_probability",
                "needs_deep_reasoning",
                "prioritizes_speed",
                "candidate_count",
            )
        }

    def event(self, stage: str, outcome: str, identity: dict[str, str] | None = None, **values: str | float) -> None:
        # Only fixed, locally owned metadata. Numeric observations never become labels.
        attributes = {**(identity or {}), "component": "backend", "stage": stage, "outcome": outcome}
        for key in ("model", "policy_version", "reason"):
            if key in values:
                attributes[key] = values[key]
        try:
            self.events.add(1, attributes)
            trace.get_current_span().add_event(f"axon.recommender.{stage}", {**attributes, **values})
            if "duration" in values:
                self.durations.record(values["duration"], attributes)
            for key, histogram in self.scores.items():
                if key in values:
                    histogram.record(values[key], {**(identity or {}), "component": "backend", "stage": stage})
        except Exception:  # noqa: BLE001 - optional instrumentation must not fail the operation
            pass

    @contextmanager
    def operation(
        self, stage: str, identity: dict[str, str] | None = None, **values: str | float
    ) -> Iterator[ProductOperation]:
        started_at = time.monotonic()
        attributes = {**(identity or {}), "component": "backend", **values}
        # Record bounded, redacted details ourselves instead of automatic raw tracebacks.
        with self.tracer.start_as_current_span(
            f"axon.recommender.{stage}",
            attributes=attributes,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                operation = ProductOperation()
                yield operation
            except Exception as exc:
                record_safe_exception(span, exc)
                self.event(stage, "failed", identity, duration=time.monotonic() - started_at, reason="unavailable")
                raise
            else:
                if operation.skipped:
                    span.set_attribute("axon.skipped", True)
                self.event(
                    stage,
                    "skipped" if operation.skipped else "success",
                    identity,
                    duration=time.monotonic() - started_at,
                )


def product_telemetry(app: FastAPI | None = None) -> ProductTelemetry:
    configured = getattr(app.state, "product_telemetry", None) if app is not None else None
    return configured or ProductTelemetry(trace.get_tracer("axon-products"), metrics.get_meter("axon-products"))


async def verified_telemetry_identity(request: Request) -> dict[str, str]:
    """Reuse auth data; optional richer identity lookup must never fail the operation."""
    from app.clients.auth_service import get_auth_service_client

    auth = getattr(request.state, "auth_data", None)
    data = auth.model_dump() if auth is not None else {}
    identity = {"axon.user_id": str(auth.user_id), "user.id": str(auth.user_id)} if auth is not None else {}
    email = data.get("user_email")
    if not email and getattr(request.app.state, "product_telemetry", None) is not None:
        try:
            authorization = (
                f"Bearer {auth.session_refresh_token}"
                if auth and auth.session_refresh_token
                else request.headers["authorization"]
            )
            verified = await asyncio.wait_for(
                get_auth_service_client(request).verify_identity(authorization), timeout=0.5
            )
            if verified.get("status") not in {"VERIFIED", "EXPIRED"}:
                return identity
            email = verified.get("user_email")
            refreshed = verified.get("encrypted_session_data")
            if (
                verified.get("status") == "EXPIRED"
                and auth is not None
                and isinstance(refreshed, str)
                and 0 < len(refreshed) <= 16384
                and all(33 <= ord(c) <= 126 for c in refreshed)
            ):
                auth.session_refresh_token = refreshed
        except Exception:  # noqa: BLE001 - optional attribution must not fail the operation
            pass
    if (
        isinstance(email, str)
        and "@" in email
        and len(email) <= 320
        and not any(ord(c) < 32 or ord(c) == 127 for c in email)
    ):
        identity["user.email"] = email.strip()
    return identity


async def initialize_backend_telemetry(app: FastAPI) -> None:
    from app.core.config import get_settings

    settings = get_settings().backend_telemetry
    if settings is None or getattr(app.state, "backend_telemetry_providers", None):
        return
    try:
        await _initialize_backend_telemetry(app, settings)
    except BaseException:
        await close_backend_telemetry(app)
        raise


async def _initialize_backend_telemetry(app: FastAPI, settings: BackendTelemetrySettings) -> None:
    from app.observability.runtime import initialize_service_telemetry

    resource = Resource.create(
        {
            "service.name": settings.service_name,
            "service.version": os.getenv("RELEASE_TAG") or "dev-local",
            "service.instance.id": f"{os.getenv('HOSTNAME', 'backend')}-{os.getpid()}-{uuid4()}",
            "deployment.environment.name": os.getenv("ENVIRONMENT") or "local",
            "framework.name": "fastapi",
        }
    )
    from app.observability.privacy import SafeSpanExporter, SampleRateProcessor

    if settings.protocol == "grpc":
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter as GrpcMetricExporter
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter as GrpcSpanExporter

        options = {
            "endpoint": settings.endpoint,
            "headers": {key.lower(): value for key, value in settings.headers.items()},
            "insecure": settings.endpoint.startswith("http://"),
            "timeout": 2,
        }
        span_exporter = GrpcSpanExporter(**options)

        def metric_exporter_factory() -> GrpcMetricExporter:
            return GrpcMetricExporter(**options)
    else:
        span_exporter = OTLPSpanExporter(endpoint=f"{settings.endpoint}/v1/traces", headers=settings.headers, timeout=2)

        def metric_exporter_factory() -> OTLPMetricExporter:
            return OTLPMetricExporter(endpoint=f"{settings.endpoint}/v1/metrics", headers=settings.headers, timeout=2)

    tracer_provider = TracerProvider(resource=resource, sampler=ParentBased(TraceIdRatioBased(settings.sampling_rate)))
    tracer_provider.add_span_processor(SampleRateProcessor(settings.sampling_rate))
    tracer_provider.add_span_processor(BatchSpanProcessor(SafeSpanExporter(span_exporter)))
    app.state.backend_telemetry_providers = (tracer_provider,)
    readers = []
    if settings.metrics_enabled:
        readers.append(
            PeriodicExportingMetricReader(
                metric_exporter_factory(),
                export_interval_millis=settings.metric_export_interval_ms,
                export_timeout_millis=min(2000, settings.metric_export_interval_ms),
            )
        )
    views = [
        View(
            instrument_name="axon.recommender.duration",
            aggregation=ExplicitBucketHistogramAggregation([0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]),
        ),
        View(
            instrument_name="axon.recommender.complexity",
            aggregation=ExplicitBucketHistogramAggregation([0, 0.5, 1, 1.5, 2, 2.5, 3]),
        ),
    ]
    views.extend(
        View(
            instrument_name=f"axon.recommender.{name}",
            aggregation=ExplicitBucketHistogramAggregation([0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]),
        )
        for name in ("confidence", "high_complexity_probability", "needs_deep_reasoning", "prioritizes_speed")
    )
    views.append(
        View(
            instrument_name="axon.recommender.candidate_count",
            aggregation=ExplicitBucketHistogramAggregation([1, 2, 4, 8, 16, 32, 64, 128, 250]),
        )
    )
    views.append(
        View(
            instrument_name="http.client.*",
            attribute_keys={
                "http.method",
                "http.request.method",
                "http.status_code",
                "http.response.status_code",
                "server.address",
                "server.port",
                "net.peer.name",
                "net.peer.port",
                "error.type",
            },
        )
    )
    meter_provider = MeterProvider(resource=resource, metric_readers=readers, views=views)
    app.state.backend_telemetry_providers = (tracer_provider, meter_provider)
    await initialize_service_telemetry(app, settings, tracer_provider, meter_provider)
    app.state.product_telemetry = ProductTelemetry(
        tracer_provider.get_tracer("axon-products"), meter_provider.get_meter("axon-products")
    )


async def close_backend_telemetry(app: FastAPI) -> None:
    from app.observability.runtime import close_service_telemetry

    providers = getattr(app.state, "backend_telemetry_providers", ())
    app.state.product_telemetry = None
    app.state.backend_telemetry_providers = ()
    try:
        await close_service_telemetry(app)
    finally:
        for provider in providers:
            try:
                await asyncio.wait_for(asyncio.to_thread(provider.shutdown), timeout=5)
            except Exception:  # noqa: BLE001 - best-effort provider shutdown
                pass
