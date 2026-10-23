"""Vortex-compatible JSON service logs without verbose HTTP client logging."""

import json
import logging
import os
import socket
import traceback
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from opentelemetry import trace

from app.observability.context import REQUEST_ID, exception_correlation

if TYPE_CHECKING:
    from app.core.config import Settings


class StructuredLoggingFormatter(logging.Formatter):
    def __init__(self, service_name: str, port: int) -> None:
        super().__init__()
        self.service_name = service_name
        self.host = f"{socket.gethostname()}:{port}"

    def format(self, record: logging.LogRecord) -> str:
        identifier = getattr(record, "request_id", None)
        payload: dict[str, Any] = {
            "version": "v2",
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "loglevel": record.levelname,
            "message": record.getMessage()[:2000],
            "logtype": getattr(record, "logtype", "custom" if identifier else "background"),
            "service_name": self.service_name,
            "branchname": os.getenv("GIT_BRANCH"),
            "current_tag": os.getenv("RELEASE_TAG") or "dev-local",
            "host": self.host,
            "request_id": identifier,
            "trace_id": getattr(record, "trace_id", None),
            "span_id": getattr(record, "span_id", None),
            "traceback": None,
        }
        for key in ("http_method", "path", "status", "duration_ms", "completed", "error_type"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info and record.exc_info[0] is not None:
            # Exception values and source lines can contain credentials/prompts.
            payload["error_type"] = record.exc_info[0].__name__
            payload["traceback"] = [
                {"file": frame.filename, "line": frame.lineno, "function": frame.name}
                for frame in traceback.extract_tb(record.exc_info[2])[-20:]
            ]
        return json.dumps(payload, ensure_ascii=True, default=str)


def _install_correlation_factory() -> None:
    old_factory = logging.getLogRecordFactory()
    if getattr(old_factory, "_axon_correlation", False):
        return

    def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        record = old_factory(*args, **kwargs)
        context = trace.get_current_span().get_span_context()
        record.request_id = REQUEST_ID.get()
        record.trace_id = format(context.trace_id, "032x") if context.is_valid else None
        record.span_id = format(context.span_id, "016x") if context.is_valid else None
        if record.request_id is None and record.exc_info:
            # Starlette/uvicorn log unhandled errors after the request context ends.
            correlation = exception_correlation(record.exc_info[1])
            if correlation is not None:
                record.request_id, record.trace_id, record.span_id = correlation
        return record

    factory._axon_correlation = True
    logging.setLogRecordFactory(factory)


def configure_application_logging(settings: "Settings | None" = None) -> None:
    """Respect deployment app handlers; install a narrowly scoped console default.

    Never configure root/HTTPX INFO logging: URLs can carry credentials. Uvicorn
    access logging is replaced with our sanitized, streaming-aware ASGI access
    log, so query strings and arbitrary path contents do not reach stdout.
    """
    logger = logging.getLogger("app")
    if settings is not None:
        _install_correlation_factory()
        logger.setLevel(settings.log_level)
    if not logger.hasHandlers():
        handler = logging.StreamHandler()
        handler.setFormatter(
            StructuredLoggingFormatter(settings.name, settings.port)
            if settings is not None and settings.log_format == "json"
            else logging.Formatter("%(levelname)s: %(name)s %(message)s")
        )
        logger.addHandler(handler)
        if logger.level == logging.NOTSET:
            logger.setLevel(logging.INFO)
        logger.propagate = False
    if settings is not None:
        logging.getLogger("uvicorn.access").disabled = True
        if settings.log_format == "json":
            formatter = StructuredLoggingFormatter(settings.name, settings.port)
            for name in ("uvicorn", "uvicorn.error"):
                for handler in logging.getLogger(name).handlers:
                    handler.setFormatter(formatter)
