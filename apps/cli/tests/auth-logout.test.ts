import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  clearEncryptedSession,
  loadEncryptedSession,
  refreshEncryptedSession,
  saveEncryptedSession,
} from "../src/cli/auth/session.ts";
import { runAuthLogout } from "../src/cli/commands/auth.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const roots: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "axon-logout-"));
  roots.push(home);
  const environment = { ...process.env, HOME: home, AXON_HOME: join(home, "axon") };
  return { home, environment, paths: resolveAxonPaths(environment) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("logout removes only the shared credential and prevents stale refresh resurrection", async () => {
  const { paths } = await fixture();
  await saveEncryptedSession(paths, "private-token");
  await Bun.write(
    paths.sharedAuthFile,
    JSON.stringify({
      extension_auth_token: "private-token",
      cli_auth_token: "keep-other-token",
      settings: { keep: true },
    }),
  );
  expect(await clearEncryptedSession(paths)).toBe(true);
  expect(await loadEncryptedSession(paths)).toBeUndefined();
  expect(await Bun.file(paths.sharedAuthFile).json()).toEqual({
    cli_auth_token: "keep-other-token",
    settings: { keep: true },
  });
  expect((await stat(paths.sharedAuthFile)).mode & 0o777).toBe(0o600);
  expect(await refreshEncryptedSession(paths, "private-token", "late-token")).toBe(false);
  expect(await clearEncryptedSession(paths)).toBe(false);
});

test("logout is a no-op with no authentication directory or no token", async () => {
  const { paths } = await fixture();
  expect(await clearEncryptedSession(paths)).toBe(false);
  expect(await Bun.file(paths.sharedAuthDirectory).exists()).toBe(false);
  await mkdir(paths.sharedAuthDirectory);
  expect(await clearEncryptedSession(paths)).toBe(false);
  await Bun.write(paths.sharedAuthFile, '{"settings":true}\n');
  expect(await clearEncryptedSession(paths)).toBe(false);
  expect(await Bun.file(paths.sharedAuthFile).text()).toBe('{"settings":true}\n');
});

test("logout clears even an invalid token without dropping unrelated fields", async () => {
  const { paths } = await fixture();
  await mkdir(paths.sharedAuthDirectory);
  await Bun.write(paths.sharedAuthFile, JSON.stringify({ extension_auth_token: null, keep: true }));
  expect(await clearEncryptedSession(paths)).toBe(true);
  expect(await Bun.file(paths.sharedAuthFile).json()).toEqual({ keep: true });
});

test("logout fails safely on corrupt JSON without exposing or changing its contents", async () => {
  const { paths } = await fixture();
  await mkdir(paths.sharedAuthDirectory);
  await Bun.write(paths.sharedAuthFile, '{"private-credential');
  await expect(runAuthLogout(paths)).rejects.toThrow("could not be cleared safely");
  expect(await Bun.file(paths.sharedAuthFile).text()).toBe('{"private-credential');
});

test("logout refuses symlinked files and directories without touching their targets", async () => {
  const { home, paths } = await fixture();
  const target = join(home, "target");
  await mkdir(target);
  const targetFile = join(target, "session.json");
  await Bun.write(targetFile, '{"extension_auth_token":"private-token"}');
  await mkdir(paths.sharedAuthDirectory);
  await symlink(targetFile, paths.sharedAuthFile);
  await expect(clearEncryptedSession(paths)).rejects.toThrow("not a regular file");
  await rm(paths.sharedAuthDirectory, { recursive: true });
  await symlink(target, paths.sharedAuthDirectory);
  await expect(clearEncryptedSession(paths)).rejects.toThrow("not a regular directory");
  expect(await Bun.file(targetFile).json()).toEqual({ extension_auth_token: "private-token" });
});

test("CLI logout works noninteractively without an auth service, including repeated logout", async () => {
  const { paths, environment } = await fixture();
  await saveEncryptedSession(paths, "private-token");
  for (const expected of ["Logged out locally.", "Already logged out locally."]) {
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../src/index.ts"), "auth", "logout"],
      {
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain(expected);
    expect(stdout + stderr).not.toContain("private-token");
  }
  expect(await loadEncryptedSession(paths)).toBeUndefined();
});
