"""Backend service observability, independent of CLI telemetry ingestion."""

from fastapi.telemetry import TelemetryConfig

# FastAPI's native pipeline can auto-configure globals from OTEL_* variables and
# record exception contents. The app-owned, sanitized pipeline replaces it.
NATIVE_TELEMETRY_DISABLED: TelemetryConfig = {
    "tracing": False,
    "metrics": False,
    "logs": False,
    "operation_spans": False,
    "auto_configure": False,
}
