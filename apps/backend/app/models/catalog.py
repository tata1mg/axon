"""Organization catalog items and their published revisions. See the matching dbmate migration."""

from uuid import uuid4

from tortoise import fields

from app.models.base import BaseModel


class CatalogItem(BaseModel):
    """One catalog entry. ``draft`` is the admin working copy; clients read revisions only."""

    id = fields.UUIDField(primary_key=True, default=uuid4)
    kind = fields.CharField(max_length=32)
    slug = fields.CharField(max_length=64)
    status = fields.CharField(max_length=16, default="draft")
    featured = fields.BooleanField(default=False)
    sort_order = fields.IntField(default=0)
    draft = fields.JSONField()
    draft_spec_version = fields.IntField()
    published_revision = fields.IntField(null=True)
    lock_version = fields.IntField(default=1)
    created_by_email = fields.CharField(max_length=320)
    updated_by_email = fields.CharField(max_length=320)
    created_at = fields.DatetimeField(auto_now_add=True)
    updated_at = fields.DatetimeField(auto_now=True)

    class Meta:
        table = "catalog_items"
        unique_together = (("kind", "slug"),)


class CatalogItemRevision(BaseModel):
    """Append-only: application code inserts and reads, never updates."""

    id = fields.BigIntField(primary_key=True, generated=True)
    item = fields.ForeignKeyField("models.CatalogItem", related_name="revisions", on_delete=fields.RESTRICT)
    revision = fields.IntField()
    spec_version = fields.IntField()
    content = fields.JSONField()
    note = fields.CharField(max_length=500, null=True)
    published_by_email = fields.CharField(max_length=320)
    published_at = fields.DatetimeField(auto_now_add=True)

    class Meta:
        table = "catalog_item_revisions"
        unique_together = (("item", "revision"),)
