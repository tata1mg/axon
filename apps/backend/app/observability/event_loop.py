"""Cheap sleep-lag metrics; no stack capture, subprocesses, or user content."""

import asyncio
from collections.abc import Iterable

from opentelemetry.metrics import CallbackOptions, Meter, Observation

# Counting tasks copies the loop's task set; refresh it at most this often
# instead of on every lag sample. Metric exports are much less frequent.
TASK_COUNT_INTERVAL_SECONDS = 1.0


class EventLoopMonitor:
    def __init__(self, meter: Meter, interval: float, blocking_threshold: float) -> None:
        self.interval = interval
        self.blocking_threshold = blocking_threshold
        self.lag_ms = 0.0
        self.max_lag_ms = 0.0
        self.active_tasks = 0
        self.utilization = 0.0
        self.task: asyncio.Task[None] | None = None
        self._tasks_counted_at: float | None = None
        self.blocking = meter.create_counter("asyncio.eventloop.blocking_events", unit="{events}")
        for name, field, unit in (
            ("lag", "lag_ms", "ms"),
            ("active_tasks", "active_tasks", "{tasks}"),
            ("utilization", "utilization", "%"),
        ):
            meter.create_observable_gauge(
                f"asyncio.eventloop.{name}",
                callbacks=[self._observer(field)],
                unit=unit,
            )
        meter.create_observable_gauge("asyncio.eventloop.max_lag", callbacks=[self._observe_max_lag], unit="ms")

    def _observer(self, field: str):  # noqa: ANN202 - SDK callback factory
        def observe(options: CallbackOptions) -> Iterable[Observation]:
            return [Observation(getattr(self, field))]

        return observe

    def _observe_max_lag(self, options: CallbackOptions) -> Iterable[Observation]:
        # Report the worst lag since the previous collection, then start a new
        # window; a lifetime maximum would hide every later regression.
        value, self.max_lag_ms = self.max_lag_ms, self.lag_ms
        return [Observation(value)]

    def start(self) -> None:
        if self.task is None:
            self.task = asyncio.create_task(self._run(), name="axon-event-loop-monitor")

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            started = loop.time()
            await asyncio.sleep(self.interval)
            elapsed = loop.time() - started
            lag = max(0.0, elapsed - self.interval)
            self.lag_ms = lag * 1000
            self.max_lag_ms = max(self.max_lag_ms, self.lag_ms)
            now = loop.time()
            if self._tasks_counted_at is None or now - self._tasks_counted_at >= TASK_COUNT_INTERVAL_SECONDS:
                self.active_tasks = len(asyncio.all_tasks(loop))
                self._tasks_counted_at = now
            # Scheduling-lag estimate, not CPU utilization.
            self.utilization = min(100.0, lag / elapsed * 100) if elapsed else 0.0
            if lag > self.blocking_threshold:
                self.blocking.add(1)

    async def stop(self) -> None:
        task, self.task = self.task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
