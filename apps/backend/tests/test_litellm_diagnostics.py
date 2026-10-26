"""Bounded lifecycle state, low-cardinality metrics and secret-free failure logs."""

import asyncio
import logging

import httpcore
import httpx
import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from app.clients.litellm.transport import LiteLLMTransport
from app.observability.context import REQUEST_ID
from app.observability.litellm import SAMPLE_LIMIT, LiteLLMDiagnostics
from tests.test_litellm_pool_isolation import settings


def test_counts_include_sample_overflow_and_finish_is_idempotent() -> None:
    diagnostics = LiteLLMDiagnostics()
    observations = [
        diagnostics.begin("streaming", "/v1/models", f"request-{index}") for index in range(SAMPLE_LIMIT + 5)
    ]
    for observation in observations:
        diagnostics.phase(observation, "awaiting_headers")
    snapshot = diagnostics.snapshot()
    assert snapshot["sample_size"] == SAMPLE_LIMIT
    assert snapshot["active"]["streaming"]["awaiting_headers"] == SAMPLE_LIMIT + 5
    assert len(snapshot["oldest"]) == 3
    for observation in observations:
        diagnostics.phase(observation, "open_response")
        diagnostics.phase(observation, "closing")
        diagnostics.finish(observation)
        diagnostics.finish(observation)
    snapshot = diagnostics.snapshot()
    assert snapshot["sample_size"] == 0
    assert not any(snapshot["active"]["streaming"].values())


def test_pool_timeout_snapshot_is_rate_limited_but_counts_every_failure(caplog: pytest.LogCaptureFixture) -> None:
    diagnostics = LiteLLMDiagnostics()
    observation = diagnostics.begin("streaming", "/{path}", "correlation-id")
    diagnostics.phase(observation, "awaiting_headers")
    error = httpx.PoolTimeout("secret-url?api_key=secret-key")
    error.__cause__ = httpcore.PoolTimeout("secret-cause")
    with caplog.at_level(logging.WARNING, logger="app.observability.litellm"):
        diagnostics.failure(observation, error)
        diagnostics.failure(observation, error)
    records = [record for record in caplog.records if "LiteLLM pool timeout" in record.getMessage()]
    assert len(records) == 1
    message = records[0].getMessage()
    assert "request_id=correlation-id" in message
    assert "exception_class=httpx.PoolTimeout cause_class=httpcore.PoolTimeout" in message
    assert "awaiting_headers" in message
    assert "secret" not in message
    assert records[0].exc_info is None
    assert diagnostics.snapshot()["events"]["streaming.pool_timeout"] == 2
    diagnostics.finish(observation)


def test_metrics_export_active_state_ages_and_durations_without_request_ids() -> None:
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    try:
        diagnostics = LiteLLMDiagnostics(provider.get_meter("test"))
        observation = diagnostics.begin("streaming", "/v1/models", "secret-correlation-id")
        diagnostics.phase(observation, "awaiting_headers")
        data = reader.get_metrics_data()
        metrics = {
            metric.name: metric
            for resource in data.resource_metrics
            for scope in resource.scope_metrics
            for metric in scope.metrics
        }
        active = metrics["axon.litellm.requests.active"].data.data_points
        assert any(
            point.value == 1 and point.attributes == {"pool": "streaming", "phase": "awaiting_headers"}
            for point in active
        )
        assert "axon.litellm.requests.sampled_oldest_age" in metrics
        diagnostics.phase(observation, "open_response")
        diagnostics.phase(observation, "closing")
        diagnostics.event("streaming", "client_disconnected")
        diagnostics.finish(observation)
        data = reader.get_metrics_data()
        metrics = {
            metric.name: metric
            for resource in data.resource_metrics
            for scope in resource.scope_metrics
            for metric in scope.metrics
        }
        assert "axon.litellm.request.duration" in metrics
        assert "axon.litellm.phase.duration" in metrics
        assert "axon.litellm.events" in metrics
        assert not any(point.value for point in metrics["axon.litellm.requests.active"].data.data_points)
        attributes = [dict(point.attributes) for metric in metrics.values() for point in metric.data.data_points]
        assert "secret" not in repr(attributes)
        assert not any("request_id" in item for item in attributes)
    finally:
        provider.shutdown()


def test_buffered_cancellation_counts_and_releases_observation() -> None:
    async def run() -> None:
        entered = asyncio.Event()

        async def upstream(request: httpx.Request) -> httpx.Response:
            entered.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        transport = LiteLLMTransport(
            settings("http://local.test"), management_client=httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        )
        token = REQUEST_ID.set("correlated-management")
        pending = asyncio.create_task(
            transport.request("GET", "/unknown/secret-resource", api_key="secret-key", timeout_seconds=1)
        )
        try:
            await asyncio.wait_for(entered.wait(), timeout=1)
            snapshot = transport.diagnostics.snapshot()
            assert snapshot["active"]["management"]["buffered_request"] == 1
            assert snapshot["oldest"][0]["route"] == "/{path}"
            assert snapshot["oldest"][0]["request_id"] == "correlated-management"
            assert "secret" not in repr(snapshot)
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
            snapshot = transport.diagnostics.snapshot()
            assert snapshot["events"]["management.request_cancelled"] == 1
            assert not any(snapshot["active"]["management"].values())
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            REQUEST_ID.reset(token)
            await transport.aclose()

    asyncio.run(run())
