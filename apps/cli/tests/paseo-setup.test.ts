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
    enabled: true,
    label: "Axon",
    command: [paths.managedBinary, "pi"],
    env: {
      PI_CODING_AGENT_DIR: paths.pi,
      PI_MODEL_RECOMMENDER_RPC: "1",
      PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
    },
  };
}

const disabledProviderIds = ["pi", "opencode", "copilot", "codex", "claude", "muse", "antigravity"];

const expectedTerminalProfile = {
  id: "profile_mvt5ic5u_nj5mgc6ucq",
  name: "Axon",
  command: "axon",
  args: ["pi", "{{{prompt}}}"],
};

function expectedIntegration(environment: NodeJS.ProcessEnv) {
  return {
    features: { dictation: { enabled: true }, voiceMode: { enabled: true } },
    pluginsEnabled: true,
    daemon: {
      relay: { enabled: true },
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: true },
      enableTerminalAgentHooks: true,
      terminalProfiles: [expectedTerminalProfile],
    },
    agents: {
      providers: {
        ...Object.fromEntries(disabledProviderIds.map((id) => [id, { enabled: false }])),
        axon: expectedProvider(environment),
      },
    },
  };
}

async function readConfig(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("Paseo integration setup", () => {
  test("detects the CLI and creates a private config with user-specific Axon paths", async () => {
    const { environment, configPath } = await fixture("first install with spaces");
    const result = await configurePaseo({ environment });

    expect(result).toEqual({ status: "created", configPath });
    expect(await readConfig(configPath)).toEqual({
      version: 1,
      ...expectedIntegration(environment),
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(dirname(configPath))).toEqual(["config.json"]);
  });

  test("merges managed settings, preserving unrelated configuration and file mode", async () => {
    const providerOverrides = Object.fromEntries(
      disabledProviderIds.map((id) => [
        id,
        {
          enabled: true,
          command: [`/custom/${id}`],
          env: { EXTRA: "keep" },
          options: { customSetting: true },
        },
      ]),
    );
    const original = {
      version: 1,
      daemon: {
        agentProfiles: [{ name: "personal", provider: "pi" }],
        terminalProfiles: [{ id: "shell", name: "Shell", command: "zsh" }],
        listen: "127.0.0.1:6767",
        relay: { enabled: false, endpoint: "wss://relay.example.test/ws" },
        mcp: { enabled: false, injectIntoAgents: false },
        browserTools: { enabled: false, customSetting: true },
        enableTerminalAgentHooks: false,
      },
      agents: {
        other: true,
        providers: {
          personal: { extends: "pi", label: "Personal" },
          ...providerOverrides,
        },
      },
      features: {
        dictation: { enabled: false, stt: { provider: "local", language: "en" } },
        voiceMode: {
          enabled: false,
          llm: { provider: "axon", model: "custom-model" },
          tts: { provider: "local", speed: 1.25 },
        },
        webUi: { enabled: false },
      },
      pluginsEnabled: false,
    };
    const content = JSON.stringify(original);
    const { environment, configPath } = await fixture("merge", content);
    await chmod(configPath, 0o640);
    const result = await configurePaseo({ environment });

    expect(result.status).toBe("updated");
    expect(await readConfig(configPath)).toEqual({
      ...original,
      features: {
        ...original.features,
        dictation: { ...original.features.dictation, enabled: true },
        voiceMode: { ...original.features.voiceMode, enabled: true },
      },
      pluginsEnabled: true,
      daemon: {
        ...original.daemon,
        relay: { ...original.daemon.relay, enabled: true },
        mcp: { ...original.daemon.mcp, injectIntoAgents: true },
        browserTools: { ...original.daemon.browserTools, enabled: true },
        enableTerminalAgentHooks: true,
        terminalProfiles: [...original.daemon.terminalProfiles, expectedTerminalProfile],
      },
      agents: {
        ...original.agents,
        providers: {
          ...original.agents.providers,
          ...Object.fromEntries(
            disabledProviderIds.map((id) => [
              id,
              {
                ...providerOverrides[id],
                enabled: false,
              },
            ]),
          ),
          axon: expectedProvider(environment),
        },
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

  test("an already configured integration is a byte-for-byte no-op, including custom extras", async () => {
    const { environment, configPath } = await fixture("no op");
    const provider = {
      ...expectedProvider(environment),
      customSetting: true,
      env: { EXTRA: "keep", ...expectedProvider(environment).env },
    };
    await mkdir(dirname(configPath), { recursive: true });
    const integration = expectedIntegration(environment);
    const content = JSON.stringify({
      ...integration,
      daemon: {
        ...integration.daemon,
        terminalProfiles: [{ ...expectedTerminalProfile, icon: "terminal", customSetting: true }],
      },
      agents: { providers: { ...integration.agents.providers, axon: provider } },
    });
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

  test("adds the terminal profile to an otherwise configured integration and reruns are a no-op", async () => {
    const { environment, configPath } = await fixture("terminal profile missing", "{}");
    const integration = expectedIntegration(environment);
    const shell = { id: "shell", name: "Shell", command: "zsh" };
    const content = JSON.stringify({
      ...integration,
      daemon: { ...integration.daemon, terminalProfiles: [shell] },
    });
    await writeFile(configPath, content);
    await expect(configurePaseo({ environment })).rejects.toMatchObject({ exitStatus: 120 });
    expect(await readFile(configPath, "utf8")).toBe(content);

    expect((await configurePaseo({ environment, yes: true })).status).toBe("updated");
    expect((await readConfig(configPath)).daemon.terminalProfiles).toEqual([
      shell,
      expectedTerminalProfile,
    ]);
    const updated = await readFile(configPath, "utf8");
    expect((await configurePaseo({ environment })).status).toBe("unchanged");
    expect(await readFile(configPath, "utf8")).toBe(updated);
  });

  test("updates an existing terminal profile by ID in place, preserving extra fields and other profiles", async () => {
    const { environment, configPath } = await fixture("terminal profile update", "{}");
    const integration = expectedIntegration(environment);
    const before = { id: "shell", name: "Shell", command: "zsh" };
    const after = { id: "custom-axon", name: "Axon", command: "custom-axon", args: ["custom"] };
    const content = JSON.stringify({
      ...integration,
      daemon: {
        ...integration.daemon,
        terminalProfiles: [
          before,
          {
            ...expectedTerminalProfile,
            name: "Old Axon",
            command: "old-axon",
            args: [],
            icon: "terminal",
          },
          after,
        ],
      },
    });
    await writeFile(configPath, content);
    const cancelled = await configurePaseo({ environment, confirmReplacement: async () => false });
    expect(cancelled.status).toBe("cancelled");
    expect(await readFile(configPath, "utf8")).toBe(content);

    expect((await configurePaseo({ environment, yes: true })).status).toBe("updated");
    expect((await readConfig(configPath)).daemon.terminalProfiles).toEqual([
      before,
      { ...expectedTerminalProfile, icon: "terminal" },
      after,
    ]);
    expect((await configurePaseo({ environment })).status).toBe("unchanged");
  });

  test("adds the terminal profile to an empty list", async () => {
    const { environment, configPath } = await fixture(
      "terminal profiles empty",
      '{"daemon":{"terminalProfiles":[]}}',
    );
    await configurePaseo({ environment });
    expect((await readConfig(configPath)).daemon.terminalProfiles).toEqual([
      expectedTerminalProfile,
    ]);
  });

  test("upgrades a provider-only setup rather than treating it as a no-op", async () => {
    const { environment, configPath } = await fixture("legacy setup", "{}");
    const content = JSON.stringify({
      agents: { providers: { axon: expectedProvider(environment) } },
    });
    await writeFile(configPath, content);

    await expect(configurePaseo({ environment })).rejects.toMatchObject({ exitStatus: 120 });
    expect(await readFile(configPath, "utf8")).toBe(content);
    const result = await configurePaseo({ environment, yes: true });
    expect(result.status).toBe("updated");
    expect(await readConfig(configPath)).toEqual(expectedIntegration(environment));
    expect((await configurePaseo({ environment })).status).toBe("unchanged");
  });

  test("each managed setting is checked and repaired even when the provider already matches", async () => {
    const managedPaths = [
      "features.dictation.enabled",
      "features.voiceMode.enabled",
      "pluginsEnabled",
      "daemon.relay.enabled",
      "daemon.mcp.injectIntoAgents",
      "daemon.browserTools.enabled",
      "daemon.enableTerminalAgentHooks",
      "agents.providers.axon.enabled",
      ...disabledProviderIds.map((id) => `agents.providers.${id}.enabled`),
    ];
    for (const path of managedPaths) {
      const { environment, configPath } = await fixture(`repair ${path}`, "{}");
      const config = JSON.parse(JSON.stringify(expectedIntegration(environment)));
      const keys = path.split(".");
      const key = keys.pop();
      if (key === undefined) throw new Error("expected a managed setting path");
      const section = keys.reduce((value, part) => value[part], config);
      section[key] = !section[key];
      const content = JSON.stringify(config);
      await writeFile(configPath, content);

      await expect(configurePaseo({ environment })).rejects.toMatchObject({ exitStatus: 120 });
      expect(await readFile(configPath, "utf8")).toBe(content);
      expect(await readdir(dirname(configPath))).toEqual(["config.json"]);
      const cancelled = await configurePaseo({
        environment,
        confirmReplacement: async () => false,
      });
      expect(cancelled.status).toBe("cancelled");
      expect(await readFile(configPath, "utf8")).toBe(content);
      const result = await configurePaseo({ environment, yes: true });
      expect(result.status).toBe("updated");
      if (result.backupPath === undefined) throw new Error("expected a config backup");
      expect(await readFile(result.backupPath, "utf8")).toBe(content);
      expect(await readConfig(configPath)).toEqual(expectedIntegration(environment));
    }
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
      '{"features":null}',
      '{"features":{"dictation":false}}',
      '{"features":{"voiceMode":[]}}',
      '{"daemon":[]}',
      '{"daemon":{"relay":false}}',
      '{"daemon":{"relay":null}}',
      '{"daemon":{"relay":[]}}',
      '{"daemon":{"mcp":false}}',
      '{"daemon":{"browserTools":null}}',
      ...[null, false, {}, "profiles", [null], ["profile"], [[]]].map((terminalProfiles) =>
        JSON.stringify({ daemon: { terminalProfiles } }),
      ),
      ...disabledProviderIds.map((id) => JSON.stringify({ agents: { providers: { [id]: null } } })),
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
    expect(first.stdout).toContain("Enabled dictation, voice mode, plugins, MCP injection");
    expect(first.stdout).toContain("Enabled Paseo relay for remote connectivity.");
    expect(first.stdout).toContain("Configured the Axon terminal profile: axon pi {{{prompt}}}");
    expect(first.stdout).toContain(
      "Disabled Pi, OpenCode, Copilot, Codex, Claude, Muse, and Antigravity",
    );
    expect(await readConfig(configPath)).toEqual({
      version: 1,
      ...expectedIntegration(environment),
    });
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
    expect(help.stdout).toContain("pi, paseo, or t3code");
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
