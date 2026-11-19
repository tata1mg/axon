import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HUB_SKILLS_PREVIEW } from "../src/hub/features.ts";
import type { McpCatalog } from "../src/hub/mcp-store.ts";
import { type LocalHub, MAX_HUB_REQUEST_BYTES, startLocalHub } from "../src/hub/server.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const BASE = "/_axon/hub";
let root: string;
let paths: ReturnType<typeof resolveAxonPaths>;
let hub: LocalHub;
let cookie: string;
let csrf: string;
let now: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-hub-http-"));
  paths = resolveAxonPaths({ AXON_HOME: join(root, ".axon"), HOME: root });
  now = Date.now();
  hub = startLocalHub(paths, { now: () => now });
  cookie = "";
  csrf = "";
});
afterEach(async () => {
  await hub.stop();
  await rm(root, { recursive: true, force: true });
});

async function call(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${hub.origin}${BASE}${path}`, {
    method,
    headers: {
      origin: hub.origin,
      "x-axon-hub": "1",
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-axon-hub-csrf": csrf } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
}

async function login(): Promise<void> {
  const token = new URLSearchParams(new URL(hub.launchUrl).hash.slice(1)).get("token");
  const response = await call("/api/session", "POST", { token });
  expect(response.status).toBe(200);
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
}

test("serves embedded browser assets with restrictive security headers, without exposing config", async () => {
  for (const [path, type, content] of [
    ["/", "text/html", "MCP servers"],
    ["/hub.js", "text/javascript", "replaceState"],
    ["/hub.css", "text/css", ".server-list"],
  ] as const) {
    const response = await fetch(`${hub.origin}${BASE}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(type);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await response.text();
    expect(text).toContain(content);
    expect(text).not.toContain(paths.pi);
    expect(text).not.toContain(new URL(hub.launchUrl).hash);
  }
  const head = await fetch(`${hub.origin}${BASE}/`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});

test("requires a single-use bootstrap exchange, HttpOnly cookie and CSRF for writes", async () => {
  expect((await call("/api/mcps")).status).toBe(401);
  const token = new URLSearchParams(new URL(hub.launchUrl).hash.slice(1)).get("token");
  const response = await call("/api/session", "POST", { token });
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain(`Path=${BASE}`);
  cookie = setCookie.split(";")[0] ?? "";
  csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
  expect((await call("/api/session", "POST", { token })).status).toBe(401);
  const metadata = await (await call("/api/session")).json();
  expect(metadata).toMatchObject({
    schemaVersion: 1,
    scope: "user",
    features: { localMcps: true, localSkills: true, catalog: true, skills: HUB_SKILLS_PREVIEW },
    csrfToken: csrf,
  });
  expect((await call("/api/mcps", "POST", {}, { "x-axon-hub-csrf": "wrong" })).status).toBe(403);
  expect((await call("/api/mcps", "GET", undefined, { "x-axon-hub": "" })).status).toBe(403);
});

test("bootstrap and browser sessions expire", async () => {
  now += 5 * 60_000;
  const token = new URLSearchParams(new URL(hub.launchUrl).hash.slice(1)).get("token");
  expect((await call("/api/session", "POST", { token })).status).toBe(401);
  await hub.stop();
  hub = startLocalHub(paths, { now: () => now });
  await login();
  now += 8 * 60 * 60_000;
  expect((await call("/api/mcps")).status).toBe(401);
});

test("rejects cross-origin, same-site other ports, missing write Origin, and DNS rebinding", async () => {
  await login();
  for (const origin of ["https://evil.example", "http://127.0.0.1:1", "http://localhost:1", "null"])
    expect((await call("/api/mcps", "GET", undefined, { origin })).status).toBe(403);
  expect(
    (await call("/api/mcps", "GET", undefined, { "sec-fetch-site": "cross-site" })).status,
  ).toBe(403);
  expect(
    (await call("/api/mcps", "GET", undefined, { "sec-fetch-site": "same-site" })).status,
  ).toBe(403);
  expect((await call("/api/mcps", "POST", {}, { origin: "" })).status).toBe(403);
  expect((await call("/api/mcps", "GET", undefined, { host: "evil.example" })).status).toBe(403);
  const preflight = await call("/api/mcps", "OPTIONS", undefined, {
    origin: "https://evil.example",
  });
  expect(preflight.status).toBe(403);
  expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
});

test("browser session cannot authorize another hub instance", async () => {
  await login();
  const another = startLocalHub(paths);
  try {
    const response = await fetch(`${another.origin}${BASE}/api/mcps`, {
      headers: { origin: another.origin, cookie, "x-axon-hub": "1", "x-axon-hub-csrf": csrf },
    });
    expect(response.status).toBe(401);
  } finally {
    await another.stop();
  }
});

test("MCP CRUD works with revisions and does not touch project or legacy catalog config", async () => {
  await mkdir(join(root, "project", ".pi"), { recursive: true });
  const projectConfig = join(root, "project", ".pi", "mcp.json");
  await Bun.write(projectConfig, "project config unchanged");
  await login();
  const initial = (await (await call("/api/mcps")).json()) as McpCatalog;
  expect(initial.revision).toBe("missing");
  const create = await call("/api/mcps", "POST", {
    revision: initial.revision,
    name: "docs",
    definition: {
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret-header" },
    },
  });
  expect(create.status).toBe(201);
  const created = (await create.json()) as McpCatalog;
  expect(JSON.stringify(created)).not.toContain("secret-header");
  const patch = await call("/api/mcps/docs", "PATCH", {
    revision: created.revision,
    changes: { enabled: false },
  });
  expect(patch.status).toBe(200);
  const updated = (await patch.json()) as McpCatalog;
  expect(updated.servers[0]?.enabled).toBe(false);
  expect((await call("/api/mcps/docs", "DELETE", { revision: created.revision })).status).toBe(409);
  const removed = await call("/api/mcps/docs", "DELETE", { revision: updated.revision });
  expect(((await removed.json()) as McpCatalog).servers).toEqual([]);
  expect(await Bun.file(projectConfig).text()).toBe("project config unchanged");
  expect(await Bun.file(join(root, ".config", "mcp", "mcp.json")).exists()).toBe(false);
});

test("validates content type, JSON, request limits and does not echo rejected secrets", async () => {
  await login();
  expect((await call("/api/mcps", "POST", {}, { "content-type": "text/plain" })).status).toBe(415);
  const invalid = await fetch(`${hub.origin}${BASE}/api/mcps`, {
    method: "POST",
    headers: {
      origin: hub.origin,
      cookie,
      "x-axon-hub": "1",
      "x-axon-hub-csrf": csrf,
      "content-type": "application/json",
    },
    body: "broken secret",
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain("broken secret");
  const oversize = await call("/api/mcps", "POST", {
    secret: "private".repeat(MAX_HUB_REQUEST_BYTES),
  });
  expect(oversize.status).toBe(413);
  expect(await oversize.text()).not.toContain("private");
  const bad = await call("/api/mcps", "POST", {
    revision: "missing",
    name: "oops",
    definition: { url: "file:///private-secret" },
  });
  expect(bad.status).toBe(400);
  expect(await bad.text()).not.toContain("private-secret");
});

test("cannot proxy models, execute commands, read arbitrary files, or change project paths", async () => {
  await login();
  for (const path of [
    "/litellm/v1/models",
    "/_axon/sandbox/execute",
    "/api/v1/otel/v1/traces",
    `${BASE}/api/files`,
    `${BASE}/api/skills/SKILL.md`,
    `${BASE}/api/skills?path=/etc/passwd`,
    `${BASE}/mcp.json`,
    `${BASE}/api/mcps?path=/etc/passwd`,
  ]) {
    const response = await fetch(`${hub.origin}${path}`, {
      headers: { origin: hub.origin, cookie, "x-axon-hub": "1" },
    });
    expect(response.status).toBe(404);
  }
  const changedPath = await call("/api/mcps", "POST", {
    revision: "missing",
    name: "docs",
    definition: { url: "https://example.com/mcp" },
    configPath: "/tmp/unapproved",
  });
  expect(changedPath.status).toBe(400);
});

test("unsafe filesystem and parsing errors are safe JSON, never raw file content", async () => {
  await mkdir(paths.pi, { recursive: true });
  await Bun.write(join(paths.pi, "mcp.json"), "secret malformed content");
  await login();
  const response = await call("/api/mcps");
  expect(response.status).toBe(422);
  expect(await response.text()).not.toContain("secret malformed content");
});
