"""Vortex-style backend error reporting with Axon's telemetry privacy defaults."""

import asyncio
import logging
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import TYPE_CHECKING, Any

import sentry_sdk
from opentelemetry import trace
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


def _hex_id(value: object, length: int) -> str | None:
    if isinstance(value, str) and len(value) == length and re.fullmatch(r"[0-9a-fA-F]+", value) and int(value, 16):
        return value.lower()
    return None


def _correlation_tags(hint: "Hint", exception: BaseException | None) -> dict[str, str]:
    correlation = exception_correlation(exception)
    record = hint.get("log_record")
    # Keep all IDs from the same source. Even an untraced error/log snapshot must
    # not acquire an unrelated trace active when it is reported later.
    if correlation is not None:
        identifier, trace_value, span_value = correlation
    elif record is not None and any(hasattr(record, key) for key in ("request_id", "trace_id", "span_id")):
        identifier = getattr(record, "request_id", None)
        trace_value, span_value = getattr(record, "trace_id", None), getattr(record, "span_id", None)
    else:
        identifier = getattr(record, "request_id", None) or REQUEST_ID.get()
        context = trace.get_current_span().get_span_context()
        trace_value = format(context.trace_id, "032x") if context.is_valid else None
        span_value = format(context.span_id, "016x") if context.is_valid else None

    tags = {}
    if isinstance(identifier, str) and (identifier := safe_identifier(identifier, "")):
        tags["request_id"] = identifier
    trace_id, span_id = _hex_id(trace_value, 32), _hex_id(span_value, 16)
    if trace_id and span_id:
        tags.update(otel_trace_id=trace_id, otel_span_id=span_id)
    return tags


def before_send(event: "Event", hint: "Hint") -> "Event | None":
    """Honor Vortex's opt-out flag and scrub sensitive automatically captured data."""
    # Access diagnostics must not duplicate the corresponding exception issue.
    # Filtering here, not via ignore_logger(), preserves their log breadcrumbs.
    if event.get("logger") in {"app.access", "uvicorn.access"}:
        return None
    # sentry_lifespan owns lifecycle failures. Uvicorn logs the same failure as
    # plain text (without exc_info), which default exception dedupe cannot match.
    # Filter by source, not message text, to retain unrelated uvicorn.error events
    # and preserve the original server logs and their Sentry breadcrumbs.
    record = hint.get("log_record")
    if (
        event.get("logger") == "uvicorn.error"
        and record is not None
        and record.pathname.replace("\\", "/").endswith("/uvicorn/lifespan/on.py")
    ):
        return None
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
    if isinstance(message := event.get("message"), str):
        event["message"] = exception_message(message)
    if "logentry" in event:
        event["logentry"] = {
            key: exception_message(value)
            for key in ("message", "formatted")
            if isinstance(value := event["logentry"].get(key), str)
        }
    _safe_exceptions(event)

    # Recover correlation even for uvicorn's logs after the request scope ended.
    tags = event.setdefault("tags", {})
    tags.pop("otel_trace_id", None)
    tags.pop("otel_span_id", None)
    tags.update(_correlation_tags(hint, exception))
    return event


def setup_sentry(settings: "SentrySettings | None") -> None:
    """Initialize parsed settings before FastAPI constructs routes.

    _sentry_settings() maps missing or blank DSNs to None, a no-op here.
    """
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
        # Default integrations, including exception dedupe, remain enabled.
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


@asynccontextmanager
async def sentry_lifespan() -> AsyncIterator[None]:
    """Own lifecycle failure reporting, then flush and re-raise without masking.

    before_send keeps Uvicorn's follow-up lifespan logs as breadcrumbs, not events.
    """
    try:
        yield
    except Exception as exc:
        # Reporting failures must never replace the application's original error.
        with suppress(Exception):
            sentry_sdk.capture_exception(exc)
        raise
    finally:
        # Telemetry transport failures must not break otherwise successful cleanup.
        with suppress(Exception):
            await flush_sentry()
