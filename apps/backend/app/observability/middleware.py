"""Streaming-safe backend spans, HTTP metrics, and sanitized access logs."""

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Sequence
from contextlib import nullcontext
from dataclasses import dataclass, field

from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.trace import Link, Span, SpanKind, Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from starlette.datastructures import Headers
from starlette.requests import ClientDisconnect
from starlette.routing import BaseRoute, Match, Mount
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.observability.context import REQUEST_ID, bind_exception_correlation, request_id
from app.observability.exceptions import record_safe_exception
from app.observability.privacy import HTTP_METHODS
from app.observability.runtime import ServiceTelemetry

logger = logging.getLogger("app.access")
PROPAGATOR = TraceContextTextMapPropagator()
ROUTE_TEMPLATE_CACHE_SIZE = 1024
MAX_CACHED_PATH_LENGTH = 512


def _caller_links(scope: Scope) -> list[Link]:
    caller = trace.get_current_span(PROPAGATOR.extract(dict(Headers(scope=scope)))).get_span_context()
    return [Link(caller)] if caller.is_valid else []


def _matched_template(route: BaseRoute, scope: Scope) -> str:
    # FastAPI 0.136+ retains included routers lazily instead of flattening their
    # paths. Resolve the original trusted route with its include-prefix stripped.
    original = getattr(route, "original_router", None)
    if original is not None:
        prefix = route.include_context.prefix
        child_scope = {**scope, "root_path": scope.get("root_path", "") + prefix}
        return prefix + route_template(child_scope, original.routes)
    if isinstance(route, Mount):
        if route.path in {"/litellm", "/litellm-admin"}:
            from app.proxies.litellm_common import DIAGNOSTIC_PATHS

            relative = scope.get("path", "")[len(scope.get("root_path", "")) + len(route.path) :] or "/"
            return route.path + (relative if relative in DIAGNOSTIC_PATHS else "/{path}")
        return (route.path or "") + "/{path}"
    return getattr(route, "path", "<other>")


def route_template(scope: Scope, routes: Sequence[BaseRoute] | None = None) -> str:
    """Resolve trusted route templates, never caller-controlled raw paths/IDs."""
    partial = "<unmatched>"
    for route in routes if routes is not None else getattr(scope.get("app"), "routes", ()):
        match, _ = route.matches(scope)
        if match == Match.NONE:
            continue
        if match == Match.PARTIAL:
            partial = _matched_template(route, scope)
            continue
        return _matched_template(route, scope)
    return partial


@dataclass
class RequestObservation:
    runtime: ServiceTelemetry | None
    method: str
    path: str
    identifier: str
    access_log: bool
    started: float = field(default_factory=time.monotonic)
    status: int = 500
    completed: bool = False
    error_type: str | None = None
    error_message: str | None = None
    cancelled: bool = False

    async def send(self, message: Message, send: Send) -> None:
        if message["type"] == "http.response.start":
            self.status = message["status"]
            message = {
                **message,
                "headers": [(k, v) for k, v in message.get("headers", []) if k.lower() != b"x-request-id"]
                + [(b"x-request-id", self.identifier.encode("ascii"))],
            }
        try:
            await send(message)
        except OSError:
            self.cancelled = True
            self.error_type = "client_disconnected"
            raise
        if message["type"] == "http.response.body" and not message.get("more_body", False):
            self.completed = True

    def finish(self, span: Span) -> None:
        duration = time.monotonic() - self.started
        # A broken stream remains a failure even if 200 headers were sent.
        failed = not self.cancelled and (self.status >= 500 or self.error_type is not None or not self.completed)
        if self.runtime:
            span.set_attribute("http.response.status_code", self.status)
            span.set_attribute("http.status_code", self.status)
            span.set_attribute("axon.response.completed", self.completed)
            if self.error_type:
                span.set_attribute("error.type", self.error_type)
            if failed:
                message = self.error_message or (f"HTTP {self.status}" if self.status >= 500 else "Response incomplete")
                if not self.error_type:
                    span.set_attribute("error.type", str(self.status) if self.status >= 500 else "response_incomplete")
                span.set_status(Status(StatusCode.ERROR, message))
            self.runtime.duration.record(
                duration,
                {
                    "http.request.method": self.method,
                    "http.route": self.path,
                    "http.response.status_code": self.status,
                },
            )
            self.runtime.active.add(-1, {"http.request.method": self.method})
        if self.access_log:
            logger.log(
                logging.WARNING if failed else logging.INFO,
                "HTTP request",
                extra={
                    "logtype": "access",
                    "http_method": self.method,
                    "path": self.path,
                    "status": self.status,
                    "duration_ms": round(duration * 1000, 2),
                    "completed": self.completed,
                    "error_type": self.error_type,
                },
            )


class BackendObservabilityMiddleware:
    def __init__(self, app: ASGIApp, *, access_log: bool = True) -> None:
        self.app = app
        self.access_log = access_log
        # Route matching repeats Starlette's routing work, so memoize resolved
        # templates per request shape. Bounded: caller-chosen paths cannot grow it.
        self._templates: OrderedDict[tuple[object, object, object], str] = OrderedDict()

    def _route_template(self, scope: Scope) -> str:
        path = scope.get("path", "")
        if len(path) > MAX_CACHED_PATH_LENGTH:
            return route_template(scope)
        key = (scope.get("method"), scope.get("root_path", ""), path)
        template = self._templates.get(key)
        if template is not None:
            self._templates.move_to_end(key)
            return template
        template = route_template(scope)
        self._templates[key] = template
        if len(self._templates) > ROUTE_TEMPLATE_CACHE_SIZE:
            self._templates.popitem(last=False)
        return template

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        runtime = getattr(scope["app"].state, "service_telemetry", None)
        method = scope.get("method", "GET")
        method = method if method in HTTP_METHODS else "_OTHER"
        path = self._route_template(scope)
        identifier = request_id(Headers(scope=scope).get("x-request-id"))
        token = REQUEST_ID.set(identifier)
        # The LiteLLM proxy must reuse the exact normalized ID, including invalid
        # input replaced here. Never forward a caller's invalid raw value.
        scope["headers"] = [(k, v) for k, v in scope.get("headers", []) if k.lower() != b"x-request-id"]
        scope["headers"].append((b"x-request-id", identifier.encode("ascii")))
        observation = RequestObservation(runtime, method, path, identifier, self.access_log)
        manager = (
            runtime.tracer.start_as_current_span(
                f"{method} {path}",
                kind=SpanKind.SERVER,
                # Public endpoint: a caller's traceparent must not choose our trace
                # ID or force sampling past SAMPLING_RATE. Start a root span and
                # keep the caller's context only as a link.
                context=Context(),
                links=_caller_links(scope),
                attributes={"http.request.method": method, "http.route": path, "http.method": method},
                record_exception=False,
                set_status_on_exception=False,
            )
            if runtime
            else nullcontext(trace.INVALID_SPAN)
        )

        async def send_correlated(message: Message) -> None:
            await observation.send(message, send)

        async def receive_observed() -> Message:
            message = await receive()
            if message["type"] == "http.disconnect" and not observation.completed:
                observation.cancelled = True
                observation.error_type = "client_disconnected"
            return message

        try:
            with manager as span:
                if runtime:
                    runtime.active.add(1, {"http.request.method": method})
                    span.set_attribute("axon.request_id", identifier)
                try:
                    await self.app(scope, receive_observed, send_correlated)
                except (asyncio.CancelledError, ClientDisconnect):
                    observation.cancelled = True
                    observation.error_type = "request_cancelled"
                    raise
                except Exception as exc:
                    if not observation.cancelled:
                        observation.error_type = type(exc).__name__
                        observation.error_message = record_safe_exception(span, exc)
                    context = span.get_span_context()
                    bind_exception_correlation(
                        exc,
                        identifier,
                        format(context.trace_id, "032x") if context.is_valid else None,
                        format(context.span_id, "016x") if context.is_valid else None,
                    )
                    raise
                finally:
                    observation.finish(span)
        finally:
            REQUEST_ID.reset(token)
