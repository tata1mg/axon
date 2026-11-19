"""HTTP router registration."""

from fastapi import APIRouter

from app.proxies.otel import router as otel_router
from app.routers.admin import router as admin_router
from app.routers.admin_catalog import router as admin_catalog_router
from app.routers.browser_login import router as browser_login_router
from app.routers.catalog import router as catalog_router
from app.routers.cli_config import router as cli_config_router
from app.routers.cli_releases import router as cli_releases_router
from app.routers.health import ping_router
from app.routers.health import router as health_router
from app.routers.install import router as install_router
from app.routers.model_recommendations import router as model_recommendations_router
from app.routers.sessions import router as sessions_router

ROUTERS: list[APIRouter] = [
    health_router,
    browser_login_router,
    cli_config_router,
    otel_router,
    model_recommendations_router,
    ping_router,
    install_router,
    cli_releases_router,
    sessions_router,
    admin_router,
    admin_catalog_router,
    catalog_router,
]
