"""Catalog entry schemas, structural validation, install tiers, and publishing guidance.

The backend checks structure only: a published entry must be something the hub can
render and install. Policy, such as pinned package versions or literal credentials, is
guidance. It is returned as warnings for the admin dashboard and never blocks publishing.

Spec documents use camelCase keys because they are delivered to the TypeScript hub as-is.
"""

import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError, field_serializer
from pydantic.alias_generators import to_camel


class CatalogKind(StrEnum):
    MCP = "mcp"
    SKILL = "skill"


class CatalogStatus(StrEnum):
    DRAFT = "draft"
    PUBLISHED = "published"
    ARCHIVED = "archived"


InstallTier = Literal["one_click", "guided", "manual"]

SLUG_PATTERN = r"^[a-z0-9][a-z0-9-]{1,62}$"
_ID_PATTERN = r"^[a-z][a-z0-9_]{0,39}$"
_TAG_PATTERN = r"^[a-z0-9][a-z0-9-]{0,31}$"
_INPUT_MARKER = "${input:"
_INPUT_REFERENCE = re.compile(r"\$\{input:([^}]*)\}")
_MARKDOWN_LINK = re.compile(r"\[[^\]\n]*\]\(([^)\s]*)\)")


@dataclass(frozen=True, slots=True)
class CatalogIssue:
    """A validation error or warning. ``path`` uses the draft's own (camelCase) keys."""

    path: str
    message: str


# --- field validators ------------------------------------------------------------------


def _single_line(value: str) -> str:
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("must be a single line without control characters")
    return value


def _multi_line(value: str) -> str:
    if any((ord(character) < 32 and character not in "\n\t") or ord(character) == 127 for character in value):
        raise ValueError("must not contain control characters")
    return value


def _not_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be blank")
    return value


def _url_has_scheme(value: str, schemes: frozenset[str]) -> bool:
    if any(character.isspace() for character in value):
        return False
    try:
        parts = urlsplit(value)
        return parts.scheme in schemes and parts.hostname is not None
    except ValueError:
        return False


def _https_url(value: str) -> str:
    if not _url_has_scheme(value, frozenset({"https"})):
        raise ValueError("must be an https:// URL")
    return value


def _http_url(value: str) -> str:
    if not _url_has_scheme(value, frozenset({"https", "http"})):
        raise ValueError("must be an https:// or http:// URL")
    return value


def _https_links(value: str) -> str:
    if not all(_url_has_scheme(target, frozenset({"https"})) for target in _MARKDOWN_LINK.findall(value)):
        raise ValueError("links must use https:// URLs")
    return value


Name = Annotated[str, Field(min_length=1, max_length=80), AfterValidator(_single_line), AfterValidator(_not_blank)]
Label = Annotated[str, Field(min_length=1, max_length=120), AfterValidator(_single_line), AfterValidator(_not_blank)]
OneLine = Annotated[str, Field(max_length=300), AfterValidator(_single_line)]
Text = Annotated[
    str,
    Field(min_length=1, max_length=4000),
    AfterValidator(_multi_line),
    AfterValidator(_not_blank),
    AfterValidator(_https_links),
]
CommandText = Annotated[
    str, Field(min_length=1, max_length=4000), AfterValidator(_multi_line), AfterValidator(_not_blank)
]
HttpsUrl = Annotated[str, Field(max_length=2048), AfterValidator(_https_url)]
Identifier = Annotated[str, Field(pattern=_ID_PATTERN)]
Value = Annotated[str, Field(max_length=8192), AfterValidator(_single_line)]
EnvName = Annotated[str, Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")]
HeaderName = Annotated[str, Field(pattern=r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$")]


class _Spec(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", alias_generator=to_camel)


# --- step blocks (the hub's setup "widgets") ------------------------------------------


class TextBlock(_Spec):
    """Paragraph. Supports `code`, **bold** and [label](https://...) and nothing else."""

    type: Literal["text"]
    text: Text


class CommandBlock(_Spec):
    """Copyable command. The hub never runs it."""

    type: Literal["command"]
    command: CommandText
    label: Label | None = None


class LinkBlock(_Spec):
    type: Literal["link"]
    label: Label
    url: HttpsUrl


class CalloutBlock(_Spec):
    type: Literal["callout"]
    tone: Literal["info", "warning"] = "info"
    text: Text


class InputBlock(_Spec):
    """Places a declared input's field at this point in the steps."""

    type: Literal["input"]
    input: Identifier


class CheckBlock(_Spec):
    """Places a declared prerequisite's detection row at this point in the steps."""

    type: Literal["check"]
    prerequisite: Identifier


class ConfirmBlock(_Spec):
    """A checkbox the user must tick before installing, for steps the hub cannot detect."""

    type: Literal["confirm"]
    id: Identifier
    label: Label


HelpBlock = Annotated[TextBlock | CommandBlock | LinkBlock | CalloutBlock, Field(discriminator="type")]
StepBlock = Annotated[
    TextBlock | CommandBlock | LinkBlock | CalloutBlock | InputBlock | CheckBlock | ConfirmBlock,
    Field(discriminator="type"),
]


# --- shared metadata ------------------------------------------------------------------


class CatalogMetadata(_Spec):
    name: Name
    summary: OneLine = ""
    tags: Annotated[list[Annotated[str, Field(pattern=_TAG_PATTERN)]], Field(max_length=10)] = []
    docs_url: HttpsUrl | None = None
    # A name from the hub's built-in icon set. Remote images are never loaded.
    icon: Annotated[str, Field(pattern=_TAG_PATTERN)] | None = None


# --- MCP (spec version 1) ---------------------------------------------------------------


class McpServerTemplate(_Spec):
    """Template for one Pi ``mcp.json`` entry. ``${input:<id>}`` is filled in by the hub."""

    type: Literal["stdio", "http", "streamable-http"] | None = None
    command: Annotated[str, Field(min_length=1, max_length=1024), AfterValidator(_single_line)] | None = None
    args: Annotated[list[Value], Field(max_length=256)] | None = None
    env: Annotated[dict[EnvName, Value], Field(max_length=64)] | None = None
    cwd: Annotated[str, Field(min_length=1, max_length=4096), AfterValidator(_single_line)] | None = None
    url: Annotated[str, Field(max_length=2048), AfterValidator(_http_url)] | None = None
    headers: Annotated[dict[HeaderName, Value], Field(max_length=64)] | None = None
    timeout: Annotated[float, Field(gt=0, le=86_400)] | None = None
    description: Annotated[str, Field(max_length=2048), AfterValidator(_multi_line)] | None = None
    exposure: Literal["codemode", "deferred", "direct", "hidden"] = "codemode"

    @field_serializer("timeout")
    def _whole_seconds(self, value: float | None) -> int | float | None:
        # Keep `"timeout": 50` as written instead of turning it into 50.0.
        return int(value) if value is not None and value.is_integer() else value


class McpInput(_Spec):
    id: Identifier
    label: Label
    type: Literal["text", "secret", "url", "path"] = "text"
    required: bool = True
    placeholder: Annotated[str, Field(max_length=200), AfterValidator(_single_line)] | None = None
    pattern: Annotated[str, Field(min_length=1, max_length=500)] | None = None
    help: Annotated[list[HelpBlock], Field(max_length=20)] = []


class ExecutableDetection(_Spec):
    executable: Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")]


class McpPrerequisite(_Spec):
    id: Identifier
    label: Label
    detect: ExecutableDetection | None = None
    help: Annotated[list[HelpBlock], Field(max_length=20)] = []


class McpSpecV1(_Spec):
    server: McpServerTemplate | None = None
    inputs: Annotated[list[McpInput], Field(max_length=20)] = []
    prerequisites: Annotated[list[McpPrerequisite], Field(max_length=10)] = []
    steps: Annotated[list[StepBlock], Field(max_length=50)] = []
    after_install: Annotated[list[HelpBlock], Field(max_length=20)] = []


class McpDraft(_Spec):
    metadata: CatalogMetadata
    spec: McpSpecV1


# --- Skill (spec version 0: preview) -----------------------------------------------------


class SkillPlaceholderSource(_Spec):
    """Stand-in until skills have a real source format (probably an uploaded bundle)."""

    type: Literal["placeholder"]
    notes: Annotated[str, Field(max_length=2000), AfterValidator(_multi_line)] = ""


class SkillSpecV0(_Spec):
    source: SkillPlaceholderSource


class SkillDraft(_Spec):
    metadata: CatalogMetadata
    spec: SkillSpecV0


# --- structural checks across fields ----------------------------------------------------


def _duplicates(ids: list[str], path: str, noun: str) -> list[CatalogIssue]:
    seen: set[str] = set()
    issues = []
    for index, identifier in enumerate(ids):
        if identifier in seen:
            issues.append(CatalogIssue(f"{path}.{index}.id", f"Another {noun} already uses this id."))
        seen.add(identifier)
    return issues


def _template_values(server: McpServerTemplate) -> Iterator[tuple[str, str]]:
    base = "spec.server"
    for index, value in enumerate(server.args or []):
        yield f"{base}.args.{index}", value
    for name, value in (server.env or {}).items():
        yield f"{base}.env.{name}", value
    for name, value in (server.headers or {}).items():
        yield f"{base}.headers.{name}", value
    if server.cwd is not None:
        yield f"{base}.cwd", server.cwd
    if server.url is not None:
        yield f"{base}.url", server.url


def _reference_issues(path: str, value: str, inputs: set[str]) -> list[CatalogIssue]:
    references = _INPUT_REFERENCE.findall(value)
    if value.count(_INPUT_MARKER) != len(references):
        return [CatalogIssue(path, "Write input references as ${input:<id>}.")]
    return [
        CatalogIssue(path, f"Unknown input {reference!r}. Declare it under inputs.")
        for reference in references
        if reference not in inputs
    ]


def _transport_issues(server: McpServerTemplate) -> list[CatalogIssue]:
    base = "spec.server"
    if (server.command is None) == (server.url is None):
        return [CatalogIssue(base, "Set either command (a local stdio server) or url (a remote HTTP server).")]
    if server.command is not None:
        issues = []
        if server.type not in {None, "stdio"}:
            issues.append(CatalogIssue(f"{base}.type", "A server with a command uses the stdio type."))
        if server.headers is not None:
            issues.append(CatalogIssue(f"{base}.headers", "Only HTTP servers send headers."))
        if _INPUT_MARKER in server.command:
            issues.append(CatalogIssue(f"{base}.command", "The command cannot contain an input. Use args or env."))
        return issues
    issues = [
        CatalogIssue(f"{base}.{field}", f"Only stdio servers use {field}.")
        for field in ("args", "env", "cwd")
        if getattr(server, field) is not None
    ]
    if server.type == "stdio":
        issues.append(CatalogIssue(f"{base}.type", "A server with a url uses the http or streamable-http type."))
    if _INPUT_MARKER in urlsplit(server.url or "").netloc:
        issues.append(CatalogIssue(f"{base}.url", "Inputs can only be used in the URL path or query."))
    return issues


def _block_reference_issues(spec: McpSpecV1) -> list[CatalogIssue]:
    inputs = {item.id for item in spec.inputs}
    prerequisites = {item.id for item in spec.prerequisites}
    issues = []
    for index, block in enumerate(spec.steps):
        if isinstance(block, InputBlock) and block.input not in inputs:
            issues.append(CatalogIssue(f"spec.steps.{index}.input", "Unknown input. Declare it under inputs."))
        if isinstance(block, CheckBlock) and block.prerequisite not in prerequisites:
            issues.append(
                CatalogIssue(
                    f"spec.steps.{index}.prerequisite", "Unknown prerequisite. Declare it under prerequisites."
                )
            )
    return issues


def _pattern_issues(spec: McpSpecV1) -> list[CatalogIssue]:
    issues = []
    for index, item in enumerate(spec.inputs):
        if item.pattern is None:
            continue
        try:
            re.compile(item.pattern)
        except re.error:
            issues.append(CatalogIssue(f"spec.inputs.{index}.pattern", "This is not a valid regular expression."))
    return issues


def _mcp_issues(draft: McpDraft) -> list[CatalogIssue]:
    spec = draft.spec
    confirm_ids = [block.id for block in spec.steps if isinstance(block, ConfirmBlock)]
    issues = [
        *_duplicates([item.id for item in spec.inputs], "spec.inputs", "input"),
        *_duplicates([item.id for item in spec.prerequisites], "spec.prerequisites", "prerequisite"),
        *_duplicates(confirm_ids, "spec.steps", "confirm step"),
        *_pattern_issues(spec),
        *_block_reference_issues(spec),
    ]
    if spec.server is None:
        # A manual entry is instructions only, so it needs some.
        if not spec.steps:
            issues.append(CatalogIssue("spec", "Add a server template, or setup steps for a manual entry."))
        if spec.inputs:
            issues.append(CatalogIssue("spec.inputs", "Inputs need a server template to fill in."))
        return issues
    issues.extend(_transport_issues(spec.server))
    inputs = {item.id for item in spec.inputs}
    for path, value in _template_values(spec.server):
        issues.extend(_reference_issues(path, value, inputs))
    return issues


def mcp_tier(spec: McpSpecV1) -> InstallTier:
    """One-click when the hub can write the config with nothing from the user."""
    if spec.server is None:
        return "manual"
    needs_user = (
        any(item.required for item in spec.inputs)
        or bool(spec.prerequisites)
        or any(isinstance(block, ConfirmBlock) for block in spec.steps)
    )
    return "guided" if needs_user else "one_click"


# --- publishing guidance (warnings only) -------------------------------------------------

_PACKAGE_RUNNERS = {"npx": "npm", "bunx": "npm", "pnpx": "npm", "uvx": "python"}
_RUNNER_SUBCOMMANDS = {
    ("pnpm", "dlx"): "npm",
    ("yarn", "dlx"): "npm",
    ("npm", "exec"): "npm",
    ("pipx", "run"): "python",
}
_PINNED_NPM = re.compile(r"^(@[^/@\s]+/)?[^@\s/]+@\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$")
_PINNED_PYTHON = re.compile(r"^[A-Za-z0-9._\-\[\],]+(==|@)\d+(\.\d+)*([A-Za-z0-9.+-]*)$")
_TOOLS_NEEDING_PREREQUISITE = frozenset(
    {"npx", "npm", "node", "bunx", "bun", "pnpm", "pnpx", "yarn", "uvx", "uv", "pipx", "python", "python3", "docker"}
)
_CREDENTIAL_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE", re.IGNORECASE)
_PLACEHOLDER_VALUE = re.compile(
    r"^(<[^>]*>|your[-_ ].*|x{3,}|\*{3,}|changeme|change[-_ ]me|replace[-_ ]?me|todo|\.\.\.)$", re.IGNORECASE
)


def _package_argument(server: McpServerTemplate) -> tuple[str, str] | None:
    """Return (package, ecosystem) for servers launched through a package runner."""
    command = (server.command or "").rsplit("/", 1)[-1]
    args = list(server.args or [])
    ecosystem = _PACKAGE_RUNNERS.get(command)
    if ecosystem is None and args:
        ecosystem = _RUNNER_SUBCOMMANDS.get((command, args[0]))
        args = args[1:]
    if ecosystem is None:
        return None
    package = next((arg for arg in args if not arg.startswith("-")), None)
    if package is None or package.startswith((".", "/")) or "://" in package or _INPUT_MARKER in package:
        return None
    return package, ecosystem


def _package_warnings(server: McpServerTemplate) -> list[CatalogIssue]:
    found = _package_argument(server)
    if found is None:
        return []
    package, ecosystem = found
    pinned = _PINNED_NPM if ecosystem == "npm" else _PINNED_PYTHON
    if pinned.fullmatch(package):
        return []
    example = "name@1.2.3" if ecosystem == "npm" else "name==1.2.3"
    return [
        CatalogIssue(
            "spec.server.args",
            f"{package} is not pinned to an exact version, so users can get different releases. Pin it like {example}.",
        )
    ]


def _prerequisite_warnings(server: McpServerTemplate, prerequisites: list[McpPrerequisite]) -> list[CatalogIssue]:
    command = (server.command or "").rsplit("/", 1)[-1]
    if command not in _TOOLS_NEEDING_PREREQUISITE:
        return []
    detected = {item.detect.executable for item in prerequisites if item.detect is not None}
    if command in detected:
        return []
    return [
        CatalogIssue(
            "spec.prerequisites",
            f"Add a prerequisite that detects {command}, so users without it see how to install it.",
        )
    ]


def _credential_warnings(server: McpServerTemplate) -> list[CatalogIssue]:
    warnings = []
    named_values = [("env", name, value) for name, value in (server.env or {}).items()]
    named_values += [("headers", name, value) for name, value in (server.headers or {}).items()]
    for group, name, value in named_values:
        if "${" in value:
            continue
        path = f"spec.server.{group}.{name}"
        if _PLACEHOLDER_VALUE.fullmatch(value.strip()):
            warnings.append(
                CatalogIssue(path, "This looks like a placeholder. Make it an input so each user enters their own.")
            )
        elif _CREDENTIAL_NAME.search(name):
            warnings.append(
                CatalogIssue(path, "Every user receives this value. If it is a personal credential, make it an input.")
            )
    return warnings


def _unused_input_warnings(spec: McpSpecV1, server: McpServerTemplate) -> list[CatalogIssue]:
    used = {reference for _path, value in _template_values(server) for reference in _INPUT_REFERENCE.findall(value)}
    return [
        CatalogIssue(f"spec.inputs.{index}", "This input is not used in the server template.")
        for index, item in enumerate(spec.inputs)
        if item.id not in used
    ]


def _summary_warnings(metadata: CatalogMetadata) -> list[CatalogIssue]:
    if metadata.summary.strip():
        return []
    return [CatalogIssue("metadata.summary", "Add a summary. The hub shows it on the catalog card.")]


def _mcp_warnings(draft: McpDraft) -> list[CatalogIssue]:
    warnings = _summary_warnings(draft.metadata)
    server = draft.spec.server
    if server is None:
        return warnings
    if not (server.description or "").strip():
        warnings.append(CatalogIssue("spec.server.description", "Add a description of what this server provides."))
    if server.exposure != "codemode":
        warnings.append(CatalogIssue("spec.server.exposure", "codemode is the recommended exposure."))
    if (server.url or "").startswith("http://"):
        warnings.append(CatalogIssue("spec.server.url", "Use https:// so traffic to this server is encrypted."))
    warnings.extend(_package_warnings(server))
    warnings.extend(_prerequisite_warnings(server, draft.spec.prerequisites))
    warnings.extend(_credential_warnings(server))
    warnings.extend(_unused_input_warnings(draft.spec, server))
    return warnings


# --- kind registry --------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class KindDefinition:
    """Everything kind-specific. Adding a kind adds one entry here and one to the DB CHECK."""

    spec_version: int
    draft_model: type[BaseModel]
    issues: Callable[[Any], list[CatalogIssue]]
    warnings: Callable[[Any], list[CatalogIssue]]
    tier: Callable[[Any], InstallTier | None]


CATALOG_KINDS: dict[CatalogKind, KindDefinition] = {
    CatalogKind.MCP: KindDefinition(
        spec_version=1,
        draft_model=McpDraft,
        issues=_mcp_issues,
        warnings=_mcp_warnings,
        tier=lambda draft: mcp_tier(draft.spec),
    ),
    CatalogKind.SKILL: KindDefinition(
        spec_version=0,
        draft_model=SkillDraft,
        issues=lambda _draft: [],
        warnings=lambda draft: _summary_warnings(draft.metadata),
        tier=lambda _draft: None,
    ),
}


@dataclass(frozen=True, slots=True)
class DraftCheck:
    """``normalized`` is the canonical document to publish, or None while errors remain."""

    normalized: dict[str, Any] | None
    errors: tuple[CatalogIssue, ...]
    warnings: tuple[CatalogIssue, ...]
    tier: InstallTier | None


def _pydantic_issues(error: ValidationError) -> list[CatalogIssue]:
    issues = []
    for detail in error.errors(include_url=False, include_input=False, include_context=False):
        path = ".".join(str(part) for part in detail["loc"])
        issues.append(CatalogIssue(path, detail["msg"].removeprefix("Value error, ")))
    return issues


def check_draft(kind: CatalogKind, draft: Any) -> DraftCheck:
    """Validate a draft document. Messages never echo submitted values."""
    definition = CATALOG_KINDS[kind]
    try:
        parsed = definition.draft_model.model_validate(draft)
    except ValidationError as error:
        return DraftCheck(normalized=None, errors=tuple(_pydantic_issues(error)), warnings=(), tier=None)
    errors = tuple(definition.issues(parsed))
    warnings = tuple(definition.warnings(parsed))
    if errors:
        return DraftCheck(normalized=None, errors=errors, warnings=warnings, tier=None)
    normalized = parsed.model_dump(mode="json", by_alias=True, exclude_none=True)
    return DraftCheck(normalized=normalized, errors=(), warnings=warnings, tier=definition.tier(parsed))


def spec_version(kind: CatalogKind) -> int:
    return CATALOG_KINDS[kind].spec_version
