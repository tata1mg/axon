"""Vortex-style backend error reporting with Axon's telemetry privacy defaults."""

import asyncio
import logging
import os
from typing import TYPE_CHECKING, Any

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.logging import LoggingIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration
from starlette.requests import ClientDisconnect

from app.observability.context import REQUEST_ID, exception_correlation, safe_identifier
from app.observability.exceptions import exception_message
from app.observability.privacy import HTTP_METHODS

if TYPE_CHECKING:
    from sentry_sdk._types import Breadcrumb, Event, Hint

    from app.core.config import SentrySettings


_FRAME_FIELDS = {"filename", "abs_path", "function", "module", "lineno", "colno", "in_app", "platform"}


def _safe_stacktrace(stacktrace: dict[str, Any]) -> None:
    # Preserve grouping and source locations, but never locals or source lines.
    stacktrace["frames"] = [
        {key: value for key, value in frame.items() if key in _FRAME_FIELDS} for frame in stacktrace.get("frames", [])
    ]


def before_breadcrumb(breadcrumb: "Breadcrumb", hint: "Hint") -> "Breadcrumb | None":
    """Keep redacted log breadcrumbs, not HTTP/SQL payloads or log extras."""
    if breadcrumb.get("type") != "log":
        return None
    return {
        **{key: breadcrumb[key] for key in ("type", "category", "level", "timestamp") if key in breadcrumb},
        "message": exception_message(breadcrumb.get("message", "")),
    }


def _safe_exceptions(event: "Event") -> None:
    for value in event.get("exception", {}).get("values", []):
        if isinstance(value.get("value"), str):
            value["value"] = exception_message(value["value"])
        if "stacktrace" in value:
            _safe_stacktrace(value["stacktrace"])
    if "stacktrace" in event:
        _safe_stacktrace(event["stacktrace"])
    for thread in event.get("threads", {}).get("values", []):
        if "stacktrace" in thread:
            _safe_stacktrace(thread["stacktrace"])


def before_send(event: "Event", hint: "Hint") -> "Event | None":
    """Honor Vortex's opt-out flag and scrub sensitive automatically captured data."""
    exc_info = hint.get("exc_info")
    exception = exc_info[1] if exc_info else None
    if exception is not None and (
        getattr(exception, "sentry_raise", True) is False
        or isinstance(exception, (asyncio.CancelledError, ClientDisconnect))
    ):
        return None

    # Defense in depth: strip even manually attached request/user/log extras.
    request = event.pop("request", None)
    if request and request.get("method") in HTTP_METHODS:
        event["request"] = {"method": request["method"]}
    event.pop("user", None)
    event.pop("extra", None)
    if "logentry" in event:
        event["logentry"] = {
            key: exception_message(value)
            for key in ("message", "formatted")
            if isinstance(value := event["logentry"].get(key), str)
        }
    _safe_exceptions(event)

    # Recover correlation even for uvicorn's logs after the request scope ended.
    correlation = exception_correlation(exception)
    record = hint.get("log_record")
    identifier = REQUEST_ID.get() or (correlation[0] if correlation else getattr(record, "request_id", None))
    if identifier and (identifier := safe_identifier(identifier, "")):
        event.setdefault("tags", {})["request_id"] = identifier
    return event


def setup_sentry(settings: "SentrySettings | None") -> None:
    """Initialize before FastAPI constructs routes; blank/missing DSNs are a no-op."""
    if settings is None:
        return
    sentry_sdk.init(
        dsn=settings.dsn,
        environment=settings.environment,
        release=os.getenv("RELEASE_TAG") or "dev-local",
        debug=False,
        integrations=[
            StarletteIntegration(transaction_style="endpoint"),
            FastApiIntegration(transaction_style="endpoint"),
            LoggingIntegration(
                level=logging.INFO, event_level=logging.WARNING if settings.capture_warning else logging.ERROR
            ),
        ],
        # OpenTelemetry owns HTTP/DB tracing; do not auto-enable AI/HTTP/DB capture.
        auto_enabling_integrations=False,
        traces_sample_rate=0.0,
        trace_propagation_targets=[],
        enable_logs=False,
        data_collection={
            "user_info": False,
            "cookies": {"mode": "off"},
            "http_headers": {"request": {"mode": "off"}},
            "url_query_params": {"mode": "off"},
            "http_bodies": [],
            "graphql": {"document": False, "variables": False},
            "gen_ai": {"inputs": False, "outputs": False},
            "database_query_data": False,
            "queues": False,
            "stack_frame_variables": False,
            "frame_context_lines": 0,
        },
        include_local_variables=False,
        include_source_context=False,
        max_request_body_size="never",
        before_send=before_send,
        before_breadcrumb=before_breadcrumb,
    )
    sentry_sdk.set_tag("service_name", settings.service_name)


async def flush_sentry() -> None:
    """Flush after dependency shutdown, without blocking the event loop."""
    if sentry_sdk.is_initialized():
        await asyncio.to_thread(sentry_sdk.flush, timeout=2)
