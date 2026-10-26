"""Strip content-bearing dependency attributes before any batch leaves the process."""

from collections.abc import Mapping, Sequence
from urllib.parse import quote, urlsplit, urlunsplit

from opentelemetry.context import Context
from opentelemetry.sdk.trace import Event, ReadableSpan, Span, SpanProcessor
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import Status, StatusCode

from app.observability.exceptions import exception_attributes, exception_message

# Do not trust instrumentation/environment header-capture settings. HTTP URLs
# retain destination/path, but not userinfo, queries, or fragments. SQL and
# parameters stay excluded; exception details use bounded best-effort redaction.
DEPENDENCY_ATTRIBUTES = frozenset(
    {
        "http.method",
        "http.request.method",
        "http.status_code",
        "http.response.status_code",
        "server.address",
        "server.port",
        "net.peer.name",
        "net.peer.port",
        "network.peer.address",
        "network.peer.port",
        "url.scheme",
        "http.scheme",
        "db.system",
        "db.system.name",
        "db.name",
        "db.namespace",
        "db.operation",
        "db.operation.name",
        "error.type",
        "sample_rate",
    }
)
SQL_OPERATIONS = frozenset(
    {
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "CREATE",
        "ALTER",
        "DROP",
        "BEGIN",
        "COMMIT",
        "ROLLBACK",
        "SAVEPOINT",
        "RELEASE",
        "SET",
        "SHOW",
        "WITH",
        "EXPLAIN",
        "TRUNCATE",
        "COPY",
    }
)
HTTP_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"})


def _http_destination(values: Mapping[str, object]) -> dict[str, str | int]:
    """Extract destination identity before discarding raw legacy/stable HTTP URLs."""
    for key in ("url.full", "http.url"):
        value = values.get(key)
        if (
            not isinstance(value, str)
            or len(value) > 16384
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
        ):
            continue
        try:
            url = urlsplit(value)
            host, port = url.hostname, url.port
        except ValueError:
            continue
        if url.scheme not in {"http", "https"} or not host or any(char.isspace() for char in host):
            continue
        authority = f"[{host}]" if ":" in host else host
        if port is not None:
            authority += f":{port}"
        path = quote(url.path or "/", safe="/%:@!$&'()*+,;=-._~")
        sanitized = urlunsplit((url.scheme, authority, path, "", ""))
        return {
            "http.url": sanitized,
            "url.full": sanitized,
            "http.host": authority,
            "server.address": host,
            "server.port": port if port is not None else (443 if url.scheme == "https" else 80),
            "http.scheme": url.scheme,
            "url.scheme": url.scheme,
        }
    return {}


def _dependency_attributes(scope_name: str, values: Mapping[str, object]) -> dict[str, object]:
    attributes = {key: value for key, value in values.items() if key in DEPENDENCY_ATTRIBUTES}
    if not scope_name.endswith("asyncpg"):
        attributes.update(_http_destination(values))
    # Support destination-based UIs regardless of the instrumentor's semconv mode.
    for modern, legacy in (
        ("server.address", "net.peer.name"),
        ("server.port", "net.peer.port"),
        ("http.request.method", "http.method"),
        ("http.response.status_code", "http.status_code"),
        ("db.system.name", "db.system"),
        ("db.namespace", "db.name"),
    ):
        value = attributes.get(modern, attributes.get(legacy))
        if value is not None:
            attributes[modern] = attributes[legacy] = value
    return attributes


class SampleRateProcessor(SpanProcessor):
    def __init__(self, rate: float) -> None:
        self.rate = rate

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        span.set_attribute("sample_rate", self.rate)


def safe_span(span: ReadableSpan) -> ReadableSpan:
    scope = span.instrumentation_scope
    dependency = scope is not None and scope.name.startswith("opentelemetry.instrumentation.")
    attributes = dict(span.attributes or {})
    name = span.name
    if dependency:
        attributes = _dependency_attributes(scope.name, attributes)
        if scope.name.endswith("asyncpg"):
            operation = name.removeprefix("CURSOR: ").upper()
            name = f"POSTGRESQL {operation if operation in SQL_OPERATIONS else 'QUERY'}"
        else:
            method = str(attributes.get("http.request.method", attributes.get("http.method", "HTTP")))
            method = method if method in HTTP_METHODS else "HTTP"
            destination = attributes.get("http.host", attributes.get("server.address"))
            name = f"{method} {destination}" if destination else method
    # Auto-instrumentors record raw exception text/tracebacks in events. Apply
    # the same redaction as app-owned spans, and retain only frame locations.
    events = [
        Event("exception", attributes=exception_attributes(event.attributes or {}), timestamp=event.timestamp)
        if event.name == "exception"
        else event
        for event in span.events
        if not dependency or event.name == "exception"
    ]
    details = next((event.attributes for event in reversed(events) if event.name == "exception"), None)
    description = exception_message(span.status.description) if span.status.description else None
    if details:
        # Some dependency instrumentors supply only exception.type, while UIs
        # expect error.type on the span itself. Replace generic fallbacks too.
        if attributes.get("error.type") in {None, "error", "Error", "_OTHER"}:
            attributes["error.type"] = details["exception.type"]
        description = details["exception.message"]
    if span.status.status_code == StatusCode.ERROR and not description:
        status = attributes.get("http.response.status_code", attributes.get("http.status_code"))
        if isinstance(status, int) and 400 <= status <= 599:
            attributes.setdefault("error.type", str(status))
            description = f"HTTP {status}"
        else:
            description = "Operation failed"
    return ReadableSpan(
        name=name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=attributes,
        events=events,
        kind=span.kind,
        status=Status(span.status.status_code, description if span.status.status_code == StatusCode.ERROR else None),
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=scope,
        # Auto-instrumentation links are not needed for HTTP/DB dependencies.
        links=() if dependency else span.links,
    )


class SafeSpanExporter(SpanExporter):
    def __init__(self, exporter: SpanExporter) -> None:
        self.exporter = exporter

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return self.exporter.export([safe_span(span) for span in spans])

    def shutdown(self) -> None:
        self.exporter.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self.exporter.force_flush(timeout_millis)
