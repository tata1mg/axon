"""Catalog admin and client routes against an in-memory store that shares the real store's rules."""

import copy
import itertools
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import authentication
from app.core.config import get_settings
from app.routers.admin_catalog import router as admin_catalog_router
from app.routers.catalog import parse_kind_requests
from app.routers.catalog import router as catalog_router
from app.services.admin import guards
from app.services.admin.guards import encode_credential, get_admin_audit_log
from app.services.catalog.specs import CatalogKind, CatalogStatus, spec_version
from app.services.catalog.store import (
    AuditHook,
    CatalogConflictError,
    CatalogItemRecord,
    CatalogNotFoundError,
    CatalogRevisionRecord,
    ItemChanges,
    StatusAction,
    ensure_deletable,
    ensure_editable,
    ensure_lock,
    ensure_slug_change_allowed,
    get_catalog_store,
    next_status,
    publication,
)
from tests.test_admin_dashboard import (
    AUTH_SERVICE,
    CREDENTIAL,
    SESSION_COOKIE,
    SETTINGS,
    VIEWER_EMAIL,
    FakeAudit,
    FakeAuth,
)
from tests.test_catalog_specs import ATLASSIAN, LAST9, REDASH, SKILL

VIEWER_CREDENTIAL = "viewer-credential"
COOKIE_PATH = "/axon/api/v1/admin"
ADMIN = "/api/v1/admin/catalog"
MISSING = "00000000-0000-4000-8000-000000000000"


class MemoryCatalogStore:
    """In-memory stand-in for CatalogStore. Writes become visible only after the audit hook succeeds."""

    def __init__(self) -> None:
        self.items: dict[UUID, CatalogItemRecord] = {}
        self.revisions: dict[UUID, list[CatalogRevisionRecord]] = {}
        self._clock = itertools.count(1)

    def _now(self) -> datetime:
        return datetime(2026, 11, 17, tzinfo=UTC) + timedelta(seconds=next(self._clock))

    def _get(self, item_id: UUID) -> CatalogItemRecord:
        if item_id not in self.items:
            raise CatalogNotFoundError("Catalog item not found.")
        return self.items[item_id]

    def _complete(self, record: CatalogItemRecord, revisions: list[CatalogRevisionRecord]) -> CatalogItemRecord:
        published = next((rev for rev in revisions if rev.revision == record.published_revision), None)
        return replace(record, latest_revision=revisions[-1].revision if revisions else None, published=published)

    def _ensure_unique(self, kind: CatalogKind, slug: str, item_id: UUID | None) -> None:
        if any(item.kind is kind and item.slug == slug and item.id != item_id for item in self.items.values()):
            raise CatalogConflictError("Another item of this kind already uses this slug.")

    async def _commit(
        self, record: CatalogItemRecord, audit: AuditHook, revisions: list[CatalogRevisionRecord] | None = None
    ) -> CatalogItemRecord:
        revisions = revisions if revisions is not None else self.revisions.get(record.id, [])
        record = self._complete(record, revisions)
        await audit(record)
        self.items[record.id] = record
        self.revisions[record.id] = revisions
        return record

    def _written(self, item: CatalogItemRecord, actor_email: str, **changes: Any) -> CatalogItemRecord:
        return replace(
            item, lock_version=item.lock_version + 1, updated_by_email=actor_email, updated_at=self._now(), **changes
        )

    async def list_items(self, *, kind: CatalogKind | None, include_archived: bool) -> list[CatalogItemRecord]:
        items = [
            item
            for item in self.items.values()
            if (kind is None or item.kind is kind) and (include_archived or item.status is not CatalogStatus.ARCHIVED)
        ]
        return sorted(items, key=lambda item: (item.kind.value, not item.featured, item.sort_order, item.slug))

    async def get_item(self, item_id: UUID) -> CatalogItemRecord:
        return self._get(item_id)

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
        self._ensure_unique(kind, slug, None)
        now = self._now()
        record = CatalogItemRecord(
            id=uuid4(),
            kind=kind,
            slug=slug,
            status=CatalogStatus.DRAFT,
            featured=featured,
            sort_order=sort_order,
            draft=draft,
            draft_spec_version=spec_version(kind),
            published_revision=None,
            lock_version=1,
            created_by_email=actor_email,
            updated_by_email=actor_email,
            created_at=now,
            updated_at=now,
            latest_revision=None,
            published=None,
        )
        return await self._commit(record, audit, [])

    async def update_item(
        self, item_id: UUID, *, lock_version: int, changes: ItemChanges, actor_email: str, audit: AuditHook
    ) -> CatalogItemRecord:
        item = self._get(item_id)
        ensure_lock(item.lock_version, lock_version)
        ensure_editable(item.status)
        updates: dict[str, Any] = {}
        if changes.slug is not None and changes.slug != item.slug:
            ensure_slug_change_allowed(item.latest_revision)
            self._ensure_unique(item.kind, changes.slug, item.id)
            updates["slug"] = changes.slug
        if changes.draft is not None:
            updates |= {"draft": changes.draft, "draft_spec_version": spec_version(item.kind)}
        if changes.featured is not None:
            updates["featured"] = changes.featured
        if changes.sort_order is not None:
            updates["sort_order"] = changes.sort_order
        return await self._commit(self._written(item, actor_email, **updates), audit)

    async def publish(
        self, item_id: UUID, *, lock_version: int, note: str | None, actor_email: str, audit: AuditHook
    ) -> CatalogItemRecord:
        item = self._get(item_id)
        ensure_lock(item.lock_version, lock_version)
        ensure_editable(item.status)
        content, version = publication(item.kind, item.draft)
        revision = CatalogRevisionRecord(
            item_id=item.id,
            revision=(item.latest_revision or 0) + 1,
            spec_version=version,
            content=content,
            note=note,
            published_by_email=actor_email,
            published_at=self._now(),
        )
        record = self._written(
            item,
            actor_email,
            draft=content,
            draft_spec_version=version,
            status=CatalogStatus.PUBLISHED,
            published_revision=revision.revision,
        )
        return await self._commit(record, audit, [*self.revisions[item.id], revision])

    async def change_status(
        self, item_id: UUID, *, lock_version: int, action: StatusAction, actor_email: str, audit: AuditHook
    ) -> CatalogItemRecord:
        item = self._get(item_id)
        ensure_lock(item.lock_version, lock_version)
        status = next_status(item.status, action)
        published_revision = item.published_revision if status is CatalogStatus.PUBLISHED else None
        record = self._written(item, actor_email, status=status, published_revision=published_revision)
        return await self._commit(record, audit)

    async def restore_revision(
        self, item_id: UUID, revision: int, *, lock_version: int, actor_email: str, audit: AuditHook
    ) -> CatalogItemRecord:
        item = self._get(item_id)
        ensure_lock(item.lock_version, lock_version)
        ensure_editable(item.status)
        stored = await self.get_revision(item_id, revision)
        record = self._written(item, actor_email, draft=stored.content, draft_spec_version=stored.spec_version)
        return await self._commit(record, audit)

    async def delete_item(self, item_id: UUID, *, lock_version: int, audit: AuditHook) -> None:
        item = self._get(item_id)
        ensure_lock(item.lock_version, lock_version)
        ensure_deletable(item.latest_revision)
        await audit(item)
        del self.items[item_id]
        del self.revisions[item_id]

    async def list_revisions(self, item_id: UUID) -> list[CatalogRevisionRecord]:
        self._get(item_id)
        return list(reversed(self.revisions[item_id]))

    async def get_revision(self, item_id: UUID, revision: int) -> CatalogRevisionRecord:
        for stored in self.revisions.get(item_id, []):
            if stored.revision == revision:
                return stored
        raise CatalogNotFoundError("Revision not found.")

    async def published(self, kinds: dict[CatalogKind, int]) -> list[CatalogItemRecord]:
        items = [
            item
            for item in self.items.values()
            if item.kind in kinds and item.published is not None and item.published.spec_version == kinds[item.kind]
        ]
        return sorted(items, key=lambda item: (not item.featured, item.sort_order, item.slug))


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    auth = FakeAuth()
    auth.identities[VIEWER_CREDENTIAL] = {"user_id": 8, "user_email": VIEWER_EMAIL}
    audit = FakeAudit()
    store = MemoryCatalogStore()
    app = FastAPI()
    app.include_router(admin_catalog_router)
    app.include_router(catalog_router)
    state = SimpleNamespace(settings=SETTINGS)
    app.dependency_overrides[get_settings] = lambda: SimpleNamespace(
        admin_dashboard=state.settings, auth_service=AUTH_SERVICE
    )
    app.dependency_overrides[get_admin_audit_log] = lambda: audit
    app.dependency_overrides[get_catalog_store] = lambda: store
    monkeypatch.setattr(guards, "get_auth_service_client", lambda _request: auth)
    monkeypatch.setattr(authentication, "get_auth_service_client", lambda _request: auth)
    outer = FastAPI()
    outer.mount("/axon", app)
    client = TestClient(outer, base_url="http://testserver/axon", headers={"X-Axon-Admin": "1"})
    return SimpleNamespace(client=client, auth=auth, audit=audit, store=store, state=state)


def as_admin(harness: SimpleNamespace) -> TestClient:
    harness.client.cookies.set(SESSION_COOKIE, encode_credential(CREDENTIAL), path=COOKIE_PATH)
    return harness.client


def as_viewer(harness: SimpleNamespace) -> TestClient:
    harness.client.cookies.set(SESSION_COOKIE, encode_credential(VIEWER_CREDENTIAL), path=COOKIE_PATH)
    return harness.client


def create(client: TestClient, draft: dict[str, Any], slug: str, kind: str = "mcp", **extra: Any) -> dict[str, Any]:
    response = client.post(f"{ADMIN}/items", json={"kind": kind, "slug": slug, "draft": draft, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def publish(client: TestClient, item: dict[str, Any], note: str | None = None) -> dict[str, Any]:
    response = client.post(
        f"{ADMIN}/items/{item['id']}/publish", json={"lock_version": item["lock_version"], "note": note}
    )
    assert response.status_code == 200, response.text
    return response.json()


ROUTES = [
    ("GET", "/items"),
    ("POST", "/items"),
    ("GET", f"/items/{MISSING}"),
    ("PATCH", f"/items/{MISSING}"),
    ("DELETE", f"/items/{MISSING}"),
    ("POST", f"/items/{MISSING}/publish"),
    ("POST", f"/items/{MISSING}/unpublish"),
    ("POST", f"/items/{MISSING}/archive"),
    ("POST", f"/items/{MISSING}/unarchive"),
    ("GET", f"/items/{MISSING}/revisions"),
    ("GET", f"/items/{MISSING}/revisions/1"),
    ("POST", f"/items/{MISSING}/revisions/1/restore"),
    ("POST", "/validate"),
]


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_admin_routes_share_the_dashboard_guards(harness: SimpleNamespace, method: str, path: str) -> None:
    url = f"{ADMIN}{path}"
    assert harness.client.request(method, url, headers={"X-Axon-Admin": "0"}).status_code == 403
    assert harness.client.request(method, url).status_code == 401
    harness.state.settings = replace(SETTINGS, enabled=False)
    response = harness.client.request(method, url)
    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"


def test_viewers_read_and_admins_write(harness: SimpleNamespace) -> None:
    item = create(as_admin(harness), REDASH, "redash")
    viewer = as_viewer(harness)
    assert viewer.get(f"{ADMIN}/items").status_code == 200
    assert viewer.get(f"{ADMIN}/items/{item['id']}").status_code == 200
    assert viewer.get(f"{ADMIN}/items/{item['id']}/revisions").status_code == 200
    denied = [
        viewer.post(f"{ADMIN}/items", json={"kind": "mcp", "slug": "other", "draft": REDASH}),
        viewer.patch(f"{ADMIN}/items/{item['id']}", json={"lock_version": 1, "featured": True}),
        viewer.post(f"{ADMIN}/items/{item['id']}/publish", json={"lock_version": 1}),
        viewer.post(f"{ADMIN}/validate", json={"kind": "mcp", "draft": REDASH}),
    ]
    assert [response.status_code for response in denied] == [403] * 4
    assert harness.audit.actions == ["catalog.item_created"]


def test_drafts_may_be_incomplete_and_report_problems(harness: SimpleNamespace) -> None:
    client = as_admin(harness)
    item = create(client, {"metadata": {"name": "Work in progress"}, "spec": {}}, "wip")
    assert item["status"] == "draft"
    assert item["tier"] is None
    assert item["errors"] == [{"path": "spec", "message": "Add a server template, or setup steps for a manual entry."}]
    assert item["error_count"] == 1
    assert item["created_by_email"] == "Root@Example.com"
    event = harness.audit.events[-1]
    assert (event.action, event.target_type, event.target_id) == ("catalog.item_created", "catalog_item", item["id"])
    assert event.details == {"kind": "mcp", "slug": "wip"}

    refused = client.post(f"{ADMIN}/items/{item['id']}/publish", json={"lock_version": item["lock_version"]})
    assert refused.status_code == 422
    assert refused.json() == {"detail": "Fix 1 error in the draft before publishing."}
    assert harness.store.revisions[UUID(item["id"])] == []
    assert harness.audit.actions == ["catalog.item_created"]


def test_publish_edit_restore_lifecycle(harness: SimpleNamespace) -> None:
    client = as_admin(harness)
    item = create(client, REDASH, "redash")
    assert (item["tier"], item["has_unpublished_changes"], item["published"]) == ("guided", False, None)
    assert [warning["path"] for warning in item["warnings"]] == ["spec.server.args"]

    first = publish(client, item, note="Initial version")
    assert first["status"] == "published"
    assert (first["published_revision"], first["latest_revision"]) == (1, 1)
    assert first["has_unpublished_changes"] is False
    assert first["published"]["spec"]["server"]["exposure"] == "codemode"
    assert first["published_by_email"] == "Root@Example.com"
    assert harness.audit.events[-1].details == {"kind": "mcp", "slug": "redash", "revision": 1}

    stale = client.patch(f"{ADMIN}/items/{item['id']}", json={"lock_version": item["lock_version"], "featured": True})
    assert stale.status_code == 409
    assert "changed since you loaded it" in stale.json()["detail"]

    pinned = copy.deepcopy(REDASH)
    pinned["spec"]["server"]["args"] = ["-y", "@suthio/redash-mcp@1.0.4"]
    edited = client.patch(
        f"{ADMIN}/items/{item['id']}", json={"lock_version": first["lock_version"], "draft": pinned}
    ).json()
    assert edited["has_unpublished_changes"] is True
    assert edited["warnings"] == []
    assert edited["published"]["spec"]["server"]["args"] == ["-y", "@suthio/redash-mcp"]

    second = publish(client, edited)
    assert (second["published_revision"], second["latest_revision"]) == (2, 2)

    revisions = client.get(f"{ADMIN}/items/{item['id']}/revisions").json()["revisions"]
    assert [(rev["revision"], rev["current"], rev["note"]) for rev in revisions] == [
        (2, True, None),
        (1, False, "Initial version"),
    ]
    old = client.get(f"{ADMIN}/items/{item['id']}/revisions/1").json()
    assert old["content"]["spec"]["server"]["args"] == ["-y", "@suthio/redash-mcp"]
    assert client.get(f"{ADMIN}/items/{item['id']}/revisions/9").status_code == 404

    restored = client.post(
        f"{ADMIN}/items/{item['id']}/revisions/1/restore", json={"lock_version": second["lock_version"]}
    ).json()
    assert restored["draft"] == old["content"]
    assert restored["has_unpublished_changes"] is True
    assert restored["published_revision"] == 2
    assert harness.audit.actions == [
        "catalog.item_created",
        "catalog.item_published",
        "catalog.item_updated",
        "catalog.item_published",
        "catalog.revision_restored",
    ]
    assert harness.audit.events[-1].details == {"kind": "mcp", "slug": "redash", "revision": 1}


def test_unpublish_archive_and_unarchive(harness: SimpleNamespace) -> None:
    client = as_admin(harness)
    item = publish(client, create(client, LAST9, "last9"))
    url = f"{ADMIN}/items/{item['id']}"

    unpublished = client.post(f"{url}/unpublish", json={"lock_version": item["lock_version"]}).json()
    assert (unpublished["status"], unpublished["published_revision"], unpublished["latest_revision"]) == (
        "draft",
        None,
        1,
    )
    again = client.post(f"{url}/unpublish", json={"lock_version": unpublished["lock_version"]})
    assert again.status_code == 409

    archived = client.post(f"{url}/archive", json={"lock_version": unpublished["lock_version"]}).json()
    assert archived["status"] == "archived"
    assert client.get(f"{ADMIN}/items").json()["items"] == []
    listed = client.get(f"{ADMIN}/items", params={"include_archived": True}).json()["items"]
    assert [entry["slug"] for entry in listed] == ["last9"]

    for path, body in [
        ("", {"featured": True}),
        ("/publish", {}),
        ("/revisions/1/restore", {}),
    ]:
        method = client.patch if path == "" else client.post
        response = method(f"{url}{path}", json={"lock_version": archived["lock_version"], **body})
        assert response.status_code == 409
        assert response.json()["detail"] == "Unarchive this item before changing it."

    restored = client.post(f"{url}/unarchive", json={"lock_version": archived["lock_version"]}).json()
    assert restored["status"] == "draft"
    assert harness.audit.actions[-3:] == [
        "catalog.item_unpublished",
        "catalog.item_archived",
        "catalog.item_unarchived",
    ]


def test_slugs_are_unique_per_kind_and_fixed_after_publishing(harness: SimpleNamespace) -> None:
    client = as_admin(harness)
    item = create(client, LAST9, "last9")
    duplicate = client.post(f"{ADMIN}/items", json={"kind": "mcp", "slug": "last9", "draft": ATLASSIAN})
    assert duplicate.status_code == 409
    create(client, SKILL, "last9", kind="skill")

    renamed = client.patch(f"{ADMIN}/items/{item['id']}", json={"lock_version": 1, "slug": "last9-prod"}).json()
    assert renamed["slug"] == "last9-prod"
    published = publish(client, renamed)
    refused = client.patch(
        f"{ADMIN}/items/{item['id']}", json={"lock_version": published["lock_version"], "slug": "last9"}
    )
    assert refused.status_code == 409
    assert "cannot change after the first publish" in refused.json()["detail"]
    same = client.patch(
        f"{ADMIN}/items/{item['id']}", json={"lock_version": published["lock_version"], "slug": "last9-prod"}
    )
    assert same.status_code == 200


def test_only_never_published_items_can_be_deleted(harness: SimpleNamespace) -> None:
    client = as_admin(harness)
    draft = create(client, ATLASSIAN, "atlassian")
    assert client.request("DELETE", f"{ADMIN}/items/{draft['id']}", json={"lock_version": 2}).status_code == 409
    deleted = client.request("DELETE", f"{ADMIN}/items/{draft['id']}", json={"lock_version": 1})
    assert deleted.status_code == 204
    assert client.get(f"{ADMIN}/items/{draft['id']}").status_code == 404

    published = publish(client, create(client, LAST9, "last9"))
    archived = client.post(
        f"{ADMIN}/items/{published['id']}/archive", json={"lock_version": published["lock_version"]}
    ).json()
    refused = client.request(
        "DELETE", f"{ADMIN}/items/{published['id']}", json={"lock_version": archived["lock_version"]}
    )
    assert refused.status_code == 409
    assert "Archive this item instead" in refused.json()["detail"]
    assert harness.audit.actions.count("catalog.item_deleted") == 1


def test_list_orders_and_filters_items(harness: SimpleNamespace) -> None:
    client = as_admin(harness)
    create(client, REDASH, "redash", sort_order=2)
    create(client, ATLASSIAN, "atlassian", sort_order=1)
    create(client, LAST9, "last9", featured=True, sort_order=9)
    create(client, SKILL, "release-notes", kind="skill")
    items = client.get(f"{ADMIN}/items").json()["items"]
    assert [item["slug"] for item in items] == ["last9", "atlassian", "redash", "release-notes"]
    assert items[0]["name"] == "Last9"
    assert items[0]["summary"].startswith("Query logs")
    assert "draft" not in items[0]
    skills = client.get(f"{ADMIN}/items", params={"kind": "skill"}).json()["items"]
    assert [(item["slug"], item["tier"]) for item in skills] == [("release-notes", None)]
    assert client.get(f"{ADMIN}/items", params={"kind": "agent"}).status_code == 422


def test_validate_reports_errors_warnings_and_tier(harness: SimpleNamespace) -> None:
    client = as_admin(harness)
    valid = client.post(f"{ADMIN}/validate", json={"kind": "mcp", "draft": REDASH}).json()
    assert (valid["valid"], valid["tier"], valid["errors"]) == (True, "guided", [])
    assert [warning["path"] for warning in valid["warnings"]] == ["spec.server.args"]
    broken = copy.deepcopy(LAST9)
    broken["spec"]["server"]["command"] = "npx"
    invalid = client.post(f"{ADMIN}/validate", json={"kind": "mcp", "draft": broken}).json()
    assert (invalid["valid"], invalid["tier"]) == (False, None)
    assert invalid["errors"][0]["path"] == "spec.server"
    assert harness.audit.actions == []


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "mcp", "slug": "Bad Slug", "draft": REDASH},
        {"kind": "agent", "slug": "agent", "draft": REDASH},
        {"kind": "mcp", "slug": "redash", "draft": {"metadata": {}, "spec": {}}},
        {"kind": "mcp", "slug": "redash", "draft": {"metadata": {"name": "x"}, "spec": {}, "extra": 1}},
        {"kind": "mcp", "slug": "redash", "draft": REDASH, "unknown": True},
        {"kind": "mcp", "slug": "redash", "draft": REDASH, "sort_order": "1"},
    ],
)
def test_malformed_bodies_are_rejected_without_detail(harness: SimpleNamespace, body: dict[str, Any]) -> None:
    response = as_admin(harness).post(f"{ADMIN}/items", json=body)
    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid request"}


def test_unknown_items_and_bad_ids(harness: SimpleNamespace) -> None:
    client = as_admin(harness)
    assert client.get(f"{ADMIN}/items/{MISSING}").status_code == 404
    assert client.get(f"{ADMIN}/items/not-a-uuid").status_code == 422
    assert client.post(f"{ADMIN}/items/{MISSING}/publish", json={"lock_version": 1}).status_code == 404
    assert client.post(f"{ADMIN}/items/{MISSING}/revisions/0/restore", json={"lock_version": 1}).status_code == 422


# --- client catalog --------------------------------------------------------------------


def test_client_catalog_requires_a_cli_session(harness: SimpleNamespace) -> None:
    response = harness.client.get("/api/v1/catalog")
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    assert harness.client.get("/api/v1/catalog", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_client_catalog_returns_published_items_the_client_supports(harness: SimpleNamespace) -> None:
    admin = as_admin(harness)
    publish(admin, create(admin, REDASH, "redash", sort_order=2))
    publish(admin, create(admin, LAST9, "last9", featured=True))
    create(admin, ATLASSIAN, "atlassian")
    publish(admin, create(admin, SKILL, "release-notes", kind="skill"))
    harness.client.cookies.clear()
    bearer = {"Authorization": f"Bearer {CREDENTIAL}"}

    response = harness.client.get("/api/v1/catalog", headers=bearer)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["schemaVersion"] == 1
    assert [(item["slug"], item["tier"], item["revision"]) for item in body["items"]] == [
        ("last9", "one_click", 1),
        ("redash", "guided", 1),
    ]
    redash = body["items"][1]
    assert set(redash) == {
        "kind",
        "slug",
        "revision",
        "specVersion",
        "tier",
        "featured",
        "publishedAt",
        "metadata",
        "spec",
    }
    assert redash["specVersion"] == 1
    assert redash["spec"]["server"]["env"]["REDASH_API_KEY"] == "${input:api_key}"
    assert redash["spec"]["afterInstall"] == REDASH["spec"]["afterInstall"]

    both = harness.client.get("/api/v1/catalog", params={"kinds": "mcp:1,skill:0"}, headers=bearer).json()
    # Featured first, then sort order (the skill's 0 before Redash's 2), then slug.
    assert [item["slug"] for item in both["items"]] == ["last9", "release-notes", "redash"]
    future = harness.client.get("/api/v1/catalog", params={"kinds": "agent:1,mcp:2"}, headers=bearer).json()
    assert future["items"] == []
    for bad in ["", "mcp", "mcp:01", "MCP:1", "mcp:1,mcp:1", ",".join(f"k{i}:1" for i in range(17))]:
        rejected = harness.client.get("/api/v1/catalog", params={"kinds": bad}, headers=bearer)
        assert rejected.status_code == 422, bad


def test_unpublished_items_leave_the_client_catalog(harness: SimpleNamespace) -> None:
    admin = as_admin(harness)
    item = publish(admin, create(admin, LAST9, "last9"))
    bearer = {"Authorization": f"Bearer {CREDENTIAL}"}
    assert len(harness.client.get("/api/v1/catalog", headers=bearer).json()["items"]) == 1
    admin.post(f"{ADMIN}/items/{item['id']}/unpublish", json={"lock_version": item["lock_version"]})
    assert harness.client.get("/api/v1/catalog", headers=bearer).json()["items"] == []


def test_kind_request_parsing() -> None:
    assert parse_kind_requests("mcp:1") == {CatalogKind.MCP: 1}
    assert parse_kind_requests(" mcp:1 , skill:0 ,agent:3") == {CatalogKind.MCP: 1, CatalogKind.SKILL: 0}
    with pytest.raises(ValueError, match="repeat"):
        parse_kind_requests("mcp:1,mcp:2")
