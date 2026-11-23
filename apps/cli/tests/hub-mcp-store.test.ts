import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { HubError } from "../src/hub/errors.ts";
import { LocalMcpStore, MAX_MCP_CONFIG_BYTES } from "../src/hub/mcp-store.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let root: string;
let paths: ReturnType<typeof resolveAxonPaths>;
let store: LocalMcpStore;

const envReference = (name: string): string => `\${${name}}`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-hub-store-"));
  paths = resolveAxonPaths({ AXON_HOME: join(root, ".axon"), HOME: root });
  store = new LocalMcpStore(paths);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(config: unknown): Promise<void> {
  await mkdir(paths.pi, { recursive: true });
  await Bun.write(store.configPath, JSON.stringify(config));
}
async function disk(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(store.configPath, "utf8"));
}
async function revision(): Promise<string> {
  return (await store.list()).revision;
}
async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  try {
    await promise;
    throw new Error("Expected hub error");
  } catch (error) {
    expect(error).toBeInstanceOf(HubError);
    expect((error as HubError).status).toBe(status);
  }
}

describe("local MCP configuration", () => {
  test("reading a missing configuration does not create directories", async () => {
    expect(await store.list()).toEqual({
      revision: "missing",
      configPath: store.configPath,
      scope: "user",
      servers: [],
      reloadRequired: true,
    });
    expect(await readdir(root)).toEqual([]);
  });

  test("creates the actual managed user config with private permissions", async () => {
    const result = await store.create({
      revision: "missing",
      name: "docs",
      definition: { url: "https://example.com/mcp", enabled: true },
    });
    expect(result.servers[0]).toMatchObject({
      name: "docs",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    });
    expect(await disk()).toEqual({
      mcpServers: { docs: { url: "https://example.com/mcp", enabled: true } },
    });
    expect((await lstat(store.configPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.pi)).mode & 0o777).toBe(0o700);
    expect(await readdir(paths.pi)).toEqual(["mcp.json"]);
    expect(await readdir(paths.locks)).toEqual([]);
  });

  test("Pi's pinned MCP CLI reads the saved configuration without connecting disabled servers", async () => {
    await store.create({
      revision: "missing",
      name: "local-disabled",
      definition: { command: "must-never-be-executed", args: ["--test"], enabled: false },
      confirmExecution: true,
    });
    await store.create({
      revision: await revision(),
      name: "remote-disabled",
      definition: { url: "http://127.0.0.1:1/mcp", enabled: false },
    });
    const packagePath = Bun.resolveSync(
      "@earendil-works/pi-coding-agent/package.json",
      import.meta.dir,
    );
    const cli = join(dirname(packagePath), "dist", "bundle", "cli.js");
    const child = Bun.spawn([process.execPath, cli, "mcp", "list"], {
      cwd: root,
      env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: paths.pi, NODE_EXTRA_CA_CERTS: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout).toContain("local-disabled");
    expect(stdout).toContain("remote-disabled");
    expect(stdout).toContain("disabled");
  });

  test("never returns stored argument, cwd, env, header, OAuth, or unknown values", async () => {
    await write({
      autoEnableCodemode: false,
      mcpServers: {
        local: {
          command: "npx",
          args: ["--token", "arg-secret"],
          cwd: "cwd-secret",
          env: { API_KEY: "env-secret", REF: envReference("SECRET_REFERENCE") },
          enabled: false,
          custom: { password: "custom-secret" },
        },
        remote: {
          url: "https://user:url-secret@example.com/mcp?key=query-secret#fragment-secret",
          headers: { Authorization: "Bearer header-secret" },
          oauth: { clientSecret: "oauth-secret" },
        },
      },
    });
    const result = await store.list();
    const serialized = JSON.stringify(result);
    for (const secret of [
      "arg-secret",
      "cwd-secret",
      "env-secret",
      "SECRET_REFERENCE",
      "custom-secret",
      "url-secret",
      "query-secret",
      "fragment-secret",
      "header-secret",
      "oauth-secret",
    ])
      expect(serialized).not.toContain(secret);
    expect(result.servers.find((server) => server.name === "local")).toMatchObject({
      argumentCount: 2,
      environmentKeys: ["API_KEY", "REF"],
      enabled: false,
    });
    expect(result.servers.find((server) => server.name === "remote")).toMatchObject({
      hasStoredUrl: true,
      headerKeys: ["Authorization"],
    });
  });

  test("patch preserves secrets, unknown server fields, invalid sibling entries, and top-level settings", async () => {
    const original = {
      autoEnableCodemode: false,
      custom: ["unchanged"],
      mcpServers: {
        docs: {
          type: "streamable-http",
          url: "https://example.com/mcp?token=secret",
          headers: { Authorization: "!echo secret", Keep: "keep" },
          oauth: { clientId: "id", clientSecret: "secret" },
          toolExposure: { "get_*": "direct" },
        },
        broken: null,
      },
    };
    await write(original);
    const result = await store.update("docs", {
      revision: await revision(),
      changes: {
        enabled: false,
        description: "Docs",
        headers: { Keep: null, New: envReference("NEW_TOKEN") },
      },
      confirmExecution: true,
    });
    expect(result.servers.find((server) => server.name === "docs")?.enabled).toBe(false);
    expect(await disk()).toEqual({
      ...original,
      mcpServers: {
        ...original.mcpServers,
        docs: {
          ...original.mcpServers.docs,
          enabled: false,
          description: "Docs",
          headers: { Authorization: "!echo secret", New: envReference("NEW_TOKEN") },
        },
      },
    });
  });

  test("arguments and environment are write-only but can be explicitly replaced/removed", async () => {
    await write({
      mcpServers: {
        local: {
          command: "example",
          args: ["old-secret"],
          env: { OLD: "secret", KEEP: "keep" },
          cwd: "/tmp",
        },
      },
    });
    await store.update("local", {
      revision: await revision(),
      changes: { args: [], env: { OLD: null, NEW: envReference("NEW") } },
      confirmExecution: true,
    });
    expect(await disk()).toEqual({
      mcpServers: {
        local: {
          command: "example",
          args: [],
          env: { KEEP: "keep", NEW: envReference("NEW") },
          cwd: "/tmp",
        },
      },
    });
  });

  test("requires explicit local execution acknowledgement for add, edit, and enable", async () => {
    const request = {
      revision: "missing",
      name: "local",
      definition: { command: "never-executed", args: ["!touch /tmp/not-executed"] },
    };
    await expectStatus(store.create(request), 400);
    await store.create({ ...request, confirmExecution: true });
    await expectStatus(
      store.update("local", { revision: await revision(), changes: { args: ["changed"] } }),
      400,
    );
    await store.update("local", { revision: await revision(), changes: { enabled: false } });
    await expectStatus(
      store.update("local", { revision: await revision(), changes: { enabled: true } }),
      400,
    );
    await store.update("local", {
      revision: await revision(),
      changes: { enabled: true },
      confirmExecution: true,
    });
    expect((await store.list()).servers[0]?.enabled).toBe(true);
  });

  test("remote credential command helpers also require execution acknowledgement", async () => {
    const request = {
      revision: "missing",
      name: "remote",
      definition: {
        url: "https://example.com/mcp",
        headers: { Authorization: "!example-token-command" },
      },
    };
    await expectStatus(store.create(request), 400);
    const result = await store.create({ ...request, confirmExecution: true });
    expect(result.servers[0]?.requiresExecutionApproval).toBe(true);
    expect(JSON.stringify(result)).not.toContain("example-token-command");
    await store.update("remote", { revision: result.revision, changes: { enabled: false } });
    await expectStatus(
      store.update("remote", { revision: await revision(), changes: { enabled: true } }),
      400,
    );
    await expectStatus(
      store.update("remote", {
        revision: await revision(),
        changes: { headers: { Extra: "!another-command" } },
      }),
      400,
    );
    await store.update("remote", {
      revision: await revision(),
      changes: { headers: { Authorization: null } },
    });
    expect((await store.list()).servers[0]?.requiresExecutionApproval).toBe(false);
  });

  test("stale writes from another hub or editor are rejected instead of overwriting", async () => {
    const first = await store.create({
      revision: "missing",
      name: "one",
      definition: { url: "https://example.com/mcp" },
    });
    await store.update("one", { revision: first.revision, changes: { enabled: false } });
    await expectStatus(store.remove("one", { revision: first.revision }), 409);
    const second = await revision();
    await write({ mcpServers: { external: { url: "https://external.example/mcp" } } });
    await expectStatus(
      store.create({
        revision: second,
        name: "two",
        definition: { url: "https://example.com/mcp" },
      }),
      409,
    );
    expect(Object.keys((await disk())["mcpServers"] as object)).toEqual(["external"]);
  });

  test("two hub instances serialize mutations and one loses a stale revision", async () => {
    const another = new LocalMcpStore(paths);
    const results = await Promise.allSettled([
      store.create({
        revision: "missing",
        name: "one",
        definition: { url: "https://example.com/one" },
      }),
      another.create({
        revision: "missing",
        name: "two",
        definition: { url: "https://example.com/two" },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" && failure.reason.status).toBe(409);
    expect((await store.list()).servers).toHaveLength(1);
  });

  test("rejects duplicate underscore aliases and handles prototype-like names safely", async () => {
    await store.create({
      revision: "missing",
      name: "my-tools",
      definition: { url: "https://example.com/mcp" },
    });
    await expectStatus(
      store.create({
        revision: await revision(),
        name: "my_tools",
        definition: { url: "https://example.com/mcp" },
      }),
      409,
    );
    await store.create({
      revision: await revision(),
      name: "__proto__",
      definition: { url: "https://example.com/mcp" },
    });
    expect((await store.list()).servers.map((server) => server.name)).toContain("__proto__");
    await store.remove("__proto__", { revision: await revision() });
    await expectStatus(store.remove("constructor", { revision: await revision() }), 404);
  });

  test("removes invalid entries without overwriting unrelated configuration", async () => {
    await write({
      other: true,
      mcpServers: { broken: ["invalid"], keep: { url: "https://example.com/mcp" } },
    });
    const before = await store.list();
    expect(before.servers.find((server) => server.name === "broken")?.editable).toBe(false);
    await store.remove("broken", { revision: before.revision });
    expect(await disk()).toEqual({
      other: true,
      mcpServers: { keep: { url: "https://example.com/mcp" } },
    });
  });

  test.each([
    { name: "../escape", definition: { url: "https://example.com/mcp" } },
    { name: "bad name", definition: { url: "https://example.com/mcp" } },
    { name: "bad", definition: { url: "file:///etc/passwd" } },
    { name: "bad", definition: { url: "javascript:alert(1)" } },
    { name: "bad", definition: { url: "https://example.com", command: "npx" } },
    { name: "bad", definition: { command: "" } },
    { name: "bad", definition: { command: "test\0bad" } },
    { name: "bad", definition: { url: "https://example.com", disabled: true } },
    { name: "bad", definition: { url: "https://example.com", env: { KEY: 123 } } },
    { name: "bad", definition: { url: "https://example.com", timeout: -1 } },
  ])("rejects invalid new configuration: %j", async (request) => {
    await expectStatus(
      store.create({ revision: "missing", ...request, confirmExecution: true }),
      400,
    );
    expect((await store.list()).revision).toBe("missing");
  });

  test.each(["not JSON secret", "[]", '{"mcpServers":null}', '{"mcpServers":[]}'])(
    "preserves malformed files: %s",
    async (content) => {
      await mkdir(paths.pi, { recursive: true });
      await Bun.write(store.configPath, content);
      await expectStatus(store.list(), 422);
      await expectStatus(
        store.create({
          revision: "missing",
          name: "docs",
          definition: { url: "https://example.com/mcp" },
        }),
        422,
      );
      expect(await readFile(store.configPath, "utf8")).toBe(content);
    },
  );

  test("refuses oversized files", async () => {
    await mkdir(paths.pi, { recursive: true });
    await Bun.write(store.configPath, " ".repeat(MAX_MCP_CONFIG_BYTES + 1));
    await expectStatus(store.list(), 422);
  });

  test("refuses a symlink configuration and never replaces its target", async () => {
    await mkdir(paths.pi, { recursive: true });
    const target = join(root, "private.json");
    await Bun.write(target, '{"private":"secret"}');
    await symlink(target, store.configPath);
    await expectStatus(store.list(), 422);
    await expectStatus(
      store.create({
        revision: "missing",
        name: "docs",
        definition: { url: "https://example.com/mcp" },
      }),
      422,
    );
    expect(await readFile(target, "utf8")).toBe('{"private":"secret"}');
    expect((await lstat(store.configPath)).isSymbolicLink()).toBe(true);
  });

  test("refuses a symlink Pi directory", async () => {
    await mkdir(paths.home, { recursive: true });
    const target = join(root, "elsewhere");
    await mkdir(target);
    await symlink(target, paths.pi);
    await expectStatus(store.list(), 422);
    await expectStatus(
      store.create({
        revision: "missing",
        name: "docs",
        definition: { url: "https://example.com/mcp" },
      }),
      422,
    );
    expect(await readdir(target)).toEqual([]);
  });

  test("tightens configuration permissions on save", async () => {
    await write({ mcpServers: { docs: { url: "https://example.com/mcp" } } });
    await chmod(store.configPath, 0o644);
    await store.update("docs", { revision: await revision(), changes: { enabled: false } });
    expect((await lstat(store.configPath)).mode & 0o777).toBe(0o600);
  });
});
