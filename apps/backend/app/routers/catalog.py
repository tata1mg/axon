"""Published organization catalog for `axon hub`, read with the user's CLI session.

Clients name the kinds and spec versions they understand (``?kinds=mcp:1,skill:0``) and
receive only published items they can render, so older CLIs never see entries written
for a newer schema. Kinds this backend does not know are ignored rather than rejected.
"""

import re
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.authentication import require_authenticated_user
from app.services.catalog.specs import CatalogKind, InstallTier, check_draft
from app.services.catalog.store import CatalogItemRecord, CatalogStore, get_catalog_store

router = APIRouter(
    prefix="/api/v1/catalog",
    tags=["catalog"],
    dependencies=[Depends(require_authenticated_user)],
)

_KIND_REQUEST = re.compile(r"^([a-z][a-z0-9_-]{0,31}):(0|[1-9][0-9]{0,3})$")
_MAX_KIND_REQUESTS = 16


class _View(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, serialize_by_alias=True)


class PublishedItemView(_View):
    kind: CatalogKind
    slug: str
    revision: int
    spec_version: int
    tier: InstallTier | None
    featured: bool
    published_at: datetime
    metadata: dict[str, Any]
    spec: dict[str, Any]


class PublishedCatalogView(_View):
    schema_version: Literal[1] = 1
    items: list[PublishedItemView]


def parse_kind_requests(value: str) -> dict[CatalogKind, int]:
    """Parse ``mcp:1,skill:0``. Unknown kinds are skipped; malformed input is rejected."""
    entries = [entry.strip() for entry in value.split(",") if entry.strip()]
    if not entries or len(entries) > _MAX_KIND_REQUESTS:
        raise ValueError("kinds must list between 1 and 16 kind:version pairs")
    requested: dict[CatalogKind, int] = {}
    for entry in entries:
        match = _KIND_REQUEST.fullmatch(entry)
        if match is None:
            raise ValueError("kinds must look like mcp:1,skill:0")
        name, version = match.groups()
        if name in CatalogKind:
            kind = CatalogKind(name)
            if kind in requested:
                raise ValueError("kinds must not repeat a kind")
            requested[kind] = int(version)
    return requested


def _published_view(record: CatalogItemRecord) -> PublishedItemView:
    published = record.published
    if published is None:  # pragma: no cover - the store only returns published items
        raise RuntimeError("Unpublished item in the published catalog")
    content = published.content
    return PublishedItemView(
        kind=record.kind,
        slug=record.slug,
        revision=published.revision,
        spec_version=published.spec_version,
        tier=check_draft(record.kind, content).tier,
        featured=record.featured,
        published_at=published.published_at,
        metadata=content.get("metadata", {}),
        spec=content.get("spec", {}),
    )


@router.get("", response_model=PublishedCatalogView)
async def published_catalog(
    store: Annotated[CatalogStore, Depends(get_catalog_store)],
    kinds: Annotated[str, Query(max_length=256)] = "mcp:1",
) -> PublishedCatalogView:
    try:
        requested = parse_kind_requests(kinds)
    except ValueError as error:
        raise HTTPException(422, str(error), headers={"Cache-Control": "no-store"}) from None
    records = await store.published(requested)
    return PublishedCatalogView(items=[_published_view(record) for record in records])
