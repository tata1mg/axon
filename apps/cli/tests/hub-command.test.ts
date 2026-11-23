import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entrypoint = resolve(import.meta.dir, "../src/index.ts");

async function exerciseCommand(command: string[], root: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      AXON_HOME: join(root, ".axon"),
      NODE_EXTRA_CA_CERTS: "",
      AXON_NO_UPDATE: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const reader = child.stdout.getReader();
  let output = "";
  try {
    let launchUrl: string | undefined;
    while (!launchUrl) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`Hub exited before startup: ${output}`);
      output += new TextDecoder().decode(value);
      launchUrl = output.match(/http:\/\/127\.0\.0\.1:\d+\/_axon\/hub\/#token=[a-f0-9]{64}/)?.[0];
    }
    const url = new URL(launchUrl);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`<div id="root">`);
    const script = await fetch(new URL("hub.js", url));
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("replaceState");
    const style = await fetch(new URL("hub.css", url));
    expect(style.status).toBe(200);
    expect(await style.text()).toContain(".server-list");
    const session = await fetch(new URL("api/session", url), {
      method: "POST",
      headers: { origin: url.origin, "content-type": "application/json" },
      body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }),
    });
    expect(session.status).toBe(200);
    const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
    const list = await fetch(new URL("api/mcps", url), { headers: { cookie, "x-axon-hub": "1" } });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ revision: "missing", servers: [], scope: "user" });
    // No login, Pi installation, settings materialization, or config creation on read.
    expect(await Bun.file(join(root, ".deputydev", ".deputydev_session")).exists()).toBe(false);
    expect(await Bun.file(join(root, ".axon", "pi", "mcp.json")).exists()).toBe(false);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
  }
}

test("axon hub --help is a launcher command and does not sign in or launch Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "axon-hub-help-"));
  try {
    const child = Bun.spawn([process.execPath, entrypoint, "hub", "--help"], {
      env: { ...process.env, HOME: root, AXON_HOME: join(root, ".axon"), NODE_EXTRA_CA_CERTS: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const stdout = await new Response(child.stdout).text();
    expect(stdout).toContain("Usage: axon hub");
    expect(stdout).toContain("--no-open");
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await Bun.file(join(root, ".axon", "pi", "settings.json")).exists()).toBe(false);
    expect(await Bun.file(join(root, ".axon", "pi", "mcp.json")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source CLI serves a standalone hub without authentication and stops on signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "axon-hub-command-"));
  try {
    await exerciseCommand([process.execPath, entrypoint, "hub", "--no-open"], root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled, minified CLI embeds hub assets and works outside the checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "axon-hub-compiled-"));
  try {
    const executable = join(root, "axon");
    const result = await Bun.build({
      entrypoints: [entrypoint],
      compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false },
      format: "esm",
      minify: true,
      bytecode: true,
    });
    expect({ success: result.success, errors: result.logs.map((log) => log.message) }).toEqual({
      success: true,
      errors: [],
    });
    await exerciseCommand([executable, "hub", "--no-open"], root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
