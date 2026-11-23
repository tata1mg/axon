import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  configureT3Code,
  defaultT3CodeSettingsPath,
  T3CODE_DISABLED_PROVIDERS,
} from "../src/integrations/t3code.ts";
import { LauncherError } from "../src/launcher/errors.ts";
import { piWrapperScript } from "../src/launcher/pi-wrapper.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let fixtureDirectory: string;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "axon-t3code-"));
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function fixture(name: string, settings?: unknown) {
  const home = join(fixtureDirectory, name);
  const settingsPath = join(home, ".t3", "userdata", "settings.json");
  await mkdir(home, { recursive: true });
  if (settings !== undefined) {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      typeof settings === "string" ? settings : JSON.stringify(settings, null, 2),
    );
  }
  // An empty PATH keeps detection deterministic.
  return { home, settingsPath, environment: { HOME: home, PATH: "" } as NodeJS.ProcessEnv };
}

async function readSettings(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

function expectedAxon(environment: NodeJS.ProcessEnv) {
  const paths = resolveAxonPaths(environment);
  return {
    driver: "pi",
    displayName: "Axon",
    enabled: true,
    environment: [
      { name: "PI_CODING_AGENT_DIR", value: paths.pi, sensitive: false },
      { name: "PI_CODING_AGENT_SESSION_DIR", value: paths.piSessions, sensitive: false },
      { name: "PI_MODEL_RECOMMENDER_RPC", value: "1", sensitive: false },
      { name: "AXON_IGNORE_OFFLINE", value: "1", sensitive: false },
    ],
    config: { binaryPath: paths.piWrapper },
  };
}

const disabledInstances = Object.fromEntries(
  T3CODE_DISABLED_PROVIDERS.map((id) => [id, { driver: id, enabled: false }]),
);

describe("configureT3Code", () => {
  test("creates settings with the Axon provider and the Pi wrapper when T3 Code is installed", async () => {
    const { environment, settingsPath } = await fixture("create");
    const result = await configureT3Code({ environment, detectInstallation: async () => true });
    expect(result).toEqual({ status: "created", configPath: settingsPath });
    expect(await readSettings(settingsPath)).toEqual({
      providerInstances: { ...disabledInstances, axon: expectedAxon(environment) },
    });
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);

    const paths = resolveAxonPaths(environment);
    expect(await readFile(paths.piWrapper, "utf8")).toBe(piWrapperScript(paths.managedBinary));
    expect((await stat(paths.piWrapper)).mode & 0o777).toBe(0o755);
  });

  test("does not create settings if T3 Code is not installed", async () => {
    const { environment, settingsPath } = await fixture("not installed");
    await expect(
      configureT3Code({ environment, detectInstallation: async () => false }),
    ).rejects.toThrow("T3 Code was not found");
    expect(await Bun.file(settingsPath).exists()).toBe(false);
    expect(await Bun.file(resolveAxonPaths(environment).piWrapper).exists()).toBe(false);
  });

  test("detects the desktop app without its CLI on PATH", async () => {
    const { environment, home, settingsPath } = await fixture("app only");
    const executable = join(home, "Applications", "T3 Code (Beta).app", "Contents", "MacOS");
    await mkdir(executable, { recursive: true });
    await writeFile(join(executable, "T3 Code (Beta)"), "", { mode: 0o755 });
    expect((await configureT3Code({ environment })).status).toBe("created");
    expect(await Bun.file(settingsPath).exists()).toBe(true);
  });

  test("keeps unrelated settings, Claude, custom instances, and user variables", async () => {
    const { environment, settingsPath } = await fixture("merge", {
      favorites: ["a"],
      providerInstances: {
        claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: "claude" } },
        codex: { driver: "codex", enabled: true, accentColor: "#fff" },
        pi: { driver: "pi", enabled: true },
        work: { driver: "codex", enabled: true },
      },
    });
    const result = await configureT3Code({ environment });
    expect(result.status).toBe("updated");
    expect(result.backupPath).toStartWith(`${settingsPath}.axon-backup.`);
    const settings = await readSettings(settingsPath);
    expect(settings.favorites).toEqual(["a"]);
    expect(settings.providerInstances.claudeAgent).toEqual({
      driver: "claudeAgent",
      enabled: true,
      config: { binaryPath: "claude" },
    });
    expect(settings.providerInstances.codex).toEqual({
      driver: "codex",
      enabled: false,
      accentColor: "#fff",
    });
    expect(settings.providerInstances.pi).toEqual({ driver: "pi", enabled: false });
    expect(settings.providerInstances.work).toEqual({ driver: "codex", enabled: true });
    expect(settings.providerInstances.axon).toEqual(expectedAxon(environment));
  });

  test("updates an existing Axon provider only with confirmation and keeps user additions", async () => {
    const { environment, settingsPath } = await fixture("existing", {
      providerInstances: {
        axon: {
          driver: "pi",
          displayName: "My Axon",
          accentColor: "#123",
          environment: [
            { name: "AXON_IGNORE_OFFLINE", value: "", sensitive: true, valueRedacted: true },
            { name: "MY_FLAG", value: "x", sensitive: false },
          ],
          enabled: true,
          config: { binaryPath: "/old/axon-pi", launchArgs: "--approve", enabled: false },
        },
      },
    });
    await expect(configureT3Code({ environment })).rejects.toMatchObject({ exitStatus: 120 });
    const cancelled = await configureT3Code({ environment, confirmReplacement: async () => false });
    expect(cancelled.status).toBe("cancelled");
    expect(await Bun.file(resolveAxonPaths(environment).piWrapper).exists()).toBe(false);

    expect((await configureT3Code({ environment, yes: true })).status).toBe("updated");
    const expected = expectedAxon(environment);
    expect((await readSettings(settingsPath)).providerInstances.axon).toEqual({
      ...expected,
      accentColor: "#123",
      environment: [
        { name: "AXON_IGNORE_OFFLINE", value: "1", sensitive: false },
        { name: "MY_FLAG", value: "x", sensitive: false },
        ...expected.environment.filter((entry) => entry.name !== "AXON_IGNORE_OFFLINE"),
      ],
      config: { binaryPath: expected.config.binaryPath, launchArgs: "--approve", enabled: true },
    });
  });

  test("reports unchanged on rerun and still repairs a missing wrapper", async () => {
    const { environment, settingsPath } = await fixture("rerun", {});
    expect((await configureT3Code({ environment })).status).toBe("updated");
    const content = await readFile(settingsPath, "utf8");
    const wrapper = resolveAxonPaths(environment).piWrapper;
    await rm(wrapper);

    expect(await configureT3Code({ environment })).toEqual({
      status: "unchanged",
      configPath: settingsPath,
    });
    expect(await readFile(settingsPath, "utf8")).toBe(content);
    expect(await Bun.file(wrapper).exists()).toBe(true);
  });

  test("leaves invalid settings untouched", async () => {
    for (const [index, content] of [
      "not json",
      "[]",
      '{"providerInstances":[]}',
      '{"providerInstances":{"axon":"x"}}',
      '{"providerInstances":{"axon":{"config":[]}}}',
      '{"providerInstances":{"axon":{"environment":{}}}}',
      '{"providerInstances":{"axon":{"environment":[{"value":"1"}]}}}',
      '{"providerInstances":{"codex":null}}',
    ].entries()) {
      const { environment, settingsPath } = await fixture(`invalid ${index}`, content);
      await expect(configureT3Code({ environment, yes: true })).rejects.toBeInstanceOf(
        LauncherError,
      );
      expect(await readFile(settingsPath, "utf8")).toBe(content);
      expect(await readdir(dirname(settingsPath))).toEqual(["settings.json"]);
    }
  });

  test("follows T3CODE_HOME like T3 Code does", () => {
    const home = "/Users/me";
    expect(defaultT3CodeSettingsPath({}, home)).toBe("/Users/me/.t3/userdata/settings.json");
    expect(defaultT3CodeSettingsPath({ T3CODE_HOME: " " }, home)).toBe(
      "/Users/me/.t3/userdata/settings.json",
    );
    expect(defaultT3CodeSettingsPath({ T3CODE_HOME: "~/t3-alt" }, home)).toBe(
      "/Users/me/t3-alt/userdata/settings.json",
    );
    expect(defaultT3CodeSettingsPath({ T3CODE_HOME: "/srv/t3" }, home)).toBe(
      "/srv/t3/userdata/settings.json",
    );
  });
});

async function runCli(argumentsVector: string[], environment: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts", ...argumentsVector], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, ...environment, AXON_SERVICE_ORIGIN: "http://127.0.0.1:1", CI: "1" },
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

describe("axon setup t3code CLI", () => {
  test("configures existing settings without a saved login and requires --yes for conflicts", async () => {
    const { environment, settingsPath } = await fixture("cli", {});
    const first = await runCli(["setup", "t3code"], environment);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`T3 Code Axon provider configured: ${settingsPath}`);
    expect(first.stdout).toContain("Claude is unchanged");
    expect((await runCli(["setup", "t3code"], environment)).stdout).toContain("already has");

    const custom = join(dirname(settingsPath), "custom.json");
    await writeFile(custom, '{"providerInstances":{"axon":{"driver":"pi"}}}');
    const refused = await runCli(["setup", "t3code", "--config", custom], environment);
    expect(refused.status).toBe(120);
    expect(refused.stderr).toContain("--yes");
    const accepted = await runCli(["setup", "t3code", "--config", custom, "--yes"], environment);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("Previous settings backed up to:");
  });

  test("rejects Pi-only flags and unknown targets", async () => {
    const { environment } = await fixture("cli flags");
    const syncPackages = await runCli(["setup", "t3code", "--sync-packages"], environment);
    expect(syncPackages.status).toBe(120);
    expect(syncPackages.stderr).toContain("applies only to Pi setup");
    const unknown = await runCli(["setup", "constructor"], environment);
    expect(unknown.status).not.toBe(0);
  });
});
