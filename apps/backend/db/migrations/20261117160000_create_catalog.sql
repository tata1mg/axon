-- migrate:up
-- Organization catalog: admin-curated MCP servers (and later skills and agents) that
-- developers install from `axon hub`. Admins edit a draft; publishing freezes it as an
-- immutable revision, and clients only ever read published revisions.
CREATE TABLE "META_HARNESS_catalog_items" (
    id UUID CONSTRAINT "META_HARNESS_catalog_items_pkey" PRIMARY KEY,
    -- Each kind's spec is validated in application code; extend the CHECK per new kind.
    kind VARCHAR(32) NOT NULL,
    -- Stable install name (the mcp.json server name for MCP entries).
    slug VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'draft',
    featured BOOLEAN NOT NULL DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- Working copy edited in the dashboard: {"metadata": {...}, "spec": {...}}. It may be
    -- incomplete; publishing validates it.
    draft JSONB NOT NULL,
    draft_spec_version INTEGER NOT NULL,
    published_revision INTEGER,
    -- Optimistic concurrency: every write must name the version it was based on.
    lock_version INTEGER NOT NULL DEFAULT 1,
    created_by_email VARCHAR(320) NOT NULL,
    updated_by_email VARCHAR(320) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "META_HARNESS_catalog_items_kind_slug" UNIQUE (kind, slug),
    CONSTRAINT "META_HARNESS_catalog_items_kind" CHECK (kind IN ('mcp', 'skill')),
    CONSTRAINT "META_HARNESS_catalog_items_slug" CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    CONSTRAINT "META_HARNESS_catalog_items_status" CHECK (status IN ('draft', 'published', 'archived')),
    CONSTRAINT "META_HARNESS_catalog_items_published" CHECK (
        (status = 'published') = (published_revision IS NOT NULL)
    ),
    CONSTRAINT "META_HARNESS_catalog_items_versions" CHECK (
        draft_spec_version >= 0 AND lock_version >= 1 AND (published_revision IS NULL OR published_revision >= 1)
    ),
    CONSTRAINT "META_HARNESS_catalog_items_draft" CHECK (
        jsonb_typeof(draft) = 'object' AND octet_length(draft::text) <= 65536
    )
);
CREATE INDEX "META_HARNESS_catalog_items_published" ON "META_HARNESS_catalog_items" (kind, featured DESC, sort_order)
    WHERE status = 'published';

-- Append-only: application code inserts and reads, never updates.
CREATE TABLE "META_HARNESS_catalog_item_revisions" (
    id BIGINT GENERATED ALWAYS AS IDENTITY CONSTRAINT "META_HARNESS_catalog_item_revisions_pkey" PRIMARY KEY,
    item_id UUID NOT NULL CONSTRAINT "META_HARNESS_catalog_item_revisions_item"
        REFERENCES "META_HARNESS_catalog_items" (id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL,
    spec_version INTEGER NOT NULL,
    -- Normalized copy of the draft at publish time.
    content JSONB NOT NULL,
    note VARCHAR(500),
    published_by_email VARCHAR(320) NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "META_HARNESS_catalog_item_revisions_unique" UNIQUE (item_id, revision),
    CONSTRAINT "META_HARNESS_catalog_item_revisions_valid" CHECK (
        revision >= 1 AND spec_version >= 0
        AND jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 65536
    )
);

-- migrate:down
DROP TABLE "META_HARNESS_catalog_item_revisions";
DROP TABLE "META_HARNESS_catalog_items";
