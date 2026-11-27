import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPiChangelogDefaults,
  applyPiDefaults,
} from "../src/harnesses/pi/settings-defaults.ts";
import { withFileLock } from "../src/launcher/file-lock.ts";
import { type AxonPaths, resolveAxonPaths } from "../src/product/paths.ts";

let root: string;
let paths: AxonPaths;
let settingsPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-pi-defaults-"));
  paths = resolveAxonPaths({ AXON_HOME: root });
  settingsPath = join(paths.pi, "settings.json");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function notices(shown: boolean) {
  return { cacheMisses: shown, cacheWarming: shown, compactionCosts: shown, reasoningDrops: shown };
}

async function writeSettings(config: Record<string, unknown>): Promise<void> {
  await mkdir(paths.pi, { recursive: true });
  await Bun.write(settingsPath, JSON.stringify(config));
}

describe("managed Pi startup defaults", () => {
  test("suppresses upstream notes using the selected Pi version, preserving all other settings", async () => {
    const saved = {
      packages: ["npm:custom"],
      theme: "custom",
      collapseChangelog: false,
      lastChangelogVersion: "1.3.0",
    };
    await writeSettings(saved);
    await applyPiChangelogDefaults(paths, "1.4.0");
    expect(await Bun.file(settingsPath).json()).toEqual({
      ...saved,
      lastChangelogVersion: "1.4.0",
    });
    const inode = (await lstat(settingsPath)).ino;
    await applyPiChangelogDefaults(paths, "1.4.0");
    expect((await lstat(settingsPath)).ino).toBe(inode);
    await applyPiChangelogDefaults(paths, "1.5.0");
    expect((await Bun.file(settingsPath).json()).lastChangelogVersion).toBe("1.5.0");
  });

  test("changelog defaults never replace unsafe settings or symlinks", async () => {
    await mkdir(paths.pi, { recursive: true });
    await Bun.write(settingsPath, "{");
    await expect(applyPiChangelogDefaults(paths, "1.4.0")).rejects.toThrow();
    expect(await Bun.file(settingsPath).text()).toBe("{");
    await rm(settingsPath);
    const target = join(root, "other-settings.json");
    await Bun.write(target, "{}");
    await symlink(target, settingsPath);
    await expect(applyPiChangelogDefaults(paths, "1.4.0")).rejects.toThrow();
    expect(await Bun.file(target).text()).toBe("{}");
  });

  test("creates additive codemode defaults without configuring inlineBudget", async () => {
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect(await Bun.file(settingsPath).json()).toEqual({
      defaultTools: ["+codemode"],
      notices: notices(true),
    });
    expect((await lstat(settingsPath)).mode & 0o777).toBe(0o600);
  });

  test("preserves other tools, package metadata, and explicit codemode preferences", async () => {
    const settings = {
      packages: ["npm:custom", { source: "npm:other", extensions: ["entry.ts"] }],
      defaultTools: ["read", "grep", "-bash", "-codemode", "+codemode"],
      codemode: { mode: "only", inlineBudget: 0 },
      theme: "custom",
    };
    await writeSettings(settings);
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect(await Bun.file(settingsPath).json()).toEqual({
      ...settings,
      defaultTools: ["read", "grep", "-bash", "+codemode"],
      notices: notices(true),
    });
  });

  test("transcript notices default on, accept managed toggles, and avoid redundant writes", async () => {
    const defaults = { codemodeEnabled: true, litellmMcpEnabled: false };
    await writeSettings({ notices: notices(false), theme: "custom" });
    await applyPiDefaults(paths, defaults);
    expect((await Bun.file(settingsPath).json()).notices).toEqual(notices(true));

    for (const showCacheMissNotices of [false, true]) {
      const managed = { ...defaults, showCacheMissNotices };
      await applyPiDefaults(paths, managed);
      const settings = await Bun.file(settingsPath).json();
      expect(settings.notices).toEqual(notices(showCacheMissNotices));
      expect(settings.showCacheMissNotices).toBeUndefined();
      expect(settings.theme).toBe("custom");
      const content = await Bun.file(settingsPath).text();
      const status = await lstat(settingsPath);
      await applyPiDefaults(paths, managed);
      expect(await Bun.file(settingsPath).text()).toBe(content);
      expect((await lstat(settingsPath)).ino).toBe(status.ino);
    }
  });

  test("replaces the pre-1.6.1 notice setting and keeps notices Axon does not manage", async () => {
    // Pi lets saved notices.* win over the legacy key, so a managed toggle must write notices.*.
    await writeSettings({
      showCacheMissNotices: false,
      notices: { cacheMisses: true, futureNotice: false },
    });
    await applyPiDefaults(paths, {
      codemodeEnabled: true,
      litellmMcpEnabled: false,
      showCacheMissNotices: false,
    });
    const settings = await Bun.file(settingsPath).json();
    expect(settings).not.toHaveProperty("showCacheMissNotices");
    expect(settings.notices).toEqual({ ...notices(false), futureNotice: false });
  });

  test("repeated enable and disable are idempotent and retain other selections", async () => {
    await writeSettings({ defaultTools: ["-bash", "+grep"] });
    for (const codemodeEnabled of [true, false]) {
      await applyPiDefaults(paths, { codemodeEnabled, litellmMcpEnabled: false });
      const status = await lstat(settingsPath);
      const content = await Bun.file(settingsPath).text();
      await applyPiDefaults(paths, { codemodeEnabled, litellmMcpEnabled: false });
      expect(await Bun.file(settingsPath).text()).toBe(content);
      expect((await lstat(settingsPath)).ino).toBe(status.ino);
      expect((await Bun.file(settingsPath).json()).defaultTools).toEqual([
        "-bash",
        "+grep",
        codemodeEnabled ? "+codemode" : "-codemode",
      ]);
    }
  });

  test("an empty selection does not restore built-in tools when codemode is enabled", async () => {
    await writeSettings({ defaultTools: [] });
    await applyPiDefaults(paths, { codemodeEnabled: false, litellmMcpEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual([]);
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual(["codemode"]);
    const status = await lstat(settingsPath);
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect((await lstat(settingsPath)).ino).toBe(status.ino);
    await applyPiDefaults(paths, { codemodeEnabled: false, litellmMcpEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual(["codemode", "-codemode"]);
  });

  test("an explicitly selected codemode keeps the user's replacement selection", async () => {
    await writeSettings({ defaultTools: ["grep", "codemode"] });
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual(["grep", "codemode"]);
    await applyPiDefaults(paths, { codemodeEnabled: false, litellmMcpEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual([
      "grep",
      "codemode",
      "-codemode",
    ]);
  });

  test("codemode toggles without touching LiteLLM settings saved by earlier releases", async () => {
    const litellm = {
      skills: { enabled: false },
      mcp: { enabled: false, exposure: "deferred", toolExposure: { "*delete*": "hidden" } },
    };
    await writeSettings({ defaultTools: ["read"], litellm, theme: "custom" });
    for (const codemodeEnabled of [true, false]) {
      for (const litellmMcpEnabled of [true, false]) {
        await applyPiDefaults(paths, { codemodeEnabled, litellmMcpEnabled });
        expect(await Bun.file(settingsPath).json()).toEqual({
          defaultTools: ["read", codemodeEnabled ? "+codemode" : "-codemode"],
          notices: notices(true),
          litellm,
          theme: "custom",
        });
        const content = await Bun.file(settingsPath).text();
        const status = await lstat(settingsPath);
        await applyPiDefaults(paths, { codemodeEnabled, litellmMcpEnabled });
        expect(await Bun.file(settingsPath).text()).toBe(content);
        expect((await lstat(settingsPath)).ino).toBe(status.ino);
      }
    }
  });

  test("writes the default model only when managed and otherwise keeps the user's choice", async () => {
    const saved = { defaultProvider: "litellm", defaultModel: "anthropic/claude-local-pick" };
    await writeSettings({ ...saved, theme: "custom" });
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect(await Bun.file(settingsPath).json()).toMatchObject(saved);

    const managed = { defaultProvider: "litellm", defaultModel: "openai/gpt-6.1-sol" };
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false, ...managed });
    expect(await Bun.file(settingsPath).json()).toEqual({
      ...managed,
      theme: "custom",
      notices: notices(true),
      defaultTools: ["+codemode"],
    });
  });

  test("invalid local settings are never overwritten", async () => {
    for (const current of ["{", "[]", '{"defaultTools":true}', '{"defaultTools":[1]}']) {
      await mkdir(paths.pi, { recursive: true });
      await Bun.write(settingsPath, current);
      await expect(
        applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false }),
      ).rejects.toThrow();
      expect(await Bun.file(settingsPath).text()).toBe(current);
    }
  });

  test("replaces a non-object notices value, as Pi does", async () => {
    for (const saved of [null, true, [], "on"]) {
      await writeSettings({ notices: saved, theme: "custom" });
      await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
      expect(await Bun.file(settingsPath).json()).toEqual({
        theme: "custom",
        notices: notices(true),
        defaultTools: ["+codemode"],
      });
    }
  });

  test("symlinked settings and their target are left untouched", async () => {
    const target = join(root, "standalone-settings.json");
    await Bun.write(target, "{}");
    await mkdir(paths.pi, { recursive: true });
    await symlink(target, settingsPath);
    await expect(
      applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false }),
    ).rejects.toThrow();
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(target).text()).toBe("{}");
  });

  test("shares the package lock and reads the latest settings after acquiring it", async () => {
    await writeSettings({ packages: ["initial"] });
    let update: Promise<void> | undefined;
    await withFileLock(paths.piPackageLock, async () => {
      update = applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
      await writeSettings({ packages: ["concurrent-package-update"] });
    });
    await update;
    expect(await Bun.file(settingsPath).json()).toEqual({
      packages: ["concurrent-package-update"],
      notices: notices(true),
      defaultTools: ["+codemode"],
    });
  });
});
