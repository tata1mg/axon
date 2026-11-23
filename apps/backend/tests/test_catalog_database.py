"""Opt-in disposable Postgres: the catalog migration, its Tortoise models, and the real store agree."""

import asyncio
import copy
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import asyncpg
import pytest
from tortoise import Tortoise

from app.core.admin_dashboard import AdminRole
from app.models.admin import AdminAuditEvent
from app.models.catalog import CatalogItem, CatalogItemRevision
from app.services.admin.audit import AdminAuditLog, AdminIdentity
from app.services.catalog.specs import CatalogKind, CatalogStatus
from app.services.catalog.store import (
    CatalogConflictError,
    CatalogInvalidError,
    CatalogItemRecord,
    CatalogNotFoundError,
    CatalogStore,
    ItemChanges,
)
from tests.test_catalog_specs import ATLASSIAN, LAST9, REDASH, SKILL
from tests.test_session_database import disposable_db  # noqa: F401 - pytest fixture

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db/migrations"
CATALOG_MIGRATION = MIGRATIONS / "20261117160000_create_catalog.sql"
AUDIT_MIGRATION = MIGRATIONS / "20261117120000_create_admin_audit_events.sql"
UP, DOWN = CATALOG_MIGRATION.read_text().split("-- migrate:down")
ACTOR = "root@example.com"
ITEMS = '"META_HARNESS_catalog_items"'
REVISIONS = '"META_HARNESS_catalog_item_revisions"'


def test_migration_uses_dbmate_sections_and_drops_in_reverse_order() -> None:
    assert UP.startswith("-- migrate:up\n")
    assert f"CREATE TABLE {ITEMS}" in UP
    assert f"CREATE TABLE {REVISIONS}" in UP
    assert DOWN.index(REVISIONS) < DOWN.index(ITEMS)
    assert "schema_migrations" not in UP + DOWN
    names = re.findall(r'"(META_HARNESS_[^"]+)"', UP)
    assert all(len(name) <= 63 for name in names)


async def _no_audit(_record: CatalogItemRecord) -> None:
    return None


@asynccontextmanager
async def catalog_database(dsn: str) -> AsyncIterator[asyncpg.Connection]:
    """Apply the audit and catalog migrations, start Tortoise, and roll both back afterwards."""
    audit_up, audit_down = AUDIT_MIGRATION.read_text().split("-- migrate:down")
    db = await asyncpg.connect(dsn)
    try:
        await db.execute(audit_up)
        await db.execute(UP)
        await Tortoise.init(db_url=dsn.replace("postgresql://", "asyncpg://"), modules={"models": ["app.models"]})
        try:
            yield db
        finally:
            await Tortoise.close_connections()
        await db.execute(DOWN)
        await db.execute(audit_down)
        assert await db.fetchval(f"SELECT to_regclass('public.{ITEMS}')") is None
    finally:
        await db.close()


def run(dsn: str, check: Callable[[asyncpg.Connection], Awaitable[None]]) -> None:
    async def main() -> None:
        async with catalog_database(dsn) as db:
            await check(db)

    asyncio.run(main())


def test_store_round_trip(disposable_db: str) -> None:  # noqa: F811
    async def check(_db: asyncpg.Connection) -> None:
        store = CatalogStore()
        redash = await store.create_item(
            kind=CatalogKind.MCP,
            slug="redash",
            draft=REDASH,
            featured=False,
            sort_order=2,
            actor_email=ACTOR,
            audit=_no_audit,
        )
        assert (redash.status, redash.lock_version, redash.latest_revision) == (CatalogStatus.DRAFT, 1, None)
        assert redash.created_at.tzinfo is not None

        first = await store.publish(redash.id, lock_version=1, note="Initial", actor_email=ACTOR, audit=_no_audit)
        assert (first.status, first.published_revision, first.latest_revision, first.lock_version) == (
            CatalogStatus.PUBLISHED,
            1,
            1,
            2,
        )
        assert first.published is not None
        assert first.published.content == first.draft
        assert first.published.note == "Initial"

        pinned = copy.deepcopy(REDASH)
        pinned["spec"]["server"]["args"] = ["-y", "@suthio/redash-mcp@1.0.4"]
        edited = await store.update_item(
            redash.id,
            lock_version=2,
            changes=ItemChanges(draft=pinned, featured=True),
            actor_email="other@example.com",
            audit=_no_audit,
        )
        assert (edited.featured, edited.updated_by_email, edited.published_revision) == (
            True,
            "other@example.com",
            1,
        )
        assert edited.updated_at > first.updated_at
        second = await store.publish(redash.id, lock_version=3, note=None, actor_email=ACTOR, audit=_no_audit)
        assert (second.published_revision, second.latest_revision) == (2, 2)

        revisions = await store.list_revisions(redash.id)
        assert [revision.revision for revision in revisions] == [2, 1]
        restored = await store.restore_revision(redash.id, 1, lock_version=4, actor_email=ACTOR, audit=_no_audit)
        assert restored.draft == revisions[1].content
        assert restored.published_revision == 2

        last9 = await store.create_item(
            kind=CatalogKind.MCP,
            slug="last9",
            draft=LAST9,
            featured=False,
            sort_order=1,
            actor_email=ACTOR,
            audit=_no_audit,
        )
        await store.publish(last9.id, lock_version=1, note=None, actor_email=ACTOR, audit=_no_audit)
        draft_only = await store.create_item(
            kind=CatalogKind.MCP,
            slug="atlassian",
            draft=ATLASSIAN,
            featured=False,
            sort_order=0,
            actor_email=ACTOR,
            audit=_no_audit,
        )
        skill = await store.create_item(
            kind=CatalogKind.SKILL,
            slug="release-notes",
            draft=SKILL,
            featured=False,
            sort_order=0,
            actor_email=ACTOR,
            audit=_no_audit,
        )
        await store.publish(skill.id, lock_version=1, note=None, actor_email=ACTOR, audit=_no_audit)

        listed = await store.list_items(kind=None, include_archived=False)
        assert [(item.kind, item.slug) for item in listed] == [
            (CatalogKind.MCP, "redash"),
            (CatalogKind.MCP, "atlassian"),
            (CatalogKind.MCP, "last9"),
            (CatalogKind.SKILL, "release-notes"),
        ]
        assert listed[0].published is not None and listed[0].published.revision == 2
        assert listed[1].published is None and listed[1].latest_revision is None

        published = await store.published({CatalogKind.MCP: 1})
        assert [(item.slug, item.published.revision) for item in published if item.published] == [
            ("redash", 2),
            ("last9", 1),
        ]
        # Featured Redash first, then by sort order across kinds; the Atlassian draft is not published.
        both = await store.published({CatalogKind.SKILL: 0, CatalogKind.MCP: 1})
        assert [item.slug for item in both] == ["redash", "release-notes", "last9"]
        assert await store.published({CatalogKind.MCP: 2}) == []

        await store.delete_item(draft_only.id, lock_version=1, audit=_no_audit)
        with pytest.raises(CatalogNotFoundError):
            await store.get_item(draft_only.id)
        with pytest.raises(CatalogConflictError, match="Archive this item instead"):
            await store.delete_item(redash.id, lock_version=5, audit=_no_audit)

        archived = await store.change_status(
            redash.id, lock_version=5, action="archive", actor_email=ACTOR, audit=_no_audit
        )
        assert (archived.status, archived.published_revision, archived.latest_revision) == (
            CatalogStatus.ARCHIVED,
            None,
            2,
        )
        assert [item.slug for item in await store.list_items(kind=CatalogKind.MCP, include_archived=False)] == ["last9"]
        assert await store.get_revision(redash.id, 2)
        with pytest.raises(CatalogNotFoundError):
            await store.get_revision(redash.id, 3)

    run(disposable_db, check)


def test_store_refuses_conflicts_and_invalid_drafts(disposable_db: str) -> None:  # noqa: F811
    async def check(_db: asyncpg.Connection) -> None:
        store = CatalogStore()
        item = await store.create_item(
            kind=CatalogKind.MCP,
            slug="last9",
            draft=LAST9,
            featured=False,
            sort_order=0,
            actor_email=ACTOR,
            audit=_no_audit,
        )
        with pytest.raises(CatalogConflictError, match="already uses this slug"):
            await store.create_item(
                kind=CatalogKind.MCP,
                slug="last9",
                draft=ATLASSIAN,
                featured=False,
                sort_order=0,
                actor_email=ACTOR,
                audit=_no_audit,
            )
        other = await store.create_item(
            kind=CatalogKind.MCP,
            slug="atlassian",
            draft=ATLASSIAN,
            featured=False,
            sort_order=0,
            actor_email=ACTOR,
            audit=_no_audit,
        )
        with pytest.raises(CatalogConflictError, match="already uses this slug"):
            await store.update_item(
                other.id, lock_version=1, changes=ItemChanges(slug="last9"), actor_email=ACTOR, audit=_no_audit
            )
        with pytest.raises(CatalogConflictError, match="changed since you loaded it"):
            await store.update_item(
                item.id, lock_version=7, changes=ItemChanges(featured=True), actor_email=ACTOR, audit=_no_audit
            )
        with pytest.raises(CatalogNotFoundError):
            await store.publish(uuid4(), lock_version=1, note=None, actor_email=ACTOR, audit=_no_audit)

        broken = copy.deepcopy(LAST9)
        broken["spec"]["server"]["command"] = "npx"
        await store.update_item(
            item.id, lock_version=1, changes=ItemChanges(draft=broken), actor_email=ACTOR, audit=_no_audit
        )
        with pytest.raises(CatalogInvalidError, match="Fix 1 error"):
            await store.publish(item.id, lock_version=2, note=None, actor_email=ACTOR, audit=_no_audit)
        assert await CatalogItemRevision.filter(item_id=item.id).count() == 0
        assert (await store.get_item(item.id)).lock_version == 2

    run(disposable_db, check)


def test_audit_runs_in_the_same_transaction(disposable_db: str) -> None:  # noqa: F811
    async def check(_db: asyncpg.Connection) -> None:
        store = CatalogStore()
        log = AdminAuditLog()
        identity = AdminIdentity(user_id=7, email=ACTOR)

        async def audited(record: CatalogItemRecord) -> None:
            await log.record(
                identity,
                AdminRole.ADMIN,
                "catalog.item_published",
                target_id=str(record.id),
                target_type="catalog_item",
            )

        async def audited_then_fail(record: CatalogItemRecord) -> None:
            await audited(record)
            raise RuntimeError("synthetic audit failure")

        with pytest.raises(RuntimeError):
            await store.create_item(
                kind=CatalogKind.MCP,
                slug="last9",
                draft=LAST9,
                featured=False,
                sort_order=0,
                actor_email=ACTOR,
                audit=audited_then_fail,
            )
        assert await CatalogItem.all().count() == 0
        assert await AdminAuditEvent.all().count() == 0

        item = await store.create_item(
            kind=CatalogKind.MCP,
            slug="last9",
            draft=LAST9,
            featured=False,
            sort_order=0,
            actor_email=ACTOR,
            audit=audited,
        )
        with pytest.raises(RuntimeError):
            await store.publish(item.id, lock_version=1, note=None, actor_email=ACTOR, audit=audited_then_fail)
        current = await store.get_item(item.id)
        assert (current.status, current.lock_version, current.latest_revision) == (CatalogStatus.DRAFT, 1, None)
        assert await AdminAuditEvent.all().count() == 1

    run(disposable_db, check)


def test_concurrent_writes_from_the_same_version_conflict(disposable_db: str) -> None:  # noqa: F811
    async def check(_db: asyncpg.Connection) -> None:
        store = CatalogStore()
        item = await store.create_item(
            kind=CatalogKind.MCP,
            slug="last9",
            draft=LAST9,
            featured=False,
            sort_order=0,
            actor_email=ACTOR,
            audit=_no_audit,
        )
        results = await asyncio.gather(
            *[store.publish(item.id, lock_version=1, note=None, actor_email=ACTOR, audit=_no_audit) for _ in range(3)],
            return_exceptions=True,
        )
        published = [result for result in results if isinstance(result, CatalogItemRecord)]
        conflicts = [result for result in results if isinstance(result, CatalogConflictError)]
        assert (len(published), len(conflicts)) == (1, 2)
        assert await CatalogItemRevision.filter(item_id=item.id).count() == 1

    run(disposable_db, check)


@pytest.mark.parametrize(
    ("columns", "values", "constraint"),
    [
        ("kind, slug", "'agent', 'x1'", "kind"),
        ("kind, slug", "'mcp', 'Bad Slug'", "slug"),
        ("kind, slug, status", "'mcp', 'x1', 'live'", "status"),
        ("kind, slug, status", "'mcp', 'x1', 'published'", "published"),
        ("kind, slug, published_revision", "'mcp', 'x1', 1", "published"),
        ("kind, slug, lock_version", "'mcp', 'x1', 0", "versions"),
    ],
)
def test_item_constraints(disposable_db: str, columns: str, values: str, constraint: str) -> None:  # noqa: F811
    async def check(db: asyncpg.Connection) -> None:
        with pytest.raises(asyncpg.CheckViolationError, match=f"META_HARNESS_catalog_items_{constraint}"):
            await db.execute(
                f"INSERT INTO {ITEMS} (id, {columns}, draft, draft_spec_version, created_by_email, updated_by_email) "
                f"VALUES (gen_random_uuid(), {values}, '{{}}'::jsonb, 1, 'a@example.com', 'a@example.com')"
            )

    run(disposable_db, check)


def test_revisions_reference_items_and_block_their_deletion(disposable_db: str) -> None:  # noqa: F811
    async def check(db: asyncpg.Connection) -> None:
        item_id = await db.fetchval(
            f"INSERT INTO {ITEMS} (id, kind, slug, draft, draft_spec_version, created_by_email, updated_by_email) "
            "VALUES (gen_random_uuid(), 'mcp', 'x1', '{}'::jsonb, 1, 'a@example.com', 'a@example.com') RETURNING id"
        )
        insert = (
            f"INSERT INTO {REVISIONS} (item_id, revision, spec_version, content, published_by_email) "
            "VALUES ($1, $2, 1, $3::jsonb, 'a@example.com')"
        )
        await db.execute(insert, item_id, 1, "{}")
        with pytest.raises(asyncpg.UniqueViolationError):
            await db.execute(insert, item_id, 1, "{}")
        with pytest.raises(asyncpg.CheckViolationError):
            await db.execute(insert, item_id, 0, "{}")
        with pytest.raises(asyncpg.CheckViolationError):
            await db.execute(insert, item_id, 2, "[]")
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await db.execute(insert, uuid4(), 1, "{}")
        # ON DELETE RESTRICT: published history can never be dropped with its item.
        with pytest.raises(asyncpg.RestrictViolationError):
            await db.execute(f"DELETE FROM {ITEMS} WHERE id = $1", item_id)
        await db.execute(f"DELETE FROM {REVISIONS}")

    run(disposable_db, check)
