"""Opt-in disposable Postgres: the admin audit migration and its Tortoise model agree."""

import asyncio
from pathlib import Path

import asyncpg
import pytest
from tortoise import Tortoise

from app.core.admin_dashboard import AdminRole
from app.services.admin.audit import AdminAuditLog, AdminIdentity
from tests.test_session_database import disposable_db  # noqa: F401 - pytest fixture

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/20261117120000_create_admin_audit_events.sql"
UP, DOWN = MIGRATION.read_text().split("-- migrate:down")


def test_migration_uses_dbmate_sections_and_rolls_back() -> None:
    assert UP.startswith("-- migrate:up\n")
    assert 'CREATE TABLE "META_HARNESS_admin_audit_events"' in UP
    assert 'DROP TABLE "META_HARNESS_admin_audit_events"' in DOWN


def test_audit_log_round_trips_and_enforces_constraints(disposable_db: str) -> None:  # noqa: F811
    async def check() -> None:
        db = await asyncpg.connect(disposable_db)
        try:
            await db.execute(UP)
        finally:
            await db.close()

        await Tortoise.init(
            db_url=disposable_db.replace("postgresql://", "asyncpg://"), modules={"models": ["app.models"]}
        )
        try:
            log = AdminAuditLog()
            admin = AdminIdentity(user_id=7, email="root@example.com")
            await log.record(admin, AdminRole.ADMIN, "admin.sign_in")
            await log.record(AdminIdentity(user_id=9, email="x@example.com"), None, "admin.sign_in_denied")
            await log.record(
                admin,
                AdminRole.ADMIN,
                "mcp_catalog.update",
                target_type="mcp_server",
                target_id="github",
                details={"revision": 2},
            )

            events = await log.list_events(before_id=None, limit=2)
            assert [event.action for event in events] == ["mcp_catalog.update", "admin.sign_in_denied"]
            assert events[0].details == {"revision": 2}
            assert events[0].target_type == "mcp_server"
            assert events[1].actor_role is None
            assert events[0].created_at.tzinfo is not None
            older = await log.list_events(before_id=events[-1].id, limit=10)
            assert [event.action for event in older] == ["admin.sign_in"]

            connection = Tortoise.get_connection("default")
            for bad in [
                ("'Admin.SignIn'", "NULL", "NULL", "'{}'"),
                ("'admin'", "NULL", "NULL", "'{}'"),
                ("'admin.x'", "'mcp_server'", "NULL", "'{}'"),
                ("'admin.x'", "NULL", "NULL", "'[]'"),
            ]:
                with pytest.raises(Exception, match="violates check constraint"):
                    await connection.execute_query(
                        'INSERT INTO "META_HARNESS_admin_audit_events" '
                        "(actor_user_id, actor_email, action, target_type, target_id, details) "
                        f"VALUES (1, 'a@example.com', {bad[0]}, {bad[1]}, {bad[2]}, {bad[3]}::jsonb)"
                    )
        finally:
            await Tortoise.close_connections()

        db = await asyncpg.connect(disposable_db)
        try:
            await db.execute(DOWN)
            assert await db.fetchval("SELECT to_regclass('public.\"META_HARNESS_admin_audit_events\"')") is None
        finally:
            await db.close()

    asyncio.run(check())


def test_full_migration_chain_applies_and_rolls_back_in_order(disposable_db: str) -> None:  # noqa: F811
    from tests.test_session_database import run_dbmate

    catalog_table = 'public."META_HARNESS_catalog_items"'
    audit_table = 'public."META_HARNESS_admin_audit_events"'
    sessions_table = 'public."META_HARNESS_sessions"'

    async def check() -> None:
        result = await run_dbmate(disposable_db, "migrate")
        assert result.returncode == 0, result.stdout + result.stderr
        db = await asyncpg.connect(disposable_db)

        async def exists(table: str) -> bool:
            return await db.fetchval(f"SELECT to_regclass('{table}')") is not None

        try:
            versions = [row["version"] for row in await db.fetch("SELECT version FROM schema_migrations ORDER BY 1")]
            assert versions == ["20261002140000", "20261117120000", "20261117160000"]
            assert [await exists(table) for table in (catalog_table, audit_table, sessions_table)] == [True] * 3
            # Each rollback removes only the newest migration's tables.
            for expected in ([False, True, True], [False, False, True]):
                result = await run_dbmate(disposable_db, "down")
                assert result.returncode == 0, result.stdout + result.stderr
                assert [await exists(table) for table in (catalog_table, audit_table, sessions_table)] == expected
            result = await run_dbmate(disposable_db, "migrate")
            assert result.returncode == 0, result.stdout + result.stderr
            assert [await exists(table) for table in (catalog_table, audit_table, sessions_table)] == [True] * 3
        finally:
            await db.close()

    asyncio.run(check())
