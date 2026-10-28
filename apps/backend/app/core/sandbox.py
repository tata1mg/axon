"""Backend-owned sandbox capabilities; clients may only narrow these permissions."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

RegistryHost = Literal["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org"]
GitHost = Literal["github.com", "bitbucket.org"]
ProtectedPath = Annotated[
    str,
    StringConstraints(min_length=1, max_length=4096, pattern=r"^(?:/|~/)[^\x00-\x1f\x7f]*$"),
]


class CliSandboxPolicy(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    required: Literal[True] = True
    engine: Literal["safehouse"] = "safehouse"
    policy_id: str = Field(alias="policyId")
    max_session_seconds: int = Field(alias="maxSessionSeconds")
    network: Literal["relay-and-package-proxy"] = "relay-and-package-proxy"
    remote_git: bool = Field(default=False, alias="remoteGit")
    remote_git_hosts: tuple[GitHost, ...] = Field(default=(), alias="remoteGitHosts")
    local_git: Literal["deny", "read-only", "read-write"] = Field(alias="localGit")
    allow_additional_read_paths: bool = Field(alias="allowAdditionalReadPaths")
    allow_additional_write_paths: bool = Field(alias="allowAdditionalWritePaths")
    package_registry_hosts: tuple[RegistryHost, ...] = Field(alias="packageRegistryHosts")
    protected_paths: tuple[ProtectedPath, ...] = Field(alias="protectedPaths", max_length=64)


class SandboxSettings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    policy_id: str = Field(default="safehouse-v1", alias="POLICY_ID", pattern=r"^[a-zA-Z0-9._-]{1,128}$")
    max_session_seconds: int = Field(default=14400, alias="MAX_SESSION_SECONDS", ge=60, le=86400)
    local_git: Literal["deny", "read-only", "read-write"] = Field(default="read-only", alias="LOCAL_GIT")
    # Enables sandboxed SSH-agent use and TCP access to the approved Git hosts.
    remote_git: bool = Field(default=False, alias="REMOTE_GIT")
    remote_git_hosts: list[GitHost] = Field(default_factory=list, alias="REMOTE_GIT_HOSTS", max_length=2)
    allow_additional_read_paths: bool = Field(default=True, alias="ALLOW_ADDITIONAL_READ_PATHS")
    allow_additional_write_paths: bool = Field(default=True, alias="ALLOW_ADDITIONAL_WRITE_PATHS")
    package_registry_hosts: list[RegistryHost] = Field(
        default_factory=lambda: ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org"],
        alias="PACKAGE_REGISTRY_HOSTS",
        max_length=4,
    )
    protected_paths: list[ProtectedPath] = Field(default_factory=list, alias="PROTECTED_PATHS", max_length=64)

    def cli_config(self) -> CliSandboxPolicy:
        return CliSandboxPolicy(
            policyId=self.policy_id,
            maxSessionSeconds=self.max_session_seconds,
            localGit=self.local_git,
            remoteGit=self.remote_git,
            remoteGitHosts=tuple(self.remote_git_hosts),
            allowAdditionalReadPaths=self.allow_additional_read_paths,
            allowAdditionalWritePaths=self.allow_additional_write_paths,
            packageRegistryHosts=tuple(self.package_registry_hosts),
            protectedPaths=tuple(self.protected_paths),
        )


def parse_sandbox(raw: dict[str, object]) -> SandboxSettings:
    # Missing deployment settings still publish the reviewed restrictive baseline.
    section = raw.get("SANDBOX", {})
    if not isinstance(section, dict):
        raise ValueError("SANDBOX must be an object")
    return SandboxSettings.model_validate(section)
