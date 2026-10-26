# Axon → LiteLLM upstream timeout investigation

## Conclusion and evidence boundary

**The observed failure is consistent with Axon's streaming HTTP connection pool acquisition timing out, not an HTTP error returned by LiteLLM. The incident's initiating cause is not proven.** There is a demonstrated disconnect-handling defect that can retain occupied upstream connections, but no pod-level evidence establishes that it filled the production pool during this incident.

Investigated checkout: `655273aa` plus the pre-existing working-tree observability changes. References below are relative to the repository root. The local installed dependency versions match `apps/backend/uv.lock`: HTTPX 0.28.1, httpcore 1.0.9, AnyIO 4.15.1, Uvicorn 0.54.0, FastAPI 0.142.2, Starlette 1.7.0, asyncpg 0.32.0.

Available evidence: source, local configuration (read through a non-secret allowlist), lockfile, installed library implementations, the incident excerpt supplied in the request, and local reproductions. Not available: affected pod's image/revision/configuration, historical traffic/concurrency, connection/task snapshots, ingress/ELB rules, or production DNS/network observations. Successful EC2-local requests are reported incident context, not independently repeated here.

The original investigation changed **tests and this report only**. A subsequent user-authorized implementation now fixes disconnect handling and adds focused diagnostics; see **section 12**. Pool sizes, configured timeouts, authentication, routing, deployments and production services remain unchanged. Pre-existing working-tree changes were preserved. Sections 1–11 describe the investigation-stage code/evidence; their original line references may have moved after the implementation.

## 1. Exact exception and 502 source

Request flow:

1. API mount `/litellm/*`: logging → `AuthenticatedSessionMiddleware` → `LiteLLMProxy` → identity/key resolution → `forward_stream`.
2. Browser mount `/litellm-admin/*`: logging → `LiteLLMUIProxy` → the same `forward_stream`, without injecting an Axon/backend credential.
3. `forward_stream` → `_open_response` → `LiteLLMTransport.send_stream` → shared `httpx.AsyncClient.send(..., stream=True)`.

References:

- `apps/backend/app/proxies/litellm.py:50,169` — key resolution and authenticated mount.
- `apps/backend/app/proxies/litellm_ui.py:138,178,196` — browser policy, limits, mount.
- `apps/backend/app/proxies/litellm_common.py:416-446` — transport timing and exception conversion.
- `apps/backend/app/clients/litellm/transport.py:120-141` — actual HTTPX request.

The fully qualified application-visible exception is **`httpx.PoolTimeout`**. It is translated from **`httpcore.PoolTimeout`** by HTTPX's `map_httpcore_exceptions`. In httpcore, `AsyncConnectionPool.handle_async_request` calls `AsyncPoolRequest.wait_for_connection`, which waits on `AsyncEvent`; under asyncio, AnyIO's `fail_after(pool_timeout)` expires and maps to `httpcore.PoolTimeout`.

Installed-library references under `apps/backend/.venv/lib/python3.12/site-packages/`:

- `httpcore/_async/connection_pool.py:199-267`, especially `232`.
- `httpcore/_synchronization.py:137-151`.
- `httpx/_transports/default.py:74-118`, especially `82`.

`_open_response` catches `httpx.HTTPError` and creates `ForwardingError(502, BAD_GATEWAY_BODY, "upstream_transport_failed", error_type=type(exc).__name__)`. `forward_stream` sends the fixed JSON body. No upstream response exists in this path; `upstream_status` remains `none`.

The reported ~10001.9 ms aligns with the configured **10-second pool wait**, not evidence of a 10-second LiteLLM processing timeout. `upstream_duration_ms` measures entry into `send_stream` through receipt of headers/failure, including pool wait, connect, upload and response-header I/O; it is **not** exclusively pool-acquisition time or full response-stream duration. In the reproduced pool-timeout case it is dominated by pool wait.

The reproduction verifies both exception classes/cause and the exact 502 body/log fields over real TCP connections. This is stronger than assuming a library from the short exception name. The incident's deployed revision and libraries still need confirmation.

## 2. Client configuration and ownership

Source: `apps/backend/app/clients/litellm/transport.py:41-148`; validation/defaults: `apps/backend/app/core/config.py:582-652`.

| Property | Streaming pool: both public proxy mounts | Management pool: identity and decisions |
|---|---|---|
| Client | `httpx.AsyncClient` | Separate `httpx.AsyncClient` |
| Maximum connections | 100 | 20 |
| Maximum idle keep-alive connections | 20 | min(20, management maximum) = 20 |
| Keep-alive expiry | 5 s | 5 s |
| Connect timeout | 10 s | Per-call timeout: identity 10 s; decisions 120 s |
| Pool acquisition timeout | 10 s | Same per-call timeout: 10 s / 120 s |
| Read timeout | 360 s | Same per-call timeout: 10 s / 120 s |
| Write timeout | API: unlimited; browser: 30 s override | Same per-call timeout: 10 s / 120 s |
| Response mode | Manual streaming for **every** proxied response, including ordinary JSON, UI assets, health and model-list responses | Buffered `.request()`, consumed before return |
| HTTP behavior | HTTP/1.1 default; HTTP/2 not enabled; no redirect following; `trust_env=False` | Same |
| Application concurrency admission | No general limiter or bounded queue | Decisions: fail-fast semaphore of 10; identity provisioning: worker-local lock with 10 s enclosing deadline |

These values are verified in the local `config.json` or resolved defaults, and match the template's pool settings; **they are not verified as the affected pod's effective settings**. HTTPX's timeouts are generally operation/idle timeouts, not a universal total-request deadline. Identity resolution adds its own total deadline (`identity.py:414-431`).

Browser-specific defaults: body idle 30 s, write 30 s, request-through-headers total 360 s, body maximum 32 MiB. `forward_stream`'s browser deadline ends after headers arrive; it does not bound response streaming (`litellm_common.py:484-500`). API `BodyLimits()` has no body-idle, total-request, or body-size bound. A 5-second keep-alive expiry applies to idle connections, **not occupied streams**.

Lifecycle is correct in ordinary use:

- One transport with two clients is created at application startup and stored in `app.state`; not per request (`app/listeners/litellm.py:20-33`).
- API and browser mounts use the same streaming client. Management traffic cannot consume its slots, and vice versa.
- Lifespan closes initialized resources in reverse order; composition failure closes clients (`app/listeners/__init__.py:20-49`, `app/listeners/litellm.py:36-44`).
- Pools are worker/process-local, not shared across Uvicorn workers. Local config/template have `WORKERS=1`. With W workers there are W independent 100-slot streaming pools and W independent 20-slot management pools; uneven traffic can exhaust one worker even if others have capacity.
- `deployment/run_service.sh:19-24` starts uvloop/httptools and configured workers. It does not set `--limit-concurrency`. There is no general proxy admission control before the client's connection pool; waiting requests still consume ASGI tasks/resources.
- Settings are cached from `apps/backend/config.json` (`core/config.py:519-527`). A restart also reloads that file; if it changed, restart recovery could include a configuration change.

## 3. Cleanup audit and demonstrated retention

### Paths that already clean up

`apps/backend/app/proxies/litellm_common.py:471-535` owns both the upstream response and upload generator:

- Successful raw streaming consumes `response.aiter_raw()` to EOF.
- Upstream 401/403 API body replacement does not consume the native body but still closes it in `finally`.
- Mid-stream HTTPX errors, downstream `OSError`, and explicit task cancellation reach `finally`.
- `response.aclose()` runs, followed by `content.aclose()` in a nested `finally`.
- Before a response is returned, httpcore removes its queued/assigned request on `BaseException`, including cancellation (`connection_pool.py:248-257`).
- Buffered management requests use HTTPX's non-streaming `send`/`aread`; HTTPX closes on errors, and completed reads close the response (`httpx/_client.py:1634-1643`).

Existing tests cover response overrides, normal cancellation, upstream read errors, partial uploads and browser timeouts. New real-pool tests show explicit cancellation both before headers and during a stalled response body frees the sole slot and permits a subsequent request. **An unconditional missing `response.aclose()` or generic permanent leak on ordinary cancellation was not found.**

Cleanup exceptions have no dedicated outcome metric/log at this ownership boundary. They can mask the original error. The application `finally` is not independently shielded against repeated cancellation; lower layers have cancellation shielding in several close paths. Repeated cancellation/close failure retention is not demonstrated, so changing shielding blindly is not justified.

### Demonstrated defect: disconnects after body completion are not watched

`request_body` handles `http.disconnect` **while reading the upload** (`litellm_common.py:381-397`). After its final body frame, nobody calls `receive()` while awaiting response headers or forwarding response chunks. The code instead relies on downstream `send()` raising `OSError` or external task cancellation.

The installed Uvicorn httptools implementation:

- Sets `cycle.disconnected` on connection loss; it does not cancel that request task (`uvicorn/protocols/http/httptools_impl.py:116-129`).
- Advertises ASGI HTTP spec 2.3 (`228`).
- Its `send` returns silently when disconnected (`467-468`); its `receive` would return `http.disconnect` if called (`577-578`).

A real local Uvicorn socket test confirms the consequence: after the downstream client closes, the upstream keeps emitting chunks, the proxy task remains active, and another request gets `PoolTimeout`. Explicit cancellation releases the connection. Periodic upstream data prevents the read-idle timeout from firing, so such retention can outlast that timeout indefinitely. A pre-header or body stall without periodic data can retain the connection until the read-idle timeout (normally 360 s).

This is a **resource-retention/disconnect defect**, not proof that production accumulated 100 abandoned streams. It could amplify normal traffic, retries, ELB/client disconnects or slow upstream responses.

### Other occupancy paths

- Active generation streams legitimately occupy HTTP/1.1 connections for their entire response lifetime.
- JSON/non-SSE routes also occupy streaming slots until consumed/closed.
- An incomplete API upload can hold a connection awaiting the next ASGI body frame indefinitely. API write timeout is unlimited; even a finite socket-write timeout would not time out the caller's body generator waiting in `receive()`.
- A slow connected downstream can block `await send(...)`, retaining the upstream response. The upstream read-idle timer does not run while the consumer is waiting to send downstream. No downstream-send deadline exists.
- Browser uploads have bounds; browser response streaming still does not have a total-duration bound.
- Pool acquisition timeout bounds waiting callers, not the lifetime of an already acquired connection.

The new tests reproduce incomplete API uploads and downstream backpressure retaining a connection beyond a short read-idle timeout; cancellation recovers it. These are admission/lifetime policy gaps, not evidence that a particular workload triggered the incident. Arbitrarily imposing short total-response deadlines would break valid long generations/MCP streams.

## 4. Threadpool, event loop and other pools

The proxy is pure async ASGI. `send_stream`, authentication HTTP calls and identity provisioning do not use FastAPI's synchronous handler threadpool. AnyIO is used inside httpcore for async sockets/events; that does **not** imply a worker-thread dependency for pool acquisition.

There are real sync FastAPI handlers/dependencies elsewhere: release discovery, URL signing and installer routes (`app/routers/cli_releases.py:37-105`, `app/routers/install.py:23`). They use Starlette/AnyIO workers; installed AnyIO's default limiter has 40 tokens. S3/session storage operations in async services are generally explicitly offloaded with `asyncio.to_thread` (`app/services/sessions/service.py:91,153,170,195`), which uses a **different** executor. Saturation of either is possible under load, but is not evidenced for this incident and does not directly prevent the pure-ASGI proxy from obtaining a free HTTP connection.

DNS is a qualified indirect concern: AnyIO's asyncio backend uses `loop.getaddrinfo` (`anyio/_backends/_asyncio.py:2932-2952`). Under the standard asyncio loop that can use its default executor; deployment uses uvloop, whose resolver/executor behavior must be checked separately. IP-literal destinations bypass name resolution (`anyio/_core/_sockets.py:220-233`). Do not equate DNS delays with AnyIO's 40-token FastAPI limiter.

No synchronous network call was found in the proxy's async forwarding path. Small synchronous parsing/header work and synchronous logging remain; unrelated CPU work/log handlers could delay the event loop, so low aggregate CPU/memory does not rule out transient blocking. A blocked loop could delay cleanup and timeout delivery, or indirectly prolong occupied connections. The local reproduction intentionally runs a scheduled callback while acquisition waits: **event-loop blocking is not necessary to produce this signature**. No historical lag or task-stack evidence establishes it here.

The backend PostgreSQL pool is not on the LiteLLM API/UI forwarding path; local backend readiness does query it (`app/routers/health.py:18-38`). Auth-service HTTP calls use a distinct client (`app/clients/auth_service.py:61-70`). Identity failures are a different diagnostic stage/status; the browser mount does not use Axon session auth or identity sync. A LiteLLM-internal database/provider issue could slow existing upstream requests, but is outside the evidence available in this repository.

## 5. Upstream URL and routing

**Local, ignored `apps/backend/config.json`:**

- Origin: `http://localhost:4000` — hostname `localhost`, HTTP port 4000.
- Root path: `/litellm-admin`; UI enabled.
- Health URL constructed by Axon: `http://localhost:4000/litellm-admin/health/liveliness`.
- Model-list URL: `http://localhost:4000/litellm-admin/v1/models`.
- UI URL: `http://localhost:4000/litellm-admin/ui/`.

**Tracked `apps/backend/config_template.json:143-151`:**

- Origin: `http://10.1.0.62:4000`; IP literal, no hostname DNS resolution required.
- Root: `/engram-service/litellm`; UI disabled.

**README production example** (`apps/backend/README.md:69-98`): private origin plus `/axon/litellm-admin`, with ingress stripping `/axon` from incoming requests. This example is not proof of deployed configuration. The tracked LiteLLM YAML only sets `store_model_in_db` and `drop_params`; it does not establish its deployed root path/listen address.

`LiteLLMTransport.upstream_url` validates the raw path, appends it to the configured root, preserves ordered/duplicate queries, and pins the origin (`transport.py:90-97`). Redirects are not followed. `trust_env=False` prevents ambient HTTP(S)_PROXY variables from silently changing the destination.

No `/axon` → `/axon_backend` ingress rule or `/axon_backend` application mount was found in this repository. The app itself mounts `/litellm` and `/litellm-admin`, not either external prefix. An ingress rewriting to `/axon_backend/...` must either strip that prefix before routing or have corresponding ASGI `root_path`/deployment support. Verify the actual ingress and observed `scope.path`/`root_path` before changing this. The browser proxy also uses the configured upstream root for public redirects (`litellm_ui.py:76-100`), coupling LiteLLM's upstream path and public mount; differing external/private roots need a deliberate design/test, not an ad-hoc rewrite.

A bad path normally produces an upstream 404/redirect/auth error with an actual upstream status after a connection is acquired. It does not directly explain acquisition `PoolTimeout`. It could contribute indirectly if it induces long-lived requests or excessive retries; no evidence establishes that chain.

EC2-local health success proves neither pod-to-host connectivity nor that Axon targets that exact instance/root. In a normal separate network namespace, `localhost` points at the backend container/pod, not the EC2 host. Network mode, mounted config and deployment overrides must be inspected before calling the local setting a production defect. Restart recovery also makes a persistent wrong destination less persuasive unless configuration/network state changed.

**Read-only production verification, with operator authorization:** capture image digest, PID/worker count and allowlisted effective settings; resolve the configured host inside the affected pod; compare addresses to the intended EC2 instance; perform bounded TCP and health/model-list checks using the exact configured root and HTTPX `trust_env=False`. Load any required key inside the diagnostic process; output only host/port/path, timings, exception class and status, not credentials or response bodies. Compare fresh connections to the app's shared pool and upstream access logs at the same time. Preserve request IDs. Inspect approved ingress rules and idle timeouts. Do not put keys in command lines or paste the complete config/environment.

## 6. Ranked causal hypotheses

This is an investigation priority ranking, not a measured probability estimate for the production incident.

| Rank | Hypothesis | Supporting evidence | Contradictory evidence / missing proof |
|---|---|---|---|
| 1 | Pool occupied by abandoned requests after downstream disconnect | Concrete defect; real Uvicorn reproduction; both mounts share pool; periodic streams can retain slots indefinitely; restart clears them | No production disconnect counts, occupied-slot ages, stream counts, task stacks, or proof that this revision was deployed |
| 2 | Legitimate concurrency/slow long-running requests exhaust the shared pool | HTTP/1.1; max 100 per worker; no general admission control; UI/health share generation capacity; exact signature reproduced without a leak | Actual traffic and upstream request durations unknown; no measured capacity crossing |
| 3 | Stalled API uploads or downstream backpressure retain slots | Unbounded API body wait and downstream-send duration demonstrated locally; read timeout does not bound them | No incident upload-size/rate/backpressure evidence; browser uploads are bounded |
| 4 | Upstream/network slowness indirectly fills occupied pool | TCP/header/read waits consume slots; EC2-local probes do not test pod path or all long requests | New failing request is an acquisition timeout, not a connect/read error; reported upstream probes succeed; no pod-network/DNS evidence |
| 5 | Event-loop/executor starvation delays progress or cleanup | Shared event loop; sync handlers/offloads exist elsewhere; external DNS/logging could be indirect contributors | Proxy is async; no long blocking proxy call identified; local signature occurs with responsive loop; threadpool/lag evidence absent |
| 6 | Cleanup/library pool-state corruption or repeated-cancel close failures | Restart resets state; cleanup-failure instrumentation is absent | Normal cleanup is explicit; real single-slot cancellation/read-timeout tests recover; no corrupt pool or close failure demonstrated |

A fixed URL/path error, backend DB exhaustion, or browser 401 is not a direct explanation for the logged upstream pool-acquisition failure. These may warrant independent investigation, but should not be presented as established causes.

## 7. What restart resets, and how to distinguish causes

Restart destroys/recreates both HTTP pools, idle/occupied sockets, pending ASGI tasks, response/upload iterators, worker-local locks/semaphores/caches, auth/storage clients, the backend database pool, and cached settings. This terminates legitimate work as well as abandoned work. Recovery alone cannot distinguish them.

Before any future planned restart, if operationally safe, capture bounded read-only evidence:

- Per-worker live request phases and ages: waiting for body, awaiting headers, streaming/awaiting downstream send, closing.
- Pending-header count versus open-response count, configured limits and worker ID.
- Sanitized task stacks: pool event wait versus upstream read versus ASGI receive/send versus cleanup; no frame locals.
- Connection counts/states and upstream concurrent requests, correlated to the same worker/instance.
- Disconnect/cancel/close outcomes, event-loop lag and AnyIO limiter statistics.
- Fresh client probe to the same destination/root, separately from shared-pool requests.

Old open responses after downstream disconnect support abandoned work. Many recent active requests support demand saturation. Low application in-flight counts with an apparently full pool support bookkeeping/cleanup/library investigation (or missing instrumentation). High loop lag supports event-loop interference. Fresh-client connect failures support the network/upstream path instead. Counts must be worker-local; aggregation can hide a single exhausted process.

## 8. Recommended changes and trade-offs

### First: smallest diagnostic change, not capacity tuning

Add a bounded, worker-local lifecycle observer around `forward_stream` and the buffered transport. On `httpx.PoolTimeout`, emit one rate-limited sanitized snapshot with:

- Existing request ID/trace correlation, PID/instance/revision, pool name, configured origin/root/limits/timeouts.
- Fully qualified exception and cause types only; no arbitrary exception text/URL/body.
- Counts for in-flight requests, awaiting headers, open responses/streaming, and closing; oldest phase ages and a bounded sample of route templates/request IDs.
- Pool-timeout, cancellation, observed-disconnect and cleanup-failure counters.

Use `finally` for counter decrements and record close outcomes without swallowing the original cancellation/error. Bound any per-request sample storage; aggregate counters must still count overflow. Keep runtime metric labels to static route templates, pool/upstream identity and exception class. Never use request IDs, prompts, keys, user IDs, full paths/queries or response contents as metric labels. Retain correlation IDs in logs/spans, not metrics.

**Do not label await-to-headers duration as pool-acquisition duration.** HTTPX 0.28.1 has no public pool occupancy/acquire-wait hook; inspected httpcore pool code has no acquisition trace event. Request/response event hooks do not isolate acquisition. An await-headers count includes queue/connect/upload/header wait, not just queued requests. Exact pool stats would require a deliberately version-tested adapter/internal instrumentation; avoid a production monkeypatch or adding a semaphore solely to pretend to measure the existing pool. Counts, phase ages and timeout types are the smallest safe first diagnostic.

At the investigation-only stage, runtime instrumentation was deferred because the deployed version was unknown and overlapping tracing/logging changes already existed. The user subsequently authorized the focused implementation described in section 12. It preserves those changes and does not inspect private HTTPX pool internals or tune capacity.

### Correct the demonstrated disconnect defect in a separately reviewed patch

After request-body completion, race header acquisition/response forwarding against a disconnect watcher and cancel/join the losing operation. There must be **one owner of `receive()` at a time**: do not race a watcher with upload ingestion. Preserve streaming backpressure and do not buffer/drain arbitrary bodies merely to watch disconnects. Close response/upload resources on every exit; distinguish genuine disconnect cancellation from server shutdown. Consider bounded cancellation-resistant cleanup only with tests for the actual cancellation model.

Invert the characterization tests to require prompt slot recovery on disconnect, including pre-header waits and active streams. Confirm with real Uvicorn/httptools **and the deployed uvloop/library versions**, not only mock sends that raise `OSError`. This fix is warranted by the demonstrated defect even though its incident contribution remains unproven.

### Capacity/lifetime policy only after measurement

- **Larger pool:** may help legitimate measured concurrency; also multiplies sockets/provider load, can postpone retention failures, and cannot fix abandoned streams. Account for workers × replicas and upstream limits first.
- **Longer pool timeout:** increases queue latency/retained tasks; can turn a 10 s failure into a longer failure without improving throughput. Not recommended without evidence of brief, recoverable contention.
- **Shorter read timeout:** reduces truly idle waits but can kill valid slow models; it does not bound active periodic streams, stalled body generators, or downstream backpressure.
- **Finite API body-idle/write limits:** address demonstrated lifetime gaps, but choose values/body-size policy from legitimate API/MCP uploads and test chunked bodies; read timeout is not a substitute.
- **Admission control:** a bounded, fail-fast per-worker gate/queue can protect capacity and avoid unbounded waiting tasks. Return an explicit overload status with a retry policy rather than silently increasing wait time. Hold/release the permit for the full occupied response lifetime. Additional routes/pool partitions can isolate UI/control traffic, but add sockets and operational complexity; merely sharing the existing management pool with browser traffic would remove current identity isolation.
- **Total stream/downstream-send deadlines:** can protect against indefinitely slow consumers but change valid long-generation behavior. Use explicit product/protocol policy, not a short blanket deadline.
- **More workers:** creates independent capacity but also more upstream/DB connections and duplicates caches; not a leak repair or a substitute for global ingress limits.

No global auth relaxation is recommended.

## 9. Observability and production confirmation

Already present, when `OPEN_TELEMETRY.ENABLED` and corresponding flags are enabled:

- Server request duration by route/status and active server requests (`app/observability/runtime.py:29-64`, `middleware.py:116-144`).
- HTTPX/asyncpg dependency instrumentation and sanitized destination spans.
- Event-loop lag/max-lag, task count, blocking events (`app/observability/event_loop.py`). Its utilization value is a scheduling-lag estimate, not CPU utilization.
- Completion diagnostics with request ID, failure stage/reason, credential mode, headers latency and total lifetime, including observed cancellations/disconnect exceptions (`litellm_common.py:105-218`). Completion-only logs do not expose requests that have not yet exited.

Both the local config and template currently have `OPEN_TELEMETRY.ENABLED=false`, although their individual metrics/loop flags are true. This is not evidence of production's effective setting. Verify collector/auth/export success before depending on dashboards. Default sampling is 10%; unsampled failures may require always-on failure counters/logs rather than traces alone.

Missing targeted signals to add with the lifecycle observer:

| Signal | Interpretation |
|---|---|
| In-flight/pending-headers/open-responses/closing by worker and pool | Locate occupancy and phase imbalance; not a fabricated exact pool size metric |
| Time-to-headers and full proxy lifetime histogram by static endpoint | Separate queuing/header work from response transfer |
| Open streaming count, stream lifetime and oldest age | Identify long-lived/abandoned work; manual HTTP streaming is not necessarily SSE |
| Timeouts/errors by upstream, pool and qualified exception class | Distinguish acquisition, DNS/connect, read, write, and upstream HTTP statuses |
| Disconnect, cancel, close success/failure and close duration | Confirm prompt recovery and expose skipped/failed cleanup |
| Loop lag/max-lag plus task count | Test event-loop starvation hypothesis |
| AnyIO limiter borrowed/total tokens and tasks waiting | Assess sync-route threadpool saturation; collect `.statistics()` on the event-loop thread |
| Offload queue/start/run timing where `asyncio.to_thread` is used | Assess the separate default executor; AnyIO limiter stats do not measure it |

After a reviewed fix, canary under real request mix and repeated client disconnects. Open-response counts should return to baseline promptly after abandonment, oldest ages should correspond to real clients, and all pool/permit counts should return to zero after test traffic drains. Alert on any sustained pool timeouts, rising oldest stream ages, cleanup failures, and high per-worker occupancy with pending requests. Monitor upstream connections/error rate and p95/p99 latency to avoid moving overload to LiteLLM. Preserve a low-cost Axon `/ping` liveness check independently of LiteLLM readiness.

## 10. Separate `/health/liveliness` 401

The log path is relative to the mount. `/litellm/health/liveliness` goes through Axon session auth for **all** methods/paths. Missing/duplicate/malformed Bearer credentials or an auth-service 401 produce an Axon 401 before identity synchronization or upstream forwarding (`app/authentication.py:62-105`). `credential_mode=unresolved` is the initial diagnostic value and stays unresolved because `_api_request` never runs.

`/litellm-admin/health/liveliness` instead uses browser/native LiteLLM auth and sets `credential_mode=browser`. A native upstream denial there is logged as an upstream HTTP error, not `session_auth_failed`. The new test verifies the distinction and that the session 401 makes **zero** upstream requests. The API health route is not special-cased by the middleware.

Therefore the observed `session_auth_failed`/401/unresolved is an independent Axon authentication-stage failure, potentially a browser hitting the API namespace without the expected session. It is not evidence of LiteLLM pool exhaustion. The exact reason (missing/invalid/expired session versus an ingress routing the browser into the API mount) needs full external path, normalized route and a sanitized auth reason enum; never log the credential itself. Check browser network requests and ingress rules. Use `/ping` for backend liveness; do not make all `/litellm/*` routes public or bypass authentication globally.

## 11. Reproduction and validation

Added `apps/backend/tests/test_litellm_incident_reproduction.py`:

- `test_real_pool_timeout_matches_incident_without_a_leak` — actual HTTPX/httpcore exception chain, same Axon response/log, responsive-loop callback, isolated management request and recovery after close.
- The original queued-disconnect characterization demonstrated unread disconnects before headers/during the body. It is now `test_disconnect_or_cancellation_releases_real_pool_slot`, requiring prompt recovery on both disconnect and explicit cancellation (4 cases).
- `test_idle_read_timeout_does_not_bound_upload_or_downstream_backpressure` — API upload/downstream wait retains a slot past the idle-read timeout; cancellation recovers it (2 cases).
- `test_liveliness_session_401_never_reaches_litellm` — API health fails before upstream; browser mount reaches the local upstream.
- The original real-Uvicorn characterization showed retained streams. It is now `test_real_uvicorn_disconnect_stops_upstream_stream`, requiring automatic upstream closure under both asyncio and uvloop (2 cases).

The original disconnect cases asserted the defective behavior to establish evidence. They have now been converted to regression tests requiring correct cleanup. Small pool/short timeouts make the mechanism deterministic; they do not demonstrate that production exceeded its actual configured capacity. Fixtures use ephemeral loopback sockets, no database/app lifespan/credentials or external services. The Uvicorn test uses httptools under both asyncio and uvloop. Repeat against the deployed image/library versions in staging; matching the local loop does not establish production parity.

Commands from `apps/backend`:

```sh
.venv/bin/python -m pytest tests/test_litellm_incident_reproduction.py -q
.venv/bin/ruff check tests/test_litellm_incident_reproduction.py
.venv/bin/ruff format --check tests/test_litellm_incident_reproduction.py
```

Investigation-stage results, before the authorized implementation:

- Original characterization suite: **8 cases passed** (also included in the focused run).
- Focused existing/new proxy, streaming, pool, lifecycle, logging, UI and decision suites: **292 passed**.
- Full backend suite at the earlier four-new-case checkpoint: **951 passed, 1 failed**. The unrelated existing failure is `tests/test_build_backend_image.py::test_python_stages_share_private_base_without_bundled_dbmate`: the test expects the `wolfi-3.12.14-r8` base tag, but the checked-in Dockerfile uses `wolfi-3.12.15-r3-tmp`. No Dockerfile/build test was changed. That full run also emitted telemetry-export 401 warnings; those are not the incident's session-auth 401 and do not establish anything about production collector health.

Follow-up verification before rollout: repeated real disconnects during pool wait/header wait/upload/stream/send; cancellation during cleanup; upstream read/write/protocol errors; downstream backpressure; sanitized logs/correlation and metric cardinality; stable connection/task counts after load drains; healthy UI/control requests during generation load; authenticated versus browser mount routing; exact external-prefix rewrite under the deployed ingress. Do not use only HTTPX ASGITransport/MockTransport for pool or disconnect validation.

## 12. Authorized implementation follow-up

Implemented after the user explicitly requested the recommended code changes. This fixes the demonstrated defect; it still does **not prove the original incident's initiating cause**.

### Disconnect and cleanup behavior

- `apps/backend/app/proxies/disconnect.py` races owned forwarding work against a disconnect watcher. Only the upload reader calls `receive()` until it sees the final request frame. The watcher then handles disconnects during pool acquisition, header waits, response iteration and downstream backpressure.
- Both forwarding and watcher tasks are cancelled/joined as appropriate before the ASGI call returns. External/server cancellation continues to propagate; an observed downstream disconnect is recorded separately and returns without attempting another response.
- `apps/backend/app/proxies/litellm_common.py` retains response/upload ownership. Cancellation-resistant closure covers HTTPX's automatic EOF close as well as explicit final cleanup. Repeated cancellation waits for owned cleanup instead of interrupting it. Both resources are attempted if one close fails, and cleanup errors do not replace a primary upstream/cancellation error.
- Already received upstream status and request correlation IDs remain intact on cancellation/disconnect. Raw response chunks, headers, authentication and routing policies remain unchanged.
- No new timeout or concurrency limit is imposed. Cleanup is allowed to finish rather than being silently abandoned; a genuinely stuck close can therefore prolong shutdown/request finalization. The `closing` count, age samples and cleanup-failure signals make that visible. A separate cleanup deadline would require an explicit policy and additional evidence, not a hidden timeout adjustment.

### Focused diagnostics

- `apps/backend/app/observability/litellm.py` tracks exact application request counts by worker-local pool and phase, with at most 128 sampled active request records. Three oldest samples appear in rate-limited pool-timeout snapshots, with request/phase ages, safe request IDs and route templates.
- Pool-timeout snapshots log at most once per second per worker; counters still count every failure. Qualified exception and cause classes are recorded without exception messages, headers, bodies, credentials or query strings.
- Streaming proxy lifetime/phase durations and events are observed in the shared forwarding lifecycle. Buffered identity/decision calls have their own `buffered_request` phase and cancellation/failure accounting in `transport.py`.
- Existing service telemetry owns the new instruments when metrics export is enabled. With telemetry disabled, in-memory counts and timeout/cleanup logs still function. No global OTel providers or production telemetry configuration are changed.
- Metrics: `axon.litellm.requests.active`, `axon.litellm.requests.sampled_oldest_age`, `axon.litellm.request.duration`, `axon.litellm.phase.duration`, and `axon.litellm.events`. Metric labels never contain correlation IDs or arbitrary resource paths.
- Startup logs identify PID, configured upstream origin/root, connection limits and relevant timeouts without keys. Request completion logs add `exception_class` and `cleanup_error_class`.
- These are **application lifecycle** measurements, not private HTTPX pool statistics. `awaiting_headers` includes acquisition/connect/upload/headers, and open responses include JSON/assets as well as generation streams. Ages are explicitly sampled and may omit unsampled overflow requests. No exact pool-wait metric is fabricated.

### Regression coverage

`test_litellm_incident_reproduction.py` now requires slot recovery after disconnect rather than preserving the old defect, including real Uvicorn/httptools under asyncio and uvloop. Connected, stalled upload/downstream tests remain characterization tests for unchanged timeout policies.

Additional suites:

- `test_litellm_disconnect.py`: real pool-wait disconnect, exclusive upload receive ownership, repeated cancellation during streaming/EOF cleanup, joining owned tasks, attempting both resource closes, and preserving a primary upstream error when cleanup also fails.
- `test_litellm_diagnostics.py`: exact counts despite bounded-sample overflow, idempotent release, rate-limited snapshots with full failure counts, secret-free exception logs, metric labels/durations/gauges, and buffered cancellation accounting.

Two existing raw-streaming test fixtures were updated to model ASGI correctly: after their final upload frame they block for disconnect rather than raising iterator exhaustion. Their raw-byte/header/security/read-ahead assertions remain intact.

Implementation validation: **968 backend tests passed, 1 pre-existing Docker base-image expectation test failed** (`test_python_stages_share_private_base_without_bundled_dbmate`, unchanged from the investigation). The three incident/disconnect/diagnostics suites contain **21 passing cases**. Ruff checks pass for every changed Python file. The full run also reports the previously observed telemetry-export 401 warnings; no production collector configuration was changed.

The backend README documents the new behavior, metric meanings and sampling limitations. Roll out through a reviewed canary with the deployed image's versions, verify prompt count recovery after client disconnects and no cleanup failures, then monitor per-worker pending/open-response/closing ages and pool-timeout counts. Do not deploy pool/timeouts/auth/routing changes alongside this patch merely to test the incident hypothesis.
