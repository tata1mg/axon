import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * In-chat Axon sign-in. The launcher's relay owns credentials, login, and request
 * retries; this extension only presents the relay's two login states:
 *
 * - Signed out: an RPC launch that deferred login. The relay rejects every managed
 *   request until sign-in, so the card is offered at startup and after rejected runs.
 * - Recovery: a session that expired mid-chat. A model request waits in the relay.
 *
 * Over RPC, Pi cannot retract a dialog: aborting or timing out a select only drops
 * Pi's side and leaves a dead card in the client. RPC cards therefore stay open until
 * answered, and act on whatever login is pending when the answer arrives.
 */

const POLL_INTERVAL_MS = 1_000;
const CONTROL_TIMEOUT_MS = 5_000;
const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60_000;
const STATUS_KEY = "axon-auth";

const LOGIN_CHOICE = "Login from browser";
const NOT_NOW_CHOICE = "Not now (keep chat open)";
const CHOICES = [LOGIN_CHOICE, NOT_NOW_CHOICE];
const SIGNED_IN_RESTART =
  "Signed in to Axon. Restart this agent to apply your organization's Axon settings, such as terminal policy.";
const UNAVAILABLE = "Axon login is unavailable here. Run axon auth login --browser in a terminal.";

interface RecoveryStatus {
  readonly id: string;
  readonly reason?: "signed-out" | "expired";
  readonly state: "required" | "logging-in";
  readonly expiresAt: number;
}

interface AuthStatus {
  readonly signedOut: boolean;
  readonly recovery: Partial<RecoveryStatus> | null;
}

/** One card, then the browser login it may start. At most one exists at a time. */
interface Flow {
  stage: "asking" | "logging-in";
  /** Set for recovery cards, which the terminal closes when their recovery ends. */
  readonly recoveryId: string | undefined;
  /** Abandons an unanswered card silently: no cancel, no "Not now" notice. */
  readonly dismiss: AbortController;
  done: Promise<void>;
}

interface AuthSession {
  /** `/axon-login`: verify the saved login, or sign in through the browser. */
  login(): Promise<void>;
  /** A Pi run finished; `failed` when it ended with an error or was aborted. */
  runSettled(failed: boolean): void;
  stop(): void;
}

export interface AxonAuthOptions {
  readonly pollIntervalMs?: number;
  /**
   * Whether the RPC client discards open cards when a run fails or is interrupted,
   * without answering Pi. Paseo 0.13 does (see `resolvePendingPermissionsForAgent` in
   * its agent manager), so a fresh card must replace the one it dropped.
   */
  readonly clientDropsCardsOnFailedRuns?: () => boolean;
}

function isRequiredRecovery(
  recovery: Partial<RecoveryStatus> | null | undefined,
): recovery is RecoveryStatus {
  return (
    recovery?.state === "required" &&
    typeof recovery.id === "string" &&
    typeof recovery.expiresAt === "number"
  );
}

// Keep in sync with axon.ts; each extension ships standalone.
function authRelayConfiguration(): { origin: string; capability: string } | undefined {
  const origin = Reflect.get(process.env, "PI_AXON_AUTH_RELAY_URL") as string | undefined;
  const capability = Reflect.get(process.env, "PI_AXON_AUTH_RELAY_KEY") as string | undefined;
  if (!origin || !capability) return undefined;
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return { origin: url.origin, capability };
  } catch {
    return undefined;
  }
}

const unavailableSession = (ctx: ExtensionContext): AuthSession => ({
  async login() {
    ctx.ui.notify(UNAVAILABLE, "warning");
  },
  runSettled() {},
  stop() {},
});

/** Polling runs independently of Pi's model request, which the relay can pause for login. */
function startAuthSession(
  ctx: ExtensionContext,
  settings: { readonly pollIntervalMs: number; readonly clientDropsCards: boolean },
): AuthSession {
  const relay = authRelayConfiguration();
  if (!ctx.hasUI || relay === undefined) return unavailableSession(ctx);

  const rpc = ctx.mode === "rpc";
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flow: Flow | undefined;
  let command: Promise<void> | undefined;
  let handledRecovery: string | undefined;
  // Offered once per signed-out stretch; a rejected run offers it again.
  let signInOffered = false;

  const control = (action: string, method = "GET", id?: string): Promise<Response> => {
    const url = new URL(`/_axon/auth/${action}`, relay.origin);
    if (id !== undefined) url.searchParams.set("id", id);
    const browser = action === "login" || action === "sign-in";
    return fetch(url, {
      method,
      headers: { Authorization: `Bearer ${relay.capability}` },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(browser ? BROWSER_LOGIN_TIMEOUT_MS : CONTROL_TIMEOUT_MS),
      ]),
    });
  };

  /** Undefined means the status could not be read. */
  const readStatus = async (): Promise<AuthStatus | undefined> => {
    const response = await control("status");
    if (!response.ok) return undefined;
    const payload = (await response.json()) as Partial<AuthStatus> | null;
    return { signedOut: payload?.signedOut === true, recovery: payload?.recovery ?? null };
  };

  const requestLogin = async (action: "login" | "sign-in", id?: string) => {
    const response = await control(action, "POST", id);
    const payload = (await response.json()) as {
      authenticated?: unknown;
      alreadyAuthenticated?: unknown;
    } | null;
    const authenticated = response.ok && payload?.authenticated === true;
    if (authenticated) {
      // Catalog refreshes refused while signed out left the cached models hidden;
      // the new login may also see a different catalog.
      void ctx.modelRegistry
        .refresh({ providers: ["litellm"], allowNetwork: true, force: true })
        .catch(() => {});
    }
    return {
      authenticated,
      alreadyAuthenticated: authenticated && payload?.alreadyAuthenticated === true,
    };
  };

  const browserLogin = async (current: Flow, action: "login" | "sign-in", id?: string) => {
    current.stage = "logging-in";
    ctx.ui.setStatus(STATUS_KEY, "Waiting for browser login…");
    ctx.ui.notify(
      "Complete login in your browser. This chat will continue after approval.",
      "info",
    );
    return (await requestLogin(action, id)).authenticated;
  };

  const start = (recoveryId: string | undefined, work: (current: Flow) => Promise<void>) => {
    const current: Flow = {
      stage: "asking",
      recoveryId,
      dismiss: new AbortController(),
      done: Promise.resolve(),
    };
    flow = current;
    current.done = work(current).finally(() => {
      if (flow === current) flow = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };

  const offerRecovery = async (current: Flow, offered: RecoveryStatus): Promise<void> => {
    const signedOut = offered.reason === "signed-out";
    ctx.ui.setStatus(STATUS_KEY, signedOut ? "Login required" : "Session expired — login required");
    const signal = AbortSignal.any([
      lifetime.signal,
      current.dismiss.signal,
      ...(rpc || ctx.signal === undefined ? [] : [ctx.signal]),
    ]);
    let recovery: RecoveryStatus | undefined = offered;
    try {
      const choice = await ctx.ui.select(
        signedOut
          ? "You're not signed in to Axon. Sign in to continue this chat."
          : "Your Axon session expired. Sign in to continue this chat.",
        CHOICES,
        rpc ? { signal } : { signal, timeout: Math.max(1, offered.expiresAt - Date.now()) },
      );
      if (current.dismiss.signal.aborted || lifetime.signal.aborted) return;
      if (rpc) {
        const pending = (await readStatus())?.recovery;
        recovery = isRequiredRecovery(pending) ? pending : undefined;
        if (recovery !== undefined) handledRecovery = recovery.id;
      }
      if (recovery === undefined) {
        if (choice === LOGIN_CHOICE) {
          ctx.ui.notify(
            "That sign-in request is no longer active. Send your message again to retry.",
            "info",
          );
        }
        return;
      }
      if (choice !== LOGIN_CHOICE || signal.aborted) {
        await control("cancel", "POST", recovery.id);
        ctx.ui.notify(
          "Login cancelled. Your chat is still open; sign in and retry when ready.",
          "warning",
        );
        return;
      }
      const authenticated = await browserLogin(current, "login", recovery.id);
      if (lifetime.signal.aborted) return;
      ctx.ui.notify(
        authenticated
          ? "Signed in. Continuing your chat…"
          : "Login failed or timed out. Your chat is still open; retry to sign in again.",
        authenticated ? "info" : "warning",
      );
    } catch {
      if (lifetime.signal.aborted) return;
      if (recovery !== undefined) await control("cancel", "POST", recovery.id).catch(() => {});
      ctx.ui.notify(
        "Login could not complete. Your chat is still open; retry when ready.",
        "warning",
      );
    }
  };

  const offerSignIn = async (current: Flow): Promise<void> => {
    ctx.ui.setStatus(STATUS_KEY, "Login required");
    const signal = AbortSignal.any([lifetime.signal, current.dismiss.signal]);
    try {
      const choice = await ctx.ui.select(
        "You're not signed in to Axon. Sign in to start this chat.",
        CHOICES,
        { signal },
      );
      if (signal.aborted) return;
      if (choice !== LOGIN_CHOICE) {
        ctx.ui.notify(
          "Not signed in. Send a message when you're ready, and Axon will offer sign-in again.",
          "warning",
        );
        return;
      }
      // Another terminal may have signed in while the card was open.
      if ((await readStatus())?.signedOut === false) {
        ctx.ui.notify("Already signed in to Axon.", "info");
        return;
      }
      const authenticated = await browserLogin(current, "sign-in");
      if (lifetime.signal.aborted) return;
      ctx.ui.notify(
        authenticated
          ? SIGNED_IN_RESTART
          : "Login failed or timed out. Send a message to try again.",
        authenticated ? "info" : "warning",
      );
    } catch {
      if (!lifetime.signal.aborted) {
        ctx.ui.notify("Login could not complete. Send a message to try again.", "warning");
      }
    }
  };

  const poll = async (): Promise<void> => {
    try {
      const status = await readStatus();
      if (status === undefined) return;
      const { recovery } = status;
      // A terminal card closes itself once its recovery is gone (cancelled or expired).
      if (
        !rpc &&
        flow?.stage === "asking" &&
        flow.recoveryId !== undefined &&
        flow.recoveryId !== recovery?.id
      ) {
        flow.dismiss.abort();
      }
      if (flow !== undefined || command !== undefined) return;
      if (status.signedOut) {
        if (signInOffered) return;
        signInOffered = true;
        start(undefined, offerSignIn);
      } else if (isRequiredRecovery(recovery) && recovery.id !== handledRecovery) {
        handledRecovery = recovery.id;
        start(recovery.id, (current) => offerRecovery(current, recovery));
      }
    } catch {
      // A transient loopback failure must not interrupt the chat or spam notifications.
    } finally {
      if (!lifetime.signal.aborted) timer = setTimeout(() => void poll(), settings.pollIntervalMs);
    }
  };

  const runCommand = async (): Promise<void> => {
    // A card that already started browser login owns that login; wait for it.
    if (flow?.stage === "logging-in") return flow.done;
    // Replace an unanswered card with the requested login, without cancelling a
    // waiting recovery: the sign-in endpoint resumes it.
    if (flow !== undefined) {
      flow.dismiss.abort();
      await flow.done;
    }
    if (lifetime.signal.aborted) return;
    signInOffered = true;
    ctx.ui.setStatus(STATUS_KEY, "Checking Axon login / waiting for browser…");
    ctx.ui.notify(
      "Checking your Axon login. If sign-in is needed, complete it in your browser; this command will wait.",
      "info",
    );
    try {
      const { authenticated, alreadyAuthenticated } = await requestLogin("sign-in");
      if (lifetime.signal.aborted) return;
      ctx.ui.notify(
        alreadyAuthenticated
          ? "Already signed in to Axon."
          : authenticated
            ? SIGNED_IN_RESTART
            : "Login failed or timed out. Your chat is still open; run /axon-login to retry.",
        authenticated ? "info" : "warning",
      );
    } catch {
      if (!lifetime.signal.aborted) {
        ctx.ui.notify(
          "Login could not complete. Your chat is still open; run /axon-login to retry.",
          "warning",
        );
      }
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  };

  void poll();
  return {
    login() {
      command ??= runCommand().finally(() => {
        command = undefined;
      });
      return command;
    },
    runSettled(failed) {
      if (!failed) return;
      // A rejected message is the user asking again.
      signInOffered = false;
      if (rpc && settings.clientDropsCards && flow?.stage === "asking") {
        flow.dismiss.abort();
        handledRecovery = undefined;
      }
    },
    stop() {
      lifetime.abort();
      if (timer !== undefined) clearTimeout(timer);
      ctx.ui.setStatus(STATUS_KEY, undefined);
    },
  };
}

export function createAxonAuth(options: AxonAuthOptions = {}): (pi: ExtensionAPI) => void {
  const settings = () => ({
    pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
    clientDropsCards: (
      options.clientDropsCardsOnFailedRuns ?? (() => process.env["PASEO_AGENT_ID"] !== undefined)
    )(),
  });

  return function axonAuth(pi: ExtensionAPI): void {
    let session: AuthSession | undefined;
    let lastRunFailed = false;

    pi.on("session_start", (_event, ctx) => {
      session?.stop();
      session = startAuthSession(ctx, settings());
    });
    pi.on("agent_end", (event) => {
      const last = event.messages.findLast((message) => message.role === "assistant");
      lastRunFailed =
        last !== undefined &&
        "stopReason" in last &&
        (last.stopReason === "error" || last.stopReason === "aborted");
    });
    // Paseo settles a turn, and clears its cards, on agent_settled; react after it.
    pi.on("agent_settled", (event) => {
      session?.runSettled(event.aborted || lastRunFailed);
      lastRunFailed = false;
    });
    pi.on("session_shutdown", () => {
      session?.stop();
      session = undefined;
    });

    pi.registerCommand("axon-login", {
      description: "Check Axon login and sign in through your browser if needed",
      handler: async (args, ctx) => {
        if (args.trim()) {
          ctx.ui.notify("Usage: /axon-login", "warning");
          return;
        }
        await (session ?? unavailableSession(ctx)).login();
      },
    });
  };
}

export default createAxonAuth();
