import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { withFileLock } from "../../launcher/file-lock.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import type { AxonPaths } from "../../product/paths.ts";

const MAX_LOG_BYTES = 1024 * 1024;
const ERROR_TYPES = new Set(["Error", "TypeError", "TimeoutError", "AbortError"]);
const ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  // Bun's native fetch reports these instead of the Node/undici errno names.
  "ConnectionClosed",
  "ConnectionRefused",
  "FailedToOpenSocket",
  // TLS verification failures, e.g. a missing corporate proxy CA.
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSPC",
  "EDQUOT",
  "EIO",
  "EBUSY",
  "EMFILE",
  "ENFILE",
]);

type FailureStage =
  | "upstream_fetch"
  | "upstream_stream"
  | "upstream_response"
  | "session_load"
  | "session_refresh"
  | "session_verify";

export interface RelayRequestDiagnostics {
  readonly requestId: string;
  failure(
    stage: FailureStage,
    error?: unknown,
    status?: number,
    bytesReceived?: number,
  ): Promise<void>;
}

/** Never serialize an exception: its message, stack, URL and cause may contain credentials. */
function errorFields(error: unknown): { errorType: string; errorCode: string } {
  try {
    const name = error instanceof Error ? error.name : undefined;
    let code: unknown;
    let current = error;
    for (let depth = 0; depth < 3 && current !== null && typeof current === "object"; depth++) {
      code = Reflect.get(current, "code");
      if (typeof code === "string" && ERROR_CODES.has(code)) break;
      current = Reflect.get(current, "cause");
    }
    return {
      errorType: typeof name === "string" && ERROR_TYPES.has(name) ? name : "unknown",
      errorCode: typeof code === "string" && ERROR_CODES.has(code) ? code : "unknown",
    };
  } catch {
    return { errorType: "unknown", errorCode: "unknown" };
  }
}

async function appendDiagnostic(paths: AxonPaths, logFile: string, line: string): Promise<void> {
  // Multiple Axon launches share this bounded log. A busy/unwritable log must never
  // replace the model error or print diagnostics over Pi's terminal.
  try {
    await withFileLock(
      join(paths.locks, "relay-log.lock"),
      async () => {
        const directory = dirname(logFile);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const directoryStatus = await lstat(directory);
        if (
          !directoryStatus.isDirectory() ||
          (process.getuid !== undefined && directoryStatus.uid !== process.getuid())
        ) {
          return;
        }
        const openLog = () =>
          open(
            logFile,
            constants.O_WRONLY |
              constants.O_APPEND |
              constants.O_CREAT |
              constants.O_NOFOLLOW |
              constants.O_NONBLOCK,
            0o600,
          );
        let file = await openLog();
        try {
          const status = await file.stat();
          if (
            !status.isFile() ||
            status.nlink !== 1 ||
            (process.getuid !== undefined && status.uid !== process.getuid())
          ) {
            return;
          }
          await file.chmod(0o600);
          if (status.size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
            await file.close();
            await rename(logFile, `${logFile}.1`);
            file = await openLog();
          }
          await file.chmod(0o600);
          await file.writeFile(line, "utf8");
        } finally {
          await file.close();
        }
      },
      { timeoutMs: 250, retryDelayMs: 25 },
    );
  } catch {
    // Best effort only; never log the logging failure or its potentially private path.
  }
}

/**
 * User-facing location of the log. Error text is persisted in Pi session history
 * (and session backups), so never include the OS user's home directory there.
 */
export function relayLogLabel(
  paths: AxonPaths,
  logFile: string,
  userHome: string = process.env["HOME"] || homedir(),
): string {
  const fromUserHome = relative(userHome, logFile);
  const label =
    fromUserHome && !fromUserHome.startsWith("..") && !isAbsolute(fromUserHome)
      ? `~${sep}${fromUserHome}`
      : `$${PRODUCT_IDENTITY.homeEnvironmentVariable}${sep}${relative(paths.home, logFile)}`;
  return label.replace(/\p{Cc}/gu, "?");
}

export function createRelayDiagnostics(paths: AxonPaths): {
  readonly logFile: string;
  readonly logLabel: string;
  readonly cliSessionId: string;
  start(request: Request, url: URL): RelayRequestDiagnostics;
} {
  const logFile = join(paths.home, "logs", "relay.log");
  // One diagnostics instance belongs to one CLI launch, not a saved Pi conversation
  // or authentication session. Never derive this identifier from credentials.
  const cliSessionId = crypto.randomUUID();
  return {
    logFile,
    cliSessionId,
    logLabel: relayLogLabel(paths, logFile),
    start(request, url) {
      const requestId = crypto.randomUUID();
      const started = performance.now();
      // Keep resource IDs for debugging, but never include query strings or fragments.
      const endpoint = url.pathname;
      const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method)
        ? request.method
        : "<other>";
      return {
        requestId,
        async failure(stage, error, status, bytesReceived = 0) {
          if (request.signal.aborted) return;
          await appendDiagnostic(
            paths,
            logFile,
            `${JSON.stringify({
              timestamp: new Date().toISOString(),
              cliSessionId,
              requestId,
              endpoint,
              method,
              stage,
              status: status ?? null,
              durationMs: Math.round(performance.now() - started),
              bytesReceived,
              ...errorFields(error),
            })}\n`,
          );
        },
      };
    },
  };
}

/**
 * Do not pass Bun's native fetch body directly to Bun.serve: a late socket error
 * is otherwise printed by Bun to the terminal shared with Pi. Reading it here
 * captures the error; erroring (not closing) the replacement stream keeps the
 * HTTP response incomplete so clients and Pi still fail/retry normally.
 */
export function observeRelayResponse(
  body: ReadableStream<Uint8Array> | null,
  diagnostic: RelayRequestDiagnostics,
  status: number,
): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  const reader = body.getReader();
  let finished = false;
  let bytesReceived = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (finished) return;
        if (result.done) {
          finished = true;
          reader.releaseLock();
          controller.close();
        } else {
          bytesReceived += result.value.byteLength;
          controller.enqueue(result.value);
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        reader.releaseLock();
        await diagnostic.failure("upstream_stream", error, status, bytesReceived);
        controller.error(new Error("Axon upstream stream interrupted"));
      }
    },
    async cancel(reason) {
      finished = true;
      try {
        await reader.cancel(reason);
      } catch {
        // Cancellation must not produce a second error or terminal output.
      } finally {
        reader.releaseLock();
      }
    },
  });
}
