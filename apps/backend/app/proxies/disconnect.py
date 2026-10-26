"""Race proxy work against disconnects without reading ahead of an upload."""

import asyncio
from collections.abc import Awaitable, Callable

from starlette.types import Message, Receive


async def _cancel_and_join(tasks: tuple[asyncio.Task[None], ...]) -> None:
    """Join owned tasks even if shutdown cancels this owner again during cleanup."""
    for task in tasks:
        if not task.done():
            task.cancel()
    joined = asyncio.gather(*tasks, return_exceptions=True)
    cancelled = False
    while not joined.done():
        try:
            await asyncio.shield(joined)
        except asyncio.CancelledError:
            cancelled = True
    if cancelled:
        raise asyncio.CancelledError


async def finish_cleanup(cleanup: Awaitable[None]) -> None:
    """Finish owned cleanup before propagating even repeated task cancellation."""
    task = asyncio.ensure_future(cleanup)
    cancellation: asyncio.CancelledError | None = None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as exc:
            cancellation = exc
        except Exception:
            if cancellation is not None:
                raise cancellation from None
            raise
    if cancellation is not None:
        raise cancellation
    task.result()


async def run_with_disconnect(
    operation: Callable[[Receive], Awaitable[None]], receive: Receive, disconnected: Callable[[], None]
) -> None:
    """Only the body reader calls receive until the final request frame is seen.

    Afterwards the watcher owns receive, including while work waits for a pool
    slot, response headers, upstream chunks, or downstream backpressure. Both
    tasks are joined before returning; the operation retains response ownership.
    """
    body_complete = asyncio.Event()

    async def receive_body() -> Message:
        message = await receive()
        if message["type"] == "http.request" and not message.get("more_body", False):
            body_complete.set()
        return message

    async def watch() -> None:
        await body_complete.wait()
        while True:
            if (await receive())["type"] == "http.disconnect":
                return
            # ASGI normally sends only disconnect after the final body frame.
            # Yield defensively if a server/adapter supplies extra empty frames.
            await asyncio.sleep(0)

    work = asyncio.create_task(operation(receive_body), name="litellm-forward")
    watcher = asyncio.create_task(watch(), name="litellm-disconnect")
    try:
        await asyncio.wait((work, watcher), return_when=asyncio.FIRST_COMPLETED)
        # Normal completion wins if final send and disconnect become ready together.
        if work.done():
            await work
        else:
            await watcher
            disconnected()
    finally:
        await _cancel_and_join((work, watcher))
