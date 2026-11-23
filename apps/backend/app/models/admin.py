"""Admin dashboard audit trail. See the matching dbmate migration."""

from tortoise import fields

from app.models.base import BaseModel


class AdminAuditEvent(BaseModel):
    """Append-only: application code inserts and reads, never updates."""

    id = fields.BigIntField(primary_key=True, generated=True)
    actor_user_id = fields.BigIntField()
    actor_email = fields.CharField(max_length=320)
    actor_role = fields.CharField(max_length=32, null=True)
    action = fields.CharField(max_length=128)
    target_type = fields.CharField(max_length=64, null=True)
    target_id = fields.CharField(max_length=256, null=True)
    details = fields.JSONField(default=dict)
    created_at = fields.DatetimeField(auto_now_add=True)

    class Meta:
        table = "admin_audit_events"
