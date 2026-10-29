import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { BUILD_INFO } from "../../build-info.ts";
import { withFileLock } from "../../launcher/file-lock.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { createRelayRedactor, relayErrorDetails } from "./relay-error-details.ts";
import { type RelayHttpError, relayHttpError } from "./relay-http-errors.ts";

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 8192;
type DiagnosticContext = Record<string, string | number | boolean | null>;

type FailureStage =
  | "upstream_fetch"
  | "upstream_stream"
  | "upstream_response"
  | "session_load"
  | "session_refresh"
  | "session_verify"
  | "upstream_response_body"
  | "pi_defaults_refresh"
  | "relay_handler"
  | "relay_server";

export interface RelayRequestDiagnostics {
  readonly requestId: string;
  attempt(attempt: number): void;
  response(response: Response): void;
  chunk(bytes: number): void;
  failure(
    stage: FailureStage,
    error?: unknown,
    status?: number,
    bytesReceived?: number,
    context?: DiagnosticContext,
  ): Promise<void>;
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
  protectSecret(value: string | null | undefined): void;
  serverFailure(error: unknown): Promise<void>;
  start(request: Request, url: URL): RelayRequestDiagnostics;
} {
  const logFile = join(paths.home, "logs", "relay.log");
  // Preserve more than the runtime's usual ten frames for errors created after
  // relay startup, without allowing unbounded stacks in recursive code.
  Error.stackTraceLimit = Math.max(Error.stackTraceLimit ?? 10, 50);
  // One diagnostics instance belongs to one CLI launch, not a saved Pi conversation
  // or authentication session. Never derive this identifier from credentials.
  const cliSessionId = crypto.randomUUID();
  const redactor = createRelayRedactor();
  const diagnostics = {
    protectSecret: redactor.protectSecret,
    async serverFailure(error: unknown) {
      const url = new URL("http://localhost/_axon/relay");
      await diagnostics.start(new Request(url.toString()), url).failure("relay_server", error);
    },
    logFile,
    cliSessionId,
    logLabel: relayLogLabel(paths, logFile),
    start(request: Request, url: URL): RelayRequestDiagnostics {
      redactor.protectSecret(request.headers.get("authorization")?.replace(/^Bearer\s+/i, ""));
      redactor.protectSecret(request.headers.get("x-api-key"));
      const requestId = crypto.randomUUID();
      const started = performance.now();
      let attempt = 0;
      let fetchStarted = started;
      let headersMs: number | null = null;
      let firstByteMs: number | null = null;
      let lastByteAt: number | null = null;
      let responseContext: DiagnosticContext = {};
      let httpError: RelayHttpError | undefined;
      // Keep resource IDs for debugging, but never include query strings or fragments.
      const endpoint = url.pathname;
      const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method)
        ? request.method
        : "<other>";
      return {
        requestId,
        attempt(value) {
          attempt = value;
          fetchStarted = performance.now();
          headersMs = null;
          firstByteMs = null;
          lastByteAt = null;
          responseContext = {};
          httpError = undefined;
        },
        response(response) {
          headersMs = Math.round(performance.now() - fetchStarted);
          for (const header of [
            "x-session-refresh-token",
            "new_session_data",
            "x-encrypted-session-data",
            "x-auth-context",
            "authorization",
            "x-api-key",
            "api-key",
          ]) {
            redactor.protectSecret(response.headers.get(header)?.replace(/^Bearer\s+/i, ""));
          }
          httpError = relayHttpError(response.status, response.headers);
          responseContext = {
            contentType: response.headers.get("content-type"),
            upstreamRequestId: response.headers.get("x-request-id"),
            litellmCallId: response.headers.get("x-litellm-call-id"),
            upstreamServer: response.headers.get("server"),
            cfRay: response.headers.get("cf-ray"),
            cfMitigated: response.headers.get("cf-mitigated"),
            retryAfter: response.headers.get("retry-after"),
          };
        },
        chunk(bytes) {
          if (bytes === 0) return;
          const now = performance.now();
          firstByteMs ??= Math.round(now - fetchStarted);
          lastByteAt = now;
        },
        async failure(stage, error, status, bytesReceived = 0, context = {}) {
          if (request.signal.aborted) return;
          // Serialization is best effort too: a hostile exception must never
          // replace the actual model/storage error or escape onto the terminal.
          try {
            const now = performance.now();
            const safeContext = Object.fromEntries(
              Object.entries({ ...responseContext, ...context }).map(([key, value]) => [
                key,
                typeof value === "string"
                  ? redactor.text(value, key === "responseBody" ? MAX_ERROR_BODY_BYTES : 1024)
                  : value,
              ]),
            );
            // HTTP denials have no thrown exception. Keep them distinct from network
            // errors without hiding a real exception/code from a failed body read.
            const httpFailure =
              error === undefined &&
              (stage === "upstream_response" || stage === "upstream_response_body")
                ? (httpError ?? relayHttpError(status ?? 0))
                : undefined;
            const fields = httpFailure ?? relayErrorDetails(error, redactor);
            const record: Record<string, unknown> = {
              schemaVersion: 2,
              timestamp: new Date().toISOString(),
              cliSessionId,
              requestId,
              endpoint: redactor.text(endpoint, 2048),
              method,
              stage,
              status: status ?? null,
              durationMs: Math.round(now - started),
              attempt,
              headersMs,
              firstByteMs,
              idleMs: lastByteAt === null ? null : Math.round(now - lastByteAt),
              bytesReceived,
              cliVersion: redactor.text(BUILD_INFO.version, 256),
              commit: redactor.text(BUILD_INFO.commit, 256),
              runtime: redactor.text(`bun/${Bun.version}`, 256),
              platform: `${process.platform}-${process.arch}`,
              pid: process.pid,
              upstreamOrigin: redactor.text(new URL(BUILD_INFO.serviceOrigin).origin, 1024),
              ...safeContext,
              ...fields,
              errorType: redactor.text(fields.errorType, 256),
              errorCode:
                typeof fields.errorCode === "string"
                  ? redactor.text(fields.errorCode, 256)
                  : fields.errorCode,
            };
            let line = JSON.stringify(record);
            if (Buffer.byteLength(line) > MAX_RECORD_BYTES - 1) {
              record["error"] = { omitted: "record size limit" };
              delete record["responseBody"];
              record["detailsTruncated"] = true;
              line = JSON.stringify(record);
            }
            await appendDiagnostic(paths, logFile, `${line}\n`);
          } catch {
            // No recursive logging and no console output.
          }
        },
      };
    },
  };
  return diagnostics;
}

function errorBodyText(chunks: Uint8Array[], contentType: string): string {
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  if (/json/i.test(contentType)) {
    try {
      // Canonicalize JSON escapes (including partially Unicode-escaped tokens)
      // before exact-value redaction. The forwarded response is never changed.
      return JSON.stringify(JSON.parse(text));
    } catch {
      // Non-JSON error pages still have useful text; redact them normally.
    }
  }
  return text;
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
  contentType = "",
): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  const reader = body.getReader();
  let finished = false;
  let bytesReceived = 0;
  // Only complete, small textual HTTP error bodies are retained. A raw prefix
  // could end in half a credential, defeating exact-value redaction. No tees,
  // eager draining, successful chat payloads or SSE transcript buffering.
  const captureBody =
    status >= 400 && /json|^text\//i.test(contentType) && !/event-stream/i.test(contentType);
  let chunks: Uint8Array[] = [];
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (finished) return;
        if (result.done) {
          finished = true;
          reader.releaseLock();
          if (captureBody) {
            const context =
              bytesReceived > MAX_ERROR_BODY_BYTES
                ? { responseBodyOmitted: "size limit" }
                : { responseBody: errorBodyText(chunks, contentType) };
            chunks = [];
            await diagnostic.failure(
              "upstream_response_body",
              undefined,
              status,
              bytesReceived,
              context,
            );
          }
          controller.close();
        } else {
          bytesReceived += result.value.byteLength;
          diagnostic.chunk(result.value.byteLength);
          if (captureBody) {
            if (bytesReceived > MAX_ERROR_BODY_BYTES) chunks = [];
            else if (result.value.byteLength > 0) chunks.push(result.value.slice());
          }
          controller.enqueue(result.value);
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        reader.releaseLock();
        chunks = [];
        await diagnostic.failure("upstream_stream", error, status, bytesReceived);
        controller.error(new Error("Axon upstream stream interrupted"));
      }
    },
    async cancel(reason) {
      finished = true;
      chunks = [];
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
