---
name: axon
description: How Axon (the `axon` launcher for Pi) works - its CLI and slash commands, where it keeps config, sessions, logs and credentials, and how to troubleshoot it. Use when the user asks about axon, Axon Hub, MCP servers or skills setup, sign-in, updates, session backups, models or the LiteLLM gateway, YOLO/terminal permissions, or anything broken in this Axon/Pi environment.
---

# Axon

You are running inside **Axon**: a launcher (`axon`) that starts a pinned, isolated copy of Pi with
organization-managed sign-in, models (through the LiteLLM "Axon AI Gateway"), extensions, telemetry
and session backups. Pi is the only harness. Treat this as the user's environment, not a Pi install.

## Ground rules

- Axon's Pi directory is `$PI_CODING_AGENT_DIR` (normally `~/.axon/pi`), **not** `~/.pi/agent`.
  User-level Pi config, MCP servers, skills and extensions go there. Project-local config still uses `.pi/`.
- `AXON_HOME` (default `~/.axon`) can move everything below. Run `axon paths` for the real locations
  before reading or editing files.
- Never edit `~/.axon/runtime/**` or `~/.axon/pi-runtime/**`. They are checksum-verified, immutable,
  and replaced by Axon; edits are lost or rejected.
- Never print, copy or paste the contents of the auth file (`~/.deputydev/*.json`) or any token.
- `axon pi update` is blocked on purpose. Axon updates itself with `axon update`.
- After changing user-level config (MCP, skills, extensions, settings), run `/reload` in the Pi session.

## Terminal commands

| Command | What it does |
|---|---|
| `axon` / `axon pi [pi args...]` | Start Pi. Everything after `pi` is passed to Pi unchanged. |
| `axon auth login [--browser]` | Sign in from the browser. |
| `axon auth status` | Verify the saved session online (refreshes expired tokens). |
| `axon auth logout` | Clear the local credential shared with DeputyDev. |
| `axon hub [--no-open]` | Local browser UI: My MCP servers, My skills, Discover (org catalog). |
| `axon sessions` | Guided menu to browse, restore or delete session backups. |
| `axon sessions list\|status\|retry\|restore\|delete` | Script-friendly backup subcommands. |
| `axon doctor [pi]` | Diagnose the launcher and Pi installation. |
| `axon paths` | Print every managed path. |
| `axon setup pi --sync-packages` | Install or repair Pi, required packages and resources. |
| `axon setup paseo` / `axon setup t3code` | Register Axon as a provider in Paseo / T3 Code. |
| `axon update [--check]` | Check for or install the latest verified release. |
| `axon uninstall [--remove-runtimes]` | Remove the managed binary; keeps sessions and settings. |
| `axon --version`, `axon harnesses` | Version; supported harness IDs. |

## Slash commands inside Pi

| Command | What it does |
|---|---|
| `/axon-hub` | Open Axon Hub from the session. |
| `/axon-status` | Confirm Axon-managed resources are active. |
| `/axon-login` | Sign in when the session started signed out (RPC/Paseo). |
| `/axon-backups [status\|retry]`, `/axon-backup-now` | Backup status, retry, or force a checkpoint. |
| `/changelog`, `/axon-changelog` | Axon release notes. |
| `/yolo` | Toggle saved autonomous terminal mode (only if the backend allows it). |
| `/terminal-permissions` | Show terminal mode, blocked and approval-required commands. |
| `/compaction-config` | Show compaction settings. |
| `/litellm-refresh` | Rediscover gateway models (use on "No models available"). |
| `/mcp` | Pi's MCP server list and toggles. |
| `/review`, `/end-review` | Code review of changes, branches, commits, PRs or files. |
| `/model`, `/reload`, `/hotkeys` | Standard Pi: switch model, reload resources, list shortcuts. |

## Paths

Default locations with `AXON_HOME=~/.axon`. Confirm with `axon paths`.

| Path | Contents |
|---|---|
| `~/.axon/bin/axon` | Managed binary (`axon.prev` is the previous version). |
| `~/.axon/bin/axon-pi` | Wrapper for apps that expect a plain Pi binary. |
| `~/.axon/pi/` | Pi agent dir (`PI_CODING_AGENT_DIR`). |
| `~/.axon/pi/settings.json` | Pi settings, including installed packages. |
| `~/.axon/pi/mcp.json` | User-level MCP servers. |
| `~/.axon/pi/models.json` | Pi model/provider overrides (e.g. `modelOverrides` for context limits). |
| `~/.axon/pi/skills/` | User skills (also read: `~/.agents/skills/`). |
| `~/.axon/pi/extensions/` | User extensions. |
| `~/.axon/pi/sessions/` | Session transcripts (`PI_CODING_AGENT_SESSION_DIR`). |
| `~/.axon/pi/terminal-preferences.json` | Saved YOLO preference. |
| `~/.axon/pi/axon-changelog.json` | Last Axon release notes seen. |
| `~/.axon/runtime/<version>-<hash>/pi/` | Embedded Axon extensions, themes and skills (read-only). |
| `~/.axon/pi-runtime/<pi-version>/` | Axon's pinned Pi install (read-only). |
| `~/.axon/logs/relay.log` | Gateway connection/5xx diagnostics (rotates to `relay.log.1`). |
| `~/.axon/certs/` | Generated CA bundle (Zscaler + public roots). |
| `~/.axon/session-backups/` | Local backup queue. |
| `~/.axon/pi-packages.json` | Required-package state. |
| `~/.axon/hub-catalog-installs.json` | MCP servers installed from the org catalog. |
| `~/.axon/state.json`, `update.json`, `hold.json` | Launcher, update and rollback-hold state. |
| `~/.axon/locks/` | Cross-process locks. |
| `~/.deputydev/<id>.json` | Sign-in credential shared with DeputyDev (never print it). |

## Environment variables

| Variable | Effect |
|---|---|
| `AXON_HOME` | Move Axon's managed data. Does not move the shared credential. |
| `AXON_DEBUG=1` | Redacted launch preview and certificate details on stderr. |
| `AXON_NO_UPDATE=1` | Skip the automatic update check at startup. |
| `AXON_WORKFLOW=<name>` | Tag telemetry and LiteLLM spend for an automated workflow. |
| `AXON_IGNORE_OFFLINE=1` | Turn offline launch requests from apps into normal online launches. |
| `LITELLM_ENABLE_MCP` / `_SKILLS` / `_BUDGET` | Override org settings for gateway MCP, Skill Hub and budget footer. |
| `LITELLM_DISPLAY_NAME` | Rename the "Axon AI Gateway" provider label. |
| `NODE_EXTRA_CA_CERTS` | Use an explicit company CA bundle instead of auto-detection. |
| `PI_CLIPBOARD_OSC52=1` | Copy to the client clipboard over SSH/remote terminals. |

Provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) are deliberately stripped. All models go
through the gateway; do not suggest adding personal keys.

## Troubleshooting

Start with `axon doctor` and `axon --version`, then match the symptom:

- **Sign-in prompts or "not signed in"**: `axon auth status`, then `axon auth login`. Axon checks the
  session online before every launch, so `--offline` / `PI_OFFLINE` launches fail by design.
- **"No models available" or a model is missing**: `/litellm-refresh`, then restart Pi. Model access
  and budgets are enforced by the gateway, not locally.
- **Connection drops, "terminated", 5xx from the gateway**: read the latest records in
  `~/.axon/logs/relay.log`. Filter by `cliSessionId` to follow one launch. Check VPN/Zscaler.
- **TLS or certificate errors (npm, fetch, Python tools)**: run with `AXON_DEBUG=1` to see the chosen
  CA source. Axon reads "Zscaler Root CA" from the System keychain, or `~/certs/ZscalerRootCertificate.crt`.
- **Required packages missing, or a non-interactive launch asks for setup**: `axon setup pi --sync-packages`.
- **MCP server not showing or failing**: check it in `axon hub` (My MCP servers) and `/mcp`, then `/reload`.
  Org servers come from Discover in `axon hub`, not from `~/.config/mcp/mcp.json`.
- **Skill not loading**: `axon hub` → My skills shows skipped, shadowed or invalid skills and why.
  A skill is a directory with `SKILL.md` and valid YAML frontmatter (`name`, `description`).
- **Commands blocked or always asking for approval**: `/terminal-permissions`. YOLO needs backend
  permission and is toggled with `/yolo`.
- **Backups paused or pending**: `/axon-backups status`, then `/axon-backups retry` or
  `axon sessions retry`. Backups are enabled by the administrator; users cannot turn them on or off.
- **Restoring a session**: `axon sessions` → restore, then run the printed `cd … && axon pi --session …`.
- **Update problems**: `axon update --check`, then `axon update`. The previous binary is kept as
  `~/.axon/bin/axon.prev`.
- **Using Axon from Paseo or T3 Code**: `axon setup paseo` / `axon setup t3code`, then restart the app
  and pick **Axon** as the provider.
