# RFC: Axon Safehouse — policies and user controls

**Status:** Informational; describes the current implementation, not proposed guarantees. Defaults below come from the checked-in backend settings/template, not a verified production deployment. `~` means the OS user's home; Axon storage defaults to `~/.axon` and can be relocated with `AXON_HOME`.

## 1. What it is and why it exists

Axon Safehouse is the mandatory **macOS OS-level sandbox** around Axon's managed Pi agent and its subprocesses. It uses pinned, SHA-256-verified Agent Safehouse **0.12.0** to generate a baseline, replaces its filesystem/network grants with Axon's rules, then executes through macOS Seatbelt (`sandbox-exec`). It is not a container, disposable checkout, or command blocklist.

| Problem | Solution provided |
| --- | --- |
| An agent or shell command reaches unrelated files or credentials | Default-deny filesystem access, explicit grants, and non-overridable protected paths |
| Code, dependencies, or Git history are changed unexpectedly | Project access modes, immutable installed-code paths, and separate Git-metadata permissions |
| Development commands need external APIs and local services | Normal sessions/workers allow outbound IP connections; listeners and general Unix sockets stay blocked. Administrators can select relay/proxy-only networking. |
| An agent grants itself more access or keeps old permissions | Human-reviewed, parent-owned permissions; active operations are revoked when settings change |
| A missing policy silently weakens isolation | Fresh backend authorization and fail-closed startup; no offline or disable switch |

## 2. Who controls which policies?

The backend publishes `axonSafehouse` through authenticated `GET /api/v1/cli/config`. Administrators configure `AXON_SAFEHOUSE` in the backend configuration; users cannot override these limits locally.

| Backend setting | Default | Administrator control |
| --- | --- | --- |
| `POLICY_ID` | `safehouse-v1` | Policy identifier |
| `MAX_SESSION_SECONDS` | `14400` (4 hours) | Authorization lifetime: 60–86400 seconds |
| `NETWORK` | `outbound` | Normal session/worker access to external APIs and local services; `relay-and-package-proxy` restores restricted egress. Setup/probes remain restricted in both modes. |
| `LOCAL_GIT` | `read-only` | `deny`, `read-only`, or `read-write` Git metadata |
| `REMOTE_GIT` / `REMOTE_GIT_HOSTS` | `false` / `[]` | Enable managed SSH tunnels and SSH-agent access for selected `github.com` / `bitbucket.org` hosts |
| `ALLOW_ADDITIONAL_READ_PATHS` | `true` | Permit user-added read-only paths |
| `ALLOW_ADDITIONAL_WRITE_PATHS` | `true` | Permit user-added read/write paths |
| `PACKAGE_REGISTRY_HOSTS` | `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org` | Select from these four hosts |
| `PACKAGE_GIT_HOSTS` | `["github.com"]` | Package-setup HTTPS access; supported hosts are GitHub and Bitbucket |
| `PROTECTED_PATHS` | `[]` | Add absolute or `~/` paths blocked for both reads and writes |

**Fixed by implementation:** schema version `1`, sandbox required, engine `safehouse`, built-in credential protections, installed-code write restrictions, and baseline runtime/process access. These are not administrator disable switches or user preferences. Additional-path flags govern extra user grants, not the default project/runtime grants. An omitted backend `AXON_SAFEHOUSE` section publishes the defaults above, including outbound networking for normal sessions/workers; an absent/invalid policy response is rejected, never replaced by cached/local permissions.

## 3. Filesystem: defaults and exceptions

Access starts denied across `/`. The following exceptions are then granted, subject to protected paths, Git restrictions, installed-code restrictions, and user denials. macOS ownership/permissions still apply; Safehouse does not grant root privileges.

### Default access

| Area | Effective access and reason |
| --- | --- |
| Selected project | **Read/write** for brokered tools by default, allowing edits, creates, and deletes. Pi's main UI process only reads project files; writes run in separate sandboxed workers. |
| Unrelated projects and ordinary home files | No automatic content access; require an explicit grant unless another baseline exception covers them. |
| `/Applications`, `/usr`, `/bin`, `/sbin`, `/opt`, `/System`, `/nix/store` | Read-only installed software, runtimes, and libraries. `/System` is readable through the installed-package grants, not just `/System/Library`. |
| `/Library/{Apple,Frameworks,Developer,Fonts,Java,Perl,Python,Ruby,R}` | Readable runtime/library locations; installed-package locations remain write-protected. |
| `/private/etc/{ssl,hosts,resolv.conf,services,protocols,localtime,shells}` | Readable certificates, resolver, network, timezone, and shell data; not a grant to all of `/etc`. |
| `/tmp`, `/var`, OS temporary directory, per-run temporary directory | **Read/write**, resolving aliases to canonical paths such as `/private/tmp` and `/private/var`. Supports temporary files, caches, and runtime state. Protected/package exclusions still apply. |
| `/dev` | Readable devices; writes only to `/dev/fd`, `/dev/stdout`, `/dev/stderr`, `/dev/null`, `/dev/tty`, `/dev/ptmx`, and matching `/dev/ttys*` / `/dev/pty*` paths. |
| `~/.agents`, `~/.claude`, `~/.paseo` | Default read/write for operation workers; read-only to the main Pi process. Installed-code subtrees, including `.claude/local` and `.claude/plugins`, remain write-protected. |
| Installed dependencies and user package stores | Readable, not writable: project dependency trees and conventional Node, Python, Rust, Go, Ruby, and other package/runtime stores. `~/.local/bin` is a nominal default write grant, but the installed-code restriction makes it **read-only**. |
| Axon-managed Pi/runtime directories | Readable runtime/configuration; only the specific persistent-state writes below are allowed during normal sessions. Explicit extension/MCP launch files may also receive file-only read access. |

<details>
<summary>Complete built-in user package-store inventory (read-only)</summary>

Brace groups below abbreviate individual paths, not arbitrary descendants of their parent:

- `~/.local/{bin,lib,pipx/venvs,share/pipx/venvs,share/uv/tools,share/claude,share/pnpm,share/fnm/node-versions}`; `~/.claude/{local,plugins}`.
- `~/.bun/{bin,install/global}`, `~/.npm-global`, `~/.nvm/versions`, `~/.fnm/node-versions`, `~/.volta/tools`, `~/.asdf/installs`.
- `~/.pyenv/versions`, `~/.conda/envs`, `~/.local/share/mamba/envs`, `~/anaconda3`, `~/miniconda3`, `~/miniforge3`, `~/mambaforge`.
- `~/.rbenv/versions`, `~/.gem`, `~/.cargo/{bin,registry,git}`, `~/.rustup/toolchains`, `~/.luarocks`, `~/go/{bin,pkg}`.
- `~/Applications`, `~/Library/{pnpm,Python,R,Java/JavaVirtualMachines}`.

Canonical dependency roots, external installed-package symlink targets, discovered Node/Python runtime library roots, and Bun/uv executables are also protected. Optional `git-ai` exposes only its resolved executable, not all of `~/.git-ai`. Within broadly writable `/var`, `/private/var/db/{receipts,pkg}` and `/private/var/lib/{dpkg,rpm}` are installed-code write exclusions.

</details>

Literal root/ancestor-directory reads or metadata access support path resolution and `getcwd`; they do **not** recursively expose parent contents.

**Important breadth:** `/var` is broadly read/write, not just a private cache. This includes paths such as `/private/var/db/timezone`, `/private/var/db/dyld`, and `/private/var/select`, except protected/package exclusions. Do not describe the current implementation as “only the project and a private temp directory are writable.”

### Required persistent Pi state

The main Pi session can read/write `~/.axon/pi/{sessions,pi-org-telemetry,agents}` and these files: `auth.json`, `settings.json`, `trust.json`, `models.json`, `models-store.json`, `litellm-models-dev.json`, and `axon-changelog.json`, including their lock paths and narrowly matched atomic-write temporary files.

This preserves chat resume, model/auth settings, trust decisions, telemetry state, and agent definitions. Users cannot deny these essential state paths. The UI retains access to **sessions across projects** for the picker/resume workflow; operation workers cannot read session transcripts or Pi `auth.json`. Pi auth state is distinct from the protected shared Axon login credential.

### Protected and blocked paths

**Always blocked for content reads and writes, even inside a broader user grant:**

- `~/.deputydev`, `~/.ssh`, `~/.aws`, `~/.gnupg`.
- `~/.config/{gcloud,gh,nix}`, `~/.git-credentials`, `~/.gitconfig`, `~/.npmrc`, `~/.pypirc`, `~/.netrc`, `~/Library/Keychains`.
- Axon's shared-auth directory, `~/.axon/{bin,staged,locks}`, and `~/.axon/axon-safehouse/filesystem`.
- All backend `PROTECTED_PATHS` and user-denied paths. Conflicts with essential Pi state can prevent startup rather than weaken protection.

**Write-protected installed code:** Axon/Pi/Safehouse runtimes, Pi package/extension executables, system/user package stores, and dependency components including `node_modules`, `.venv`, `venv`, `__pypackages__`, `site-packages`, `dist-packages`, `vendor`, `bower_components`, `.pi/{npm,git,bin,extensions}`, `.yarn/{cache,unplugged}`, and `.pnp.cjs` / `.pnp.loader.mjs`. Newly created dependency paths and resolved installed-package symlink targets are covered; editable workspace source links remain governed by project permissions.

**Blocked by default, not necessarily immutable:** unlisted locations such as `/private/etc/ssh`, `/private/etc/sudoers`, `/private/etc/master.passwd`, and `/private/root`. A permitted user grant can expose otherwise unlisted paths; immutable protections and OS permissions still win. Project `.env` files are **not automatically protected**—deny sensitive project files explicitly.

## 4. Git, network, and package setup

- **Local Git:** `read-only` permits inspection such as log/diff/status but blocks `.git` writes, including staging, commits, resets, and new repository metadata. `deny` blocks metadata reads too; `read-write` permits metadata changes within applicable filesystem grants. Linked-worktree/common metadata is resolved; symlinked `.git` markers are rejected. Source files remain editable independently of Git-metadata permissions. Read-only project/path rules still override Git write permission.
- **Managed remote Git:** off by default. Enabling it also requires a nonempty approved host list. Axon creates per-host loopback tunnels to public port 22 and a restricted SSH configuration. Authentication may use the existing SSH agent, without exposing private-key files or user SSH configuration. Public `known_hosts` data is copied by the parent for strict host verification; forwarding and SSH hooks are disabled. This is host-level access, not repository- or read-only/push authorization. In `outbound` mode, these settings govern managed tunnels and SSH-agent exposure, not all Git traffic: direct network Git access is possible subject to available credentials and filesystem permissions.
- **Ordinary network:** `NETWORK: "outbound"` is the default. Normal Pi sessions and operation workers can make direct outbound IP connections to external APIs, private-network services, and localhost services such as HTTP servers, Postgres, and Redis. Native DNS resolution through mDNSResponder is allowed. Network listeners, general Unix-domain sockets, and system sockets remain blocked; use TCP addresses for local databases. Provisioning, administration, and catalog probes do not receive these broad grants.
- **Restricted network option:** `NETWORK: "relay-and-package-proxy"` blocks arbitrary external and localhost connections. In either mode, the main Pi session uses a capability-authenticated parent relay for managed APIs, login, and related services; workers do not inherit that relay capability or managed-provider credentials. Ambient credentials and injection variables are excluded by building an allowlisted environment.
- **Package proxy:** an authenticated HTTPS CONNECT proxy permits only approved hosts on port 443. Private/local/reserved IPv4 DNS destinations are rejected and checked addresses are pinned. This is a **host/port boundary for proxy traffic**, not inspection of encrypted requests or a package-name allowlist. Normal outbound-mode sessions/workers connect directly and are not constrained by this proxy's host list.
- **Package setup is separate:** provisioning/administration receives a different proxy capability that also permits `PACKAGE_GIT_HOSTS`; normal sessions/workers do not get those extra HTTPS Git hosts. Narrow write exceptions cover managed runtime staging and Pi `npm`, `git`, `settings.json`, and lock targets, including project-local `.pi` administration. Setup may create the trust-store lock, not change trust decisions through that exception. This does not make ordinary `npm install` / `pip install` into protected dependency trees writable. Probes/provisioning do not inherit project grants; administration can read a selected project but grants writes only to approved setup targets plus baseline runtime exceptions. Global administration from home uses a private working directory, not a home grant; catalog probes cannot operate on projects or edit permissions.
- **Environment and integrations:** only absolute `PATH` entries survive; shell defaults to `/bin/sh`, caches/temp variables point into per-run storage, and proxy variables are parent-controlled. Normal outbound-mode sessions/workers receive no forced HTTP proxy; restricted sessions and package setup retain their scoped proxy settings. System/global Git configuration and interactive credential prompts are disabled. Configured CA certificates are copied into the sandbox rather than granting their source directory. Normal Pi sessions receive native clipboard access; workers, installers, and catalog probes do not. Generic application opening (`lsopen`) remains denied inside the sandbox; browser login is parent-managed.

## 5. What users can change

Run **`/safehouse` inside an idle Axon Pi session** (terminal or supported RPC/Paseo UI):

- Set the project to **read-only** or **read/write**; new Axon runs default to read/write with no extra path rules.
- Add existing files/directories as read-only or read/write, if backend policy permits; block paths; change or remove explicit rules.
- Review and confirm before saving. Removing a rule restores inherited/baseline access; it is not the same as blocking a path.

Grants cannot cover `/`, the entire home, Axon storage, or ancestors containing home/Axon storage. The same root/home/Axon-storage constraints apply when selecting a project. Paths are canonicalized; protected descendants remain excluded from broader grants. **Denials/protections override grants; read-only restrictions override writes.** Exclusions are built into every allow rule, not just appended as broad denies, because macOS may prefer a more-specific allow.

Only regular files/directories may be granted; new grants must exist, while deny targets may be absent. Symlinks are resolved and rechecked at save; stale editors or changed paths cannot silently redirect consent. A path has one explicit mode. Each read/write/deny list allows at most **64 entries**, each path at most **4096 characters**, and the complete preference object at most **64 KiB**; control characters are rejected. Backend protected paths also have a 64-entry limit.

Changes live only in the **current parent Axon process's memory**, scoped by project. They are not persisted, shared with another Axon process, or restored with a chat. Saving revokes active operations/background groups, invalidates profiles, and restarts Pi to resume the validated conversation under the new rules. The parent run keeps its original authorization expiry.

`axon safehouse show` (optionally `--json`) shows **new-run defaults**, not another process's live permissions or the complete runtime sandbox. Standalone mutation commands refuse changes and direct users to `/safehouse`.

Users cannot disable Safehouse, extend its lease, bypass protected/package paths, or change network/Git/backend policy. Terminal approvals and `/yolo` are a separate layer: YOLO can skip eligible approval prompts, **not OS sandbox restrictions**.

### User-control screenshots — images to be added

**Figure 1 — TUI: `/safehouse` permission editor**

> **[TUI IMAGE PLACEHOLDER]** Add a terminal screenshot showing current project access, read-only/read-write/blocked path rules, and the **Review changes and save → Apply permissions** confirmation. Use multiple images here if needed to show the review screen.

<!-- Add TUI image(s) here. Suggested Markdown: ![TUI Safehouse permissions and save confirmation](images/safehouse-tui.png) -->

**Figure 2 — GUI: Safehouse controls in the RPC/Paseo client**

> **[GUI IMAGE PLACEHOLDER]** Add a screenshot showing the same `/safehouse` choices in client dialogs, the reviewed changes, and confirmation that the chat resumed under the new permissions. These are user filesystem controls, not an administrator policy-management page.

<!-- Add GUI image(s) here. Suggested Markdown: ![GUI Safehouse permission dialogs](images/safehouse-gui.png) -->

Both interfaces use parent-owned choices and validation. An agent request cannot supply grants directly; cancelling discards the draft. Editing waits for idle chat/no pending approvals, and RPC editing blocks new mutating requests until save/cancel/restart completes. Resume files are checked for ownership, location, symlinks/hardlinks, and matching session identity; an unsaved in-memory chat must be saved before an RPC restart.

## 6. Terminal approval policies (separate from OS isolation)

The backend's optional `TERMINAL_PERMISSIONS` section controls the approval guard. Its template/default values are:

| Setting | Default | Meaning |
| --- | --- | --- |
| `YOLO_MODE` | `false` | Eligibility to enable YOLO, not automatic activation |
| `REQUIRE_APPROVAL_COMMANDS` | `[]` | Literal command prefixes requiring review in Standard mode |
| `BLOCKED_COMMANDS` | `[]` | Recognized literal command prefixes denied even in YOLO |
| `APPROVAL_TIMEOUT_SECONDS` | `60` | Queue + dialog deadline; configurable 1–300 seconds |

Lists accept at most 32 prefixes, each at most 96 characters; these are not regex policies. Managed settings override local command-list/timeout variables. Without this optional section, local approval-list/timeout defaults apply and YOLO eligibility remains off; malformed terminal configuration blocks execution, without disabling Safehouse.

Standard mode auto-runs supported routine commands; model-requested review, required prefixes, custom shells, wrappers, and unverifiable syntax trigger approval. With a nonempty blocklist, unverifiable syntax/wrappers are blocked instead. Approval denied, cancelled, timed out, unavailable in a headless session, or exceeding the 32-waiter queue means **no execution**. Model/nested shell calls require explicit boolean approval intent; user-entered shell commands also pass through the guard.

Users inspect `/terminal-permissions` and toggle `/yolo` when eligible. YOLO skips review, including for complex syntax, but still rejects recognized blocked commands and invalid requests; blocklists cannot inspect arbitrary scripts/wrappers and are **not a security boundary**. Its preference is designed to persist in `~/.axon/pi/terminal-preferences.json`, shared by local sessions, unlike temporary Safehouse grants. Missing/corrupt consent defaults to Standard; switching modes affects subsequent commands, not already-running work/open approvals.

**YOLO remains inside Safehouse:** it changes terminal approval behavior only. Commands still run under the same OS sandbox; YOLO cannot expand filesystem access, enable additional network destinations, change Git permissions, or bypass backend protections.

## 7. Lifecycle, runtime safeguards, and boundaries

1. Fetch fresh backend policy; verify/download the pinned runtime; generate and validate a sandbox profile before executing Pi.
2. Launch Pi and broker read/write/edit/grep/find/ls/shell requests into separately sandboxed workers. Signed-out RPC may bootstrap the login UI, but project operations require authenticated authorization matching the compiled policy.
3. Revalidate backend policy before saving permissions. A changed backend boundary requires a **new Axon invocation**; editing permissions neither replaces it nor renews authorization. This is not continuous backend push revocation.
4. On expiry/closure, terminate owned commands and close proxies. Missing/invalid policy, unsupported OS, integrity failure, or profile failure stops execution—never launches unsandboxed.

| Additional safeguard | Current rule / purpose |
| --- | --- |
| Runtime/profile integrity | Runtime must be a user-owned regular non-symlink file with the pinned digest; downloads are bounded to 1 MiB. Project Safehouse config is not trusted. Unsafe baseline grants are removed/rejected; each profile is checked with sandboxed `pwd` before launch. |
| Worker authority and limits | Only seven known operation types; parent-owned executable/environment, not caller-supplied host credentials/modules. At most 8 active requests; 10 MiB operation payload, 1 MiB shell command, 16 MiB retained output per stream. File mutations are serialized. |
| Time/process ownership | File tools and probes default to 5-minute deadlines; shells have no shorter default deadline and installs are lease-bounded. Cancellation/permission changes stop owned operation groups, including tracked background jobs. Installers cannot retain descendants with provisioning grants after completion. |
| Proxy resources | HTTPS proxy: 64 connections; SSH: 16 per host; 90-second socket inactivity timeout. Closing the invocation destroys its proxies/sockets. |
| UI trust boundary | Main session has the managed relay/clipboard/Pi-state capabilities; workers do not. RPC UI messages are bounded to 50 MiB and private control requests time out after 30 seconds. The parent validates replies and resume state; chat text cannot become host argv or permission grants. |

**Limits:** allowed operations modify real files; there is no rollback. Baseline runtime/package reads and `/var` writes are broader than project-only isolation. Outbound mode permits arbitrary external, private-network, and local-service destinations; it is not an exfiltration boundary and can reach unauthenticated local services. Restricted-mode approved destinations and SSH-agent access also carry risk. This boundary covers managed agent subprocesses, not the trusted parent launcher or programs you run independently. It does not itself redact secrets already in project files/transcripts or configure backup, telemetry, model, or application-level authorization policies; those remain separate features.

**Implementation references:** [backend policy](../apps/backend/app/core/axon_safehouse.py), [backend template](../apps/backend/config_template.json), [filesystem/user grants](../apps/cli/src/axon-safehouse/filesystem.ts), [effective sandbox rules](../apps/cli/src/axon-safehouse/launch.ts), [full package-store path lists](../apps/cli/src/axon-safehouse/packages.ts), [network proxy](../apps/cli/src/axon-safehouse/package-proxy.ts), [authorization/lifecycle](../apps/cli/src/axon-safehouse/session.ts), [permission editor](../apps/cli/src/cli/commands/axon-safehouse.ts), [terminal policy](../apps/backend/app/core/terminal_permissions.py), [terminal enforcement](../apps/cli/src/harnesses/pi/resources/extensions/terminal-permissions.ts).