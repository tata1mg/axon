import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRelayDiagnostics, observeRelayResponse } from "../src/cli/auth/relay-diagnostics.ts";
import { createRelayRedactor, relayErrorDetails } from "../src/cli/auth/relay-error-details.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "axon-relay-details-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function setup(path = "/litellm/mcp") {
  const diagnostics = createRelayDiagnostics(resolveAxonPaths({ AXON_HOME: home, HOME: home }));
  const url = new URL(path, "http://localhost");
  return { ...diagnostics, diagnostic: diagnostics.start(new Request(url.toString()), url) };
}

async function entries(logFile: string) {
  return (await readFile(logFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("retains complete available stacks and nested network causes, including custom names/codes", () => {
  const inner = Object.assign(new Error("DNS lookup for internal.company failed"), {
    code: "CUSTOM_DNS_ERROR",
    errno: -3008,
    syscall: "getaddrinfo",
    hostname: "internal.company",
  });
  const outer = new TypeError("fetch failed for user alice@example.com", { cause: inner });
  const fields = relayErrorDetails(outer, createRelayRedactor());
  expect(fields.errorType).toBe("TypeError");
  expect(fields.errorCode).toBe("CUSTOM_DNS_ERROR");
  expect(fields.error?.stack).toBe(outer.stack);
  expect(fields.error?.cause).toMatchObject({
    stack: inner.stack,
    code: "CUSTOM_DNS_ERROR",
    errno: -3008,
    syscall: "getaddrinfo",
    hostname: "internal.company",
  });
  expect(fields.error?.message).toContain("alice@example.com");
});

test("removes raw, JSON-escaped and URL-encoded opaque tokens from all exception fields", () => {
  const redactor = createRelayRedactor();
  const token = 'opaque/with+punctuation="and\\slashes';
  redactor.protectSecret(token);
  const forms = [
    token,
    JSON.stringify(token).slice(1, -1),
    encodeURIComponent(token),
    encodeURI(token),
  ];
  const error = Object.assign(new Error(forms.join("\n")), {
    name: token,
    stack: forms.join("\n"),
    code: token,
    hostname: token,
    cause: new Error(token),
    errors: [new Error(token)],
  });
  const serialized = JSON.stringify(relayErrorDetails(error, redactor));
  for (const form of forms) expect(serialized).not.toContain(JSON.stringify(form).slice(1, -1));
  expect(serialized).toContain("REDACTED");
});

test("removes credential labels and bearer credentials without removing user/chat context", () => {
  const redactor = createRelayRedactor();
  const value = redactor.text(
    [
      "user=alice@example.com chat=chat-123",
      "Authorization: Bearer opaque-value",
      'extension_auth_token="file-token"',
      "x-session-refresh-token: rotation-token",
      "encryptedSession=encrypted-value",
      "https://user:password@host/path?access_token=url-token&model=my-model",
      '{"sessionRefreshToken":"json-token","message":"chat context"}',
    ].join("\n"),
  );
  for (const token of [
    "opaque-value",
    "file-token",
    "rotation-token",
    "encrypted-value",
    "url-token",
    "json-token",
    "user:password",
  ]) {
    expect(value).not.toContain(token);
  }
  expect(value).toContain("alice@example.com");
  expect(value).toContain("chat context");
  expect(value).toContain("my-model");
});

test("redacts before truncation and omits oversized input instead of exposing a partial token", () => {
  const redactor = createRelayRedactor();
  redactor.protectSecret("confidential-credential");
  const value = redactor.text(`prefix confidential-credential suffix`, 17);
  expect(value).not.toContain("confidential");
  expect(value).toContain("TRUNCATED");
  expect(redactor.text("x".repeat(1024 * 1024 + 1))).toContain("OMITTED");
});

test("credential tracking fails closed rather than evicting old rotations", () => {
  const redactor = createRelayRedactor();
  for (let i = 0; i < 5000; i++) redactor.protectSecret(`rotation-${i}`);
  expect(redactor.text("rotation-0 rotation-4999 arbitrary user data")).toBe(
    "[OMITTED: credential tracking limit]",
  );
});

test("handles aggregate errors, circular causes, hostile getters, primitives and revoked proxies", () => {
  const error = new AggregateError([new Error("first"), new Error("second")], "group");
  Object.assign(error, { cause: error });
  Object.defineProperty(error, "code", {
    get() {
      throw new Error("must not escape");
    },
  });
  const fields = relayErrorDetails(error, createRelayRedactor());
  expect(fields.error?.cause?.omitted).toContain("circular");
  expect(fields.error?.errors?.map((entry) => entry.message)).toEqual(["first", "second"]);
  expect(fields.error?.code).toContain("UNAVAILABLE");
  expect(relayErrorDetails("thrown string", createRelayRedactor()).error?.message).toBe(
    "thrown string",
  );
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  expect(() => relayErrorDetails(proxy, createRelayRedactor())).not.toThrow();
});

test("bounds deep/wide exception graphs without calling custom serializers", () => {
  const redactor = createRelayRedactor();
  let root = new Error("leaf");
  for (let i = 0; i < 20; i++) root = new Error(`level ${i}`, { cause: root });
  expect(JSON.stringify(relayErrorDetails(root, redactor))).toContain("error detail limit");
  const error = new AggregateError(
    Array.from({ length: 100 }, () => new Error("child")),
    "many",
  );
  Object.assign(error, {
    toJSON() {
      throw new Error("never call me");
    },
  });
  expect(JSON.stringify(relayErrorDetails(error, redactor))).toContain("aggregate error limit");
});

test("redacts tokens registered after request start, including paths, headers and old stream credentials", async () => {
  const token = "old/opaque+token";
  const { logFile, diagnostic, protectSecret } = setup(
    `/litellm/files/${encodeURIComponent(token)}`,
  );
  protectSecret(token);
  diagnostic.attempt(2);
  diagnostic.response(
    new Response(null, {
      headers: {
        "x-session-refresh-token": "new-opaque-token",
        "x-request-id": token,
        "content-type": "text/event-stream",
        server: `server ${token}`,
        "cf-ray": `${encodeURIComponent(token)}-BOM`,
        "cf-mitigated": `challenge ${token}`,
        "retry-after": `120 new-opaque-token`,
        "x-unrelated-secret": "unregistered-header-secret",
      },
    }),
  );
  diagnostic.chunk(12);
  await diagnostic.failure("upstream_stream", new Error(`${token} new-opaque-token`), 200, 12);
  const log = await readFile(logFile, "utf8");
  for (const secret of [token, encodeURIComponent(token), "new-opaque-token"])
    expect(log).not.toContain(secret);
  const [record] = await entries(logFile);
  expect(record.attempt).toBe(2);
  expect(record.headersMs).toBeGreaterThanOrEqual(0);
  expect(record.firstByteMs).toBeGreaterThanOrEqual(0);
  expect(record.idleMs).toBeGreaterThanOrEqual(0);
  expect(record.contentType).toBe("text/event-stream");
  expect(record.upstreamServer).toBe("server [REDACTED]");
  expect(record.cfRay).toBe("[REDACTED]-BOM");
  expect(record.cfMitigated).toBe("challenge [REDACTED]");
  expect(record.retryAfter).toBe("120 [REDACTED]");
  expect(log).not.toContain("unregistered-header-secret");
});

test("large Unicode/control-character stacks produce bounded complete JSON records", async () => {
  const { logFile, diagnostic } = setup();
  const error = Object.assign(new Error("message"), { stack: "\u0001😀".repeat(20000) });
  await diagnostic.failure("upstream_fetch", error);
  const log = await readFile(logFile, "utf8");
  expect(Buffer.byteLength(log)).toBeLessThanOrEqual(64 * 1024);
  expect((await entries(logFile))[0].detailsTruncated).toBe(true);
});

test("captures only complete small error bodies without changing response bytes", async () => {
  const { logFile, diagnostic, protectSecret } = setup();
  protectSecret("body-credential");
  const body = '{"error":"user alice: body-cr\\u0065dential"}';
  const bytes = new TextEncoder().encode(body);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 27));
      controller.enqueue(bytes.slice(27));
      controller.close();
    },
  });
  const stream = observeRelayResponse(source, diagnostic, 429, "application/json");
  expect(await new Response(stream).text()).toBe(body);
  const [record] = await entries(logFile);
  expect(record.stage).toBe("upstream_response_body");
  expect(record.responseBody).toContain("user alice");
  expect(record.responseBody).not.toContain("body-credential");
  expect(record.responseBody).toContain("[REDACTED]");
});

test("oversized error bodies are omitted entirely, not logged as a partial credential", async () => {
  const { logFile, diagnostic, protectSecret } = setup();
  protectSecret("credential-spanning-capture-boundary");
  const body = `${"x".repeat(8180)}credential-spanning-capture-boundary`;
  const stream = observeRelayResponse(new Response(body).body, diagnostic, 500, "text/plain");
  expect(await new Response(stream).text()).toBe(body);
  const [record] = await entries(logFile);
  expect(record.responseBody).toBeUndefined();
  expect(record.responseBodyOmitted).toBe("size limit");
  expect(await readFile(logFile, "utf8")).not.toContain("credential-spanning");
});

test("server fallback exceptions also produce private diagnostics", async () => {
  const { logFile, serverFailure, protectSecret } = setup();
  protectSecret("server-credential");
  await serverFailure(new Error("server-credential server context"));
  const [record] = await entries(logFile);
  expect(record.stage).toBe("relay_server");
  expect(record.error.message).toBe("[REDACTED] server context");
});
