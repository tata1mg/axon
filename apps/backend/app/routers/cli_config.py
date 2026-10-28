"""Protected CLI preferences and the policy-only sandbox bootstrap for RPC login."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from app.authentication import require_authenticated_user
from app.core.cli_config import (
    CliCompactionConfig,
    CliLiteLLMClientConfig,
    CliModelRecommenderConfig,
    CliPiConfig,
    CliTelemetryConfig,
)
from app.core.config import Settings, get_settings
from app.core.sandbox import CliSandboxPolicy
from app.core.terminal_permissions import CliTerminalPermissionsConfig
from app.core.web_search import CliWebSearchConfig

router = APIRouter(prefix="/api/v1/cli/config", tags=["cli-config"])


class CliSandboxBootstrapResponse(BaseModel):
    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    sandbox: CliSandboxPolicy


class CliConfigResponse(BaseModel):
    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    sandbox: CliSandboxPolicy
    telemetry: CliTelemetryConfig | None = None
    pi: CliPiConfig | None = None
    compaction: CliCompactionConfig | None = None
    model_recommender: CliModelRecommenderConfig | None = Field(default=None, alias="modelRecommender")
    litellm_client: CliLiteLLMClientConfig | None = Field(default=None, alias="litellmClient")
    web_search: CliWebSearchConfig | None = Field(default=None, alias="webSearch")
    terminal_permissions: CliTerminalPermissionsConfig | None = Field(default=None, alias="terminalPermissions")


@router.get("/sandbox-bootstrap", response_model=CliSandboxBootstrapResponse)
async def sandbox_bootstrap(
    settings: Annotated[Settings, Depends(get_settings)], response: Response
) -> CliSandboxBootstrapResponse:
    # RPC must start inside Safehouse before its chat can offer browser login.
    # Publish only the sandbox boundary: preferences and managed APIs still require auth.
    response.headers["Cache-Control"] = "no-store"
    return CliSandboxBootstrapResponse(sandbox=settings.sandbox.cli_config())


@router.get(
    "",
    response_model=CliConfigResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_authenticated_user)],
)
async def client_config(settings: Annotated[Settings, Depends(get_settings)]) -> CliConfigResponse:
    # Explicit projection only: never return auth_data, refresh tokens, or backend settings.
    return CliConfigResponse(
        sandbox=settings.sandbox.cli_config(),
        telemetry=settings.cli_telemetry,
        pi=settings.cli_pi,
        compaction=settings.cli_compaction,
        modelRecommender=settings.cli_model_recommender,
        litellmClient=settings.cli_litellm_client,
        webSearch=settings.web_search.cli_config(),
        terminalPermissions=settings.terminal_permissions.cli_config()
        if settings.terminal_permissions is not None
        else None,
    )
