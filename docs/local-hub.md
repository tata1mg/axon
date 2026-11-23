# Local Axon Hub

`axon hub` starts a standalone, local-only browser UI for Axon configuration. It manages
**user-level MCP servers** (My MCP servers), lists **user-level skills** (My skills), and
installs MCP servers from the **organization catalog** (Discover), without launching Pi, contacting MCP servers, or forwarding requests
to LiteLLM. Its only outbound request is a read-only GET of the published catalog, made
with the saved Axon session.

```sh
axon hub             # start the local server and ask the OS to open a browser
axon hub --no-open   # print the private link; open it manually
```

From a checkout: `bun run apps/cli/src/index.ts hub`.

Inside an interactive `axon pi` terminal session, run `/axon-hub` to open the same Hub
without starting a second terminal command. The Hub stays open through `/reload` and
stops when Pi exits. Running `/axon-hub` again replaces the previous Hub tab’s session.
In offline Pi sessions, My MCP servers and My skills still work but Discover is hidden.

Keep the standalone command running while using the page. Ctrl+C, SIGTERM, or SIGHUP
stops the server and invalidates its browser session. The command prints a private, single-use
link valid for five minutes. Do not share or persist it. If it expires, has already
been consumed by a different browser, or the eight-hour browser session expires,
restart the command for a fresh link. Refreshing an authenticated page works without
reusing the link.

## MCP MVP

The hub reads and writes `${AXON_HOME:-$HOME/.axon}/pi/mcp.json`, the user-level file
read by Axon's managed Pi. An inherited `PI_CODING_AGENT_DIR` does not redirect this
command away from Axon's managed home.

Supported operations:

- List, search, and filter configured servers (all, enabled, disabled, needs repair),
  with configuration-level enabled state, transport, description, exposure, and
  environment/header key names.
- Add a streamable HTTP server by URL, or a local stdio server by pasting its command
  line. The page splits the command into an executable and arguments with POSIX-style
  quoting and shows the result before saving; it never runs a shell, so pipes,
  redirects, `&&`, `;`, and inline `NAME=value` assignments are rejected.
- Edit the description, URL/executable, arguments, working directory, environment
  variables, headers, and server-level tool exposure.
- Enable or disable a server with its switch, or remove it after a confirmation.
  Changes to a stdio server's command, arguments, working directory, environment, or
  headers, enabling it, and any configuration with `!command` credential helpers need
  an explicit **Trust and save** / **Trust and enable** step. The hub itself never
  installs or executes that server or its credential helpers.
- Refresh after editing the file outside the hub. The page also refreshes when its tab
  becomes visible again.

**These are saved configuration states, not connection health.** After any change,
run `/reload` in each running Pi session, or start a new session. The hub does not
disrupt an active model/tool turn. A trusted project's `.pi/mcp.json` can override a
user-level entry; those overrides are not shown or changed by this MVP.

LiteLLM's extension-registered MCP bridge and servers injected by other extensions are
not local user-level entries and are not managed by this page. Neither is the shared
`~/.config/mcp/mcp.json`: Axon's former launch-time sync wrote disabled organization
entries there, and they stay until you remove them. Disabling a user-level
override for an extension server can have different results after removing that
override: Pi may expose the underlying extension registration again.

## My skills

A read-only list of the skills Pi loads from the two user-level folders, in Pi's order:
`${AXON_HOME:-$HOME/.axon}/pi/skills`, then `~/.agents/skills`. It follows Pi's discovery
(a folder with `SKILL.md` is one skill; standalone `.md` files count when their frontmatter
has a description) and shows each skill's name, description, folder, and `SKILL.md` path.
It also lists the ones Pi skips, so they can be fixed: **Not loaded** (no description, or
frontmatter that isn't valid YAML) and **Overridden** (an earlier skill has the same name).
Only frontmatter is read; skill bodies never reach the page. Project skills, skills from Pi
packages or settings paths, and `.gitignore` rules in skill folders aren't covered. Run
`/reload` in Pi after changing a skill.

## Discover: the organization catalog

Admins publish MCP servers in the admin dashboard (see `docs/hub-catalog-plan.md`).
Discover lists them with a tier (One-click, Guided, Steps only) and their state on this
machine: not installed, Installed, Update available, Changed locally (the catalog-managed
fields were edited), or Name in use (a server with that name exists that didn't come from
the catalog).

- **Sign-in.** The hub reads the catalog with the session saved by `axon auth login`
  and persists a rotated session the same way the CLI does. Signed out, Discover asks you
  to sign in; My MCP servers and My skills keep working.
- **Installing.** The dialog shows prerequisite checks (an executable looked up on
  `PATH`, never run), the entry's setup steps with its input fields, and a review of
  exactly what will be written, with secret values masked. stdio servers need **Trust and
  install**. The browser sends only the entry's slug, the revision it showed, the config
  revision, and the values typed; the hub renders the entry from its own copy of the
  catalog, fetched again at install time, so a page can't supply a server definition. If
  an admin unpublished or superseded the entry after the dialog opened, the install is
  refused with a conflict. Input values are substituted only
  into arguments, env and header values, the working directory, and the URL (encoded, and
  unable to change its origin). They're written to `mcp.json` and nowhere else.
- **Updates and resets.** Leave an input blank to keep the stored value. An update
  replaces only catalog-managed fields; fields you added and a disabled state stay.
- **Provenance.** `${AXON_HOME}/hub-catalog-installs.json` (mode `0600`) records each
  install's server name, catalog revision, and a fingerprint of the catalog-managed fields
  with input positions masked. It never holds input values. My MCP servers marks those
  entries **From catalog**, and shows a catalog URL the store would otherwise hide because
  it has a query string. Removing a server, or adding one under a name whose old entry was
  removed in an editor, drops that name's record under the config write lock, so an
  unrelated server never inherits it.
- **Kinds.** Discover is one page for every catalog kind. With more than one kind enabled
  it shows a kind filter (All, MCP servers, Skills) and a section per kind; with only MCP it
  looks as before. Each kind is an entry in `apps/cli/src/hub/web/catalog/kinds.ts`.
- **Skills (preview).** With `HUB_SKILLS_PREVIEW` in `apps/cli/src/hub/features.ts`
  set to `true`, Discover lists published skills in a Skills section with Install disabled.
  Set it to `false` before a release build: the section disappears and the hub stops
  requesting skills. My skills doesn't depend on this flag.
- After installing, run `/reload` in each running Pi session. OAuth servers such as
  Last9 and Atlassian then need `/mcp` to sign in.

### Private fields and editing

The API never returns existing argument values, working directories, environment
values, header values, OAuth configuration, or unknown extra configuration fields.
HTTP URLs containing a username, password, query string, or fragment are also
write-only; the page shows that a private endpoint is stored instead.

- Edits send only the fields that changed. A blank URL or working directory keeps the
  stored value.
- Stored arguments stay hidden. Changing only the executable keeps them; pasting a full
  command replaces them; **Clear** removes them.
- Environment variables and headers are edited as key/value rows. Stored keys are
  listed with hidden values: leave the value blank to keep it, type a new value to
  replace it, or remove the row to delete the key. Prefer `${NAME}` environment
  references to literal secrets.
- Existing custom fields, OAuth settings, per-tool exposure, unrelated servers, and
  top-level settings are preserved. Custom OAuth/timeout/per-tool editing is not
  exposed in the form; use an editor for those advanced settings.
- Transport and name are fixed during editing. Remove and re-add to change them.

New configuration uses Pi's native `enabled` field, not the legacy `disabled` field.
Names that collide after replacing hyphens with underscores are rejected.
Unsupported entries remain visible and removable; malformed top-level JSON is never
silently repaired or overwritten.

## Foundation and boundaries

The hub follows the existing launcher-owned loopback-service pattern but deliberately
uses a **separate listener and browser credentials**, not the LiteLLM relay's broad
capability. Browser code cannot call model, telemetry, sandbox, authentication,
arbitrary file, or command-execution endpoints through this service.

- Binds only `127.0.0.1` on an OS-assigned port, with exact Host/Origin validation and
  no cross-origin/CORS API access, including from other localhost ports.
- Exchanges the single-use fragment token for an HttpOnly, SameSite=Strict, path-scoped
  cookie. JavaScript clears the fragment before its first request. Credentials are
  kept in memory; there is no hub session file or local/session-storage token.
- Requires a per-session CSRF token and same-origin Origin on every mutation; API
  reads require a custom header. Security headers prohibit framing, inline scripts,
  external assets, referrers, and response caching.
- Reads only the fixed managed MCP path and its own install record. No server-supplied
  environment expansion, `!command` evaluation, connection testing, or package
  installation occurs. The catalog GET sends the saved session as a bearer token, no
  cookies, follows no redirects, and bounds the response to 4 MiB.
- Limits API bodies to 64 KiB and config files to 1 MiB. Errors do not echo request
  values, file contents, filesystem exceptions, or stacks.
- Refuses symlink/non-regular configuration files and symlink/non-user-owned managed
  directories. Writes are private (`0600`), staged and synced before atomic rename.
- Serializes hub writes across processes and checks a content revision before saving.
  Stale tabs receive HTTP 409 rather than silently overwriting a newer version. The
  revision is checked again before rename to catch ordinary external-editor changes;
  an uncooperative writer can still race in the final filesystem check/rename window.

This is not a security boundary against another process running as the same OS user,
a malicious browser extension, or a compromised browser. Adding an MCP can allow Pi
to execute programs, access files, and contact networks when Pi loads it. Review the
configuration and retain Pi's normal trust/permission controls.

### Layout

- `apps/cli/src/hub/server.ts`: local transport, allowlisted API, embedded static assets.
- `apps/cli/src/hub/browser-session.ts`: bootstrap, browser authentication, CSRF, expiry.
- `apps/cli/src/hub/mcp-store.ts`: validated user-level MCP persistence and safe views.
- `apps/cli/src/hub/catalog*.ts`: the catalog schema (mirrors the backend's), the
  authenticated fetch, install rendering and fingerprints, the install record, and the
  service behind the Discover routes. `features.ts` holds the skills preview flag.
- `apps/cli/src/hub/web/`: the browser UI source, in React with plain CSS.
  - `main.tsx` clears the launch token from the address bar and starts the session.
  - `App.tsx` holds the page header and the session, expired and unreachable screens.
  - `api.ts` is the request client, with CSRF and error handling.
  - `ui/` holds shared pieces: native `<dialog>` modals, the confirm dialog, toasts and
    empty/error panels.
  - `mcp/` is the MCP page. Its editor rules (command splitting, trust, key/value
    updates) live in `mcp/model.ts`, which does not touch the DOM and is unit-tested.
  - `catalog/` holds Discover, Skills and the install dialog. Its rules (card actions,
    what blocks Install, the masked review) live in `catalog/model.ts`.
  - A new section goes in its own folder next to `mcp/`, with its own CSS file.
  - Don't add libraries that inject `<style>` tags or inline scripts: the CSP blocks them.
    Radix's scroll lock, used by shadcn dialogs, is one example.
- `apps/cli/src/hub/assets/hub.{js,css}`: the generated bundle, committed to the repo and
  embedded by Bun's text loader in source and native-compiled builds. Rebuild it with
  `bun run --cwd apps/cli hub:build` after changing `web/`. `hub:check`, which runs in
  `check`, `build` and `build:release`, fails if the bundle is out of date. No
  frontend or backend service is needed at runtime.
- `apps/cli/src/cli/commands/hub.ts`: lifecycle and browser opening.

`GET /_axon/hub/api/session` advertises schema version and available features.
`GET`/`POST /_axon/hub/api/mcps` and `PATCH`/`DELETE /_axon/hub/api/mcps/:name` implement
local MCP operations. Mutation payloads carry the latest config `revision`.
`GET /_axon/hub/api/catalog` fetches the published catalog and describes it against the
local config; `POST /_axon/hub/api/catalog/install` installs or updates one entry.
These are local implementation endpoints, not a public remote administration API.

The central `apps/frontend` remains the independently deployed management console.
The catalog routes reuse the local browser session; they do not expose the model-relay
capability or any organization-wide administration rights. Live Pi status/reload requires a separately designed
session bridge. Project configuration also needs explicit scope and trust handling.

## Validation

```sh
bun run --cwd apps/cli hub:check
bun test apps/cli/tests/hub-*.test.ts   # includes the catalog route and install tests
bun run --cwd apps/cli typecheck
```

The tests cover:

- Storage, redaction, conflicts, and unsafe files.
- Browser authentication, CSRF/Origin/Host checks, allowed routes, and expiry.
- CLI lifecycle.
- A minified native binary serving the embedded assets from outside the checkout.
- The editor rules in `mcp/model.ts`: command splitting, keeping or replacing arguments,
  key/value updates, name clashes, and when trust is required.

When changing the UI, also check it in a browser at desktop and mobile widths.
