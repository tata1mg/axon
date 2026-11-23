import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import tuiDefaultModel from "../src/harnesses/pi/resources/extensions/tui-default-model.ts";
import {
  createTuiDefaultModelOverrides,
  selectsPiModel,
  TUI_DEFAULT_MODEL_VARIABLES,
} from "../src/harnesses/pi/tui-default-model.ts";

const VARIABLES = Object.values(TUI_DEFAULT_MODEL_VARIABLES);
const GLM = { provider: "litellm", id: "z-ai/glm-5.3" };
const GEMINI = { provider: "litellm", id: "gemini/gemini-3.8-pro" };
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    PI_AXON_TUI_MODEL_MANAGED: "model,thinkingLevel",
    PI_AXON_TUI_MODEL_PROVIDER: GLM.provider,
    PI_AXON_TUI_MODEL: GLM.id,
    PI_AXON_TUI_THINKING_LEVEL: "max",
  });
});
afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function harness(
  options: {
    settings?: Record<string, unknown>;
    mode?: ExtensionContext["mode"];
    entries?: { type: string }[];
    scoped?: boolean;
    models?: (typeof GLM)[];
    authorized?: boolean;
    current?: typeof GLM;
    setModelResult?: boolean;
  } = {},
) {
  let handler: ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>) | undefined;
  const setModel = mock(async (_model: typeof GLM) => options.setModelResult ?? true);
  const setThinkingLevel = mock((_level: string) => {});
  tuiDefaultModel({
    on(name: string, registered: typeof handler) {
      if (name === "session_start") handler = registered;
    },
    getSettings: () => options.settings ?? {},
    setModel,
    setThinkingLevel,
  } as unknown as ExtensionAPI);
  const models = options.models ?? [GLM, GEMINI];
  const ctx = {
    mode: options.mode ?? "tui",
    model: options.current ?? GEMINI,
    scopedModels: options.scoped ? [{ model: GEMINI }] : [],
    sessionManager: { getBranch: () => options.entries ?? [] },
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: () => options.authorized ?? true,
    },
  } as unknown as ExtensionContext;
  return {
    setModel,
    setThinkingLevel,
    start: (reason: SessionStartEvent["reason"] = "startup") =>
      handler?.({ type: "session_start", reason }, ctx),
  };
}

describe("tui-default-model extension", () => {
  test("starts new TUI sessions on the backend model and thinking level", async () => {
    for (const reason of ["startup", "new"] as const) {
      const { start, setModel, setThinkingLevel } = harness();
      await start(reason);
      expect(setModel).toHaveBeenCalledWith(GLM);
      expect(setThinkingLevel).toHaveBeenCalledWith("max");
    }
  });

  test("leaves Pi's choice for resumed, forked and reloaded sessions", async () => {
    for (const reason of ["resume", "fork", "reload"] as const) {
      const { start, setModel, setThinkingLevel } = harness();
      await start(reason);
      expect(setModel).not.toHaveBeenCalled();
      expect(setThinkingLevel).not.toHaveBeenCalled();
    }
  });

  test.each([
    ["a saved default model", { settings: { defaultProvider: "litellm", defaultModel: "x/y" } }],
    ["a model scope", { scoped: true }],
    ["a session with messages (--continue)", { entries: [{ type: "message" }] }],
    ["RPC mode", { mode: "rpc" as const }],
    ["print mode", { mode: "print" as const }],
    ["a model the user cannot use", { models: [GEMINI] }],
    ["a provider without auth", { authorized: false }],
  ])("skips with %s", async (_name, options) => {
    const { start, setModel, setThinkingLevel } = harness(options);
    await start();
    expect(setModel).not.toHaveBeenCalled();
    expect(setThinkingLevel).not.toHaveBeenCalled();
  });

  test("skips without both a provider and a model", async () => {
    for (const name of [TUI_DEFAULT_MODEL_VARIABLES.provider, TUI_DEFAULT_MODEL_VARIABLES.model]) {
      const value = process.env[name];
      delete process.env[name];
      const { start, setModel } = harness();
      await start();
      expect(setModel).not.toHaveBeenCalled();
      process.env[name] = value;
    }
  });

  test("applies a model the user exported, which the launcher does not list as managed", async () => {
    process.env[TUI_DEFAULT_MODEL_VARIABLES.managed] = "thinkingLevel";
    const { start, setModel } = harness();
    await start();
    expect(setModel).toHaveBeenCalledWith(GLM);
  });

  test("a half-saved default (provider only) does not count, as in Pi", async () => {
    const { start, setModel } = harness({ settings: { defaultProvider: "litellm" } });
    await start();
    expect(setModel).toHaveBeenCalledWith(GLM);
  });

  test("the backend thinking level yields to a saved one; an exported one always applies", async () => {
    const savedLevels = [
      { defaultThinkingLevel: "low" },
      { modelThinkingLevels: { "litellm/z-ai/glm-5.3": "medium" } },
    ];
    for (const settings of savedLevels) {
      const { start, setModel, setThinkingLevel } = harness({ settings });
      await start();
      expect(setModel).toHaveBeenCalledWith(GLM);
      expect(setThinkingLevel).not.toHaveBeenCalled();
    }
    // The user exported PI_AXON_TUI_THINKING_LEVEL, so the launcher did not list it as managed.
    process.env[TUI_DEFAULT_MODEL_VARIABLES.managed] = "model";
    for (const settings of savedLevels) {
      const { start, setThinkingLevel } = harness({ settings });
      await start();
      expect(setThinkingLevel).toHaveBeenCalledWith("max");
    }
  });

  test("an unknown or missing thinking level leaves Pi's", async () => {
    process.env[TUI_DEFAULT_MODEL_VARIABLES.thinkingLevel] = "ultra";
    const unknown = harness();
    await unknown.start();
    expect(unknown.setModel).toHaveBeenCalledWith(GLM);
    expect(unknown.setThinkingLevel).not.toHaveBeenCalled();
    delete process.env[TUI_DEFAULT_MODEL_VARIABLES.thinkingLevel];
    const none = harness();
    await none.start();
    expect(none.setModel).toHaveBeenCalledWith(GLM);
    expect(none.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("keeps the current model when it already matches, and stops if Pi refuses it", async () => {
    const same = harness({ current: GLM });
    await same.start();
    expect(same.setModel).not.toHaveBeenCalled();
    expect(same.setThinkingLevel).toHaveBeenCalledWith("max");
    const refused = harness({ setModelResult: false });
    await refused.start();
    expect(refused.setThinkingLevel).not.toHaveBeenCalled();
  });
});

describe("launcher TUI default model environment", () => {
  const config = { provider: "litellm", model: "z-ai/glm-5.3", thinkingLevel: "max" as const };

  test("detects model selection flags before the option terminator", () => {
    for (const args of [
      ["--model", "x"],
      ["--model=x"],
      ["--models", "a,b"],
      ["--provider", "litellm", "--model", "x"],
      ["--thinking", "low"],
      ["--thinking=low", "hello"],
    ]) {
      expect(selectsPiModel(args)).toBe(true);
    }
    for (const args of [[], ["hello"], ["--continue"], ["--", "--model", "x"], ["--model-info"]]) {
      expect(selectsPiModel(args)).toBe(false);
    }
  });

  test("passes backend values to interactive launches without model flags only", () => {
    expect(createTuiDefaultModelOverrides({}, true, ["hello"], config)).toEqual({
      PI_AXON_TUI_MODEL_MANAGED: "model,thinkingLevel",
      PI_AXON_TUI_MODEL_PROVIDER: "litellm",
      PI_AXON_TUI_MODEL: "z-ai/glm-5.3",
      PI_AXON_TUI_THINKING_LEVEL: "max",
    });
    const removed = Object.fromEntries(VARIABLES.map((name) => [name, undefined]));
    expect(createTuiDefaultModelOverrides({}, false, [], config)).toEqual(removed);
    expect(createTuiDefaultModelOverrides({}, true, ["--model", "x"], config)).toEqual(removed);
    // Managed without a backend value, so a /reload can supply one.
    expect(createTuiDefaultModelOverrides({}, true, [], undefined)).toEqual({
      ...removed,
      PI_AXON_TUI_MODEL_MANAGED: "model,thinkingLevel",
    });
  });

  test("values the user exported win over the backend's and stay unmanaged", () => {
    const own = {
      PI_AXON_TUI_MODEL_PROVIDER: "litellm",
      PI_AXON_TUI_MODEL: "anthropic/claude-opus-5.5",
      PI_AXON_TUI_THINKING_LEVEL: "high",
    };
    expect(createTuiDefaultModelOverrides(own, true, [], config)).toEqual({
      PI_AXON_TUI_MODEL_MANAGED: undefined,
      ...own,
    });
    expect(
      createTuiDefaultModelOverrides({ PI_AXON_TUI_THINKING_LEVEL: "low" }, true, [], config),
    ).toEqual({
      PI_AXON_TUI_MODEL_MANAGED: "model",
      PI_AXON_TUI_MODEL_PROVIDER: "litellm",
      PI_AXON_TUI_MODEL: "z-ai/glm-5.3",
      PI_AXON_TUI_THINKING_LEVEL: "low",
    });
    // Half a model, or blank values, are not the user's choice.
    for (const partial of [
      { PI_AXON_TUI_MODEL: "anthropic/claude-opus-5.5" },
      { PI_AXON_TUI_MODEL_PROVIDER: "litellm", PI_AXON_TUI_MODEL: " " },
      { PI_AXON_TUI_THINKING_LEVEL: "" },
    ]) {
      expect(createTuiDefaultModelOverrides(partial, true, [], config)).toEqual({
        PI_AXON_TUI_MODEL_MANAGED: "model,thinkingLevel",
        PI_AXON_TUI_MODEL_PROVIDER: "litellm",
        PI_AXON_TUI_MODEL: "z-ai/glm-5.3",
        PI_AXON_TUI_THINKING_LEVEL: "max",
      });
    }
    // Flags still win over exported values.
    expect(createTuiDefaultModelOverrides(own, true, ["--thinking", "low"], config)).toEqual(
      Object.fromEntries(VARIABLES.map((name) => [name, undefined])),
    );
  });
});
