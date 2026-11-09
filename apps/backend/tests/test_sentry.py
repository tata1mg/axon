"""Backend Sentry configuration and real SDK capture, using an in-memory transport."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
import sentry_sdk
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import NonRecordingSpan, SpanContext
from sentry_sdk.envelope import Envelope
from sentry_sdk.transport import Transport
from starlette.requests import ClientDisconnect
from starlette.responses import StreamingResponse
from uvicorn import Config
from uvicorn.lifespan.on import LifespanOn

from app import listeners
from app.core import config
from app.core.config import SentrySettings
from app.observability import NATIVE_TELEMETRY_DISABLED
from app.observability import sentry as sentry_observability
from app.observability.context import REQUEST_ID, bind_exception_correlation
from app.observability.middleware import BackendObservabilityMiddleware
from app.observability.sentry import before_breadcrumb, before_send, flush_sentry, sentry_lifespan, setup_sentry
from app.routers.cli_config import client_config

DSN = "https://private-key@sentry.example.test/42"
TRACE_ID = "1234567890abcdef1234567890abcdef"
SPAN_ID = "1234567890abcdef"
OTEL_CONTEXT = SpanContext(trace_id=int(TRACE_ID, 16), span_id=int(SPAN_ID, 16), is_remote=False)


@pytest.fixture
def configured_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[dict[str, Any], Path]]:
    raw = json.loads((config.BASE_DIR / "config_template.json").read_text())
    path = tmp_path / "config.json"
    path.write_text(json.dumps(raw))
    monkeypatch.setattr(config, "BASE_DIR", tmp_path)
    config.get_settings.cache_clear()
    try:
        yield raw, path
    finally:
        config.get_settings.cache_clear()


@pytest.mark.parametrize("section", [None, {}, {"DSN": ""}, {"DSN": " \t "}])
def test_missing_or_empty_dsn_disables_sentry(
    configured_settings: tuple[dict[str, Any], Path], monkeypatch: pytest.MonkeyPatch, section: dict | None
) -> None:
    raw, path = configured_settings
    raw.pop("SENTRY")
    if section is not None:
        raw["SENTRY"] = section
    path.write_text(json.dumps(raw))
    monkeypatch.setenv("SENTRY_DSN", DSN)
    initialize = Mock()
    monkeypatch.setattr(sentry_sdk, "init", initialize)
    settings = config.get_settings()
    assert settings.sentry is None
    setup_sentry(settings.sentry)
    initialize.assert_not_called()


def test_config_defaults_and_private_dsn(configured_settings: tuple[dict[str, Any], Path]) -> None:
    raw, path = configured_settings
    raw["SENTRY"] = {"DSN": f"  {DSN}  "}
    path.write_text(json.dumps(raw))
    settings = config.get_settings().sentry
    assert settings == SentrySettings(DSN)
    assert "private-key" not in repr(settings)
    assert "private-key" not in repr(config.get_settings())


@pytest.mark.parametrize(
    "section",
    [
        None,
        [],
        True,
        {"DSN": False},
        {"DSN": "https://private-key@sentry.example.test/not-a-project"},
        {"DSN": "ftp://private-key@sentry.example.test/42"},
        {"DSN": "https://sentry.example.test/42"},
        {"DSN": DSN, "ENVIRONMENT": ""},
        {"DSN": DSN, "SERVICE_NAME": 5},
        {"DSN": DSN, "CAPTURE_WARNING": "true"},
    ],
)
def test_invalid_config_is_rejected_without_exposing_dsn(
    configured_settings: tuple[dict[str, Any], Path], section: object
) -> None:
    raw, path = configured_settings
    raw["SENTRY"] = section
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match=r"config\.SENTRY") as error:
        config.get_settings()
    assert "private-key" not in str(error.value)


def test_configured_metadata_and_release(
    configured_settings: tuple[dict[str, Any], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    raw, path = configured_settings
    raw["SENTRY"] = {"DSN": DSN, "ENVIRONMENT": "staging", "SERVICE_NAME": "axon-api", "CAPTURE_WARNING": True}
    path.write_text(json.dumps(raw))
    monkeypatch.setenv("RELEASE_TAG", "axon-1.2.3")
    monkeypatch.setenv("SENTRY_ENVIRONMENT", "ignored")
    initialize, set_tag = Mock(), Mock()
    monkeypatch.setattr(sentry_sdk, "init", initialize)
    monkeypatch.setattr(sentry_sdk, "set_tag", set_tag)
    setup_sentry(config.get_settings().sentry)
    options = initialize.call_args.kwargs
    assert options["dsn"] == DSN
    assert options["environment"] == "staging"
    assert options["release"] == "axon-1.2.3"
    set_tag.assert_called_once_with("service_name", "axon-api")
    assert options["before_send"] is before_send
    assert options["before_breadcrumb"] is before_breadcrumb
    assert options["data_collection"]["user_info"] is False
    assert options["data_collection"]["http_bodies"] == []
    assert options["data_collection"]["frame_context_lines"] == 0
    assert options["include_local_variables"] is False
    assert options["include_source_context"] is False
    assert options["max_request_body_size"] == "never"
    assert options["auto_enabling_integrations"] is False
    assert options["traces_sample_rate"] == 0
    assert options["trace_propagation_targets"] == []
    assert options["enable_logs"] is False


def test_sentry_settings_are_never_published_to_cli(configured_settings: tuple[dict[str, Any], Path]) -> None:
    raw, path = configured_settings
    raw["SENTRY"] = {"DSN": DSN}
    path.write_text(json.dumps(raw))
    public = asyncio.run(client_config(config.get_settings())).model_dump_json(by_alias=True, exclude_none=True)
    assert "sentry" not in public.lower()
    assert "private-key" not in public


class MemoryTransport(Transport):
    def __init__(self) -> None:
        super().__init__()
        self.events: list[dict[str, Any]] = []

    def capture_envelope(self, envelope: Envelope) -> None:
        if event := envelope.get_event():
            self.events.append(event)


@contextmanager
def memory_sentry(monkeypatch: pytest.MonkeyPatch, capture_warning: bool = False) -> Iterator[MemoryTransport]:
    initialize = Mock()
    monkeypatch.setattr(sentry_sdk, "init", initialize)
    transport = MemoryTransport()
    with sentry_sdk.isolation_scope() as scope:
        setup_sentry(SentrySettings(DSN, environment="test", capture_warning=capture_warning))
        client = sentry_sdk.Client(**initialize.call_args.kwargs, transport=transport)
        scope.set_client(client)
        try:
            yield transport
        finally:
            client.close()


@pytest.mark.parametrize("capture", ["message", "event"])
def test_top_level_messages_are_redacted(monkeypatch: pytest.MonkeyPatch, capture: str) -> None:
    with memory_sentry(monkeypatch) as transport:
        message = "operation failed token=secret-value"
        if capture == "message":
            sentry_sdk.capture_message(message)
        else:
            sentry_sdk.capture_event({"message": message})
    assert len(transport.events) == 1
    assert transport.events[0]["message"] == "operation failed token=[REDACTED]"
    assert "secret-value" not in json.dumps(transport.events)


@pytest.mark.parametrize("capture_warning", [False, True])
def test_log_capture_threshold_and_redacted_breadcrumbs(monkeypatch: pytest.MonkeyPatch, capture_warning: bool) -> None:
    logger = logging.getLogger("app.sentry_test")
    monkeypatch.setattr(logger, "level", logging.INFO)
    with memory_sentry(monkeypatch, capture_warning) as transport:
        logger.info("starting operation token=secret-breadcrumb", extra={"body": "secret-extra"})
        logger.warning("upstream unavailable token=secret-warning")
        logger.error("operation failed token=%s", "secret-error", extra={"payload": "secret-payload"})
    assert [event["level"] for event in transport.events] == (["warning", "error"] if capture_warning else ["error"])
    event = transport.events[-1]
    assert event["tags"]["service_name"] == "axon-backend"
    assert event["environment"] == "test"
    assert event["logentry"]["formatted"] == "operation failed token=[REDACTED]"
    assert "params" not in event["logentry"]
    assert "extra" not in event
    assert event["breadcrumbs"]["values"][0]["message"] == "starting operation token=[REDACTED]"
    assert "secret" not in json.dumps(transport.events)
    assert "otel_trace_id" not in event["tags"]
    assert "otel_span_id" not in event["tags"]


@pytest.mark.parametrize("logger_name", ["app.access", "uvicorn.access"])
def test_access_logs_are_breadcrumbs_not_issues(monkeypatch: pytest.MonkeyPatch, logger_name: str) -> None:
    logger = logging.getLogger(logger_name)
    monkeypatch.setattr(logger, "disabled", False)
    monkeypatch.setattr(logger, "level", logging.INFO)
    with memory_sentry(monkeypatch, capture_warning=True) as transport:
        logger.warning("request failed token=secret-warning", extra={"payload": "secret-body"})
        logger.error("request failed token=secret-error")
        assert transport.events == []
        sentry_sdk.capture_message("later diagnostic", level="error")
    assert len(transport.events) == 1
    breadcrumbs = [
        breadcrumb
        for breadcrumb in transport.events[0]["breadcrumbs"]["values"]
        if breadcrumb["category"] == logger_name
    ]
    assert [breadcrumb["level"] for breadcrumb in breadcrumbs] == ["warning", "error"]
    assert all(breadcrumb["message"] == "request failed token=[REDACTED]" for breadcrumb in breadcrumbs)
    assert "secret" not in json.dumps(transport.events)


@pytest.mark.parametrize("capture_warning", [False, True])
@pytest.mark.parametrize("failure", ["endpoint", "stream"])
def test_real_fastapi_errors_are_captured_once_with_safe_request_context(
    monkeypatch: pytest.MonkeyPatch, failure: str, capture_warning: bool
) -> None:
    # Production imports routers before SDK initialization, then includes them.
    router = APIRouter()

    @router.post("/fail/{item_id}")
    async def fail(item_id: str) -> StreamingResponse:
        if failure == "endpoint":
            raise ValueError("operation failed token=secret-exception")

        async def stream():  # noqa: ANN202 - async generator fixture
            yield b"first chunk"
            raise ValueError("operation failed token=secret-stream")

        return StreamingResponse(stream())

    with memory_sentry(monkeypatch, capture_warning) as transport:
        app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)
        app.add_middleware(BackendObservabilityMiddleware)
        app.include_router(router, prefix="/api")

        async def run() -> None:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://backend.test"
            ) as client:
                response = await client.post(
                    "/api/fail/secret-path?token=secret-query",
                    headers={"authorization": "Bearer secret-header", "x-request-id": "test-request"},
                    json={"prompt": "secret-prompt"},
                )
                assert response.status_code == (500 if failure == "endpoint" else 200)

        asyncio.run(run())
    assert len(transport.events) == 1
    event = transport.events[0]
    assert event["request"] == {"method": "POST"}
    assert event["tags"]["request_id"] == "test-request"
    assert event["transaction"].endswith(".fail")
    value = event["exception"]["values"][-1]
    assert value["type"] == "ValueError"
    assert value["value"] == "operation failed token=[REDACTED]"
    assert value["stacktrace"]["frames"]
    assert all("vars" not in frame and "context_line" not in frame for frame in value["stacktrace"]["frames"])
    assert "secret" not in json.dumps(event)


def test_request_error_links_to_backend_otel_span_after_request_cleanup(monkeypatch: pytest.MonkeyPatch) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    try:
        with memory_sentry(monkeypatch, capture_warning=True) as transport:
            app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)
            app.add_middleware(BackendObservabilityMiddleware)
            app.state.service_telemetry = SimpleNamespace(
                tracer=provider.get_tracer("test"), active=Mock(), duration=Mock()
            )

            @app.get("/fail")
            async def fail() -> None:
                raise RuntimeError("operation failed token=secret-value")

            async def run() -> None:
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://backend.test"
                ) as client:
                    response = await client.get("/fail", headers={"x-request-id": "backend-request"})
                    assert response.status_code == 500
                assert REQUEST_ID.get() is None
                assert not trace.get_current_span().get_span_context().is_valid

            asyncio.run(run())
        assert len(transport.events) == 1
        span = exporter.get_finished_spans()[0]
        assert transport.events[0]["tags"] == {
            "service_name": "axon-backend",
            "request_id": "backend-request",
            "otel_trace_id": format(span.context.trace_id, "032x"),
            "otel_span_id": format(span.context.span_id, "016x"),
        }
        assert "secret" not in json.dumps(transport.events)
    finally:
        provider.shutdown()


def test_expected_http_errors_are_not_issues(monkeypatch: pytest.MonkeyPatch) -> None:
    with memory_sentry(monkeypatch) as transport:
        app = FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)

        @app.get("/denied")
        async def denied() -> None:
            raise HTTPException(status_code=401, detail="secret-detail")

        async def run() -> None:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://backend.test"
            ) as client:
                assert (await client.get("/denied")).status_code == 401

        asyncio.run(run())
    assert transport.events == []


@pytest.mark.parametrize("exception", [asyncio.CancelledError(), ClientDisconnect(), RuntimeError("expected")])
def test_exception_opt_out_and_disconnects_are_ignored(exception: BaseException) -> None:
    if isinstance(exception, RuntimeError):
        exception.sentry_raise = False
    assert before_send({}, {"exc_info": (type(exception), exception, None)}) is None


@pytest.mark.parametrize("capture", ["exception", "log"])
def test_events_use_the_current_otel_span_without_sentry_tracing(monkeypatch: pytest.MonkeyPatch, capture: str) -> None:
    with memory_sentry(monkeypatch) as transport:
        token = REQUEST_ID.set("active-request")
        try:
            with trace.use_span(NonRecordingSpan(OTEL_CONTEXT)):
                if capture == "exception":
                    sentry_sdk.capture_exception(RuntimeError("operation failed token=secret-value"))
                else:
                    logging.getLogger("app.sentry_test").error("operation failed token=secret-value")
        finally:
            REQUEST_ID.reset(token)
    assert transport.events[0]["tags"] == {
        "service_name": "axon-backend",
        "request_id": "active-request",
        "otel_trace_id": TRACE_ID,
        "otel_span_id": SPAN_ID,
    }
    assert "secret" not in json.dumps(transport.events)


def test_uvicorn_error_logs_recover_request_and_otel_correlation(monkeypatch: pytest.MonkeyPatch) -> None:
    logger = logging.getLogger("uvicorn.error")
    monkeypatch.setattr(logger, "disabled", False)
    monkeypatch.setattr(logger, "level", logging.ERROR)
    with memory_sentry(monkeypatch) as transport:
        exception = RuntimeError("operation failed token=secret-value")
        bind_exception_correlation(exception, "finished-request", TRACE_ID, SPAN_ID)
        assert REQUEST_ID.get() is None
        assert not trace.get_current_span().get_span_context().is_valid
        logger.error("ASGI operation failed", exc_info=(type(exception), exception, None))
    assert transport.events[0]["tags"] == {
        "service_name": "axon-backend",
        "request_id": "finished-request",
        "otel_trace_id": TRACE_ID,
        "otel_span_id": SPAN_ID,
    }
    assert "secret" not in json.dumps(transport.events)


def test_captured_exceptions_are_not_reported_again_by_uvicorn(monkeypatch: pytest.MonkeyPatch) -> None:
    logger = logging.getLogger("uvicorn.error")
    monkeypatch.setattr(logger, "disabled", False)
    monkeypatch.setattr(logger, "level", logging.ERROR)
    with memory_sentry(monkeypatch) as transport:
        exception = RuntimeError("operation failed token=secret-value")
        sentry_sdk.capture_exception(exception)
        logger.error("Exception in ASGI application", exc_info=(type(exception), exception, None))
    assert len(transport.events) == 1
    assert "secret-value" not in json.dumps(transport.events)


@pytest.mark.parametrize("message", ["Error loading ASGI app.", "Application startup failed. Exiting."])
def test_non_lifespan_uvicorn_errors_are_still_reported(monkeypatch: pytest.MonkeyPatch, message: str) -> None:
    logger = logging.getLogger("uvicorn.error")
    monkeypatch.setattr(logger, "disabled", False)
    monkeypatch.setattr(logger, "level", logging.ERROR)
    with memory_sentry(monkeypatch) as transport:
        logger.error(message)
    assert len(transport.events) == 1
    assert transport.events[0]["logentry"]["formatted"] == message


@pytest.mark.parametrize(
    "pathname", ["/site-packages/uvicorn/lifespan/on.py", r"C:\site-packages\uvicorn\lifespan\on.py"]
)
def test_uvicorn_lifespan_logs_are_breadcrumbs_not_issues(monkeypatch: pytest.MonkeyPatch, pathname: str) -> None:
    logger = logging.getLogger("uvicorn.error")
    monkeypatch.setattr(logger, "disabled", False)
    record = logging.LogRecord(
        logger.name, logging.ERROR, pathname, 1, "Application startup failed. Exiting.", (), None
    )
    with memory_sentry(monkeypatch) as transport:
        logger.handle(record)
        assert transport.events == []
        sentry_sdk.capture_message("later diagnostic")
    assert len(transport.events) == 1
    breadcrumbs = transport.events[0]["breadcrumbs"]["values"]
    assert any(
        breadcrumb["category"] == logger.name and breadcrumb["message"] == record.getMessage()
        for breadcrumb in breadcrumbs
    )


def test_log_record_snapshots_survive_ended_spans(monkeypatch: pytest.MonkeyPatch) -> None:
    record = logging.LogRecord("app.sentry_test", logging.ERROR, __file__, 1, "operation failed", (), None)
    record.request_id, record.trace_id, record.span_id = "log-snapshot", TRACE_ID.upper(), SPAN_ID.upper()
    with memory_sentry(monkeypatch) as transport:
        assert not trace.get_current_span().get_span_context().is_valid
        logging.getLogger(record.name).handle(record)
    assert transport.events[0]["tags"] == {
        "service_name": "axon-backend",
        "request_id": "log-snapshot",
        "otel_trace_id": TRACE_ID,
        "otel_span_id": SPAN_ID,
    }
    assert "extra" not in transport.events[0]


def test_bound_error_correlation_wins_over_an_unrelated_current_request() -> None:
    exception = RuntimeError("original error")
    bind_exception_correlation(exception, "original-request", TRACE_ID, SPAN_ID)
    unrelated = SpanContext(trace_id=int("a" * 32, 16), span_id=int("b" * 16, 16), is_remote=False)
    token = REQUEST_ID.set("unrelated-request")
    try:
        with trace.use_span(NonRecordingSpan(unrelated)):
            event = before_send({}, {"exc_info": (type(exception), exception, None)})
    finally:
        REQUEST_ID.reset(token)
    assert event["tags"] == {"request_id": "original-request", "otel_trace_id": TRACE_ID, "otel_span_id": SPAN_ID}


@pytest.mark.parametrize(
    ("trace_value", "span_value"),
    [
        ("0" * 32, SPAN_ID),
        (TRACE_ID, "0" * 16),
        ("g" * 32, SPAN_ID),
        ("a" * 31, SPAN_ID),
        (TRACE_ID, "a" * 17),
        (123, SPAN_ID),
        (TRACE_ID, None),
        (None, SPAN_ID),
    ],
)
def test_invalid_otel_ids_and_unvalidated_tags_are_not_exported(trace_value: object, span_value: object) -> None:
    record = SimpleNamespace(request_id="safe-request", trace_id=trace_value, span_id=span_value)
    with trace.use_span(trace.INVALID_SPAN):
        event = before_send({"tags": {"otel_trace_id": "injected", "otel_span_id": "injected"}}, {"log_record": record})
    assert event["tags"] == {"request_id": "safe-request"}


def test_otel_trace_and_span_ids_are_never_mixed_between_sources() -> None:
    exception = RuntimeError("original error")
    bind_exception_correlation(exception, "original-request", "a" * 32, None)
    record = SimpleNamespace(trace_id=None, span_id="b" * 16)
    with trace.use_span(NonRecordingSpan(OTEL_CONTEXT)):
        event = before_send({}, {"exc_info": (type(exception), exception, None), "log_record": record})
    assert event["tags"] == {"request_id": "original-request"}


@pytest.mark.parametrize("source", ["exception", "log"])
def test_untraced_snapshots_do_not_acquire_an_unrelated_active_trace(source: str) -> None:
    exception = RuntimeError("original error")
    if source == "exception":
        bind_exception_correlation(exception, "untraced-request", None, None)
        hint = {"exc_info": (type(exception), exception, None)}
    else:
        hint = {"log_record": SimpleNamespace(request_id="untraced-request", trace_id=None, span_id=None)}
    token = REQUEST_ID.set("unrelated-request")
    try:
        with trace.use_span(NonRecordingSpan(OTEL_CONTEXT)):
            event = before_send({}, hint)
    finally:
        REQUEST_ID.reset(token)
    assert event["tags"] == {"request_id": "untraced-request"}


def test_non_log_breadcrumbs_are_discarded() -> None:
    assert before_breadcrumb({"type": "http", "data": {"url": "https://private.test/?key=secret"}}, {}) is None


def test_flush_is_bounded_and_disabled_is_a_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    flush = Mock()
    monkeypatch.setattr(sentry_sdk, "flush", flush)
    monkeypatch.setattr(sentry_sdk, "is_initialized", lambda: False)
    asyncio.run(flush_sentry())
    flush.assert_not_called()
    monkeypatch.setattr(sentry_sdk, "is_initialized", lambda: True)
    asyncio.run(flush_sentry())
    flush.assert_called_once_with(timeout=2)


@pytest.mark.parametrize("failure_phase", [None, "startup", "shutdown"])
def test_lifespan_captures_once_before_flush_after_dependency_cleanup(
    monkeypatch: pytest.MonkeyPatch, failure_phase: str | None
) -> None:
    order = []
    failure = RuntimeError("lifecycle failed token=secret-value")
    monkeypatch.setattr(listeners, "get_settings", lambda: SimpleNamespace(auth_service=None))
    for name in ("backend_telemetry", "database", "litellm_proxy", "storage", "otel_proxy"):
        monkeypatch.setattr(listeners, f"initialize_{name}", AsyncMock())
        monkeypatch.setattr(
            listeners, f"close_{name}", AsyncMock(side_effect=lambda app, name=name: order.append(name))
        )
    if failure_phase == "startup":
        monkeypatch.setattr(listeners, "initialize_storage", AsyncMock(side_effect=failure))
    elif failure_phase == "shutdown":

        async def close_storage(app: FastAPI) -> None:
            order.append("storage")
            raise failure

        monkeypatch.setattr(listeners, "close_storage", close_storage)

    events_at_flush = []
    with memory_sentry(monkeypatch) as transport:

        async def flush() -> None:
            order.append("flush")
            # Assert outside the callback: lifecycle intentionally swallows flush errors.
            events_at_flush.append(len(transport.events))

        flush_mock = AsyncMock(side_effect=flush)
        monkeypatch.setattr(sentry_observability, "flush_sentry", flush_mock)
        app = FastAPI(lifespan=listeners.lifespan, telemetry=NATIVE_TELEMETRY_DISABLED)
        if failure_phase is None:
            with TestClient(app):
                assert order == []
        else:
            with pytest.raises(RuntimeError) as caught, TestClient(app):
                assert order == []
            assert caught.value is failure
        flush_mock.assert_awaited_once()
    expected = ["litellm_proxy", "database", "backend_telemetry"]
    if failure_phase != "startup":
        expected = ["otel_proxy", "storage", *expected]
    assert order == [*expected, "flush"]
    assert events_at_flush == [int(failure_phase is not None)]
    # Starlette's outer integration sees the error after our flush, but dedupes it.
    assert len(transport.events) == int(failure_phase is not None)
    assert "secret" not in json.dumps(transport.events)


@pytest.mark.parametrize("capture_warning", [False, True])
@pytest.mark.parametrize("failure_phase", ["startup", "shutdown"])
def test_uvicorn_lifespan_failures_are_reported_once(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, failure_phase: str, capture_warning: bool
) -> None:
    logger = logging.getLogger("uvicorn.error")
    monkeypatch.setattr(logger, "disabled", False)
    monkeypatch.setattr(logger, "level", logging.INFO)
    events_at_flush = []

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with sentry_lifespan():
            if failure_phase == "startup":
                raise RuntimeError("lifecycle failed token=secret-value")
            yield
            raise RuntimeError("lifecycle failed token=secret-value")

    with memory_sentry(monkeypatch, capture_warning) as transport:

        async def flush() -> None:
            events_at_flush.append(len(transport.events))

        monkeypatch.setattr(sentry_observability, "flush_sentry", flush)
        app = FastAPI(lifespan=lifespan, telemetry=NATIVE_TELEMETRY_DISABLED)

        async def run() -> None:
            server = LifespanOn(Config(app, lifespan="on", log_config=None))
            await server.startup()
            if failure_phase == "shutdown":
                await server.shutdown()
            assert server.should_exit
            assert server.startup_failed is (failure_phase == "startup")
            assert server.shutdown_failed is (failure_phase == "shutdown")

        asyncio.run(run())
    assert events_at_flush == [1]
    assert len(transport.events) == 1
    value = transport.events[0]["exception"]["values"][-1]
    assert value["type"] == "RuntimeError"
    assert value["value"] == "lifecycle failed token=[REDACTED]"
    assert "secret-value" not in json.dumps(transport.events)
    # Suppressing Sentry events must not suppress the normal server logs.
    errors = [record for record in caplog.records if record.name == "uvicorn.error" and record.levelno == logging.ERROR]
    assert len(errors) == 2
    assert "Traceback (most recent call last)" in errors[0].getMessage()
    assert errors[1].getMessage() == f"Application {failure_phase} failed. Exiting."


@pytest.mark.parametrize("reporting_failure", ["capture", "flush", "both"])
def test_reporting_failures_do_not_mask_the_original_lifecycle_error(
    monkeypatch: pytest.MonkeyPatch, reporting_failure: str
) -> None:
    failure = RuntimeError("original lifecycle failure")
    capture = Mock(side_effect=OSError("capture failed") if reporting_failure in {"capture", "both"} else None)
    flush = AsyncMock(side_effect=OSError("flush failed") if reporting_failure in {"flush", "both"} else None)
    monkeypatch.setattr(sentry_sdk, "capture_exception", capture)
    monkeypatch.setattr(sentry_observability, "flush_sentry", flush)

    async def run() -> None:
        async with sentry_lifespan():
            raise failure

    with pytest.raises(RuntimeError) as caught:
        asyncio.run(run())
    assert caught.value is failure
    capture.assert_called_once_with(failure)
    flush.assert_awaited_once()


def test_flush_failure_does_not_break_successful_shutdown(monkeypatch: pytest.MonkeyPatch) -> None:
    capture, flush = Mock(), AsyncMock(side_effect=OSError("flush failed"))
    monkeypatch.setattr(sentry_sdk, "capture_exception", capture)
    monkeypatch.setattr(sentry_observability, "flush_sentry", flush)

    async def run() -> None:
        async with sentry_lifespan():
            pass

    asyncio.run(run())
    capture.assert_not_called()
    flush.assert_awaited_once()


def test_lifecycle_cancellation_is_not_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    capture, flush = Mock(), AsyncMock()
    monkeypatch.setattr(sentry_sdk, "capture_exception", capture)
    monkeypatch.setattr(sentry_observability, "flush_sentry", flush)

    async def run() -> None:
        async with sentry_lifespan():
            raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(run())
    capture.assert_not_called()
    flush.assert_awaited_once()
