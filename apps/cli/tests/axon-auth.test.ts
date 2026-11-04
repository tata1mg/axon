import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAxonAuth } from "../src/harnesses/pi/resources/extensions/axon-auth.ts";

type SelectOptions = { signal?: AbortSignal; timeout?: number };
interface Dialog {
  readonly title: string;
  readonly options: SelectOptions | undefined;
  answer(value: string | undefined): void;
  readonly settled: Promise<string | undefined>;
}

const environmentKeys = [
  "PI_AXON_AUTH_RELAY_URL",
  "PI_AXON_AUTH_RELAY_KEY",
  "PASEO_AGENT_ID",
] as const;
let savedEnvironment: Record<string, string | undefined>;
let relay: ReturnType<typeof Bun.serve> | undefined;
let shutdown: (() => unknown) | undefined;

beforeEach(() => {
  savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  // Tests run as a Paseo agent unless they say otherwise.
  process.env["PASEO_AGENT_ID"] = "agent-1";
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

const POLL_MS = 20;
/** Long enough for several status polls to have run. */
const settle = () => Bun.sleep(POLL_MS * 8);

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(20);
  }
}

/** A fake relay control endpoint and a Pi context whose dialogs the test answers. */
function setup(mode: "tui" | "rpc", options: { signedOut?: boolean; noRelay?: boolean } = {}) {
  const state = {
    recovery: null as {
      id: string;
      reason: "signed-out" | "expired";
      state: "required";
      expiresAt: number;
    } | null,
    signedOut: options.signedOut === true,
    authenticated: options.signedOut !== true,
    signInRequests: 0,
    signInWait: undefined as Promise<void> | undefined,
    signInFails: false,
    signIns: 0,
    logins: [] as string[],
    cancels: [] as string[],
    refreshes: 0,
  };
  relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const id = url.searchParams.get("id") ?? "";
      if (url.pathname === "/_axon/auth/status") {
        return Response.json({ signedOut: state.signedOut, recovery: state.recovery });
      }
      if (url.pathname === "/_axon/auth/sign-in") {
        state.signInRequests++;
        await state.signInWait;
        if (state.signInFails) return Response.json({ authenticated: false }, { status: 401 });
        if (state.authenticated) {
          return Response.json({ authenticated: true, alreadyAuthenticated: true });
        }
        state.signIns++;
        state.signedOut = false;
        state.authenticated = true;
        state.recovery = null;
        return Response.json({ authenticated: true });
      }
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
  if (options.noRelay) delete process.env["PI_AXON_AUTH_RELAY_URL"];
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const statuses: (string | undefined)[] = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const busHandlers = new Map<string, (data: unknown) => void>();
  createAxonAuth({ pollIntervalMs: POLL_MS })({
    events: {
      on(name: string, handler: (data: unknown) => void) {
        busHandlers.set(name, handler);
      },
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    mode,
    hasUI: true,
    modelRegistry: {
      refresh: async () => {
        state.refreshes++;
        return { aborted: false, errors: new Map() };
      },
    },
    ui: {
      setHeader() {},
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string) => notifications.push(message),
      // Mirrors Pi's dialog contract: abort or timeout resolves locally with undefined.
      select: (title: string, _choices: string[], options?: SelectOptions) => {
        let answer: (value: string | undefined) => void = () => {};
        const settled = new Promise<string | undefined>((resolve) => {
          answer = resolve;
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        dialogs.push({ title, options, answer, settled });
        return settled;
      },
    },
  } as unknown as ExtensionContext;
  handlers.get("session_start")?.({}, ctx);
  shutdown = () => handlers.get("session_shutdown")?.({}, ctx);

  const requireLogin = (id: string, reason: "signed-out" | "expired" = "expired") => {
    state.recovery = { id, reason, state: "required", expiresAt: Date.now() + 60_000 };
  };
  /** A Pi run ends; Paseo drops every open card when it failed or was interrupted. */
  const runEnds = (stopReason: "stop" | "error" | "aborted") => {
    handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason }] }, ctx);
    handlers.get("agent_settled")?.({ aborted: stopReason === "aborted" }, ctx);
  };
  const login = (args = "") => {
    const command = commands.get("axon-login");
    if (command === undefined) throw new Error("/axon-login was not registered");
    return command.handler(args, ctx);
  };
  const axonSafehouseEditor = (open: boolean) =>
    busHandlers.get("axon:axon-safehouse-editor")?.(open);
  return {
    state,
    dialogs,
    notifications,
    statuses,
    requireLogin,
    runEnds,
    login,
    axonSafehouseEditor,
  };
}

test("terminal recovery pauses for the Axon Safehouse editor and resumes after it closes", async () => {
  const { state, dialogs, requireLogin, axonSafehouseEditor } = setup("tui");
  requireLogin("recovery-during-axon-safehouse");
  await waitFor(() => dialogs.length === 1);
  axonSafehouseEditor(true);
  await settle();
  expect(await dialogs[0]?.settled).toBeUndefined();
  expect(state.cancels).toEqual([]);
  expect(dialogs).toHaveLength(1);

  axonSafehouseEditor(false);
  await waitFor(() => dialogs.length === 2);
  dialogs[1]?.answer("Login from browser");
  await waitFor(() => state.logins.length === 1);
  expect(state.logins).toEqual(["recovery-during-axon-safehouse"]);
});

for (const mode of ["tui", "rpc"] as const) {
  test(`/axon-login in ${mode} checks an existing login without opening a dialog or browser`, async () => {
    const { state, dialogs, notifications, login } = setup(mode);
    await login();
    expect(state.signInRequests).toBe(1);
    expect(state.signIns).toBe(0);
    expect(dialogs).toEqual([]);
    expect(notifications.at(-1)).toBe("Already signed in to Axon.");
  });

  test(`/axon-login in ${mode} replaces an unanswered sign-in dialog and waits for the browser`, async () => {
    const { state, dialogs, notifications, statuses, login } = setup(mode, { signedOut: true });
    await waitFor(() => dialogs.length === 1);
    const browser = Promise.withResolvers<void>();
    state.signInWait = browser.promise;
    let finished = false;
    const work = login().then(() => {
      finished = true;
    });
    await waitFor(() => state.signInRequests === 1);
    expect(await dialogs[0]?.settled).toBeUndefined();
    expect(finished).toBe(false);
    expect(notifications.some((message) => /cancelled|Not signed in/.test(message))).toBe(false);
    // Repeated commands join the same flow, and polling must not offer another card.
    const repeated = login();
    await settle();
    expect(state.signInRequests).toBe(1);
    expect(dialogs).toHaveLength(1);
    browser.resolve();
    await Promise.all([work, repeated]);
    expect(finished).toBe(true);
    expect(state.signIns).toBe(1);
    expect(state.refreshes).toBe(1);
    expect(notifications.at(-1)).toContain("Signed in to Axon");
    expect(statuses.at(-1)).toBeUndefined();
  });

  test(`/axon-login in ${mode} resumes a pending recovery without cancelling it`, async () => {
    const { state, dialogs, notifications, requireLogin, login } = setup(mode);
    state.authenticated = false;
    requireLogin("expired");
    await waitFor(() => dialogs.length === 1);
    await login();
    expect(state.signIns).toBe(1);
    expect(state.cancels).toEqual([]);
    expect(state.recovery).toBeNull();
    expect(notifications.at(-1)).toContain("Signed in to Axon");
  });
}

test("/axon-login works after Not now and permits retry after a failed login", async () => {
  const { state, dialogs, notifications, statuses, login } = setup("rpc", { signedOut: true });
  await waitFor(() => dialogs.length === 1);
  dialogs[0]?.answer("Not now (keep chat open)");
  await waitFor(() => notifications.length === 1);
  state.signInFails = true;
  await login();
  expect(notifications.at(-1)).toContain("run /axon-login to retry");
  expect(statuses.at(-1)).toBeUndefined();
  expect(state.refreshes).toBe(0);
  state.signInFails = false;
  await login();
  expect(state.signIns).toBe(1);
  expect(dialogs).toHaveLength(1);
});

test("/axon-login reports an unavailable relay without attempting login", async () => {
  const { state, notifications, login } = setup("rpc", { noRelay: true });
  await login();
  expect(state.signInRequests).toBe(0);
  expect(notifications.at(-1)).toContain("axon auth login --browser");
});

test("/axon-login rejects unexpected arguments", async () => {
  const { state, notifications, login } = setup("rpc");
  await login("unexpected");
  expect(state.signInRequests).toBe(0);
  expect(notifications.at(-1)).toBe("Usage: /axon-login");
});

test("RPC keeps one login card across recoveries and signs in against the current one", async () => {
  const { state, dialogs, requireLogin } = setup("rpc");
  requireLogin("first");
  await waitFor(() => dialogs.length === 1);
  // Paseo ignores dialog timeouts and Pi cannot retract a card, so none may be set.
  expect(dialogs[0]?.options?.timeout).toBeUndefined();

  // The first waiting request fails and a retry starts a fresh recovery.
  requireLogin("second");
  await settle();
  expect(dialogs).toHaveLength(1);

  dialogs[0]?.answer("Login from browser");
  await waitFor(() => state.logins.length === 1);
  expect(state.logins).toEqual(["second"]);
  expect(state.cancels).toEqual([]);
  // A new login may see a different catalog, and stale cached models stay hidden until refreshed.
  await waitFor(() => state.refreshes === 1);
});

test("a launch without any login asks the user to sign in rather than saying it expired", async () => {
  const { dialogs, requireLogin } = setup("rpc");
  requireLogin("first", "signed-out");
  await waitFor(() => dialogs.length === 1);
  expect(dialogs[0]?.title).toContain("not signed in");
});

test("a signed-out launch offers sign-in at startup, without any request waiting", async () => {
  const { state, dialogs, notifications } = setup("rpc", { signedOut: true });
  await waitFor(() => dialogs.length === 1);
  expect(dialogs[0]?.title).toContain("Sign in to start this chat");
  expect(dialogs[0]?.options?.timeout).toBeUndefined();

  dialogs[0]?.answer("Login from browser");
  await waitFor(() => state.signIns === 1);
  await waitFor(() => notifications.some((message) => message.startsWith("Signed in")));
  // Org settings are fixed at launch, so the user is told to restart for them.
  expect(notifications.at(-1)).toContain("Restart this agent");
  expect(state.refreshes).toBe(1);
  expect(state.logins).toEqual([]);
});

test("after Not now, a rejected message offers sign-in again", async () => {
  const { state, dialogs, runEnds } = setup("rpc", { signedOut: true });
  await waitFor(() => dialogs.length === 1);
  dialogs[0]?.answer("Not now (keep chat open)");
  await settle();
  expect(dialogs).toHaveLength(1);

  runEnds("stop");
  await settle();
  expect(dialogs).toHaveLength(1);

  // The user's message is rejected because they are signed out.
  runEnds("error");
  await waitFor(() => dialogs.length === 2);
  dialogs[1]?.answer("Login from browser");
  await waitFor(() => state.signIns === 1);
});

test("a failed run replaces the sign-in card Paseo dropped, without a Not now notice", async () => {
  const { state, dialogs, notifications, runEnds } = setup("rpc", { signedOut: true });
  await waitFor(() => dialogs.length === 1);
  runEnds("error");
  expect(await dialogs[0]?.settled).toBeUndefined();
  await waitFor(() => dialogs.length === 2);
  expect(notifications).toEqual([]);
  dialogs[1]?.answer("Login from browser");
  await waitFor(() => state.signIns === 1);
});

test("an interrupted run re-offers a pending recovery without cancelling it", async () => {
  const { state, dialogs, runEnds, requireLogin } = setup("rpc");
  requireLogin("first");
  await waitFor(() => dialogs.length === 1);
  runEnds("aborted");
  await waitFor(() => dialogs.length === 2);
  expect(state.cancels).toEqual([]);
  dialogs[1]?.answer("Login from browser");
  await waitFor(() => state.logins.length === 1);
  expect(state.logins).toEqual(["first"]);
});

test("an RPC client other than Paseo keeps its open card after a failed run", async () => {
  delete process.env["PASEO_AGENT_ID"];
  const { state, dialogs, notifications, runEnds } = setup("rpc", { signedOut: true });
  await waitFor(() => dialogs.length === 1);
  runEnds("error");
  await settle();
  expect(dialogs).toHaveLength(1);
  dialogs[0]?.answer("Login from browser");
  await waitFor(() => state.signIns === 1);
  expect(notifications.at(-1)).toContain("Restart this agent");
});

test("a successful run keeps the open card", async () => {
  const { dialogs, runEnds } = setup("rpc", { signedOut: true });
  await waitFor(() => dialogs.length === 1);
  runEnds("stop");
  await settle();
  expect(dialogs).toHaveLength(1);
});

test("sign-in completed elsewhere while the card was open is not repeated", async () => {
  const { state, dialogs, notifications } = setup("rpc", { signedOut: true });
  await waitFor(() => dialogs.length === 1);
  state.signedOut = false;
  dialogs[0]?.answer("Login from browser");
  await waitFor(() => notifications.length === 1);
  expect(notifications[0]).toContain("Already signed in");
  expect(state.signIns).toBe(0);
});

test("RPC reports a card answered after its recovery ended instead of logging in", async () => {
  const { state, dialogs, notifications, requireLogin } = setup("rpc");
  requireLogin("first");
  await waitFor(() => dialogs.length === 1);
  state.recovery = null;
  await settle();

  dialogs[0]?.answer("Login from browser");
  await waitFor(() => notifications.length === 1);
  expect(notifications[0]).toContain("no longer active");
  expect(state.logins).toEqual([]);
  expect(state.cancels).toEqual([]);
});

test("RPC declining the card cancels the recovery pending at that moment", async () => {
  const { state, dialogs, requireLogin } = setup("rpc");
  requireLogin("first");
  await waitFor(() => dialogs.length === 1);
  requireLogin("second");
  await settle();

  dialogs[0]?.answer("Not now (keep chat open)");
  await waitFor(() => state.cancels.length === 1);
  expect(state.cancels).toEqual(["second"]);
});

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
});
