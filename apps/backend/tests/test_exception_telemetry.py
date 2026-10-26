"""Exception traces retain useful details without raw credentials or source lines."""

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Status, StatusCode

from app.observability.exceptions import (
    MAX_MESSAGE_LENGTH,
    MAX_STACK_FRAMES,
    MAX_STACK_LENGTH,
    exception_attributes,
    exception_message,
    exception_stacktrace,
    record_safe_exception,
)
from app.observability.privacy import SafeSpanExporter


@pytest.mark.parametrize(
    "message",
    [
        "connection timed out after 10 seconds",
        "invalid literal for int() with base 10: 'abc'",
        "model service returned HTTP 503",
    ],
)
def test_useful_exception_messages_remain_readable(message: str) -> None:
    assert exception_message(message) == message


@pytest.mark.parametrize(
    "message",
    [
        "request failed Authorization: Bearer secret-token",
        "request failed proxy_authorization=Basic secret-password",
        "request failed Bearer secret-token",
        "failed GET https://user:secret-password@private.test/path?key=secret-query",
        "connection failed postgresql://user:secret-password@db.test/private",
        "token=secret-token",
        "access_token='secret-token with spaces'",
        'failure: {"api_key": "secret-key", "status": 500}',
        "x-api-key=secret-key",
        "password=secret-password; status=500",
        "token=Bearer secret-token",
        'token={"nested": "secret-token", "extra": "secret-value"}',
        "cookie: token=secret-token; session=secret-session",
        "Set-Cookie: session=secret-session; other=secret-value",
        "invalid prompt=secret prompt\ncontinued secret prompt",
        'failure payload={"nested": ["secret-body", "secret-value"]}',
        'failure body={"content": "secret-body"}',
        "query=SELECT 'secret-query'",
        "database error: SELECT 'secret-query' FROM private_table",
        "invalid email secret-email@example.test",
        "invalid key sk-secretkey123456789",
        "invalid JWT eyJhbGciOiJIUzI1NiJ9.secretpayload.secretvalue",
        "invalid key ghp_secretkey123456789",
    ],
)
def test_exception_message_redacts_sensitive_patterns(message: str) -> None:
    result = exception_message(message)
    assert "secret" not in result
    assert "[REDACTED" in result
    assert exception_message(result) == result


def test_messages_are_bounded_and_control_characters_are_normalized() -> None:
    assert len(exception_message("x" * 20000)) <= MAX_MESSAGE_LENGTH
    assert exception_message("failed\r\nrequest\toperation") == "failed request operation"
    assert exception_message("failed\x00request\x1boperation") == "failed request operation"
    assert "secret" not in exception_message("token=" + "secret" * 10000)


def test_tracebacks_retain_only_bounded_frame_locations() -> None:
    raw = (
        "\n".join(
            f'  File "/app/service.py", line {number}, in operation\n    execute("secret-source", token="secret-value")'
            for number in range(40)
        )
        + "\nValueError: secret-exception-value"
    )
    result = exception_stacktrace(raw)
    assert len(result) <= MAX_STACK_LENGTH
    assert result.count('File "/app/service.py"') == MAX_STACK_FRAMES
    assert "line 39, in operation" in result
    assert "secret" not in result
    assert exception_stacktrace(result) == result


def test_exception_event_attributes_do_not_retain_arbitrary_metadata() -> None:
    result = exception_attributes(
        {
            "exception.type": "httpx.ReadTimeout",
            "exception.message": "request failed token=secret-token",
            "request.body": "secret-body",
            "exception.stacktrace": '  File "/app/service.py", line 42, in operation\n    secret_source()',
        }
    )
    assert result == {
        "exception.type": "httpx.ReadTimeout",
        "exception.message": "request failed token=[REDACTED]",
        "exception.stacktrace": '  File "/app/service.py", line 42, in operation',
    }
    assert exception_attributes(result) == result


@pytest.mark.parametrize("existing_type", [None, "error", "Error", "_OTHER"])
def test_exporter_populates_actual_error_type_and_redacted_status_description(existing_type: str | None) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(SafeSpanExporter(exporter)))
    try:
        with provider.get_tracer("opentelemetry.instrumentation.httpx").start_as_current_span("GET") as span:
            if existing_type is not None:
                span.set_attribute("error.type", existing_type)
            span.add_event(
                "exception",
                {
                    "exception.type": "httpx.ReadTimeout",
                    "exception.message": "upstream timed out token=secret-token",
                    "exception.stacktrace": '  File "/app/service.py", line 42, in operation\n    secret_source()',
                },
            )
            span.set_status(Status(StatusCode.ERROR, "raw secret-status-description"))
        exported = exporter.get_finished_spans()[0]
        assert exported.attributes["error.type"] == "httpx.ReadTimeout"
        assert exported.status.description == "upstream timed out token=[REDACTED]"
        assert exported.events[0].attributes["exception.message"] == exported.status.description
        assert "secret" not in exported.to_json()
    finally:
        provider.shutdown()


def test_record_safe_exception_keeps_the_original_error_if_message_formatting_fails() -> None:
    class BrokenError(Exception):
        def __str__(self) -> str:
            raise RuntimeError("secret-formatting-error")

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(SafeSpanExporter(exporter)))
    try:
        with provider.get_tracer("axon-backend").start_as_current_span("operation") as span:
            try:
                raise BrokenError()
            except BrokenError as exc:
                assert record_safe_exception(span, exc) == "BrokenError"
        exported = exporter.get_finished_spans()[0]
        assert exported.attributes["error.type"] == "BrokenError"
        assert exported.status.description == "BrokenError"
        assert "test_record_safe_exception" in exported.events[0].attributes["exception.stacktrace"]
        assert "secret" not in exported.to_json()
    finally:
        provider.shutdown()
