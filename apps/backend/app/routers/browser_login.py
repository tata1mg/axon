"""Browser-login handshake for Axon CLI sessions.

The admin dashboard uses the same axon-auth pairing, but its pairing IDs are a separate,
browser-bound exchange: the ID in the dashboard's browser URL is a one-way derivation of
a secret held only in an HttpOnly cookie, and it carries a marker this public CLI route
refuses. Reading a dashboard login URL is therefore not enough to collect its credential
here or through the dashboard's own poll.
"""

import hashlib
import logging
import re
from typing import Annotated, Literal
from urllib.parse import urlencode, urlsplit, urlunsplit
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Path, Request, Response, status
from pydantic import BaseModel

from app.clients.auth_service import (
    AuthServiceClient,
    AuthServiceError,
    AuthSessionVerification,
    get_auth_service_client,
)
from app.core.config import AuthServiceSettings, get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class BrowserLoginStart(BaseModel):
    session_id: str
    browser_url: str


class BrowserLoginSession(BaseModel):
    status: Literal["PENDING", "AUTHENTICATED"]
    encrypted_session_data: str | None = None
    user_email: str | None = None
    user_name: str | None = None


PAIRING_ID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
# Leading bytes of every dashboard pairing ID. The CLI start route never issues them.
_DASHBOARD_PAIRING_MARKER = bytes.fromhex("ad3a1b0d")
_DASHBOARD_PAIRING_CONTEXT = b"axon-admin-dashboard-pairing\x00"
DASHBOARD_LOGIN_SECRET = re.compile(r"^[A-Za-z0-9_-]{43}$")


def dashboard_pairing_id(login_secret: str) -> str:
    """Derive the dashboard pairing ID (a version-4 UUID) from its cookie-held secret."""
    digest = hashlib.sha256(_DASHBOARD_PAIRING_CONTEXT + login_secret.encode("ascii")).digest()
    return str(UUID(bytes=_DASHBOARD_PAIRING_MARKER + digest[:12], version=4))


def is_dashboard_pairing(session_id: str) -> bool:
    return UUID(session_id).bytes.startswith(_DASHBOARD_PAIRING_MARKER)


def new_cli_pairing_id() -> str:
    while is_dashboard_pairing(session_id := str(uuid4())):
        pass
    return session_id


def browser_login_url(settings: AuthServiceSettings, session_id: str) -> str:
    """The operator-configured login page, paired with one unguessable session ID."""
    url = urlsplit(settings.browser_login_url)
    return urlunsplit(
        url._replace(query=urlencode({"unique_session_id": session_id, "is_external_auth_request": "CLI"}))
    )


@router.post("/verify-auth-token", response_model=AuthSessionVerification)
async def verify_cli_session(
    request: Request, response: Response, refresh_expired: bool = False
) -> AuthSessionVerification:
    """Verify CLI sessions; return opted-in rotations only in the private refresh header."""
    credentials = request.headers.getlist("authorization")
    if len(credentials) != 1:
        raise HTTPException(401, "Authentication required", headers={"Cache-Control": "no-store"})
    scheme, separator, encrypted_session = credentials[0].partition(" ")
    if (
        scheme.lower() != "bearer"
        or not separator
        or not encrypted_session
        or any(not 33 <= ord(character) <= 126 for character in encrypted_session)
    ):
        raise HTTPException(401, "Authentication required", headers={"Cache-Control": "no-store"})
    try:
        result = await get_auth_service_client(request).verify_auth_token(
            credentials[0], refresh_expired=refresh_expired
        )
    except (AuthServiceError, RuntimeError) as exc:
        status_code = exc.status_code if isinstance(exc, AuthServiceError) else 503
        detail = "Authentication required" if status_code in {401, 403} else "Auth service is unavailable"
        raise HTTPException(status_code, detail, headers={"Cache-Control": "no-store"}) from exc
    response.headers["Cache-Control"] = "no-store"
    if refresh_expired and result.encrypted_session_data and result.status in {"VERIFIED", "EXPIRED"}:
        # axon-auth reports EXPIRED even when it successfully refreshed the session.
        response.headers["x-session-refresh-token"] = result.encrypted_session_data
        return AuthSessionVerification(status="VERIFIED")
    return AuthSessionVerification(status=result.status)


@router.post("/browser-login", response_model=BrowserLoginStart)
async def start_browser_login(response: Response) -> BrowserLoginStart:
    """Create an unpredictable pairing ID and a browser URL owned by backend config."""
    settings = get_settings().auth_service
    if settings is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Browser login is not configured")

    session_id = new_cli_pairing_id()
    response.headers["Cache-Control"] = "no-store"
    return BrowserLoginStart(session_id=session_id, browser_url=browser_login_url(settings, session_id))


@router.get("/browser-login/{session_id}", response_model=BrowserLoginSession)
async def get_browser_login_session(
    session_id: Annotated[str, Path(pattern=PAIRING_ID_PATTERN)],
    request: Request,
    response: Response,
) -> BrowserLoginSession:
    """Poll axon-auth; never log or cache the encrypted credential."""
    if get_settings().auth_service is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Browser login is not configured")
    if is_dashboard_pairing(session_id):
        # Dashboard sign-ins complete only through the browser that holds their secret.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "Browser login session not found", headers={"Cache-Control": "no-store"}
        )
    client: AuthServiceClient = get_auth_service_client(request)
    try:
        payload = await client.get_session(session_id)
        session = BrowserLoginSession.model_validate(payload)
        if session.status == "AUTHENTICATED" and not session.encrypted_session_data:
            raise ValueError("Authenticated response has no encrypted session")
    except (AuthServiceError, ValueError) as exc:
        # Never include upstream response bodies: they can contain credentials.
        logger.warning("Browser login session lookup failed")
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Auth service is temporarily unavailable",
        ) from exc
    response.headers["Cache-Control"] = "no-store"
    return session
