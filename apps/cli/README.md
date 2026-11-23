# Axon CLI

This app lives at `apps/cli` inside the Axon monorepo. Workspace-wide setup is described in the [root README](../../README.md).

Native Bun/TypeScript launcher for running Pi with Axon-managed configuration and resources. The command is `axon`, managed state defaults to `~/.axon`, and launcher controls use `AXON_*`.

This is a clean-install rename: previous product installations are not automatically upgraded or migrated. Install Axon and update PATH and shell controls. Authentication reuses the shared DeputyDev token described below. Existing local sessions/settings and remote backups remain untouched; retain them until an explicit migration is reviewed. See the [rename progress and cutover checklist](../../docs/project-rename-to-loom.md).

## Current status

**Launcher Phase 1 and Pi resource/package isolation are implemented.** The CLI resolves and starts Pi while preserving user-supplied arguments. Pi is the only supported harness.

### Implemented

- Bun 1.4.1, strict TypeScript, Biome, and native `darwin-arm64` and `darwin-x64` compilation
- Product identity, build metadata, service-origin validation, and managed paths
- Pre-Commander dispatch for `pi`
- Online session verification and silent access-token refresh before Pi launches; browser login only when needed
- Authenticated, best-effort telemetry, standalone web-search, and Pi preferences from backend client-config
- Standalone web search through the existing authenticated LiteLLM relay, with grounding, session attribution, and tool usage/cost reporting
- `axon hub`: a local browser UI for user-level MCP servers, user-level skills, and the organization catalog (Discover), installing admin-published MCP servers with guided setup
- Pi agent/session isolation under `${AXON_HOME}/pi`, with Pi version checks disabled and every Pi-documented provider API key removed from Pi only (LiteLLM variables are kept)
- Exact Pi 1.6.0 pin: Axon uses only its isolated executable under `${AXON_HOME}/pi-runtime`, installed from Pi's release API with `npm ci`; the user's PATH Pi is never used or changed
- Content-addressed, checksum-verified Axon Pi resources injected through explicit Pi flags that reference the immutable runtime directory
- Embedded required-package policy with exact, minimum, and Pi/user-managed floating versions
- Locked package reconciliation, last-known-good exact fallback, and local-only warm checks
- Exact Pi executable selection independent of PATH; override attempts are rejected
- Preserved user harness arguments and inherited stdio/cwd; adapters may add required generated resource or local-service options
- Axon control-variable stripping and redacted debug launch previews
- Child exit-code and signal-status propagation
- Standalone local browser hub (`axon hub`) with separately scoped browser authentication and user-level MCP configuration management
- `harnesses`, `paths`, basic `doctor`, and guarded `uninstall` commands
- Launcher-core tests for registry behavior, environment isolation, argv passthrough, and reserved exit statuses
- Verified, atomic installer for the native Apple Silicon or Intel binary
- S3/CloudFront release discovery, manual `axon update`, and automatic latest-version updates before interactive online Pi sessions

### Deferred

- Phase 0 compatibility evidence and the complete Phase 0.5 PTY/import-boundary suite
- Import of personal Pi provider authentication
- Apple Developer ID signing and notarization
- Independently signed update manifests, rollout policy, and rollback command (the current updater uses backend-served hashes)

## Installation

Releases support macOS on Apple Silicon (`darwin-arm64`) and Intel (`darwin-x64`). The installer picks the build that runs natively, including from a Rosetta terminal on Apple Silicon, and each binary updates only to the same target. The launcher does not bundle Pi. The installer checks for Node.js 22.19 or newer and npm before installing `axon`; if either is unavailable, it offers to install or upgrade Node.js with Homebrew in an interactive terminal. Non-interactive installations require Node.js and npm to be installed first. `axon pi` installs and uses its own exact Pi 1.6.0 release on first use, independently of any user-installed Pi.

Once the backend serves the public `/install.sh` endpoint (rendered from this repository's [`install.sh`](install.sh) using its configured release URL), install with:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://YOUR_ORIGIN/install.sh | sh
```

For an inspect-first installation:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo install.sh https://YOUR_ORIGIN/install.sh
less install.sh
sh install.sh
```

The installer itself uses no `sudo` (Homebrew may request privileges when installing Node.js), installs to `${AXON_HOME:-$HOME/.axon}/bin/axon`, verifies compressed and decompressed SHA-256 hashes, verifies the ad-hoc code signature and exact version, preserves an existing binary as `axon.prev`, and atomically activates the replacement. It automatically adds the Axon bin directory to your shell startup configuration: `.zshrc` for Zsh (honoring `ZDOTDIR`), `.bashrc` and the selected login profile for Bash, `config.fish` for Fish (honoring `XDG_CONFIG_HOME`), and `.profile` for sh/dash/ksh. Existing configuration is preserved, and repeat installs or repeated sourcing do not duplicate PATH entries. Restart your terminal or run the printed shell-specific command to enable Axon in the current shell, then run:

```bash
axon doctor
```

> **macOS trust limitation:** the MVP binary is explicitly ad-hoc signed, not Apple Developer ID signed or notarized. The verified terminal installer does not disable Gatekeeper. A browser-downloaded copy may receive a quarantine attribute and trigger an unidentified-developer warning. After independently checking its published checksum and signature, remove only that file's quarantine attribute if necessary: `xattr -d com.apple.quarantine ~/.axon/bin/axon`. Never disable Gatekeeper globally.

`axon update --check` reports whether the backend has a newer release for this binary's target. `axon update` downloads it through CloudFront, checks both SHA-256 hashes, signature, and version, and atomically replaces **only the managed binary** while keeping `axon.prev`. Every interactive online Pi session (`axon` or `axon pi ...`) checks the published latest version **before starting Pi**, without a 24-hour throttle. If newer, Axon installs it and automatically continues in the updated launcher with the same Pi arguments, cwd, environment, and terminal. Metadata requests time out after three seconds; downloads retain their longer timeout. In a terminal, both `axon update` and the startup check show a spinner through the check, download, and verify stages that clears before the result line; piped and CI output is unchanged. Check/install/relaunch failures warn and allow the current launcher to continue. Set `AXON_NO_UPDATE=1` to skip automatic updates without disabling explicit updates. Offline (`--offline`/`PI_OFFLINE`), CI, non-interactive, and administrative/help/version invocations skip the startup check. Non-interactive Pi launches (`--mode rpc`, `--mode json`, `-p`, piped stdio, e.g. Paseo) instead start a detached background worker with no stdio, so the client protocol is untouched; it checks at most once every 24 hours (1 hour after a failure), shares the update lock, and installs for the **next** launch while the running process continues on its current binary. The throttle is read before the worker starts, so frequent scripted launches do not each start a process. An interactive launch never waits behind a worker's download: it continues on its current version, and if the worker already installed the latest release, it switches to that release without downloading it again. The same `AXON_NO_UPDATE`, offline, and CI opt-outs apply. Source/dev builds do not self-update. Updates never downgrade. This behavior applies after installing a release containing the startup updater; older clients retain their existing update behavior.

The checksums and URLs come from the same backend; they detect corruption but are **not independent proof of provenance** if the backend itself is compromised. The current release is ad-hoc signed, not Developer ID signed or notarized. Separately signed distribution manifests remain future work.

## Usage

```bash
axon pi [pi arguments...]
axon update --check
axon update
```

Everything after `pi` bypasses Commander and retains its relative token order. For example, `axon pi --help` launches `pi --help`. Ordinary Pi sessions are prefixed with explicit Axon-owned resource flags.

Launcher-owned commands:

```bash
axon auth login [--browser]
axon auth status              # verify the saved session online, refreshing expired access tokens
axon hub [--no-open]           # local browser UI for user-level MCP configuration; no sign-in needed
axon sessions                  # guided session management
axon sessions list             # plain listing for scripts
axon harnesses
axon paths
axon doctor [pi]
axon setup pi --sync-packages   # installs Pi if needed, required packages, resources, and MCP defaults
axon setup paseo                # configure Axon and integration settings in Paseo
axon setup t3code               # add Axon as a T3 Code provider
axon uninstall [--remove-runtimes]
```

`uninstall` only mutates an installation when the running executable is the managed binary at `~/.axon/bin/axon`. It also removes the `axon-pi` wrapper. It preserves Pi settings, provider authentication, and sessions under `${AXON_HOME}/pi`, as well as the shared DeputyDev authentication file; `--remove-runtimes` removes only cached runtimes. Files created by earlier releases for other harnesses are not deleted automatically.

Set `AXON_DEBUG=1` for a redacted launch preview on stderr. `AXON_PI_BIN` is rejected. A different `AXON_PI_VERSION` is allowed only when running the CLI from source, not in any compiled CLI.

Set `AXON_WORKFLOW=<name>` when an automated workflow launches Axon (for example `AXON_WORKFLOW=pr-review axon pi -p "..."`). The value is trimmed, lowercased, and attached as `axon.workflow.name` to every Pi and launcher telemetry span, log, and metric point, so Grafana's **Workflow** filter can split usage and cost by workflow. Only `[a-z0-9._-]`, starting with a letter or digit, up to 64 characters, is accepted; anything else is dropped silently. Use a stable name per workflow, not a run ID. Unset is the normal case: those sessions have no workflow label and still appear under **All**. Pi subagents inherit the tag.

Every Pi request to LiteLLM also carries `x-litellm-tags` and `x-litellm-spend-logs-metadata`, which LiteLLM stores on the request log and forwards to Langfuse as trace tags and generation metadata. Tags hold the few values worth filtering on: `axon_workflow`, `axon_version`, `repo`, `pi_mode`, and `call_kind` (`main`, `compaction`, or `web_search`). The metadata adds `pi_version`, `repo_dir` (relative to the repository root, never the absolute path), `branch`, `commit`, and `ticket` when the branch names one such as `DD-520`. The repository and directory are read once per session and the branch and commit once per prompt, so a branch or commit the agent creates mid-prompt appears from the next prompt. Each prompt also gets a fresh `langfuse_trace_id` header, with `langfuse_trace_name: axon-prompt`, so every LLM call, compaction, and web search that prompt causes lands in one Langfuse trace instead of one trace per request. The Pi session id still groups the prompts into a Langfuse session. Requests to providers other than `litellm` carry none of this.

### Local browser hub

Run `axon hub` from a terminal or `/axon-hub` inside interactive `axon pi` to add, edit,
enable/disable, or remove local user-level MCP servers in
`${AXON_HOME:-$HOME/.axon}/pi/mcp.json`, and to install MCP servers your admins publish
to the organization catalog (the **Discover** tab). **My skills** lists the skills Pi
loads from `${AXON_HOME:-$HOME/.axon}/pi/skills` and `~/.agents/skills`. My MCP servers and
My skills need neither a Pi session nor an Axon login; Discover reads the catalog with your saved Axon session
(`axon auth login`). For the standalone command, use `--no-open` to open the printed
private link manually, and keep the command running while using the page. Run `/reload`
in each running Pi session after saving changes. See [`docs/local-hub.md`](../../docs/local-hub.md).

See [Local Axon Hub](../../docs/local-hub.md) for credential-safe editing, browser
security, lifecycle, architecture, and current limitations.

### Paseo integration

If you use [Paseo](https://paseo.sh), register Axon as a provider with:

```bash
axon setup paseo
axon setup paseo --config /custom/paseo/config.json  # non-default Paseo home
axon setup paseo --yes                              # accept integration updates in scripts
```

This local-only command does not require sign-in or install Paseo. It edits
`~/.paseo/config.json` by default, adding `agents.providers.axon` as a provider extending `pi`.
The provider runs `${AXON_HOME:-$HOME/.axon}/bin/axon pi` and sets `PI_CODING_AGENT_DIR`,
`PI_CODING_AGENT_SESSION_DIR`, and `PI_MODEL_RECOMMENDER_RPC=1` using your Axon paths.
If the config does not exist, setup creates it only when it finds `paseo` on `PATH` or the
macOS app in `/Applications` or `~/Applications`. An existing config also allows setup
when Paseo is installed elsewhere.

Setup enables the Axon provider and applies these integration settings:

- `features.dictation.enabled` and `features.voiceMode.enabled`: `true`
- `pluginsEnabled`: `true`
- `daemon.relay.enabled`: `true` (opts into relay connectivity; setup does not pair devices)
- `daemon.mcp.injectIntoAgents`: `true`
- `daemon.browserTools.enabled`: `true`
- `daemon.enableTerminalAgentHooks`: `true`
- `agents.providers.<id>.enabled`: `false` for `pi`, `opencode`, `copilot`, `codex`,
  `claude`, `muse`, and `antigravity`

Setup also adds or updates this entry in `daemon.terminalProfiles`, matching by its stable ID
so reruns do not append duplicates:

```json
{
  "id": "profile_mvt5ic5u_nj5mgc6ucq",
  "name": "Axon",
  "command": "axon",
  "args": ["pi", "{{{prompt}}}"]
}
```

Custom providers, agent profiles, other terminal profiles, and unrelated settings are preserved,
including voice configuration, extra terminal-profile fields, and extra fields on disabled
providers. Setup is a no-op only
when the Axon provider and all managed settings already match. Updating an existing Axon
setup requires confirmation (default **No**), or `--yes` in non-interactive runs. Extra Axon
provider fields and environment variables are preserved; only managed fields are updated.
Invalid JSON, malformed parent sections, and symlink/non-regular configs are never overwritten.
Writes are atomic, preserve existing config permissions, and save the previous contents to a
private sibling `config.json.axon-backup.<timestamp>.<id>` file before changing an existing file.

Restart Paseo after setup and select **Axon** when starting a new chat. Setup does not choose
a model or create an agent profile, and it never restarts Paseo or interrupts running agents.

### T3 Code integration

If you use [T3 Code](https://github.com/pingdotgg/t3code), add Axon as a provider with:

```bash
axon setup t3code
axon setup t3code --config /custom/t3/userdata/settings.json  # non-default T3 Code home
axon setup t3code --yes                                       # accept updates in scripts
```

This local-only command does not require sign-in or install T3 Code. It edits
`${T3CODE_HOME:-~/.t3}/userdata/settings.json`, adding `providerInstances.axon`: a `pi` driver
instance named **Axon** whose binary is the `axon-pi` wrapper (see below), which setup creates
or repairs. Its environment sets `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
`PI_MODEL_RECOMMENDER_RPC=1`, and `AXON_IGNORE_OFFLINE=1` as plain, non-sensitive values;
other variables you added are kept. Setup also sets `enabled: false` on the built-in `codex`,
`cursor`, `grok`, `opencode`, `antigravity`, `kiro`, `pi`, `muse`, and `fx` instances. Claude
(`claudeAgent`), instances you created, and all other settings are left unchanged.

If the settings file does not exist, setup creates it only when it finds `t3` on `PATH` or the
`T3 Code` or `T3 Code (Beta)` macOS app. The same safeguards as Paseo setup apply: an existing
Axon provider is replaced only after confirmation or `--yes`, invalid or concurrently edited
files are left unchanged, and a private backup is saved before changing an existing file.
T3 Code reloads the file itself; select **Axon** when starting a new thread.

### Using Axon from other apps

Some apps run a Pi binary directly (`<binary> --mode rpc`, `<binary> --version`) and have no
place for Axon's `pi` argument. Point them at `~/.axon/bin/axon-pi` (`axon paths` shows the
exact path) instead. It is a small script that runs `axon pi` with the same arguments, so
`axon-pi --version` reports Pi's version as those apps expect. The managed binary creates the
wrapper, and repairs it if it changed, whenever it launches Pi; source runs never touch it.

Axon verifies the session online before every Pi launch, so `--offline` and `PI_OFFLINE`
launches fail. Apps that request offline launches on their own, such as short-lived
model-discovery probes, can set `AXON_IGNORE_OFFLINE=1` in the environment they give Axon.
Pi launches then drop `--offline` (before `--`) and `PI_OFFLINE` and run as normal online
launches, including session verification, client configuration, and update scheduling.
Launcher commands are unaffected.

### First-run login and client configuration

Axon and the existing DeputyDev VS Code/binary application use the **same** user-wide authentication file: `~/.deputydev/264325ba-cbd0-47d5-9269-ac4bd19067c2.json`, under the `extension_auth_token` key. Axon does not use the separate `cli_auth_token` key. `AXON_HOME` changes only Axon's managed installation/runtime data, never this authentication location. Existing `.axon` authentication files are ignored; there is no fallback or migration.

Login and refresh write that shared token while preserving other JSON keys. Requests reload the live credential, and Axon's refresh writes use a shared `~/.deputydev/locks/session.lock` plus compare-and-swap checks so stale responses cannot replace an already changed credential. This coordinates Axon processes across different `AXON_HOME` values. The older DeputyDev writer does not acquire this lock, so sharing the file alone does not guarantee race-free writes between the two applications; full cross-app serialization requires DeputyDev to adopt the same locking protocol. Axon never deletes the shared credential on uninstall.

`axon` and every `axon pi ...` invocation verify the saved session online before resolving, installing, or launching Pi. Expired access tokens are silently refreshed when the refresh token is still usable, and the rotated encrypted session is saved atomically before continuing. A late response never overwrites another login; the newer saved session is verified instead. Browser login is offered only when the session is missing, invalid, or cannot be refreshed. Non-TTY/CI/scripted runs never prompt, but can refresh silently. Auth-service outages and unsafe refresh writes stop startup without asking for another login. Offline Pi invocations stop because online verification is required. `axon auth status` uses the same verify-and-refresh behavior.

RPC launches (`axon pi --mode rpc`, as used by Paseo) are the exception for a missing or unusable login: Pi starts signed out instead of failing. The relay rejects every managed model request at once with a "not signed in" error (nothing waits, so RPC client timeouts cannot fire), and the `axon-auth` extension offers a **Login from browser / Not now** card at startup and again after each rejected message; `/axon-login` also works. A login from another terminal ends the signed-out state too. Launch-time backend preferences such as terminal policy were not fetched, so the chat asks the user to restart the agent after signing in. Offline RPC launches and auth-service outages still fail startup. Over RPC, dialogs cannot be retracted, so cards stay open until answered; under Paseo, which discards open cards when a run fails or is interrupted, a fresh card replaces the discarded one.

Launcher-owned `setup pi --sync-packages`, `doctor`, `paths`, and `harnesses` retain a local saved-session preflight: if absent, interactive online invocations offer browser login, while scripted runs fail with login guidance. Launcher help/version, auth, update, uninstall, and local `setup paseo` and `setup t3code` remain exempt from that preflight. API routes still validate saved sessions server-side.

Online non-administrative Pi launches (including scripted modes) fetch `/api/v1/cli/config` using that session, capped at 700 ms and 16 KiB, even when telemetry/search are locally disabled. Accepted backend telemetry/search and partial compaction/recommender/provider preferences override inherited environment values. Managed telemetry has no supported local opt-out; unavailable or absent policies retain documented environment fallback, never changing authenticated search routing. Offline and administrative launches skip the request. There is no config disk cache and no public bootstrap/config endpoint. See [client configuration](docs/plans/cli-client-config.md) and [backend configuration](../backend/README.md#cli-client-configuration).

### Session backups

Run `axon sessions` in a terminal for a guided menu: browse/search backed-up sessions, restore into an existing checkout, delete a remote backup, inspect status, or retry pending backups. The picker shows titles and local-time backup details and searches by title, date, or full ID. Checkout defaults to the current directory and is validated before restore; relative paths and `~/` are supported. Restore and deletion still require explicit confirmation (default **No**). Cancel any prompt to exit without starting that operation, or use **← Back** / **Exit** to navigate. Restore shows a spinner while it downloads and verifies the backup, then prints a `cd … && axon pi --session …` command rather than launching Pi automatically.

Existing `sessions list/status/retry/restore/delete` subcommands remain available for scripts. Bare `sessions` requires a TTY and offers browser login if no saved session exists.

Session backups are administrator-managed: the backend `config.json` boolean `SESSION_BACKUPS.ENABLED=true` enables automatic complete-transcript backups for authenticated managed Pi sessions. There is no user enable/disable/pause command or launcher override. `/axon-backups status` (or `axon sessions status`) checks policy and queue status; `/axon-backup-now` requests a checkpoint. If backend policy is unavailable, no new capture/upload is attempted. See [session backup and restore](../../docs/session-backup-and-restore.md) for sensitive-data scope and storage setup.

### Web search

The embedded `web_search` tool is standalone: it constructs a dedicated LiteLLM Chat Completions
request with `web_search_options`, reads bounded raw JSON, and returns a grounded answer and sources.
It does not modify the main agent's provider requests or send the agent's function-tool catalog.

On managed launches, backend `WEB_SEARCH` preferences select enablement, model, limits, temperature,
reasoning level, optional search context size, URL context, and grounding requirements. The launcher
always sets the destination to `/litellm/v1/chat/completions` on its capability-protected local relay.
The relay reads the saved Axon session per request, persists rotation, and supports session recovery.
Upstream requests run concurrently, including main-agent, subagent, and web-search calls; new requests
wait only while a rotated session is being saved. Login recovery is shared across waiting requests,
and cancelling one request does not cancel recovery for the others. If concurrent responses rotate
the same session, the first rotation is saved; should the auth service reject it, the relay adopts a
verified sibling rotation before asking for login. The backend proxy resolves the
native LiteLLM identity. The extension sees only the local capability,
never the real session or an upstream LiteLLM key. Raw calls explicitly carry Pi's canonical session
ID and search metadata and report tokens plus `x-litellm-response-cost` as tool usage.

Backend search enablement and all five numeric settings win exactly over local values, including local
disablement or smaller limits. Offline disables the tool. Without accepted policy, local environment
preferences apply. A local model preference is accepted when listed in `allowedModels`.
Backend generation/grounding preferences win when fetched, and absent/null thinking and search-context
levels clear inherited overrides. These are client preferences, not an authorization boundary;
LiteLLM enforces actual model access, rate limits, and budgets. The backend template defaults search to
**disabled**: set `WEB_SEARCH.ENABLED=true`, restart the backend, and relaunch Pi to enable it.

Outside Axon, copy `src/harnesses/pi/resources/extensions/web-search.ts` into Pi's extensions directory.
With `pi-provider-litellm`, the tool resolves the provider's current credentials, pinned root, and custom
headers per call, including `/login` and refresh. `PI_WEB_SEARCH_PROVIDER` selects an alias (default
`litellm`); `PI_WEB_SEARCH_MODEL` selects a search-capable model (default `gemini-3.8-flash`). Explicit
`PI_WEB_SEARCH_BASE_URL`/`URL` and `API_KEY` also work without the provider. An explicit destination
cannot borrow credentials from a different provider root. The file has no runtime imports or SDK dependency.

`PI_WEB_SEARCH_THINKING_LEVEL` and `PI_WEB_SEARCH_SEARCH_CONTEXT_SIZE` accept `low`, `medium`, or `high`.
Omitting them leaves reasoning at its model default and sends `web_search_options: {}`.
Gemini ignores `search_context_size` in LiteLLM 1.104.0; it is not a Gemini search-depth control.
`USE_URL_CONTEXT` is Gemini-specific, and `REQUIRE_GROUNDING` defaults to true. See `.env.example` for
all settings. `PI_WEB_SEARCH_MODE` and `PI_WEB_SEARCH_SEARCH_TOOL` are obsolete.

### Pi installation bootstrap

`axon pi` uses **only** the Axon-managed executable at `${AXON_HOME}/pi-runtime/1.6.0/node_modules/.bin/pi`. It verifies the installed package and reported executable version, installs that exact version on demand if missing, and never reads or modifies `pi` on `PATH`, regardless of its version. This also applies to forwarded Pi administration (`install`, `auth`, `mcp`, etc.). `axon pi update` (including `--extensions`) is blocked before launching Pi; use `pi update` directly for a separate global installation. Axon's own required-package reconciliation still works through its pinned executable.

The official `https://pi.dev/install.sh` cannot pin a version, requires an interactive terminal, and may edit shell profiles, so Axon does not run it. Instead it follows the same steps as Pi's own managed `pi update`: it downloads `package.json` and `package-lock.json` for the exact version from `https://pi.dev/api/installer/releases/<version>/`, plus the release metadata from `https://pi.dev/api/installer/releases/<version>`, validates that all three describe `@earendil-works/pi-coding-agent@<version>`, merges the first-party tarball SHA-512 hashes from the metadata into the lockfile (the published lockfile omits them) so that every resolved tarball is integrity-checked, runs `npm ci --ignore-scripts --omit=dev --include=optional` in a staging directory under a same-user lock, verifies the installed package version and launcher, and atomically renames the tree into place. Shell profiles and `PATH` are never modified.

Installation requires Node.js 22.19.0 or newer and npm on `PATH`; otherwise the launch fails with a remediation that names Homebrew and the official installer. Offline launches (`--offline` or `PI_OFFLINE=1`) and `axon doctor` never install. The built CLI's exact pin comes from [`pi-version.json`](pi-version.json) and is embedded when compiling. `AXON_PI_BIN` fails with a clear error. A different `AXON_PI_VERSION` is accepted only in source development runs; compiled local and release binaries reject it. `pi --version` results are cached per executable path, size, and mtime in `${AXON_HOME}/pi-executable.json`, so warm launches do not spawn Pi twice. `axon uninstall --remove-runtimes` also removes `pi-runtime`.

### Axon release notes in Pi

`/changelog` displays only Axon's release notes, as does the startup **What's New in Axon** section.
The managed `axon-changelog.ts` extension wraps Pi's public editor submit callback; it does not patch
Pi's runtime, replace raw keyboard input, or send release notes to the model. `/axon-changelog` is also
available as a normal extension command for clients without the terminal editor.

On each ordinary launch, Axon sets `lastChangelogVersion` in its isolated Pi settings to the selected
Pi version, suppressing upstream Pi startup notes. Axon separately stores `lastSeenAxonVersion` in
`${AXON_HOME}/pi/axon-changelog.json`. The first new conversation establishes a baseline silently;
subsequent upgrades show only newly published Axon entries. Resuming an existing conversation or
using print/JSON/RPC mode does not advance this marker, and downgrades do not move it backwards.

Release notes are maintained in `AXON_RELEASES` (newest first) in
`src/harnesses/pi/resources/extensions/axon-changelog.ts` and embedded with the CLI for offline use.
Add an entry matching the Axon release version when preparing a release. Global Pi installations
and Pi's own packaged `CHANGELOG.md` are never changed.

### Managed npm registry fallback

Pi runtime installation and Axon's required **npm** extension installs try the configured npm registry first (`npm_config_registry` / `NPM_CONFIG_REGISTRY` or npm's `.npmrc` configuration, including a package's scope). If the active registry is `https://registry.npmjs.org/` or `https://registry.yarnpkg.com/` and a registry/network request fails, Axon retries the same installation **once** with the other registry. This includes missing packages/versions (404 / `ETARGET`) and temporary network/server errors. The retry is announced on stderr. For example, to prefer the Yarn registry and fall back to npmjs:

```bash
npm_config_registry=https://registry.yarnpkg.com/ axon setup pi --sync-packages
```

Fallback only changes the subprocess environment and public tarball URLs in Axon's managed lockfiles; package versions and integrity hashes stay unchanged. It never changes global npm configuration or `.npmrc`. Custom/private registries, authentication/permission failures, integrity failures, dependency conflicts, lifecycle-script failures, and cancelled processes do not trigger fallback. A custom Pi `npmCommand` owns its own retry policy. Healthy installed packages remain local-only, and offline/diagnostic commands never install.

This policy covers Axon's bootstrap and required-package synchronization, not user-forwarded `axon pi install` commands. Git packages and explicit non-public tarball URLs are unchanged. Pi release metadata and lockfiles still require access to `https://pi.dev/api/installer/releases/`; changing npm registries cannot bypass a failure there.

### Corporate TLS certificates (Zscaler)

Axon keeps HTTPS certificate verification enabled. Before telemetry, authentication, updates, or Pi installation, it prepares company CA trust when no explicit `NODE_EXTRA_CA_CERTS` setting exists:

1. If `SSL_CERT_FILE` is set, use its PEM CA certificates without consulting Keychain or the local fallback. An explicitly empty setting is preserved.
2. Otherwise, on macOS, export certificates named **Zscaler Root CA** from `/Library/Keychains/System.keychain` using `/usr/bin/security`, with a one-second timeout.
3. If Keychain discovery is unavailable, use `~/certs/ZscalerRootCertificate.crt` when present. Other platforms use this local fallback without querying Keychain.
4. Validate the additional PEM certificates as CAs and combine them with Bun's bundled public CA roots. No Python/certifi installation is required.

The combined bundle is atomically written to `${AXON_HOME}/certs/combined-<sha256>.pem` with owner-only permissions, never to a shared temporary filename. Axon then restarts itself in place once with `NODE_EXTRA_CA_CERTS` pointing to the bundle and, unless already configured, `SSL_CERT_FILE` pointing to it too. This is necessary because Bun reads CA environment variables at process startup; changing them after startup or calling `node:tls.setDefaultCACertificates()` does not configure Bun's `fetch()`. The restart preserves PID, terminal, cwd, arguments, and exit/signal behavior on supported macOS releases. npm and Pi inherit the CA environment.

An existing `NODE_EXTRA_CA_CERTS` setting takes precedence and skips automatic discovery and restart, including when explicitly empty. npm-specific CA overrides are not changed. If no company certificate is available, startup continues with normal runtime trust. If certificate preparation fails, Axon warns and retains certificate verification; it never enables a TLS bypass. `AXON_DEBUG=1` prints the selected certificate source, generated bundle path, and setup failure details on stderr. Certificates must come from your organization's approved trust configuration; Axon does not download or install new system roots or change shell profiles.

For an explicitly supplied company CA bundle:

```bash
NODE_EXTRA_CA_CERTS="/absolute/path/to/company-ca.pem" axon setup pi --sync-packages
```

This configures trust for Axon and its subprocesses. It cannot bypass a proxy's domain/download block. The shell installer (`curl ... | sh`) runs before Axon and still needs a working system/curl trust configuration.

### Pi version during development

Change [`pi-version.json`](pi-version.json) to change the default and future built CLI pin. Keep the exact `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` development dependencies in `package.json` aligned, run `bun install` from the workspace root to update `bun.lock`, and run `bun run --cwd apps/cli pi-version:check`. The CLI check and release build reject mismatches.

To try a different *exact* Pi version temporarily without changing the checked-in default, run from `apps/cli`:

```bash
AXON_PI_VERSION=0.87.1 bun run src/index.ts pi --version
```

This works **only for source runs**: the selected version is installed into its own `${AXON_HOME}/pi-runtime/<version>` directory and does not touch the global Pi or the default managed version. Test the bundled extensions and packages against the selected version. A compiled CLI (including `bun run build`) always uses its build-time `pi-version.json` value, even if `AXON_PI_VERSION` is set at runtime. `axon pi update` remains blocked in both modes.

### Pi data isolation

Every `axon pi` launch sets:

```text
PI_CODING_AGENT_DIR=${AXON_HOME}/pi
PI_CODING_AGENT_SESSION_DIR=${AXON_HOME}/pi/sessions
```

With the default Axon home, these resolve to `~/.axon/pi` and `~/.axon/pi/sessions`. Pi settings, auth, installed npm/git packages, temporary package caches, and sessions used through Axon therefore remain separate from the user's normal `~/.pi/agent` directory. The values override inherited `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` settings, including for forwarded Pi package commands.

Pi launches set `PI_SKIP_VERSION_CHECK=1` to disable Pi's startup version request. They also remove every provider API-key variable documented by Pi (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, and the rest of the list exported as `PI_STRIPPED_PROVIDER_VARIABLES` in [`src/harnesses/pi/environment.ts`](src/harnesses/pi/environment.ts)) so ambient personal credentials never select a provider implicitly. `LITELLM_*` variables, `GOOGLE_APPLICATION_CREDENTIALS`, cloud SDK configuration, and proxy variables are kept because the pinned `pi-provider-litellm` package is the organization provider path. This provider-key policy applies to every `axon pi` launch without mutating `process.env`. The managed Axon extension also replaces the direct `amazon-bedrock` catalog with an empty model list, so AWS profiles (including SSO/role profiles), IAM/session credentials, container/web-identity credentials, and tokens saved by `/login amazon-bedrock` cannot expose direct Bedrock models. AWS environment variables and shared files remain available to tools; saved provider credentials are not deleted. Bedrock-backed models served through LiteLLM are unaffected.

The default `litellm` provider is labeled **Axon AI Gateway** in Pi. Set `LITELLM_DISPLAY_NAME` to customize it without editing settings:

```bash
LITELLM_DISPLAY_NAME="Company AI Gateway" axon pi
```

A `litellm.providers.litellm.displayName` value in Pi settings takes precedence over the environment variable. When the variable is unset, Axon supplies its branded default; explicit values are forwarded unchanged (empty, whitespace-only, or `"undefined"` values fall back to `LiteLLM` in the provider extension). Alias providers are unaffected, and the provider ID remains `litellm` for model references, authentication, and routing. No settings file is modified for this label.

Before an authenticated online Pi launch, Axon removes cached `litellm` models whose base URLs point to an obsolete Axon loopback relay. Otherwise Pi can restore the previous launch's random-port URLs over fresh discovery, causing “No models available.” Cleanup uses Pi's native model-store lock and an atomic write; other providers, unrelated LiteLLM endpoints, and current-relay models are preserved. Offline, administrative, and discovery-disabled launches leave the cache untouched. A busy or unsafe cache never blocks launch; use `/litellm-refresh` if models remain unavailable.

The managed LiteLLM provider preserves vendor-specific compatibility for models served through generic OpenAI-compatible adapters and falls back to `/v1/models` when `/model/info` is empty. Its four-hour startup catalog reuse requires the same proxy URL and discovery version. Axon creates a new random-port relay on each launch, so ordinary managed launches still discover models; the stale-relay cleanup above remains necessary. Stored models from an older discovery version are rediscovered online. Upgrading the provider from 4.7.3 to 4.8.0 changes the discovery version from 13 to 16.

The local authenticated relay accepts request bodies up to **50 MiB** (52,428,800 bytes), matching the
Nginx `50m` limit. This covers the full serialized payload, including conversation history, tool results,
and base64 images. The limit is currently hardcoded; responses and SSE remain streamed.

Relay connection/stream failures and upstream HTTP 5xx responses write sanitized JSON-line diagnostics
to `${AXON_HOME}/logs/relay.log` (default `~/.axon/logs/relay.log`). The log rotates at **1 MiB**, retaining
one backup, `relay.log.1`; files are owner-only (`0600`). Records contain timestamps, a generated
`cliSessionId` UUID shared by all requests from one CLI launch, generated request IDs, full endpoint
pathnames (including resource IDs), failure stage, status, duration, byte counts, and allowlisted error
types/codes. Headers, query strings, URL fragments, request/response bodies, and exception messages/stacks
are excluded. Resource identifiers and any other sensitive values embedded in pathnames are retained.
The CLI session ID changes on each launch, even when resuming a saved conversation, and is unrelated
to authentication credentials. To follow one launch across log rotation, use:

```bash
tail -n 100 -F "${AXON_HOME:-$HOME/.axon}/logs/relay.log" | grep --line-buffered '"cliSessionId":"<UUID>"'
```

The request ID is forwarded to the backend for correlation. Logging is best effort; a busy or unwritable
log never prevents retrying a model request. Intentional request cancellations are not logged as failures.
Error messages shown in Pi name the log home-relative (`~/...` or `$AXON_HOME/...`), never by absolute
path, because Pi stores error text in session history and backups.

Late stream failures are captured by the relay instead of letting Bun print raw socket errors over
Pi's input area. The HTTP stream still fails (it is not converted into a successful end-of-stream),
preserving normal client failure/retry handling. For managed `litellm` requests, the Axon extension
replaces opaque `terminated`/socket-drop errors with a concise connection error and the diagnostic log
path in Pi's normal error UI. Pi's `--verbose` controls startup output; the Bun error's `verbose: true`
suggestion is a different, potentially credential-revealing fetch option and is not enabled.

LiteLLM image-generation routes are available through Pi codemode's `models.generateImages()`, not `/model`, when every deployment in a `/model/info` route reports `mode: "image_generation"`. Requests use the same authenticated relay at `/litellm/v1/images/generations`. The provider accepts text prompts and base64 image responses only; reference-image editing and URL-only image responses are unsupported.

LiteLLM decision routes are available through codemode's `models.classify()`, not `/model`, with the
same authenticated relay at `/litellm/v1/systemone` (LiteLLM 1.104.2 or later). Every deployment in a
`/model/info` route must advertise `/v1/systemone` or `/v1/decisions` in `supported_endpoints`, or,
without an endpoint list, report `mode: "evaluation"` or `"decisions"`. A chat route advertising
decisions remains available for chat too. List usable classifiers with
`models.getAvailableOfType("classifier", "litellm")`. Classification accepts text state and typed
boolean, choice, or score questions; images are unsupported. Requests use managed authentication and
report the proxy's `x-litellm-response-cost` when present. This does not replace Axon's backend-owned
model recommender. Wildcard routes and `/v1/models` or `/health` discovery do not publish classifiers.

Claude-backed Messages or Chat routes with Anthropic cache markers now declare five-minute/one-hour
`promptCache` lifetimes. This enables Pi's existing cache warming when eligible; it is not a new
Axon default or a guarantee of savings. Pi defaults to warming during active runs and for up to 30 minutes between runs when expected to pay for itself
(`cacheWarming: "idle"`); `cacheWarming: "streaming"` restricts warming to active runs and `cacheWarming: "off"` disables it in the global settings.
Refresh requests are billable. GPT-5.6+ Responses routes now declare a 30-minute `short` lifetime
when every deployment is identified by backend metadata and routes through LiteLLM's `openai`,
`azure`, or `azure_ai` provider; Pi can refresh at about minute 27 when eligible. No `long`
lifetime is declared. GPT Chat routes, earlier/mixed GPT deployments, relay providers such as
OpenRouter or GitHub Copilot, and routes identified only by name are not eligible automatically.

Budget refusals now report `out of budget` without retrying; when interactive budget polling can
read the affected level, the error includes spend, limit, and local reset time. If the proxy refuses
MCP initialization because a budget is exhausted, its LiteLLM MCP server is registered disabled
for the session with one notice. After the budget resets, enable it in `/mcp` or restart Pi.

Axon continues to forward `LITELLM_*` variables. The provider now recognizes `LITELLM_PROVIDERS`, `LITELLM_PROVIDERS_JSON`, and `LITELLM_PROVIDER_<NAME>_*` as additional-provider configuration, so inherit them only when those extra proxy destinations are intended. Provider configuration in Pi's agent-directory `models.json` also participates in the extension's configuration precedence. For managed Axon requests, avoid overriding the default `litellm` provider's relay URL or credential through settings, `models.json`, or `/login litellm`; use `axon auth login` for Axon authentication.

### Backend-managed launch preferences

`CLI_CLIENT_CONFIG.PI.SHOW_CACHE_MISS_NOTICES` controls Pi's `showCacheMissNotices` setting in
`~/.axon/pi/settings.json`. It defaults to `true` when the backend manages Pi defaults; set it to
`false` to hide cache-related notices. Like codemode and model defaults, it is persisted on authenticated
online launches and refreshed on `/reload`. Omitted/null `PI`, offline/admin launches, and failed config
fetches leave the last local settings untouched. Trusted project settings can override this default.
See [Pi startup defaults](../backend/README.md#pi-startup-defaults) for the full backend configuration.

The authenticated config response can include partial `compaction`, `modelRecommender`, and
`litellmClient` objects. Each explicitly supplied backend field wins over inherited environment
values, including false and discovery timeout zero. Missing/null fields retain local values, then
existing extension/provider defaults. Removing a field restores that fallback on the next launch.

| Backend section / operator field | Child environment |
| --- | --- |
| `COMPACTION.ENABLED` | `PI_COMPACTION_ENABLED` |
| `COMPACTION.MODEL` | `PI_COMPACTION_MODEL` |
| `COMPACTION.THRESHOLD_TOKENS` | `PI_COMPACTION_THRESHOLD_TOKENS` |
| `COMPACTION.MAX_OUTPUT_TOKENS` | `PI_COMPACTION_MAX_OUTPUT_TOKENS` |
| `COMPACTION.TIMEOUT_MS` | `PI_COMPACTION_TIMEOUT_MS` |
| `MODEL_RECOMMENDER.ENABLED` | `PI_MODEL_RECOMMENDER_DISABLED` (inverted) |
| `MODEL_RECOMMENDER.TIMEOUT_MS` | `PI_MODEL_RECOMMENDER_TIMEOUT_MS` |
| `MODEL_RECOMMENDER.AUTO_SELECT_MS` | `PI_MODEL_RECOMMENDER_AUTO_SELECT_MS` |
| `LITELLM_CLIENT.DISCOVERY_TIMEOUT_MS` | `LITELLM_DISCOVERY_TIMEOUT_MS` |
| `LITELLM_CLIENT.DEFAULT_CONTEXT_WINDOW` | `LITELLM_DEFAULT_CONTEXT_WINDOW` |

These preferences apply only on the **next authenticated online non-administrative launch**, including
scripted modes. They do not mutate the launcher environment, persist to settings, poll, or refresh on
`/reload`; Pi's separate persisted startup-defaults/reload flow is unchanged. An invalid optional
section is ignored as a unit without discarding other valid sections. Offline/admin launches and
unavailable config keep local fallback; offline still suppresses managed search/telemetry/discovery.

Compaction enablement controls extension overrides, **not native automatic compaction**. Pi settings
still control automatic compaction and retention. Configured summaries retain model-registry/auth
checks, idle-only custom thresholds, native overflow recovery, and failure cancellation without
silently switching summary models. Pi 1.4 summaries use the model's output limit by default;
`compaction.reserveTokens` controls only when native compaction starts. An explicit
`COMPACTION.MAX_OUTPUT_TOKENS` / `PI_COMPACTION_MAX_OUTPUT_TOKENS` cap is clamped to the
selected summary model's known positive output limit. Positive limits are not a guarantee of
a sensible combination.
Recommender countdowns must be positive; backend recommendation eligibility/204 still takes priority.
Provider discovery timeout zero disables discovery (and affected integrations such as MCP). Context
window fallback only fills missing metadata; known per-model context/output limits are preserved.
The LiteLLM provider’s offline cache enrichment recognizes its built-in/current fallback
sentinels, but cannot reliably rewrite an older custom fallback without online discovery. Prefer
correct `/model/info` metadata over a global fallback.

For known backends, `providers.<catalog-provider>.modelOverrides.<backend-model>` in
`~/.axon/pi/models.json` can set `contextWindow` and `maxTokens` for every LiteLLM alias backed by
that model, when discovery identifies the same backend across deployments. The provider is Pi's
catalog provider, not necessarily the LiteLLM routing label. Overrides take effect on discovery
(`/litellm-refresh` or cache expiry); the minimum across deployments still applies. Without an
override, the smaller of catalog and explicit proxy limits remains the default.
`LITELLM_TRUST_PROXY_LIMITS=1` opts into explicit proxy limits instead; Axon forwards it but does not
enable it or add it to backend-managed launch preferences. Neither option increases actual backend
capacity, so only configure verified limits.

See [operator configuration](../backend/README.md#launch-only-compaction-recommender-and-provider-preferences)
and the [contract](docs/plans/backend-compaction-config.md). Deploy the updated CLI before relying on
backend-authoritative search/telemetry precedence; older clients retain their former local overrides.

### Remote clipboard copying

For a remote multiplexer attachment or remote IDE session where Pi cannot detect SSH,
opt in to copying text to the client terminal clipboard with OSC 52:

```bash
PI_CLIPBOARD_OSC52=1 axon pi
```

Axon forwards this variable unchanged. It is not enabled by default and requires a
client terminal that supports OSC 52. Pi still attempts the local clipboard write.

### Pi resources and required packages

Axon-owned extensions, skills, prompts, and themes are embedded in the CLI, materialized under `${AXON_HOME}/runtime/<version>-<hash>/pi`, and checksum-verified. Ordinary Pi sessions receive explicit resource arguments that reference that immutable directory, so a concurrently running launcher of another Axon version can never swap resources underneath a session. The `runtime/current` symlink is maintained for inspection only. The core extension provides `/axon-status`. In interactive sessions it also replaces Pi's startup header with an Axon connected-node logo, TATA 1mg branding, the launcher version, and a “Powered by Pi” attribution. Live backup status is right-aligned beside the wordmark without adding header lines, with theme-aware activity, success, and warning colors. Shortcut hints follow the active keybindings and wrap as complete groups instead of being clipped; the tool-expansion shortcut (normally Ctrl+O) expands the help, and `/hotkeys` lists all shortcuts. Narrow terminals use a compact text header, and long version labels yield space to backup status without hiding the Axon wordmark. Pi's `quietStartup: true` still hides the header, and RPC/JSON/print modes are unchanged. Resource source has an independent Pi extension typecheck.

The embedded `axon` skill (`src/harnesses/pi/resources/skills/axon/SKILL.md`) teaches the model Axon's commands, managed paths, environment variables, and troubleshooting steps. Pi lists it in the system prompt by description and reads it only when a task calls for it; `/skill:axon` forces it. It loads through `--skill`, so it stays available with `--no-skills`. Keep it a single file: every embedded resource gets its own flag, so bundled reference files would load as separate skills. Update it when commands, paths, or slash commands change.

A `[Tips]` section below the startup shortcuts shows one randomly selected tip per launch. Edit `src/product/tips.ts` to add or change tips; keep each tip to one or two lines at the standard header width. The selected tip stays the same during resizing, shortcut expansion, and live status updates. Tips are part of the startup header, so quiet startup hides them and RPC/JSON/print output is unchanged. Rebuild the CLI to include catalog changes.

Every non-administrative `axon pi` session also loads the embedded `pi-org-telemetry` extension. Its OpenTelemetry dependencies are bundled into one standalone ESM resource at Axon build time, so `--extension <immutable-path>` does **not** run `npm install`, execute dependency lifecycle scripts, contact a package registry, or download dependencies. A new Axon release materializes a new content-addressed bundle once; healthy launches verify and reuse it.

The telemetry extension stays inert without managed OTLP configuration. To export traces, metrics, and structured logs, configure the backend's `CLI_CLIENT_CONFIG.TELEMETRY` or provide `OTEL_EXPORTER_OTLP_ENDPOINT` (or all three per-signal endpoint variables) as a fallback in the environment used to start `axon`. A fetched policy uses only the pinned backend OTEL proxy with Axon session auth, clears inherited exporter authorization/TLS overrides, and cannot select an external destination for the session. The extension reads the session for each batch and safely persists rotations. Managed mode supports HTTP/protobuf; environment fallback supports HTTP/protobuf and gRPC with normal env headers/API keys. Export failures are passive and bounded. Accepted backend enablement wins over local `PI_ORG_OTEL_ENABLED`, samplers, and exporter preferences for both Pi and launcher product events, through shutdown; there is no managed local opt-out. Explicit offline disables export, and local disablement still applies without an accepted policy. This is separate from upstream Pi's `PI_TELEMETRY`. Backend `BATCH_SCHEDULE_DELAY_MS`, `MAX_EXPORT_BATCH_SIZE`, and `MAX_QUEUE_SIZE` control both Pi and launcher log/trace batching, overriding local batch tuning; `METRIC_EXPORT_INTERVAL_MS` controls metric cadence. Full batches and shutdown can export earlier than the configured delay. The extension never exports prompt/completion text, system prompts, file contents, tool results, provider payloads, authorization headers, environment values, full session paths, raw Git remotes, or stack traces. Managed mode exports backend-verified user ID/email, and optional name after server-side identity replacement; environment fallback exports raw effective Git email when available or an installation UUID. Both export the normalized private repository slug; collector access and retention must be restricted accordingly. See [`src/harnesses/pi/telemetry/README.md`](src/harnesses/pi/telemetry/README.md), its [data policy](src/harnesses/pi/telemetry/docs/data-policy.md), and its [schema](src/harnesses/pi/telemetry/docs/telemetry-schema.md).

The embedded manifest in `src/product/manifest.ts` declares required community packages. Pi 1.0 provides MCP support natively, so Axon no longer installs `pi-mcp-adapter`; upgrading to a CLI with this manifest removes the adapter on the next package synchronization when its ownership state and settings entry are unchanged. If it was adopted or modified, remove it manually with `axon pi remove npm:pi-mcp-adapter@2.34.0`. The manifest locks `pi-provider-litellm` to `4.8.0`, `@juicesharp/rpiv-ask-user-question` to `2.15.0`, and `git:github.com/earendil-works/pi-review` to commit `f1de050504936046c0f85b21fec0e0a93ef394eb`. The review package adds `/review` and `/end-review` for reviewing uncommitted changes, branches, commits, pull requests, or files/folders. Git must be installed to provision and verify Git packages; pull-request reviews also require the GitHub CLI (`gh`). Package entries support:

- `exact`: only the declared npm version or Git commit is accepted; a failed migration may use a verified, non-revoked last-known-good exact version
- `minimum`: the declared version is a hard floor; newer installed versions are accepted and never downgraded
- `floating`: no Axon version constraint; Pi or the user may update it at any time

Minimum and floating entries can still be updated explicitly with `axon pi install <source>` inside Axon's isolated Pi directory, but `axon pi update` is disabled to protect the executable pin. A direct `pi update` affects the user's separate global Pi and packages, not Axon's Pi packages. Axon does not query registries or schedule updates for healthy minimum/floating packages. It only installs a missing package, repairs a below-minimum package, or restores the required unfiltered settings entry. Exact versions change only with a new embedded Axon manifest.

A first ordinary interactive launch installs missing required packages with visible progress. Print, JSON/RPC, piped, CI, offline (`--offline` or `PI_OFFLINE=1`), and other non-interactive launches perform no package installation network work and instead direct the user to:

```bash
axon setup pi --sync-packages
```

Package checks inspect `${AXON_HOME}/pi/settings.json` and installed package metadata directly; they do not parse `pi list`. State is written to `${AXON_HOME}/pi-packages.json`, synchronization uses a same-user lock, and unrelated user package entries are preserved. If a later manifest removes a package, Axon removes it only when state and unchanged metadata prove it is still Axon-owned.

> **Security:** Pi packages run with full user permissions. Extensions, skills, dependency install scripts, and update commands can execute code. Treat every required package and manifest change as release-grade code.

See [`docs/plans/pi-package-provisioning.md`](docs/plans/pi-package-provisioning.md) for the manifest schema, lifecycle decisions, and verification plan.

### Terminal modes

Terminal execution defaults to **Standard** mode until the user saves a YOLO preference.
Supported commands run automatically when
the model sets `requires_approval: false`, including routine edits, builds, and tests.
Model-requested review, required-approval prefixes, custom shells, wrappers, and complex
shell syntax still require confirmation. Commands needing confirmation are refused when
no UI is available. `/terminal-permissions` shows the active mode and restrictions.

**YOLO** is fully autonomous terminal execution. The backend's
`TERMINAL_PERMISSIONS.YOLO_MODE: true` (public `yoloMode`) only permits users to enable it;
it never activates it by itself. Run **`/yolo`** with no arguments to toggle and save the
local user's preference, without an additional confirmation dialog. It applies to existing
and future sessions sharing the same user configuration directory, including headless
sessions. The header shows `YOLO` while active.
YOLO ignores model approval requests and required-approval lists, and allows wrappers,
custom shells, PowerShell, and complex syntax without prompts. The preference survives
session creation/replacement, shutdown, extension reload, and process restart. It is stored
in `$PI_CODING_AGENT_DIR/terminal-preferences.json` (normally `~/.axon/pi/terminal-preferences.json`),
not in project settings or conversation history. Missing, unreadable, or corrupt preferences
default to Standard. Every terminal authorization reads the latest preference; interactive
headers refresh within about half a second. Concurrent toggles are serialized across processes.
Backend `false`, missing policy, or a failed policy fetch prevents YOLO execution even with
a saved preference. These do not erase the preference. Environment variables cannot grant
eligibility; `PI_TERMINAL_YOLO_MODE` is no longer used. The tool prompt/schema stays static.

Literal-prefix blocklists remain **best-effort in both modes**, not OS isolation. Recognized
blocked commands are denied without prompting. In YOLO, scripts, wrappers, or syntax the
parser cannot understand may hide blocked operations and are allowed. Only subsequent
calls use a changed mode; toggling does not cancel running commands or approve dialogs
already waiting for a decision. Policy is fetched at launch, not continuously during a session.

The backend policy now contains only `YOLO_MODE` (eligibility), `REQUIRE_APPROVAL_COMMANDS`
(Standard only), `BLOCKED_COMMANDS`, and `APPROVAL_TIMEOUT_SECONDS`. Remove obsolete
`ALLOW_YOLO_MODE` and `AUTO_APPROVE_COMMANDS` entries from deployed configuration before
upgrading the backend; configuration validation rejects unknown fields.

### Organization MCP servers

Axon no longer writes organization MCP defaults into `~/.config/mcp/mcp.json` at launch.
Admins publish MCP servers in the admin dashboard's Catalog, and developers install them
from `axon hub` → Discover. Entries that the old launch-time sync added stay in
`~/.config/mcp/mcp.json` (disabled) until you remove them; Axon no longer changes that file.

## Development

Bun must be available in your shell. The repository pins Bun `1.4.1`. Dependencies are installed once at the monorepo root; everything else runs from this directory.

```bash
bun install --frozen-lockfile   # at the repository root
cd apps/cli
bun run check                   # generated extension bundle checks and typecheck
bun run test                    # test files in four isolated workers
bun run dev -- --version
bun run build
./dist/axon --version
```

`bun run test` (or `bun run test:cli` from the repository root) runs test files in four isolated worker processes, keeping tests within each file sequential to avoid races in environment variables and mocks. CI and release checks use the same command. For serial debugging, run `bun test`; to choose another worker count, run `bun test --parallel=2`.

Terminal permissions ship as a generated standalone `.mjs` asset so the launcher can import the TypeScript command validator without colliding with Bun's file loader. After editing `src/harnesses/pi/resources/extensions/terminal-permissions.ts`, run `bun run terminal:build` and commit the generated bundle. Development/release builds and `bun run check` reject stale bundles with `terminal:check`.

Formatting and lint run from the repository root with `biome ci .`, which the root `bun run check` includes.

Local development reads `AXON_SERVICE_ORIGIN` from the ignored `apps/cli/.env`. Copy `.env.example` in this directory when setting up a new checkout. Compiled release binaries receive a validated service base URL at build time and do not autoload project environment files. Despite its name, `AXON_SERVICE_ORIGIN` accepts an optional deployment path, such as `https://deputydev.ai/axon`, and preserves it for all backend requests. Use HTTPS without a trailing slash, credentials, query, or fragment; path segments must be plain URL-safe names (no encoded or dot segments).

Every package this app imports must be declared in `apps/cli/package.json`. Bun uses isolated installs in the workspace, so a transitive dependency of another package is not resolvable from here.

## Releasing

Publishing is **manual on native Apple Silicon macOS**. [GitHub Actions CI](../../.github/workflows/ci.yml) runs checks, tests, and a native development build with a binary smoke test, but does not publish. The retained GitHub Release workflow is separate and is not needed for this manual S3 release path. Releases use private S3, CloudFront signed GETs, and the backend's version configuration. Git tags can remain `cli-<semver>` for traceability, but no GitHub Release is created.

1. Configure the backend's ignored `config.json` following [CLI releases](../backend/README.md#cli-releases-macos-arm64-and-x64): HTTPS `CLI_INSTALL.RELEASES_URL`, S3 bucket and region, key prefix, a random 32+-character `UPLOAD_AUTH_KEY`, and CloudFront trusted key group, URL and RSA PEM. Provision S3/CloudFront OAC and IAM; start with `CLI_RELEASES.ENABLED=true` and `LATEST_VERSION=""` if there is no published version yet. Never commit real secrets.
2. On a trusted Apple Silicon Mac (with Rosetta installed only when building x64: `softwareupdate --install-rosetta`), update `apps/cli/package.json` to the desired canonical SemVer, merge and run the checks and installer tests. From `apps/cli`, set `RELEASE_VERSION` to that version, `BUILD_COMMIT` to the full tagged commit SHA, and `AXON_SERVICE_ORIGIN` to the production **HTTPS base URL** (optional deployment path, no trailing slash), for example `https://deputydev.ai/axon`. Run `bun run release:prepare-s3`. This validates the version/commit/origin, compiles the selected targets (`darwin-arm64` and `darwin-x64` by default), checks each architecture, ad-hoc signs them, runs each (x64 under Rosetta), and reproducibly gzips them. It then writes `release/checksums-<target>.txt`, the arm64-only `release/checksums.txt` that older launchers read, `release/VERSION`, `release/release-metadata.json`, and `release/cli-release-config.json`. The source map is copied locally; it need not be publicly distributed.
3. Add the entry from `release/cli-release-config.json` under `CLI_RELEASES.VERSIONS` in the ignored backend `config.json` **without changing `LATEST_VERSION`**. Restart the backend; test `GET /api/v1/cli/releases/<version>/checksums.txt`. The first release may have `LATEST_VERSION=""` until it is published. Do not reuse or overwrite an existing S3 version key.
4. Set `CLI_UPLOAD_AUTH_KEY` in the publishing shell to the same private upload secret as the backend, then run `bun run release:publish-s3`. Use the same `RELEASE_TARGETS` selection as preparation. It compares every selected target's backend checksums (and the legacy `checksums.txt`) with the prepared files before uploading anything. Then, per target, it asks the protected endpoint for a short-lived PUT, uploads with its mandatory checksum/immutability headers, and re-downloads the object via CloudFront to verify the archive hash. If a run stops part-way, rerun it: S3 refuses to overwrite an already uploaded key (HTTP 412), and the script then verifies that object's CloudFront hash instead. Treat the returned URL as a credential; never log it. If CDN verification fails, wait for any cached 404 to expire, then rerun or verify the exact-version CloudFront downloads and hashes manually; promote only after every target verifies.
5. Only after verification set `CLI_RELEASES.LATEST_VERSION` to the new version and restart the backend. Confirm `GET /api/v1/cli/releases/latest/VERSION`, run the public `/install.sh` path and `axon update --check` from a prior managed binary. Keep the old version's config/key for existing clients. With an enabled `LATEST_VERSION`, new installs and foreground/background updates discover the change on their next check.

The S3 scripts accept an optional comma-separated `RELEASE_TARGETS`. Set it to
`darwin-arm64` for an Apple Silicon-only release; leave it unset to build and publish both
architectures. Set it identically for preparation and publishing: publication rejects a
selection that differs from `release/cli-release-config.json` before making any network request.
Empty, duplicate, unsupported, and x64-only selections are rejected; arm64 is required by the
backend and legacy checksum endpoint. Arm64-only releases do not need Rosetta. Only selected
targets appear in generated metadata and are uploaded, even if old files for other targets
remain in `release/`.

**Arm64-only promotion:** `LATEST_VERSION` is global, not per architecture. Promoting an
arm64-only version makes Intel install/update asset requests return 404. Only promote it
when that limitation is intended; keep earlier x64 releases available by exact version.

For example, run preparation with `RELEASE_VERSION=0.2.0 BUILD_COMMIT=$(git rev-parse HEAD) AXON_SERVICE_ORIGIN=https://YOUR_ORIGIN bun run release:prepare-s3` and publication with `RELEASE_VERSION=0.2.0 AXON_SERVICE_ORIGIN=https://YOUR_ORIGIN CLI_UPLOAD_AUTH_KEY=<secret> bun run release:publish-s3` (prefer a secret manager over shell history). `RELEASE_KEY_PREFIX` is optional for preparation and must match backend `KEY_PREFIX`; the default is `cli/releases/`. The installer/updater release endpoints do not require a database.

For production under `/axon`, use the same base URL for preparation and publication:

```bash
# From apps/cli, after committing the intended release source.
export RELEASE_VERSION=0.2.0  # Must match package.json.
export BUILD_COMMIT="$(git rev-parse HEAD)"
export AXON_SERVICE_ORIGIN=https://deputydev.ai/axon
export RELEASE_KEY_PREFIX=axon-prod/cli/releases/
# Stop if checks or tests fail; do not prepare a release after a failed test run.
bun run check && bun run test && bun run release:prepare-s3

# Stage release/cli-release-config.json in backend CLI_RELEASES.VERSIONS,
# keep LATEST_VERSION unchanged, and restart the backend.
# Load CLI_UPLOAD_AUTH_KEY securely into the publishing shell, then:
bun run release:publish-s3
```

After upload/CDN verification succeeds, promote `CLI_RELEASES.LATEST_VERSION` and restart the backend. Set `CLI_INSTALL.RELEASES_URL=https://deputydev.ai/axon/api/v1/cli/releases`; the shell installer does not infer the binary's service base. Ingress must forward `/axon/*` to backend `/*`, stripping `/axon`. Auth, configuration, model/recommendation/search traffic, telemetry, backups, MCP discovery, and update/release requests all retain the public prefix; per-launch loopback relay URLs do not. See [base-path deployment](../backend/README.md#deployment-under-a-path-prefix) for backend settings and the deferred frontend follow-up.
