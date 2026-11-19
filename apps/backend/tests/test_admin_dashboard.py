"""Admin dashboard: config policy, browser sign-in, cookie-held axon-auth sessions, and guards."""

import json
from dataclasses import replace
from datetime import UTC, datetime
from http.cookies import SimpleCookie
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.authentication import SessionRefreshResponseMiddleware
from app.clients.auth_service import AuthDataResponse, AuthServiceError
from app.core import config as config_module
from app.core.admin_dashboard import AdminDashboardSettings, AdminRole, parse_admin_dashboard
from app.core.config import AuthServiceSettings, ConfigurationError, get_settings
from app.routers import browser_login
from app.routers.admin import router
from app.routers.browser_login import dashboard_pairing_id, is_dashboard_pairing
from app.services.admin import guards
from app.services.admin.audit import AdminIdentity, AuditEventView
from app.services.admin.guards import (
    CredentialTooLargeError,
    decode_credential,
    encode_credential,
    get_admin_audit_log,
)

ADMIN_EMAIL = "Root@Example.com"
VIEWER_EMAIL = "viewer@example.com"
CREDENTIAL = "enc-session-credential"
LOGIN_SECRET = "s" * 43
PAIRING_ID = dashboard_pairing_id(LOGIN_SECRET)
HEADERS = {"X-Axon-Admin": "1"}
AUTH_SERVICE = AuthServiceSettings(
    base_url="http://auth.internal/",
    browser_login_url="https://login.example.com/external-auth",
    connect_timeout_seconds=1,
    request_timeout_seconds=1,
)
SETTINGS = AdminDashboardSettings(
    enabled=True,
    members={"root@example.com": AdminRole.ADMIN, VIEWER_EMAIL: AdminRole.VIEWER},
    secure_cookies=False,
    public_base_path="/axon",
)
SESSION_COOKIE = "axon-admin-session"
LOGIN_COOKIE = "axon-admin-login"


# --- configuration -----------------------------------------------------------------


def test_absent_section_is_disabled() -> None:
    assert parse_admin_dashboard({}, auth_service_configured=False) == AdminDashboardSettings()


def test_members_are_normalized_and_roles_parsed() -> None:
    settings = parse_admin_dashboard(
        {
            "ADMIN_DASHBOARD": {
                "ENABLED": True,
                "PUBLIC_BASE_PATH": "/axon",
                "MEMBERS": {" Root@Example.com ": "admin", "v@example.com": "viewer"},
            }
        },
        auth_service_configured=True,
    )
    assert settings.members == {"root@example.com": AdminRole.ADMIN, "v@example.com": AdminRole.VIEWER}
    assert settings.role_for("ROOT@example.com ") is AdminRole.ADMIN
    assert settings.role_for("nobody@example.com") is None
    assert settings.role_for(None) is None
    assert settings.cookie_path == "/axon/api/v1/admin"
    assert AdminRole.ADMIN.includes(AdminRole.VIEWER)
    assert not AdminRole.VIEWER.includes(AdminRole.ADMIN)


@pytest.mark.parametrize(
    ("section", "message"),
    [
        ({"MEMBERS": {"not-an-email": "admin"}}, "invalid email"),
        ({"MEMBERS": {"a@example.com": "owner"}}, "roles must be one of"),
        ({"MEMBERS": {"a@example.com": "admin", "A@example.com": "viewer"}}, "more than once"),
        ({"MEMBERS": ["a@example.com"]}, "must map"),
        ({"PUBLIC_BASE_PATH": "/axon/"}, "PUBLIC_BASE_PATH"),
        ({"PUBLIC_BASE_PATH": "axon"}, "PUBLIC_BASE_PATH"),
        ({"SESSION_TTL_SECONDS": 10}, "SESSION_TTL_SECONDS"),
        ({"SECURE_COOKIES": "yes"}, "SECURE_COOKIES"),
        ({"ENABLED": True, "MEMBERS": {"v@example.com": "viewer"}}, "at least one admin"),
    ],
)
def test_invalid_sections_are_rejected_without_echoing_values(section: dict, message: str) -> None:
    with pytest.raises(ValueError, match=message) as error:
        parse_admin_dashboard({"ADMIN_DASHBOARD": section}, auth_service_configured=True)
    assert "example.com" not in str(error.value)


def test_enabled_dashboard_requires_auth_service() -> None:
    with pytest.raises(ValueError, match="requires AUTH_SERVICE"):
        parse_admin_dashboard(
            {"ADMIN_DASHBOARD": {"ENABLED": True, "MEMBERS": {"a@example.com": "admin"}}},
            auth_service_configured=False,
        )


def test_settings_loader_wraps_admin_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    raw = json.loads((config_module.BASE_DIR / "config_template.json").read_text())
    monkeypatch.setattr(config_module, "BASE_DIR", tmp_path)
    try:
        (tmp_path / "config.json").write_text(json.dumps(raw))
        get_settings.cache_clear()
        assert get_settings().admin_dashboard.enabled is False

        raw["ADMIN_DASHBOARD"] = {"ENABLED": True, "MEMBERS": {"secret@example.com": "superuser"}}
        (tmp_path / "config.json").write_text(json.dumps(raw))
        get_settings.cache_clear()
        with pytest.raises(ConfigurationError, match=r"^config\.ADMIN_DASHBOARD\.MEMBERS roles") as error:
            get_settings()
        assert "secret@" not in str(error.value)
    finally:
        get_settings.cache_clear()


# --- cookie encoding ---------------------------------------------------------------


@pytest.mark.parametrize("credential", ["abc.DEF-123_~", 'has;semi"quote\\slash,comma=eq/'])
def test_credentials_round_trip_through_the_cookie_encoding(credential: str) -> None:
    encoded = encode_credential(credential)
    assert all(character not in encoded for character in ';", \\')
    assert decode_credential(encoded) == credential


def test_oversized_credentials_are_refused() -> None:
    with pytest.raises(CredentialTooLargeError):
        encode_credential("a" * 5000)


@pytest.mark.parametrize("value", [None, "", "x.abc", "r.", "b.!!!", "r.has space", "b." + "A" * 4000])
def test_malformed_cookies_decode_to_nothing(value: str | None) -> None:
    assert decode_credential(value) is None


# --- routes --------------------------------------------------------------------------


class FakeAuth:
    def __init__(self) -> None:
        self.pairing: dict = {"status": "PENDING"}
        self.identities = {CREDENTIAL: {"user_id": 7, "user_email": ADMIN_EMAIL, "user_name": "Root"}}
        self.rotations: dict[str, str] = {}
        self.failure: int | None = None
        self.seen: list[tuple[str, dict]] = []

    async def get_session(self, session_id: str) -> dict:
        self.seen.append(("session", {"id": session_id}))
        return self.pairing

    async def get_auth_data(self, authorization: str, grace_params: dict) -> AuthDataResponse:
        self.seen.append((authorization, grace_params))
        if self.failure is not None:
            raise AuthServiceError("synthetic", status_code=self.failure)
        credential = authorization.removeprefix("Bearer ")
        if credential not in self.identities:
            raise AuthServiceError("synthetic", status_code=401)
        data = {**self.identities[credential], "session_refresh_token": self.rotations.get(credential)}
        return AuthDataResponse.model_validate({"auth_data": data, "response_headers": {}})


class FakeAudit:
    def __init__(self) -> None:
        self.events: list[AuditEventView] = []

    async def record(self, identity: AdminIdentity, role: AdminRole | None, action: str, **target: object) -> None:
        self.events.append(
            AuditEventView(
                id=len(self.events) + 1,
                actor_user_id=identity.user_id,
                actor_email=identity.email,
                actor_role=role.value if role else None,
                action=action,
                target_type=target.get("target_type"),
                target_id=target.get("target_id"),
                details=target.get("details") or {},
                created_at=datetime(2026, 11, 17, tzinfo=UTC),
            )
        )

    async def list_events(self, *, before_id: int | None, limit: int) -> list[AuditEventView]:
        events = [event for event in reversed(self.events) if before_id is None or event.id < before_id]
        return events[:limit]

    @property
    def actions(self) -> list[str]:
        return [event.action for event in self.events]


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    auth = FakeAuth()
    audit = FakeAudit()
    app = FastAPI()
    # The real middleware must not leak rotated credentials into a readable header.
    app.add_middleware(SessionRefreshResponseMiddleware)
    app.include_router(router)
    # The public CLI pairing routes share the origin with the dashboard.
    app.include_router(browser_login.router)
    state = SimpleNamespace(settings=SETTINGS)

    def settings() -> SimpleNamespace:
        return SimpleNamespace(admin_dashboard=state.settings, auth_service=AUTH_SERVICE)

    app.dependency_overrides[get_settings] = settings
    app.dependency_overrides[get_admin_audit_log] = lambda: audit
    monkeypatch.setattr(guards, "get_auth_service_client", lambda _request: auth)
    monkeypatch.setattr(browser_login, "get_auth_service_client", lambda _request: auth)
    monkeypatch.setattr(browser_login, "get_settings", settings)
    # Cookies are scoped to /axon/api/v1/admin; serve the API under that browser path,
    # as ingress does in production.
    outer = FastAPI()
    outer.mount("/axon", app)
    client = TestClient(outer, base_url="http://testserver/axon", headers=HEADERS)
    return SimpleNamespace(client=client, auth=auth, audit=audit, state=state)


def set_cookies(response) -> dict[str, SimpleCookie]:  # noqa: ANN001 - httpx response
    cookies = {}
    for header in response.headers.get_list("set-cookie"):
        cookie = SimpleCookie()
        cookie.load(header)
        cookies.update({name: morsel for name, morsel in cookie.items()})
    return cookies


def signed_in(harness: SimpleNamespace, credential: str = CREDENTIAL) -> TestClient:
    harness.client.cookies.set(SESSION_COOKIE, encode_credential(credential), path="/axon/api/v1/admin")
    return harness.client


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/login"),
        ("POST", "/login/poll"),
        ("GET", "/session"),
        ("POST", "/logout"),
        ("GET", "/audit-events"),
        ("GET", "/members"),
    ],
)
def test_every_route_is_hidden_when_disabled_and_requires_the_dashboard_header(
    harness: SimpleNamespace, method: str, path: str
) -> None:
    url = f"/api/v1/admin{path}"
    assert harness.client.request(method, url, headers={"X-Axon-Admin": "0"}).status_code == 403
    cross_site = harness.client.request(method, url, headers={"Sec-Fetch-Site": "cross-site"})
    assert cross_site.status_code == 403
    harness.state.settings = replace(SETTINGS, enabled=False)
    response = harness.client.request(method, url)
    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"


def test_login_binds_the_pairing_to_a_secret_http_only_cookie(harness: SimpleNamespace) -> None:
    response = harness.client.post("/api/v1/admin/login")
    assert response.status_code == 200
    body = response.json()
    pairing_id = parse_qs(urlsplit(body["browser_url"]).query)["unique_session_id"][0]
    assert body["browser_url"].startswith("https://login.example.com/external-auth?")
    assert body["expires_in_seconds"] == 600
    cookie = set_cookies(response)[LOGIN_COOKIE]
    # The page sees only a one-way derivation of the cookie's secret.
    assert cookie.value != pairing_id
    assert cookie.value not in response.text
    assert dashboard_pairing_id(cookie.value) == pairing_id
    assert is_dashboard_pairing(pairing_id)
    assert cookie["httponly"] is True
    assert cookie["samesite"] == "strict"
    assert cookie["path"] == "/axon/api/v1/admin"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("value", ["not-a-secret", PAIRING_ID, LOGIN_SECRET + "x"])
def test_poll_without_the_login_secret_has_expired(harness: SimpleNamespace, value: str) -> None:
    harness.auth.pairing = {"status": "AUTHENTICATED", "encrypted_session_data": CREDENTIAL}
    # Knowing the pairing ID from the browser URL does not complete the sign-in.
    harness.client.cookies.set(LOGIN_COOKIE, value, path="/axon/api/v1/admin")
    response = harness.client.post("/api/v1/admin/login/poll")
    assert response.status_code == 410
    assert SESSION_COOKIE not in set_cookies(response)
    assert harness.auth.seen == []


def test_the_public_cli_poll_refuses_dashboard_pairings(harness: SimpleNamespace) -> None:
    harness.auth.pairing = {"status": "AUTHENTICATED", "encrypted_session_data": CREDENTIAL}
    response = harness.client.post("/api/v1/admin/login")
    pairing_id = parse_qs(urlsplit(response.json()["browser_url"]).query)["unique_session_id"][0]

    stolen = harness.client.get(f"/api/v1/auth/browser-login/{pairing_id}")
    assert stolen.status_code == 404
    assert CREDENTIAL not in stolen.text
    assert harness.auth.seen == []

    # Ordinary CLI pairings keep working.
    started = harness.client.post("/api/v1/auth/browser-login").json()
    assert not is_dashboard_pairing(started["session_id"])
    polled = harness.client.get(f"/api/v1/auth/browser-login/{started['session_id']}")
    assert polled.status_code == 200
    assert polled.json()["encrypted_session_data"] == CREDENTIAL


def test_cli_pairings_never_carry_the_dashboard_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    from uuid import UUID

    issued = iter([UUID(dashboard_pairing_id("x" * 43)), UUID("6f1c1a52-6c1e-4b8e-9d55-0a1c2b3d4e5f")])
    monkeypatch.setattr(browser_login, "uuid4", lambda: next(issued))
    assert browser_login.new_cli_pairing_id() == "6f1c1a52-6c1e-4b8e-9d55-0a1c2b3d4e5f"


def test_poll_reports_pending(harness: SimpleNamespace) -> None:
    harness.client.cookies.set(LOGIN_COOKIE, LOGIN_SECRET, path="/axon/api/v1/admin")
    response = harness.client.post("/api/v1/admin/login/poll")
    assert response.status_code == 202
    assert response.json() == {"status": "pending"}
    assert harness.auth.seen == [("session", {"id": PAIRING_ID})]


def test_member_sign_in_stores_the_verified_credential_only_in_the_cookie(harness: SimpleNamespace) -> None:
    harness.auth.pairing = {"status": "AUTHENTICATED", "encrypted_session_data": CREDENTIAL}
    harness.auth.rotations[CREDENTIAL] = "rotated-credential"
    harness.client.cookies.set(LOGIN_COOKIE, LOGIN_SECRET, path="/axon/api/v1/admin")

    response = harness.client.post("/api/v1/admin/login/poll")

    assert response.status_code == 200
    assert response.json() == {
        "status": "authenticated",
        "session": {"user": {"id": "7", "email": ADMIN_EMAIL, "name": "Root", "role": "admin"}},
    }
    cookies = set_cookies(response)
    assert decode_credential(cookies[SESSION_COOKIE].value) == "rotated-credential"
    assert cookies[SESSION_COOKIE]["httponly"] is True
    assert cookies[SESSION_COOKIE]["max-age"] == "28800"
    assert cookies[LOGIN_COOKIE]["max-age"] == "0"
    assert "rotated-credential" not in response.text and CREDENTIAL not in response.text
    assert "x-session-refresh-token" not in response.headers
    assert harness.auth.seen[-1] == (
        f"Bearer {CREDENTIAL}",
        {"use_grace_period": "false", "enable_grace_period": "false"},
    )
    assert harness.audit.actions == ["admin.sign_in"]


def test_non_member_sign_in_is_denied_and_audited(harness: SimpleNamespace) -> None:
    harness.auth.identities["other"] = {"user_id": 9, "user_email": "intruder@example.com"}
    harness.auth.pairing = {"status": "AUTHENTICATED", "encrypted_session_data": "other"}
    harness.client.cookies.set(LOGIN_COOKIE, LOGIN_SECRET, path="/axon/api/v1/admin")

    response = harness.client.post("/api/v1/admin/login/poll")

    assert response.status_code == 403
    assert "intruder@example.com does not have dashboard access" in response.text
    assert SESSION_COOKIE not in set_cookies(response)
    assert set_cookies(response)[LOGIN_COOKIE]["max-age"] == "0"
    assert harness.audit.events[0].action == "admin.sign_in_denied"
    assert harness.audit.events[0].actor_role is None


def test_sign_in_with_an_oversized_credential_fails_clearly(harness: SimpleNamespace) -> None:
    big = "x" * 5000
    harness.auth.identities[big] = {"user_id": 7, "user_email": ADMIN_EMAIL}
    harness.auth.pairing = {"status": "AUTHENTICATED", "encrypted_session_data": big}
    harness.client.cookies.set(LOGIN_COOKIE, LOGIN_SECRET, path="/axon/api/v1/admin")
    response = harness.client.post("/api/v1/admin/login/poll")
    assert response.status_code == 503
    assert "too large for a browser cookie" in response.text
    assert harness.audit.actions == []


def test_session_verifies_the_cookie_with_axon_auth_every_request(harness: SimpleNamespace) -> None:
    client = signed_in(harness)
    for _ in range(2):
        response = client.get("/api/v1/admin/session")
        assert response.status_code == 200
        assert response.json()["user"]["role"] == "admin"
    assert [seen[0] for seen in harness.auth.seen] == [f"Bearer {CREDENTIAL}"] * 2


def test_rotated_credentials_replace_the_cookie(harness: SimpleNamespace) -> None:
    harness.auth.rotations[CREDENTIAL] = "next"
    response = signed_in(harness).get("/api/v1/admin/session")
    assert response.status_code == 200
    assert decode_credential(set_cookies(response)[SESSION_COOKIE].value) == "next"
    assert "x-session-refresh-token" not in response.headers


def test_rotation_reaches_the_browser_on_endpoint_errors(harness: SimpleNamespace) -> None:
    harness.auth.rotations[CREDENTIAL] = "next"
    response = signed_in(harness).get("/api/v1/admin/audit-events", params={"limit": 500})
    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid request"}
    assert decode_credential(set_cookies(response)[SESSION_COOKIE].value) == "next"
    assert response.headers["cache-control"] == "no-store"


def test_rotation_is_sent_once_on_success(harness: SimpleNamespace) -> None:
    harness.auth.rotations[CREDENTIAL] = "next"
    response = signed_in(harness).get("/api/v1/admin/members")
    assert response.status_code == 200
    assert len(response.headers.get_list("set-cookie")) == 1


def test_rotation_reaches_the_browser_even_when_the_role_is_insufficient(harness: SimpleNamespace) -> None:
    harness.auth.identities[CREDENTIAL]["user_email"] = VIEWER_EMAIL
    harness.auth.rotations[CREDENTIAL] = "next"
    response = signed_in(harness).get("/api/v1/admin/members")
    assert response.status_code == 403
    assert decode_credential(set_cookies(response)[SESSION_COOKIE].value) == "next"


@pytest.mark.parametrize(("failure", "expected"), [(401, 401), (403, 401), (503, 503)])
def test_upstream_failures(harness: SimpleNamespace, failure: int, expected: int) -> None:
    harness.auth.failure = failure
    response = signed_in(harness).get("/api/v1/admin/session")
    assert response.status_code == expected
    cleared = SESSION_COOKIE in set_cookies(response)
    # Keep the cookie when axon-auth is merely unavailable.
    assert cleared is (expected == 401)


def test_missing_or_garbage_cookie_requires_sign_in(harness: SimpleNamespace) -> None:
    assert harness.client.get("/api/v1/admin/session").status_code == 401
    harness.client.cookies.set(SESSION_COOKIE, "garbage", path="/axon/api/v1/admin")
    response = harness.client.get("/api/v1/admin/session")
    assert response.status_code == 401
    assert set_cookies(response)[SESSION_COOKIE]["max-age"] == "0"
    assert harness.auth.seen == []


def test_removing_a_member_from_config_ends_their_session(harness: SimpleNamespace) -> None:
    client = signed_in(harness)
    harness.state.settings = replace(SETTINGS, members={"someone@example.com": AdminRole.ADMIN})
    response = client.get("/api/v1/admin/session")
    assert response.status_code == 401
    assert set_cookies(response)[SESSION_COOKIE]["max-age"] == "0"


def test_members_require_the_admin_role(harness: SimpleNamespace) -> None:
    client = signed_in(harness)
    response = client.get("/api/v1/admin/members")
    assert response.status_code == 200
    assert response.json() == {
        "members": [{"email": "root@example.com", "role": "admin"}, {"email": VIEWER_EMAIL, "role": "viewer"}],
        "source": "config",
    }
    harness.auth.identities[CREDENTIAL]["user_email"] = VIEWER_EMAIL
    assert client.get("/api/v1/admin/members").status_code == 403
    assert client.get("/api/v1/admin/session").json()["user"]["role"] == "viewer"


def test_audit_events_paginate_newest_first(harness: SimpleNamespace) -> None:
    identity = AdminIdentity(user_id=7, email=ADMIN_EMAIL)
    import asyncio

    for _ in range(5):
        asyncio.run(harness.audit.record(identity, AdminRole.ADMIN, "admin.sign_in"))
    client = signed_in(harness)
    first = client.get("/api/v1/admin/audit-events", params={"limit": 2}).json()
    assert [event["id"] for event in first["events"]] == ["5", "4"]
    assert first["next_before"] == "4"
    last = client.get("/api/v1/admin/audit-events", params={"limit": 4, "before": 2}).json()
    assert [event["id"] for event in last["events"]] == ["1"]
    assert last["next_before"] is None
    assert client.get("/api/v1/admin/audit-events", params={"limit": 500}).status_code == 422


def test_logout_clears_the_cookie_and_audits_when_possible(harness: SimpleNamespace) -> None:
    response = signed_in(harness).post("/api/v1/admin/logout")
    assert response.status_code == 204
    assert set_cookies(response)[SESSION_COOKIE]["max-age"] == "0"
    assert harness.audit.actions == ["admin.sign_out"]

    harness.auth.failure = 503
    response = signed_in(harness).post("/api/v1/admin/logout")
    assert response.status_code == 204
    assert harness.audit.actions == ["admin.sign_out"]


def test_logout_clears_the_cookie_even_when_the_audit_fails(
    harness: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def broken(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("database down")

    monkeypatch.setattr(harness.audit, "record", broken)
    response = signed_in(harness).post("/api/v1/admin/logout")
    assert response.status_code == 500
    assert "signed out" in response.json()["detail"]
    assert set_cookies(response)[SESSION_COOKIE]["max-age"] == "0"
    assert response.headers["cache-control"] == "no-store"


def test_large_bodies_are_rejected(harness: SimpleNamespace) -> None:
    response = signed_in(harness).post("/api/v1/admin/logout", content=b"x" * (64 * 1024 + 1))
    assert response.status_code == 413


def test_secure_cookies_use_the_secure_prefix(harness: SimpleNamespace) -> None:
    harness.state.settings = replace(SETTINGS, secure_cookies=True)
    harness.client.base_url = "https://testserver/axon"
    response = harness.client.post("/api/v1/admin/login")
    cookie = set_cookies(response)["__Secure-axon-admin-login"]
    assert cookie["secure"] is True
