"""Admin dashboard access policy: who may sign in, with which role, and for how long.

Membership lives in config.json on purpose. Granting or revoking admin access is a
reviewed configuration change, never a write through the dashboard itself. Identity
and session validity come from axon-auth on every request; the role is re-read from
this config on every request, so removing an email (and restarting) revokes access
immediately even if that person still holds a valid axon-auth session.
"""

import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

ADMIN_API_PREFIX = "/api/v1/admin"

# Minimal shape check only. Identity comes from axon-auth, so this exists to catch
# typos in config.json, not to validate deliverable addresses.
_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PUBLIC_BASE_PATH_PATTERN = re.compile(r"^(/[A-Za-z0-9._~-]+)*$")


class AdminRole(StrEnum):
    """Ordered roles. A higher rank includes every lower rank's access."""

    VIEWER = "viewer"
    ADMIN = "admin"

    @property
    def rank(self) -> int:
        return _ROLE_RANKS[self]

    def includes(self, required: "AdminRole") -> bool:
        return self.rank >= required.rank


_ROLE_RANKS = {AdminRole.VIEWER: 1, AdminRole.ADMIN: 2}


def normalize_email(value: str) -> str:
    """Compare identities case-insensitively and without surrounding whitespace."""
    return value.strip().casefold()


@dataclass(frozen=True, slots=True)
class AdminDashboardSettings:
    """Validated ADMIN_DASHBOARD section. Disabled unless explicitly enabled."""

    enabled: bool = False
    members: dict[str, AdminRole] = field(default_factory=dict)
    # Browser cookie lifetime only. axon-auth still decides whether the session is valid.
    session_ttl_seconds: int = 8 * 60 * 60
    login_timeout_seconds: int = 10 * 60
    secure_cookies: bool = True
    # The browser-visible prefix that ingress strips before the backend (for example
    # "/axon"). Cookies are scoped to <prefix>/api/v1/admin so they never reach the
    # LiteLLM proxies or any other route mounted on this origin.
    public_base_path: str = ""

    def role_for(self, email: str | None) -> AdminRole | None:
        if not email:
            return None
        return self.members.get(normalize_email(email))

    @property
    def cookie_path(self) -> str:
        return f"{self.public_base_path}{ADMIN_API_PREFIX}"


def _integer(section: dict[str, Any], key: str, default: int, minimum: int, maximum: int) -> int:
    value = section.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"ADMIN_DASHBOARD.{key} must be an integer between {minimum} and {maximum}")
    return value


def _boolean(section: dict[str, Any], key: str, default: bool) -> bool:
    value = section.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"ADMIN_DASHBOARD.{key} must be a boolean")
    return value


def _members(section: dict[str, Any]) -> dict[str, AdminRole]:
    raw = section.get("MEMBERS", {})
    if not isinstance(raw, dict):
        raise ValueError("ADMIN_DASHBOARD.MEMBERS must map email addresses to roles")
    members: dict[str, AdminRole] = {}
    for email, role in raw.items():
        if not isinstance(email, str) or len(email) > 320 or not _EMAIL_PATTERN.fullmatch(email.strip()):
            raise ValueError("ADMIN_DASHBOARD.MEMBERS contains an invalid email address")
        try:
            parsed_role = AdminRole(role)
        except ValueError:
            roles = ", ".join(AdminRole)
            raise ValueError(f"ADMIN_DASHBOARD.MEMBERS roles must be one of: {roles}") from None
        key = normalize_email(email)
        if key in members:
            raise ValueError("ADMIN_DASHBOARD.MEMBERS lists the same email address more than once")
        members[key] = parsed_role
    return members


def parse_admin_dashboard(raw_config: dict[str, Any], *, auth_service_configured: bool) -> AdminDashboardSettings:
    section = raw_config.get("ADMIN_DASHBOARD")
    if section is None:
        return AdminDashboardSettings()
    if not isinstance(section, dict):
        raise ValueError("ADMIN_DASHBOARD must be an object")

    public_base_path = section.get("PUBLIC_BASE_PATH", "")
    if not isinstance(public_base_path, str) or not _PUBLIC_BASE_PATH_PATTERN.fullmatch(public_base_path):
        raise ValueError(
            'ADMIN_DASHBOARD.PUBLIC_BASE_PATH must be "" or a path such as "/axon" without a trailing slash'
        )

    settings = AdminDashboardSettings(
        enabled=_boolean(section, "ENABLED", False),
        members=_members(section),
        session_ttl_seconds=_integer(section, "SESSION_TTL_SECONDS", 8 * 60 * 60, 5 * 60, 7 * 24 * 60 * 60),
        login_timeout_seconds=_integer(section, "LOGIN_TIMEOUT_SECONDS", 10 * 60, 60, 60 * 60),
        secure_cookies=_boolean(section, "SECURE_COOKIES", True),
        public_base_path=public_base_path,
    )
    if settings.enabled:
        if not auth_service_configured:
            raise ValueError("ADMIN_DASHBOARD requires AUTH_SERVICE for sign-in")
        if AdminRole.ADMIN not in settings.members.values():
            raise ValueError("ADMIN_DASHBOARD.MEMBERS must include at least one admin when ENABLED is true")
    return settings
