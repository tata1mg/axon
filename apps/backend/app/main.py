"""ASGI application entry point."""

from fastapi import FastAPI

from app.authentication import SessionRefreshResponseMiddleware
from app.core.config import get_settings
from app.core.logging import configure_application_logging
from app.listeners import lifespan
from app.observability import NATIVE_TELEMETRY_DISABLED
from app.observability.middleware import BackendObservabilityMiddleware
from app.observability.sentry import setup_sentry
from app.proxies import mount_litellm_proxy, mount_litellm_ui_proxy
from app.routers import ROUTERS
from app.web import mount_frontend

settings = get_settings()
configure_application_logging(settings)
setup_sentry(settings.sentry)
app = FastAPI(
    title=settings.name,
    debug=settings.debug,
    lifespan=lifespan,
    description="Centralized management API for Axon CLI installations",
    version="0.2.0",
    telemetry=NATIVE_TELEMETRY_DISABLED,
)
app.add_middleware(SessionRefreshResponseMiddleware)
app.add_middleware(BackendObservabilityMiddleware, access_log=settings.access_log)
for router in ROUTERS:
    app.include_router(router)
mount_litellm_proxy(app)
if settings.litellm.ui_enabled:
    mount_litellm_ui_proxy(app)

# Must run after the API routes: the console is mounted at "/" as a catch-all,
# and Starlette matches routes in registration order.
mount_frontend(app)
