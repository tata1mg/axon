"""Exercise real dependency wrappers against fake transports, without HTTP/DB I/O."""

import asyncio
import logging
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import APIRouter, FastAPI
from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode
from starlette.types import Message, Receive, Scope, Send

from app.observability import NATIVE_TELEMETRY_DISABLED
from app.observability.middleware import BackendObservabilityMiddleware
from app.observability.privacy import SafeSpanExporter
from app.observability.runtime import close_service_telemetry, initialize_service_telemetry
from app.telemetry import BackendTelemetrySettings


def test_httpx_and_asyncpg_are_children_of_backend_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    forwarded = []

    async def fake_http(self: httpx.AsyncHTTPTransport, request: httpx.Request) -> httpx.Response:
        forwarded.append(request)
        return httpx.Response(200, content=b"ok")

    async def fake_query(*args: Any, **kwargs: Any) -> str:
        return "ok"

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", fake_http)
    reader = InMemoryMetricReader()
    metrics = MeterProvider(metric_readers=[reader])
    exporter = InMemorySpanExporter()
    traces = TracerProvider()
    traces.add_span_processor(SimpleSpanProcessor(SafeSpanExporter(exporter)))
    app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)
    app.add_middleware(BackendObservabilityMiddleware)
    # Included APIRouter routes, not just routes declared directly on the app.
    router = APIRouter(prefix="/api")

    @router.get("/operations/{id}")
    async def operations(id: str) -> dict[str, bool]:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://upstream.test/private-id?key=secret",
                headers={
                    "authorization": "Bearer secret",
                },
            )
            assert response.status_code == 200
        connection = SimpleNamespace(
            _params=SimpleNamespace(database="axon", user="private-user"),
            _addr=("database.test", 5432),
        )
        result = await AsyncPGInstrumentor()._do_execute(
            fake_query,
            connection,
            ("SELECT 'secret'", "private-parameter"),
            {},
        )
        assert result == "ok"
        return {"ok": True}

    app.include_router(router, prefix="/v1")
    settings = BackendTelemetrySettings("http://collector.test", "test")

    async def run() -> None:
        await initialize_service_telemetry(app, settings, traces, metrics)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://backend.test"
            ) as client:
                response = await client.get("/v1/api/operations/private-value?key=secret")
                assert response.status_code == 200
        finally:
            await close_service_telemetry(app)

    try:
        asyncio.run(run())
        spans = exporter.get_finished_spans()
        server = next(span for span in spans if span.kind == SpanKind.SERVER)
        assert server.name == "GET /v1/api/operations/{id}"
        children = [span for span in spans if span.kind == SpanKind.CLIENT]
        assert len(children) == 2
        assert all(span.parent.span_id == server.context.span_id for span in children)
        assert all(span.context.trace_id == server.context.trace_id for span in children)
        assert forwarded[0].headers["traceparent"].split("-")[1] == format(server.context.trace_id, "032x")
        assert forwarded[0].url.query == b"key=secret"
        assert forwarded[0].headers["authorization"] == "Bearer secret"
        http = next(span for span in children if span.instrumentation_scope.name.endswith("httpx"))
        assert http.name == "GET upstream.test"
        assert http.attributes["http.url"] == http.attributes["url.full"] == "https://upstream.test/private-id"
        assert http.attributes["server.address"] == http.attributes["net.peer.name"] == "upstream.test"
        assert http.attributes["server.port"] == http.attributes["net.peer.port"] == 443
        database = next(span for span in children if span.instrumentation_scope.name.endswith("asyncpg"))
        assert database.attributes["server.address"] == "database.test"
        assert database.attributes["server.port"] == 5432
        assert database.attributes["db.system"] == database.attributes["db.system.name"] == "postgresql"
        serialized = "".join(span.to_json() for span in spans)
        assert "secret" not in serialized
        assert "private-user" not in serialized
        assert "private-value" not in serialized
        assert "private-parameter" not in serialized
        data = reader.get_metrics_data()
        assert "secret" not in repr(data)
        assert "private-id" not in repr(data)
    finally:
        traces.shutdown()
        metrics.shutdown()


def test_httpx_failures_export_real_exception_types_and_redacted_details(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fail_http(self: httpx.AsyncHTTPTransport, request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("upstream timed out token=secret-token", request=request)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", fail_http)
    exporter = InMemorySpanExporter()
    traces = TracerProvider()
    traces.add_span_processor(SimpleSpanProcessor(SafeSpanExporter(exporter)))
    metrics = MeterProvider()
    app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)
    app.add_middleware(BackendObservabilityMiddleware)

    @app.get("/fail")
    async def fail() -> None:
        async with httpx.AsyncClient() as client:
            await client.get("https://upstream.test/private-path?key=secret-key")

    async def run() -> None:
        settings = BackendTelemetrySettings("http://collector.test", "test", asyncpg_enabled=False)
        await initialize_service_telemetry(app, settings, traces, metrics)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://backend.test"
            ) as client:
                with pytest.raises(httpx.ReadTimeout):
                    await client.get("/fail")
        finally:
            await close_service_telemetry(app)

    try:
        asyncio.run(run())
        spans = exporter.get_finished_spans()
        assert {span.kind for span in spans} == {SpanKind.CLIENT, SpanKind.SERVER}
        for span in spans:
            assert span.status.status_code == StatusCode.ERROR
            assert span.attributes["error.type"].endswith("ReadTimeout")
            assert span.status.description == "upstream timed out token=[REDACTED]"
            assert span.events[0].attributes["exception.type"].endswith("ReadTimeout")
            assert span.events[0].attributes["exception.message"] == span.status.description
            assert "test_backend_instrumentation.py" in span.events[0].attributes["exception.stacktrace"]
            assert "secret" not in span.to_json()
            if span.kind == SpanKind.CLIENT:
                assert span.name == "GET upstream.test"
                assert span.attributes["http.url"] == "https://upstream.test/private-path"
                assert span.attributes["server.address"] == "upstream.test"
            else:
                assert "private-path" not in span.to_json()
    finally:
        traces.shutdown()
        metrics.shutdown()


def test_downstream_disconnect_does_not_turn_into_server_error(caplog: pytest.LogCaptureFixture) -> None:
    exporter = InMemorySpanExporter()
    traces = TracerProvider()
    traces.add_span_processor(SimpleSpanProcessor(SafeSpanExporter(exporter)))
    metrics = MeterProvider()
    app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)
    caplog.set_level(logging.INFO, logger="app.access")

    async def application(scope: Scope, receive: Receive, send: Send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"chunk", "more_body": True})

    async def disconnected_send(message: Message) -> None:
        if message["type"] == "http.response.body":
            raise OSError("private-downstream-error")

    async def receive() -> Message:
        return {"type": "http.request", "body": b""}

    async def run() -> None:
        settings = BackendTelemetrySettings("http://collector.test", "test", httpx_enabled=False, asyncpg_enabled=False)
        await initialize_service_telemetry(app, settings, traces, metrics)
        try:
            middleware = BackendObservabilityMiddleware(application)
            with pytest.raises(OSError):
                await middleware(
                    {
                        "type": "http",
                        "app": app,
                        "method": "GET",
                        "path": "/stream",
                        "headers": [],
                    },
                    receive,
                    disconnected_send,
                )
        finally:
            await close_service_telemetry(app)

    try:
        asyncio.run(run())
        span = exporter.get_finished_spans()[0]
        assert span.status.status_code.name == "UNSET"
        assert span.attributes["error.type"] == "client_disconnected"
        assert not span.attributes["axon.response.completed"]
        assert "private-downstream-error" not in span.to_json()
        record = next(record for record in caplog.records if record.name == "app.access")
        assert record.levelno == logging.INFO
    finally:
        traces.shutdown()
        metrics.shutdown()
