# Organization catalog in Axon Hub: plan

Status: agreed direction (drafted 17 Nov 2026). Phases 1–3 (backend, admin dashboard, hub) are
implemented; phase 4 (install tracking) is not started.
Touches `apps/backend`, `apps/frontend` and `apps/cli`.

Admins publish a short, curated list of MCP servers from the admin dashboard. Every developer
sees them in `axon hub` and installs each one in a click, or through guided steps when the server
needs an API key or a prerequisite. The same catalog later carries skills and agents. It replaces
the unused launch-time sync from `/v1/cli/pi/mcp.json`.

## Decisions

| Topic | Decision |
| --- | --- |
| Storage | One generic `catalog_items` table with a `kind` column (`mcp`, `skill`), plus immutable `catalog_item_revisions`. Each kind's spec is JSONB, validated in code. |
| Editing | Admins edit a draft. Publishing freezes it as revision N+1. Rollback means restoring an old revision into the draft and publishing it. |
| Distribution | The local `axon hub` process fetches published items with the user's CLI session. The browser page only talks to the loopback hub. |
| Local vs LiteLLM gateway | Local installs. The LiteLLM MCP gateway cannot carry per-user credentials such as each user's Redash API key. OAuth servers (Last9, Atlassian) authenticate per user inside Pi with `/mcp`. |
| Secrets | Saved in `~/.axon/pi/mcp.json` (mode `0600`), the same as users do by hand today. Never sent to the backend. |
| Default exposure | `codemode`. |
| Publishing rules | Guidance in the admin UI only, shown as warnings. The backend validates structure, not policy: an unpinned `npx` package or similar never blocks publishing. |
| Skills | Preview only. Admins can create skill entries with metadata and a placeholder source. The hub's Skills tab sits behind a hardcoded flag that is turned off before release builds. Real distribution (probably S3 upload) comes later. |
| Seed data | None in migrations. Admins add the first entries through the dashboard. |
| Old catalog | Deleted outright. Nothing is migrated from it. |

## Where we are

| Piece | Today | Change |
| --- | --- | --- |
| Old MCP catalog | Static JSON at `/v1/cli/pi/mcp.json`. Interactive launches (throttled to every 6 h) append missing servers to `~/.config/mcp/mcp.json`, forced to `disabled: true`. No UI or instructions, so nobody enables them. | Removed (see [Retiring the old catalog](#retiring-the-old-catalog)). |
| `axon hub` | Loopback-only UI for `~/.axon/pi/mcp.json`. No network access, single-use launch link, CSRF, `default-src 'none'` CSP. `/api/session` already advertises `features`. | Gains Discover and Skills (preview) tabs, two local API routes and one read-only backend call. |
| Admin dashboard | axon-auth sign-in, roles from `config.json` `MEMBERS`, audit log. `sections.ts` already names the MCP catalog as the next section. | Gains a Catalog section and `/api/v1/admin/catalog/*` routes. Every write goes through `AdminAuditLog`. |
| Database | dbmate migrations, `META_HARNESS_` prefix, Tortoise models. | One migration adds two tables. |

## Architecture

```text
Admin dashboard ──edit draft / publish──▶ Backend: catalog_items + catalog_item_revisions
      │                                          ▲
      └──every write──▶ admin_audit_events       │ GET /api/v1/catalog (user's CLI session)
                                                 │
Browser (Discover tab) ──loopback API──▶ axon hub process ──install / update──▶ ~/.axon/pi/mcp.json ──/reload──▶ Pi
                                                 └──provenance──▶ ~/.axon/hub-catalog-installs.json
```

The browser only talks to the local hub. The hub's only new outbound call is a read of published
items with the user's own session: it gains no admin rights, and the model-relay capability is still
never exposed to the page. Both match the boundaries in [`local-hub.md`](local-hub.md).

## Data model and migration

Implemented in `apps/backend/db/migrations/20261117160000_create_catalog.sql`, in the style of the
admin audit migration. It seeds nothing.

- `META_HARNESS_catalog_items`: `id`, `kind` (CHECK `mcp`, `skill`), `slug` (unique per kind),
  `status` (`draft`, `published`, `archived`), `featured`, `sort_order`, the admin's `draft`
  (`{"metadata": {...}, "spec": {...}}`, at most 64 KiB), `draft_spec_version`,
  `published_revision` (set exactly when published), `lock_version`, and who created and last
  updated it.
- `META_HARNESS_catalog_item_revisions`: append-only `revision` N per item with `spec_version`, the
  normalized `content`, an optional `note`, and who published it when. `ON DELETE RESTRICT` keeps
  published history from being dropped with its item.

Design notes:

- **JSONB plus a kind registry.** A per-kind Pydantic model (`McpSpecV1`, `SkillSpecV0`) is the
  real schema. Agents are undecided, and nothing in these tables depends on their shape.
- **Draft plus revisions.** Admins can save unfinished drafts (only `metadata.name` is required to
  save) without users seeing them; reads report the draft's errors and warnings. Publishing needs a
  draft without errors. The hub compares the revision it installed with the latest one to show
  "Update available". Unpublishing and archiving clear `published_revision`; revisions are kept.
  Items that were never published can be deleted; published ones can only be archived.
- **Identity id on revisions.** Tortoise handles composite primary keys poorly, so revisions use an
  identity id plus `UNIQUE (item_id, revision)`.
- **Audit in the same transaction.** Writes lock the item row, apply the change, and record the
  `catalog.*` audit event before committing, so a failed audit write rolls the change back.
- Layout: `app/models/catalog.py`; `app/services/catalog/specs.py` (schemas, validation, warnings,
  tiers, kind registry) and `store.py` (persistence and rules); `app/routers/admin_catalog.py` and
  `app/routers/catalog.py`. `db/schema.sql` only covers the sessions table and is unchanged.

## MCP entries

### Spec (`McpSpecV1`)

`metadata`: `name`, `summary`, `tags`, `docsUrl`, `icon` (a name from the hub's built-in icon
set; no remote images). Admins maintain every entry, so there is no per-entry owner field.

`spec`:

| Field | Purpose |
| --- | --- |
| `server` | Template of the Pi `mcp.json` entry: `type` (optional: `stdio`, `http`, `streamable-http`; Pi infers it from `command` or `url`), `command`, `args`, `env`, `cwd`, `url`, `headers`, `timeout`, `description`, `exposure` (default `codemode`). Absent for manual entries. |
| `inputs[]` | Values the user supplies: `id`, `label`, `type` (`text`, `secret`, `url`, `path`), `required`, `placeholder`, optional `pattern`, `help` blocks. Referenced in `server` as `${input:<id>}`. |
| `prerequisites[]` | `id`, `label`, `detect: { executable }`, `help` blocks. |
| `steps[]` | Setup blocks shown before install. |
| `afterInstall[]` | Blocks shown once the config is written, for example "Run `/reload`, then `/mcp` to authenticate". |

Catalog installs always write `enabled: true`.

### Install tiers

The tier is computed from the content, never stored, so the label always matches what the entry
needs. `afterInstall` blocks do not affect the tier.

| Tier | Rule | Example |
| --- | --- | --- |
| One-click | Has `server`; no required inputs, prerequisites or `confirm` steps | Last9, Atlassian (OAuth happens afterwards in Pi) |
| Guided | Has `server` plus inputs, prerequisites or `confirm` steps | Redash (needs Node and a personal API key) |
| Manual | No `server`; instructions only | A server that needs a desktop app or an access request first |

### First entries

Admins add these through the dashboard, usually by pasting the existing `mcp.json` snippet (see
[Import from mcp.json](#import-from-mcpjson)). The summaries below are suggested copy.

**Redash** (guided):

```json
{
  "kind": "mcp",
  "slug": "redash",
  "metadata": {
    "name": "Redash",
    "summary": "Query 1mg Redash data sources, saved queries and dashboards from Pi.",
    "tags": ["data", "analytics"],
    "icon": "database"
  },
  "spec": {
    "server": {
      "command": "npx",
      "args": ["-y", "@suthio/redash-mcp"],
      "env": {
        "REDASH_URL": "https://redash.1mg.com/",
        "REDASH_API_KEY": "${input:api_key}"
      },
      "exposure": "codemode",
      "description": "Query 1mg Redash data sources, saved queries and dashboards."
    },
    "inputs": [
      { "id": "api_key", "label": "Redash API key", "type": "secret", "required": true }
    ],
    "prerequisites": [
      {
        "id": "node",
        "label": "Node.js (provides npx)",
        "detect": { "executable": "npx" },
        "help": [{ "type": "command", "command": "brew install node" }]
      }
    ],
    "steps": [
      { "type": "text", "text": "Copy the API key shown on your Redash profile page." },
      { "type": "link", "label": "Open my Redash profile", "url": "https://redash.1mg.com/users/me" },
      { "type": "input", "input": "api_key" }
    ],
    "afterInstall": [
      { "type": "text", "text": "Run `/reload` in Pi to load Redash." }
    ]
  }
}
```

The admin UI warns that `@suthio/redash-mcp` has no pinned version. The warning does not block
publishing.

**Last9** (one-click, then OAuth in Pi):

```json
{
  "kind": "mcp",
  "slug": "last9",
  "metadata": {
    "name": "Last9",
    "summary": "Query logs, metrics, traces and alerts in the tata1mg Last9 organization.",
    "tags": ["observability"],
    "icon": "activity"
  },
  "spec": {
    "server": {
      "type": "streamable-http",
      "url": "https://app.last9.io/api/v4/organizations/tata1mg/mcp",
      "timeout": 50,
      "exposure": "codemode",
      "description": "Logs, metrics, traces and alerts from the tata1mg Last9 organization."
    },
    "afterInstall": [
      { "type": "text", "text": "Run `/reload` in Pi, then run `/mcp` to authenticate with Last9." }
    ]
  }
}
```

**Atlassian** (one-click, then OAuth in Pi):

```json
{
  "kind": "mcp",
  "slug": "atlassian",
  "metadata": {
    "name": "Atlassian",
    "summary": "Search and manage work across Jira, Confluence, Bitbucket and other connected Atlassian products.",
    "tags": ["tickets", "docs", "code"],
    "icon": "ticket"
  },
  "spec": {
    "server": {
      "url": "https://mcp.atlassian.com/v2/mcp?tools=all",
      "exposure": "codemode",
      "description": "Search and manage Atlassian work across Jira, Confluence, Bitbucket, and other connected products."
    },
    "afterInstall": [
      { "type": "text", "text": "Run `/reload` in Pi, then run `/mcp` to authenticate with Atlassian." }
    ]
  }
}
```

The hub's My MCP servers list normally hides URLs that contain a query string, because they can carry
credentials. For catalog-installed servers it shows the catalog's URL instead, since that URL came
from the published revision and is not a secret.

### Import from mcp.json

The admin editor accepts a pasted snippet in any of these shapes: `{ "mcpServers": { ... } }`, a
single `"name": { ... }` entry, or a bare definition. It:

- uses the server name as the slug (lower-cased, `_` replaced with `-`);
- copies `command`, `args`, `env`, `cwd`, `url`, `headers`, `type`, `timeout`, `exposure` and
  `description`, defaults `exposure` to `codemode`, and drops `enabled`;
- flags placeholder or credential-looking values (`your-api-key`, `<...>`, `xxx`, `changeme`, or
  env/header keys containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `AUTH`) and offers **Make this
  an input**, which replaces the value with `${input:...}` and adds a secret input;
- for an HTTP server with no inputs, offers to add the "Run `/reload`, then `/mcp` to authenticate"
  after-install block.

Each of the three entries above is then a paste, one click, a summary, and **Publish**.

### Template rules (applied by the hub)

- Only `${input:<id>}` is substituted, and only by the hub. Other `${VAR}` references are written
  unchanged for Pi to expand.
- Inputs may appear in `args` items, `env` values, `headers` values and `cwd`. They may not appear in
  `command`. In `url` they are URL-encoded, and the rendered URL must keep the template's origin.
- Input values are at most 4 KiB, contain no control characters, and match `pattern` when one is set.
- Secret inputs are written as literal values into the `0600` config.

## Setup step blocks

Steps are typed blocks rather than HTML or free-form markdown. The hub renders them with React
components, and the admin preview renders the same blocks. No block can carry HTML, scripts or
remote images, so the hub CSP stays unchanged.

| Block | Renders as | Rule |
| --- | --- | --- |
| `text` | Paragraph with `` `code` ``, `**bold**` and `[label](https://...)` | Small inline parser, no HTML |
| `command` | Code block with a Copy button | The hub never runs it |
| `link` | Button that opens a page in a new tab | `https:` only, `noopener noreferrer` |
| `callout` | Info or warning box | Same text rules |
| `input` | Field bound to a declared input, masked when secret | Must reference an existing input |
| `check` | Prerequisite row: "Found at /opt/homebrew/bin/npx" or "Not found", with help blocks | Detection only looks the executable up on `PATH` |
| `confirm` | "I've done this" checkbox that must be ticked before Install | For steps the hub cannot detect, such as requesting access |

The renderer is small. `apps/frontend` is a pnpm app outside the Bun workspace, so implement it in
both apps and keep them consistent with shared golden fixtures in `docs/catalog/fixtures/*.json`,
parsed by the backend, CLI and frontend tests.

## Publishing: validation and guidance

The backend validates **structure only** when saving and publishing: the spec matches the kind's
schema, a server has either `command` or `url`, every `${input:...}` and `input` block references a
declared input, slugs and sizes are within limits, and links use `https:`.

The admin editor shows **warnings that never block publishing**:

- a package runner (`npx`, `uvx`, `bunx`, `pnpm dlx`) without an exact version;
- a literal value that looks like a credential, which every user would receive;
- an `http://` server URL;
- a missing summary or description;
- a stdio server whose command has no matching prerequisite (for example `npx` without Node);
- an `exposure` other than `codemode` (informational).

## APIs

### Admin API (backend, under `/api/v1/admin`)

Uses the existing `AdminRoute`, `require_admin_api`, `AnyAdmin` and `FullAdmin`. Each write records
one audit event, for example `catalog.item_published` with `kind`, `slug` and `revision` in its
details, never the spec body.

| Route | Role | Purpose |
| --- | --- | --- |
| `GET /catalog/items` | viewer | List with status, tier and an "unpublished changes" flag |
| `POST /catalog/items` | admin | Create a draft |
| `GET /catalog/items/{id}` | viewer | Draft plus the current published revision |
| `PATCH /catalog/items/{id}` | admin | Save the draft, slug (until first publish), `featured` or `sort_order`. Requires `lock_version`; a stale value returns 409. |
| `DELETE /catalog/items/{id}` | admin | Delete an item that was never published |
| `POST /catalog/items/{id}/publish` | admin | Validate and freeze revision N+1, with an optional note |
| `POST /catalog/items/{id}/unpublish` | admin | Hide from clients; revisions are kept |
| `POST /catalog/items/{id}/archive` | admin | Remove from the working list |
| `POST /catalog/items/{id}/unarchive` | admin | Return an archived item to draft |
| `GET /catalog/items/{id}/revisions` | viewer | History |
| `GET /catalog/items/{id}/revisions/{n}` | viewer | One revision with its content |
| `POST /catalog/items/{id}/revisions/{n}/restore` | admin | Copy an old revision into the draft |
| `POST /catalog/validate` | admin | Structural validation plus warnings, for the live preview |

### Client API (backend)

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/v1/catalog?kinds=mcp:1` | CLI bearer session (`require_authenticated_user`) | Published items whose kind and spec version the client supports, at most 100. Featured first, then `sort_order`, then slug. |

`kinds` defaults to `mcp:1`. It lets older CLIs skip kinds and spec versions they do not
understand, and the backend ignores kinds it does not know. Each item carries `kind`, `slug`,
`revision`, `specVersion`, `tier`, `featured`, `publishedAt`, `metadata` and `spec`. Add
`catalog.items` to `SERVICE_ENDPOINTS` in `apps/cli/src/product/endpoints.ts` and remove
`pi.mcpConfig`.

### Hub local API (CLI, under `/_axon/hub/api`)

| Route | Purpose |
| --- | --- |
| `GET /session` | Adds `features.catalog: true` and reports `features.skills` from the preview flag |
| `GET /catalog` | Published items with each item's local state, or `signin_required` / `unavailable` |
| `POST /catalog/install` | Install or update one MCP: `{kind, slug, revision, configRevision, name?, inputs, confirmExecution}`. `name` is only for installing under another name when the slug is taken. |

## Admin dashboard: Catalog section

One `ADMIN_SECTIONS` entry at `/admin/catalog` with `minRole: "viewer"`. Viewers see everything
read-only; admins edit and publish.

- **List.** Kind tabs (MCP, and Skills marked as preview), status chips (Draft, Published,
  Unpublished changes, Archived), the computed tier, and who last published it and when.
- **Editor.** Import from mcp.json. Details (name, slug, summary, tags, docs link, featured, order); the slug locks after the first publish because users have installed under that name.
  Server (transport, URL or command and arguments, env and headers with an `${input:...}` picker,
  exposure defaulting to `codemode`, timeout). Inputs, prerequisites, steps and after-install blocks
  as lists you can add to, reorder and remove from. A JSON tab for advanced edits. Warnings are shown
  inline next to the field they concern.
- **Live preview.** The hub card and install dialog rendered from the current draft.
- **Publish dialog.** The change against the last published revision, the open warnings, and an
  optional note.
- **History.** Revisions with author and time, viewable and restorable into the draft.

Access is still granted only in `config.json` `MEMBERS`.

## Hub: Discover tab

The hub's header nav has one "My …" tab per installable kind and one catalog page for every kind:
**My MCP servers**, **My skills** (read-only list of local skills), and **Discover**. Discover lists
published entries as cards with name, summary, tier and local state. With more than one kind enabled
it shows a kind filter (All, MCP servers, Skills) and a section per kind; with only MCP it is a single
list. Per-kind rules (label, feature flag, preview, card button and tag) live in
`apps/cli/src/hub/web/catalog/kinds.ts`, so a new kind adds an entry there, not a new page.

| Local state | Meaning |
| --- | --- |
| Not installed | No server with this name in `mcp.json` |
| Installed | Installed from the catalog at the latest revision |
| Update available | Installed from an older revision |
| Changed locally | The non-secret fields no longer match what the catalog installed; Update asks before overwriting |
| Name in use | A server with this name exists but was not installed from the catalog; offer another name |

### Install sequence

1. The user opens an item. The dialog shows the summary, prerequisite checks, step blocks with
   inputs inline, and a review of the exact command, arguments, URL and env/header names, with
   secret values masked.
2. The browser posts only the slug, catalog revision, config revision and input values. It never
   sends a server definition.
3. The hub server looks up that slug and revision in its own fetched copy of the catalog. If the
   catalog has changed since the page loaded, it returns 409 and asks the user to review again.
4. It validates the inputs, substitutes `${input:...}`, and writes the entry through
   `LocalMcpStore`. Split the current `create` into the browser-request parser and an internal
   `insertDefinition(name, definition, revision, confirmExecution)` that the catalog installer also
   calls. That reuses `validateDefinition`, the **Trust and save** rule for stdio servers, the file
   lock, the revision check and the atomic `0600` write, and lets catalog entries carry `type`,
   which the browser request schema does not accept.
5. It records the slug, revision and a hash of the non-secret fields in
   `${AXON_HOME}/hub-catalog-installs.json`, outside Pi's config, so Pi's file gets no extra fields.
6. The page shows the after-install blocks (for example "Run `/reload`, then `/mcp` to
   authenticate"). The server appears in My MCP servers with a "From catalog" badge.

### Sign-in, updates and unpublishing

- **Signed out.** Discover shows "Sign in with `axon auth login`, then refresh". My MCP servers keeps
  working without a session. The hub reuses the CLI's existing session helpers (load, verify, and
  rotate under the shared auth lock) rather than adding a second auth path.
- **Update.** Re-renders the latest revision and keeps existing input values unless the user types
  new ones. The review shows the full entry that will be written, and stdio servers always need
  **Trust and update**.
- **Unpublished items** disappear from Discover. Installed copies stay, because the local config
  belongs to the user, and keep their "From catalog" mark. (A "No longer in catalog" label was
  planned but isn't built: My MCP servers doesn't fetch the catalog.) Nothing is ever pushed to or
  removed from a machine remotely.
- After changing `apps/cli/src/hub/web/`, rebuild with `bun run --cwd apps/cli hub:build`.
  `hub:check` fails when the committed bundle is stale.

## Skills (preview)

Skills are visible end to end but do not install yet.

- **Backend.** Kind `skill` with `SkillSpecV0`: metadata plus a placeholder source, for example
  `{ "source": { "type": "placeholder", "notes": "..." } }`. Entries can be published so the hub
  has something to show. When the real source is designed (probably an S3 bundle upload with a
  SHA-256 the hub verifies before writing `~/.axon/pi/skills/<slug>/`), it ships as `SkillSpecV1`.
- **Admin dashboard.** A Skills tab in the Catalog section, using the same list, publish and history
  flow, with an editor for metadata and the placeholder source. It is labeled as a preview.
- **Hub.** A Skills section in Discover that lists published skill entries as cards with Install
  disabled and "Coming soon". It is gated by a hardcoded constant:

  ```ts
  // apps/cli/src/hub/features.ts
  /** Skills tab preview. Set to false before cutting a release build. */
  export const HUB_SKILLS_PREVIEW = true;
  ```

  When it is `false`, `/session` reports `skills: false`, the section is not rendered, and the hub
  does not request `skill` items from the backend. The separate **My skills** tab lists local skills
  (`~/.axon/pi/skills`, `~/.agents/skills`) and is not behind the flag. Once skills install, catalog
  installs land in `~/.axon/pi/skills/<slug>/`, get a `skill` section in `hub-catalog-installs.json`,
  and show a "From catalog" badge in My skills.

## Agents

Not designed yet. When the shape is decided, add the kind to the CHECK constraint, an
`AgentSpecV1` model, an admin editor and a hub installer. The list, publishing, revisions, audit,
cards and local state are already generic.

## Hub-side guarantees

The soft publishing rules above do not change these:

- Secrets typed into the hub stay on the machine.
- The browser never supplies a server definition; installs render from the hub's own fetched copy.
- stdio servers and `!command` credential helpers still need explicit Trust and install, after a
  review of exactly what will run.
- The hub never runs install commands. Command blocks are copy-only, and prerequisite checks only
  look executables up on `PATH`.
- Step content is typed data, never HTML. The hub CSP stays `default-src 'none'`.
- Catalog reads need sign-in, because entries contain internal hostnames. Responses are
  size-bounded, and the hub validates them with zod and drops unknown kinds and spec versions.
- The hub's only backend call is a read-only catalog GET with the user's own session.
- Every admin change is audited, and dashboard access is still granted only in configuration.

## Retiring the old catalog

Ship this in the same CLI release as the Discover tab.

| Where | Change |
| --- | --- |
| `apps/cli/src/harnesses/pi/setup/mcp-catalog.ts`, `mcp-config.ts`, `paths.ts` | Delete |
| `apps/cli/src/harnesses/pi/setup/contracts.ts` | Remove the MCP sync types |
| `apps/cli/src/harnesses/pi/setup/index.ts` | Remove the `mcp-config` interactive check (the only one) |
| `apps/cli/src/cli/commands/setup.ts` | Remove the forced sync step |
| `apps/cli/src/product/endpoints.ts`, `apps/cli/src/product/paths.ts` | Remove `pi.mcpConfig` and `piMcpSyncState` |
| `apps/cli/tests/pi-mcp-setup.test.ts`, `apps/cli/tests/endpoints.test.ts` | Delete the first; update the second |
| `apps/cli/README.md`, `apps/cli/docs/launcher-plan.md`, `apps/cli/docs/shipplan.md`, `docs/local-hub.md` | Remove the sync sections; document Discover |
| `apps/backend/README.md` (deployment section) | Drop the requirement to host `/v1/cli/pi/mcp.json` |
| Ingress or static hosting of that JSON | Remove once the release ships. Older CLIs treat a failed fetch as a silent warning and retry at most every 15 minutes. |

Leave users' `~/.config/mcp/mcp.json` alone: other tools share it, it belongs to the user, and every
entry the old sync added was disabled. Deleting `~/.axon/pi-mcp-sync.json` is optional cleanup.

## Delivery phases

1. **Backend foundation** (`apps/backend`). **Done.** Migration, Tortoise models, kind registry with
   `McpSpecV1`, `SkillSpecV0` and tier computation; admin routes with audit events; client
   `GET /api/v1/catalog`. Tests: `test_catalog_specs.py` (validation, warnings, tiers, using the
   Redash, Last9 and Atlassian entries), `test_catalog_routes.py` (guards, roles, lifecycle, client
   filtering, against an in-memory store), and `test_catalog_database.py` (constraints, the real
   store, audit rollback, concurrent publishes; skipped without a disposable Postgres).
2. **Admin Catalog section** (`apps/frontend`). **Done.** List, editor with Import from mcp.json,
   block editor, live errors and warnings, preview, publish dialog, history with restore, and the
   Skills preview editor, under `src/admin/catalog/`. `tests/catalog-model.test.ts` (`pnpm test`)
   covers the import of the Redash, Last9 and Atlassian snippets as they were shared. Checked in a
   browser against the real backend routers: all three imported, created, published, edited and
   restored, with the audit trail visible. Admins still need to add them in each environment.
3. **Hub Discover and retiring the old sync** (`apps/cli`). **Done.** Session reuse, catalog fetch
   and local state, install and update, provenance file, block renderer, "From catalog" badges,
   the Skills preview tab behind `HUB_SKILLS_PREVIEW`, and the removals listed above. Tests:
   `hub-catalog.test.ts` (routes: sign-in states, session rotation, browser-supplied definitions
   rejected, stale catalog and config revisions, trust, updates keeping secrets and user fields,
   local edits, name clashes, the skills flag), `hub-catalog-install.test.ts` (rendering,
   substitution rules, input validation, fingerprints), and `hub-web-catalog-model.test.ts`. The
   shared `docs/catalog/fixtures` were not added; both test suites carry their own copies of the
   three entries. Checked in a browser: `axon hub` from source against the real backend routers
   installed Redash, Last9 and Atlassian into an isolated home. Running them in Pi (`/reload`, and
   `/mcp` for the OAuth servers) still needs a check on a real machine.
4. **Install tracking.** Product events for Discover views and installs (slug, revision, tier and
   outcome, never input values), shown as install counts on the admin overview. The old catalog had
   no usage signal, so this should not slip.

## Later

None of these block v1.

- **`axon mcp add <slug>`.** A terminal command that installs a catalog MCP without opening the hub
  and prompts for inputs in the terminal. It can share the hub's installer.
- **Per-team audiences.** v1 shows every signed-in user the whole catalog. If some entries should
  reach only some teams, add an `audience` column and filter in the client API.
- **Skill source format.** S3 bundle upload is the likely choice. It is decided when skills move
  past the preview.
