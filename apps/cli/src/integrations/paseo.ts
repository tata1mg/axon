import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { LauncherError } from "../launcher/errors.ts";
import { isExecutableFile, resolveCommandOnPath } from "../launcher/executable.ts";
import { LAUNCHER_EXIT_STATUS } from "../launcher/exit-status.ts";
import { withFileLock } from "../launcher/file-lock.ts";
import { resolveAxonPaths } from "../product/paths.ts";

type JsonObject = Record<string, unknown>;

export interface PaseoSetupOptions {
  readonly config?: string;
  readonly yes?: boolean;
}

interface ConfigurePaseoOptions extends PaseoSetupOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly confirmReplacement?: (configPath: string) => Promise<boolean>;
  readonly detectInstallation?: () => Promise<boolean>;
}

export interface PaseoSetupResult {
  readonly status: "created" | "updated" | "unchanged" | "cancelled";
  readonly configPath: string;
  readonly backupPath?: string;
}

interface ConfigSnapshot {
  readonly content: string;
  readonly mode: number;
  readonly ino: number;
  readonly dev: number;
}

function setupError(message: string, remediation?: string): LauncherError {
  return new LauncherError(message, LAUNCHER_EXIT_STATUS.profileFailure, {
    ...(remediation === undefined ? {} : { remediation }),
  });
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readSnapshot(configPath: string): Promise<ConfigSnapshot | undefined> {
  try {
    const status = await lstat(configPath);
    if (!status.isFile()) {
      throw setupError(`refusing to modify Paseo config that is not a regular file: ${configPath}`);
    }
    return {
      content: await readFile(configPath, "utf8"),
      mode: status.mode & 0o777,
      ino: status.ino,
      dev: status.dev,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseConfig(snapshot: ConfigSnapshot | undefined, configPath: string): JsonObject {
  if (snapshot === undefined) return { version: 1 };

  let config: unknown;
  try {
    config = JSON.parse(snapshot.content);
  } catch {
    throw setupError(`Paseo config is not valid JSON; left unchanged: ${configPath}`);
  }
  if (!isObject(config)) {
    throw setupError(`Paseo config must contain a JSON object; left unchanged: ${configPath}`);
  }
  return config;
}

function objectSection(parent: JsonObject, key: string, section: string): JsonObject {
  const value = parent[key];
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw setupError(`Paseo ${section} must be an object; config left unchanged`);
  }
  return value;
}

async function isPaseoInstalled(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  userHome: string,
): Promise<boolean> {
  if ((await resolveCommandOnPath("paseo", environment, cwd)) !== undefined) return true;
  // The desktop application can be installed without its CLI being on PATH.
  for (const applications of ["/Applications", join(userHome, "Applications")]) {
    if (
      await isExecutableFile(
        join(applications, "Paseo.app", "Contents", "Resources", "bin", "paseo"),
      )
    ) {
      return true;
    }
  }
  return false;
}

async function assertUnchanged(
  configPath: string,
  original: ConfigSnapshot | undefined,
): Promise<void> {
  if (!isDeepStrictEqual(await readSnapshot(configPath), original)) {
    throw setupError(
      `Paseo config changed during setup; refusing to overwrite it: ${configPath}`,
      "Rerun axon setup paseo against the latest config.",
    );
  }
}

async function writeConfig(
  configPath: string,
  config: JsonObject,
  original: ConfigSnapshot | undefined,
): Promise<string | undefined> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  return withFileLock(`${configPath}.axon.lock`, async () => {
    await assertUnchanged(configPath, original);
    const suffix = `${Date.now()}.${crypto.randomUUID()}`;
    const temporaryPath = `${configPath}.axon.${suffix}.tmp`;
    const backupPath = original === undefined ? undefined : `${configPath}.axon-backup.${suffix}`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporaryPath, original?.mode ?? 0o600);
      if (backupPath !== undefined && original !== undefined) {
        // Configs may contain credentials. Backups are private and never replaced.
        await writeFile(backupPath, original.content, { flag: "wx", mode: 0o600 });
      }
      await assertUnchanged(configPath, original);
      if (original === undefined) {
        // Never replace a file created by Paseo while setup was running.
        await link(temporaryPath, configPath);
      } else {
        await rename(temporaryPath, configPath);
      }
      return backupPath;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  });
}

/** Register only the Axon provider; models, agent profiles and terminal profiles are user-owned. */
export async function configurePaseo(
  options: ConfigurePaseoOptions = {},
): Promise<PaseoSetupResult> {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const userHome = environment["HOME"] || homedir();
  const configPath = resolve(cwd, options.config ?? join(userHome, ".paseo", "config.json"));

  try {
    const original = await readSnapshot(configPath);
    // An existing config is sufficient, including installations outside PATH.
    const detectInstallation =
      options.detectInstallation ?? (() => isPaseoInstalled(environment, cwd, userHome));
    if (original === undefined && !(await detectInstallation())) {
      throw new LauncherError(
        "Paseo was not found; no configuration was created",
        LAUNCHER_EXIT_STATUS.executableUnavailable,
        {
          remediation: "Install Paseo, or use --config <path> to select an existing Paseo config.",
        },
      );
    }

    const config = parseConfig(original, configPath);
    const agents = objectSection(config, "agents", "agents");
    const providers = objectSection(agents, "providers", "agents.providers");
    const existing = providers["axon"];
    const paths = resolveAxonPaths(environment, userHome);
    const provider = {
      ...(isObject(existing) ? existing : {}),
      extends: "pi",
      label: "Axon",
      command: [paths.managedBinary, "pi"],
      env: {
        ...(isObject(existing) && isObject(existing["env"]) ? existing["env"] : {}),
        PI_CODING_AGENT_DIR: paths.pi,
        PI_MODEL_RECOMMENDER_RPC: "1",
        PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
      },
    };
    if (isDeepStrictEqual(existing, provider)) return { status: "unchanged", configPath };

    if (Object.hasOwn(providers, "axon") && options.yes !== true) {
      if (options.confirmReplacement === undefined) {
        throw new LauncherError(
          `Paseo already has a different Axon provider; left unchanged: ${configPath}`,
          LAUNCHER_EXIT_STATUS.usage,
          { remediation: "Rerun interactively to confirm the update, or pass --yes to accept it." },
        );
      }
      if (!(await options.confirmReplacement(configPath)))
        return { status: "cancelled", configPath };
    }

    const merged = {
      ...config,
      agents: { ...agents, providers: { ...providers, axon: provider } },
    };
    const backupPath = await writeConfig(configPath, merged, original);
    return {
      status: original === undefined ? "created" : "updated",
      configPath,
      ...(backupPath === undefined ? {} : { backupPath }),
    };
  } catch (error) {
    if (error instanceof LauncherError) throw error;
    throw new LauncherError(
      `could not configure Paseo: ${configPath}`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      { cause: error, remediation: "Check the config path and file permissions, then retry." },
    );
  }
}
