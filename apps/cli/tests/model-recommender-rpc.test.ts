import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createModelRecommender } from "../src/harnesses/pi/resources/extensions/model-recommender.ts";
import { type ProductEvent, sanitizeProductEvent } from "../src/telemetry/product-events.ts";

type Model = NonNullable<ExtensionContext["model"]>;
type Dependencies = NonNullable<Parameters<typeof createModelRecommender>[0]>;
type Select = (
  title: string,
  options: string[],
  opts?: { signal?: AbortSignal; timeout?: number },
) => Promise<string | undefined>;

const original = { provider: "litellm", id: "model-original", name: "Original" } as Model;
const recommended = { provider: "litellm", id: "model-recommended", name: "Fast" } as Model;
const another = { provider: "litellm", id: "model-other", name: "Deep" } as Model;

const ENVIRONMENT = [
  "PASEO_AGENT_ID",
  "PI_MODEL_RECOMMENDER_RPC",
  "PI_MODEL_RECOMMENDER_URL",
  "PI_MODEL_RECOMMENDER_AUTO_SELECT_MS",
  "PI_MODEL_RECOMMENDER_DISABLED",
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENVIRONMENT.map((name) => [name, process.env[name]]));
  for (const name of ENVIRONMENT) delete process.env[name];
});

afterEach(() => {
  for (const name of ENVIRONMENT) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function setup(
  options: { mode?: "tui" | "rpc"; select?: Select; dependencies?: Dependencies } = {},
) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const events: ProductEvent[] = [];
  const dialogs: { title: string; options: string[]; timeout?: number | undefined }[] = [];
  let requests = 0;
  let customs = 0;
  const ctx = {
    model: original,
    mode: options.mode ?? "rpc",
    scopedModels: [],
    modelRegistry: { getAvailable: () => [original, recommended, another] },
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: () => {},
      custom: async () => {
        customs++;
        return undefined;
      },
      select: async (
        title: string,
        choices: string[],
        opts?: { signal?: AbortSignal; timeout?: number },
      ) => {
        dialogs.push({ title, options: choices, timeout: opts?.timeout });
        return (options.select ?? (async (_t, all) => all[0]))(title, choices, opts);
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    events: {
      emit(_channel: string, raw: unknown) {
        const event = sanitizeProductEvent(raw);
        if (event) events.push(event);
      },
    },
    async setModel(model: Model) {
      ctx.model = model;
      return true;
    },
  } as unknown as ExtensionAPI;
  createModelRecommender({
    request: async () => {
      requests++;
      return {
        kind: "success",
        ranked: [
          { model: recommended, reason: "quick edit" },
          { model: another, reason: "hard reasoning" },
        ],
      };
    },
    ...options.dependencies,
  })(pi);
  return {
    ctx,
    events,
    dialogs,
    requests: () => requests,
    customs: () => customs,
    decision: () => events.find((event) => event.stage === "decision")?.outcome,
    async run(source = options.mode === "tui" ? "interactive" : "rpc") {
      await handlers.get("session_start")?.({}, ctx);
      await handlers.get("input")?.({ text: "fix the bug", source }, ctx);
    },
  };
}

test("RPC input is ignored unless the session opted in", async () => {
  const fixture = setup();
  await fixture.run();
  assert.equal(fixture.requests(), 0);
  assert.equal(fixture.dialogs.length, 0);
  assert.equal(fixture.events.length, 0);
});

test("a Paseo agent alone does not enable RPC, since abort cannot cancel the pending prompt", async () => {
  process.env["PASEO_AGENT_ID"] = "agent-1";
  const fixture = setup();
  await fixture.run();
  assert.equal(fixture.requests(), 0);
  assert.equal(fixture.dialogs.length, 0);
});

test("an explicit opt-out keeps RPC disabled", async () => {
  process.env["PI_MODEL_RECOMMENDER_RPC"] = "0";
  const fixture = setup();
  await fixture.run();
  assert.equal(fixture.requests(), 0);
});

test("with RPC opted in the picker uses a standard select dialog and applies the choice", async () => {
  process.env["PI_MODEL_RECOMMENDER_RPC"] = "1";
  const fixture = setup({ select: async (_title, choices) => choices[1] });
  await fixture.run();
  assert.equal(fixture.customs(), 0);
  assert.equal(fixture.dialogs.length, 1);
  assert.match(fixture.dialogs[0]?.title ?? "", /auto-selects Fast in 10s/);
  // The client gets the deadline, since Pi cannot retract the question on expiry.
  assert.equal(fixture.dialogs[0]?.timeout, 10_000);
  assert.deepEqual(fixture.dialogs[0]?.options, [
    "★ Fast — quick edit",
    "Deep — hard reasoning",
    "Keep current (Original)",
  ]);
  assert.equal(fixture.decision(), "selected");
  assert.equal(fixture.ctx.model, another);
});

test("keep current, dismissal and countdown expiry have distinct outcomes", async () => {
  process.env["PI_MODEL_RECOMMENDER_RPC"] = "1";

  const kept = setup({ select: async (_title, choices) => choices.at(-1) });
  await kept.run();
  assert.equal(kept.decision(), "kept_current");
  assert.equal(kept.ctx.model, original);

  const dismissed = setup({ select: async () => undefined });
  await dismissed.run();
  assert.equal(dismissed.decision(), "dismissed");
  assert.equal(dismissed.ctx.model, original);

  process.env["PI_MODEL_RECOMMENDER_AUTO_SELECT_MS"] = "20";
  const expired = setup({
    select: (_title, _choices, opts) =>
      new Promise((resolve) =>
        opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
      ),
  });
  await expired.run();
  assert.equal(expired.decision(), "auto_selected");
  assert.equal(expired.ctx.model, recommended);

  // Pi's own `timeout` may settle the dialog before the abort signal fires.
  const piTimeout = setup({
    select: (_title, _choices, opts) =>
      new Promise((resolve) => setTimeout(() => resolve(undefined), opts?.timeout)),
  });
  await piTimeout.run();
  assert.equal(piTimeout.decision(), "auto_selected");
  assert.equal(piTimeout.ctx.model, recommended);
});

test("duplicate display names fall back to the model key so options stay unambiguous", async () => {
  process.env["PI_MODEL_RECOMMENDER_RPC"] = "1";
  const twin = { provider: "bedrock", id: "fast", name: "Fast" } as Model;
  const fixture = setup({
    select: async (_title, choices) => choices[1],
    dependencies: {
      request: async () => ({
        kind: "success",
        ranked: [
          { model: recommended, reason: "a" },
          { model: twin, reason: "b" },
        ],
      }),
    },
  });
  await fixture.run();
  assert.deepEqual(fixture.dialogs[0]?.options.slice(0, 2), [
    "★ litellm/model-recommended — a",
    "bedrock/fast — b",
  ]);
  assert.equal(fixture.ctx.model, twin);
});

test("terminal sessions keep the custom picker even with RPC enabled", async () => {
  process.env["PI_MODEL_RECOMMENDER_RPC"] = "1";
  const fixture = setup({ mode: "tui" });
  await fixture.run();
  assert.equal(fixture.customs(), 1);
  assert.equal(fixture.dialogs.length, 0);
  // RPC-sourced input in a terminal session stays ineligible.
  const rpcSource = setup({ mode: "tui" });
  await rpcSource.run("rpc");
  assert.equal(rpcSource.requests(), 0);
});

test("RPC sessions fetch recommendations without the terminal loader", async () => {
  process.env["PI_MODEL_RECOMMENDER_RPC"] = "1";
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        recommendations: [{ provider: "litellm", model: "model-other", reason: "deep work" }],
      }),
  });
  try {
    process.env["PI_MODEL_RECOMMENDER_URL"] = server.url.href;
    // Real request implementation; only the dialog is faked.
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    let customs = 0;
    const offered: string[][] = [];
    const ctx = {
      model: original,
      mode: "rpc",
      scopedModels: [],
      modelRegistry: { getAvailable: () => [original, recommended, another] },
      sessionManager: { getBranch: () => [] },
      ui: {
        notify: () => {},
        custom: async () => {
          customs++;
        },
        select: async (_title: string, choices: string[]) => {
          offered.push(choices);
          return choices[0];
        },
      },
    } as unknown as ExtensionContext;
    const pi = {
      on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
        handlers.set(name, handler),
      events: { emit() {} },
      async setModel(model: Model) {
        ctx.model = model;
        return true;
      },
    } as unknown as ExtensionAPI;
    createModelRecommender()(pi);
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("input")?.({ text: "refactor", source: "rpc" }, ctx);
    assert.equal(customs, 0);
    assert.deepEqual(offered, [["★ Deep — deep work", "Keep current (Original)"]]);
    assert.equal(ctx.model, another);
  } finally {
    server.stop(true);
  }
});
