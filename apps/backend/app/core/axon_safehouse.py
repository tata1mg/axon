"""Backend-owned Axon Safehouse capabilities; clients may only narrow these permissions."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

ProtectedPath = Annotated[
    str,
    StringConstraints(min_length=1, max_length=4096, pattern=r"^(?:/|~/)[^\x00-\x1f\x7f]*$"),
]


class CliAxonSafehousePolicy(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    required: Literal[True] = True
    engine: Literal["safehouse"] = "safehouse"
    policy_id: str = Field(alias="policyId")
    max_session_seconds: int = Field(alias="maxSessionSeconds")
    allow_additional_read_paths: bool = Field(alias="allowAdditionalReadPaths")
    allow_additional_write_paths: bool = Field(alias="allowAdditionalWritePaths")
    protected_paths: tuple[ProtectedPath, ...] = Field(alias="protectedPaths", max_length=64)


class AxonSafehouseSettings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    policy_id: str = Field(default="safehouse-v1", alias="POLICY_ID", pattern=r"^[a-zA-Z0-9._-]{1,128}$")
    max_session_seconds: int = Field(default=14400, alias="MAX_SESSION_SECONDS", ge=60, le=86400)
    # Networking and local/remote Git have no backend policy gates.
    allow_additional_read_paths: bool = Field(default=True, alias="ALLOW_ADDITIONAL_READ_PATHS")
    allow_additional_write_paths: bool = Field(default=True, alias="ALLOW_ADDITIONAL_WRITE_PATHS")
    protected_paths: list[ProtectedPath] = Field(default_factory=list, alias="PROTECTED_PATHS", max_length=64)

    def cli_config(self) -> CliAxonSafehousePolicy:
        return CliAxonSafehousePolicy(
            policyId=self.policy_id,
            maxSessionSeconds=self.max_session_seconds,
            allowAdditionalReadPaths=self.allow_additional_read_paths,
            allowAdditionalWritePaths=self.allow_additional_write_paths,
            protectedPaths=tuple(self.protected_paths),
        )


def parse_axon_safehouse(raw: dict[str, object]) -> AxonSafehouseSettings:
    # Missing deployment settings still require the filesystem/process sandbox.
    section = raw.get("AXON_SAFEHOUSE", {})
    if not isinstance(section, dict):
        raise ValueError("AXON_SAFEHOUSE must be an object")
    return AxonSafehouseSettings.model_validate(section)
