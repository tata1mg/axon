"""Admin dashboard API: browser sign-in, session, audit trail, and access list.

Sign-in reuses axon-auth's browser-login pairing (the same flow as the CLI), as a
separate, browser-bound exchange: only a secret in an HttpOnly cookie can complete it.
The browser URL carries a pairing ID derived one-way from that secret, which neither
this poll route nor the public CLI poll route accepts on its own.
New dashboard features add routes here (or in a sibling router using AdminRoute and
require_admin_api) and record every write with AdminAuditLog.
"""

import logging
import secrets
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ValidationError

from app.clients.auth_service import AuthServiceError
from app.core.admin_dashboard import ADMIN_API_PREFIX, AdminDashboardSettings
from app.core.config import Settings, get_settings
from app.routers.browser_login import (
    DASHBOARD_LOGIN_SECRET,
    BrowserLoginSession,
    browser_login_url,
    dashboard_pairing_id,
)
from app.services.admin.audit import MAX_AUDIT_PAGE_SIZE, AdminAuditLog, AdminPrincipal
from app.services.admin.guards import (
    AdminRoute,
    AnyAdmin,
    CredentialTooLargeError,
    FullAdmin,
    admin_error,
    auth_client,
    clear_admin_cookie,
    cleared_cookie_headers,
    decode_credential,
    get_admin_audit_log,
    login_cookie_name,
    require_admin_api,
    session_cookie_name,
    set_admin_cookie,
    set_session_cookie,
    verify_credential,
)

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix=ADMIN_API_PREFIX,
    tags=["admin"],
    route_class=AdminRoute,
    dependencies=[Depends(require_admin_api)],
)

AdminSettings = Annotated[AdminDashboardSettings, Depends(require_admin_api)]
AuditLog = Annotated[AdminAuditLog, Depends(get_admin_audit_log)]


class AdminUserView(BaseModel):
    id: str
    email: str
    name: str | None
    role: str


class AdminSessionView(BaseModel):
    user: AdminUserView


class LoginStartView(BaseModel):
    browser_url: str
    expires_in_seconds: int


class LoginPollView(BaseModel):
    status: Literal["pending", "authenticated"]
    session: AdminSessionView | None = None


class AuditEventModel(BaseModel):
    id: str
    actor_user_id: str
    actor_email: str
    actor_role: str | None
    action: str
    target_type: str | None
    target_id: str | None
    details: dict[str, Any]
    created_at: datetime


class AuditEventPage(BaseModel):
    events: list[AuditEventModel]
    next_before: str | None


class AdminMemberView(BaseModel):
    email: str
    role: str


class AdminMembersView(BaseModel):
    members: list[AdminMemberView]
    source: Literal["config"] = "config"


def session_view(principal: AdminPrincipal) -> AdminSessionView:
    identity = principal.identity
    return AdminSessionView(
        user=AdminUserView(id=str(identity.user_id), email=identity.email, name=identity.name, role=principal.role)
    )


@router.post("/login", response_model=LoginStartView)
async def start_login(
    response: Response, settings: AdminSettings, app_settings: Annotated[Settings, Depends(get_settings)]
) -> LoginStartView:
    """Start an axon-auth browser login that only this browser's cookie can complete."""
    if app_settings.auth_service is None:
        raise admin_error(503, "Sign-in is not configured")
    login_secret = secrets.token_urlsafe(32)
    set_admin_cookie(response, settings, login_cookie_name(settings), login_secret, settings.login_timeout_seconds)
    return LoginStartView(
        browser_url=browser_login_url(app_settings.auth_service, dashboard_pairing_id(login_secret)),
        expires_in_seconds=settings.login_timeout_seconds,
    )


@router.post("/login/poll", response_model=LoginPollView, response_model_exclude_none=True)
async def poll_login(request: Request, response: Response, settings: AdminSettings, audit: AuditLog) -> LoginPollView:
    """Complete sign-in once axon-auth reports the pairing as authenticated."""
    login_cookie = login_cookie_name(settings)
    login_done = cleared_cookie_headers(settings, login_cookie)
    login_secret = request.cookies.get(login_cookie, "")
    if not DASHBOARD_LOGIN_SECRET.fullmatch(login_secret):
        raise admin_error(410, "Sign-in expired. Start again.", login_done)

    client = auth_client(request)
    try:
        session = BrowserLoginSession.model_validate(await client.get_session(dashboard_pairing_id(login_secret)))
    except (AuthServiceError, ValidationError):
        # Never log upstream bodies: they can contain credentials.
        logger.warning("Admin sign-in pairing lookup failed")
        raise admin_error(502, "Sign-in is temporarily unavailable") from None

    if session.status == "PENDING":
        response.status_code = 202
        return LoginPollView(status="pending")
    if not session.encrypted_session_data:
        logger.warning("Admin sign-in pairing completed without a session")
        raise admin_error(502, "Sign-in is temporarily unavailable")

    try:
        identity, rotated = await verify_credential(client, session.encrypted_session_data)
    except AuthServiceError as exc:
        if exc.status_code in {401, 403}:
            raise admin_error(401, "Sign-in failed. Start again.", login_done) from None
        raise admin_error(503, "Sign-in is temporarily unavailable") from None

    role = settings.role_for(identity.email)
    if role is None:
        await audit.record(identity, None, "admin.sign_in_denied")
        raise admin_error(403, f"{identity.email} does not have dashboard access", login_done)

    try:
        set_session_cookie(response, settings, rotated or session.encrypted_session_data)
    except CredentialTooLargeError:
        logger.error("Admin sign-in credential exceeds the browser cookie limit")
        raise admin_error(503, "This sign-in session is too large for a browser cookie", login_done) from None
    # Fail closed: no audit record, no session.
    await audit.record(identity, role, "admin.sign_in")
    clear_admin_cookie(response, settings, login_cookie)
    return LoginPollView(status="authenticated", session=session_view(AdminPrincipal(identity=identity, role=role)))


@router.get("/session", response_model=AdminSessionView)
async def current_session(principal: AnyAdmin) -> AdminSessionView:
    return session_view(principal)


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, settings: AdminSettings, audit: AuditLog) -> None:
    """Always clear the browser session; audit it when the credential is still valid.

    Error responses bypass the dependency Response, so every failure after this point
    carries the cookie deletion itself: the browser is signed out whatever happens next.
    """
    cookie = session_cookie_name(settings)
    signed_out = cleared_cookie_headers(settings, cookie)
    credential = decode_credential(request.cookies.get(cookie))
    clear_admin_cookie(response, settings, cookie)
    if credential is None:
        return
    try:
        identity, _ = await verify_credential(auth_client(request), credential)
    except Exception:  # noqa: BLE001 - sign-out must succeed even if axon-auth is down
        return
    try:
        await audit.record(identity, settings.role_for(identity.email), "admin.sign_out")
    except Exception:  # noqa: BLE001 - never leave the session cookie behind
        logger.exception("Admin sign-out could not be audited")
        raise admin_error(500, "You were signed out, but the sign-out could not be recorded.", signed_out) from None


@router.get("/audit-events", response_model=AuditEventPage)
async def list_audit_events(
    _: AnyAdmin,
    audit: AuditLog,
    before: Annotated[int | None, Query(ge=1)] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_AUDIT_PAGE_SIZE)] = 50,
) -> AuditEventPage:
    events = await audit.list_events(before_id=before, limit=limit)
    return AuditEventPage(
        events=[
            AuditEventModel(
                id=str(event.id),
                actor_user_id=str(event.actor_user_id),
                actor_email=event.actor_email,
                actor_role=event.actor_role,
                action=event.action,
                target_type=event.target_type,
                target_id=event.target_id,
                details=event.details,
                created_at=event.created_at,
            )
            for event in events
        ],
        next_before=str(events[-1].id) if len(events) == limit else None,
    )


@router.get("/members", response_model=AdminMembersView)
async def list_members(_: FullAdmin, settings: AdminSettings) -> AdminMembersView:
    """Read-only: access is granted in config.json, never through the dashboard."""
    members = sorted(settings.members.items(), key=lambda item: (-item[1].rank, item[0]))
    return AdminMembersView(members=[AdminMemberView(email=email, role=role) for email, role in members])
