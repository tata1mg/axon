import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRelayDiagnostics,
  observeRelayResponse,
  relayLogLabel,
} from "../src/cli/auth/relay-diagnostics.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "axon-relay-diagnostics-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function setup(path = "/litellm/v1/chat/completions?key=query-secret", signal?: AbortSignal) {
  const paths = resolveAxonPaths({ AXON_HOME: home, HOME: home });
  const diagnostics = createRelayDiagnostics(paths);
  const url = new URL(path, "http://127.0.0.1:12345");
  const request = new Request(url.toString(), {
    method: "POST",
    headers: { authorization: "Bearer session-secret", "x-request-id": "caller-secret" },
    body: "prompt-secret",
    ...(signal === undefined ? {} : { signal }),
  });
  return { ...diagnostics, diagnostic: diagnostics.start(request, url) };
}

async function records(logFile: string) {
  return (await readFile(logFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("logs transport metadata, never full URLs, headers, payloads, messages or stacks", async () => {
  const { logFile, cliSessionId, diagnostic } = setup();
  const error = Object.assign(new TypeError("https://private.test?key=error-secret"), {
    code: "ECONNRESET",
    stack: "stack-secret",
  });
  await diagnostic.failure("upstream_stream", error, 200, 123);
  const [record] = await records(logFile);
  expect(record).toEqual({
    timestamp: expect.any(String),
    cliSessionId,
    requestId: diagnostic.requestId,
    endpoint: "/litellm/v1/chat/completions",
    method: "POST",
    stage: "upstream_stream",
    status: 200,
    durationMs: expect.any(Number),
    bytesReceived: 123,
    errorType: "TypeError",
    errorCode: "ECONNRESET",
  });
  expect(record.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(await readFile(logFile, "utf8")).not.toContain("secret");
  expect((await stat(logFile)).mode & 0o777).toBe(0o600);
  expect((await stat(join(home, "logs"))).mode & 0o777).toBe(0o700);
});

test("groups requests by CLI launch while keeping request IDs unique", async () => {
  const first = setup();
  const url = new URL("http://127.0.0.1/litellm/v1/models");
  const anotherRequest = first.start(new Request(url.toString()), url);
  const second = setup();

  await first.diagnostic.failure("upstream_fetch");
  await anotherRequest.failure("upstream_response", undefined, 503);
  await second.diagnostic.failure("upstream_fetch");

  const entries = await records(first.logFile);
  expect(first.cliSessionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(second.cliSessionId).not.toBe(first.cliSessionId);
  expect(entries.map((entry) => entry.cliSessionId)).toEqual([
    first.cliSessionId,
    first.cliSessionId,
    second.cliSessionId,
  ]);
  expect(new Set(entries.map((entry) => entry.requestId)).size).toBe(3);
});

test.each([
  "/litellm/mcp",
  "/litellm/responses/resp_abc123",
  "/litellm/files/file_xyz789",
  "/litellm/v1/models/",
])(
  "logs pathname %s, but not query strings, fragments or untrusted exception names/codes",
  async (path) => {
    const { logFile, diagnostic } = setup(`${path}?key=query-secret#fragment-secret`);
    await diagnostic.failure(
      "upstream_fetch",
      Object.assign(new Error("secret"), {
        name: "name-secret",
        code: "code-secret",
      }),
    );
    const [record] = await records(logFile);
    expect(record.endpoint).toBe(path);
    expect(record.errorType).toBe("unknown");
    expect(record.errorCode).toBe("unknown");
    expect(await readFile(logFile, "utf8")).not.toContain("secret");
  },
);

test("extracts an allowlisted connection code from a wrapped fetch error", async () => {
  const { logFile, diagnostic } = setup();
  await diagnostic.failure(
    "upstream_fetch",
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("private"), { code: "UND_ERR_SOCKET" }),
    }),
  );
  expect((await records(logFile))[0].errorCode).toBe("UND_ERR_SOCKET");
});

test("rotates at 1 MiB and retains only one backup", async () => {
  const { logFile, diagnostic } = setup();
  await mkdir(join(home, "logs"), { mode: 0o700 });
  const old = "x".repeat(1024 * 1024);
  await writeFile(logFile, old, { mode: 0o600 });
  await writeFile(`${logFile}.1`, "older", { mode: 0o600 });
  await diagnostic.failure("upstream_fetch", new Error("private"));
  expect(await readFile(`${logFile}.1`, "utf8")).toBe(old);
  expect(await records(logFile)).toHaveLength(1);
  expect((await readdir(join(home, "logs"))).sort()).toEqual(["relay.log", "relay.log.1"]);
});

test("concurrent failures append complete JSON records", async () => {
  const { logFile, diagnostic } = setup();
  await Promise.all(Array.from({ length: 4 }, () => diagnostic.failure("upstream_fetch")));
  expect(await records(logFile)).toHaveLength(4);
});

test("logging failure is best effort and never follows log or directory symlinks", async () => {
  const { logFile, diagnostic } = setup();
  const target = join(home, "private-file");
  await writeFile(target, "must stay unchanged");
  await mkdir(join(home, "logs"));
  await symlink(target, logFile);
  await diagnostic.failure("upstream_fetch");
  expect(await readFile(target, "utf8")).toBe("must stay unchanged");
  await rm(join(home, "logs"), { recursive: true });
  await mkdir(join(home, "elsewhere"));
  await symlink(join(home, "elsewhere"), join(home, "logs"));
  await diagnostic.failure("upstream_fetch");
  expect(await readdir(join(home, "elsewhere"))).toEqual([]);
});

test("intentional request cancellation does not create an error log", async () => {
  const controller = new AbortController();
  const { logFile, diagnostic } = setup(undefined, controller.signal);
  controller.abort();
  await diagnostic.failure("upstream_fetch", new DOMException("Aborted", "AbortError"));
  expect(await Bun.file(logFile).exists()).toBe(false);
});

test("response observation forwards bytes, propagates cancellation, and releases the reader", async () => {
  const { logFile, diagnostic } = setup();
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 1, 255]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = observeRelayResponse(source, diagnostic, 200);
  if (!response) throw new Error("Missing observed response");
  const reader = response.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([0, 1, 255]));
  await reader.cancel();
  expect(cancelled).toBe(true);
  expect(source.locked).toBe(false);
  expect(await Bun.file(logFile).exists()).toBe(false);
  expect(observeRelayResponse(null, diagnostic, 204)).toBeNull();
});

test("records Bun's native fetch failure codes instead of unknown", async () => {
  const { logFile, diagnostic } = setup();
  let error: unknown;
  try {
    // Port 1 is never listening; Bun reports code ConnectionRefused.
    await fetch("http://127.0.0.1:1/");
  } catch (caught) {
    error = caught;
  }
  await diagnostic.failure("upstream_fetch", error);
  const [record] = await records(logFile);
  expect(record.errorCode).toBe("ConnectionRefused");
  expect(record.errorType).toBe("TypeError");
});

test("user-facing log labels never include the OS home directory", () => {
  const paths = resolveAxonPaths({ AXON_HOME: join(home, ".axon"), HOME: home });
  const logFile = join(paths.home, "logs", "relay.log");
  expect(relayLogLabel(paths, logFile, home)).toBe(join("~", ".axon", "logs", "relay.log"));
  const elsewhere = resolveAxonPaths({ AXON_HOME: "/srv/axon", HOME: home });
  expect(relayLogLabel(elsewhere, join("/srv/axon", "logs", "relay.log"), home)).toBe(
    join("$AXON_HOME", "logs", "relay.log"),
  );
});
