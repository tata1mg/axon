import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import axonExtension from "../src/harnesses/pi/resources/extensions/axon.ts";

type SelectOptions = { signal?: AbortSignal; timeout?: number };
interface Dialog {
  readonly options: SelectOptions | undefined;
  answer(value: string | undefined): void;
  readonly settled: Promise<string | undefined>;
}

const environmentKeys = ["PI_AXON_AUTH_RELAY_URL", "PI_AXON_AUTH_RELAY_KEY"] as const;
let savedEnvironment: Record<string, string | undefined>;
let relay: ReturnType<typeof Bun.serve> | undefined;
let shutdown: (() => unknown) | undefined;

beforeEach(() => {
  savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  shutdown?.();
  shutdown = undefined;
  relay?.stop(true);
  relay = undefined;
  for (const key of environmentKeys) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(20);
  }
}

/** A fake relay control endpoint and a Pi context whose dialogs the test answers. */
function setup(mode: "tui" | "rpc") {
  const state = {
    recovery: null as { id: string; state: "required"; expiresAt: number } | null,
    logins: [] as string[],
    cancels: [] as string[],
  };
  relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const id = url.searchParams.get("id") ?? "";
      if (url.pathname === "/_axon/auth/status") return Response.json({ recovery: state.recovery });
      if (url.pathname === "/_axon/auth/login") {
        state.logins.push(id);
        if (state.recovery?.id === id) state.recovery = null;
        return Response.json({ authenticated: true });
      }
      if (url.pathname === "/_axon/auth/cancel") {
        state.cancels.push(id);
        if (state.recovery?.id === id) state.recovery = null;
        return Response.json({ authenticated: false });
      }
      return new Response(null, { status: 404 });
    },
  });
  process.env["PI_AXON_AUTH_RELAY_URL"] = `http://127.0.0.1:${relay.port}/`;
  process.env["PI_AXON_AUTH_RELAY_KEY"] = "capability";

  const dialogs: Dialog[] = [];
  const notifications: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  axonExtension({
    events: { on: () => () => {} },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
    registerProvider() {},
    registerEntryRenderer() {},
    registerCommand() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    mode,
    hasUI: true,
    ui: {
      setHeader() {},
      setStatus() {},
      notify: (message: string) => notifications.push(message),
      // Mirrors Pi's dialog contract: abort or timeout resolves locally with undefined.
      select: (_title: string, _choices: string[], options?: SelectOptions) => {
        let answer: (value: string | undefined) => void = () => {};
        const settled = new Promise<string | undefined>((resolve) => {
          answer = resolve;
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        dialogs.push({ options, answer, settled });
        return settled;
      },
    },
  } as unknown as ExtensionContext;
  handlers.get("session_start")?.({}, ctx);
  shutdown = () => handlers.get("session_shutdown")?.({}, ctx);

  const requireLogin = (id: string) => {
    state.recovery = { id, state: "required", expiresAt: Date.now() + 60_000 };
  };
  return { state, dialogs, notifications, requireLogin };
}

test("RPC keeps one login card across recoveries and signs in against the current one", async () => {
  const { state, dialogs, requireLogin } = setup("rpc");
  requireLogin("first");
  await waitFor(() => dialogs.length === 1);
  // Paseo ignores dialog timeouts and Pi cannot retract a card, so none may be set.
  expect(dialogs[0]?.options?.timeout).toBeUndefined();

  // The first waiting request fails and a retry starts a fresh recovery.
  requireLogin("second");
  await Bun.sleep(1_300);
  expect(dialogs).toHaveLength(1);

  dialogs[0]?.answer("Login from browser");
  await waitFor(() => state.logins.length === 1);
  expect(state.logins).toEqual(["second"]);
  expect(state.cancels).toEqual([]);
}, 10_000);

test("RPC reports a card answered after its recovery ended instead of logging in", async () => {
  const { state, dialogs, notifications, requireLogin } = setup("rpc");
  requireLogin("first");
  await waitFor(() => dialogs.length === 1);
  state.recovery = null;
  await Bun.sleep(1_300);

  dialogs[0]?.answer("Login from browser");
  await waitFor(() => notifications.length === 1);
  expect(notifications[0]).toContain("no longer active");
  expect(state.logins).toEqual([]);
  expect(state.cancels).toEqual([]);
}, 10_000);

test("RPC declining the card cancels the recovery pending at that moment", async () => {
  const { state, dialogs, requireLogin } = setup("rpc");
  requireLogin("first");
  await waitFor(() => dialogs.length === 1);
  requireLogin("second");
  await Bun.sleep(1_300);

  dialogs[0]?.answer("Not now (keep chat open)");
  await waitFor(() => state.cancels.length === 1);
  expect(state.cancels).toEqual(["second"]);
}, 10_000);

test("the terminal dialog still closes itself when its recovery is replaced", async () => {
  const { state, dialogs, requireLogin } = setup("tui");
  requireLogin("first");
  await waitFor(() => dialogs.length === 1);
  expect(dialogs[0]?.options?.timeout).toBeGreaterThan(0);

  requireLogin("second");
  await waitFor(() => dialogs.length === 2);
  expect(await dialogs[0]?.settled).toBeUndefined();

  dialogs[1]?.answer("Login from browser");
  await waitFor(() => state.logins.length === 1);
  expect(state.logins).toEqual(["second"]);
}, 10_000);
