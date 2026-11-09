"""Backend Sentry configuration and real SDK capture, using an in-memory transport."""

import asyncio
import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
import sentry_sdk
from fastapi import APIRouter, FastAPI, HTTPException
from sentry_sdk.envelope import Envelope
from sentry_sdk.transport import Transport
from starlette.requests import ClientDisconnect
from starlette.responses import StreamingResponse

from app import listeners
from app.core import config
from app.core.config import SentrySettings
from app.observability import NATIVE_TELEMETRY_DISABLED
from app.observability.context import REQUEST_ID, bind_exception_correlation
from app.observability.middleware import BackendObservabilityMiddleware
from app.observability.sentry import before_breadcrumb, before_send, flush_sentry, setup_sentry
from app.routers.cli_config import client_config

DSN = "https://private-key@sentry.example.test/42"


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


@pytest.mark.parametrize("failure", ["endpoint", "stream"])
def test_real_fastapi_errors_are_captured_once_with_safe_request_context(
    monkeypatch: pytest.MonkeyPatch, failure: str
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

    with memory_sentry(monkeypatch) as transport:
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


def test_uvicorn_error_logs_recover_request_correlation(monkeypatch: pytest.MonkeyPatch) -> None:
    with memory_sentry(monkeypatch) as transport:
        exception = RuntimeError("operation failed token=secret-value")
        bind_exception_correlation(exception, "finished-request", None, None)
        assert REQUEST_ID.get() is None
        sentry_sdk.capture_exception(exception)
    assert transport.events[0]["tags"]["request_id"] == "finished-request"
    assert "secret" not in json.dumps(transport.events)


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


@pytest.mark.parametrize("startup_failure", [False, True])
def test_lifespan_flushes_after_dependency_shutdown(monkeypatch: pytest.MonkeyPatch, startup_failure: bool) -> None:
    order = []
    monkeypatch.setattr(listeners, "get_settings", lambda: SimpleNamespace(auth_service=None))
    for name in ("backend_telemetry", "database", "litellm_proxy", "storage", "otel_proxy"):
        monkeypatch.setattr(listeners, f"initialize_{name}", AsyncMock())
        monkeypatch.setattr(listeners, f"close_{name}", AsyncMock(side_effect=lambda app: order.append("close")))
    if startup_failure:
        monkeypatch.setattr(listeners, "initialize_storage", AsyncMock(side_effect=RuntimeError("startup failed")))
    monkeypatch.setattr(listeners, "flush_sentry", AsyncMock(side_effect=lambda: order.append("flush")))

    async def run() -> None:
        async with listeners.lifespan(FastAPI(telemetry=NATIVE_TELEMETRY_DISABLED)):
            assert order == []

    if startup_failure:
        with pytest.raises(RuntimeError, match="startup failed"):
            asyncio.run(run())
    else:
        asyncio.run(run())
    assert order == ["close"] * (3 if startup_failure else 5) + ["flush"]
