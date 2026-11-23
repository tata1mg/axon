"""Catalog persistence: drafts, publishing, status changes, and revision history.

Every write names the ``lock_version`` it was based on, so two admins never overwrite
each other silently. Writes take a row lock, apply the change, and call the caller's
audit hook inside the same transaction: if the audit record cannot be written, the
change is rolled back.

The rule helpers at the top are pure so the route tests' in-memory store can share them.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from tortoise.exceptions import IntegrityError
from tortoise.expressions import Q
from tortoise.functions import Max
from tortoise.transactions import in_transaction

from app.models.catalog import CatalogItem, CatalogItemRevision
from app.services.catalog.specs import CatalogKind, CatalogStatus, check_draft, spec_version

MAX_PUBLISHED_ITEMS = 100

StatusAction = Literal["unpublish", "archive", "unarchive"]


class CatalogError(Exception):
    """A user-safe failure with the HTTP status the admin API should report."""

    status_code = 400

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class CatalogNotFoundError(CatalogError):
    status_code = 404


class CatalogConflictError(CatalogError):
    status_code = 409


class CatalogInvalidError(CatalogError):
    status_code = 422


@dataclass(frozen=True, slots=True)
class CatalogRevisionRecord:
    item_id: UUID
    revision: int
    spec_version: int
    content: dict[str, Any]
    note: str | None
    published_by_email: str
    published_at: datetime


@dataclass(frozen=True, slots=True)
class CatalogItemRecord:
    id: UUID
    kind: CatalogKind
    slug: str
    status: CatalogStatus
    featured: bool
    sort_order: int
    draft: dict[str, Any]
    draft_spec_version: int
    published_revision: int | None
    lock_version: int
    created_by_email: str
    updated_by_email: str
    created_at: datetime
    updated_at: datetime
    # Highest revision ever published, or None if the item was never published.
    latest_revision: int | None
    published: CatalogRevisionRecord | None


@dataclass(frozen=True, slots=True)
class ItemChanges:
    draft: dict[str, Any] | None = None
    slug: str | None = None
    featured: bool | None = None
    sort_order: int | None = None


AuditHook = Callable[[CatalogItemRecord], Awaitable[None]]


# --- rules shared with the in-memory test store ----------------------------------------


def ensure_lock(current: int, expected: int) -> None:
    if current != expected:
        raise CatalogConflictError("This item changed since you loaded it. Reload it and try again.")


def ensure_editable(status: CatalogStatus) -> None:
    if status is CatalogStatus.ARCHIVED:
        raise CatalogConflictError("Unarchive this item before changing it.")


def ensure_slug_change_allowed(latest_revision: int | None) -> None:
    if latest_revision is not None:
        raise CatalogConflictError("The slug cannot change after the first publish: users install under that name.")


def ensure_deletable(latest_revision: int | None) -> None:
    if latest_revision is not None:
        raise CatalogConflictError("Published items keep their history. Archive this item instead.")


def next_status(status: CatalogStatus, action: StatusAction) -> CatalogStatus:
    if action == "unpublish":
        if status is not CatalogStatus.PUBLISHED:
            raise CatalogConflictError("This item is not published.")
        return CatalogStatus.DRAFT
    if action == "archive":
        if status is CatalogStatus.ARCHIVED:
            raise CatalogConflictError("This item is already archived.")
        return CatalogStatus.ARCHIVED
    if status is not CatalogStatus.ARCHIVED:
        raise CatalogConflictError("This item is not archived.")
    return CatalogStatus.DRAFT


def publication(kind: CatalogKind, draft: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Return the normalized content and spec version to publish, or refuse an invalid draft."""
    check = check_draft(kind, draft)
    if check.normalized is None:
        count = len(check.errors)
        raise CatalogInvalidError(f"Fix {count} error{'s' if count != 1 else ''} in the draft before publishing.")
    return check.normalized, spec_version(kind)


# --- database store -------------------------------------------------------------------


def _revision_record(row: CatalogItemRevision) -> CatalogRevisionRecord:
    return CatalogRevisionRecord(
        item_id=row.item_id,  # type: ignore[attr-defined] - Tortoise adds the FK id attribute
        revision=row.revision,
        spec_version=row.spec_version,
        content=row.content,
        note=row.note,
        published_by_email=row.published_by_email,
        published_at=row.published_at,
    )


def _item_record(
    row: CatalogItem, latest_revision: int | None, published: CatalogRevisionRecord | None
) -> CatalogItemRecord:
    return CatalogItemRecord(
        id=row.id,
        kind=CatalogKind(row.kind),
        slug=row.slug,
        status=CatalogStatus(row.status),
        featured=row.featured,
        sort_order=row.sort_order,
        draft=row.draft,
        draft_spec_version=row.draft_spec_version,
        published_revision=row.published_revision,
        lock_version=row.lock_version,
        created_by_email=row.created_by_email,
        updated_by_email=row.updated_by_email,
        created_at=row.created_at,
        updated_at=row.updated_at,
        latest_revision=latest_revision,
        published=published,
    )


async def _published_revisions(rows: list[CatalogItem]) -> dict[UUID, CatalogRevisionRecord]:
    pairs = [Q(item_id=row.id, revision=row.published_revision) for row in rows if row.published_revision is not None]
    if not pairs:
        return {}
    revisions = await CatalogItemRevision.filter(Q(*pairs, join_type="OR"))
    return {record.item_id: record for record in map(_revision_record, revisions)}


async def _records(rows: list[CatalogItem]) -> list[CatalogItemRecord]:
    if not rows:
        return []
    latest_rows = (
        await CatalogItemRevision.filter(item_id__in=[row.id for row in rows])
        .annotate(latest=Max("revision"))
        .group_by("item_id")
        .values("item_id", "latest")
    )
    latest = {entry["item_id"]: entry["latest"] for entry in latest_rows}
    published = await _published_revisions(rows)
    return [_item_record(row, latest.get(row.id), published.get(row.id)) for row in rows]


async def _locked(item_id: UUID) -> CatalogItem:
    """Lock the row for the rest of the current transaction."""
    row = await CatalogItem.filter(id=item_id).select_for_update().first()
    if row is None:
        raise CatalogNotFoundError("Catalog item not found.")
    return row


async def _latest_revision(item_id: UUID) -> int | None:
    latest = await CatalogItemRevision.filter(item_id=item_id).order_by("-revision").first()
    return latest.revision if latest is not None else None


Change = Callable[[CatalogItem, int | None], Awaitable[None]]


class CatalogStore:
    """Database-backed store. Route tests substitute an in-memory equivalent."""

    async def list_items(self, *, kind: CatalogKind | None, include_archived: bool) -> list[CatalogItemRecord]:
        query = CatalogItem.all()
        if kind is not None:
            query = query.filter(kind=kind.value)
        if not include_archived:
            query = query.exclude(status=CatalogStatus.ARCHIVED.value)
        return await _records(await query.order_by("kind", "-featured", "sort_order", "slug"))

    async def get_item(self, item_id: UUID) -> CatalogItemRecord:
        row = await CatalogItem.get_or_none(id=item_id)
        if row is None:
            raise CatalogNotFoundError("Catalog item not found.")
        return (await _records([row]))[0]

    async def create_item(
        self,
        *,
        kind: CatalogKind,
        slug: str,
        draft: dict[str, Any],
        featured: bool,
        sort_order: int,
        actor_email: str,
        audit: AuditHook,
    ) -> CatalogItemRecord:
        try:
            async with in_transaction():
                row = await CatalogItem.create(
                    kind=kind.value,
                    slug=slug,
                    draft=draft,
                    draft_spec_version=spec_version(kind),
                    featured=featured,
                    sort_order=sort_order,
                    created_by_email=actor_email,
                    updated_by_email=actor_email,
                )
                record = _item_record(row, None, None)
                await audit(record)
        except IntegrityError:
            raise CatalogConflictError("Another item of this kind already uses this slug.") from None
        return record

    async def _write(
        self, item_id: UUID, lock_version: int, actor_email: str, audit: AuditHook, change: Change
    ) -> CatalogItemRecord:
        try:
            async with in_transaction():
                row = await _locked(item_id)
                ensure_lock(row.lock_version, lock_version)
                await change(row, await _latest_revision(row.id))
                row.lock_version += 1
                row.updated_by_email = actor_email
                await row.save()
                record = (await _records([row]))[0]
                await audit(record)
        except IntegrityError:
            raise CatalogConflictError("Another item of this kind already uses this slug.") from None
        return record

    async def update_item(
        self, item_id: UUID, *, lock_version: int, changes: ItemChanges, actor_email: str, audit: AuditHook
    ) -> CatalogItemRecord:
        async def change(row: CatalogItem, latest_revision: int | None) -> None:
            ensure_editable(CatalogStatus(row.status))
            if changes.slug is not None and changes.slug != row.slug:
                ensure_slug_change_allowed(latest_revision)
                row.slug = changes.slug
            if changes.draft is not None:
                row.draft = changes.draft
                row.draft_spec_version = spec_version(CatalogKind(row.kind))
            if changes.featured is not None:
                row.featured = changes.featured
            if changes.sort_order is not None:
                row.sort_order = changes.sort_order

        return await self._write(item_id, lock_version, actor_email, audit, change)

    async def publish(
        self, item_id: UUID, *, lock_version: int, note: str | None, actor_email: str, audit: AuditHook
    ) -> CatalogItemRecord:
        async def change(row: CatalogItem, latest_revision: int | None) -> None:
            ensure_editable(CatalogStatus(row.status))
            content, version = publication(CatalogKind(row.kind), row.draft)
            revision = (latest_revision or 0) + 1
            await CatalogItemRevision.create(
                item_id=row.id,
                revision=revision,
                spec_version=version,
                content=content,
                note=note,
                published_by_email=actor_email,
            )
            row.draft = content
            row.draft_spec_version = version
            row.status = CatalogStatus.PUBLISHED.value
            row.published_revision = revision

        return await self._write(item_id, lock_version, actor_email, audit, change)

    async def change_status(
        self, item_id: UUID, *, lock_version: int, action: StatusAction, actor_email: str, audit: AuditHook
    ) -> CatalogItemRecord:
        async def change(row: CatalogItem, _latest_revision: int | None) -> None:
            status = next_status(CatalogStatus(row.status), action)
            row.status = status.value
            if status is not CatalogStatus.PUBLISHED:
                row.published_revision = None

        return await self._write(item_id, lock_version, actor_email, audit, change)

    async def restore_revision(
        self, item_id: UUID, revision: int, *, lock_version: int, actor_email: str, audit: AuditHook
    ) -> CatalogItemRecord:
        async def change(row: CatalogItem, _latest_revision: int | None) -> None:
            ensure_editable(CatalogStatus(row.status))
            stored = await CatalogItemRevision.get_or_none(item_id=row.id, revision=revision)
            if stored is None:
                raise CatalogNotFoundError("Revision not found.")
            row.draft = stored.content
            row.draft_spec_version = stored.spec_version

        return await self._write(item_id, lock_version, actor_email, audit, change)

    async def delete_item(self, item_id: UUID, *, lock_version: int, audit: AuditHook) -> None:
        async with in_transaction():
            row = await _locked(item_id)
            ensure_lock(row.lock_version, lock_version)
            latest_revision = await _latest_revision(row.id)
            ensure_deletable(latest_revision)
            await audit(_item_record(row, latest_revision, None))
            await row.delete()

    async def list_revisions(self, item_id: UUID) -> list[CatalogRevisionRecord]:
        if not await CatalogItem.exists(id=item_id):
            raise CatalogNotFoundError("Catalog item not found.")
        rows = await CatalogItemRevision.filter(item_id=item_id).order_by("-revision")
        return [_revision_record(row) for row in rows]

    async def get_revision(self, item_id: UUID, revision: int) -> CatalogRevisionRecord:
        row = await CatalogItemRevision.get_or_none(item_id=item_id, revision=revision)
        if row is None:
            raise CatalogNotFoundError("Revision not found.")
        return _revision_record(row)

    async def published(self, kinds: dict[CatalogKind, int]) -> list[CatalogItemRecord]:
        """Published items whose kind and spec version the client asked for."""
        if not kinds:
            return []
        rows = await CatalogItem.filter(
            status=CatalogStatus.PUBLISHED.value, kind__in=[kind.value for kind in kinds]
        ).order_by("-featured", "sort_order", "slug")
        records = await _records(rows)
        matching = [
            record
            for record in records
            if record.published is not None and record.published.spec_version == kinds[record.kind]
        ]
        return matching[:MAX_PUBLISHED_ITEMS]


def get_catalog_store() -> CatalogStore:
    return CatalogStore()
