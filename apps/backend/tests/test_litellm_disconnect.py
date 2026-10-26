"""Disconnect ownership, pool-wait cancellation and cancellation-resistant cleanup."""

import asyncio
import logging
from collections.abc import AsyncIterator

import httpx
import pytest
from starlette.types import Message, Receive, Scope, Send

from app.clients.litellm.transport import LiteLLMTransport
from app.proxies.disconnect import run_with_disconnect
from app.proxies.litellm_common import (
    LiteLLMRequestLoggingMiddleware,
    ResponseHead,
    UpstreamRequest,
    _close_resources,
    forward_stream,
)
from tests.test_litellm_incident_reproduction import healthy, healthy_request, proxy, scope
from tests.test_litellm_pool_isolation import settings, upstream_server


def test_disconnect_cancels_waiting_pool_request_without_affecting_holder() -> None:
    async def run() -> None:
        entered = asyncio.Event()

        async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            request = await reader.readuntil(b"\r\n\r\n")
            if request.startswith(b"GET /hold "):
                writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n")
                await writer.drain()
                await reader.read()
            else:
                await healthy(writer)

        async with upstream_server(handler) as origin:
            transport = LiteLLMTransport(settings(origin))
            held = await transport.send_stream("GET", b"/hold", headers=[])
            incoming: asyncio.Queue[Message] = asyncio.Queue()
            incoming.put_nowait({"type": "http.request", "body": b""})

            async def prepare(request_id: str) -> UpstreamRequest:
                entered.set()
                return UpstreamRequest([], b"")

            async def send(message: Message) -> None:
                pytest.fail("A disconnected pool waiter must not send a response")

            async def app(scope: Scope, receive: Receive, send: Send) -> None:
                await forward_stream(
                    scope,
                    receive,
                    send,
                    transport,
                    b"/ok",
                    build_request=prepare,
                    response_policy=lambda response, request_id: ResponseHead(response.status_code, []),
                )

            pending = asyncio.create_task(LiteLLMRequestLoggingMiddleware(app)(scope(), incoming.get, send))
            try:
                await asyncio.wait_for(entered.wait(), timeout=1)
                assert transport.diagnostics.snapshot()["active"]["streaming"]["awaiting_headers"] == 1
                incoming.put_nowait({"type": "http.disconnect"})
                await asyncio.wait_for(pending, timeout=0.5)
                assert not held.is_closed
                assert not any(transport.diagnostics.snapshot()["active"]["streaming"].values())
                assert transport.diagnostics.snapshot()["events"]["streaming.client_disconnected"] == 1
                await held.aclose()
                await healthy_request(transport)
            finally:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                await held.aclose()
                await transport.aclose()

    asyncio.run(run())


def test_disconnect_watcher_never_reads_ahead_of_upload() -> None:
    async def run() -> None:
        incoming: asyncio.Queue[Message] = asyncio.Queue()
        incoming.put_nowait({"type": "http.request", "body": b"first", "more_body": True})
        incoming.put_nowait({"type": "http.request", "body": b"last", "more_body": False})
        first_read, continue_upload, body_read, stopped = (asyncio.Event() for _ in range(4))
        received = 0
        reading = False
        disconnected = False

        async def receive() -> Message:
            nonlocal received, reading
            assert not reading
            reading = True
            try:
                message = await incoming.get()
                received += 1
                return message
            finally:
                reading = False

        async def operation(receive_body: Receive) -> None:
            try:
                assert (await receive_body())["body"] == b"first"
                first_read.set()
                await continue_upload.wait()
                assert (await receive_body())["body"] == b"last"
                body_read.set()
                await asyncio.Event().wait()
            finally:
                stopped.set()

        def disconnect() -> None:
            nonlocal disconnected
            disconnected = True

        task = asyncio.create_task(run_with_disconnect(operation, receive, disconnect))
        try:
            await asyncio.wait_for(first_read.wait(), timeout=1)
            await asyncio.sleep(0)
            assert received == 1 and incoming.qsize() == 1
            continue_upload.set()
            await asyncio.wait_for(body_read.wait(), timeout=1)
            incoming.put_nowait({"type": "http.disconnect"})
            await asyncio.wait_for(task, timeout=1)
            assert received == 3
            assert stopped.is_set() and disconnected
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())


@pytest.mark.parametrize("cancel_at", ["streaming", "closing"])
def test_repeated_cancellation_waits_for_cleanup_and_joins_owned_tasks(cancel_at: str) -> None:
    async def run() -> None:
        started, closing, release, closed = (asyncio.Event() for _ in range(4))

        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self) -> AsyncIterator[bytes]:
                yield b"data"
                if cancel_at == "streaming":
                    await asyncio.Event().wait()

            async def aclose(self) -> None:
                closing.set()
                await release.wait()
                closed.set()

        def upstream(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, stream=Stream())

        transport = LiteLLMTransport(
            settings("http://local.test"), client=httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        )
        incoming: asyncio.Queue[Message] = asyncio.Queue()
        incoming.put_nowait({"type": "http.request", "body": b""})

        async def send(message: Message) -> None:
            if message.get("body"):
                started.set()

        pending = asyncio.create_task(proxy(transport)(scope(), incoming.get, send))
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            if cancel_at == "streaming":
                pending.cancel()
            await asyncio.wait_for(closing.wait(), timeout=1)
            pending.cancel()
            await asyncio.sleep(0)
            pending.cancel()
            await asyncio.sleep(0)
            assert not pending.done() and not closed.is_set()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert closed.is_set()
            assert not any(transport.diagnostics.snapshot()["active"]["streaming"].values())
            assert not [
                task for task in asyncio.all_tasks() if task.get_name() in {"litellm-forward", "litellm-disconnect"}
            ]
        finally:
            release.set()
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("error_type", [RuntimeError, asyncio.CancelledError])
def test_both_resources_are_closed_when_response_close_fails(error_type: type[BaseException]) -> None:
    async def run() -> None:
        closed = asyncio.Event()

        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self) -> AsyncIterator[bytes]:
                yield b"unused"

            async def aclose(self) -> None:
                raise error_type("secret-close-error")

        async def upload() -> AsyncIterator[bytes]:
            try:
                yield b"secret-body"
            finally:
                closed.set()

        content = upload()
        await anext(content)
        with pytest.raises(error_type):
            await _close_resources(scope(), httpx.Response(200, stream=Stream()), content, None, propagating=False)
        assert closed.is_set()

    asyncio.run(run())


def test_cleanup_failure_does_not_mask_original_upstream_error(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING)

    async def run() -> None:
        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self) -> AsyncIterator[bytes]:
                yield b"secret-prompt"
                raise httpx.ReadError("secret-upstream-message")

            async def aclose(self) -> None:
                raise RuntimeError("secret-close-message")

        def upstream(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, stream=Stream())

        transport = LiteLLMTransport(
            settings("http://local.test"), client=httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        )
        incoming: asyncio.Queue[Message] = asyncio.Queue()
        incoming.put_nowait({"type": "http.request", "body": b""})

        async def send(message: Message) -> None:
            pass

        try:
            with pytest.raises(httpx.ReadError):
                await proxy(transport)(scope(), incoming.get, send)
            snapshot = transport.diagnostics.snapshot()
            assert snapshot["events"]["streaming.cleanup_failure"] == 1
            assert snapshot["events"]["streaming.transport_failure"] == 1
            assert not any(snapshot["active"]["streaming"].values())
        finally:
            await transport.aclose()

    asyncio.run(run())
    assert "secret" not in caplog.text
    assert "exception_class=builtins.RuntimeError" in caplog.text
    assert "exception_class=httpx.ReadError" in caplog.text
