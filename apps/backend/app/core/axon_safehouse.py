"""Backend-owned Axon Safehouse defaults and filesystem capabilities."""

from posixpath import normpath
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

# Absolute or home-relative; the CLI expands "~/" and resolves symlinks on the user's machine.
PolicyPath = Annotated[
    str,
    StringConstraints(min_length=1, max_length=4096, pattern=r"^(?:/|~/)[^\x00-\x1f\x7f]*$"),
]


def _lexical(path: str) -> str:
    # "~/" stays a prefix: absolute and home-relative entries are compared only within their own form.
    if path.startswith("/"):
        return normpath(path)
    relative = normpath(path[2:])
    return "~" if relative == "." else f"~/{relative}"


def _overlaps(left: str, right: str) -> bool:
    shorter, longer = sorted((_lexical(left), _lexical(right)), key=len)
    return longer == shorter or longer.startswith(shorter.rstrip("/") + "/")


class CliAxonSafehousePolicy(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    required: bool = True
    engine: Literal["safehouse"] = "safehouse"
    policy_id: str = Field(alias="policyId")
    allow_additional_read_paths: bool = Field(alias="allowAdditionalReadPaths")
    allow_additional_write_paths: bool = Field(alias="allowAdditionalWritePaths")
    protected_paths: tuple[PolicyPath, ...] = Field(alias="protectedPaths", max_length=64)
    read_paths: tuple[PolicyPath, ...] = Field(alias="readPaths", max_length=64)
    write_paths: tuple[PolicyPath, ...] = Field(alias="writePaths", max_length=64)
    # Sent only when true: released CLIs parse this policy strictly and reject unknown keys.
    allow_local_opt_out: Literal[True] | None = Field(default=None, alias="allowLocalOptOut")


class AxonSafehouseSettings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    enabled: bool = Field(default=True, alias="ENABLED")
    # Whether --no-safehouse / AXON_DISABLE_SAFEHOUSE may skip a required sandbox.
    allow_local_opt_out: bool = Field(default=False, alias="ALLOW_LOCAL_OPT_OUT")
    policy_id: str = Field(default="safehouse-v1", alias="POLICY_ID", pattern=r"^[a-zA-Z0-9._-]{1,128}$")
    # Networking and local/remote Git have no backend policy gates.
    allow_additional_read_paths: bool = Field(default=True, alias="ALLOW_ADDITIONAL_READ_PATHS")
    allow_additional_write_paths: bool = Field(default=True, alias="ALLOW_ADDITIONAL_WRITE_PATHS")
    protected_paths: list[PolicyPath] = Field(default_factory=list, alias="PROTECTED_PATHS", max_length=64)
    # Plain grants for session, operation and administration runs. They never revoke other access:
    # protected paths and the user's own blocked paths still win, and users may add or narrow grants.
    read_paths: list[PolicyPath] = Field(default_factory=list, alias="READ_PATHS", max_length=64)
    write_paths: list[PolicyPath] = Field(default_factory=list, alias="WRITE_PATHS", max_length=64)

    @model_validator(mode="after")
    def _validate_grants(self) -> Self:
        grants = [*self.read_paths, *self.write_paths]
        for path in grants:
            if _lexical(path) in ("/", "~"):
                raise ValueError(f"AXON_SAFEHOUSE grant must not be the filesystem root or home: {path}")
            if any(_overlaps(path, protected) for protected in self.protected_paths):
                raise ValueError(f"AXON_SAFEHOUSE grant overlaps PROTECTED_PATHS: {path}")
        read = {_lexical(path) for path in self.read_paths}
        if duplicate := next((path for path in self.write_paths if _lexical(path) in read), None):
            raise ValueError(f"AXON_SAFEHOUSE path is in both READ_PATHS and WRITE_PATHS: {duplicate}")
        return self

    def cli_config(self) -> CliAxonSafehousePolicy:
        return CliAxonSafehousePolicy(
            required=self.enabled,
            policyId=self.policy_id,
            allowAdditionalReadPaths=self.allow_additional_read_paths,
            allowAdditionalWritePaths=self.allow_additional_write_paths,
            protectedPaths=tuple(self.protected_paths),
            readPaths=tuple(self.read_paths),
            writePaths=tuple(self.write_paths),
            allowLocalOptOut=True if self.allow_local_opt_out else None,
        )


def parse_axon_safehouse(raw: dict[str, object]) -> AxonSafehouseSettings:
    # Missing deployment settings still require the filesystem/process sandbox.
    section = raw.get("AXON_SAFEHOUSE", {})
    if not isinstance(section, dict):
        raise ValueError("AXON_SAFEHOUSE must be an object")
    return AxonSafehouseSettings.model_validate(section)
