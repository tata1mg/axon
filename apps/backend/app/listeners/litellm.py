"""Per-application LiteLLM integration startup and shutdown."""

import logging
import os

from fastapi import FastAPI

from app.clients.litellm.decisions import LiteLLMDecisionClient
from app.clients.litellm.dependencies import (
    LITELLM_DECISION_CLIENT_STATE_KEY,
    LITELLM_IDENTITY_CLIENT_STATE_KEY,
    LITELLM_TRANSPORT_STATE_KEY,
)
from app.clients.litellm.identity import LiteLLMIdentityClient
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import get_settings

logger = logging.getLogger(__name__)


async def initialize_litellm_proxy(app: FastAPI) -> None:
    """Compose streaming proxy and buffered consumers over isolated HTTP pools."""
    settings = get_settings()
    runtime = getattr(app.state, "service_telemetry", None)
    transport = LiteLLMTransport(settings.litellm, diagnostics=getattr(runtime, "litellm", None))
    try:
        identity = LiteLLMIdentityClient(settings.litellm, transport)
        decisions = LiteLLMDecisionClient(settings.litellm, transport)
        setattr(app.state, LITELLM_TRANSPORT_STATE_KEY, transport)
        setattr(app.state, LITELLM_IDENTITY_CLIENT_STATE_KEY, identity)
        setattr(app.state, LITELLM_DECISION_CLIENT_STATE_KEY, decisions)
    except BaseException:
        await transport.aclose()
        raise
    config = settings.litellm
    logger.info(
        "LiteLLM integration initialized pid=%s upstream_origin=%s upstream_root=%s "
        "streaming_max_connections=%s management_max_connections=%s keepalive_max=%s keepalive_expiry_s=%s "
        "connect_timeout_s=%s read_timeout_s=%s pool_timeout_s=%s",
        os.getpid(),
        config.upstream_url,
        config.upstream_root_path,
        config.max_connections,
        config.management_max_connections,
        config.max_keepalive_connections,
        config.keepalive_expiry_seconds,
        config.connect_timeout_seconds,
        config.read_timeout_seconds,
        config.pool_timeout_seconds,
    )


async def close_litellm_proxy(app: FastAPI) -> None:
    """Detach all consumers before closing both connection pools."""
    transport = getattr(app.state, LITELLM_TRANSPORT_STATE_KEY, None)
    setattr(app.state, LITELLM_TRANSPORT_STATE_KEY, None)
    setattr(app.state, LITELLM_IDENTITY_CLIENT_STATE_KEY, None)
    setattr(app.state, LITELLM_DECISION_CLIENT_STATE_KEY, None)
    if transport is not None:
        await transport.aclose()
    logger.info("LiteLLM integration closed")
