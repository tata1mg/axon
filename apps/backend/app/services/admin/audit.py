"""Append-only audit trail for the admin dashboard.

Every admin write should record one event here. Feature modules call
``AdminAuditLog.record`` with the request's ``AdminPrincipal``.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.core.admin_dashboard import AdminRole
from app.models.admin import AdminAuditEvent

MAX_AUDIT_PAGE_SIZE = 100


@dataclass(frozen=True, slots=True)
class AdminIdentity:
    """A verified axon-auth identity. Never built from caller-supplied fields."""

    user_id: int
    email: str
    name: str | None = None


@dataclass(frozen=True, slots=True)
class AdminPrincipal:
    """The signed-in dashboard user for one request, with their current config role."""

    identity: AdminIdentity
    role: AdminRole


@dataclass(frozen=True, slots=True)
class AuditEventView:
    id: int
    actor_user_id: int
    actor_email: str
    actor_role: str | None
    action: str
    target_type: str | None
    target_id: str | None
    details: dict[str, Any]
    created_at: datetime


class AdminAuditLog:
    """Database-backed implementation. Tests substitute an in-memory equivalent."""

    async def record(
        self,
        identity: AdminIdentity,
        role: AdminRole | None,
        action: str,
        *,
        target_type: str | None = None,
        target_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        await AdminAuditEvent.create(
            actor_user_id=identity.user_id,
            actor_email=identity.email,
            actor_role=role.value if role is not None else None,
            action=action,
            target_type=target_type,
            target_id=target_id,
            details=details or {},
        )

    async def list_events(self, *, before_id: int | None, limit: int) -> list[AuditEventView]:
        query = AdminAuditEvent.all()
        if before_id is not None:
            query = query.filter(id__lt=before_id)
        events = await query.order_by("-id").limit(min(limit, MAX_AUDIT_PAGE_SIZE))
        return [
            AuditEventView(
                id=event.id,
                actor_user_id=event.actor_user_id,
                actor_email=event.actor_email,
                actor_role=event.actor_role,
                action=event.action,
                target_type=event.target_type,
                target_id=event.target_id,
                details=event.details if isinstance(event.details, dict) else {},
                created_at=event.created_at,
            )
            for event in events
        ]
