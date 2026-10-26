"""Bounded exception details for traces, without credentials or source-code lines."""

import re
from collections.abc import Mapping
from traceback import walk_tb

from opentelemetry.trace import Span, Status, StatusCode

MAX_MESSAGE_LENGTH = 1024
MAX_STACK_LENGTH = 4096
MAX_INPUT_LENGTH = 16384
MAX_STACK_FRAMES = 20
REDACTED = "[REDACTED]"
_URL = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s<>\"']+", re.IGNORECASE)
# Content-bearing fields can hold nested/multiline data: omit the whole remainder.
_CONTENT = re.compile(
    r"(?i)([\"']?\b(?:authorization|proxy[-_]authorization|(?:set[-_])?cookie|"
    r"prompt|payload|body|messages|content|task|input|sql|query|statement|parameters|params|detail)"
    r"[\"']?\s*[:=]\s*)[\s\S]*"
)
_SECRET = re.compile(
    r"(?i)([\"']?\b(?:[\w.-]*(?:token|password|passwd|secret|api[-_]?key|session)[\w.-]*|key)"
    r"[\"']?\s*[:=]\s*)"
    r"(?:\[REDACTED\]|[\[{][\s\S]*|\"(?:\\.|[^\"\\])*(?:\"|$)|'(?:\\.|[^'\\])*(?:'|$)|"
    r"(?:Bearer|Basic)\s+[^\s,;)}\]]+|[^\s,;)}\]]+)"
)
_AUTH = re.compile(r"\b(Bearer|Basic)\s+[^\s,;\"'<>]+", re.IGNORECASE)
_TOKEN = re.compile(r"\b(?:eyJ[\w-]+\.[\w-]+\.[\w-]+|sk-[\w-]{8,}|gh[pousr]_[\w]{8,})\b")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b", re.IGNORECASE)
_SQL = re.compile(r"\b(?:SELECT\s|INSERT\s+INTO\s|UPDATE\s|DELETE\s+FROM\s)[\s\S]*", re.IGNORECASE)
_FRAME = re.compile(r'^\s*(?:\|\s*)?File "([^"\r\n]+)", line (\d+), in ([^\r\n]+)$', re.MULTILINE)
_TYPE = re.compile(r"[A-Za-z_][\w.]{0,199}\Z", re.ASCII)


def exception_message(value: str) -> str:
    """Best-effort redaction, not a guarantee that arbitrary exception text is non-sensitive."""
    value = value[:MAX_INPUT_LENGTH]
    value = _URL.sub("[REDACTED_URL]", value)
    value = _CONTENT.sub(lambda match: match[1] + REDACTED, value)
    value = _SECRET.sub(lambda match: match[1] + REDACTED, value)
    value = _AUTH.sub(lambda match: match[1] + " " + REDACTED, value)
    value = _TOKEN.sub(REDACTED, value)
    value = _EMAIL.sub(REDACTED, value)
    value = _SQL.sub("[REDACTED_SQL]", value)
    value = re.sub(r"[\x00-\x1f\x7f]", " ", value)
    return " ".join(value.split())[:MAX_MESSAGE_LENGTH]


def exception_stacktrace(value: str) -> str:
    """Keep frame locations only; discard source lines, locals, and exception values."""
    frames = list(_FRAME.finditer(value[-MAX_INPUT_LENGTH:]))[-MAX_STACK_FRAMES:]
    return "\n".join(
        f'  File "{exception_message(frame[1])}", line {frame[2]}, in {exception_message(frame[3])}' for frame in frames
    )[:MAX_STACK_LENGTH]


def exception_attributes(values: Mapping[str, object]) -> dict[str, str]:
    """Normalize both app-owned and auto-instrumentation exception events at export."""
    kind = values.get("exception.type")
    kind = kind if isinstance(kind, str) and _TYPE.fullmatch(kind) else "Error"
    message = values.get("exception.message")
    attributes = {
        "exception.type": kind,
        "exception.message": (exception_message(message) or kind) if isinstance(message, str) else kind,
    }
    stack = values.get("exception.stacktrace")
    if isinstance(stack, str) and (frames := exception_stacktrace(stack)):
        attributes["exception.stacktrace"] = frames
    return attributes


def record_safe_exception(span: Span, exception: Exception) -> str:
    """Record standard exception fields without ever formatting a full traceback."""
    kind = type(exception).__name__
    if not span.is_recording():
        return kind
    try:
        message = exception_message(str(exception)) or kind
    except Exception:  # noqa: BLE001 - broken exception formatters must not replace the original error
        message = kind
    frames = list(walk_tb(exception.__traceback__))[-MAX_STACK_FRAMES:]
    attributes = exception_attributes(
        {
            "exception.type": kind,
            "exception.message": message,
            "exception.stacktrace": "\n".join(
                f'  File "{frame.f_code.co_filename}", line {line}, in {frame.f_code.co_name}' for frame, line in frames
            ),
        }
    )
    span.set_attribute("error.type", attributes["exception.type"])
    span.add_event("exception", attributes)
    span.set_status(Status(StatusCode.ERROR, attributes["exception.message"]))
    return attributes["exception.message"]
