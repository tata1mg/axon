import type { AxonPaths } from "../../product/paths.ts";
import { emitProductEvent } from "../../telemetry/product-events.ts";
import { runAuthLogin } from "../commands/auth.ts";
import { InvalidSessionContentError, loadEncryptedSession } from "./session.ts";
import { verifyEncryptedSession } from "./verification.ts";
import { waitForAuthWork } from "./wait-for-auth.ts";

const CONTROL_PATH = "/_axon/auth";
const UI_HEARTBEAT_MS = 10_000;
const RECOVERY_TIMEOUT_MS = 5 * 60_000;

/** Whether the launch had no login at all, or one that stopped working. */
export type RecoveryReason = "signed-out" | "expired";

interface PendingRecovery {
  readonly id: string;
  readonly reason: RecoveryReason;
  readonly expiresAt: number;
  readonly controller: AbortController;
  readonly result: Promise<boolean>;
  readonly finish: (
    authenticated: boolean,
    failure?: { outcome: "failed" | "cancelled"; reason: string },
  ) => void;
  state: "required" | "logging-in";
  waiters: number;
}

export interface SessionRecoveryOptions {
  /**
   * The launch had no usable login (RPC launches defer it). Until a login succeeds or
   * the saved session changes from this one, managed requests fail fast and the chat
   * offers sign-in itself, rather than requests waiting on a recovery.
   */
  readonly signedOut?: { readonly session: string | undefined };
}

export interface SessionRecovery {
  recover(signal: AbortSignal, reason?: RecoveryReason): Promise<boolean>;
  /** Whether a request carrying this saved session must be rejected as signed out. */
  isSignedOut(currentSession: string | undefined): boolean;
  handle(request: Request, url: URL): Promise<Response | undefined>;
  dispose(): void;
}

function controlResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

/** Control requests are capability-protected by the relay and never expose the real session. */
export function createSessionRecovery(
  paths: AxonPaths,
  options: SessionRecoveryOptions = {},
): SessionRecovery {
  let connectedUntil = 0;
  let pending: PendingRecovery | undefined;
  let disposed = false;
  let signedOut = options.signedOut;
  let signingIn = false;
  const lifetime = new AbortController();

  function isSignedOut(currentSession: string | undefined): boolean {
    // A login from another terminal or the VS Code extension lifts the gate too.
    if (currentSession !== undefined && currentSession !== signedOut?.session) {
      signedOut = undefined;
    }
    return signedOut !== undefined;
  }

  async function signIn(request: Request): Promise<Response> {
    if (signingIn || pending?.state === "logging-in") {
      return controlResponse({ detail: "Browser login is already in progress" }, 409);
    }
    signingIn = true;
    const recovery = pending;
    if (recovery !== undefined) recovery.state = "logging-in";
    const signal = AbortSignal.any([lifetime.signal, request.signal]);
    let authenticated = false;
    let alreadyAuthenticated = false;
    try {
      let session: string | undefined;
      try {
        session = await loadEncryptedSession(paths);
      } catch (error) {
        // Browser login can repair corrupt contents, but not unsafe storage.
        if (!(error instanceof InvalidSessionContentError)) throw error;
      }
      // A launch-time flag or a saved token is not proof of a current login.
      // Verification also attempts a safe refresh before requiring the browser.
      alreadyAuthenticated =
        session !== undefined && (await verifyEncryptedSession(session, paths)) === "VERIFIED";
      if (!alreadyAuthenticated && !signal.aborted) {
        await runAuthLogin(paths, { browser: true, quiet: true, signal });
        session = await loadEncryptedSession(paths);
        authenticated =
          session !== undefined &&
          (await verifyEncryptedSession(session, paths)) === "VERIFIED" &&
          !signal.aborted;
      } else {
        authenticated = alreadyAuthenticated && !signal.aborted;
      }
    } catch {
      // An outage or storage failure is not a reason to open another browser.
      // Keep credentials, browser URLs, and upstream errors out of Pi's transcript.
    } finally {
      signingIn = false;
      if (authenticated) {
        signedOut = undefined;
        // /axon-login also resumes any model requests already waiting for login.
        pending?.finish(true);
      } else if (pending === recovery && recovery !== undefined) {
        recovery.state = "required";
      }
    }
    return controlResponse(
      {
        authenticated,
        ...(authenticated && alreadyAuthenticated ? { alreadyAuthenticated: true } : {}),
      },
      authenticated ? 200 : 401,
    );
  }

  async function waitForRecovery(recovery: PendingRecovery, signal: AbortSignal): Promise<boolean> {
    recovery.waiters += 1;
    try {
      return await waitForAuthWork(recovery.result, signal);
    } catch (error) {
      if (signal.aborted) return false;
      throw error;
    } finally {
      recovery.waiters -= 1;
      // One cancelled subagent must not cancel login for other waiting requests.
      if (recovery.waiters === 0) recovery.finish(false);
    }
  }

  return {
    async recover(signal, reason = "expired") {
      // No registered interactive UI means a scripted/RPC request must fail promptly.
      if (disposed || signal.aborted || Date.now() >= connectedUntil) return false;
      if (pending !== undefined) return waitForRecovery(pending, signal);

      let resolveResult: (authenticated: boolean) => void = () => {};
      const result = new Promise<boolean>((resolve) => {
        resolveResult = resolve;
      });
      const controller = new AbortController();
      const startedAt = Date.now();
      emitProductEvent({ category: "auth", stage: "recovery", outcome: "pending" });
      const finish: PendingRecovery["finish"] = (authenticated, failure): void => {
        if (pending !== recovery) return;
        pending = undefined;
        clearTimeout(timeout);
        controller.abort();
        emitProductEvent({
          category: "auth",
          stage: "recovery",
          outcome: authenticated ? "success" : (failure?.outcome ?? "cancelled"),
          ...(authenticated ? {} : { reason: failure?.reason ?? "cancelled" }),
          durationMs: Date.now() - startedAt,
        });
        resolveResult(authenticated);
      };
      const timeout = setTimeout(
        () => finish(false, { outcome: "failed", reason: "timeout" }),
        RECOVERY_TIMEOUT_MS,
      );
      const recovery: PendingRecovery = {
        id: crypto.randomUUID(),
        reason,
        expiresAt: Date.now() + RECOVERY_TIMEOUT_MS,
        controller,
        result,
        finish,
        state: "required",
        waiters: 0,
      };
      pending = recovery;
      return waitForRecovery(recovery, signal);
    },
    isSignedOut,
    async handle(request, url) {
      if (!url.pathname.startsWith(`${CONTROL_PATH}/`)) return undefined;
      if (disposed) return controlResponse({ detail: "Session ended" }, 410);

      if (url.pathname === `${CONTROL_PATH}/status` && request.method === "GET") {
        connectedUntil = Date.now() + UI_HEARTBEAT_MS;
        if (signedOut !== undefined) {
          try {
            isSignedOut(await loadEncryptedSession(paths));
          } catch {
            // An unreadable session file is not a login; keep offering sign-in.
          }
        }
        return controlResponse({
          signedOut: signedOut !== undefined,
          recovery:
            pending === undefined
              ? null
              : {
                  id: pending.id,
                  reason: pending.reason,
                  state: pending.state,
                  expiresAt: pending.expiresAt,
                },
        });
      }
      if (request.method !== "POST") return controlResponse({ detail: "Not found" }, 404);
      if (url.pathname === `${CONTROL_PATH}/sign-in`) return signIn(request);
      const recovery = pending;
      if (recovery === undefined || url.searchParams.get("id") !== recovery.id) {
        return controlResponse({ detail: "Login request is no longer active" }, 409);
      }
      if (url.pathname === `${CONTROL_PATH}/cancel`) {
        recovery.finish(false);
        return controlResponse({ authenticated: false });
      }
      if (url.pathname !== `${CONTROL_PATH}/login`) {
        return controlResponse({ detail: "Not found" }, 404);
      }
      if (signingIn || recovery.state !== "required") {
        return controlResponse({ detail: "Browser login is already in progress" }, 409);
      }

      // Run independently of managed requests: they are waiting for this shared login.
      recovery.state = "logging-in";
      const signal = AbortSignal.any([recovery.controller.signal, request.signal]);
      let authenticated = false;
      try {
        await runAuthLogin(paths, {
          browser: true,
          quiet: true,
          signal,
        });
        const session = await loadEncryptedSession(paths);
        authenticated =
          session !== undefined &&
          (await verifyEncryptedSession(session, paths)) === "VERIFIED" &&
          !signal.aborted;
      } catch {
        // Keep credentials, browser URLs, and upstream errors out of Pi's transcript.
      } finally {
        recovery.finish(authenticated, {
          outcome: signal.aborted ? "cancelled" : "failed",
          reason: signal.aborted ? "cancelled" : "unavailable",
        });
      }
      return controlResponse({ authenticated }, authenticated ? 200 : 401);
    },
    dispose() {
      disposed = true;
      connectedUntil = 0;
      lifetime.abort();
      pending?.finish(false);
    },
  };
}
