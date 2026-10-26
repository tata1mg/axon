"""Real-pool regressions for disconnect cleanup and incident failure classification.

No app lifespan, database, credentials, or external services are used. Connected
slow upload/downstream cases still characterize intentional timeout-policy limits.
"""

import asyncio
import logging
import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace

import httpcore
import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.clients.litellm.transport import LiteLLMTransport
from app.proxies.litellm import mount_litellm_proxy
from app.proxies.litellm_common import LiteLLMRequestLoggingMiddleware, ResponseHead, UpstreamRequest, forward_stream
from app.proxies.litellm_ui import mount_litellm_ui_proxy
from tests.test_litellm_pool_isolation import settings, upstream_server


def proxy(transport: LiteLLMTransport) -> ASGIApp:
    async def prepare(request_id: str) -> UpstreamRequest:
        return UpstreamRequest([(b"x-request-id", request_id.encode("ascii"))], b"")

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        await forward_stream(
            scope,
            receive,
            send,
            transport,
            scope["path"].encode("ascii"),
            build_request=prepare,
            response_policy=lambda response, request_id: ResponseHead(response.status_code, response.headers.raw),
        )

    return LiteLLMRequestLoggingMiddleware(app)


def scope(path: str = "/health/liveliness") -> Scope:
    return {
        "type": "http",
        "method": "GET",
        "path": path,
        "raw_path": path.encode("ascii"),
        "root_path": "",
        "headers": [(b"x-request-id", b"incident-local-test")],
        "query_string": b"",
        "state": {},
    }


async def healthy_request(transport: LiteLLMTransport) -> None:
    response = await asyncio.wait_for(transport.send_stream("GET", b"/ok", headers=[]), timeout=1)
    try:
        assert await response.aread() == b"ok"
    finally:
        await response.aclose()


async def healthy(writer: asyncio.StreamWriter) -> None:
    writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
    await writer.drain()


def test_real_pool_timeout_matches_incident_without_a_leak(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger="app.proxies.litellm_common")

    async def run() -> None:
        async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            request = await reader.readuntil(b"\r\n\r\n")
            if request.startswith(b"GET /hold "):
                writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n")
                await writer.drain()
                await reader.read()
            else:
                await healthy(writer)

        async with upstream_server(handler) as origin:
            transport = LiteLLMTransport(replace(settings(origin), pool_timeout_seconds=0.05))
            held = await transport.send_stream("GET", b"/hold", headers=[])
            try:
                # Verify both fully qualified exception classes, not just their names.
                with pytest.raises(httpx.PoolTimeout) as caught:
                    await transport.send_stream("GET", b"/health/liveliness", headers=[])
                assert type(caught.value) is httpx.PoolTimeout
                assert type(caught.value.__cause__) is httpcore.PoolTimeout

                messages: list[Message] = []

                async def receive() -> Message:
                    return {"type": "http.request", "body": b""}

                async def send(message: Message) -> None:
                    messages.append(message)

                # A scheduled callback runs while acquisition waits: no blocked loop is required.
                tick = asyncio.Event()
                asyncio.get_running_loop().call_later(0.01, tick.set)
                await proxy(transport)(scope(), receive, send)
                assert tick.is_set()
                assert messages[0]["status"] == 502
                assert messages[1]["body"] == b'{"detail":"LiteLLM upstream is unavailable"}'
                assert (b"x-request-id", b"incident-local-test") in messages[0]["headers"]

                # Management is isolated despite complete streaming-pool saturation.
                response = await transport.request("GET", "/ok", api_key="local-test", timeout_seconds=1)
                assert response.content == b"ok"
                await held.aclose()
                await healthy_request(transport)
            finally:
                await held.aclose()
                await transport.aclose()

    asyncio.run(run())
    diagnostic = next(
        record.getMessage() for record in caplog.records if "reason=upstream_transport_failed" in record.getMessage()
    )
    assert "stage=upstream reason=upstream_transport_failed upstream_status=none status=502" in diagnostic
    assert "error_type=PoolTimeout" in diagnostic


@pytest.mark.parametrize("stall_at", ["headers", "body"])
@pytest.mark.parametrize("termination", ["disconnect", "cancel"])
def test_disconnect_or_cancellation_releases_real_pool_slot(stall_at: str, termination: str) -> None:
    async def run() -> None:
        started, body_sent = asyncio.Event(), asyncio.Event()

        async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            request = await reader.readuntil(b"\r\n\r\n")
            if request.startswith(b"GET /hold "):
                if stall_at == "body":
                    writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n")
                    await writer.drain()
                started.set()
                await reader.read()
            else:
                await healthy(writer)

        async with upstream_server(handler) as origin:
            transport = LiteLLMTransport(replace(settings(origin), pool_timeout_seconds=0.05))
            incoming: asyncio.Queue[Message] = asyncio.Queue()
            incoming.put_nowait({"type": "http.request", "body": b""})

            async def send(message: Message) -> None:
                if message.get("body"):
                    body_sent.set()

            pending = asyncio.create_task(proxy(transport)(scope("/hold"), incoming.get, send))
            try:
                await asyncio.wait_for(started.wait(), timeout=1)
                if stall_at == "body":
                    await asyncio.wait_for(body_sent.wait(), timeout=1)
                assert not pending.done()
                if termination == "disconnect":
                    incoming.put_nowait({"type": "http.disconnect"})
                    await asyncio.wait_for(pending, timeout=0.5)
                    assert incoming.empty()
                    assert transport.diagnostics.snapshot()["events"]["streaming.client_disconnected"] == 1
                else:
                    pending.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await pending
                    assert transport.diagnostics.snapshot()["events"]["streaming.request_cancelled"] == 1
                assert not any(transport.diagnostics.snapshot()["active"]["streaming"].values())
                await healthy_request(transport)
            finally:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("stall_at", ["upload", "downstream"])
def test_idle_read_timeout_does_not_bound_upload_or_downstream_backpressure(stall_at: str) -> None:
    async def run() -> None:
        stalled = asyncio.Event()

        async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            request = await reader.readuntil(b"\r\n\r\n")
            if b" /hold " in request:
                if stall_at == "downstream":
                    writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n")
                    await writer.drain()
                await reader.read()
            else:
                await healthy(writer)

        async with upstream_server(handler) as origin:
            transport = LiteLLMTransport(
                replace(settings(origin), pool_timeout_seconds=0.05, read_timeout_seconds=0.05)
            )
            received = 0

            async def receive() -> Message:
                nonlocal received
                received += 1
                if stall_at == "upload":
                    if received > 1:
                        stalled.set()
                        await asyncio.Event().wait()
                    return {"type": "http.request", "body": b"first", "more_body": True}
                return {"type": "http.request", "body": b""}

            async def send(message: Message) -> None:
                if stall_at == "downstream" and message.get("body"):
                    stalled.set()
                    await asyncio.Event().wait()

            request_scope = scope("/hold")
            request_scope["method"] = {"upload": "POST", "downstream": "GET"}[stall_at]
            pending = asyncio.create_task(proxy(transport)(request_scope, receive, send))
            try:
                await asyncio.wait_for(stalled.wait(), timeout=1)
                # Neither upstream read-idle nor pool timeout limits an already occupied slot.
                await asyncio.sleep(0.15)
                assert not pending.done()
                with pytest.raises(httpx.PoolTimeout):
                    await transport.send_stream("GET", b"/ok", headers=[])
                pending.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await pending
                await healthy_request(transport)
            finally:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                await transport.aclose()

    asyncio.run(run())


def test_liveliness_session_401_never_reaches_litellm(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="app.proxies.litellm")

    async def run() -> None:
        seen: list[bytes] = []

        async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            seen.append(await reader.readuntil(b"\r\n\r\n"))
            await healthy(writer)

        async with upstream_server(handler) as origin:
            transport = LiteLLMTransport(settings(origin))
            app = FastAPI()
            app.state.litellm_transport = transport
            mount_litellm_proxy(app)
            mount_litellm_ui_proxy(app)
            try:
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://local.test"
                ) as client:
                    response = await client.get("/litellm/health/liveliness")
                    assert response.status_code == 401
                    assert not seen
                    response = await client.get("/litellm-admin/health/liveliness")
                    assert response.status_code == 200
                    assert len(seen) == 1
            finally:
                await transport.aclose()

    asyncio.run(run())
    diagnostic = next(
        record.getMessage() for record in caplog.records if "reason=session_auth_failed" in record.getMessage()
    )
    assert "path=/health/liveliness stage=session_auth reason=session_auth_failed" in diagnostic
    assert "upstream_status=none status=401 credential_mode=unresolved" in diagnostic


@asynccontextmanager
async def running_uvicorn(app: ASGIApp) -> AsyncIterator[tuple[str, int]]:
    config = uvicorn.Config(app, host="127.0.0.1", port=0, http="httptools", lifespan="off", access_log=False)
    server = uvicorn.Server(config)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(2):
            while not server.started:
                if serving.done():
                    await serving
                await asyncio.sleep(0.001)
        yield listener.getsockname()
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, timeout=2)
        listener.close()


@pytest.mark.parametrize("event_loop", ["asyncio", "uvloop"])
def test_real_uvicorn_disconnect_stops_upstream_stream(event_loop: str) -> None:
    async def run() -> None:
        closed, finished = asyncio.Event(), asyncio.Event()

        async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            request = await reader.readuntil(b"\r\n\r\n")
            if not request.startswith(b"GET /hold "):
                await healthy(writer)
                return
            writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            await writer.drain()
            eof = asyncio.create_task(reader.read())
            try:
                while not eof.done():
                    writer.write(b"1\r\na\r\n")
                    await writer.drain()
                    await asyncio.wait((eof,), timeout=0.01)
                await eof
                closed.set()
            finally:
                eof.cancel()
                await asyncio.gather(eof, return_exceptions=True)

        async with upstream_server(handler) as origin:
            transport = LiteLLMTransport(replace(settings(origin), pool_timeout_seconds=0.05))
            forwarding = proxy(transport)

            async def tracked(scope: Scope, receive: Receive, send: Send) -> None:
                try:
                    await forwarding(scope, receive, send)
                finally:
                    finished.set()

            try:
                async with running_uvicorn(tracked) as address:
                    reader, writer = await asyncio.open_connection(*address)
                    try:
                        writer.write(b"GET /hold HTTP/1.1\r\nHost: local.test\r\n\r\n")
                        await writer.drain()
                        await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=1)
                        writer.close()
                        await writer.wait_closed()
                        # No manual task cancellation or service restart may be needed.
                        await asyncio.wait_for(finished.wait(), timeout=0.5)
                        await asyncio.wait_for(closed.wait(), timeout=0.5)
                        await healthy_request(transport)
                        assert not any(transport.diagnostics.snapshot()["active"]["streaming"].values())
                    finally:
                        writer.close()
                        await writer.wait_closed()
            finally:
                await transport.aclose()

    loop_factory = None if event_loop == "asyncio" else pytest.importorskip("uvloop").new_event_loop
    with asyncio.Runner(loop_factory=loop_factory) as runner:
        runner.run(run())
