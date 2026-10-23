import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ensureAxonSession, runPiSessionPreflight } from "../src/cli/auth/preflight.ts";
import {
  loadEncryptedSession,
  refreshEncryptedSession,
  saveEncryptedSession,
} from "../src/cli/auth/session.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-preflight-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
function paths(name: string) {
  return resolveAxonPaths({ AXON_HOME: join(root, name, "axon"), HOME: join(root, name) });
}

describe("first-run preflight", () => {
  test("existing sessions skip onboarding even without a terminal or while offline", async () => {
    const home = paths("existing");
    await saveEncryptedSession(home, "saved-session");
    let calls = 0;
    await ensureAxonSession(home, {
      interactive: false,
      offline: true,
      login: async () => {
        calls++;
        return true;
      },
    });
    expect(calls).toBe(0);
  });

  test("first interactive run logs in and persists before continuation; next run skips", async () => {
    const home = paths("first");
    let calls = 0;
    const login = async () => {
      calls++;
      await saveEncryptedSession(home, "new-session");
      return true;
    };
    await ensureAxonSession(home, { interactive: true, login });
    expect(await loadEncryptedSession(home)).toBe("new-session");
    await ensureAxonSession(home, { interactive: true, login });
    expect(calls).toBe(1);
  });

  test("noninteractive and offline missing-session runs fail without invoking login", async () => {
    for (const options of [{ interactive: false }, { interactive: true, offline: true }]) {
      await expect(
        ensureAxonSession(paths("not-saved"), {
          ...options,
          login: async () => {
            throw new Error("must not call");
          },
        }),
      ).rejects.toThrow("login is required");
    }
  });

  for (const [name, content] of [
    ["truncated JSON", '{"truncated'],
    ["null JSON", "null"],
    ["array JSON", "[]"],
    ["invalid token", JSON.stringify({ extension_auth_token: "invalid token" })],
    ["non-string token", JSON.stringify({ extension_auth_token: 123 })],
    ["empty token", JSON.stringify({ extension_auth_token: "" })],
  ] as const) {
    test(`interactive onboarding repairs ${name} after login`, async () => {
      const home = paths(`repair-${name}`);
      await mkdir(home.sharedAuthDirectory, { recursive: true });
      await Bun.write(home.sharedAuthFile, content);
      let calls = 0;
      await ensureAxonSession(home, {
        interactive: true,
        login: async () => {
          calls++;
          expect(await Bun.file(home.sharedAuthFile).text()).toBe(content);
          await saveEncryptedSession(home, "repaired-session");
          return true;
        },
      });
      expect(calls).toBe(1);
      expect(await loadEncryptedSession(home)).toBe("repaired-session");
    });

    test(`noninteractive/offline onboarding requires login for ${name} without modifying it`, async () => {
      const home = paths(`no-repair-${name}`);
      await mkdir(home.sharedAuthDirectory, { recursive: true });
      await Bun.write(home.sharedAuthFile, content);
      let calls = 0;
      for (const options of [{ interactive: false }, { interactive: true, offline: true }]) {
        await expect(
          ensureAxonSession(home, {
            ...options,
            login: async () => {
              calls++;
              return true;
            },
          }),
        ).rejects.toThrow("login is required");
      }
      expect(calls).toBe(0);
      expect(await Bun.file(home.sharedAuthFile).text()).toBe(content);
    });
  }

  test("cancelled onboarding cannot continue", async () => {
    await expect(
      ensureAxonSession(paths("cancel"), { interactive: true, login: async () => false }),
    ).rejects.toThrow("not completed");
  });

  test("unsafe session files fail safely instead of being overwritten", async () => {
    const home = paths("unsafe");
    await mkdir(home.sharedAuthDirectory, { recursive: true });
    await symlink("/does/not/exist", home.sharedAuthFile);
    await expect(
      ensureAxonSession(home, {
        interactive: true,
        login: async () => {
          throw new Error("must not call");
        },
      }),
    ).rejects.toThrow("could not be read safely");
  });

  for (const code of ["EACCES", "EPERM", "EIO"]) {
    test(`${code} storage errors do not trigger login`, async () => {
      let calls = 0;
      await expect(
        ensureAxonSession(paths(`storage-${code}`), {
          interactive: true,
          loadSession: async () => {
            throw Object.assign(new Error("private storage error"), { code });
          },
          login: async () => {
            calls++;
            return true;
          },
        }),
      ).rejects.toThrow("could not be read safely");
      expect(calls).toBe(0);
    });
  }

  test("Pi help/auth/admin bypass preflight; print/RPC/CI/offline do not prompt", async () => {
    const invocation = { ci: false, stdinIsTty: true, stdoutIsTty: true };
    const home = paths("classification");
    for (const args of [
      ["--help"],
      ["--version"],
      ["auth"],
      ["install", "npm:test"],
      ["mcp", "list", "--json"],
      ["mcp", "login", "example"],
    ]) {
      await runPiSessionPreflight(home, args, {}, invocation);
    }
    for (const args of [["-p", "hello"], ["--mode", "rpc"], ["--offline"]]) {
      await expect(runPiSessionPreflight(home, args, {}, invocation)).rejects.toThrow(
        "login is required",
      );
    }
    await expect(runPiSessionPreflight(home, [], {}, { ...invocation, ci: true })).rejects.toThrow(
      "login is required",
    );
  });
});

describe("refresh persistence", () => {
  test("preserves unrelated keys, enforces 0600, and rejects stale refreshes", async () => {
    const home = paths("refresh");
    await mkdir(home.sharedAuthDirectory, { recursive: true });
    const file = home.sharedAuthFile;
    await Bun.write(file, JSON.stringify({ vscode: "retained", extension_auth_token: "original" }));
    await chmod(file, 0o644);
    expect(await refreshEncryptedSession(home, "original", "rotated")).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      vscode: "retained",
      extension_auth_token: "rotated",
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await refreshEncryptedSession(home, "original", "stale")).toBe(false);
    expect(await loadEncryptedSession(home)).toBe("rotated");
  });
});

test("real dispatch fails before provisioning and keeps help/status/invalid usage available", async () => {
  const home = paths("dispatch");
  async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts", ...args], {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        AXON_HOME: home.home,
        HOME: join(root, "dispatch"),
        AXON_SERVICE_ORIGIN: "http://127.0.0.1:1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, status };
  }
  for (const args of [
    ["pi"],
    ["paths"],
    ["harnesses"],
    ["doctor", "pi"],
    ["setup", "pi", "--sync-packages"],
  ]) {
    const result = await run(args);
    expect(result.status).toBe(123);
    expect(result.stderr).toContain("axon auth login");
    expect(await Bun.file(home.home).exists()).toBe(false);
  }
  for (const args of [["--help"], ["--version"], ["paths", "--help"], ["auth", "status"]])
    expect((await run(args)).status).toBe(0);
  for (const args of [
    ["unknown"],
    ["setup", "other", "--sync-packages"],
    ["doctor", "other"],
    ["setup", "pi"],
  ])
    expect((await run(args)).status).toBe(120);
});
