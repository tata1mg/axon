import { timingSafeEqual } from "node:crypto";

import { BUILD_INFO } from "../../build-info.ts";
import { applyPiDefaults } from "../../harnesses/pi/settings-defaults.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../../product/endpoints.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { createSandboxConfigurationRelay } from "../../sandbox/configuration-relay.ts";
import { createBackupRelay } from "../../sessions/relay.ts";
import { emitProductEvent } from "../../telemetry/product-events.ts";
import { fetchClientConfig } from "../client-config.ts";
import {
  createRelayDiagnostics,
  observeRelayResponse,
  type RelayRequestDiagnostics,
} from "./relay-diagnostics.ts";
import { loadEncryptedSession, refreshEncryptedSession } from "./session.ts";
import {
  createSessionRecovery,
  type SessionRecovery,
  type SessionRecoveryOptions,
} from "./session-recovery.ts";
import { type SessionVerificationStatus, verifyEncryptedSession } from "./verification.ts";
import { waitForAuthWork } from "./wait-for-auth.ts";

const MAX_RELAY_REQUEST_BODY_BYTES = 50 * 1024 * 1024;

const REMOVED_REQUEST_HEADERS = [
  "authorization",
  "api-key",
  "x-api-key",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "x-session-refresh-token",
  "x-auth-context",
  "x-encrypted-session-data",
];
const REMOVED_RESPONSE_HEADERS = [
  "authorization",
  "api-key",
  "x-api-key",
  "set-cookie",
  "content-length",
  "content-encoding",
  "connection",
  "transfer-encoding",
  "new_session_data",
  "x-session-refresh-token",
  "x-auth-context",
  "x-encrypted-session-data",
];

export interface AuthenticatedRequestRelay {
  readonly origin: string;
  readonly capability: string;
  readonly diagnosticsLogFile: string;
  /** Home-relative location shown to users; never the absolute path. */
  readonly diagnosticsLogLabel: string;
  dispose(): void;
}

function relayError(status: number, message: string): Response {
  return Response.json(
    {
      detail: message,
      error: {
        message,
        type: status === 401 ? "authentication_error" : "gateway_error",
      },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function matchesCapability(value: string, expected: string): boolean {
  const supplied = Buffer.from(value);
  const required = Buffer.from(expected);
  return supplied.length === required.length && timingSafeEqual(supplied, required);
}

function authorizedLocalRequest(request: Request, capability: string): boolean {
  // OpenAI uses Authorization; native Anthropic requests may use x-api-key.
  const authorization = request.headers.get("authorization");
  const apiKey = request.headers.get("x-api-key");
  if (authorization === null && apiKey === null) return false;
  return (
    (authorization === null || matchesCapability(authorization, `Bearer ${capability}`)) &&
    (apiKey === null || matchesCapability(apiKey, capability))
  );
}

type RefreshOutcome = "saved" | "superseded" | "account_changed";

interface RelaySession {
  load(signal: AbortSignal): Promise<string | undefined>;
  refresh(expectedSession: string, refreshedSession: string): Promise<RefreshOutcome>;
  verify(encryptedSession: string): Promise<SessionVerificationStatus>;
  adoptLostRotation(rejectedSession: string): Promise<boolean>;
}

const MAX_TRACKED_ROTATIONS = 16;

/** Only credential persistence is serialized; upstream requests remain concurrent. */
function createRelaySession(paths: AxonPaths): RelaySession {
  let pendingRefresh = Promise.resolve();
  // Concurrent responses can each rotate the same credential, and only the first is saved.
  // Keep the others in memory in case the auth service honours only a later rotation.
  const rotations = new Map<string, string[]>();
  const predecessors = new Map<string, string>();
  const savedRotations = new Map<string, string>();
  const verifications = new Map<string, Promise<SessionVerificationStatus>>();

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = pendingRefresh.then(work);
    // A failed save must fail its request, not poison later requests' refresh waits.
    pendingRefresh = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function track(predecessor: string, rotation: string): void {
    let siblings = rotations.get(predecessor);
    if (siblings === undefined) {
      siblings = [];
      rotations.set(predecessor, siblings);
      for (const [oldest, forgotten] of rotations) {
        if (rotations.size <= MAX_TRACKED_ROTATIONS) break;
        rotations.delete(oldest);
        savedRotations.delete(oldest);
        for (const token of forgotten) predecessors.delete(token);
      }
    }
    if (!siblings.includes(rotation)) siblings.push(rotation);
    predecessors.set(rotation, predecessor);
  }

  function verify(encryptedSession: string): Promise<SessionVerificationStatus> {
    // Concurrent rejections of one credential share a single verification round trip.
    let verification = verifications.get(encryptedSession);
    if (verification === undefined) {
      verification = verifyEncryptedSession(encryptedSession, paths).finally(() =>
        verifications.delete(encryptedSession),
      );
      verifications.set(encryptedSession, verification);
    }
    return verification;
  }

  return {
    async load(signal) {
      while (true) {
        const refresh = pendingRefresh;
        await waitForAuthWork(refresh, signal);
        const session = await loadEncryptedSession(paths);
        signal.throwIfAborted();
        // A rotation started during the read: wait for it and read the live credential again.
        if (refresh === pendingRefresh) return session;
      }
    },
    refresh(expectedSession, refreshedSession) {
      track(expectedSession, refreshedSession);
      return serialized(async () => {
        if (await refreshEncryptedSession(paths, expectedSession, refreshedSession)) {
          savedRotations.set(expectedSession, refreshedSession);
          return "saved";
        }
        // Losing a race to a sibling rotation is not an account switch.
        return savedRotations.has(expectedSession) ? "superseded" : "account_changed";
      });
    },
    verify,
    async adoptLostRotation(rejectedSession) {
      const predecessor = predecessors.get(rejectedSession);
      const siblings = predecessor === undefined ? undefined : rotations.get(predecessor);
      if (predecessor === undefined || siblings === undefined) return false;
      for (const candidate of siblings.filter((token) => token !== rejectedSession)) {
        // Try each lost rotation at most once so a stale family cannot loop.
        siblings.splice(siblings.indexOf(candidate), 1);
        // This credential is not the live saved session yet. A read-only probe
        // must not adopt or verify some other credential via the shared file.
        if ((await verifyEncryptedSession(candidate)) !== "VERIFIED") continue;
        // Conditional persistence: never replace a credential another login already changed.
        const adopted = await serialized(() =>
          refreshEncryptedSession(paths, rejectedSession, candidate),
        );
        if (adopted) savedRotations.set(predecessor, candidate);
        return adopted;
      }
      return false;
    },
  };
}

async function forwardManagedRequest(
  request: Request,
  url: URL,
  session: RelaySession,
  recovery: SessionRecovery,
  diagnostic: RelayRequestDiagnostics,
  logLabel: string,
): Promise<Response> {
  // Only the bounded request body is replayable. Successful response/SSE bodies stay streaming.
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  if (body !== undefined && body.byteLength > MAX_RELAY_REQUEST_BODY_BYTES) {
    return relayError(413, "Axon request is too large.");
  }
  // Recommendations have their own short-lived picker. Recover on the ensuing model
  // request instead of opening a second dialog over that picker.
  const supportsRecovery = url.pathname.startsWith("/litellm/");
  const loginRequired = (): Response =>
    relayError(
      401,
      "Your Axon session is invalid or expired. Your chat is still open. Run axon auth login in another terminal, then retry here.",
    );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    request.signal.throwIfAborted();
    let encryptedSession: string | undefined;
    try {
      // Never cache the real credential in Pi's environment or in this relay.
      encryptedSession = await session.load(request.signal);
    } catch (error) {
      await diagnostic.failure("session_load", error);
      return relayError(
        503,
        "Your saved Axon session could not be read safely. Check the shared authentication file and its permissions, then retry.",
      );
    }
    if (recovery.isSignedOut(encryptedSession)) {
      // Fail fast: a waiting request would hold Pi's prompt open past RPC client timeouts.
      return relayError(
        401,
        'You\'re not signed in to Axon. Choose "Login from browser" or run /axon-login in this chat, then send your message again.',
      );
    }
    if (encryptedSession === undefined) {
      if (
        attempt === 0 &&
        supportsRecovery &&
        (await recovery.recover(request.signal, "signed-out"))
      ) {
        continue;
      }
      return loginRequired();
    }

    const headers = new Headers(request.headers);
    for (const name of REMOVED_REQUEST_HEADERS) headers.delete(name);
    headers.set("Authorization", `Bearer ${encryptedSession}`);
    headers.set("X-Harness-Id", "pi");
    headers.set("X-Request-Id", diagnostic.requestId);

    let upstream: Response;
    try {
      upstream = await fetch(
        resolveServiceUrl(BUILD_INFO.serviceOrigin, `${url.pathname}${url.search}`),
        {
          method: request.method,
          headers,
          body,
          redirect: "error",
          cache: "no-store",
          signal: request.signal,
        },
      );
    } catch (error) {
      await diagnostic.failure("upstream_fetch", error);
      return relayError(
        502,
        `Connection error contacting Axon. Check connectivity and retry. Relay diagnostics: ${logLabel} (request ${diagnostic.requestId}).`,
      );
    }

    const refreshedSession = upstream.headers.get("x-session-refresh-token");
    // Authentication may rotate the session even if the model returns an error.
    if (refreshedSession) {
      try {
        // Conditional atomic persistence prevents a late response replacing a newer login.
        const outcome = await session.refresh(encryptedSession, refreshedSession);
        emitProductEvent({
          category: "auth",
          stage: "refresh",
          outcome: outcome === "saved" ? "success" : "skipped",
          ...(outcome === "saved"
            ? {}
            : { reason: outcome === "superseded" ? "conflict" : "account_changed" }),
        });
      } catch (error) {
        await diagnostic.failure("session_refresh", error, upstream.status);
        emitProductEvent({
          category: "auth",
          stage: "refresh",
          outcome: "failed",
          reason: "rotation_failed",
        });
        await upstream.body?.cancel();
        return relayError(503, "Your refreshed Axon session could not be saved safely.");
      }
    }
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      if (!supportsRecovery) return loginRequired();
      try {
        // A refresh or another terminal's login may already have replaced this
        // credential. Retry once with it before offering another browser login.
        const latestSession = await session.load(request.signal);
        if (attempt === 0 && latestSession !== undefined && latestSession !== encryptedSession) {
          continue;
        }
        const verification = await session.verify(encryptedSession);
        // Another concurrent request may have rotated the token during verification.
        if (attempt === 0) {
          const currentSession = await session.load(request.signal);
          if (currentSession !== undefined && currentSession !== encryptedSession) continue;
        }
        // A model-provider 401 with a valid Axon session is not a reason to log in again.
        if (verification === "VERIFIED") {
          return relayError(
            401,
            "The model service rejected this request; your Axon session is still valid.",
          );
        }
        // The saved rotation may have lost to a concurrent sibling the auth service kept.
        if (attempt === 0 && (await session.adoptLostRotation(encryptedSession))) continue;
      } catch (error) {
        await diagnostic.failure("session_verify", error, upstream.status);
        return relayError(503, "Could not verify your Axon session. Check connectivity and retry.");
      }
      if (attempt === 0 && (await recovery.recover(request.signal))) continue;
      return loginRequired();
    }

    if (upstream.status >= 500) {
      await diagnostic.failure("upstream_response", undefined, upstream.status);
    }
    const responseHeaders = new Headers(upstream.headers);
    for (const name of REMOVED_RESPONSE_HEADERS) responseHeaders.delete(name);
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(observeRelayResponse(upstream.body, diagnostic, upstream.status), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }
  return loginRequired();
}

/** Refresh only the Pi defaults; credentials and filesystem writes stay in the launcher. */
async function refreshPiDefaults(
  request: Request,
  paths: AxonPaths,
  session: RelaySession,
): Promise<Response> {
  let expectedSession = await session.load(request.signal);
  if (expectedSession === undefined)
    return relayError(401, "Authentication required to refresh Pi defaults.");
  // Pi owns the terminal during reload, so invalid sections are recorded, never printed.
  let piInvalid = false;
  const result = await fetchClientConfig(expectedSession, {
    onInvalidSection: (section) => {
      if (section === "pi") piInvalid = true;
    },
    fetcher: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([request.signal, ...(init?.signal ? [init.signal] : [])]),
      }),
  });
  // Preserve safe rotations even when the config body is invalid, just as at startup.
  if (result.sessionRefreshToken) {
    const outcome = await session.refresh(expectedSession, result.sessionRefreshToken);
    if (outcome !== "saved") return relayError(409, "Pi defaults refresh was superseded.");
    expectedSession = result.sessionRefreshToken;
  }
  const beforeWrite = async () => {
    request.signal.throwIfAborted();
    if ((await session.load(request.signal)) !== expectedSession) {
      throw new Error("Pi defaults account changed during refresh");
    }
  };
  await beforeWrite();
  // An invalid pi section is a failed refresh, not "the backend has no Pi defaults".
  if (!result.config || piInvalid)
    return relayError(503, "Could not refresh Pi defaults; current settings were preserved.");
  if (result.config.pi) await applyPiDefaults(paths, result.config.pi, { beforeWrite });
  return Response.json(
    { applied: result.config.pi !== undefined },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** A per-launch, capability-protected loopback transport owned by axon, not a provider fork. */
export function startAuthenticatedRequestRelay(
  paths: AxonPaths,
  options: {
    readonly allowPiConfigRefresh?: boolean;
    readonly allowTelemetry?: boolean;
    readonly allowSandboxConfiguration?: boolean;
    readonly sandboxOperation?: (request: Request) => Promise<Response>;
    readonly cwd?: string;
    readonly signedOut?: SessionRecoveryOptions["signedOut"];
  } = {},
): AuthenticatedRequestRelay {
  const capability = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const recovery = createSessionRecovery(
    paths,
    options.signedOut === undefined ? {} : { signedOut: options.signedOut },
  );
  const session = createRelaySession(paths);
  const diagnostics = createRelayDiagnostics(paths);
  const backupRelay = createBackupRelay(paths, options.cwd ?? process.cwd());
  const sandboxConfiguration = options.allowSandboxConfiguration
    ? createSandboxConfigurationRelay(paths, options.cwd ?? process.cwd())
    : undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    idleTimeout: 0,
    maxRequestBodySize: MAX_RELAY_REQUEST_BODY_BYTES,
    error() {
      return relayError(503, "Axon could not process this request safely");
    },
    async fetch(request) {
      if (!authorizedLocalRequest(request, capability)) {
        return relayError(401, "Invalid local Axon request credential");
      }
      const url = new URL(request.url);
      // Control calls never wait for authentication work so Pi can approve a pending login.
      const controlResponse = await recovery.handle(request, url);
      if (controlResponse !== undefined) return controlResponse;
      if (url.pathname === "/_axon/sandbox/execute") {
        if (!options.sandboxOperation || request.method !== "POST" || url.search !== "")
          return relayError(404, "Axon endpoint is not available");
        return options.sandboxOperation(request);
      }
      if (url.pathname.startsWith("/_axon/sandbox/")) {
        if (!sandboxConfiguration) return relayError(404, "Axon endpoint is not available");
        return sandboxConfiguration.handle(request, url);
      }
      if (url.pathname === "/_axon/pi-defaults/refresh") {
        if (!options.allowPiConfigRefresh || request.method !== "POST" || url.search !== "") {
          return relayError(404, "Axon endpoint is not available");
        }
        try {
          return await refreshPiDefaults(request, paths, session);
        } catch {
          return relayError(503, "Could not refresh Pi defaults; current settings were preserved.");
        }
      }
      const backupResponse = await backupRelay(request, url);
      if (backupResponse !== undefined) return backupResponse;
      const telemetryAllowed =
        options.allowTelemetry === true &&
        request.method === "POST" &&
        url.search === "" &&
        /^\/api\/v1\/otel\/v1\/(traces|metrics|logs)$/.test(url.pathname);
      const allowed =
        telemetryAllowed ||
        url.pathname.startsWith("/litellm/") ||
        (url.pathname === SERVICE_ENDPOINTS.models.recommendations && request.method === "POST");
      if (!allowed) return relayError(404, "Axon endpoint is not available");

      try {
        return await forwardManagedRequest(
          request,
          url,
          session,
          recovery,
          diagnostics.start(request, url),
          diagnostics.logLabel,
        );
      } catch {
        // Do not let Bun's development error page disclose request headers or locals.
        return relayError(503, "Axon could not process this request safely");
      }
    },
  });

  return Object.freeze({
    origin: server.url.origin,
    capability,
    diagnosticsLogFile: diagnostics.logFile,
    diagnosticsLogLabel: diagnostics.logLabel,
    dispose: () => {
      sandboxConfiguration?.dispose();
      recovery.dispose();
      void server.stop(true);
    },
  });
}
