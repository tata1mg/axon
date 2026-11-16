import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { compact, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseClientConfig } from "../src/cli/client-config.ts";
import { createCompactionOverrides } from "../src/harnesses/pi/launch-preferences-environment.ts";
import compactionExtension from "../src/harnesses/pi/resources/extensions/compaction.ts";
import requestContextExtension, {
  buildRequestContext,
  REQUEST_CONTEXT_CHANNEL,
} from "../src/harnesses/pi/resources/extensions/request-context.ts";

type Preparation = Parameters<typeof compact>[0];
type Model = NonNullable<ExtensionContext["model"]>;
const environmentKeys = [
  "ENABLED",
  "MODEL",
  "THRESHOLD_TOKENS",
  "MAX_OUTPUT_TOKENS",
  "TIMEOUT_MS",
].map((key) => `PI_COMPACTION_${key}`);
const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setup(policy: unknown, failure?: "auth" | "missing" | "empty" | "timeout") {
  for (const key of environmentKeys) delete process.env[key];
  const config = parseClientConfig({ schemaVersion: 1, compaction: policy });
  Object.assign(process.env, createCompactionOverrides(config.compaction));
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const model = {
    provider: "litellm",
    id: "team/summary",
    api: "openai-completions",
    reasoning: false,
    maxTokens: 10000,
    contextWindow: 128000,
  } as Model;
  const requests: {
    model: Model;
    maxTokens?: number;
    signal: AbortSignal;
    headers?: Record<string, string>;
  }[] = [];
  const finds: string[][] = [];
  const nativeSettings = {
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: false },
  };
  let compactions = 0;
  let idle = true;
  const ctx = {
    model,
    hasUI: true,
    thinkingLevel: "off",
    ui: { notify: () => {} },
    sessionManager: {
      getBranch: () => [],
      getLeafId: () => "leaf",
      getSessionId: () => "session-1",
    },
    modelRegistry: {
      find(provider: string, id: string) {
        finds.push([provider, id]);
        return failure === "missing" ? undefined : model;
      },
      hasConfiguredAuth: () => failure !== "auth",
      streamSimple(
        requestModel: Model,
        _context: unknown,
        options: { maxTokens?: number; signal: AbortSignal; headers?: Record<string, string> },
      ) {
        requests.push({ model: requestModel, ...options });
        return {
          result: async () => {
            if (failure === "timeout")
              await new Promise((_, reject) => {
                options.signal.addEventListener("abort", () => reject(options.signal.reason), {
                  once: true,
                });
              });
            return {
              role: "assistant",
              content: [{ type: "text", text: failure === "empty" ? "" : "safe summary" }],
              stopReason: "stop",
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 15,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: 1,
            };
          },
        };
      },
    },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 90000 }),
    compact(options: { onComplete: () => void }) {
      compactions++;
      options.onComplete();
    },
  } as unknown as ExtensionContext;
  const host = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: () => {},
    getSettings: () => nativeSettings,
    events: {
      emit: (channel: string, data: unknown) => {
        for (const listener of listeners.get(channel) ?? []) listener(data);
      },
      on: (channel: string, handler: (data: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
        return () => {};
      },
    },
  } as unknown as ExtensionAPI;
  compactionExtension(host);
  const emit = async (name: string, event: unknown = {}) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  const preparation: Preparation = {
    firstKeptEntryId: "kept",
    messagesToSummarize: [{ role: "user", content: "old history", timestamp: 1 }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 90000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: nativeSettings.compaction,
  };
  return {
    requests,
    finds,
    model,
    nativeSettings,
    preparation,
    publishContext: (data: unknown) => host.events.emit(REQUEST_CONTEXT_CHANNEL, data),
    loadRequestContext: (exec: ExtensionAPI["exec"]) => {
      const cwd = mkdtempSync(join(tmpdir(), "axon-compaction-context-"));
      directories.push(cwd);
      mkdirSync(join(cwd, ".git"));
      Object.assign(ctx, { cwd, mode: "rpc" });
      requestContextExtension({ ...host, exec });
    },
    compactions: () => compactions,
    setIdle: (value: boolean) => {
      idle = value;
    },
    emit,
    compact: (
      reason: "manual" | "threshold" | "overflow",
      tokensBefore = 90000,
      signal = new AbortController().signal,
    ) =>
      emit("session_before_compact", {
        reason,
        preparation: { ...preparation, tokensBefore },
        signal,
      }),
  };
}

test("managed model/output/timeout environment is consumed by the pinned Pi compaction implementation", async () => {
  const fixture = setup({
    enabled: true,
    model: "litellm/team/summary",
    maxOutputTokens: 1234,
    timeoutMs: 30000,
  });
  const result = (await fixture.compact("manual")) as { compaction?: { summary: string } };
  expect(result.compaction?.summary).toContain("safe summary");
  expect(fixture.finds).toEqual([["litellm", "team/summary"]]);
  expect(fixture.requests[0]?.model).toBe(fixture.model);
  expect(fixture.requests[0]?.maxTokens).toBe(1234);
  expect(fixture.requests[0]?.signal.aborted).toBe(false);
  expect(fixture.nativeSettings.compaction.enabled).toBe(true);
});

test("summary requests to LiteLLM carry the session's request context as compaction", async () => {
  const fixture = setup({ model: "litellm/team/summary" });
  await fixture.compact("manual");
  expect(fixture.requests[0]?.headers).toEqual({ "x-litellm-session-id": "session-1" });

  fixture.publishContext(
    buildRequestContext(
      { repo: "tata1mg/app", repoDir: ".", piMode: "tui" },
      { branch: "main", commit: "a1b2c3d" },
      { AXON_WORKFLOW: "pr-review" },
      () => "0123456789abcdef0123456789abcdef",
    ),
  );
  await fixture.compact("manual");
  const headers = fixture.requests[1]?.headers ?? {};
  expect(headers["x-litellm-session-id"]).toBe("session-1");
  expect(headers["x-litellm-tags"]).toBe(
    "axon_workflow:pr-review,repo:tata1mg/app,pi_mode:tui,call_kind:compaction",
  );
  expect(headers["langfuse_trace_id"]).toBe("0123456789abcdef0123456789abcdef");
  expect(headers["langfuse_trace_name"]).toBe("axon-prompt");
  expect(JSON.parse(headers["x-litellm-spend-logs-metadata"] as string)).toMatchObject({
    repo: "tata1mg/app",
    branch: "main",
    commit: "a1b2c3d",
    call_kind: "compaction",
  });

  fixture.model.provider = "anthropic";
  await fixture.compact("manual");
  expect(fixture.requests[2]?.headers).toBeUndefined();
});

function delayedGit(gate: Promise<void>, code = 0): ExtensionAPI["exec"] {
  return async (_command, args) => {
    await gate;
    const stdout = {
      "rev-parse --show-prefix": ".",
      "remote get-url origin": "git@github.com:tata1mg/app.git",
      "symbolic-ref --quiet --short HEAD": "main",
      "rev-parse --verify --quiet --short HEAD": "a1b2c3d",
    }[args.slice(2).join(" ")];
    if (stdout === undefined) throw new Error(`Unexpected Git arguments: ${args.join(" ")}`);
    return { code, stdout, stderr: "", killed: false, truncated: false };
  };
}

test("immediate resumed-session compaction awaits attribution from delayed Git", async () => {
  const fixture = setup({ model: "litellm/team/summary" });
  const git = Promise.withResolvers<void>();
  fixture.loadRequestContext(delayedGit(git.promise));
  await fixture.emit("session_start", { reason: "resume" });
  const pending = fixture.compact("manual");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(fixture.requests).toHaveLength(0);

  git.resolve();
  const result = (await pending) as { compaction?: { summary: string } };
  expect(result.compaction?.summary).toContain("safe summary");
  expect(fixture.requests).toHaveLength(1);
  const headers = fixture.requests[0]?.headers;
  expect(headers?.["x-litellm-session-id"]).toBe("session-1");
  expect(headers?.["x-litellm-tags"]).toContain("repo:tata1mg/app");
  expect(headers?.["x-litellm-tags"]).toEndWith(",call_kind:compaction");
  expect(JSON.parse(headers?.["x-litellm-spend-logs-metadata"] as string)).toMatchObject({
    repo: "tata1mg/app",
    repo_dir: ".",
    branch: "main",
    commit: "a1b2c3d",
    pi_mode: "rpc",
    call_kind: "compaction",
  });
});

test("failed initial attribution cancels compaction without an unattributed request", async () => {
  const fixture = setup({ model: "litellm/team/summary" });
  fixture.loadRequestContext(delayedGit(Promise.resolve(), 128));
  await fixture.emit("session_start", { reason: "resume" });
  expect(await fixture.compact("manual")).toEqual({ cancel: true });
  expect(fixture.requests).toHaveLength(0);
});

test("compaction cancelled while waiting for attribution sends no summary request", async () => {
  const fixture = setup({ model: "litellm/team/summary" });
  const git = Promise.withResolvers<void>();
  fixture.loadRequestContext(delayedGit(git.promise));
  await fixture.emit("session_start", { reason: "resume" });
  const controller = new AbortController();
  const pending = fixture.compact("manual", 90000, controller.signal);
  controller.abort();
  git.resolve();
  expect(await pending).toEqual({ cancel: true });
  expect(fixture.requests).toHaveLength(0);
});

test("non-LiteLLM compaction does not wait for or export request attribution", async () => {
  const fixture = setup({ model: "litellm/team/summary" });
  const git = Promise.withResolvers<void>();
  fixture.loadRequestContext(delayedGit(git.promise));
  fixture.model.provider = "anthropic";
  await fixture.emit("session_start", { reason: "resume" });
  const result = (await fixture.compact("manual")) as { compaction?: unknown };
  expect(result.compaction).toBeDefined();
  expect(fixture.requests[0]?.headers).toBeUndefined();
  git.resolve();
});

test.each([10000, 50000])(
  "summary cap %d respects the selected model's output limit without a native cap",
  async (maxOutputTokens) => {
    const fixture = setup({ model: "litellm/team/summary", maxOutputTokens });
    for (const reason of ["manual", "threshold", "overflow"] as const) {
      const result = (await fixture.compact(reason)) as { compaction?: { summary: string } };
      expect(result.compaction?.summary).toContain("safe summary");
    }
    expect(fixture.requests).toHaveLength(3);
    for (const request of fixture.requests) {
      expect(request.maxTokens).toBe(Math.min(maxOutputTokens, fixture.model.maxTokens));
    }
    expect(fixture.model.maxTokens).toBe(10000);
  },
);

test("split-turn history and prefix summaries both respect the model output limit", async () => {
  const fixture = setup({ maxOutputTokens: 50000 });
  fixture.preparation.isSplitTurn = true;
  fixture.preparation.turnPrefixMessages = [
    { role: "user", content: "start of the split turn", timestamp: 2 },
  ];
  const result = (await fixture.compact("manual")) as { compaction?: { summary: string } };
  expect(result.compaction?.summary).toContain("safe summary");
  expect(fixture.requests).toHaveLength(2);
  for (const request of fixture.requests) {
    expect(request.maxTokens).toBe(fixture.model.maxTokens);
  }
});

test.each([0, -1])("unknown model output limit %d preserves the explicit cap", async (limit) => {
  const fixture = setup({ maxOutputTokens: 50000 });
  fixture.model.maxTokens = limit;
  await fixture.compact("manual");
  expect(fixture.requests[0]?.maxTokens).toBe(50000);
});

test("uncapped custom summaries preserve native Pi output selection independently of reserveTokens", async () => {
  const fixture = setup({ model: "litellm/team/summary" });
  fixture.nativeSettings.compaction.reserveTokens = 100;
  const result = (await fixture.compact("manual")) as { compaction?: { summary: string } };
  expect(result.compaction?.summary).toContain("safe summary");
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]?.maxTokens).toBeUndefined();
  expect(fixture.model.maxTokens).toBe(10000);
});

test("false bypasses overrides without disabling native compaction; true alone invents no overrides", async () => {
  for (const policy of [{ enabled: false, model: "litellm/team/summary" }, { enabled: true }]) {
    const fixture = setup(policy);
    expect(await fixture.compact("manual")).toBeUndefined();
    expect(fixture.requests).toEqual([]);
    expect(fixture.nativeSettings.compaction.enabled).toBe(true);
  }
});

test("custom threshold schedules only while idle and respects native disabled settings", async () => {
  const fixture = setup({ thresholdTokens: 80000 });
  await fixture.emit("session_start");
  await fixture.emit("turn_end", { outcome: "completed" });
  fixture.setIdle(false);
  await fixture.emit("agent_settled");
  expect(fixture.compactions()).toBe(0);
  fixture.setIdle(true);
  fixture.nativeSettings.compaction.enabled = false;
  await fixture.emit("agent_settled");
  expect(fixture.compactions()).toBe(0);
  fixture.nativeSettings.compaction.enabled = true;
  await fixture.emit("agent_settled");
  await fixture.emit("agent_settled");
  expect(fixture.compactions()).toBe(1);
});

test("threshold can defer native threshold summaries, never manual or overflow recovery", async () => {
  const fixture = setup({ thresholdTokens: 80000, maxOutputTokens: 1234 });
  expect(await fixture.compact("threshold", 1000)).toEqual({ cancel: true });
  for (const reason of ["manual", "overflow"] as const) {
    const result = (await fixture.compact(reason, 1000)) as { compaction?: unknown };
    expect(result.compaction).toBeDefined();
  }
});

test.each(["auth", "missing", "empty", "timeout"] as const)(
  "configured summary failure cancels, without falling back: %s",
  async (failure) => {
    const fixture = setup(
      { model: "litellm/team/summary", timeoutMs: failure === "timeout" ? 5 : 30000 },
      failure,
    );
    expect(await fixture.compact("manual")).toEqual({ cancel: true });
    expect(fixture.requests.length).toBe(failure === "auth" || failure === "missing" ? 0 : 1);
  },
);
