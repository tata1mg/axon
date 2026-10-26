"""Outgoing destinations remain identifiable without URL credentials or query strings."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

from app.observability.privacy import SafeSpanExporter


def exported_span(attributes: dict[str, str | int], library: str = "httpx", name: str = "GET") -> ReadableSpan:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(SafeSpanExporter(exporter)))
    try:
        with provider.get_tracer(f"opentelemetry.instrumentation.{library}").start_as_current_span(
            name, kind=SpanKind.CLIENT, attributes=attributes
        ):
            pass
        return exporter.get_finished_spans()[0]
    finally:
        provider.shutdown()


@pytest.mark.parametrize("url_key", ["http.url", "url.full"])
@pytest.mark.parametrize(
    ("url", "sanitized", "host", "port", "authority"),
    [
        (
            "https://user:secret-password@upstream.test/files/file_abc123?key=secret-key#secret-fragment",
            "https://upstream.test/files/file_abc123",
            "upstream.test",
            443,
            "upstream.test",
        ),
        (
            "http://upstream.test:8080/responses/resp%2Fabc123?token=secret-token",
            "http://upstream.test:8080/responses/resp%2Fabc123",
            "upstream.test",
            8080,
            "upstream.test:8080",
        ),
        (
            "https://user:secret-password@[2001:db8::1]:8443/path?key=secret-key",
            "https://[2001:db8::1]:8443/path",
            "2001:db8::1",
            8443,
            "[2001:db8::1]:8443",
        ),
        (
            "http://upstream.test?X-Amz-Signature=secret-signature",
            "http://upstream.test/",
            "upstream.test",
            80,
            "upstream.test",
        ),
        (
            "https://UPSTREAM.test:443/path/",
            "https://upstream.test:443/path/",
            "upstream.test",
            443,
            "upstream.test:443",
        ),
        (
            "https://upstream.test/a path/café?key=secret-key",
            "https://upstream.test/a%20path/caf%C3%A9",
            "upstream.test",
            443,
            "upstream.test",
        ),
    ],
)
def test_http_destination_preserves_path_and_normalizes_old_and_new_attributes(
    url_key: str, url: str, sanitized: str, host: str, port: int, authority: str
) -> None:
    attributes = {
        url_key: url,
        "http.request.method" if url_key == "url.full" else "http.method": "GET",
        "http.request.header.authorization": "Bearer secret-header",
        "http.response.header.set_cookie": "token=secret-cookie",
    }
    span = exported_span(attributes)
    assert span.name == f"GET {authority}"
    assert span.attributes["http.url"] == sanitized
    assert span.attributes["url.full"] == sanitized
    assert span.attributes["http.host"] == authority
    assert span.attributes["server.address"] == span.attributes["net.peer.name"] == host
    assert span.attributes["server.port"] == span.attributes["net.peer.port"] == port
    assert span.attributes["http.method"] == span.attributes["http.request.method"] == "GET"
    assert span.attributes["url.scheme"] == span.attributes["http.scheme"] == sanitized.split(":")[0]
    assert "secret" not in span.to_json()
    assert "http.request.header.authorization" not in span.attributes
    assert "http.response.header.set_cookie" not in span.attributes
    # Export filtering must not alter the request or the instrumentor's original metadata.
    assert attributes[url_key] == url


@pytest.mark.parametrize(
    "url",
    [
        "https://user:secret-password@upstream.test:invalid/path",
        "https://[invalid-ipv6]/path?key=secret-key",
        "https:///path?key=secret-key",
        "upstream.test/path?key=secret-key",
        "postgresql://user:secret-password@database.test/axon",
        "https://upstream.test/path\n?key=secret-key",
        "https://upstream.test/" + "x" * 16384,
        42,
    ],
)
def test_invalid_urls_are_not_exported_or_allowed_to_break_a_batch(url: str | int) -> None:
    span = exported_span({"http.url": url, "http.method": "GET"})
    assert span.name == "GET"
    assert "http.url" not in span.attributes
    assert "url.full" not in span.attributes
    assert "secret" not in span.to_json()


def test_modern_url_takes_precedence_and_invalid_modern_url_falls_back_to_legacy() -> None:
    attributes = {
        "url.full": "https://modern.test/path?key=secret-modern",
        "http.url": "https://legacy.test/other?key=secret-legacy",
        "http.method": "POST",
    }
    span = exported_span(attributes)
    assert span.name == "POST modern.test"
    assert span.attributes["http.url"] == span.attributes["url.full"] == "https://modern.test/path"
    attributes["url.full"] = "invalid"
    span = exported_span(attributes)
    assert span.name == "POST legacy.test"
    assert span.attributes["http.url"] == span.attributes["url.full"] == "https://legacy.test/other"


@pytest.mark.parametrize("modern", [False, True])
def test_postgresql_destinations_have_both_schema_aliases_without_sql_or_credentials(modern: bool) -> None:
    attributes = {
        "db.system.name" if modern else "db.system": "postgresql",
        "db.namespace" if modern else "db.name": "axon",
        "server.address" if modern else "net.peer.name": "database.test",
        "server.port" if modern else "net.peer.port": 5432,
        "db.statement": "SELECT 'secret-query'",
        "db.query.text": "SELECT 'secret-query'",
        "db.statement.parameters": "secret-parameters",
        "db.user": "secret-db-user",
    }
    span = exported_span(attributes, library="asyncpg", name="SELECT")
    assert span.name == "POSTGRESQL SELECT"
    assert span.attributes["db.system"] == span.attributes["db.system.name"] == "postgresql"
    assert span.attributes["db.name"] == span.attributes["db.namespace"] == "axon"
    assert span.attributes["server.address"] == span.attributes["net.peer.name"] == "database.test"
    assert span.attributes["server.port"] == span.attributes["net.peer.port"] == 5432
    assert "secret" not in span.to_json()


@pytest.mark.parametrize("semconv_mode", ["", "http", "http/dup"])
def test_real_httpx_wrappers_export_destinations_in_every_semconv_mode(semconv_mode: str) -> None:
    # The SDK caches semantic-convention mode globally; isolate each real wrapper.
    script = """
import asyncio
from unittest.mock import patch
import httpx
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from app.observability.privacy import SafeSpanExporter

exporter = InMemorySpanExporter()
provider = TracerProvider()
provider.add_span_processor(SimpleSpanProcessor(SafeSpanExporter(exporter)))
metrics = MeterProvider()
instrumentor = HTTPXClientInstrumentor()

async def upstream(self, request):
    return httpx.Response(200, content=b"ok")

async def run():
    async with httpx.AsyncClient(trust_env=False) as client:
        await client.get("https://user:secret-password@upstream.test:8443/files/file_abc123?key=secret-key")

try:
    with patch.object(httpx.AsyncHTTPTransport, "handle_async_request", upstream):
        instrumentor.instrument(tracer_provider=provider, meter_provider=metrics)
        try:
            asyncio.run(run())
        finally:
            instrumentor.uninstrument()
    span, = exporter.get_finished_spans()
    assert span.name == "GET upstream.test:8443"
    assert span.attributes["http.url"] == span.attributes["url.full"] == "https://upstream.test:8443/files/file_abc123"
    assert span.attributes["server.address"] == span.attributes["net.peer.name"] == "upstream.test"
    assert span.attributes["server.port"] == span.attributes["net.peer.port"] == 8443
    assert span.attributes["http.status_code"] == span.attributes["http.response.status_code"] == 200
    assert "secret" not in span.to_json()
finally:
    provider.shutdown()
    metrics.shutdown()
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, "OTEL_SEMCONV_STABILITY_OPT_IN": semconv_mode},
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_existing_destination_metadata_is_used_when_no_url_is_available() -> None:
    span = exported_span({"http.request.method": "PATCH", "server.address": "upstream.test", "server.port": 8443})
    assert span.name == "PATCH upstream.test"
    assert span.attributes["net.peer.name"] == "upstream.test"
    assert span.attributes["net.peer.port"] == 8443
    assert "http.url" not in span.attributes
