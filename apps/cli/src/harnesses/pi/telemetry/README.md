# Embedded Pi organization telemetry

This directory vendors and adapts `pi-org-telemetry` version `0.2.0` for Axon.
The imported source was provided from:

```text
/Users/vaibhavmeena/Desktop/1mg/pi-otel-telemetry/pi-org-telemetry
```

The source repository had no commits when imported, so the files in this directory are the
reviewable source of truth for the imported snapshot. `UPSTREAM_SNAPSHOT.sha256` records every
imported source/test/doc/dashboard hash, and `UPSTREAM_PACKAGE.json` preserves the original package
metadata. Axon changes include:

- Bun tests and Axon TypeScript/Biome compatibility;
- a compile-time extension version because the materialized bundle has no adjacent package.json;
- deterministic bundling of OpenTelemetry dependencies into one standalone ESM extension;
- embedding and checksum-protected materialization through Axon's Pi resource manifest;
- authenticated managed HTTP/protobuf export through Axon, with live session reads/rotation
  and backend-authoritative user identity, separate from standard environment exporters;
- schema 4 GenAI development semantics: INTERNAL `invoke_agent pi`, observed CLIENT inference,
  INTERNAL `execute_tool {name}`, inclusive standard input tokens, separate gateway/response IDs,
  and invocation-owned direct-call histograms;
- transcript-owned inference attribution (not cache warming), finalized top-level tool usage once,
  cancellation without invented exceptions, and content collection kept OFF.

The upstream snapshot metadata remains archival; current adapted source and the generated bundle
are authoritative. The adapted runtime version is `0.6.0-axon.1` with schema version 4; the archival upstream package version is unchanged.

## Build

```bash
bun run telemetry:build
bun run telemetry:check
bun test src/harnesses/pi/telemetry/tests
```

`telemetry:build` writes
`src/harnesses/pi/resources/extensions/pi-org-telemetry.mjs`. Pi supplies only
`@earendil-works/pi-coding-agent`; all OpenTelemetry runtime dependencies are inside that generated
file. Loading it with `--extension` does not install packages or contact a registry.

## Runtime

The extension is loaded for every non-administrative `axon pi` invocation. It stays inert when a
OTLP endpoint is absent. Authenticated online non-administrative Pi (including scripted launches)
receives enablement/sampling/interval/batching policy from CLI config, overriding local disablement,
samplers, and batch delay/size/queue settings for both Pi and launcher telemetry.
There is no supported local opt-out of accepted managed enablement. Managed
export always uses HTTP/protobuf to the pinned Axon backend proxy and reads the saved session
for each batch; the backend replaces user identity with verified auth-service data. Configure
`OTEL_EXPORTER_OTLP_ENDPOINT`, or all three per-signal endpoints, as environment fallback; standard
headers/API keys and HTTP/protobuf or gRPC remain supported there. Offline Pi disables export.
See [Deployment](docs/deployment.md). Users receive this bundle by installing an updated Axon
CLI release and starting a new `axon pi` process; existing processes retain their loaded extension.
See the [schema migration](docs/telemetry-schema.md#migration-from-schema-version-3) before updating
collector span filters or token totals. No skill/workflow/plan, streaming, or process observations
are invented from these public events.

## Grafana dashboard

Import [`grafana.json`](grafana.json) and select the org Prometheus and Tempo datasources. One
dashboard serves both views: **User email = All** is the organization view, and picking emails
narrows every panel to those people. Rows, top to bottom:

- **Overview**: active and new users, sessions, interactions, cost, tokens, agent hours, cost per
  user/session, cache hit ratio, and LLM/tool error rates.
- **Adoption**: LLM-active user counts for today, this week and this month (calendar, Monday week
  start, dashboard timezone) and the last 24 hours, 7 days and 30 days; Axon user activity,
  sessions and interactions over time, users by terminal, and CLI versions. The tiles count only
  users with an observed model call, using the **LLM active** definition below, and use their own
  fixed windows, so they ignore the dashboard time range but follow the User and Workflow filters.
  The Overview **Active users** tile still counts everyone who opened a Pi session.
- **Leaderboards**: per-user table (cost, sessions, interactions, tokens, tool calls, agent hours),
  top users by tokens, top repositories and models by cost, and top sessions by cost (Tempo
  `pi.session` spans above the **Min session cost** threshold).
- **Cost & tokens**: cost over time by model, cost by usage source, token usage by type, token mix,
  and a per-model usage table (cost, requests, tokens, cache hit, cost per request, users).
- **Models & reasoning effort**: requests and cost by thinking level, effort mix over time,
  reasoning share of output, latency and context utilization by model.
- **Sessions & terminals**: sessions by terminal, mode and repository; per-session cost,
  duration, token and interaction distributions; session start/end reasons; inputs by source;
  interventions and recent interaction traces.
- **Agent loop**: runs, turns, repeated runs and inputs; LLM/tool calls per interaction; turn and
  run duration; tool latency by tool; turn outcomes, run stop reasons, and time waiting on the user.
- **Reliability**, then collapsed **Product** rows: recommender (funnel, decisions, routing signals,
  candidates), backup/restore, CLI health, compaction (triggers, outcomes, cost, duration,
  summarizer models, traces) and terminal permissions (decisions, approvals and wait time,
  YOLO adoption, policy events, blocked commands and traces). Auto-allowed terminal decisions are
  sampled (first per session, then 1 in 100); blocked and approval events are complete.

[`grafana-metrics-only.json`](grafana-metrics-only.json) is the same dashboard without the Tempo
panels; keep the two in sync (a test enforces it).

Counter totals use `(increase(m[w]) and (m offset w)) or (max_over_time(m[w]) unless (m offset w))`
instead of bare `increase`. Each process exports its own cumulative series and `increase` ignores a
series' first sample, which would drop short-lived processes (for example, a process that starts one
session first exports `pi_session_started_total=1`). The `unless` guard limits that first-sample
branch to newly observed series: an established series with too few samples for `increase` must not
fall back to its cumulative lifetime count (a test enforces the guard on every panel). Multi-counter
sums use a `label_replace` union rather than `+`, so a model without cache-write tokens still
appears. Histogram panels apply the same pattern to `_bucket` series, and product rows use it too:
launcher processes usually export a single sample. Whole-range totals are instant queries; trend
time series use the **Trend interval** bucket as their window. Active users count emails
with any Pi session-start counter sample in the window.

Use **Trend interval** to set the bucket for usage and cost trends,
LLM-active users, reasoning effort, session distributions, agent-loop trends, and recommender,
backup, restore, startup, auth/config and update outcome charts. Choose **Hourly** for short
ranges, **Daily** for a week, or **Weekly** for a month. Percentile panels compute directly from the
histogram observations in each selected window, not from averages of smaller percentiles.
The dashboard time range, short-window diagnostics, and whole-range summaries are unchanged.
Each point covers the bucket before its timestamp. Hourly and Daily points are one step apart and
aligned to UTC, so a Daily point ends at 05:30 IST. Grafana aligns a one-week step to Thursdays (the
Unix epoch), so **Weekly** is evaluated daily with a one-week window and keeps only the points that
end a Monday-to-Monday week; the hidden `trend_step` variable (derived from Trend interval with a
Prometheus `query_result`) supplies that one-day step. Trend panels set Max data points to 11000,
Prometheus' per-query limit, so Grafana does not widen the step past the bucket and skip data;
only Hourly ranges longer than about 458 days exceed it.

**Axon user activity** shows stacked bars per Trend interval bucket, not a rolling window;
each bar is the users with Pi session telemetry in that bucket. **LLM active** counts each email
once if Pi observed a foreground model call in the bucket, successful or not. The query compares
the latest per-process provider-call count with its last value in the week before the bucket (or
zero for a series with no sample in that week), so repeated idle exports do not count as calls,
including after a process stops exporting for a while, such as a laptop asleep overnight. **Session only** counts
emails with session samples but no observed call in the same bucket. Distinct users do not add up
across buckets, so the legend shows the mean and peak per bucket rather than a sum. The split is
based on exported telemetry, not a roster: users who never opened Pi cannot be counted, and missed
exports or calls outside the observed Pi provider lifecycle are not captured.

Run `promtool test rules src/harnesses/pi/telemetry/tests/grafana-llm-activity.promql.json` from
`apps/cli` to check the idle, first-export, per-email, and export-gap counting cases.

The shortest **Runs, turns and inputs** window is now one hour, above the four-export minimum
for the maximum five-minute export cadence. Prometheus regression scenarios exercise the turns
query at all three intervals and cover idle and sparse established series, newly observed
sessions, and Monday-aligned weekly points. From `apps/cli`, run them with
`promtool test rules src/harnesses/pi/telemetry/tests/grafana-counters.promql.json`; Bun tests
ensure the fixture expression stays identical to the dashboard query.

The **User email** selector, dependent repository options, panel filters, and per-user legends
use `user_email` for metrics and `user.email` for traces. Managed exports receive verified email
from DD auth; `user.id` remains unchanged in the telemetry schema. Multi-select and **All** are
supported. **All** includes only records with a non-empty email;
environment-fallback records without email are not shown. Repository filtering applies only to
activity metrics, session-summary histograms, and interaction traces, not token, cost, LLM, tool,
or telemetry-health metrics.

The **Workflow** selector filters every metrics panel, including token, cost, and product-event
panels, by `axon_workflow_name`, which comes from `AXON_WORKFLOW` on workflow-driven launches.
Its **All** value is `.*`, which in Prometheus also matches series with no workflow label, so
ordinary sessions stay visible. Picking a workflow shows only tagged sessions. Trace panels do not
filter by workflow: in TraceQL, comparing an attribute that is missing never matches, so the filter
would hide untagged traces. Filter traces by hand with `resource."axon.workflow.name" = "<name>"`.

## Product tracking

Content-free recommender, backup/restore, startup, auth/config, compaction, terminal-permission,
update and release-version observations now use the same managed OTel path. The dashboard adds
adoption, cost/cache, recommender funnel/decisions, transfer reliability, compaction,
terminal-permission and CLI operational panels; every product category must have a panel (a test
enforces it). Feedback is not
collected. See [Product telemetry](docs/product-telemetry.md) for producer ownership, schema,
backend configuration and best-effort monitoring limitations.

Read these documents before changing exported data:

- [Data policy](docs/data-policy.md)
- [Telemetry schema](docs/telemetry-schema.md)
- [Deployment](docs/deployment.md)
- [Limitations](docs/limitations.md)

The upstream extension is MIT licensed. Bundled OpenTelemetry dependencies are Apache-2.0; both
license texts are retained in the generated bundle's legal banner.
