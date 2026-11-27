import { test } from "bun:test";
import assert from "node:assert/strict";
import { PRODUCT_STAGES } from "../../../../telemetry/product-events.ts";
import { COUNTER_UNITS, SPAN_INTERACTION, SPAN_SESSION } from "../src/attributes.ts";
import { resolveConfig } from "../src/config.ts";
import { SESSION_HISTOGRAMS } from "../src/otel/instruments.ts";
import { PRODUCT_HISTOGRAMS } from "../src/otel/product-instruments.ts";

interface Target {
  expr?: string;
  query?: string;
  queryType?: string;
  limit?: number;
  legendFormat?: string;
  interval?: string;
}

interface Panel {
  type: string;
  title: string;
  maxDataPoints?: number;
  datasource: { type: string };
  targets: Target[];
  interval?: string;
  timeFrom?: string;
  hideTimeOverride?: boolean;
  panels?: Panel[];
  fieldConfig?: {
    defaults?: {
      custom?: { drawStyle?: string; stacking?: { mode?: string } };
    };
  };
}

interface Dashboard {
  weekStart?: string;
  panels: Panel[];
  templating: {
    list: Array<{
      name: string;
      label: string;
      type: string;
      current?: { text: string; value: string };
      options?: Array<{ text: string; value: string; selected: boolean }>;
      query: string;
      definition: string;
      includeAll: boolean;
      allValue: string;
      multi: boolean;
      hide?: number;
      regex?: string;
      datasource?: { type: string };
    }>;
  };
}

const raw = (await Bun.file(new URL("../grafana.json", import.meta.url)).json()) as Dashboard;
// Rows carry no queries; collapsed rows nest their panels.
const dashboard = {
  ...raw,
  panels: raw.panels
    .flatMap((panel) => (panel.type === "row" ? (panel.panels ?? []) : [panel]))
    .filter((panel) => panel.type !== "row"),
};
// biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana dashboard variables use literal ${name} references.
const trendInterval = "${trend_interval}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana dashboard variables use literal ${name} references.
const trendStep = "${trend_step}";
// Weekly buckets are evaluated daily; only the points that end a Monday-to-Monday week are kept.
const trendMask = `((day_of_week(vector(time() + 43200)) == 1) or on() (label_replace(vector(1), "trend", "${trendInterval}", "", "") unless on(trend) label_replace(vector(1), "trend", "1w", "", "")))`;
/** The bucket query of a trend target, without the Monday filter for Weekly. */
function unmasked(expr: string): string {
  const suffix = `) and on() ${trendMask}`;
  assert.ok(expr.startsWith("(") && expr.endsWith(suffix), expr);
  return expr.slice(1, -suffix.length);
}
const emailMatcher = 'user_email=~"$user"';
const workflowMatcher = 'axon_workflow_name=~"$workflow"';
// Axon product metric names; the `axon_workflow_name` label is on every query and is not one.
const productMetric = /\baxon_(?!workflow_name\b)\w+/;

test("Grafana user selector lists non-empty emails and supports multi-select and All", () => {
  const user = dashboard.templating.list.find((variable) => variable.name === "user");
  assert.ok(user);
  assert.equal(user.label, "User email");
  assert.equal(
    user.query,
    'label_values({__name__=~"pi_session_started_total|pi_interaction_count_total|axon_.*_events_total",user_email!=""}, user_email)',
  );
  assert.equal(user.definition, user.query);
  assert.equal(user.includeAll, true);
  assert.equal(user.multi, true);
  assert.equal(user.allValue, ".+");
});

test("every Grafana metrics query respects the selected emails", () => {
  const panels = dashboard.panels.filter((panel) => panel.datasource.type === "prometheus");
  assert.ok(panels.length > 0);
  for (const panel of panels) {
    assert.ok(panel.targets.length > 0, panel.title);
    for (const target of panel.targets) {
      assert.ok(target.expr, panel.title);
      assert.ok(target.expr.includes(emailMatcher), panel.title);
      assert.ok(target.expr.includes(`${emailMatcher},${workflowMatcher}`), panel.title);
      assert.doesNotMatch(target.expr, /user_id/, panel.title);
      assert.doesNotMatch(target.legendFormat ?? "", /user_id/, panel.title);
    }
  }
});

test("Grafana workflow selector follows email selection and keeps untagged sessions under All", () => {
  const names = dashboard.templating.list.map((variable) => variable.name);
  assert.ok(names.indexOf("workflow") > names.indexOf("user"));
  assert.ok(names.indexOf("workflow") < names.indexOf("repo"));
  const workflow = dashboard.templating.list.find((variable) => variable.name === "workflow");
  assert.ok(workflow);
  assert.equal(workflow.label, "Workflow");
  assert.equal(
    workflow.query,
    'label_values({__name__=~"pi_session_started_total|pi_interaction_count_total|axon_.*_events_total",user_email=~"$user",axon_workflow_name!=""}, axon_workflow_name)',
  );
  assert.equal(workflow.definition, workflow.query);
  assert.equal(workflow.includeAll, true);
  assert.equal(workflow.multi, true);
  // `.*` also matches series without the label, so sessions launched without AXON_WORKFLOW stay
  // visible; `.+` would hide them.
  assert.equal(workflow.allValue, ".*");
});

test("Trend interval controls the bucket and minimum step on the selected trend panels only", () => {
  const interval = dashboard.templating.list.find((variable) => variable.name === "trend_interval");
  assert.ok(interval);
  assert.equal(interval.label, "Trend interval");
  assert.equal(interval.type, "custom");
  assert.equal(interval.query, "Hourly : 1h,Daily : 1d,Weekly : 1w");
  assert.deepEqual(
    interval.options?.map((option) => option.value),
    ["1h", "1d", "1w"],
  );
  assert.equal(interval.current?.value, "1h");
  assert.equal(interval.multi, false);
  assert.equal(interval.includeAll, false);
  const expected = [
    "Sessions and interactions",
    "Cost over time by model",
    "Token usage by type",
    "Reasoning effort mix over time",
    "Runs, turns and inputs",
    "Session cost distribution",
    "Session duration",
    "Interactions per session",
    "Tokens per session",
    "Calls per interaction",
    "Turn and run duration",
    "Tool latency p95 by tool",
    "Time waiting on the user",
    "Recommender skips and failures",
    "Backup outcomes",
    "Restore outcomes",
    "Startup outcomes",
    "Auth and config outcomes",
    "Update outcomes",
    "Axon user activity",
  ];
  const panels = dashboard.panels.filter((panel) =>
    panel.targets.some(
      (target) => target.interval === trendInterval || target.expr?.includes(trendInterval),
    ),
  );
  assert.deepEqual(panels.map((panel) => panel.title).sort(), expected.sort());
  const step = dashboard.templating.list.find((variable) => variable.name === "trend_step");
  assert.ok(step);
  assert.equal(step.type, "query");
  assert.equal(step.datasource?.type, "prometheus");
  assert.equal(step.hide, 2);
  assert.equal(
    step.query,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana dashboard variables use literal ${name} references.
    'query_result(label_replace(label_replace(vector(1), "step", "${trend_interval}", "", ""), "step", "1d", "step", "1w"))',
  );
  assert.equal(step.definition, step.query);
  assert.equal(step.regex, '/step="([^"]+)"/');
  for (const panel of panels) {
    assert.equal(panel.type, "timeseries", panel.title);
    assert.equal(panel.interval, undefined, panel.title);
    // Windows are the fixed bucket, so Grafana must never coarsen the step past it.
    assert.equal(panel.maxDataPoints, 11000, panel.title);
    for (const target of panel.targets) {
      // The step is the bucket, or one day for Weekly so the Monday filter can pick week ends.
      assert.equal(target.interval, trendStep, panel.title);
      assert.ok(target.expr, panel.title);
      assert.ok(!target.expr.includes("$__interval"), panel.title);
      // The LLM-activity query reads the call count before each bucket from a one-week
      // `[1w] offset` lookback; every other window is the bucket itself.
      const expr = unmasked(target.expr).replaceAll(`[1w] offset ${trendInterval}`, "");
      const windows = [...expr.matchAll(/\[([^\]]+)\]| offset ([^\s)]+)/g)];
      assert.ok(windows.length >= 2, panel.title);
      for (const [, duration, offset] of windows) {
        assert.equal(duration ?? offset, trendInterval, panel.title);
      }
    }
  }
});

test("LLM-active user tiles use fixed windows and the LLM activity chart's definition", () => {
  assert.equal(raw.weekStart, "monday");
  const chart = dashboard.panels.find((panel) => panel.title === "Axon user activity");
  const llmActive = chart?.targets.find((target) => target.legendFormat === "LLM active")?.expr;
  assert.ok(llmActive);
  const tiles: Array<[string, string]> = [
    ["Active users today", "now/d"],
    ["Active users, last 24 hours", "24h"],
    ["Active users this week", "now/w"],
    ["Active users, last 7 days", "7d"],
    ["Active users this month", "now/M"],
    ["Active users, last 30 days", "30d"],
  ];
  for (const [title, timeFrom] of tiles) {
    const panel = dashboard.panels.find((item) => item.title === title);
    assert.ok(panel, title);
    assert.equal(panel.type, "stat", title);
    assert.equal(panel.timeFrom, timeFrom, title);
    assert.equal(panel.hideTimeOverride, true, title);
    assert.equal(panel.targets.length, 1, title);
    assert.equal(
      panel.targets[0]?.expr,
      unmasked(llmActive).replaceAll(trendInterval, "$__range"),
      title,
    );
  }
});

test("LLM activity is a stacked bar per Trend interval and matches the PromQL regression scenario", async () => {
  assert.ok(
    !dashboard.templating.list.some((variable) => variable.name === "user_activity_window"),
  );
  const panel = dashboard.panels.find((item) => item.title === "Axon user activity");
  assert.ok(panel);
  assert.deepEqual(
    panel.targets.map((target) => target.legendFormat),
    ["LLM active", "Session only (no LLM call)"],
  );
  assert.equal(panel.fieldConfig?.defaults?.custom?.drawStyle, "bars");
  assert.equal(panel.fieldConfig?.defaults?.custom?.stacking?.mode, "normal");
  const fixture = (await Bun.file(
    new URL("./grafana-llm-activity.promql.json", import.meta.url),
  ).json()) as { tests: Array<{ promql_expr_test: Array<{ expr: string }> }> };
  const exprs = panel.targets.map((target) =>
    target.expr
      ?.replaceAll(trendInterval, "1d")
      .replaceAll("$user", ".+")
      .replaceAll("$workflow", ".*"),
  );
  assert.ok(fixture.tests.length > 0);
  for (const scenario of fixture.tests) {
    assert.deepEqual(
      exprs,
      scenario.promql_expr_test.map((check) => check.expr),
    );
  }
});

test("Grafana repository options and leaderboards follow email selection", () => {
  const repo = dashboard.templating.list.find((variable) => variable.name === "repo");
  assert.ok(repo);
  assert.ok(repo.query.includes(emailMatcher));
  assert.equal(repo.definition, repo.query);
  const leaderboard = dashboard.panels.find((panel) => panel.title === "User leaderboard");
  assert.ok(leaderboard);
  for (const target of leaderboard.targets) {
    assert.ok(target.expr?.includes("sum by (user_email)"), leaderboard.title);
  }
});

test("repository filters only apply to metrics that carry the repository label", () => {
  const repoScoped = /^pi_(session_|interaction_|agent_run|turn_|user_)/;
  for (const panel of dashboard.panels) {
    for (const target of panel.targets) {
      for (const [, name, selector] of (target.expr ?? "").matchAll(/(\w+)\{([^}]*)\}/g)) {
        if (selector?.includes("pi_repo_slug"))
          assert.match(name ?? "", repoScoped, `${panel.title}: ${name}`);
      }
    }
  }
});

test("counter sums never join metrics with + (which drops groups missing one side)", () => {
  for (const panel of dashboard.panels) {
    for (const target of panel.targets) {
      assert.doesNotMatch(target.expr ?? "", /\)\s*\+\s*(sum|\()/, panel.title);
    }
  }
});

test("session, terminal and reasoning panels use exported metric names and labels", () => {
  const queries = dashboard.panels.flatMap((panel) =>
    panel.targets.map((target) => target.expr ?? ""),
  );
  const sessionNames = new Set(
    Object.entries(SESSION_HISTOGRAMS).map(([name, { unit }]) => {
      const suffix = unit === "USD" ? "_USD" : "";
      return `${name.replaceAll(".", "_")}${suffix}`;
    }),
  );
  const used = queries.flatMap(
    (query) => query.match(/pi_session_(?:cost|tokens|interactions)\w*/g) ?? [],
  );
  assert.ok(used.length > 0);
  for (const name of used)
    assert.ok(sessionNames.has(name.replace(/_(bucket|sum|count)$/, "")), name);
  assert.ok(queries.some((query) => query.includes("by (terminal_type)")));
  assert.ok(queries.some((query) => query.includes("by (pi_thinking_level)")));
});

test("every Grafana trace query uses email selection and bounded TraceQL search", () => {
  const traces = dashboard.panels.filter((panel) => panel.datasource.type === "tempo");
  assert.equal(traces.length, 5);
  for (const panel of traces) {
    assert.ok(panel.targets.length > 0, panel.title);
    for (const target of panel.targets) {
      assert.ok(target.query, panel.title);
      assert.equal(target.queryType, "traceql", panel.title);
      assert.equal(target.limit, 50, panel.title);
      assert.ok(target.query.includes('resource."user.email" =~ "$user"'), panel.title);
      assert.doesNotMatch(target.query, /user\.id/, panel.title);
    }
  }
});

test("interaction traces retain the current span name and repository selection", () => {
  const panel = dashboard.panels.find((panel) => panel.title === "Recent interaction traces");
  assert.ok(panel);
  assert.equal(panel.datasource.type, "tempo");
  assert.equal(panel.targets.length, 1);
  assert.equal(
    panel.targets[0]?.query,
    `{ name = "${SPAN_INTERACTION}" && resource."user.email" =~ "$user" && span."pi.repo.slug" =~ "$repo" }`,
  );
});

test("session leaderboard reads the summary span with a bounded cost threshold", () => {
  const panel = dashboard.panels.find((panel) => panel.title === "Top sessions by cost");
  assert.ok(panel);
  assert.equal(panel.datasource.type, "tempo");
  const query = panel.targets[0]?.query ?? "";
  assert.ok(query.startsWith(`{ name = "${SPAN_SESSION}" && resource."user.email" =~ "$user"`));
  assert.ok(query.includes('span."pi.session.cost.usd" >= $min_session_cost'));
  const threshold = dashboard.templating.list.find((v) => v.name === "min_session_cost");
  assert.ok(threshold);
});

test("recommender traces match CLI resource identity or backend span identity without a repo constraint", () => {
  const panel = dashboard.panels.find((panel) => panel.title === "Recent recommender traces");
  assert.ok(panel);
  assert.equal(panel.datasource.type, "tempo");
  assert.equal(panel.targets.length, 1);
  assert.equal(
    panel.targets[0]?.query,
    '{ name = "axon.recommender.request" && (resource."user.email" =~ "$user" || span."user.email" =~ "$user") }',
  );
});

test("product histograms use the declared instrument names and translated units", () => {
  const expectedNames = new Set(
    Object.entries(PRODUCT_HISTOGRAMS).map(([name, { unit }]) => {
      const suffix = unit === "s" ? "_seconds" : unit === "By" ? "_bytes" : "";
      return `${name.replaceAll(".", "_")}${suffix}_bucket`;
    }),
  );
  const queries = dashboard.panels.flatMap((panel) =>
    panel.targets.map((target) => target.expr ?? ""),
  );
  const names = queries.flatMap((query) => query.match(/axon_\w+_bucket/g) ?? []);
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(expectedNames.has(name), name);
});

test("product metrics separate CLI funnel counts from backend requests and avoid repo/ID labels", () => {
  const productPanels = dashboard.panels.filter((panel) =>
    panel.targets.some((target) => productMetric.test(target.expr ?? "")),
  );
  assert.ok(productPanels.length > 0);
  for (const panel of productPanels) {
    for (const target of panel.targets) {
      assert.ok(target.expr, panel.title);
      assert.doesNotMatch(target.expr, /pi_repo_slug|recommendation_id|session_id/, panel.title);
      if (!productMetric.test(target.expr)) continue;
      if (panel.title === "Model recommender request p95") {
        assert.ok(target.expr.includes("by (le, component)"));
      } else {
        assert.ok(target.expr.includes('component="cli"'), panel.title);
      }
    }
  }
});

test("every product category has a dashboard panel", () => {
  const queries = dashboard.panels.flatMap((panel) =>
    panel.targets.map((target) => target.expr ?? ""),
  );
  for (const category of Object.keys(PRODUCT_STAGES))
    assert.ok(
      queries.some((query) => query.includes(`axon_${category}_`)),
      category,
    );
});

test("product windows keep each process's first sample", () => {
  // Launcher processes usually export one cumulative sample, which bare increase/rate ignore.
  for (const panel of dashboard.panels) {
    for (const target of panel.targets) {
      const expr = target.expr ?? "";
      for (const [, fn, name, selector, window] of expr.matchAll(
        /(increase|rate)\((axon_\w+)\{([^}]*)\}\[([^\]]+)\]\)/g,
      )) {
        assert.equal(fn, "increase", panel.title);
        assert.ok(expr.includes(`and (${name}{${selector}} offset ${window})`), panel.title);
        assert.ok(
          expr.includes(
            `or (max_over_time(${name}{${selector}}[${window}]) unless (${name}{${selector}} offset ${window}))`,
          ),
          panel.title,
        );
      }
    }
  }
});

test("counter fallbacks only count series first seen in the window", () => {
  // Unguarded, a series with one in-window sample would fall back to its lifetime total.
  for (const panel of dashboard.panels) {
    for (const target of panel.targets) {
      assert.doesNotMatch(target.expr ?? "", /\bor max_over_time\(/, panel.title);
    }
  }
});

test("whole-range totals are instant queries", () => {
  for (const panel of dashboard.panels) {
    for (const target of panel.targets as Array<Target & { instant?: boolean }>) {
      if (target.expr?.includes("$__range")) assert.equal(target.instant, true, panel.title);
    }
  }
});

test("agent-loop counter windows cover four exports even at the maximum configured cadence", () => {
  const panel = dashboard.panels.find((panel) => panel.title === "Runs, turns and inputs");
  assert.ok(panel);
  const config = resolveConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test",
    OTEL_METRIC_EXPORT_INTERVAL: String(Number.MAX_SAFE_INTEGER),
  });
  assert.ok(config);
  // The shortest Trend interval option is one hour.
  assert.ok(60 * 60_000 >= 4 * config.metricExportIntervalMs);
  const names = [
    "pi_agent_run_count_total",
    "pi_turn_count_total",
    "pi_agent_run_repeated_total",
    "pi_user_input_count_total",
  ];
  assert.equal(panel.targets.length, names.length);
  for (const [index, name] of names.entries()) {
    const metric = `${name}{user_email=~"$user",axon_workflow_name=~"$workflow",pi_repo_slug=~"$repo"}`;
    assert.equal(panel.targets[index]?.interval, trendStep, name);
    assert.equal(
      panel.targets[index]?.expr,
      `(sum ((increase(${metric}[${trendInterval}]) and (${metric} offset ${trendInterval})) or (max_over_time(${metric}[${trendInterval}]) unless (${metric} offset ${trendInterval})))) and on() ${trendMask}`,
      name,
    );
  }
});

test("PromQL counter regression fixtures evaluate the dashboard expression", async () => {
  const panel = dashboard.panels.find((panel) => panel.title === "Runs, turns and inputs");
  const turns = panel?.targets.find((target) => target.legendFormat === "Turns");
  assert.ok(turns?.expr);
  const fixture = (await Bun.file(
    new URL("./grafana-counters.promql.json", import.meta.url),
  ).json()) as { tests: Array<{ name: string; promql_expr_test: Array<{ expr: string }> }> };
  const durations = ["1h", "1h", "1h", "1h", "1h", "1h", "1d", "1w"];
  assert.equal(fixture.tests.length, durations.length);
  for (const [index, scenario] of fixture.tests.entries()) {
    const duration = durations[index];
    assert.ok(duration);
    const expr: string = turns.expr
      .replaceAll(trendInterval, duration)
      .replaceAll("$user", "test@example.com")
      .replaceAll("$workflow", ".*")
      .replaceAll("$repo", "test/repo");
    assert.ok(scenario.promql_expr_test.length > 0, scenario.name);
    for (const { expr: fixtureExpr } of scenario.promql_expr_test) {
      assert.equal(fixtureExpr, expr, scenario.name);
    }
  }
});

test("counter queries use exported counter names", () => {
  const counters = new Set(
    Object.entries(COUNTER_UNITS).map(
      ([name, unit]) => `${name.replaceAll(".", "_")}${unit === "USD" ? "_USD" : ""}_total`,
    ),
  );
  for (const panel of dashboard.panels) {
    for (const target of panel.targets) {
      for (const name of target.expr?.match(/\bpi_\w+_total\b/g) ?? [])
        assert.ok(counters.has(name), `${panel.title}: ${name}`);
    }
  }
});

test("metrics-only dashboard is the full dashboard without Tempo panels", async () => {
  const metricsOnly = (await Bun.file(
    new URL("../grafana-metrics-only.json", import.meta.url),
  ).json()) as Dashboard & Record<string, unknown>;
  const full = raw as Dashboard & Record<string, unknown> & { __inputs: { pluginId: string }[] };
  const withoutTempo = (panels: Panel[]): Panel[] =>
    panels
      .filter((panel) => panel.datasource?.type !== "tempo")
      .map((panel) => (panel.panels ? { ...panel, panels: withoutTempo(panel.panels) } : panel));
  assert.deepEqual(metricsOnly, {
    ...full,
    __inputs: full.__inputs.filter((input) => input.pluginId !== "tempo"),
    title: `${full["title"]} (Metrics Only)`,
    uid: `${full["uid"]}-metrics`,
    description: metricsOnly["description"],
    panels: withoutTempo(full.panels),
  });
  assert.match(String(metricsOnly["description"]), /Tempo trace panels omitted/);
});
