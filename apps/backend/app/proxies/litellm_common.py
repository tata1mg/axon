"""Shared LiteLLM HTTP primitives and the single streaming-forwarding lifecycle."""

import asyncio
import logging
import sys
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import dataclass
from time import monotonic
from urllib.parse import quote
from uuid import uuid4

import httpx
from fastapi import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.clients.litellm.transport import LiteLLMTransport, validate_raw_path
from app.observability.context import safe_identifier
from app.observability.litellm import LiteLLMDiagnostics, UpstreamObservation, exception_class
from app.observability.privacy import HTTP_METHODS
from app.proxies.disconnect import finish_cleanup, run_with_disconnect

logger = logging.getLogger(__name__)

LITELLM_MOUNT_PATH = "/litellm"

HOP_BY_HOP_HEADERS = {
    b"connection",
    b"keep-alive",
    b"proxy-authenticate",
    b"proxy-authorization",
    b"te",
    b"trailer",
    b"transfer-encoding",
    b"upgrade",
}
PROTECTED_REQUEST_HEADERS = {
    b"api-key",
    b"authorization",
    b"cookie",
    b"content-length",
    b"host",
    b"x-api-key",
    b"x-auth-context",
    b"x-encrypted-session-data",
    b"x-forwarded-for",
    b"x-forwarded-host",
    b"x-forwarded-proto",
    b"x-litellm-api-key",
    b"x-litellm-customer-id",
    b"x-litellm-end-user-id",
    b"x-request-id",
    b"x-session-refresh-token",
    b"x-team-id",
    b"x-user-id",
}
PROTECTED_RESPONSE_HEADERS = {
    b"api-key",
    b"authorization",
    b"cache-control",
    b"expires",
    b"set-cookie",
    b"x-api-key",
    b"x-auth-context",
    b"x-encrypted-session-data",
    b"x-litellm-api-key",
    b"x-request-id",
    b"x-session-refresh-token",
}
INVALID_PATH_BODY = b'{"detail":"Invalid LiteLLM request path"}'
BAD_GATEWAY_BODY = b'{"detail":"LiteLLM upstream is unavailable"}'
SERVICE_UNAVAILABLE_BODY = b'{"detail":"LiteLLM proxy is not ready"}'
IDENTITY_SYNC_UNAVAILABLE_BODY = b'{"detail":"LiteLLM user/team synchronization is unavailable"}'
ACCESS_DENIED_BODY = b'{"detail":"LiteLLM access denied"}'
UNAUTHORIZED_BODY = b'{"detail":"Authentication required"}'

# Static endpoint names keep observability route templates/metrics low-cardinality.
# Request diagnostics retain the actual encoded pathname, including resource IDs.
DIAGNOSTIC_PATHS = frozenset(
    {
        "/",
        "/health",
        "/health/liveliness",
        "/health/readiness",
        "/key/info",
        "/mcp",
        "/model/info",
        "/models",
        "/team/info",
        "/team/list",
        "/user/info",
        "/v2/user/info",
        "/v1/models",
        "/chat/completions",
        "/v1/chat/completions",
        "/completions",
        "/v1/completions",
        "/responses",
        "/v1/responses",
        "/embeddings",
        "/v1/embeddings",
        "/messages",
        "/v1/messages",
    }
)
DIAGNOSTICS_STATE_KEY = "litellm_request_diagnostics"


@dataclass
class RequestDiagnostics:
    request_id: str
    stage: str = "session_auth"
    reason: str = "none"
    upstream_status: int | None = None
    upstream_duration_ms: float | None = None
    credential_mode: str = "unresolved"
    error_type: str = "none"
    error_class: str = "none"
    cleanup_error_class: str = "none"

    def log_result(
        self, *, logger: logging.Logger, method: str, path: str, status: int | None, completed: bool, started: float
    ) -> None:
        if self.reason == "none":
            if self.stage == "session_auth" and status is not None and status >= 400:
                self.reason = "session_auth_failed"
            elif not completed:
                self.reason = "response_incomplete"
        failed = status is None or status >= 400 or self.reason != "none"
        level = logging.WARNING if failed else logging.INFO
        if self.reason in {"client_disconnected", "request_cancelled"}:
            level = logging.INFO
        logger.log(
            level,
            "LiteLLM request request_id=%s method=%s path=%s stage=%s reason=%s "
            "upstream_status=%s status=%s credential_mode=%s upstream_duration_ms=%s "
            "duration_ms=%.1f completed=%s error_type=%s exception_class=%s cleanup_error_class=%s",
            self.request_id,
            method,
            path,
            self.stage,
            self.reason,
            self.upstream_status if self.upstream_status is not None else "none",
            status if status is not None else "none",
            self.credential_mode,
            self.upstream_duration_ms if self.upstream_duration_ms is not None else "none",
            (monotonic() - started) * 1000,
            str(completed).lower(),
            self.error_type,
            self.error_class,
            self.cleanup_error_class,
        )


def get_diagnostics(scope: Scope) -> RequestDiagnostics | None:
    """Return this request's sanitized diagnostics, if logging is installed."""
    return scope.get("state", {}).get(DIAGNOSTICS_STATE_KEY)


class LiteLLMRequestLoggingMiddleware:
    """Correlate session, provisioning, upstream, and streaming failures safely."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        strip_mount_path: bool = False,
        mount_path: str = LITELLM_MOUNT_PATH,
        logger: logging.Logger | None = None,
    ) -> None:
        self.app = app
        self.strip_mount_path = strip_mount_path
        self.mount_path = mount_path
        self.logger = logger or logging.getLogger(__name__)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = monotonic()
        request = Request(scope)
        diagnostic = RequestDiagnostics(safe_identifier(request.headers.get("x-request-id"), str(uuid4())))
        request.state.litellm_request_diagnostics = diagnostic
        # Preserve the encoded pathname for debugging; ASGI query_string stays excluded.
        path = relative_raw_path(scope, strip_mount_path=self.strip_mount_path, mount_path=self.mount_path).decode(
            "ascii", errors="replace"
        )
        method = str(scope.get("method", "GET"))
        method = method if method in HTTP_METHODS else "<other>"
        status: int | None = None
        completed = False

        async def send_correlated(message: Message) -> None:
            nonlocal status, completed
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = [
                    (name, value) for name, value in message.get("headers", []) if name.lower() != b"x-request-id"
                ]
                headers.append((b"x-request-id", diagnostic.request_id.encode("ascii")))
                message = {**message, "headers": headers}
            try:
                await send(message)
            except OSError as exc:
                diagnostic.stage = "downstream_stream"
                diagnostic.reason = "client_disconnected"
                diagnostic.error_type = type(exc).__name__
                raise
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                completed = True

        try:
            await self.app(scope, receive, send_correlated)
        except asyncio.CancelledError:
            diagnostic.reason = "request_cancelled"
            diagnostic.error_type = "CancelledError"
            raise
        except httpx.HTTPError as exc:
            diagnostic.stage = "upstream_stream"
            diagnostic.reason = "upstream_stream_failed"
            diagnostic.error_type = type(exc).__name__
            raise
        finally:
            diagnostic.log_result(
                logger=self.logger, method=method, path=path, status=status, completed=completed, started=started
            )


def connection_tokens(headers: Iterable[tuple[bytes, bytes]]) -> set[bytes]:
    """Return additional hop-by-hop header names declared by Connection."""
    tokens: set[bytes] = set()
    for name, value in headers:
        if name.lower() != b"connection":
            continue
        tokens.update(token.strip().lower() for token in value.split(b",") if token.strip())
    return tokens


def end_to_end_headers(headers: Iterable[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
    """Preserve header order and duplicates while removing hop-by-hop fields."""
    raw_headers = list(headers)
    excluded_headers = HOP_BY_HOP_HEADERS | connection_tokens(raw_headers)
    return [(name, value) for name, value in raw_headers if name.lower() not in excluded_headers]


def relative_raw_path(scope: Scope, *, strip_mount_path: bool, mount_path: str = LITELLM_MOUNT_PATH) -> bytes:
    """Return the encoded request path after Starlette's mounted root path."""
    raw_path = scope.get("raw_path")
    if not isinstance(raw_path, bytes):
        raw_path = quote(str(scope.get("path", "/")), safe="/").encode("ascii")

    root_path = str(scope.get("root_path", ""))
    encoded_root_path = quote(root_path, safe="/").encode("ascii")
    if encoded_root_path and raw_path.startswith(encoded_root_path):
        relative_path = raw_path[len(encoded_root_path) :]
    else:
        decoded_path = str(scope.get("path", "/"))
        if root_path and decoded_path.startswith(root_path):
            decoded_path = decoded_path[len(root_path) :]
        relative_path = quote(decoded_path, safe="/").encode("ascii")

    if strip_mount_path:
        encoded_mount_path = mount_path.encode("ascii")
        if relative_path == encoded_mount_path:
            relative_path = b"/"
        elif relative_path.startswith(encoded_mount_path + b"/"):
            relative_path = relative_path[len(encoded_mount_path) :]

    if not relative_path:
        return b"/"
    if not relative_path.startswith(b"/"):
        return b"/" + relative_path
    return relative_path


async def send_error(send: Send, status_code: int, body: bytes) -> None:
    """Send a fixed JSON proxy error without caching or upstream details."""
    await send(
        {
            "type": "http.response.start",
            "status": status_code,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"cache-control", b"no-store"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def validated_request_path(scope: Scope, send: Send, *, strip_mount_path: bool, mount_path: str) -> bytes | None:
    """Reject unsafe/oversized paths before reading bodies or resolving credentials."""
    raw_path = relative_raw_path(scope, strip_mount_path=strip_mount_path, mount_path=mount_path)
    try:
        validate_raw_path(raw_path)
    except ValueError:
        diagnostic = get_diagnostics(scope)
        if diagnostic is not None:
            diagnostic.reason = "invalid_path"
        await send_error(send, 400, INVALID_PATH_BODY)
        return None
    return raw_path


@dataclass(frozen=True)
class BodyLimits:
    """Optional browser upload limits; API streaming keeps its existing defaults."""

    idle_timeout_seconds: float | None = None
    write_timeout_seconds: float | None = None
    request_timeout_seconds: float | None = None
    max_bytes: int | None = None


@dataclass(frozen=True)
class UpstreamRequest:
    """Policy-owned headers and query; the lifecycle owns body streaming."""

    headers: list[tuple[bytes, bytes]]
    query_string: bytes


@dataclass(frozen=True)
class ResponseHead:
    """Policy-owned response metadata, with an optional sanitized body override."""

    status: int
    headers: list[tuple[bytes, bytes]]
    body: bytes | None = None
    reason: str = "none"


class ForwardingError(Exception):
    """A sanitized policy/input failure that can be returned before headers."""

    def __init__(
        self,
        status: int,
        body: bytes,
        reason: str,
        *,
        error_type: str | None = None,
        upstream_status: int | None = None,
    ) -> None:
        super().__init__(reason)
        self.status = status
        self.body = body
        self.reason = reason
        self.error_type = error_type or type(self).__name__
        self.upstream_status = upstream_status


class _ClientDisconnectedError(Exception):
    """Abort an incomplete upload instead of forwarding a truncated body."""


def _check_body_size(size: int, limits: BodyLimits) -> None:
    if limits.max_bytes is not None and size > limits.max_bytes:
        raise ForwardingError(413, b'{"detail":"LiteLLM request body is too large"}', "request_body_too_large")


def _check_content_length(scope: Scope, limits: BodyLimits) -> None:
    if limits.max_bytes is None:
        return
    for value in Request(scope).headers.getlist("content-length"):
        try:
            size = int(value)
        except ValueError:
            raise ForwardingError(
                400, b'{"detail":"Invalid request content length"}', "invalid_content_length"
            ) from None
        if size < 0:
            raise ForwardingError(400, b'{"detail":"Invalid request content length"}', "invalid_content_length")
        _check_body_size(size, limits)


async def _receive_message(receive: Receive, limits: BodyLimits) -> Message:
    """Bound every body wait, including the first frame before opening upstream."""
    if limits.idle_timeout_seconds is None:
        return await receive()
    try:
        async with asyncio.timeout(limits.idle_timeout_seconds):
            return await receive()
    except TimeoutError:
        raise ForwardingError(408, b'{"detail":"LiteLLM request body timed out"}', "request_body_timeout") from None


async def request_body(first_message: Message, receive: Receive, limits: BodyLimits) -> AsyncGenerator[bytes, None]:
    """Stream bounded body chunks without read-ahead; disconnects abort upstream."""
    message = first_message
    size = 0
    while True:
        if message["type"] == "http.disconnect":
            raise _ClientDisconnectedError
        if message["type"] != "http.request":
            return
        body = message.get("body", b"")
        size += len(body)
        _check_body_size(size, limits)
        if body:
            yield body
        if not message.get("more_body", False):
            return
        message = await _receive_message(receive, limits)


async def _send_response(response: httpx.Response, send: Send, head: ResponseHead) -> None:
    """Forward raw bytes and duplicate headers; forward_stream owns closure."""
    await send({"type": "http.response.start", "status": head.status, "headers": head.headers})
    if head.body is not None:
        await send({"type": "http.response.body", "body": head.body})
        return
    if response.is_stream_consumed:
        if response.content:
            await send({"type": "http.response.body", "body": response.content, "more_body": True})
    else:
        async for chunk in response.aiter_raw():
            if chunk:
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
    await send({"type": "http.response.body", "body": b"", "more_body": False})


async def _open_response(
    scope: Scope,
    transport: LiteLLMTransport,
    raw_path: bytes,
    request_id: str,
    build_request: Callable[[str], Awaitable[UpstreamRequest]],
    limits: BodyLimits,
    content: AsyncIterator[bytes] | None,
    observer: LiteLLMDiagnostics | None,
    observation: UpstreamObservation | None,
) -> httpx.Response:
    """Build policy-specific credentials, then time only transport-to-headers I/O."""
    prepared = await build_request(request_id)
    diagnostic = get_diagnostics(scope)
    if diagnostic is not None:
        diagnostic.stage = "upstream"
    started = monotonic()
    if observer is not None and observation is not None:
        observer.phase(observation, "awaiting_headers")
    try:
        return await transport.send_stream(
            str(scope.get("method", "GET")),
            raw_path,
            query_string=prepared.query_string,
            headers=prepared.headers,
            content=content,
            write_timeout_seconds=limits.write_timeout_seconds,
        )
    except httpx.HTTPError as exc:
        if diagnostic is not None:
            diagnostic.error_class = exception_class(exc)
        if observer is not None and observation is not None:
            observer.failure(observation, exc)
        raise ForwardingError(
            502, BAD_GATEWAY_BODY, "upstream_transport_failed", error_type=type(exc).__name__
        ) from exc
    finally:
        if diagnostic is not None:
            diagnostic.upstream_duration_ms = round((monotonic() - started) * 1000, 1)


async def reject_non_http(scope: Scope, send: Send) -> bool:
    """Close unsupported WebSockets; return whether HTTP forwarding should stop."""
    if scope["type"] == "http":
        return False
    if scope["type"] == "websocket":
        await send({"type": "websocket.close", "code": 1008})
    return True


def _record_failure(scope: Scope, reason: str, error_type: str = "none", upstream_status: int | None = None) -> None:
    diagnostic = get_diagnostics(scope)
    if diagnostic is not None:
        diagnostic.reason = reason
        diagnostic.error_type = error_type
        if upstream_status is not None:
            diagnostic.upstream_status = upstream_status


async def _send_failure(scope: Scope, send: Send, error: ForwardingError) -> None:
    _record_failure(scope, error.reason, error.error_type, error.upstream_status)
    await send_error(send, error.status, error.body)


async def _forward_stream(
    scope: Scope,
    receive: Receive,
    send: Send,
    transport: LiteLLMTransport,
    raw_path: bytes,
    *,
    build_request: Callable[[str], Awaitable[UpstreamRequest]],
    response_policy: Callable[[httpx.Response, str], ResponseHead],
    limits: BodyLimits,
    observer: LiteLLMDiagnostics | None,
    observation: UpstreamObservation | None,
) -> None:
    """Own receive/body iteration, timing, error mapping and upstream cleanup.

    Request and response policies only choose credentials, headers, queries and
    status/body overrides. Response streaming has no total-duration cap; browser
    request limits cover body ingestion and acquiring upstream response headers.
    """
    diagnostic = get_diagnostics(scope)
    request_id = (
        diagnostic.request_id
        if diagnostic is not None
        else safe_identifier(Request(scope).headers.get("x-request-id"), str(uuid4()))
    )
    response: httpx.Response | None = None
    content: AsyncGenerator[bytes, None] | None = None
    try:
        try:
            async with asyncio.timeout(limits.request_timeout_seconds):
                _check_content_length(scope, limits)
                first = await _receive_message(receive, limits)
                if first["type"] == "http.disconnect":
                    raise _ClientDisconnectedError
                _check_body_size(len(first.get("body", b"")), limits)
                if first.get("body") or first.get("more_body", False):
                    content = request_body(first, receive, limits)
                response = await _open_response(
                    scope, transport, raw_path, request_id, build_request, limits, content, observer, observation
                )
        except _ClientDisconnectedError:
            _record_failure(scope, "client_disconnected")
            return
        except ForwardingError as exc:
            await _send_failure(scope, send, exc)
            return
        except TimeoutError:
            await _send_failure(
                scope,
                send,
                ForwardingError(
                    408, b'{"detail":"LiteLLM request timed out"}', "request_timeout", error_type="TimeoutError"
                ),
            )
            return
        response.stream = _ResponseStream(response.stream, scope, observer, observation)
        if observer is not None and observation is not None:
            observer.phase(observation, "open_response")
        head = response_policy(response, request_id)
        if diagnostic is not None:
            diagnostic.upstream_status = response.status_code
            diagnostic.reason = head.reason
        await _send_response(response, send, head)
    except OSError:
        return
    finally:
        if observer is not None and observation is not None:
            observer.phase(observation, "closing")
        await finish_cleanup(
            _close_resources(scope, response, content, observer, propagating=sys.exception() is not None)
        )


def _cleanup_failure(scope: Scope, resource: str, error: BaseException, observer: LiteLLMDiagnostics | None) -> None:
    diagnostic = get_diagnostics(scope)
    if diagnostic is not None:
        diagnostic.cleanup_error_class = exception_class(error)
        if diagnostic.reason == "none":
            diagnostic.reason = "cleanup_failed"
    if observer is not None:
        observer.event("streaming", "cleanup_failure", error)
    logger.warning(
        "LiteLLM cleanup failed request_id=%s resource=%s exception_class=%s",
        diagnostic.request_id if diagnostic is not None else "none",
        resource,
        exception_class(error),
    )


class _ResponseStream(httpx.AsyncByteStream):
    """Protect HTTPX's automatic EOF close as well as the explicit final close."""

    def __init__(
        self,
        stream: httpx.AsyncByteStream,
        scope: Scope,
        observer: LiteLLMDiagnostics | None,
        observation: UpstreamObservation | None,
    ) -> None:
        self.stream, self.scope = stream, scope
        self.observer, self.observation = observer, observation

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self.stream:
            yield chunk

    async def aclose(self) -> None:
        if self.observer is not None and self.observation is not None:
            self.observer.phase(self.observation, "closing")
        try:
            await finish_cleanup(self.stream.aclose())
        except Exception as exc:
            _cleanup_failure(self.scope, "response", exc, self.observer)
            raise


async def _close_resources(
    scope: Scope,
    response: httpx.Response | None,
    content: AsyncGenerator[bytes, None] | None,
    observer: LiteLLMDiagnostics | None,
    *,
    propagating: bool,
) -> None:
    """Attempt both closes; a cleanup error must not mask an existing failure."""
    failure: BaseException | None = None
    for name, resource in (("response", response), ("upload", content)):
        if resource is None:
            continue
        try:
            await resource.aclose()
        except (Exception, asyncio.CancelledError) as exc:  # noqa: BLE001 - attempt both resources before propagation
            failure = failure or exc
            # The response wrapper already observes ordinary close errors.
            if (
                isinstance(exc, asyncio.CancelledError)
                or name != "response"
                or response is None
                or not isinstance(response.stream, _ResponseStream)
            ):
                _cleanup_failure(scope, name, exc, observer)
    if failure is not None and not propagating:
        raise failure


async def forward_stream(
    scope: Scope,
    receive: Receive,
    send: Send,
    transport: LiteLLMTransport,
    raw_path: bytes,
    *,
    build_request: Callable[[str], Awaitable[UpstreamRequest]],
    response_policy: Callable[[httpx.Response, str], ResponseHead],
    limits: BodyLimits = BodyLimits(),
) -> None:
    """Observe the full lifetime and cancel/join forwarding on downstream disconnect."""
    diagnostic = get_diagnostics(scope)
    candidate = getattr(transport, "diagnostics", None)
    observer = candidate if isinstance(candidate, LiteLLMDiagnostics) else None
    path = raw_path.decode("ascii", errors="replace")
    observation = (
        observer.begin(
            "streaming",
            path if path in DIAGNOSTIC_PATHS else "/{path}",
            diagnostic.request_id if diagnostic is not None else None,
        )
        if observer is not None
        else None
    )

    async def operate(receive_body: Receive) -> None:
        await _forward_stream(
            scope,
            receive_body,
            send,
            transport,
            raw_path,
            build_request=build_request,
            response_policy=response_policy,
            limits=limits,
            observer=observer,
            observation=observation,
        )

    try:
        await run_with_disconnect(operate, receive, lambda: _record_failure(scope, "client_disconnected"))
    except asyncio.CancelledError as exc:
        _record_failure(scope, "request_cancelled", "CancelledError")
        if diagnostic is not None:
            diagnostic.error_class = exception_class(exc)
        raise
    except httpx.HTTPError as exc:
        if diagnostic is not None:
            diagnostic.error_class = exception_class(exc)
        if observer is not None and observation is not None:
            observer.failure(observation, exc)
        raise
    finally:
        if observer is not None and observation is not None:
            if diagnostic is not None and diagnostic.reason in {"client_disconnected", "request_cancelled"}:
                observer.event("streaming", diagnostic.reason)
            observer.finish(observation)
