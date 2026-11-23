// biome-ignore-all lint/suspicious/noTemplateCurlyInString: catalog templates use literal ${input:<id>} references.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEncryptedSession, saveEncryptedSession } from "../src/cli/auth/session.ts";
import type { CatalogView } from "../src/hub/catalog.ts";
import type { McpCatalog } from "../src/hub/mcp-store.ts";
import { type LocalHub, type LocalHubOptions, startLocalHub } from "../src/hub/server.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const BASE = "/_axon/hub";
const SECRET = "sk-live-do-not-leak";

// Published entries as the backend returns them (normalized), plus one it shouldn't send.
function redash(revision = 1, args = ["-y", "@suthio/redash-mcp"]) {
  return {
    kind: "mcp",
    slug: "redash",
    revision,
    specVersion: 1,
    tier: "guided",
    featured: false,
    publishedAt: "2026-11-18T10:00:00Z",
    metadata: { name: "Redash", summary: "Query Redash.", tags: [] },
    spec: {
      server: {
        command: "npx",
        args,
        env: { REDASH_URL: "https://redash.1mg.com/", REDASH_API_KEY: "${input:redash_api_key}" },
        exposure: "codemode",
      },
      inputs: [
        { id: "redash_api_key", label: "Redash API key", type: "secret", required: true, help: [] },
      ],
      prerequisites: [{ id: "node", label: "Node.js", detect: { executable: "npx" }, help: [] }],
      steps: [{ type: "input", input: "redash_api_key" }],
      afterInstall: [],
    },
  };
}
const last9 = {
  kind: "mcp",
  slug: "last9",
  revision: 1,
  specVersion: 1,
  tier: "one_click",
  featured: true,
  publishedAt: "2026-11-18T10:00:00Z",
  metadata: { name: "Last9", summary: "Observability.", tags: ["observability"] },
  spec: {
    server: {
      type: "streamable-http",
      url: "https://app.last9.io/api/v4/organizations/tata1mg/mcp?scope=all",
      timeout: 50,
      exposure: "codemode",
    },
    inputs: [],
    prerequisites: [],
    steps: [],
    afterInstall: [{ type: "text", text: "Run `/reload`, then `/mcp`." }],
  },
};
const skill = {
  kind: "skill",
  slug: "release-notes",
  revision: 1,
  specVersion: 0,
  tier: null,
  featured: false,
  publishedAt: "2026-11-18T10:00:00Z",
  metadata: { name: "Release notes", summary: "", tags: [] },
  spec: { source: { type: "placeholder", notes: "" } },
};
const malformed = { ...last9, slug: "bad", spec: { server: { url: "https://x", oauth: {} } } };

let root: string;
let paths: ReturnType<typeof resolveAxonPaths>;
let hub: LocalHub;
let cookie: string;
let csrf: string;
let published: unknown[];
let backend: { status: number; rotate?: string; fail?: boolean };
let requests: Request[];

async function start(options: Partial<LocalHubOptions> = {}): Promise<void> {
  hub = startLocalHub(paths, {
    serviceOrigin: "https://axon.example/axon",
    which: (name) => (name === "npx" ? "/opt/homebrew/bin/npx" : null),
    skillsPreview: true,
    fetcher: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const request = new Request(url, init);
      requests.push(request);
      if (backend.fail) throw new TypeError("network down");
      const headers = new Headers({ "content-type": "application/json" });
      if (backend.rotate) headers.set("x-session-refresh-token", backend.rotate);
      return new Response(JSON.stringify({ schemaVersion: 1, items: published }), {
        status: backend.status,
        headers,
      });
    },
    ...options,
  });
  const token = new URLSearchParams(new URL(hub.launchUrl).hash.slice(1)).get("token");
  const response = await call("/api/session", "POST", { token });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-hub-catalog-"));
  paths = resolveAxonPaths({ AXON_HOME: join(root, ".axon"), HOME: root });
  published = [redash(), last9, skill, malformed];
  backend = { status: 200 };
  requests = [];
  cookie = "";
  csrf = "";
  await saveEncryptedSession(paths, "saved-session");
  await start();
});
afterEach(async () => {
  await hub.stop();
  await rm(root, { recursive: true, force: true });
});

async function call(path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${hub.origin}${BASE}${path}`, {
    method,
    headers: {
      origin: hub.origin,
      "x-axon-hub": "1",
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-axon-hub-csrf": csrf } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function view(): Promise<Extract<CatalogView, { status: "ok" }>> {
  const response = await call("/api/catalog");
  expect(response.status).toBe(200);
  const body = (await response.json()) as CatalogView;
  if (body.status !== "ok") throw new Error(`catalog is ${body.status}`);
  return body;
}

function item(catalog: Extract<CatalogView, { status: "ok" }>, slug: string) {
  const found = catalog.items.find((entry) => entry.slug === slug);
  if (!found) throw new Error(`missing ${slug}`);
  return found;
}

async function install(body: Record<string, unknown>): Promise<Response> {
  return call("/api/catalog/install", "POST", { kind: "mcp", inputs: {}, ...body });
}

async function config(): Promise<{ mcpServers: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await Bun.file(join(paths.pi, "mcp.json")).text());
}

test("reads the catalog with the saved session and reports local state", async () => {
  const catalog = await view();
  expect(catalog.skipped).toBe(1);
  expect(catalog.configRevision).toBe("missing");
  expect(catalog.items.map((entry) => [entry.slug, entry.local.state])).toEqual([
    ["redash", "not_installed"],
    ["last9", "not_installed"],
    ["release-notes", "not_installed"],
  ]);
  expect(item(catalog, "redash").prerequisiteStatus).toEqual([
    { id: "node", found: true, path: "/opt/homebrew/bin/npx" },
  ]);
  const request = requests[0] as Request;
  expect(request.url).toBe("https://axon.example/axon/api/v1/catalog?kinds=mcp%3A1%2Cskill%3A0");
  expect(request.headers.get("authorization")).toBe("Bearer saved-session");
  expect(request.headers.get("cookie")).toBeNull();
  expect(request.redirect).toBe("error");
});

test("persists a rotated session and reports sign-in and service problems", async () => {
  backend.rotate = "rotated-session";
  await view();
  expect(await loadEncryptedSession(paths)).toBe("rotated-session");

  for (const [setup, expected] of [
    [() => (backend.status = 401), { status: "signin_required" }],
    [
      () => (backend.status = 503),
      { status: "unavailable", message: "The Axon service returned HTTP 503. Try again later." },
    ],
    [() => Object.assign(backend, { status: 200, fail: true }), { status: "unavailable" }],
  ] as const) {
    setup();
    expect(await (await call("/api/catalog")).json()).toMatchObject(expected);
  }
  backend.fail = false;
  await rm(paths.sharedAuthFile);
  const before = requests.length;
  expect(await (await call("/api/catalog")).json()).toEqual({ status: "signin_required" });
  expect(requests.length).toBe(before);
});

test("installs from the hub's own copy, with trust, and never stores or returns the secret elsewhere", async () => {
  const catalog = await view();
  const base = { slug: "redash", revision: 1, configRevision: catalog.configRevision };
  expect((await install({ ...base, inputs: { redash_api_key: SECRET } })).status).toBe(400);
  expect((await install({ ...base, confirmExecution: true })).status).toBe(400);
  expect((await install({ ...base, revision: 2, confirmExecution: true })).status).toBe(409);
  expect((await install({ ...base, slug: "unknown", confirmExecution: true })).status).toBe(409);
  // The browser can't hand the hub a definition of its own.
  const forged = await install({ ...base, confirmExecution: true, server: { command: "/bin/sh" } });
  expect(forged.status).toBe(400);

  const response = await install({
    ...base,
    inputs: { redash_api_key: SECRET },
    confirmExecution: true,
  });
  expect(response.status).toBe(200);
  const after = (await response.json()) as Extract<CatalogView, { status: "ok" }>;
  expect(item(after, "redash").local).toEqual({
    state: "installed",
    name: "redash",
    installedRevision: 1,
    changedLocally: false,
  });
  expect(JSON.stringify(after)).not.toContain(SECRET);
  expect((await config()).mcpServers["redash"]).toEqual({
    command: "npx",
    args: ["-y", "@suthio/redash-mcp"],
    env: { REDASH_URL: "https://redash.1mg.com/", REDASH_API_KEY: SECRET },
    exposure: "codemode",
    enabled: true,
  });
  const record = await Bun.file(paths.hubCatalogInstalls).text();
  expect(record).not.toContain(SECRET);
  expect(JSON.parse(record).mcp.redash).toMatchObject({
    name: "redash",
    revision: 1,
    positions: ["env.REDASH_API_KEY"],
  });

  const servers = (await (await call("/api/mcps")).json()) as McpCatalog;
  expect(servers.servers[0]).toMatchObject({
    name: "redash",
    catalog: { slug: "redash", revision: 1 },
  });
  expect(JSON.stringify(servers)).not.toContain(SECRET);
});

test("updates keep a stored secret, the user's own fields, and a disabled state", async () => {
  let catalog = await view();
  await install({
    slug: "redash",
    revision: 1,
    configRevision: catalog.configRevision,
    inputs: { redash_api_key: SECRET },
    confirmExecution: true,
  });
  const edited = await config();
  edited.mcpServers["redash"] = {
    ...edited.mcpServers["redash"],
    enabled: false,
    oauth: { clientId: "mine" },
  };
  await Bun.write(join(paths.pi, "mcp.json"), JSON.stringify(edited));
  expect(item(await view(), "redash").local.state).toBe("installed");

  published = [redash(2, ["-y", "@suthio/redash-mcp@1.0.4"]), last9];
  catalog = await view();
  expect(item(catalog, "redash").local).toEqual({
    state: "update_available",
    name: "redash",
    installedRevision: 1,
    changedLocally: false,
  });
  const updated = await install({
    slug: "redash",
    revision: 2,
    configRevision: catalog.configRevision,
    confirmExecution: true,
  });
  expect(updated.status).toBe(200);
  expect((await config()).mcpServers["redash"]).toEqual({
    oauth: { clientId: "mine" },
    command: "npx",
    args: ["-y", "@suthio/redash-mcp@1.0.4"],
    env: { REDASH_URL: "https://redash.1mg.com/", REDASH_API_KEY: SECRET },
    exposure: "codemode",
    enabled: false,
  });
  expect(
    item((await updated.json()) as Extract<CatalogView, { status: "ok" }>, "redash").local.state,
  ).toBe("installed");
});

test("detects local edits and stale config revisions", async () => {
  const catalog = await view();
  await install({ slug: "last9", revision: 1, configRevision: catalog.configRevision });
  const edited = await config();
  edited.mcpServers["last9"] = { ...edited.mcpServers["last9"], timeout: 5 };
  await Bun.write(join(paths.pi, "mcp.json"), JSON.stringify(edited));
  const changed = await view();
  expect(item(changed, "last9").local).toMatchObject({
    state: "changed_locally",
    changedLocally: true,
  });
  const stale = await install({
    slug: "last9",
    revision: 1,
    configRevision: catalog.configRevision,
  });
  expect(stale.status).toBe(409);
  expect(
    (await install({ slug: "last9", revision: 1, configRevision: changed.configRevision })).status,
  ).toBe(200);
  expect((await config()).mcpServers["last9"]?.["timeout"]).toBe(50);
});

test("a name in use is not overwritten; installing under another name works", async () => {
  await Bun.write(
    join(paths.pi, "mcp.json"),
    JSON.stringify({ mcpServers: { last9: { url: "https://mine.example/mcp?token=abc" } } }),
  );
  const catalog = await view();
  expect(item(catalog, "last9").local).toEqual({ state: "name_in_use", name: "last9" });
  const taken = await install({
    slug: "last9",
    revision: 1,
    configRevision: catalog.configRevision,
  });
  expect(taken.status).toBe(409);
  const renamed = await install({
    slug: "last9",
    revision: 1,
    configRevision: catalog.configRevision,
    name: "last9-org",
  });
  expect(
    item((await renamed.json()) as Extract<CatalogView, { status: "ok" }>, "last9").local,
  ).toMatchObject({
    state: "installed",
    name: "last9-org",
  });
  const servers = (await config()).mcpServers;
  expect(servers["last9"]).toEqual({ url: "https://mine.example/mcp?token=abc" });
  expect(servers["last9-org"]).toMatchObject({
    url: last9.spec.server.url,
    timeout: 50,
    enabled: true,
  });
  // The store hides URLs with query strings: the user's own stays hidden, the catalog's is shown.
  const listed = ((await (await call("/api/mcps")).json()) as McpCatalog).servers;
  expect(listed.find((server) => server.name === "last9")?.url).toBeUndefined();
  expect(listed.find((server) => server.name === "last9-org")).toMatchObject({
    url: last9.spec.server.url,
    catalog: { slug: "last9", revision: 1 },
  });
});

test("installs are refused once the catalog can't be seen", async () => {
  const catalog = await view();
  backend.status = 401;
  await call("/api/catalog");
  expect(
    (await install({ slug: "last9", revision: 1, configRevision: catalog.configRevision })).status,
  ).toBe(409);
});

test("installs revalidate against the current publication, not the last Discover fetch", async () => {
  const catalog = await view();
  const body = { slug: "last9", revision: 1, configRevision: catalog.configRevision };
  const before = requests.length;

  // Withdrawn while the dialog was open.
  published = [redash()];
  const withdrawn = await install(body);
  expect(withdrawn.status).toBe(409);
  expect(requests.length).toBe(before + 1);

  // Superseded while the dialog was open.
  published = [redash(), { ...last9, revision: 2 }];
  expect((await install(body)).status).toBe(409);

  backend.status = 503;
  expect((await install(body)).status).toBe(503);
  expect(await Bun.file(join(paths.pi, "mcp.json")).exists()).toBe(false);

  backend.status = 200;
  published = [redash(), last9];
  expect((await install(body)).status).toBe(200);
});

test("removing a catalog server forgets its provenance, so a replacement is a name collision", async () => {
  let catalog = await view();
  await install({ slug: "last9", revision: 1, configRevision: catalog.configRevision });
  let servers = (await (await call("/api/mcps")).json()) as McpCatalog;
  const removed = await call("/api/mcps/last9", "DELETE", { revision: servers.revision });
  expect(removed.status).toBe(200);
  expect(JSON.parse(await Bun.file(paths.hubCatalogInstalls).text()).mcp).toEqual({});

  servers = (await removed.json()) as McpCatalog;
  const created = await call("/api/mcps", "POST", {
    revision: servers.revision,
    name: "last9",
    definition: { url: "https://mine.example/mcp" },
  });
  expect(created.status).toBe(201);
  catalog = await view();
  expect(item(catalog, "last9").local).toEqual({ state: "name_in_use", name: "last9" });
  const listed = ((await (await call("/api/mcps")).json()) as McpCatalog).servers;
  expect(listed.find((server) => server.name === "last9")?.catalog).toBeUndefined();
});

test("a server re-added after an editor removal doesn't inherit stale provenance", async () => {
  const catalog = await view();
  await install({ slug: "last9", revision: 1, configRevision: catalog.configRevision });
  await Bun.write(join(paths.pi, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  const servers = (await (await call("/api/mcps")).json()) as McpCatalog;
  const created = await call("/api/mcps", "POST", {
    revision: servers.revision,
    name: "last9",
    definition: { url: "https://mine.example/mcp" },
  });
  expect(created.status).toBe(201);
  expect(item(await view(), "last9").local).toEqual({ state: "name_in_use", name: "last9" });
});

test("without the skills preview, the hub neither asks for nor shows skills", async () => {
  await hub.stop();
  await start({ skillsPreview: false });
  const session = (await (await call("/api/session")).json()) as {
    features: Record<string, boolean>;
  };
  expect(session.features).toEqual({
    localMcps: true,
    localSkills: true,
    catalog: true,
    skills: false,
  });
  const catalog = await view();
  expect(requests.at(-1)?.url).toEndWith("/api/v1/catalog?kinds=mcp%3A1");
  expect(catalog.items.some((entry) => entry.kind === "skill")).toBe(false);
});
