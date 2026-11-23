import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { startAuthenticatedRequestRelay } from "../src/cli/auth/request-relay.ts";
import axonExtension from "../src/harnesses/pi/resources/extensions/axon.ts";
import { createPiHub } from "../src/hub/pi-hub.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const OPEN = "/_axon/hub/open";
const HUB_API = "/_axon/hub/api";

function hubCommand() {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  axonExtension({
    events: { on() {} },
    on() {},
    registerProvider() {},
    registerEntryRenderer() {},
    registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);
  const command = commands.get("axon-hub");
  if (!command) throw new Error("Missing /axon-hub command");
  const notify = mock();
  const run = (args = "", mode: ExtensionCommandContext["mode"] = "tui") =>
    command.handler(args, {
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      ui: { notify },
    } as unknown as ExtensionCommandContext);
  return { notify, run };
}

async function withRelayEnvironment<T>(
  relay: { origin: string; capability: string },
  run: () => Promise<T>,
): Promise<T> {
  const values = {
    PI_AXON_AUTH_RELAY_URL: relay.origin,
    PI_AXON_AUTH_RELAY_KEY: relay.capability,
  };
  const original = Object.entries(values).map(([key]) => [key, process.env[key]] as const);
  try {
    Object.assign(process.env, values);
    return await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function exchangeLink(link: URL): Promise<Response> {
  const token = new URLSearchParams(link.hash.slice(1)).get("token");
  return fetch(`${link.origin}${HUB_API}/session`, {
    method: "POST",
    headers: { origin: link.origin, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function fixture(offline: boolean, openBrowser: (url: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "axon-pi-hub-"));
  const paths = resolveAxonPaths({ AXON_HOME: home, HOME: home });
  const piHub = createPiHub(paths, { offline, openBrowser });
  const relay = startAuthenticatedRequestRelay(paths, { piHub });
  return {
    relay,
    authorization: { Authorization: `Bearer ${relay.capability}` },
    async close() {
      relay.dispose();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("/axon-hub opens a private Hub in the browser and the launcher owns its lifetime", async () => {
  const openBrowser = mock(async (_url: string) => {});
  const { relay, authorization, close } = await fixture(false, openBrowser);
  let latestLink: URL | undefined;
  try {
    const endpoint = relay.origin + OPEN;
    expect((await fetch(endpoint, { method: "POST" })).status).toBe(401);
    expect((await fetch(endpoint, { headers: authorization })).status).toBe(404);
    expect(
      (await fetch(`${endpoint}?extra`, { method: "POST", headers: authorization })).status,
    ).toBe(404);
    for (const headers of [{ origin: relay.origin }, { "sec-fetch-site": "same-origin" }]) {
      expect(
        (await fetch(endpoint, { method: "POST", headers: { ...authorization, ...headers } }))
          .status,
      ).toBe(403);
    }
    expect(openBrowser).not.toHaveBeenCalled();

    const { run, notify } = hubCommand();
    await withRelayEnvironment(relay, async () => {
      await run("unexpected");
      await run("", "json");
      await run("", "print");
      expect(openBrowser).not.toHaveBeenCalled();
      await run();
      expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("opened"), "info");
      const link = new URL(openBrowser.mock.calls[0]?.[0] ?? "");
      expect(link.origin).not.toBe(relay.origin);
      expect(link.hostname).toBe("127.0.0.1");
      expect((await exchangeLink(link)).status).toBe(200);
      expect((await exchangeLink(link)).status).toBe(401);

      // A new invocation issues a different one-use link without keeping the old Hub alive.
      await run();
      latestLink = new URL(openBrowser.mock.calls[1]?.[0] ?? "");
      expect(latestLink.hash).not.toBe(link.hash);
      if (link.port !== latestLink.port) await expect(fetch(link)).rejects.toThrow();
    });
  } finally {
    await close();
  }
  if (!latestLink) throw new Error("Missing Hub browser link");
  await expect(fetch(latestLink)).rejects.toThrow();
});

test("an offline /axon-hub shows a manual link on browser failure and only serves local settings", async () => {
  const { relay, close } = await fixture(true, async () => {
    throw new Error("No system browser available");
  });
  try {
    const { run, notify } = hubCommand();
    await withRelayEnvironment(relay, () => run());
    const [message, level] = notify.mock.calls[0] ?? [];
    expect(level).toBe("warning");
    const link = new URL(String(message).split("manually: ")[1] ?? "");
    const response = await exchangeLink(link);
    expect(response.status).toBe(200);
    const headers = { "x-axon-hub": "1", cookie: response.headers.get("set-cookie") ?? "" };
    const session = await fetch(`${link.origin}${HUB_API}/session`, { headers });
    expect(await session.json()).toMatchObject({
      features: { localMcps: true, catalog: false, skills: false },
    });
    expect((await fetch(`${link.origin}${HUB_API}/mcps`, { headers })).status).toBe(200);
    expect((await fetch(`${link.origin}${HUB_API}/catalog`, { headers })).status).toBe(404);
  } finally {
    await close();
  }
});

test("/axon-hub opens the Hub for a local RPC client, including the manual-link fallback", async () => {
  const openBrowser = mock(async (_url: string) => {});
  const { relay, close } = await fixture(false, openBrowser);
  try {
    const { run, notify } = hubCommand();
    await withRelayEnvironment(relay, () => run("", "rpc"));
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("opened"), "info");
    const link = new URL(openBrowser.mock.calls[0]?.[0] ?? "");
    expect((await exchangeLink(link)).status).toBe(200);

    openBrowser.mockImplementation(async () => {
      throw new Error("No system browser available");
    });
    await withRelayEnvironment(relay, () => run("", "rpc"));
    const [message, level] = notify.mock.calls.at(-1) ?? [];
    expect(level).toBe("warning");
    expect((await exchangeLink(new URL(String(message).split("manually: ")[1] ?? ""))).status).toBe(
      200,
    );
  } finally {
    await close();
  }
});
