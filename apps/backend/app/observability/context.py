"""Request correlation shared by logging and ASGI middleware."""

import re
from contextvars import ContextVar
from uuid import uuid4

REQUEST_ID: ContextVar[str | None] = ContextVar("axon_request_id", default=None)
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9._:/-]{1,128}$")
# Unhandled exceptions are logged by Starlette/uvicorn after the request context
# has been reset. The middleware binds its IDs to the exception so those later
# records can still be correlated.
EXCEPTION_CORRELATION = "_axon_correlation"


def safe_identifier(value: str | None, fallback: str) -> str:
    return value if value and SAFE_IDENTIFIER.fullmatch(value) else fallback


def request_id(value: str | None) -> str:
    return safe_identifier(value, str(uuid4()))


def bind_exception_correlation(exc: BaseException, identifier: str, trace_id: str | None, span_id: str | None) -> None:
    if getattr(exc, EXCEPTION_CORRELATION, None) is not None:
        return
    try:
        setattr(exc, EXCEPTION_CORRELATION, (identifier, trace_id, span_id))
    except (AttributeError, TypeError):
        pass


def exception_correlation(exc: object) -> tuple[str, str | None, str | None] | None:
    value = getattr(exc, EXCEPTION_CORRELATION, None)
    return value if isinstance(value, tuple) and len(value) == 3 else None
