"""Admin API for the organization catalog: drafts, publishing, status, and history.

Viewers read everything; admins edit and publish. Drafts may be incomplete, so saving
only checks the document's outline and reports errors and warnings back. Publishing
requires a draft without errors. Warnings (unpinned packages, literal credentials, ...)
are guidance for the dashboard and never block anything.

Every write records one audit event in the same transaction as the change.
"""

from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Response
from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from app.core.admin_dashboard import ADMIN_API_PREFIX
from app.services.admin.audit import AdminAuditLog, AdminPrincipal
from app.services.admin.guards import (
    AdminRoute,
    AnyAdmin,
    FullAdmin,
    admin_error,
    get_admin_audit_log,
    require_admin_api,
)
from app.services.catalog.specs import (
    SLUG_PATTERN,
    CatalogIssue,
    CatalogKind,
    CatalogStatus,
    DraftCheck,
    InstallTier,
    check_draft,
)
from app.services.catalog.store import (
    AuditHook,
    CatalogError,
    CatalogItemRecord,
    CatalogRevisionRecord,
    CatalogStore,
    ItemChanges,
    StatusAction,
    get_catalog_store,
)

router = APIRouter(
    prefix=f"{ADMIN_API_PREFIX}/catalog",
    tags=["admin-catalog"],
    route_class=AdminRoute,
    dependencies=[Depends(require_admin_api)],
)

Store = Annotated[CatalogStore, Depends(get_catalog_store)]
AuditLog = Annotated[AdminAuditLog, Depends(get_admin_audit_log)]
ItemId = Annotated[UUID, Path()]
RevisionNumber = Annotated[int, Path(ge=1)]


# --- request bodies -----------------------------------------------------------------------


def _named(metadata: dict[str, Any]) -> dict[str, Any]:
    name = metadata.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        raise ValueError("metadata.name must be a non-blank string of at most 80 characters")
    return metadata


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class DraftBody(_Body):
    """Outline only. The full spec is checked on read, on validate, and on publish."""

    metadata: Annotated[dict[str, Any], AfterValidator(_named)]
    spec: dict[str, Any]


Slug = Annotated[str, Field(pattern=SLUG_PATTERN)]
SortOrder = Annotated[int, Field(ge=-10_000, le=10_000)]
LockVersion = Annotated[int, Field(ge=1)]
Kind = Annotated[CatalogKind, Field(strict=False)]


class CreateItemBody(_Body):
    kind: Kind
    slug: Slug
    draft: DraftBody
    featured: bool = False
    sort_order: SortOrder = 0


class UpdateItemBody(_Body):
    lock_version: LockVersion
    draft: DraftBody | None = None
    slug: Slug | None = None
    featured: bool | None = None
    sort_order: SortOrder | None = None


class LockBody(_Body):
    lock_version: LockVersion


class PublishBody(LockBody):
    note: Annotated[str, Field(max_length=500)] | None = None


class ValidateBody(_Body):
    kind: Kind
    draft: DraftBody


# --- responses ---------------------------------------------------------------------------


class IssueView(BaseModel):
    path: str
    message: str


class ItemSummaryView(BaseModel):
    id: str
    kind: CatalogKind
    slug: str
    status: CatalogStatus
    featured: bool
    sort_order: int
    name: str
    summary: str
    tier: InstallTier | None
    error_count: int
    warning_count: int
    published_revision: int | None
    latest_revision: int | None
    has_unpublished_changes: bool
    lock_version: int
    updated_at: datetime
    updated_by_email: str
    published_at: datetime | None
    published_by_email: str | None


class ItemView(ItemSummaryView):
    created_at: datetime
    created_by_email: str
    draft: dict[str, Any]
    draft_spec_version: int
    published: dict[str, Any] | None
    errors: list[IssueView]
    warnings: list[IssueView]


class ItemListView(BaseModel):
    items: list[ItemSummaryView]


class RevisionSummaryView(BaseModel):
    revision: int
    spec_version: int
    note: str | None
    published_by_email: str
    published_at: datetime
    current: bool


class RevisionView(RevisionSummaryView):
    content: dict[str, Any]


class RevisionListView(BaseModel):
    revisions: list[RevisionSummaryView]


class ValidationView(BaseModel):
    valid: bool
    tier: InstallTier | None
    errors: list[IssueView]
    warnings: list[IssueView]


def _issues(issues: tuple[CatalogIssue, ...]) -> list[IssueView]:
    return [IssueView(path=issue.path, message=issue.message) for issue in issues]


def _summary_fields(record: CatalogItemRecord, check: DraftCheck) -> dict[str, Any]:
    metadata = record.draft.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    name, summary = metadata.get("name"), metadata.get("summary")
    published = record.published
    return {
        "id": str(record.id),
        "kind": record.kind,
        "slug": record.slug,
        "status": record.status,
        "featured": record.featured,
        "sort_order": record.sort_order,
        "name": name if isinstance(name, str) else record.slug,
        "summary": summary if isinstance(summary, str) else "",
        "tier": check.tier,
        "error_count": len(check.errors),
        "warning_count": len(check.warnings),
        "published_revision": record.published_revision,
        "latest_revision": record.latest_revision,
        "has_unpublished_changes": published is not None and check.normalized != published.content,
        "lock_version": record.lock_version,
        "updated_at": record.updated_at,
        "updated_by_email": record.updated_by_email,
        "published_at": published.published_at if published else None,
        "published_by_email": published.published_by_email if published else None,
    }


def summary_view(record: CatalogItemRecord) -> ItemSummaryView:
    return ItemSummaryView(**_summary_fields(record, check_draft(record.kind, record.draft)))


def item_view(record: CatalogItemRecord) -> ItemView:
    check = check_draft(record.kind, record.draft)
    return ItemView(
        **_summary_fields(record, check),
        created_at=record.created_at,
        created_by_email=record.created_by_email,
        draft=record.draft,
        draft_spec_version=record.draft_spec_version,
        published=record.published.content if record.published else None,
        errors=_issues(check.errors),
        warnings=_issues(check.warnings),
    )


def revision_summary(record: CatalogRevisionRecord, current: int | None) -> RevisionSummaryView:
    return RevisionSummaryView(
        revision=record.revision,
        spec_version=record.spec_version,
        note=record.note,
        published_by_email=record.published_by_email,
        published_at=record.published_at,
        current=record.revision == current,
    )


# --- helpers ------------------------------------------------------------------------------


async def _run[T](operation: Awaitable[T]) -> T:
    """Report store failures as user-safe admin errors."""
    try:
        return await operation
    except CatalogError as error:
        raise admin_error(error.status_code, error.message) from None


def _audit(audit: AdminAuditLog, principal: AdminPrincipal, action: str, **details: int) -> AuditHook:
    async def record(item: CatalogItemRecord) -> None:
        extra = dict(details)
        if action == "catalog.item_published" and item.published_revision is not None:
            extra["revision"] = item.published_revision
        await audit.record(
            principal.identity,
            principal.role,
            action,
            target_type="catalog_item",
            target_id=str(item.id),
            details={"kind": item.kind.value, "slug": item.slug, **extra},
        )

    return record


# --- routes -------------------------------------------------------------------------------


@router.get("/items", response_model=ItemListView)
async def list_items(
    _: AnyAdmin,
    store: Store,
    kind: Annotated[CatalogKind | None, Query()] = None,
    include_archived: Annotated[bool, Query()] = False,
) -> ItemListView:
    records = await store.list_items(kind=kind, include_archived=include_archived)
    return ItemListView(items=[summary_view(record) for record in records])


@router.post("/items", response_model=ItemView, status_code=201)
async def create_item(body: CreateItemBody, principal: FullAdmin, store: Store, audit: AuditLog) -> ItemView:
    record = await _run(
        store.create_item(
            kind=body.kind,
            slug=body.slug,
            draft=body.draft.model_dump(),
            featured=body.featured,
            sort_order=body.sort_order,
            actor_email=principal.identity.email,
            audit=_audit(audit, principal, "catalog.item_created"),
        )
    )
    return item_view(record)


@router.get("/items/{item_id}", response_model=ItemView)
async def get_item(item_id: ItemId, _: AnyAdmin, store: Store) -> ItemView:
    return item_view(await _run(store.get_item(item_id)))


@router.patch("/items/{item_id}", response_model=ItemView)
async def update_item(
    item_id: ItemId, body: UpdateItemBody, principal: FullAdmin, store: Store, audit: AuditLog
) -> ItemView:
    changes = ItemChanges(
        draft=body.draft.model_dump() if body.draft is not None else None,
        slug=body.slug,
        featured=body.featured,
        sort_order=body.sort_order,
    )
    record = await _run(
        store.update_item(
            item_id,
            lock_version=body.lock_version,
            changes=changes,
            actor_email=principal.identity.email,
            audit=_audit(audit, principal, "catalog.item_updated"),
        )
    )
    return item_view(record)


@router.delete("/items/{item_id}", status_code=204)
async def delete_item(item_id: ItemId, body: LockBody, principal: FullAdmin, store: Store, audit: AuditLog) -> Response:
    """Only for items that were never published; published items are archived instead."""
    await _run(
        store.delete_item(
            item_id, lock_version=body.lock_version, audit=_audit(audit, principal, "catalog.item_deleted")
        )
    )
    return Response(status_code=204)


@router.post("/items/{item_id}/publish", response_model=ItemView)
async def publish_item(
    item_id: ItemId, body: PublishBody, principal: FullAdmin, store: Store, audit: AuditLog
) -> ItemView:
    record = await _run(
        store.publish(
            item_id,
            lock_version=body.lock_version,
            note=body.note,
            actor_email=principal.identity.email,
            audit=_audit(audit, principal, "catalog.item_published"),
        )
    )
    return item_view(record)


_STATUS_AUDIT_ACTIONS: dict[StatusAction, str] = {
    "unpublish": "catalog.item_unpublished",
    "archive": "catalog.item_archived",
    "unarchive": "catalog.item_unarchived",
}


async def _change_status(
    item_id: UUID,
    body: LockBody,
    principal: AdminPrincipal,
    store: CatalogStore,
    audit: AdminAuditLog,
    action: StatusAction,
) -> ItemView:
    record = await _run(
        store.change_status(
            item_id,
            lock_version=body.lock_version,
            action=action,
            actor_email=principal.identity.email,
            audit=_audit(audit, principal, _STATUS_AUDIT_ACTIONS[action]),
        )
    )
    return item_view(record)


@router.post("/items/{item_id}/unpublish", response_model=ItemView)
async def unpublish_item(
    item_id: ItemId, body: LockBody, principal: FullAdmin, store: Store, audit: AuditLog
) -> ItemView:
    """Hide from clients. Installed copies stay on users' machines; revisions are kept."""
    return await _change_status(item_id, body, principal, store, audit, "unpublish")


@router.post("/items/{item_id}/archive", response_model=ItemView)
async def archive_item(
    item_id: ItemId, body: LockBody, principal: FullAdmin, store: Store, audit: AuditLog
) -> ItemView:
    return await _change_status(item_id, body, principal, store, audit, "archive")


@router.post("/items/{item_id}/unarchive", response_model=ItemView)
async def unarchive_item(
    item_id: ItemId, body: LockBody, principal: FullAdmin, store: Store, audit: AuditLog
) -> ItemView:
    return await _change_status(item_id, body, principal, store, audit, "unarchive")


@router.get("/items/{item_id}/revisions", response_model=RevisionListView)
async def list_revisions(item_id: ItemId, _: AnyAdmin, store: Store) -> RevisionListView:
    item = await _run(store.get_item(item_id))
    revisions = await _run(store.list_revisions(item_id))
    return RevisionListView(revisions=[revision_summary(record, item.published_revision) for record in revisions])


@router.get("/items/{item_id}/revisions/{revision}", response_model=RevisionView)
async def get_revision(item_id: ItemId, revision: RevisionNumber, _: AnyAdmin, store: Store) -> RevisionView:
    item = await _run(store.get_item(item_id))
    record = await _run(store.get_revision(item_id, revision))
    summary = revision_summary(record, item.published_revision)
    return RevisionView(**summary.model_dump(), content=record.content)


@router.post("/items/{item_id}/revisions/{revision}/restore", response_model=ItemView)
async def restore_revision(
    item_id: ItemId, revision: RevisionNumber, body: LockBody, principal: FullAdmin, store: Store, audit: AuditLog
) -> ItemView:
    """Copy an old revision into the draft. Publish it to make it current again."""
    record = await _run(
        store.restore_revision(
            item_id,
            revision,
            lock_version=body.lock_version,
            actor_email=principal.identity.email,
            audit=_audit(audit, principal, "catalog.revision_restored", revision=revision),
        )
    )
    return item_view(record)


@router.post("/validate", response_model=ValidationView)
async def validate_draft(body: ValidateBody, _: FullAdmin) -> ValidationView:
    """Errors block publishing; warnings are guidance only."""
    check = check_draft(body.kind, body.draft.model_dump())
    return ValidationView(
        valid=check.normalized is not None,
        tier=check.tier,
        errors=_issues(check.errors),
        warnings=_issues(check.warnings),
    )
