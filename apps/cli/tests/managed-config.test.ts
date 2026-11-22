import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

import managedConfig from "../src/harnesses/pi/resources/extensions/managed-config.ts";

const keys = [
  "PI_AXON_CONFIG_REFRESH_ENABLED",
  "PI_AXON_AUTH_RELAY_URL",
  "PI_AXON_AUTH_RELAY_KEY",
  "PI_AXON_LITELLM_MANAGED_FEATURES",
  "LITELLM_ENABLE_MCP",
  "LITELLM_ENABLE_SKILLS",
  "LITELLM_ENABLE_BUDGET",
] as const;
let savedEnvironment: Record<string, string | undefined>;
let originalFetch: typeof fetch;
const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit) =>
  Response.json({ applied: true }),
);

beforeEach(() => {
  savedEnvironment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env["PI_AXON_CONFIG_REFRESH_ENABLED"] = "true";
  process.env["PI_AXON_AUTH_RELAY_URL"] = "http://127.0.0.1:12345";
  process.env["PI_AXON_AUTH_RELAY_KEY"] = "local-capability";
  originalFetch = globalThis.fetch;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ applied: true }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setup() {
  let shutdown: ((event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>) | undefined;
  const names: string[] = [];
  const notify = mock((_message: string, _level?: string) => {});
  managedConfig({
    on(name: string, handler: typeof shutdown) {
      names.push(name);
      shutdown = handler;
    },
  } as unknown as ExtensionAPI);
  if (!shutdown) throw new Error("Missing reload hook");
  const ctx = { hasUI: true, ui: { notify } } as unknown as ExtensionContext;
  return {
    names,
    notify,
    run: (reason: SessionShutdownEvent["reason"]) =>
      shutdown?.({ type: "session_shutdown", reason }, ctx),
  };
}

test("awaits a protected refresh before the reload shutdown hook completes", async () => {
  const response = Promise.withResolvers<Response>();
  fetchMock.mockImplementation(() => response.promise);
  const { names, run, notify } = setup();
  expect(names).toEqual(["session_shutdown"]);
  let finished = false;
  const work = run("reload")?.then(() => {
    finished = true;
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(finished).toBe(false);
  const [url, options] = fetchMock.mock.calls[0] ?? [];
  expect(String(url)).toBe("http://127.0.0.1:12345/_axon/pi-defaults/refresh");
  expect(options).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
  expect(new Headers(options?.headers).get("authorization")).toBe("Bearer local-capability");
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  response.resolve(Response.json({ applied: true }));
  await work;
  expect(finished).toBe(true);
  expect(notify).not.toHaveBeenCalled();
});

test("does not fetch on quit, new session, resume, or fork", async () => {
  const { run } = setup();
  for (const reason of ["quit", "new", "resume", "fork"] as const) await run(reason);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("offline/unmanaged sessions and missing capabilities skip refresh", async () => {
  const { run } = setup();
  for (const enabled of [undefined, "false"]) {
    if (enabled === undefined) delete process.env["PI_AXON_CONFIG_REFRESH_ENABLED"];
    else process.env["PI_AXON_CONFIG_REFRESH_ENABLED"] = enabled;
    await run("reload");
  }
  process.env["PI_AXON_CONFIG_REFRESH_ENABLED"] = "true";
  delete process.env["PI_AXON_AUTH_RELAY_KEY"];
  await run("reload");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("refuses non-loopback or malformed origins without sending the capability", async () => {
  const { run, notify } = setup();
  for (const origin of [
    "https://evil.example",
    "http://user:secret@127.0.0.1:12345",
    "http://127.0.0.1:12345/path",
    "http://127.0.0.1:12345?token=secret",
    "http://127.0.0.1:12345#fragment",
    "not-a-url",
  ]) {
    process.env["PI_AXON_AUTH_RELAY_URL"] = origin;
    await run("reload");
  }
  expect(fetchMock).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledTimes(6);
  expect(JSON.stringify(notify.mock.calls)).not.toContain("secret");
  expect(JSON.stringify(notify.mock.calls)).not.toContain("local-capability");
});

test("HTTP errors and network failures warn safely without blocking reload", async () => {
  const { run, notify } = setup();
  fetchMock.mockImplementation(async () => new Response("private-secret", { status: 503 }));
  await run("reload");
  fetchMock.mockImplementation(async () => {
    throw new Error("private-secret");
  });
  await run("reload");
  expect(notify).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(notify.mock.calls)).not.toContain("private-secret");
});

test("reload updates only the LiteLLM feature variables the launcher manages", async () => {
  // The user exported LITELLM_ENABLE_SKILLS, so the launcher left it out of the managed list.
  process.env["PI_AXON_LITELLM_MANAGED_FEATURES"] = "mcp,budget";
  process.env["LITELLM_ENABLE_MCP"] = "1";
  process.env["LITELLM_ENABLE_SKILLS"] = "1";
  process.env["LITELLM_ENABLE_BUDGET"] = "0";
  fetchMock.mockImplementation(async () =>
    Response.json({ applied: true, litellmFeatures: { mcp: false, skills: false, budget: true } }),
  );
  const { run, notify } = setup();
  await run("reload");
  expect(notify).not.toHaveBeenCalled();
  expect(process.env["LITELLM_ENABLE_MCP"]).toBe("0");
  expect(process.env["LITELLM_ENABLE_SKILLS"]).toBe("1");
  expect(process.env["LITELLM_ENABLE_BUDGET"]).toBe("1");

  for (const body of [{ applied: true }, { litellmFeatures: { mcp: "true", budget: null } }, []]) {
    fetchMock.mockImplementation(async () => Response.json(body));
    await run("reload");
  }
  expect(process.env["LITELLM_ENABLE_MCP"]).toBe("0");
  expect(process.env["LITELLM_ENABLE_BUDGET"]).toBe("1");

  delete process.env["PI_AXON_LITELLM_MANAGED_FEATURES"];
  fetchMock.mockImplementation(async () =>
    Response.json({ applied: true, litellmFeatures: { mcp: true, skills: false, budget: false } }),
  );
  await run("reload");
  expect(process.env["LITELLM_ENABLE_MCP"]).toBe("0");
  expect(process.env["LITELLM_ENABLE_SKILLS"]).toBe("1");
});
