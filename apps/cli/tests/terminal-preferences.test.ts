import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  readYoloPreference,
  terminalPreferencesPath,
  toggleYoloPreference,
} from "../src/harnesses/pi/terminal-permissions/preferences.ts";

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "axon-terminal-preferences-"));
  path = join(directory, "terminal-preferences.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("user-level terminal preference storage", () => {
  test("uses the Axon user directory, never cwd or project settings", () => {
    const home = resolve("/synthetic/home");
    expect(terminalPreferencesPath({ HOME: home })).toBe(
      join(home, ".axon", "pi", "terminal-preferences.json"),
    );
    expect(terminalPreferencesPath({ HOME: home, AXON_HOME: directory })).toBe(
      join(directory, "pi", "terminal-preferences.json"),
    );
    expect(
      terminalPreferencesPath({
        HOME: home,
        AXON_HOME: "/ignored",
        PI_CODING_AGENT_DIR: directory,
      }),
    ).toBe(path);
  });

  test.each([
    "{",
    "null",
    "true",
    "[]",
    "{}",
    '{"version":1,"yoloEnabled":"true"}',
    '{"version":2,"yoloEnabled":true}',
    '{"version":1,"yoloEnabled":false}',
  ])("defaults to Standard for absent or invalid consent: %s", async (value) => {
    expect(readYoloPreference(path)).toBe(false);
    await writeFile(path, value);
    expect(readYoloPreference(path)).toBe(false);
  });

  test("creates private, atomic saved preferences without overwriting Pi settings", async () => {
    const settings = join(directory, "settings.json");
    await writeFile(settings, '{"theme":"dark"}');
    expect(await toggleYoloPreference(path, { allowEnable: true })).toBe(true);
    expect(readYoloPreference(path)).toBe(true);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await toggleYoloPreference(path, { allowEnable: true })).toBe(false);
    expect(readYoloPreference(path)).toBe(false);
    expect(await Bun.file(settings).text()).toBe('{"theme":"dark"}');
    expect((await readdir(directory)).sort()).toEqual([
      "settings.json",
      "terminal-preferences.json",
    ]);
  });

  test("serializes concurrent read-modify-write toggles", async () => {
    const states = await Promise.all(
      Array.from({ length: 6 }, () => toggleYoloPreference(path, { allowEnable: true })),
    );
    expect(states.filter(Boolean)).toHaveLength(3);
    expect(readYoloPreference(path)).toBe(false);
    expect(await readdir(directory)).toEqual(["terminal-preferences.json"]);
  });

  test("coordinates separate processes through the same preference file", async () => {
    const modulePath = resolve(
      import.meta.dir,
      "../src/harnesses/pi/terminal-permissions/preferences.ts",
    );
    const source = `import { toggleYoloPreference } from ${JSON.stringify(modulePath)};
      await toggleYoloPreference(${JSON.stringify(path)}, { allowEnable: true });`;
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, "--eval", source], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => ({
        status: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ status: 0, stderr: "" })));
    expect(readYoloPreference(path)).toBe(false);
  });

  test("rejects activation without permission but permits revoking existing consent", async () => {
    await expect(toggleYoloPreference(path, { allowEnable: false })).rejects.toThrow("unavailable");
    expect(readYoloPreference(path)).toBe(false);
    await toggleYoloPreference(path, { allowEnable: true });
    expect(await toggleYoloPreference(path, { allowEnable: false })).toBe(false);
  });

  test("aborted toggles never save consent", async () => {
    await expect(
      toggleYoloPreference(path, { allowEnable: true, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(readYoloPreference(path)).toBe(false);
  });
});
