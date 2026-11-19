"""Request guards shared by every admin dashboard route.

The dashboard has no session store of its own. After browser sign-in, the
axon-auth session credential lives in an HttpOnly cookie and is verified with
axon-auth on every request, exactly like a CLI bearer token. Defense layers:

1. The whole API returns 404 unless ADMIN_DASHBOARD.ENABLED is true.
2. Every request must carry ``X-Axon-Admin: 1``. Browsers cannot attach a custom
   header cross-origin without a CORS preflight, which this backend never grants,
   and ``Sec-Fetch-Site`` must not report a cross-site caller. With SameSite=Strict
   cookies this is the CSRF defense; there is no separate CSRF token.
3. Cookies are HttpOnly, SameSite=Strict and path-scoped to the admin API, so page
   scripts and the LiteLLM proxies on this origin never see the credential.
4. The role comes from config.json on every request.

Never store the verified AuthData on ``request.state.auth_data``:
SessionRefreshResponseMiddleware would copy rotated credentials into a response
header that page JavaScript can read. Rotations go back into the cookie instead, and
AdminRoute adds that cookie to every response the request produces, including errors
raised after the guard ran (conflicts, validation failures), which never see the
dependency Response.
"""

import base64
import binascii
from collections.abc import Awaitable, Callable
from typing import Annotated, NoReturn

from fastapi import Depends, HTTPException, Request, Response
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from app.clients.auth_service import AuthServiceClient, AuthServiceError, get_auth_service_client
from app.core.admin_dashboard import AdminDashboardSettings, AdminRole
from app.core.config import Settings, get_settings
from app.services.admin.audit import AdminAuditLog, AdminIdentity, AdminPrincipal

ADMIN_REQUEST_HEADER = "x-axon-admin"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
MAX_ADMIN_BODY_BYTES = 64 * 1024
NO_STORE = {"Cache-Control": "no-store"}
# Browsers drop cookies whose name=value exceeds ~4096 bytes; leave room for the name.
MAX_COOKIE_VALUE_BYTES = 3900
# Characters Python's cookie writer emits without quoting or escaping.
_RAW_COOKIE_CHARACTERS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+-.^_`|~:")
_NO_GRACE = {"use_grace_period": "false", "enable_grace_period": "false"}
# request.state attribute holding the Set-Cookie header for a rotated session credential.
_ROTATION_STATE = "admin_session_rotation"


class CredentialTooLargeError(Exception):
    """The axon-auth credential cannot be carried in a browser cookie."""


def admin_error(status_code: int, detail: str, headers: dict[str, str] | None = None) -> HTTPException:
    return HTTPException(status_code, detail, headers={**NO_STORE, **(headers or {})})


def session_cookie_name(settings: AdminDashboardSettings) -> str:
    return "__Secure-axon-admin-session" if settings.secure_cookies else "axon-admin-session"


def login_cookie_name(settings: AdminDashboardSettings) -> str:
    return "__Secure-axon-admin-login" if settings.secure_cookies else "axon-admin-login"


def encode_credential(credential: str) -> str:
    """Store cookie-safe credentials as-is; base64url anything else. Bounded either way."""
    if all(character in _RAW_COOKIE_CHARACTERS for character in credential):
        value = f"r.{credential}"
    else:
        value = "b." + base64.urlsafe_b64encode(credential.encode("utf-8")).decode("ascii").rstrip("=")
    if len(value) > MAX_COOKIE_VALUE_BYTES:
        raise CredentialTooLargeError
    return value


def decode_credential(value: str | None) -> str | None:
    if not value or len(value) > MAX_COOKIE_VALUE_BYTES:
        return None
    kind, _, payload = value.partition(".")
    if not payload:
        return None
    if kind == "r":
        credential = payload
    elif kind == "b":
        try:
            padded = payload + "=" * (-len(payload) % 4)
            credential = base64.b64decode(padded, altchars=b"-_", validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            return None
    else:
        return None
    # Same shape the backend accepts for CLI bearer sessions.
    if not credential or any(not 33 <= ord(character) <= 126 for character in credential):
        return None
    return credential


def set_admin_cookie(response: Response, settings: AdminDashboardSettings, name: str, value: str, max_age: int) -> None:
    response.set_cookie(
        name,
        value,
        max_age=max_age,
        path=settings.cookie_path,
        secure=settings.secure_cookies,
        httponly=True,
        samesite="strict",
    )


def clear_admin_cookie(response: Response, settings: AdminDashboardSettings, name: str) -> None:
    response.delete_cookie(
        name, path=settings.cookie_path, secure=settings.secure_cookies, httponly=True, samesite="strict"
    )


def cleared_cookie_headers(settings: AdminDashboardSettings, name: str) -> dict[str, str]:
    """Set-Cookie header for an error response, which bypasses the dependency Response."""
    response = Response()
    clear_admin_cookie(response, settings, name)
    return {"set-cookie": response.headers["set-cookie"]}


def set_session_cookie(response: Response, settings: AdminDashboardSettings, credential: str) -> None:
    set_admin_cookie(
        response, settings, session_cookie_name(settings), encode_credential(credential), settings.session_ttl_seconds
    )


class AdminRoute(APIRoute):
    """Bound request bodies, never cache, and never reflect invalid input."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def guarded(request: Request) -> Response:
            if request.method not in SAFE_METHODS:
                size = 0
                pieces = []
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_ADMIN_BODY_BYTES:
                        return JSONResponse({"detail": "Request is too large"}, status_code=413, headers=NO_STORE)
                    pieces.append(chunk)
                request._body = b"".join(pieces)
            try:
                response = await handler(request)
            except RequestValidationError:
                response = JSONResponse({"detail": "Invalid request"}, status_code=422, headers=NO_STORE)
            except HTTPException as exc:
                if _pending_rotation(request) is None:
                    raise
                response = await http_exception_handler(request, exc)
            rotation = _pending_rotation(request)
            if rotation is not None:
                # axon-auth may already have invalidated the old credential.
                response.headers.append("set-cookie", rotation)
            response.headers["Cache-Control"] = "no-store"
            return response

        return guarded


def _pending_rotation(request: Request) -> str | None:
    return getattr(request.state, _ROTATION_STATE, None)


def admin_settings(settings: Annotated[Settings, Depends(get_settings)]) -> AdminDashboardSettings:
    return settings.admin_dashboard


def require_admin_api(
    request: Request, settings: Annotated[AdminDashboardSettings, Depends(admin_settings)]
) -> AdminDashboardSettings:
    """Router-level guard applied before any admin route, signed in or not."""
    if not settings.enabled:
        raise admin_error(404, "Not Found")
    if request.headers.get(ADMIN_REQUEST_HEADER) != "1":
        raise admin_error(403, "Admin API requests must come from the dashboard")
    if request.headers.get("sec-fetch-site", "same-origin") not in {"same-origin", "none"}:
        raise admin_error(403, "Admin API requests must come from the dashboard")
    return settings


def get_admin_audit_log() -> AdminAuditLog:
    return AdminAuditLog()


def auth_client(request: Request) -> AuthServiceClient:
    try:
        return get_auth_service_client(request)
    except RuntimeError:
        raise admin_error(503, "Sign-in is temporarily unavailable") from None


async def verify_credential(client: AuthServiceClient, credential: str) -> tuple[AdminIdentity, str | None]:
    """Return the axon-auth identity and any rotated credential.

    Raises AuthServiceError: 401/403 for an invalid session, 503 when unavailable.
    """
    response = await client.get_auth_data(f"Bearer {credential}", _NO_GRACE)
    data = response.auth_data
    email = (data.user_email or "").strip()
    if not email:
        raise AuthServiceError("Auth service returned no email address", status_code=403)
    return AdminIdentity(user_id=data.user_id, email=email, name=data.user_name), data.session_refresh_token


def _deny(status_code: int, detail: str, headers: dict[str, str] | None = None) -> NoReturn:
    raise admin_error(status_code, detail, headers)


def require_admin(minimum: AdminRole) -> Callable[..., Awaitable[AdminPrincipal]]:
    """Dependency factory: ``Depends(require_admin(AdminRole.ADMIN))``."""

    async def dependency(
        request: Request,
        settings: Annotated[AdminDashboardSettings, Depends(require_admin_api)],
    ) -> AdminPrincipal:
        cookie = session_cookie_name(settings)
        signed_out = cleared_cookie_headers(settings, cookie)
        credential = decode_credential(request.cookies.get(cookie))
        if credential is None:
            _deny(401, "Sign in to continue", signed_out if cookie in request.cookies else None)

        try:
            identity, rotated = await verify_credential(auth_client(request), credential)
        except AuthServiceError as exc:
            if exc.status_code in {401, 403}:
                _deny(401, "Sign in to continue", signed_out)
            _deny(503, "Sign-in is temporarily unavailable")

        role = settings.role_for(identity.email)
        if role is None:
            # Removed from config since signing in: end the browser session too.
            _deny(401, "Sign in to continue", signed_out)

        if rotated and rotated != credential:
            # axon-auth may invalidate the old credential once it rotates, so the new
            # one must reach the browser on every outcome: AdminRoute adds it to the
            # response, including the 403 below and any error the endpoint raises.
            carrier = Response()
            try:
                set_session_cookie(carrier, settings, rotated)
            except CredentialTooLargeError:
                _deny(401, "Sign in to continue", signed_out)
            setattr(request.state, _ROTATION_STATE, carrier.headers["set-cookie"])

        if not role.includes(minimum):
            _deny(403, "Your role does not allow this action")
        return AdminPrincipal(identity=identity, role=role)

    return dependency


# Common aliases for route signatures.
AnyAdmin = Annotated[AdminPrincipal, Depends(require_admin(AdminRole.VIEWER))]
FullAdmin = Annotated[AdminPrincipal, Depends(require_admin(AdminRole.ADMIN))]
