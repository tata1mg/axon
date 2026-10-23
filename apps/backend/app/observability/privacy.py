"""Strip content-bearing dependency attributes before any batch leaves the process."""

from collections.abc import Sequence

from opentelemetry.context import Context
from opentelemetry.sdk.trace import Event, ReadableSpan, Span, SpanProcessor
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import Status

# Do not trust instrumentation/environment header-capture settings. Never export
# raw URLs (paths/queries can be credentials), SQL, parameters, or exception text.
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
        attributes = {key: value for key, value in attributes.items() if key in DEPENDENCY_ATTRIBUTES}
        if scope.name.endswith("asyncpg"):
            operation = name.removeprefix("CURSOR: ").upper()
            name = f"POSTGRESQL {operation if operation in SQL_OPERATIONS else 'QUERY'}"
        else:
            method = str(attributes.get("http.request.method", attributes.get("http.method", "HTTP")))
            name = method if method in HTTP_METHODS else "HTTP"
    # Automatic instrumentors can record SQL/URL-bearing exception messages and
    # tracebacks even when ordinary attributes are sanitized. Preserve type only.
    events = [
        Event(
            "exception",
            attributes={"exception.type": (event.attributes or {}).get("exception.type", "Error")},
            timestamp=event.timestamp,
        )
        if event.name == "exception"
        else event
        for event in span.events
        if not dependency or event.name == "exception"
    ]
    return ReadableSpan(
        name=name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=attributes,
        events=events,
        kind=span.kind,
        status=Status(span.status.status_code),
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
