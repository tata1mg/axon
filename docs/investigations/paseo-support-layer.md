# Axon + Paseo 0.13.1: no-fork support-layer investigation

## Conclusion

**Axon can provide model recommendations, in-chat authentication recovery, and Axon-specific status UI without a Paseo fork.** The recommended design is:

1. Keep the existing Paseo provider that extends `pi` and runs `axon pi`.
2. Make Axon's extensions distinguish terminal presentation from RPC presentation.
3. Add an optional **Axon companion plugin** for Paseo's desktop, web, and mobile clients.
4. Connect the plugin and the Axon runtime through a small, authenticated, daemon-local control channel. Do not replace or modify Pi's standard-input/output protocol.

The plugin is a presentation and interaction layer, not a second model gateway, credential store, terminal-permission authority, or replacement coding-agent provider.

**A companion plugin alone cannot make arbitrary terminal extensions render in Paseo.** Axon must expose the relevant state and actions. Basic dialogs can work without a plugin; richer UI and sign-in on the viewing device need an explicit integration.

## 1. Scope and evidence boundary

Investigation date: **2026-10-26**.

Verified:

- The user successfully configured an `axon` provider inheriting Paseo's `pi` provider and confirmed it appears in Paseo.
- Local `paseo --version` reports **0.13.1**.
- The installed `/Applications/Paseo.app/Contents/Resources/app.asar` identifies the desktop app and bundled `@getpaseo/plugin` package as **0.13.1**.
- Read-only inspection of that archive confirms the bundled Pi launch and extension-dialog mapping described below.
- Versioned upstream documentation and source were inspected at **`getpaseo/paseo`, tag `v0.13.1`**, rather than assuming the latest website matches the installation.
- Axon's installed development Pi dependency is **1.4.0**. Its packaged RPC documentation and implementation were inspected locally.
- Axon source was inspected at checkout **`d8ea34af` plus pre-existing working-tree changes**. Some package/manifest edits were in progress; the working tree is not evidence that an installed Axon binary contains those edits.

Not verified:

- The version or behavior of the phone's Paseo client.
- End-to-end plugin loading, mobile UI rendering, real model recommendation requests, or an actual expired-credential recovery in Paseo.
- The initiating cause of the user's missing re-login experience.
- A released Axon/Paseo compatibility matrix beyond the inspected versions.

This task creates **this document only**. It does not install dependencies, scaffold a plugin, change Axon implementation, edit Paseo configuration, enable plugins, modify the installed app, or invalidate credentials.

## 2. What is retained today, and what is missing

The current process path is:

```text
Paseo desktop / web / mobile
    -> Paseo daemon
    -> existing Pi provider adapter
    -> axon pi --mode rpc [Paseo-generated session/model/extension arguments]
    -> Axon-managed Pi runtime + extensions
    -> Axon authenticated relay and backend
```

Paseo's Pi launcher appends `--mode rpc` when no mode flag is present. Its command override supports the existing `axon pi` prefix, so a new provider implementation is unnecessary for basic connectivity.

| Capability | Current evidence | Support-layer work |
| --- | --- | --- |
| Managed Pi resources and provider | Axon's adapter injects resources and prepares its managed environment for non-administrative launches, including RPC | Retain this launch path; do not launch standalone Pi instead |
| Managed model gateway and silent token refresh | Owned by Axon's launcher/relay, not by its terminal header | Retain; do not copy credentials into the plugin client |
| First-task model recommender | Explicitly skips RPC input; its network loader and picker both use custom terminal UI | Separate request/decision logic from rendering and add supported RPC presentation |
| In-chat login prompt | Recovery watcher is not TUI-only and uses a standard selection dialog | Diagnose missing prompts; add explicit presentation ownership for companion mode |
| Browser sign-in from a phone | Current login opens the browser on the daemon host | Separate login creation/polling from browser opening; deliver an ephemeral approval URL to the viewing client |
| Terminal approvals | Axon uses `ctx.ui.confirm`; Paseo maps that RPC method | Keep existing enforcement and approval semantics; a plugin must not auto-approve them |
| Backup capture | Uses Pi lifecycle hooks and its own queue/API | Retain capture; separately expose sanitized status |
| Backup/terminal indicators | Current indicators use an in-process event bus and custom terminal header | Add a state bridge and plugin UI; the event bus does not cross processes |
| Web search, compaction, git-ai, telemetry | Backend/tool/lifecycle behavior is not inherently dependent on rendering the terminal header | Validate individually; do not describe all extensions as removed |
| Ask-user and other package UI | Paseo has selected Pi-extension-specific mappings, not universal terminal rendering | Check the actual managed package versions and supported dialog behavior |
| Organization MCP setup | Axon skips ordinary interactive-only setup work on RPC launches | Preserve explicit initial setup; do not mistake a missing setup sync for loss of the runtime integration |

### 2.1 Definite recommender blockers

In `apps/cli/src/harnesses/pi/resources/extensions/model-recommender.ts`:

- The `input` handler requires `ctx.mode === "tui"`.
- It requires `event.source === "interactive"`; Pi RPC sends source `"rpc"`.
- `requestRemoteRecommendations` performs its fetch inside `ctx.ui.custom` with a `BorderedLoader`.
- `showModelSelector` also uses `ctx.ui.custom` and a terminal `SelectList`.

Pi 1.4.0 documents that `custom()` returns `undefined` in RPC mode. Removing the mode guard alone would therefore still not make the feature work.

The existing first-task/resumed-session behavior, image compatibility filtering, backend enablement, bounded request, model validation, and telemetry outcomes should remain authoritative.

### 2.2 Re-login is not proven to be disabled by RPC

In `apps/cli/src/harnesses/pi/resources/extensions/axon.ts`:

- `session_start` starts `watchSessionRecovery` before the TUI-only header branch.
- The watcher requires `ctx.hasUI`, not `ctx.mode === "tui"`.
- Pi 1.4.0 explicitly documents **`hasUI === true` in RPC mode**.
- The prompt uses `ctx.ui.select`, a method Paseo 0.13.1 maps into an interactive question.

The existing recovery design also has important conditions:

- `session-recovery.ts` requires a recent UI heartbeat. Its status endpoint extends a **10-second** window; the extension normally polls every **one second**.
- Recovery has a **five-minute** budget and coordinates multiple waiting requests.
- `request-relay.ts` enables recovery for `/litellm/` requests, not recommendation requests. This intentionally avoids opening a login dialog over the recommendation picker.
- The real shared credential stays with Axon; the Pi child receives a per-launch loopback capability.

Before changing recovery logic, establish which stage is missing: extension loading, polling/heartbeat, authentication failure classification, pending recovery creation, dialog delivery, browser opening, or verification.

A separate limitation is established: `runAuthLogin` always calls the daemon host's OS browser opener after creating the login. That is not a phone-accessible login UI.

## 3. Paseo 0.13.1 integration surface

### 3.1 APIs confirmed in the versioned contracts

| Surface | Relevant API | Intended use |
| --- | --- | --- |
| Session startup | `server.before("agent.session_open", ...)` | Inject a bridge descriptor on create, resume, refresh, and import |
| Creation defaults | `server.before("agent.create", ...)` | Optional creation-time environment/configuration defaults, not prompt interception |
| Lifecycle observations | `server.on(...)` | Track creation, closure, turns, and permission lifecycle |
| Private plugin requests | `defineRpc`, `server.handle`, `useRpc` | Client-to-plugin-server typed requests; no credentials in chat messages |
| Agent UI | `addAgentPanel`, `addComposerPill` | Per-agent Axon status, recommendation decisions, and sign-in actions |
| Workspace/account UI | `addScreen`, `addWorkspacePanel`, `addHeaderButton` | Host/account setup and broader diagnostics |
| Optional timeline UI | `addTimelineRenderer`, `addTimelineTransformer` | Sanitized durable-looking presentation, not a secret transport |
| Device browser | `openExternalUrl` / host `ExternalLink` | Open the approved sign-in URL on the device showing Paseo |
| Full provider plugin | `server.registerProvider` | Available escape hatch, but not recommended for the first integration |

The plugin executes `index.server.ts` in a daemon-side subprocess and `index.client.tsx` in connected apps. Client code must use React Native-compatible components, host theme/layout APIs, and the client/server/shared directory boundaries.

### 3.2 Constraints that change the architecture

1. **There is no general before-prompt lifecycle hook in 0.13.1.** The before-hook contract contains `agent.create`, `agent.session_open`, and `workspace.create`. It cannot intercept the first prompt and wait for model selection through an invented `beforeSend` hook. The first-prompt gate belongs in Axon's Pi input extension.
2. **`agent.session_open` can change only `env`.** It is useful for connection metadata, not changing the prompt or inserting a long sign-in flow.
3. **Before hooks have a 30-second deadline.** Do not wait for a user or a five-minute login inside a hook. Hook errors can fail session startup.
4. **Lifecycle observers are live/best-effort, not a replayable state store.** Reconnecting clients need a fresh snapshot from the live Axon runtime.
5. **There is no generic plugin tap into the built-in Pi adapter's raw RPC stream.** Public lifecycle events expose selected agent events, not every Pi extension event or internal `pi.events` message.
6. **Pi UI support is a subset.** The bundled adapter maps `select`, `confirm`, `input`, and `editor`; `notify` becomes a timeline notification. There is no general Axon mapping for `setStatus` or `setWidget`. Pi's `setHeader` is itself a no-op in RPC mode.
7. **A renderer does not create a transport.** Registering a timeline renderer will not make Axon events arrive automatically. Transformers operate on already-projected timeline items, not hidden process state.
8. **Plugin timeline appends are not an authoritative persistent database.** The versioned docs describe daemon-memory rows, a 64 KiB serialized-data limit, and a feature capability check. They do not survive daemon restart.
9. **Daemon and app versions are checked independently.** A 0.13.1 daemon does not prove the mobile client supports the same contributions.
10. **A configured provider with `extends` shadows a same-ID provider plugin.** Keep plugin ID `axon-paseo` distinct from provider ID `axon` and do not register another provider for the companion design.

Paseo sets `PASEO_AGENT_ID` and `PASEO_AGENT_CWD` during session opening. These can help correlate the Axon runtime, but an agent ID is an identifier, not an authentication secret. Runtime generations still need separate identities.

## 4. Recommended architecture

### 4.1 Two presentation paths, one Axon behavior owner

Keep the backend policy, request/recovery state machines, model validation, credentials, and tool execution in Axon. Add a presentation boundary:

- **Terminal presentation:** existing loader, model picker, header, and host browser behavior.
- **Generic interactive RPC presentation:** standard select/confirm/input/notify methods only.
- **Paseo companion presentation:** structured state and correlated actions over a private bridge, rendered through the companion plugin.
- **Unattended RPC/print/CI:** no surprise dialogs or indefinite waits.

A mode marker is an opt-in to presentation, not an authorization grant or an override of organization policy. A successful capability handshake, not just `hasUI`, determines whether rich companion interactions are available.

### 4.2 Separate data and control channels

```text
MODEL / TOOL DATA PATH (unchanged)
Paseo Pi adapter <-> Axon launcher <-> Pi RPC stdin/stdout
                                      |
                                      +-> managed Axon extensions
                                      +-> authenticated Axon relay -> backend

AXON UI CONTROL PATH (proposed)
Paseo plugin client
    <-> typed Paseo plugin RPC
    <-> axon-paseo plugin server / session broker
    <-> authenticated local socket
    <-> Axon launcher / extension presentation adapter
```

Prefer a Unix-domain socket for the initial macOS-only scope. The phone never connects directly to a daemon-local socket or loopback URL; it uses its existing Paseo connection.

The bridge should be local and session-scoped. It is not a public HTTP service, generic command executor, or new model proxy. Supporting other operating systems would require an explicit transport decision, not a claim that the Unix socket works everywhere.

### 4.3 Session attachment

Proposed sequence:

1. The plugin server starts a private broker under its selected daemon instance's ownership.
2. Its `agent.session_open` hook filters for provider `axon` or explicitly opted-in derived profiles.
3. For interactive sessions, it allocates a fresh generation and short-lived capability, then returns only bridge metadata through `env`. It does not await user interaction.
4. The Axon launch/runtime connects, authenticates, and negotiates a small supported-feature set.
5. The runtime registers its Pi session identity and supplies the current sanitized state snapshot.
6. The client renders an Axon composer pill or panel. UI requests go to the plugin server, which validates the bound agent, generation, request, and current state before forwarding.
7. Closing/refreshing a runtime invalidates its generation and pending decisions. Reopened sessions attach again and publish fresh state.

Do not enable interactive behavior for model-catalog probes, history-only openings, unrelated Pi sessions, or runs with no attached capable UI.

If new child-visible variables are needed, a proposed `PI_AXON_PASEO_*` namespace fits the current environment boundary. These names are **not implemented**. Arbitrary inherited `AXON_*` variables are stripped by `createHarnessEnvironment`; merely setting `AXON_CLIENT=paseo` would not reliably reach extensions.

## 5. Feature design

### 5.1 Model recommendations

Keep recommendation work in the Pi extension so it runs before the actual user prompt, rather than duplicating it in a Paseo creation hook.

1. Detect the first eligible real user task, including explicitly supported RPC input. Preserve the existing resumed-session and steering/follow-up exclusions.
2. Fetch recommendations independently of terminal rendering, using the existing authenticated relay, backend policy, timeout, and available-model validation.
3. Present through the selected UI path:
   - Terminal: keep the current rich selector.
   - Generic interactive RPC: use a standard selection dialog.
   - Companion: publish ranked models/reasons and a decision request; the plugin offers a native panel/popover.
4. Apply exactly one validated decision with the existing Pi model API before continuing the original prompt. Do not send the prompt twice or convert a UI action into an extra assistant turn.
5. Reconcile the effective model with Paseo's controls through supported state/configuration mechanisms. Confirm this behavior; do not assume repainting a plugin label updates the agent's model.

Important details:

- Preserve cancellation as distinct from intentional auto-selection.
- Standard Pi selection dialogs return `undefined` for cancellation/timeout, so using that result alone cannot reproduce the terminal countdown semantics. The presentation adapter must explicitly track its decision deadline and why it settled.
- The first accepted answer/deadline wins; ignore late clicks and stale generations.
- Exactly one presentation owner must be active. Do not show a normal Paseo question and a companion model picker simultaneously.
- Bound the fetch plus decision time against Paseo's configured RPC timeout. The inspected adapter defaults to **60 seconds**; Axon's backend may supply longer-than-default picker preferences. Resolve that contract explicitly instead of leaving an input hook pending indefinitely.
- With no capable client, keep the current model and continue according to a documented fallback. Never silently enable new automatic model routing for every RPC script.
- Check stale question cleanup after cancellation or timeout; Pi settling a dialog does not by itself prove Paseo removed every displayed pending card.

### 5.2 Mid-chat sign-in on the viewing device

Reuse the current Axon recovery coordinator, verification, shared-file persistence, rotation handling, and bounded request retry. Do not implement a second credential refresh system in the plugin.

The current combined login function needs a presentation-independent boundary:

- Create a browser-login transaction and validate the returned approval URL.
- Poll for completion and verify/save the resulting credential on the daemon.
- Choose a browser opener: host OS for terminal mode, viewing client for companion mode.

Proposed live-session flow:

1. A managed model request detects an unrecoverable authentication state after existing silent refresh logic.
2. The recovery coordinator creates one shared pending recovery and pauses eligible waiting requests within its existing budget.
3. The Axon presentation adapter reports `authentication required` to the companion broker. Keep a healthy heartbeat independently of an active model request or whether a panel is mounted.
4. The client offers a sign-in action. After explicit user interaction, a private RPC starts the login transaction and returns its validated, short-lived approval URL to that client only.
5. The client opens the URL using its own OS/browser. For web popup restrictions, offer an explicit second link click after the URL is ready; an async RPC completion may no longer have browser user activation.
6. Axon polls, verifies, and persists credentials on the daemon. The client receives status only, never an encrypted session or provider key.
7. The existing coordinator settles the waiting request and the UI clears its pending state.

Preserve these distinctions:

- **Refresh vs login:** use silent refresh when possible; do not prompt on every access-token expiry.
- **Authentication vs connectivity:** a relay/network failure is not automatically an expired login.
- **Pending unauthorized request vs interrupted stream:** resume only the eligible request under existing rules. Do not blindly replay already-streamed generation or tool side effects.
- **Desktop-host vs phone browser:** approval must work without access to the daemon's desktop.
- **Multiple waiting requests/devices:** coordinate one login, allow cancellation without cancelling unrelated waiters, and reject stale completions.
- **Account switching:** define what happens if login completes as a different verified user. Do not silently resume one account's pending work under another account's identity.

The current watcher could already work for host-browser login through normal RPC dialogs. Investigate that path before attributing its absence to a Paseo limitation.

### 5.3 Startup authentication is a separate case

Axon verifies authentication **before Pi starts**, so an extension cannot rescue a launch that never reached Pi.

Initial scope can keep the existing prerequisite: authenticate and provision Axon on the daemon host before starting a Paseo agent. The plugin should expose a clear setup diagnostic rather than hang session creation.

A later fully remote onboarding flow needs an Axon-owned, machine-readable login operation usable without a running Pi session. Its implementation should reuse the same login/verification/persistence primitives and return only an ephemeral approval URL plus status to the trusted plugin server. This is a proposed API, not an existing Axon command.

Do not keep `agent.session_open` blocked while a human logs in. Do not write the shared credential from a separate plugin-specific implementation.

### 5.4 Status, backups, and permissions

- Forward only fixed, sanitized backup and terminal-policy states from the existing in-process event channels into the bridge.
- Maintain a current snapshot in the broker for reconnects; get fresh authoritative state from the Axon runtime after restarts.
- Distinguish `saved`, `pending`, `paused`, and `unknown/disconnected`. A disconnected plugin must not display a stale green `saved` indicator as current truth.
- Keep backup enablement administrator-controlled. A plugin control must not grant backup policy or YOLO eligibility.
- Keep command approvals on the existing `ctx.ui.confirm` -> Paseo permission path initially. Do not register a blanket permission auto-responder.
- Use the existing backup commands for behavior where appropriate, but do not scrape their human-readable messages as the long-term state protocol.
- Avoid client slash-command names that unintentionally shadow existing provider commands. Paseo plugin slash commands can take precedence over provider commands.

## 6. Proposed control contract and safety rules

The following are design concepts, **not existing methods, endpoints, or implemented schemas**.

### 6.1 Minimum messages

| Direction | Logical message | Required meaning |
| --- | --- | --- |
| Runtime -> broker | Attach/capabilities | Protocol version, agent ID, generation, native session ID when available, feature set |
| Runtime -> broker | State snapshot/update | Monotonic revision and sanitized auth/backup/policy/model state |
| Runtime -> broker | Decision requested | Request ID, kind, bounded choices, deadline, current revision |
| Client -> plugin server -> runtime | Decision response | Bound agent/generation/request, expected revision, allowlisted choice |
| Client -> plugin server -> Axon | Begin/cancel login | Explicit user action and bound active recovery; no arbitrary destination URL |
| Axon -> initiating client | Login approval link | Ephemeral validated URL, expiry, transaction identity; never a timeline payload |
| Runtime/broker -> peer | Settled/detached | Reject pending work, clear UI, and invalidate capabilities |

Each action must have bounded size, validation, an explicit deadline, correlation, and an idempotent/stale-response policy. Add version negotiation and reject unsupported versions rather than guessing.

### 6.2 Security and ownership

- Keep the real Axon session, provider keys, and current loopback relay capability daemon-side. The UI bridge uses its own narrower capability.
- Bind socket/capability ownership to one daemon instance, one agent, and one runtime generation. Validate provider association through the daemon API; do not trust arbitrary client-supplied paths or IDs.
- Protect the local directory/socket with owner-only access and safe creation. Handle stale paths and macOS Unix-socket path-length limits deliberately.
- Keep tokens out of command arguments, launch diagnostics, plugin logs, URLs used for navigation state, and persistent plugin settings. Environment delivery is a local trusted-process mechanism, not isolation from the same OS user.
- Never serialize a login URL into `notify`, model-visible chat, timeline rows, telemetry, or durable client caches. Private RPC is a transport path, not a guarantee that application code will avoid logging/caching its result.
- Validate login destinations against Axon's expected authentication origin and existing transaction checks; do not accept a browser URL supplied by another client. Require HTTPS outside the existing development-loopback exception.
- Keep browser approval and model selection tied to explicit, current requests. Two devices must not apply contradictory late decisions.
- Expose allowlisted UI actions only. No arbitrary shell command, filesystem read, relay forwarding, raw Pi frame injection, or unrestricted model endpoint.
- Do not share the model relay's broad per-launch capability with the companion just to avoid designing a narrow bridge.
- Plugins are trusted and not isolated. This design limits accidental exposure and remote misuse; it does not claim isolation from a malicious installed plugin or same-user host process.

### 6.3 Failure behavior

- No plugin: basic Axon/Pi remains usable; use the agreed generic-RPC behavior without rich companion features.
- Broker unavailable before attachment: use a bounded handshake and avoid indefinite UI waits.
- Plugin/client disconnect during a decision: settle under the documented deadline/fallback, reject late answers, and never bypass required command approval.
- Client suspended on a phone: no promise of background execution or guaranteed prompt delivery; refresh state on foreground/reconnect.
- Plugin reload/disable: remove client contributions, stop broker resources, detach sessions, and release pending UI work. The companion must not take ownership of the Pi provider process.
- Axon runtime exit/refresh: invalidate generation and sockets; a new runtime must reattach. Never deliver an old decision to a resumed process merely because the agent ID stayed the same.
- Daemon restart: reconstruct state from live/reopened Axon sessions, not timeline rows or process IDs saved to disk.

## 7. Packaging and likely future change areas

No listed changes are implemented by this investigation.

| Location | Proposed responsibility |
| --- | --- |
| `apps/cli/src/harnesses/pi/resources/extensions/model-recommender.ts` | Headless request logic, explicit supported RPC eligibility, presentation selection |
| `apps/cli/src/harnesses/pi/resources/extensions/axon.ts` | Recovery/status presentation and bridge lifecycle instead of assuming a terminal header |
| `apps/cli/src/cli/commands/auth.ts` | Separate login transaction/polling/persistence from host browser opening |
| `apps/cli/src/cli/auth/session-recovery.ts` | Reuse coordinator with one selected presentation owner and external-device login integration |
| `apps/cli/src/cli/auth/request-relay.ts` | Preserve request authentication/retry; add only explicitly needed narrow control integration |
| `apps/cli/src/harnesses/pi/adapter.ts` and `environment.ts` | Validate/forward negotiated presentation context and keep credentials isolated |
| `apps/cli/src/launcher/environment.ts` and `debug-preview.ts` | Review environment ownership and redaction for any new variables/diagnostics |
| `apps/cli/src/product/manifest.ts` and resource build/materialization paths | Ensure new runtime helpers are actually embedded and checksum-covered |
| Future `apps/paseo-plugin/` | Companion plugin's client/server/shared implementation, with separate plugin ID `axon-paseo` |

Proposed plugin layout:

```text
apps/paseo-plugin/                 # proposed; not created
  paseo-plugin.json
  package.json
  tsconfig.json
  index.client.tsx
  index.server.ts
  client/                         # React Native panels/pills and browser action
  server/                         # broker, session hooks, typed request handlers
  shared/                         # runtime-neutral wire schemas and contracts
```

Axon's embedded `.ts` extensions are materialized assets. Extracting helpers into ordinary sibling imports is not automatically safe: include the helpers in resource materialization or bundle them using the project's existing patterns. Preserve standalone-extension behavior where required and update the resource integrity/typecheck path.

Only introduce a shared `packages/` module if both apps actually need the neutral wire contract. Do not create a broad shared framework preemptively. Any new dependencies and workspace changes require a separate implementation decision.

For a first supported plugin, pin development SDK/protocol packages to **0.13.1**, and conservatively declare support for **`>=0.13.1 <0.14.0`** until a broader range is validated. This is a proposed support policy, not an upstream compatibility guarantee. Both daemon and connected clients must meet the declared range. Do not adopt APIs marked unreleased merely because they appear in versioned documentation.

## 8. Alternatives and recommendation

| Option | Assessment |
| --- | --- |
| Axon RPC dialogs only | Smallest useful step; enough for basic model selection and host-browser recovery, not a full mobile/status experience |
| Existing Pi provider + companion plugin + narrow bridge | **Recommended** for preserving Axon features without a Paseo fork or a second provider implementation |
| Axon direct provider plugin | Officially possible, but owns stream conversion, catalog, persistence, permissions, cancellation, replay, commands, and compatibility; use only if a proven built-in adapter limitation blocks the companion |
| ACP bridge | Useful only for an explicit broader interoperability goal; Pi RPC is not ACP, and a protocol translation layer adds maintenance |
| Patch/fork Paseo | Unnecessary for the identified first scope; reconsider only with a concrete missing public hook that cannot be met by the Axon bridge |
| Force TUI mode or parse terminal output | Wrong abstraction for native mobile interaction; does not make custom terminal components become Paseo UI |
| Encode control data in notifications/chat | Pollutes history and risks secret leakage; not appropriate for authentication or authoritative mutable state |

## 9. Suggested rollout and remaining proof

### Phase A: RPC-compatible Axon baseline

- Separate recommender behavior from terminal rendering.
- Support deliberate, bounded interactive RPC presentation without changing unattended behavior.
- Diagnose existing recovery dialogs against the installed 0.13.1 adapter and the actual installed Axon binary.
- Keep initial authentication/provisioning as an explicit host prerequisite.

### Phase B: companion layer

- Add only the broker, session attachment, versioned contracts, snapshot/decision flow, and one Axon panel/pill.
- Add viewing-device login using the existing Axon credential owner.
- Add backup/auth indicators after the state and teardown contracts are stable.
- Keep ordinary command approvals on Paseo's built-in path.

### Phase C: distribution and optional remote onboarding

- Offer plugin installation from a reviewed Git/npm source with a compatibility range and clear trust disclosure.
- Read the user's current plugin-enable state and obtain explicit consent before enabling plugins. Enabling the global switch may start other configured plugins too.
- Preserve the existing `agents.providers` map when adding Axon. Paseo's CLI rejects individual dynamic paths such as `agents.providers.axon`; setting `agents.providers` replaces that complete configured map.
- Treat startup login and missing-runtime/package provisioning as separate workflows from mid-chat recovery.
- Do not make plugin installation silently modify authentication, provider policy, or the user's other providers.

Before claiming support, validate real desktop and mobile behavior for recommendation decisions, selected-model reconciliation, login on the viewing device, request cancellation, reconnect, stale decisions, concurrent agents/devices, runtime refresh, and plugin teardown. Confirm fallback behavior without the plugin and preserve terminal behavior and organization policy. These are required validation areas, not results established by this report.

## 10. Source references

### Axon working-tree sources

- `apps/cli/src/harnesses/pi/resources/extensions/model-recommender.ts` — TUI/input guards, loader, selector, first-task lifecycle.
- `apps/cli/src/harnesses/pi/resources/extensions/axon.ts` — recovery watcher, standard dialog, terminal header, internal status channels.
- `apps/cli/src/cli/auth/session-recovery.ts` — heartbeat, shared waiters, recovery timeout, browser login.
- `apps/cli/src/cli/auth/request-relay.ts` — authenticated relay, recovery eligibility, request retry and credential isolation.
- `apps/cli/src/cli/commands/auth.ts` — browser-login transaction, polling, host opener, persistence.
- `apps/cli/src/cli/dispatch.ts` and `auth/ensure-session.ts` — authentication before Pi startup.
- `apps/cli/src/harnesses/pi/adapter.ts`, `environment.ts`, and `launch-preferences-environment.ts` — resource/environment preparation and backend preferences.
- `apps/cli/src/harnesses/pi/session-backup/index.ts` — lifecycle capture and fixed backup status states.
- `apps/cli/src/launcher/environment.ts`, `debug-preview.ts`, and `spawn-harness.ts` — environment boundary, diagnostics, inherited protocol streams.
- `apps/cli/src/product/manifest.ts` — embedded resource ownership and package requirements.
- Installed Pi 1.4.0 `docs/rpc-extension-ui.md` and `dist/modes/rpc/rpc-mode.js` — supported dialogs, `hasUI`, unsupported `custom`, and RPC input source.

### Paseo versioned sources

- [Plugin documentation, v0.13.1](https://github.com/getpaseo/paseo/blob/v0.13.1/docs/plugins.md)
- [Public plugin reference, v0.13.1](https://github.com/getpaseo/paseo/blob/v0.13.1/public-docs/plugins/reference.md)
- [Lifecycle contracts, v0.13.1](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/plugin/src/server/lifecycle.ts)
- [Server plugin contracts, v0.13.1](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/plugin/src/server/contracts.ts)
- [Client contribution contracts, v0.13.1](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/plugin/src/client/contracts.ts)
- [Client exports and external opener contract, v0.13.1](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/plugin/src/client/index.ts)
- [Pi provider, v0.13.1](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/server/src/server/agent/providers/pi/agent.ts)
- [Pi launch builder, v0.13.1](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/server/src/server/agent/providers/pi/runtime.ts)
- [Provider registry, v0.13.1](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/server/src/server/agent/provider-registry.ts)
- [Lifecycle example, v0.13.1](https://github.com/getpaseo/paseo/blob/v0.13.1/plugin-examples/lifecycle-actions/index.server.ts)

The installed app archive was inspected read-only for package versions and the bundled `@getpaseo/server` Pi adapter/runtime. No packaged files were extracted to disk or modified. Versioned contracts establish design feasibility; they do not substitute for an end-to-end integration check.