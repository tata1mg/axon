"""Service observability uses in-memory exporters; never contacts a collector."""

import asyncio
import json
import logging
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from opentelemetry.trace import SpanKind, StatusCode
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from app import telemetry
from app.core import config
from app.core.logging import StructuredLoggingFormatter, _install_correlation_factory, configure_application_logging
from app.observability import NATIVE_TELEMETRY_DISABLED
from app.observability.context import REQUEST_ID
from app.observability.event_loop import EventLoopMonitor
from app.observability.middleware import BackendObservabilityMiddleware
from app.observability.privacy import SafeSpanExporter
from app.observability.runtime import initialize_service_telemetry
from app.telemetry import BackendTelemetrySettings, close_backend_telemetry, initialize_backend_telemetry


@pytest.fixture
def correlation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(logging, "_logRecordFactory", logging.getLogRecordFactory())
    _install_correlation_factory()


def memory_app(
    rate: float = 1,
) -> tuple[FastAPI, TracerProvider, MeterProvider, InMemorySpanExporter, InMemoryMetricReader]:
    exporter = InMemorySpanExporter()
    traces = TracerProvider(sampler=ParentBased(TraceIdRatioBased(rate)))
    traces.add_span_processor(SimpleSpanProcessor(SafeSpanExporter(exporter)))
    reader = InMemoryMetricReader()
    metrics = MeterProvider(metric_readers=[reader])
    app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)
    app.add_middleware(BackendObservabilityMiddleware)
    settings = BackendTelemetrySettings(
        "http://collector.test:4318", "backend", httpx_enabled=False, asyncpg_enabled=False
    )
    asyncio.run(initialize_service_telemetry(app, settings, traces, metrics))
    return app, traces, metrics, exporter, reader


def points(reader: InMemoryMetricReader) -> list[Any]:
    return [
        point
        for resource in reader.get_metrics_data().resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
        for point in metric.data.data_points
    ]


def test_json_logs_nested_span_correlation_and_context_reset(
    correlation: None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    app, traces, metrics, exporter, reader = memory_app()
    caplog.set_level(logging.INFO, logger="app")

    @app.get("/items/{item_id}")
    async def item(item_id: str) -> dict[str, bool]:
        logger = logging.getLogger("app.test")
        logger.info("before child")
        with app.state.service_telemetry.tracer.start_as_current_span("controlled-operation"):
            logger.info("inside child")
        logger.info("after child")
        return {"ok": True}

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://backend.test") as client:
            response = await client.get(
                "/items/private-value?token=secret",
                headers={
                    "Authorization": "Bearer secret",
                    "X-Request-ID": "shared-request",
                    "traceparent": "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
                },
            )
            assert response.headers["x-request-id"] == "shared-request"
        assert REQUEST_ID.get() is None
        assert not trace.get_current_span().get_span_context().is_valid

    try:
        asyncio.run(run())
        spans = exporter.get_finished_spans()
        server = next(span for span in spans if span.kind == SpanKind.SERVER)
        assert server.name == "GET /items/{item_id}"
        # Callers cannot choose our trace ID; their context is kept only as a link.
        assert server.parent is None
        assert server.context.trace_id != int("1234567890abcdef1234567890abcdef", 16)
        assert [link.context.trace_id for link in server.links] == [int("1234567890abcdef1234567890abcdef", 16)]
        assert not server.events
        assert server.attributes["axon.response.completed"]
        records = [record for record in caplog.records if record.name == "app.test"]
        assert records[0].span_id == records[2].span_id != records[1].span_id
        formatter = StructuredLoggingFormatter("axon-backend", 3000)
        payloads = [json.loads(formatter.format(record)) for record in caplog.records if record.name.startswith("app")]
        assert all(payload["trace_id"] == format(server.context.trace_id, "032x") for payload in payloads)
        assert all(payload["request_id"] == "shared-request" for payload in payloads)
        assert all(payload["service_name"] == "axon-backend" for payload in payloads)
        assert "private-value" not in repr(payloads) + repr([dict(span.attributes) for span in spans])
        assert "secret" not in repr(payloads) + repr(points(reader))
        assert any(point.attributes.get("http.route") == "/items/{item_id}" for point in points(reader))
        assert any(getattr(point, "value", None) == 0 for point in points(reader))
    finally:
        traces.shutdown()
        metrics.shutdown()


def test_disabled_telemetry_still_correlates_safe_access_logs(
    correlation: None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)
    app.add_middleware(BackendObservabilityMiddleware)
    caplog.set_level(logging.INFO, logger="app.access")

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://backend.test") as client:
            responses = await asyncio.gather(
                *[
                    client.get("/secret-value?key=secret", headers={"x-request-id": value})
                    for value in ("valid-id", "invalid id")
                ]
            )
        assert responses[0].headers["x-request-id"] == "valid-id"
        assert responses[1].headers["x-request-id"] != "invalid id"
        assert REQUEST_ID.get() is None

    asyncio.run(run())
    records = [record for record in caplog.records if record.name == "app.access"]
    assert len(records) == 2
    assert all(record.path == "<unmatched>" and record.trace_id is None for record in records)
    assert records[0].request_id != records[1].request_id


@pytest.mark.parametrize("parent_sampled", [False, True])
def test_caller_traceparent_cannot_force_sampling(parent_sampled: bool) -> None:
    app, traces, metrics, exporter, _ = memory_app(rate=0)

    @app.get("/ping")
    async def ping() -> dict[str, bool]:
        return {"ok": True}

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://backend.test") as client:
            await client.get(
                "/ping",
                headers={
                    "traceparent": "00-1234567890abcdef1234567890abcdef-1234567890abcdef-"
                    + ("01" if parent_sampled else "00"),
                },
            )

    try:
        asyncio.run(run())
        assert not exporter.get_finished_spans()
    finally:
        traces.shutdown()
        metrics.shutdown()


@pytest.mark.parametrize("failure", ["exception", "stream", "cancel"])
def test_streaming_failures_and_cancellation_are_content_free(failure: str) -> None:
    app, traces, metrics, exporter, reader = memory_app()

    @app.get("/fail")
    async def fail() -> StreamingResponse:
        if failure == "exception":
            raise ValueError("secret-prompt")
        if failure == "cancel":
            raise asyncio.CancelledError()

        async def stream():  # noqa: ANN202 - async generator fixture
            yield b"first chunk"
            raise ValueError("secret-prompt")

        return StreamingResponse(stream())

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://backend.test") as client:
            try:
                await client.get("/fail")
            except (ValueError, asyncio.CancelledError):
                pass
        assert REQUEST_ID.get() is None

    try:
        asyncio.run(run())
        span = exporter.get_finished_spans()[0]
        assert span.status.status_code == (StatusCode.UNSET if failure == "cancel" else StatusCode.ERROR)
        assert not span.events
        assert "secret-prompt" not in repr(dict(span.attributes)) + repr(points(reader))
        assert not span.attributes["axon.response.completed"]
    finally:
        traces.shutdown()
        metrics.shutdown()


@pytest.mark.parametrize("library", ["httpx", "asyncpg"])
def test_dependency_exporter_strips_urls_sql_headers_and_exception_values(library: str) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(SafeSpanExporter(exporter)))
    try:
        tracer = provider.get_tracer(f"opentelemetry.instrumentation.{library}")
        with pytest.raises(ValueError):
            with tracer.start_as_current_span(
                "SELECT" if library == "asyncpg" else "GET",
                attributes={
                    "http.method": "GET",
                    "http.url": "https://user:secret@host.test/private?key=secret",
                    "url.full": "https://host.test/private?key=secret",
                    "db.statement": "SELECT 'secret'",
                    "db.query.text": "SELECT 'secret'",
                    "db.system": "postgresql",
                    "http.request.header.authorization": ["Bearer secret"],
                },
            ):
                raise ValueError("secret")
        span = exporter.get_finished_spans()[0]
        assert "secret" not in span.to_json()
        assert "private" not in span.to_json()
        assert span.status.description is None
        assert span.events[0].attributes == {"exception.type": "ValueError"}
        assert span.name == ("POSTGRESQL SELECT" if library == "asyncpg" else "GET")
    finally:
        provider.shutdown()


@pytest.mark.parametrize("protocol", ["grpc", "http/protobuf"])
@pytest.mark.parametrize("metrics_enabled", [False, True])
def test_export_protocol_lifecycle_and_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    protocol: str,
    metrics_enabled: bool,
) -> None:
    import opentelemetry.exporter.otlp.proto.grpc.metric_exporter as grpc_metrics
    import opentelemetry.exporter.otlp.proto.grpc.trace_exporter as grpc_traces

    settings = BackendTelemetrySettings(
        "http://collector.test:4317" if protocol == "grpc" else "https://collector.test:4318/otel",
        "axon-backend",
        {"Authorization": "Bearer secret"},
        protocol=protocol,
        metrics_enabled=metrics_enabled,
        event_loop_monitoring=True,
        sampling_rate=1,
    )
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(backend_telemetry=settings))
    exporter = InMemorySpanExporter()
    traces = Mock(return_value=exporter)
    metric_exporter = Mock()
    monkeypatch.setattr(grpc_traces if protocol == "grpc" else telemetry, "OTLPSpanExporter", traces)
    monkeypatch.setattr(grpc_metrics if protocol == "grpc" else telemetry, "OTLPMetricExporter", metric_exporter)
    reader = InMemoryMetricReader()
    reader_factory = Mock(return_value=reader)
    monkeypatch.setattr(telemetry, "PeriodicExportingMetricReader", reader_factory)
    global_traces, global_metrics = trace.get_tracer_provider(), telemetry.metrics.get_meter_provider()
    app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)

    async def run() -> None:
        await initialize_backend_telemetry(app)
        runtime = app.state.service_telemetry
        providers = app.state.backend_telemetry_providers
        await initialize_backend_telemetry(app)
        assert app.state.backend_telemetry_providers is providers
        assert HTTPXClientInstrumentor().is_instrumented_by_opentelemetry
        assert AsyncPGInstrumentor().is_instrumented_by_opentelemetry
        assert (runtime.monitor is not None) is metrics_enabled
        monitor_task = runtime.monitor.task if runtime.monitor else None
        with app.state.product_telemetry.tracer.start_as_current_span("product"):
            pass
        await close_backend_telemetry(app)
        await close_backend_telemetry(app)
        assert app.state.service_telemetry is None
        assert not app.state.backend_telemetry_providers
        assert not HTTPXClientInstrumentor().is_instrumented_by_opentelemetry
        assert not AsyncPGInstrumentor().is_instrumented_by_opentelemetry
        if monitor_task:
            assert monitor_task.done()

    asyncio.run(run())
    assert trace.get_tracer_provider() is global_traces
    assert telemetry.metrics.get_meter_provider() is global_metrics
    assert traces.call_count == 1
    assert metric_exporter.call_count == int(metrics_enabled)
    assert reader_factory.call_count == int(metrics_enabled)
    options = traces.call_args.kwargs
    if protocol == "grpc":
        assert options["endpoint"].endswith(":4317") and options["insecure"] is True
        assert options["headers"] == {"authorization": "Bearer secret"}
    else:
        assert options["endpoint"].endswith("/otel/v1/traces")
    span = exporter.get_finished_spans()[0]
    assert span.attributes["sample_rate"] == 1
    assert span.resource.attributes["service.name"] == "axon-backend"


def test_metric_exporter_construction_failure_closes_existing_tracer(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = BackendTelemetrySettings("http://collector.test", "test")
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(backend_telemetry=settings))
    exporter = InMemorySpanExporter()
    shutdown = Mock(wraps=exporter.shutdown)
    monkeypatch.setattr(exporter, "shutdown", shutdown)
    monkeypatch.setattr(telemetry, "OTLPSpanExporter", Mock(return_value=exporter))
    monkeypatch.setattr(telemetry, "OTLPMetricExporter", Mock(side_effect=RuntimeError("metric construction failed")))
    app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)
    with pytest.raises(RuntimeError, match="metric construction failed"):
        asyncio.run(initialize_backend_telemetry(app))
    shutdown.assert_called_once()
    assert not app.state.backend_telemetry_providers
    assert getattr(app.state, "service_telemetry", None) is None


def test_disabled_backend_initialization_and_partial_failure_cleanup(monkeypatch: pytest.MonkeyPatch) -> None:
    app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(backend_telemetry=None))
    factory = Mock(side_effect=AssertionError("disabled telemetry created an exporter"))
    monkeypatch.setattr(telemetry, "OTLPSpanExporter", factory)
    asyncio.run(initialize_backend_telemetry(app))
    factory.assert_not_called()
    assert getattr(app.state, "service_telemetry", None) is None

    settings = BackendTelemetrySettings("http://collector.test", "test", metrics_enabled=False)
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(backend_telemetry=settings))
    exporter = InMemorySpanExporter()
    monkeypatch.setattr(telemetry, "OTLPSpanExporter", Mock(return_value=exporter))
    monkeypatch.setattr(AsyncPGInstrumentor, "instrument", Mock(side_effect=RuntimeError("instrument failure")))
    with pytest.raises(RuntimeError, match="instrument failure"):
        asyncio.run(initialize_backend_telemetry(app))
    assert not HTTPXClientInstrumentor().is_instrumented_by_opentelemetry
    assert app.state.service_telemetry is None
    assert not app.state.backend_telemetry_providers


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("METRICS_ENABLED", "true"),
        ("HTTPX_ENABLED", 1),
        ("ASYNCPG_ENABLED", None),
        ("EVENT_LOOP_MONITORING", []),
        ("EVENT_LOOP_MONITOR_INTERVAL", 0),
        ("EVENT_LOOP_MONITOR_INTERVAL", float("nan")),
        ("EVENT_LOOP_MONITOR_BLOCKING_THRESHOLD", True),
        ("ENDPOINT", "http://user:secret@collector:4317"),
        ("ENDPOINT", "http://collector:4317/path"),
        ("ENDPOINT", "http://collector:4317?key=secret"),
    ],
)
def test_invalid_service_telemetry_configuration(key: str, value: Any) -> None:
    with pytest.raises(ValueError):
        telemetry.parse_backend_telemetry(
            {
                "NAME": "test",
                "OPEN_TELEMETRY": {
                    "ENABLED": True,
                    "PROTOCOL": "grpc",
                    "ENDPOINT": "http://collector:4317",
                    key: value,
                },
            }
        )


def test_logging_configuration_and_safe_exception_formatting(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    correlation: None,
) -> None:
    logger = logging.Logger("app")
    monkeypatch.setitem(logging.Logger.manager.loggerDict, "app", logger)
    settings = SimpleNamespace(name="axon-backend", port=3000, log_level="INFO", log_format="json")
    configure_application_logging(settings)
    configure_application_logging(settings)
    assert len(logger.handlers) == 1
    try:
        raise ValueError("secret-prompt")
    except ValueError:
        logger.exception("controlled error")
    payload = json.loads(capsys.readouterr().err)
    assert payload["error_type"] == "ValueError"
    assert payload["traceback"] and payload["service_name"] == "axon-backend"
    assert "secret-prompt" not in repr(payload)


def test_event_loop_metrics_and_shutdown() -> None:
    reader = InMemoryMetricReader()
    metrics = MeterProvider(metric_readers=[reader])

    async def run() -> None:
        monitor = EventLoopMonitor(metrics.get_meter("test"), interval=0.01, blocking_threshold=0.01)
        monitor.start()
        task = monitor.task
        monitor.start()
        assert monitor.task is task
        await asyncio.sleep(0.04)
        assert monitor.active_tasks > 0
        assert monitor.lag_ms >= 0
        assert points(reader)
        await monitor.stop()
        await monitor.stop()
        assert task.done() and monitor.task is None

    try:
        asyncio.run(run())
    finally:
        metrics.shutdown()


def test_mounted_proxy_paths_are_bounded() -> None:
    app, traces, metrics, exporter, _ = memory_app()

    async def proxy(scope: Scope, receive: Receive, send: Send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    app.mount("/litellm", proxy)

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://backend.test") as client:
            await client.get("/litellm/key/info?key=secret")
            await client.get("/litellm/files/private-id")

    try:
        asyncio.run(run())
        assert [span.attributes["http.route"] for span in exporter.get_finished_spans()] == [
            "/litellm/key/info",
            "/litellm/{path}",
        ]
    finally:
        traces.shutdown()
        metrics.shutdown()


def test_unhandled_exception_logs_keep_request_and_trace_correlation(
    correlation: None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    app, traces, metrics, exporter, _ = memory_app()
    caplog.set_level(logging.ERROR, logger="uvicorn.error")

    @app.get("/boom")
    async def boom() -> None:
        raise ValueError("secret-prompt")

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://backend.test") as client:
            with pytest.raises(ValueError) as raised:
                await client.get("/boom", headers={"x-request-id": "failing-request"})
        assert REQUEST_ID.get() is None
        # Mirrors uvicorn logging the escaped exception after the request context ends.
        logging.getLogger("uvicorn.error").error("Exception in ASGI application", exc_info=raised.value)

    try:
        asyncio.run(run())
        server = exporter.get_finished_spans()[0]
        record = next(record for record in caplog.records if record.name == "uvicorn.error")
        assert record.request_id == "failing-request"
        assert record.trace_id == format(server.context.trace_id, "032x")
        assert record.span_id == format(server.context.span_id, "016x")
    finally:
        traces.shutdown()
        metrics.shutdown()


def test_event_loop_max_lag_resets_each_collection() -> None:
    reader = InMemoryMetricReader()
    metrics = MeterProvider(metric_readers=[reader])

    def max_lag() -> float:
        return next(
            point.value
            for resource in reader.get_metrics_data().resource_metrics
            for scope in resource.scope_metrics
            for metric in scope.metrics
            if metric.name == "asyncio.eventloop.max_lag"
            for point in metric.data.data_points
        )

    try:
        monitor = EventLoopMonitor(metrics.get_meter("test"), interval=0.01, blocking_threshold=0.01)
        monitor.lag_ms, monitor.max_lag_ms = 1.0, 800.0
        assert max_lag() == 800.0
        assert max_lag() == 1.0
    finally:
        metrics.shutdown()


def test_route_templates_are_memoized_and_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.observability import middleware

    app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)

    @app.get("/items/{item_id}")
    async def item(item_id: str) -> dict[str, bool]:
        return {"ok": True}

    calls = Mock(wraps=middleware.route_template)
    monkeypatch.setattr(middleware, "route_template", calls)
    monkeypatch.setattr(middleware, "ROUTE_TEMPLATE_CACHE_SIZE", 2)
    observability = BackendObservabilityMiddleware(app, access_log=False)

    def scope(path: str) -> dict[str, Any]:
        return {"type": "http", "app": app, "method": "GET", "path": path, "root_path": "", "headers": []}

    assert observability._route_template(scope("/items/1")) == "/items/{item_id}"
    assert observability._route_template(scope("/items/1")) == "/items/{item_id}"
    assert calls.call_count == 1
    for path in ("/items/2", "/items/3"):
        observability._route_template(scope(path))
    assert len(observability._templates) == 2
    assert observability._route_template(scope("/" + "x" * 600)) == "<unmatched>"
    assert len(observability._templates) == 2
