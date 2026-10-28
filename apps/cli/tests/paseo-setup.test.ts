import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { configurePaseo } from "../src/integrations/paseo.ts";
import { LauncherError } from "../src/launcher/errors.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let fixtureDirectory: string;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "axon-paseo-"));
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function fixture(name: string, content?: string) {
  const home = join(fixtureDirectory, name);
  const bin = join(home, "bin");
  const configPath = join(home, ".paseo", "config.json");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "paseo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (content !== undefined) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, content);
  }
  return { home, configPath, environment: { HOME: home, PATH: bin } };
}

function expectedProvider(environment: NodeJS.ProcessEnv) {
  const paths = resolveAxonPaths(environment);
  return {
    extends: "pi",
    label: "Axon",
    command: [paths.managedBinary, "pi"],
    env: {
      PI_CODING_AGENT_DIR: paths.pi,
      PI_MODEL_RECOMMENDER_RPC: "1",
      PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
    },
  };
}

async function readConfig(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("Paseo provider setup", () => {
  test("detects the CLI and creates a private config with user-specific Axon paths", async () => {
    const { environment, configPath } = await fixture("first install with spaces");
    const result = await configurePaseo({ environment });

    expect(result).toEqual({ status: "created", configPath });
    expect(await readConfig(configPath)).toEqual({
      version: 1,
      agents: { providers: { axon: expectedProvider(environment) } },
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(dirname(configPath))).toEqual(["config.json"]);
  });

  test("merges only the provider, preserving all other Paseo configuration and file mode", async () => {
    const original = {
      version: 1,
      daemon: { agentProfiles: [{ name: "personal", provider: "pi" }], listen: "127.0.0.1:6767" },
      agents: { other: true, providers: { personal: { extends: "pi", label: "Personal" } } },
      features: { voiceMode: { enabled: true } },
    };
    const content = JSON.stringify(original);
    const { environment, configPath } = await fixture("merge", content);
    await chmod(configPath, 0o640);
    const result = await configurePaseo({ environment });

    expect(result.status).toBe("updated");
    expect(await readConfig(configPath)).toEqual({
      ...original,
      agents: {
        ...original.agents,
        providers: { ...original.agents.providers, axon: expectedProvider(environment) },
      },
    });
    const backupPath = result.backupPath;
    expect(backupPath).toBeDefined();
    if (backupPath === undefined) throw new Error("expected a config backup");
    expect(await readFile(backupPath, "utf8")).toBe(content);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
    expect((await readdir(dirname(configPath))).sort()).toEqual(
      ["config.json", basename(backupPath)].sort(),
    );
  });

  test("uses AXON_HOME and a relative custom config path, even without Paseo on PATH", async () => {
    const { environment, home } = await fixture("custom paths");
    const configPath = join(home, "custom paseo", "settings.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "{}");
    const customEnvironment = { ...environment, PATH: "", AXON_HOME: join(home, "custom axon") };
    const result = await configurePaseo({
      environment: customEnvironment,
      cwd: home,
      config: "custom paseo/settings.json",
    });

    expect(result.configPath).toBe(configPath);
    expect((await readConfig(configPath)).agents.providers.axon).toEqual(
      expectedProvider(customEnvironment),
    );
  });

  test("an already configured provider is a byte-for-byte no-op, including custom extras", async () => {
    const { environment, configPath } = await fixture("no op");
    const provider = {
      ...expectedProvider(environment),
      customSetting: true,
      env: { EXTRA: "keep", ...expectedProvider(environment).env },
    };
    await mkdir(dirname(configPath), { recursive: true });
    const content = JSON.stringify({ agents: { providers: { axon: provider } } });
    await writeFile(configPath, content);
    const before = await stat(configPath);
    const result = await configurePaseo({
      environment,
      confirmReplacement: async () => {
        throw new Error("must not prompt");
      },
    });

    expect(result).toEqual({ status: "unchanged", configPath });
    expect(await readFile(configPath, "utf8")).toBe(content);
    expect((await stat(configPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(dirname(configPath))).toEqual(["config.json"]);
  });

  test("a conflicting provider requires confirmation in noninteractive runs", async () => {
    const content = '{"agents":{"providers":{"axon":{"command":["custom"]}}}}';
    const { environment, configPath } = await fixture("conflict", content);
    try {
      await configurePaseo({ environment });
      throw new Error("expected a confirmation error");
    } catch (error) {
      expect(error).toBeInstanceOf(LauncherError);
      expect((error as LauncherError).exitStatus).toBe(120);
      expect((error as LauncherError).remediation).toContain("--yes");
    }
    expect(await readFile(configPath, "utf8")).toBe(content);
    expect(await readdir(dirname(configPath))).toEqual(["config.json"]);
  });

  test("--yes updates managed fields while retaining extra provider and environment settings", async () => {
    const original = {
      agents: {
        providers: {
          axon: {
            extends: "pi",
            label: "Old Axon",
            command: ["/old/axon", "pi"],
            customSetting: true,
            env: { EXTRA: "keep", PI_CODING_AGENT_DIR: "/old/pi" },
          },
        },
      },
    };
    const { environment, configPath } = await fixture("accept yes", JSON.stringify(original));
    const result = await configurePaseo({ environment, yes: true });

    expect(result.status).toBe("updated");
    expect((await readConfig(configPath)).agents.providers.axon).toEqual({
      ...expectedProvider(environment),
      customSetting: true,
      env: { EXTRA: "keep", ...expectedProvider(environment).env },
    });
  });

  test("interactive confirmation can accept or cancel without writing on cancellation", async () => {
    for (const accepted of [false, true]) {
      const content = '{"agents":{"providers":{"axon":null}}}';
      const { environment, configPath } = await fixture(`confirmation ${accepted}`, content);
      const result = await configurePaseo({
        environment,
        confirmReplacement: async (path) => {
          expect(path).toBe(configPath);
          return accepted;
        },
      });
      expect(result.status).toBe(accepted ? "updated" : "cancelled");
      if (!accepted) {
        expect(await readFile(configPath, "utf8")).toBe(content);
        expect(await readdir(dirname(configPath))).toEqual(["config.json"]);
      }
    }
  });

  test("invalid JSON and malformed parent sections are left untouched, even with --yes", async () => {
    for (const [index, content] of [
      "{broken",
      "[]",
      "null",
      "42",
      '{"agents":null}',
      '{"agents":[]}',
      '{"agents":{"providers":false}}',
    ].entries()) {
      const { environment, configPath } = await fixture(`invalid ${index}`, content);
      await expect(configurePaseo({ environment, yes: true })).rejects.toBeInstanceOf(
        LauncherError,
      );
      expect(await readFile(configPath, "utf8")).toBe(content);
      expect(await readdir(dirname(configPath))).toEqual(["config.json"]);
    }
  });

  test("refuses symlink and directory configs", async () => {
    const { environment, home, configPath } = await fixture("symlink");
    const target = join(home, "target.json");
    await writeFile(target, "{}");
    await mkdir(dirname(configPath), { recursive: true });
    await symlink(target, configPath);
    await expect(configurePaseo({ environment })).rejects.toThrow("not a regular file");
    expect(await readFile(target, "utf8")).toBe("{}");
    await expect(configurePaseo({ environment, config: home })).rejects.toThrow(
      "not a regular file",
    );
  });

  test("does not create a config if Paseo is not installed", async () => {
    const { environment, configPath } = await fixture("not installed");
    await expect(
      configurePaseo({ environment, detectInstallation: async () => false }),
    ).rejects.toThrow("Paseo was not found");
    expect(await Bun.file(configPath).exists()).toBe(false);
    await expect(stat(dirname(configPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to overwrite config changes made while confirmation was open", async () => {
    const { environment, configPath } = await fixture(
      "concurrent edit",
      '{"agents":{"providers":{"axon":{}}}}',
    );
    const changed = '{"version":1,"userChange":true}';
    await expect(
      configurePaseo({
        environment,
        confirmReplacement: async () => {
          await writeFile(configPath, changed);
          return true;
        },
      }),
    ).rejects.toThrow("changed during setup");
    expect(await readFile(configPath, "utf8")).toBe(changed);
    expect(await readdir(dirname(configPath))).toEqual(["config.json"]);
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

describe("axon setup paseo CLI", () => {
  test("configures Paseo without a saved login and reports a no-op on rerun", async () => {
    const { environment, configPath } = await fixture("cli");
    const first = await runCli(["setup", "paseo"], environment);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain(`Paseo Axon provider configured: ${configPath}`);
    expect(first.stdout).toContain("Restart Paseo");
    expect((await runCli(["setup", "paseo"], environment)).stdout).toContain("already has");
  });

  test("supports --config and requires --yes to update conflicts in scripts", async () => {
    const { environment, home } = await fixture("cli custom");
    const configPath = join(home, "custom config.json");
    await writeFile(configPath, '{"agents":{"providers":{"axon":{}}}}');
    const args = ["setup", "paseo", "--config", configPath];
    const refused = await runCli(args, environment);
    expect(refused.status).toBe(120);
    expect(refused.stderr).toContain("--yes");
    const accepted = await runCli([...args, "--yes"], environment);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("Previous config backed up to:");
    expect((await readConfig(configPath)).agents.providers.axon).toEqual(
      expectedProvider(environment),
    );
  });

  test("advertises setup targets and rejects flags for the wrong target without requiring login", async () => {
    const { environment } = await fixture("cli help");
    const help = await runCli(["setup", "--help"], environment);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("pi or paseo");
    expect(help.stdout).toContain("--config");
    expect(help.stdout).toContain("--yes");
    for (const args of [
      ["setup", "paseo", "--sync-packages"],
      ["setup", "pi", "--sync-packages", "--yes"],
      ["setup", "pi", "--sync-packages", "--config", "unused.json"],
    ]) {
      const result = await runCli(args, environment);
      expect(result.status).toBe(120);
      expect(result.stderr).toMatch(/appl(y|ies) only/);
    }
  });
});
