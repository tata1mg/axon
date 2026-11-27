import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionNamingExtension from "../src/harnesses/pi/resources/extensions/session-naming.ts";

const HOST_VARIABLES = [
  "PASEO_AGENT_ID",
  "T3CODE_THREAD_ID",
  "T3_PI_MCP_EXTENSION_PATH",
  "GHOSTEX_SESSION_ID",
];
const CONTROLLED = [
  ...HOST_VARIABLES,
  "AXON_SESSION_NAMING",
  "PI_SESSION_NAMING_ENABLED",
  "PI_SESSION_NAMING_MODEL",
  "PI_SESSION_NAMING_TIMEOUT_MS",
  "PI_OFFLINE",
  "LITELLM_OFFLINE",
];
let saved: Record<string, string | undefined> = {};
const shutdowns: Array<() => void> = [];

beforeEach(() => {
  saved = Object.fromEntries(CONTROLLED.map((name) => [name, process.env[name]]));
  // Tests may themselves run inside one of these hosts.
  for (const name of CONTROLLED) delete process.env[name];
});

afterEach(() => {
  // Abort pending retries so no timer outlives its test.
  for (const shutdown of shutdowns.splice(0)) shutdown();
  jest.useRealTimers();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Reply = { stopReason: string; content: Array<{ type: "text"; text: string }> };

const MODEL = {
  provider: "litellm",
  id: "anthropic/claude-haiku-5-5",
  reasoning: false,
  maxTokens: 4096,
};
const titled = (text: string): Reply => ({ stopReason: "stop", content: [{ type: "text", text }] });
const failed: Reply = { stopReason: "error", content: [] };

/**
 * Loads the extension against a fake Pi. `flag` is the parsed --session-naming value. `replies`
 * are the naming model's answers in order; without them, model discovery fails.
 */
function setup(options: { flag?: string | undefined; replies?: Reply[]; branch?: unknown[] } = {}) {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const flags = new Set<string>();
  const warnings: string[] = [];
  let sessionName: string | undefined;
  sessionNamingExtension({
    registerFlag: (name: string) => {
      flags.add(name);
    },
    getFlag: (name: string) => (flags.has(name) ? options.flag : undefined),
    on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    events: { on: () => {} },
    registerCommand: () => {},
    getSessionName: () => sessionName,
    setSessionName: (name: string) => {
      sessionName = name;
    },
  } as unknown as ExtensionAPI);

  const replies = [...(options.replies ?? [])];
  const find = mock(() => (options.replies ? MODEL : undefined));
  const streamSimple = mock(
    (_model: unknown, request: { messages: Array<{ content: string }> }) => ({
      result: async () => replies.shift() ?? failed,
      request,
    }),
  );
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => warnings.push(message) },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/tmp/session-1.jsonl",
      getBranch: () => options.branch ?? [],
    },
    modelRegistry: {
      find,
      refresh: async () => ({ errors: new Map([["litellm", new Error("offline")]]) }),
      hasConfiguredAuth: () => true,
      streamSimple,
    },
  };
  const shutdown = () => handlers.get("session_shutdown")?.({});
  shutdowns.push(shutdown);
  return {
    find,
    streamSimple,
    warnings,
    sessionName: () => sessionName,
    setSessionName: (name: string) => {
      sessionName = name;
    },
    input: (text: string, source = "interactive") =>
      handlers.get("input")?.({ type: "input", text, source }, ctx),
    startSession: () => handlers.get("session_start")?.({}),
    shutdown,
  };
}

/** Lets pending promise callbacks run; works with fake timers. */
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

/** Submits a first prompt and reports whether naming started, and any warning it showed. */
async function runExchange(
  flag?: string,
): Promise<{ attempted: boolean; warning: string | undefined }> {
  const fake = setup({ flag });
  const result = fake.input("Fix the login bug");
  // The input must pass through untouched: naming never blocks or rewrites the prompt.
  expect(result).toBeUndefined();
  // The model lookup starts synchronously, before Pi starts the agent run.
  const attempted = fake.find.mock.calls.length > 0;
  fake.shutdown();
  return { attempted, warning: fake.warnings[0] };
}

async function attemptsNaming(flag?: string): Promise<boolean> {
  return (await runExchange(flag)).attempted;
}

test("names sessions when no self-naming host launched Axon", async () => {
  expect(await attemptsNaming()).toBe(true);
});

for (const name of HOST_VARIABLES) {
  test(`skips automatic naming when ${name} is set`, async () => {
    process.env[name] = "host-value";
    expect(await attemptsNaming()).toBe(false);
  });

  test(`${name} overrides PI_SESSION_NAMING_ENABLED=true`, async () => {
    process.env[name] = "host-value";
    process.env["PI_SESSION_NAMING_ENABLED"] = "true";
    expect(await attemptsNaming()).toBe(false);
  });
}

test("ignores blank host variables", async () => {
  process.env["PASEO_AGENT_ID"] = " ";
  expect(await attemptsNaming()).toBe(true);
});

describe("user override", () => {
  test("--session-naming on re-enables naming under a host", async () => {
    process.env["GHOSTEX_SESSION_ID"] = "S0a-P89jj-G1l4c";
    expect(await attemptsNaming("on")).toBe(true);
  });

  test("AXON_SESSION_NAMING=on re-enables naming under a host", async () => {
    process.env["PASEO_AGENT_ID"] = "agent-1";
    process.env["AXON_SESSION_NAMING"] = "on";
    expect(await attemptsNaming()).toBe(true);
  });

  test("off disables naming without a host, even when policy enables it", async () => {
    process.env["PI_SESSION_NAMING_ENABLED"] = "true";
    expect(await attemptsNaming("off")).toBe(false);
    process.env["AXON_SESSION_NAMING"] = "OFF";
    expect(await attemptsNaming()).toBe(false);
  });

  test("the flag wins over the environment variable", async () => {
    process.env["AXON_SESSION_NAMING"] = "off";
    expect(await attemptsNaming("on")).toBe(true);
    process.env["AXON_SESSION_NAMING"] = "on";
    expect(await attemptsNaming("off")).toBe(false);
  });

  test("auto keeps host detection", async () => {
    process.env["T3CODE_THREAD_ID"] = "thread-1";
    expect(await attemptsNaming("auto")).toBe(false);
    delete process.env["T3CODE_THREAD_ID"];
    expect(await attemptsNaming("auto")).toBe(true);
  });

  test("on never overrides administrator policy or offline mode", async () => {
    process.env["PI_SESSION_NAMING_ENABLED"] = "false";
    expect(await attemptsNaming("on")).toBe(false);
    process.env["PI_SESSION_NAMING_ENABLED"] = "true";
    process.env["PI_OFFLINE"] = "1";
    expect(await attemptsNaming("on")).toBe(false);
  });

  test("invalid values warn instead of guessing", async () => {
    const fromFlag = await runExchange("maybe");
    expect(fromFlag.attempted).toBe(false);
    expect(fromFlag.warning).toContain("Invalid --session-naming value");

    process.env["AXON_SESSION_NAMING"] = "sometimes";
    const fromEnvironment = await runExchange();
    expect(fromEnvironment.attempted).toBe(false);
    expect(fromEnvironment.warning).toContain("Invalid AXON_SESSION_NAMING setting");
  });
});

describe("first prompt", () => {
  test("titles the session from the first prompt", async () => {
    const fake = setup({ replies: [titled('"Fix login bug"')] });
    fake.input("Fix the login bug");
    await flush();
    expect(fake.sessionName()).toBe("Fix login bug");
    expect(fake.find).toHaveBeenCalledWith("litellm", "anthropic/claude-haiku-5-5");
    expect(fake.streamSimple.mock.calls[0]?.[1].messages[0]?.content).toBe(
      "User request:\nFix the login bug",
    );
  });

  test("requests a title only once per session", async () => {
    const fake = setup({ replies: [titled("First"), titled("Second")] });
    fake.input("First task");
    fake.input("Second task");
    await flush();
    expect(fake.streamSimple).toHaveBeenCalledTimes(1);
    expect(fake.sessionName()).toBe("First");

    fake.startSession();
    fake.setSessionName("");
    fake.input("New session task");
    await flush();
    expect(fake.streamSimple).toHaveBeenCalledTimes(2);
    expect(fake.sessionName()).toBe("Second");
  });

  test("ignores extension input, empty input and named sessions", async () => {
    const fake = setup({ replies: [titled("Title")] });
    fake.input("Injected by an extension", "extension");
    fake.input("   ");
    fake.setSessionName("Chosen by the user");
    fake.input("Real prompt");
    await flush();
    expect(fake.find).not.toHaveBeenCalled();
    expect(fake.sessionName()).toBe("Chosen by the user");
  });

  test("names a resumed, unnamed session from its first message", async () => {
    const fake = setup({
      replies: [titled("Title")],
      branch: [{ type: "message", message: { role: "user", content: "Original task" } }],
    });
    fake.input("continue");
    await flush();
    expect(fake.streamSimple.mock.calls[0]?.[1].messages[0]?.content).toBe(
      "User request:\nOriginal task",
    );
  });

  test("never overwrites a name the user set while the request ran", async () => {
    const fake = setup({ replies: [titled("Generated")] });
    fake.input("Fix the login bug");
    fake.setSessionName("Mine");
    await flush();
    expect(fake.sessionName()).toBe("Mine");
  });
});

describe("retries", () => {
  test("retries once, 10 seconds after a failure", async () => {
    jest.useFakeTimers();
    const fake = setup({ replies: [failed, titled("Fix login bug")] });
    fake.input("Fix the login bug");
    await flush();
    expect(fake.streamSimple).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(9_999);
    await flush();
    expect(fake.streamSimple).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await flush();
    expect(fake.streamSimple).toHaveBeenCalledTimes(2);
    expect(fake.sessionName()).toBe("Fix login bug");
    expect(fake.warnings).toEqual([]);
  });

  test("stops after two attempts and warns once", async () => {
    jest.useFakeTimers();
    const fake = setup({ replies: [failed, failed, titled("Too late")] });
    fake.input("Fix the login bug");
    await flush();
    for (let step = 0; step < 6; step++) {
      jest.advanceTimersByTime(10_000);
      await flush();
    }
    expect(fake.streamSimple).toHaveBeenCalledTimes(2);
    expect(fake.sessionName()).toBeUndefined();
    expect(fake.warnings).toHaveLength(1);
    expect(fake.warnings[0]).toContain("use /name <title>");
    expect(fake.warnings[0]).not.toContain("/session-rename");
  });

  test("a new session cancels a pending retry", async () => {
    jest.useFakeTimers();
    const fake = setup({ replies: [failed, titled("Stale")] });
    fake.input("Fix the login bug");
    await flush();
    fake.startSession();
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(fake.streamSimple).toHaveBeenCalledTimes(1);
    expect(fake.sessionName()).toBeUndefined();
    expect(fake.warnings).toEqual([]);
  });
});
