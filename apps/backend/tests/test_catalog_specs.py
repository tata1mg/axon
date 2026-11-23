"""Catalog entry validation: structure blocks publishing, policy only produces warnings."""

import copy
import json
from typing import Any

import pytest

from app.services.catalog.specs import CatalogKind, check_draft, spec_version

# The first entries from docs/hub-catalog-plan.md. Admins add these through the dashboard.
REDASH: dict[str, Any] = {
    "metadata": {
        "name": "Redash",
        "summary": "Query 1mg Redash data sources, saved queries and dashboards from Pi.",
        "tags": ["data", "analytics"],
        "icon": "database",
    },
    "spec": {
        "server": {
            "command": "npx",
            "args": ["-y", "@suthio/redash-mcp"],
            "env": {"REDASH_URL": "https://redash.1mg.com/", "REDASH_API_KEY": "${input:api_key}"},
            "exposure": "codemode",
            "description": "Query 1mg Redash data sources, saved queries and dashboards.",
        },
        "inputs": [{"id": "api_key", "label": "Redash API key", "type": "secret", "required": True}],
        "prerequisites": [
            {
                "id": "node",
                "label": "Node.js (provides npx)",
                "detect": {"executable": "npx"},
                "help": [{"type": "command", "command": "brew install node"}],
            }
        ],
        "steps": [
            {"type": "text", "text": "Copy the API key shown on your Redash profile page."},
            {"type": "link", "label": "Open my Redash profile", "url": "https://redash.1mg.com/users/me"},
            {"type": "input", "input": "api_key"},
        ],
        "afterInstall": [{"type": "text", "text": "Run `/reload` in Pi to load Redash."}],
    },
}

LAST9: dict[str, Any] = {
    "metadata": {
        "name": "Last9",
        "summary": "Query logs, metrics, traces and alerts in the tata1mg Last9 organization.",
        "tags": ["observability"],
        "icon": "activity",
    },
    "spec": {
        "server": {
            "type": "streamable-http",
            "url": "https://app.last9.io/api/v4/organizations/tata1mg/mcp",
            "timeout": 50,
            "exposure": "codemode",
            "description": "Logs, metrics, traces and alerts from the tata1mg Last9 organization.",
        },
        "afterInstall": [{"type": "text", "text": "Run `/reload` in Pi, then run `/mcp` to authenticate with Last9."}],
    },
}

ATLASSIAN: dict[str, Any] = {
    "metadata": {
        "name": "Atlassian",
        "summary": "Search and manage work across Jira, Confluence, Bitbucket and other Atlassian products.",
        "tags": ["tickets", "docs", "code"],
        "icon": "ticket",
    },
    "spec": {
        "server": {
            "url": "https://mcp.atlassian.com/v2/mcp?tools=all",
            "description": "Search and manage Atlassian work across Jira, Confluence, Bitbucket, and other products.",
        },
        "afterInstall": [
            {"type": "text", "text": "Run `/reload` in Pi, then run `/mcp` to authenticate with Atlassian."}
        ],
    },
}

SKILL: dict[str, Any] = {
    "metadata": {"name": "Release notes", "summary": "Drafts release notes from merged pull requests."},
    "spec": {"source": {"type": "placeholder", "notes": "Bundle upload comes later."}},
}


def edited(base: dict[str, Any], **spec: Any) -> dict[str, Any]:
    """Copy a draft and replace top-level spec fields (``server=None`` removes the server)."""
    draft = copy.deepcopy(base)
    for key, value in spec.items():
        if value is None:
            draft["spec"].pop(key, None)
        else:
            draft["spec"][key] = value
    return draft


def server(base: dict[str, Any], **fields: Any) -> dict[str, Any]:
    """Copy a draft and change server fields (``None`` removes a field)."""
    draft = copy.deepcopy(base)
    for key, value in fields.items():
        if value is None:
            draft["spec"]["server"].pop(key, None)
        else:
            draft["spec"]["server"][key] = value
    return draft


def paths(issues: tuple) -> list[str]:
    return [issue.path for issue in issues]


@pytest.mark.parametrize(("draft", "tier"), [(REDASH, "guided"), (LAST9, "one_click"), (ATLASSIAN, "one_click")])
def test_first_entries_are_valid(draft: dict[str, Any], tier: str) -> None:
    check = check_draft(CatalogKind.MCP, draft)
    assert check.errors == ()
    assert check.tier == tier
    assert check.normalized is not None


def test_normalized_content_is_canonical_and_keeps_pi_fields() -> None:
    last9 = check_draft(CatalogKind.MCP, LAST9).normalized
    assert last9 is not None
    assert last9["spec"]["server"] == {
        "type": "streamable-http",
        "url": "https://app.last9.io/api/v4/organizations/tata1mg/mcp",
        "timeout": 50,
        "description": "Logs, metrics, traces and alerts from the tata1mg Last9 organization.",
        "exposure": "codemode",
    }
    assert '"timeout": 50,' in json.dumps(last9["spec"]["server"])
    assert last9["spec"]["afterInstall"] == LAST9["spec"]["afterInstall"]

    atlassian = check_draft(CatalogKind.MCP, ATLASSIAN).normalized
    assert atlassian is not None
    # codemode is the default exposure.
    assert atlassian["spec"]["server"]["exposure"] == "codemode"
    assert atlassian["spec"]["server"]["url"] == "https://mcp.atlassian.com/v2/mcp?tools=all"

    for draft in (REDASH, LAST9, ATLASSIAN):
        normalized = check_draft(CatalogKind.MCP, draft).normalized
        assert check_draft(CatalogKind.MCP, normalized).normalized == normalized


def test_redash_only_warns_about_the_unpinned_package() -> None:
    check = check_draft(CatalogKind.MCP, REDASH)
    assert paths(check.warnings) == ["spec.server.args"]
    assert "@suthio/redash-mcp is not pinned" in check.warnings[0].message


def test_a_raw_pasted_snippet_publishes_with_warnings() -> None:
    pasted = {
        "metadata": {"name": "redash"},
        "spec": {
            "server": {
                "command": "npx",
                "args": ["-y", "@suthio/redash-mcp"],
                "env": {"REDASH_API_KEY": "your-api-key", "REDASH_URL": "https://redash.1mg.com/"},
            }
        },
    }
    check = check_draft(CatalogKind.MCP, pasted)
    assert check.errors == ()
    assert check.tier == "one_click"
    assert paths(check.warnings) == [
        "metadata.summary",
        "spec.server.description",
        "spec.server.args",
        "spec.prerequisites",
        "spec.server.env.REDASH_API_KEY",
    ]
    assert "placeholder" in check.warnings[-1].message


@pytest.mark.parametrize(
    ("draft", "path", "message"),
    [
        (server(LAST9, url="http://mcp.internal/mcp"), "spec.server.url", "https://"),
        (server(LAST9, exposure="direct"), "spec.server.exposure", "codemode"),
        (server(LAST9, headers={"Authorization": "Bearer abc123"}), "spec.server.headers.Authorization", "credential"),
        (server(LAST9, headers={"X-Api-Key": "<api key>"}), "spec.server.headers.X-Api-Key", "placeholder"),
        (
            edited(REDASH, inputs=[*REDASH["spec"]["inputs"], {"id": "unused", "label": "Unused"}]),
            "spec.inputs.1",
            "not used",
        ),
    ],
)
def test_policy_findings_are_warnings_only(draft: dict[str, Any], path: str, message: str) -> None:
    check = check_draft(CatalogKind.MCP, draft)
    assert check.errors == ()
    assert check.normalized is not None
    assert any(issue.path == path and message in issue.message for issue in check.warnings)


@pytest.mark.parametrize(
    ("command", "args"),
    [
        ("npx", ["-y", "@suthio/redash-mcp@1.2.3"]),
        ("npx", ["--yes", "mcp-server@0.4.0-beta.1"]),
        ("bunx", ["tool@2.0.0"]),
        ("uvx", ["mcp-server-fetch==2025.1.17"]),
        ("pnpm", ["dlx", "@scope/tool@1.0.0"]),
        ("npx", ["-y", "./local-server"]),
        ("/opt/homebrew/bin/mcp-server", ["--port", "0"]),
    ],
)
def test_pinned_or_unpackaged_commands_do_not_warn_about_versions(command: str, args: list[str]) -> None:
    draft = server(REDASH, command=command, args=args)
    assert "spec.server.args" not in paths(check_draft(CatalogKind.MCP, draft).warnings)


@pytest.mark.parametrize(
    ("command", "args"),
    [
        ("bunx", ["tool"]),
        ("uvx", ["mcp-server-fetch"]),
        ("pnpm", ["dlx", "tool@latest"]),
        ("npx", ["-y", "@scope/tool@^1.2.0"]),
        ("yarn", ["dlx", "tool@1"]),
    ],
)
def test_unpinned_runner_variants_warn(command: str, args: list[str]) -> None:
    draft = server(REDASH, command=command, args=args)
    assert "spec.server.args" in paths(check_draft(CatalogKind.MCP, draft).warnings)


@pytest.mark.parametrize(
    ("draft", "path", "message"),
    [
        (server(REDASH, url="https://example.com/mcp"), "spec.server", "either command"),
        (server(REDASH, command=None, args=None, env=None), "spec.server", "either command"),
        (server(LAST9, type="stdio"), "spec.server.type", "http"),
        (server(REDASH, type="http"), "spec.server.type", "stdio"),
        (server(REDASH, headers={"X-Key": "v"}), "spec.server.headers", "Only HTTP"),
        (server(LAST9, args=["--flag"]), "spec.server.args", "Only stdio"),
        (server(LAST9, env={"A": "b"}), "spec.server.env", "Only stdio"),
        (server(REDASH, command="${input:api_key}"), "spec.server.command", "cannot contain an input"),
        (server(REDASH, env={"KEY": "${input:missing}"}), "spec.server.env.KEY", "Unknown input"),
        (server(REDASH, env={"KEY": "${input:api_key"}), "spec.server.env.KEY", "${input:<id>}"),
        (
            edited(server(LAST9, url="https://${input:host}/mcp"), inputs=[{"id": "host", "label": "Host"}]),
            "spec.server.url",
            "path or query",
        ),
        (edited(REDASH, steps=[{"type": "input", "input": "nope"}]), "spec.steps.0.input", "Unknown input"),
        (
            edited(REDASH, steps=[{"type": "check", "prerequisite": "nope"}]),
            "spec.steps.0.prerequisite",
            "Unknown prerequisite",
        ),
        (
            edited(REDASH, inputs=[{"id": "api_key", "label": "A"}, {"id": "api_key", "label": "B"}]),
            "spec.inputs.1.id",
            "already uses",
        ),
        (
            edited(REDASH, inputs=[{"id": "api_key", "label": "Key", "pattern": "("}]),
            "spec.inputs.0.pattern",
            "regular expression",
        ),
        (edited(LAST9, server=None), "spec", "setup steps"),
        (
            edited(REDASH, server=None),
            "spec.inputs",
            "server template",
        ),
        (
            edited(REDASH, steps=[{"type": "text", "text": "See [docs](http://insecure.example.com)."}]),
            "spec.steps.0.text.text",
            "https://",
        ),
        (
            edited(REDASH, steps=[{"type": "link", "label": "Go", "url": "javascript:alert(1)"}]),
            "spec.steps.0.link.url",
            "https://",
        ),
        (edited(REDASH, steps=[{"type": "html", "html": "<b>x</b>"}]), "spec.steps.0", "does not match"),
        (server(LAST9, oauth={"clientId": "x"}), "spec.server.oauth", "Extra inputs"),
        (server(LAST9, timeout=0), "spec.server.timeout", "greater than 0"),
        (server(LAST9, timeout=True), "spec.server.timeout", "valid number"),
        (edited(REDASH, inputs=[{"id": "api_key", "label": "Two\nlines"}]), "spec.inputs.0.label", "single line"),
    ],
)
def test_structural_problems_block_publishing(draft: dict[str, Any], path: str, message: str) -> None:
    check = check_draft(CatalogKind.MCP, draft)
    assert check.normalized is None
    assert check.tier is None
    assert any(issue.path == path and message in issue.message for issue in check.errors), check.errors


def test_metadata_is_checked() -> None:
    bad = copy.deepcopy(REDASH)
    bad["metadata"] = {"name": " ", "tags": ["Not A Tag"], "docsUrl": "ftp://example.com", "extra": 1}
    assert sorted(paths(check_draft(CatalogKind.MCP, bad).errors)) == [
        "metadata.docsUrl",
        "metadata.extra",
        "metadata.name",
        "metadata.tags.0",
    ]


def test_errors_never_echo_submitted_values() -> None:
    secret = "sk-live-SECRET123"
    bad = server(REDASH, env={"TOKEN": f"{secret}\n"}, cwd=f"{secret}\x00", timeout=secret)
    check = check_draft(CatalogKind.MCP, bad)
    assert check.errors
    assert all(secret not in issue.message and secret not in issue.path for issue in check.errors)


def test_manual_entries_are_instructions_only() -> None:
    manual = {
        "metadata": {"name": "Internal tool", "summary": "Needs an IT request first."},
        "spec": {
            "steps": [
                {"type": "text", "text": "Request access in the IT portal."},
                {"type": "confirm", "id": "access", "label": "I have access"},
            ]
        },
    }
    check = check_draft(CatalogKind.MCP, manual)
    assert check.errors == ()
    assert check.tier == "manual"


def test_confirm_steps_and_prerequisites_make_an_entry_guided() -> None:
    confirm = edited(LAST9, steps=[{"type": "confirm", "id": "vpn", "label": "I am on the VPN"}])
    assert check_draft(CatalogKind.MCP, confirm).tier == "guided"
    optional_input = edited(
        server(LAST9, headers={"X-Team": "${input:team}"}),
        inputs=[{"id": "team", "label": "Team", "required": False}],
    )
    assert check_draft(CatalogKind.MCP, optional_input).tier == "one_click"


def test_skill_preview_entries() -> None:
    check = check_draft(CatalogKind.SKILL, SKILL)
    assert check.errors == ()
    assert check.tier is None
    assert check.warnings == ()
    unsummarized = copy.deepcopy(SKILL)
    unsummarized["metadata"].pop("summary")
    assert paths(check_draft(CatalogKind.SKILL, unsummarized).warnings) == ["metadata.summary"]
    wrong = copy.deepcopy(SKILL)
    wrong["spec"]["source"] = {"type": "s3", "key": "x"}
    assert check_draft(CatalogKind.SKILL, wrong).errors


def test_spec_versions() -> None:
    assert spec_version(CatalogKind.MCP) == 1
    assert spec_version(CatalogKind.SKILL) == 0
