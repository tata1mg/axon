"""Bounded, worker-local LiteLLM lifecycle diagnostics, not HTTP pool internals."""

import logging
import os
from collections import Counter
from dataclasses import dataclass, field
from threading import Lock
from time import monotonic
from typing import Any

import httpx
from opentelemetry.metrics import CallbackOptions, Meter, Observation

logger = logging.getLogger(__name__)
SAMPLE_LIMIT = 128
PHASES = ("preparing", "awaiting_headers", "open_response", "closing", "buffered_request")
DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 360, 900]


def exception_class(error: BaseException) -> str:
    return f"{type(error).__module__}.{type(error).__qualname__}"


@dataclass(eq=False)
class UpstreamObservation:
    pool: str
    route: str
    request_id: str | None
    phase: str = "preparing"
    started: float = field(default_factory=monotonic)
    phase_started: float = field(default_factory=monotonic)
    finished: bool = False


class LiteLLMDiagnostics:
    """Counts are exact; oldest ages are from a bounded sample of active requests.

    No bodies, URLs, queries or headers are retained. Awaiting headers includes
    pool wait, connection setup, upload and headers I/O; it is NOT pool wait time.
    The lock protects small snapshots collected by OTel's exporter thread.
    """

    def __init__(self, meter: Meter | None = None) -> None:
        self._lock = Lock()
        self._counts: Counter[tuple[str, str]] = Counter()
        self._events: Counter[tuple[str, str]] = Counter()
        self._sample: dict[int, UpstreamObservation] = {}
        self._last_timeout_log = float("-inf")
        self._duration = self._phase_duration = self._event_counter = None
        if meter is not None:
            meter.create_observable_gauge("axon.litellm.requests.active", callbacks=[self._active], unit="{request}")
            meter.create_observable_gauge(
                "axon.litellm.requests.sampled_oldest_age", callbacks=[self._oldest], unit="s"
            )
            self._duration = meter.create_histogram(
                "axon.litellm.request.duration", unit="s", explicit_bucket_boundaries_advisory=DURATION_BUCKETS
            )
            self._phase_duration = meter.create_histogram(
                "axon.litellm.phase.duration", unit="s", explicit_bucket_boundaries_advisory=DURATION_BUCKETS
            )
            self._event_counter = meter.create_counter("axon.litellm.events", unit="{event}")

    def begin(self, pool: str, route: str, request_id: str | None) -> UpstreamObservation:
        observation = UpstreamObservation(pool, route, request_id)
        with self._lock:
            self._counts[pool, observation.phase] += 1
            if len(self._sample) < SAMPLE_LIMIT:
                self._sample[id(observation)] = observation
        return observation

    def phase(self, observation: UpstreamObservation, phase: str) -> None:
        now = monotonic()
        with self._lock:
            if observation.finished or observation.phase == phase:
                return
            previous, elapsed = observation.phase, now - observation.phase_started
            self._counts[observation.pool, previous] -= 1
            self._counts[observation.pool, phase] += 1
            observation.phase, observation.phase_started = phase, now
        if self._phase_duration is not None:
            self._phase_duration.record(
                elapsed, {"pool": observation.pool, "phase": previous, "http.route": observation.route}
            )

    def finish(self, observation: UpstreamObservation) -> None:
        with self._lock:
            if observation.finished:
                return
            observation.finished = True
            self._counts[observation.pool, observation.phase] -= 1
            self._sample.pop(id(observation), None)
        if self._phase_duration is not None:
            self._phase_duration.record(
                monotonic() - observation.phase_started,
                {"pool": observation.pool, "phase": observation.phase, "http.route": observation.route},
            )
        if self._duration is not None:
            self._duration.record(
                monotonic() - observation.started, {"pool": observation.pool, "http.route": observation.route}
            )

    def event(self, pool: str, event: str, error: BaseException | None = None) -> None:
        with self._lock:
            self._events[pool, event] += 1
        if self._event_counter is not None:
            attributes = {"pool": pool, "event": event}
            if error is not None:
                attributes["error.type"] = exception_class(error)
            self._event_counter.add(1, attributes)

    def failure(self, observation: UpstreamObservation, error: httpx.HTTPError) -> None:
        self.event(
            observation.pool, "pool_timeout" if isinstance(error, httpx.PoolTimeout) else "transport_failure", error
        )
        if not isinstance(error, httpx.PoolTimeout):
            return
        now = monotonic()
        with self._lock:
            # Always count failures; bound snapshot log volume during an outage.
            if now - self._last_timeout_log < 1:
                return
            self._last_timeout_log = now
        logger.warning(
            "LiteLLM pool timeout request_id=%s pid=%s pool=%s exception_class=%s cause_class=%s snapshot=%s",
            observation.request_id,
            os.getpid(),
            observation.pool,
            exception_class(error),
            exception_class(error.__cause__) if error.__cause__ is not None else "none",
            self.snapshot(),
        )

    def snapshot(self) -> dict[str, Any]:
        now = monotonic()
        with self._lock:
            return {
                "active": {
                    pool: {phase: self._counts[pool, phase] for phase in PHASES} for pool in ("streaming", "management")
                },
                "events": {f"{pool}.{event}": count for (pool, event), count in self._events.items()},
                "sample_size": len(self._sample),
                "sample_limit": SAMPLE_LIMIT,
                "oldest": [
                    {
                        "pool": item.pool,
                        "phase": item.phase,
                        "route": item.route,
                        "request_id": item.request_id,
                        "age_seconds": round(now - item.started, 3),
                        "phase_age_seconds": round(now - item.phase_started, 3),
                    }
                    for item in sorted(self._sample.values(), key=lambda item: item.started)[:3]
                ],
            }

    def _active(self, options: CallbackOptions) -> list[Observation]:
        with self._lock:
            return [
                Observation(self._counts[pool, phase], {"pool": pool, "phase": phase})
                for pool in ("streaming", "management")
                for phase in PHASES
            ]

    def _oldest(self, options: CallbackOptions) -> list[Observation]:
        now = monotonic()
        with self._lock:
            return [
                Observation(
                    max((now - item.started for item in self._sample.values() if item.pool == pool), default=0),
                    {"pool": pool},
                )
                for pool in ("streaming", "management")
            ]
