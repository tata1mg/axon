import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { LauncherError } from "../launcher/errors.ts";
import { isExecutableFile, resolveCommandOnPath } from "../launcher/executable.ts";
import { LAUNCHER_EXIT_STATUS } from "../launcher/exit-status.ts";
import { withFileLock } from "../launcher/file-lock.ts";

export type JsonObject = Record<string, unknown>;

/** A third-party app whose JSON config an `axon setup <app>` command edits. */
export interface IntegrationTarget {
  /** Display name used in messages, e.g. "Paseo". */
  readonly app: string;
  /** Command that reruns this setup, used in remediation text. */
  readonly setupCommand: string;
  readonly configPath: string;
}

export interface IntegrationSetupOptions {
  readonly config?: string;
  readonly yes?: boolean;
}

export interface IntegrationSetupResult {
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

export function setupError(message: string, remediation?: string): LauncherError {
  return new LauncherError(message, LAUNCHER_EXIT_STATUS.profileFailure, {
    ...(remediation === undefined ? {} : { remediation }),
  });
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads an optional object section; anything else leaves the config unchanged. */
export function objectSection(
  target: IntegrationTarget,
  parent: JsonObject,
  key: string,
  section: string,
): JsonObject {
  const value = parent[key];
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw setupError(`${target.app} ${section} must be an object; config left unchanged`);
  }
  return value;
}

async function readSnapshot(target: IntegrationTarget): Promise<ConfigSnapshot | undefined> {
  try {
    const status = await lstat(target.configPath);
    if (!status.isFile()) {
      throw setupError(
        `refusing to modify ${target.app} config that is not a regular file: ${target.configPath}`,
      );
    }
    return {
      content: await readFile(target.configPath, "utf8"),
      mode: status.mode & 0o777,
      ino: status.ino,
      dev: status.dev,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseConfig(
  target: IntegrationTarget,
  snapshot: ConfigSnapshot | undefined,
  emptyConfig: JsonObject,
): JsonObject {
  if (snapshot === undefined) return emptyConfig;

  let config: unknown;
  try {
    config = JSON.parse(snapshot.content);
  } catch {
    throw setupError(
      `${target.app} config is not valid JSON; left unchanged: ${target.configPath}`,
    );
  }
  if (!isObject(config)) {
    throw setupError(
      `${target.app} config must contain a JSON object; left unchanged: ${target.configPath}`,
    );
  }
  return config;
}

async function assertUnchanged(
  target: IntegrationTarget,
  original: ConfigSnapshot | undefined,
): Promise<void> {
  if (!isDeepStrictEqual(await readSnapshot(target), original)) {
    throw setupError(
      `${target.app} config changed during setup; refusing to overwrite it: ${target.configPath}`,
      `Rerun ${target.setupCommand} against the latest config.`,
    );
  }
}

async function writeConfig(
  target: IntegrationTarget,
  config: JsonObject,
  original: ConfigSnapshot | undefined,
): Promise<string | undefined> {
  const { configPath } = target;
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  return withFileLock(`${configPath}.axon.lock`, async () => {
    await assertUnchanged(target, original);
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
      await assertUnchanged(target, original);
      if (original === undefined) {
        // Never replace a file the app created while setup was running.
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

export interface ApplyIntegrationOptions extends IntegrationSetupOptions {
  readonly target: IntegrationTarget;
  /** Contents assumed when the config file does not exist yet. */
  readonly emptyConfig: JsonObject;
  /** Only consulted when no config exists; an existing config is proof enough. */
  readonly detectInstallation: () => Promise<boolean>;
  readonly installRemediation: string;
  /** Returns the merged config, and whether it replaces an existing Axon entry. */
  readonly merge: (config: JsonObject) => {
    readonly config: JsonObject;
    readonly replacesAxon: boolean;
  };
  readonly confirmReplacement?: (configPath: string) => Promise<boolean>;
  /**
   * Files the config depends on. Runs once setup is going ahead (after validation and
   * confirmation, before writing), and also when the config is already current.
   */
  readonly ensurePrerequisites?: () => Promise<void>;
}

/**
 * Merges Axon's settings into an app's JSON config. Invalid configs, concurrent
 * edits, and unconfirmed replacements of an existing Axon entry leave it untouched.
 */
export async function applyIntegrationConfig(
  options: ApplyIntegrationOptions,
): Promise<IntegrationSetupResult> {
  const { target } = options;
  const { configPath } = target;
  try {
    const original = await readSnapshot(target);
    if (original === undefined && !(await options.detectInstallation())) {
      throw new LauncherError(
        `${target.app} was not found; no configuration was created`,
        LAUNCHER_EXIT_STATUS.executableUnavailable,
        { remediation: options.installRemediation },
      );
    }

    const config = parseConfig(target, original, options.emptyConfig);
    const { config: merged, replacesAxon } = options.merge(config);
    if (isDeepStrictEqual(config, merged)) {
      await options.ensurePrerequisites?.();
      return { status: "unchanged", configPath };
    }

    if (replacesAxon && options.yes !== true) {
      if (options.confirmReplacement === undefined) {
        throw new LauncherError(
          `${target.app} already has Axon configured with different settings; left unchanged: ${configPath}`,
          LAUNCHER_EXIT_STATUS.usage,
          { remediation: "Rerun interactively to confirm the update, or pass --yes to accept it." },
        );
      }
      if (!(await options.confirmReplacement(configPath)))
        return { status: "cancelled", configPath };
    }

    await options.ensurePrerequisites?.();
    const backupPath = await writeConfig(target, merged, original);
    return {
      status: original === undefined ? "created" : "updated",
      configPath,
      ...(backupPath === undefined ? {} : { backupPath }),
    };
  } catch (error) {
    if (error instanceof LauncherError) throw error;
    throw new LauncherError(
      `could not configure ${target.app}: ${configPath}`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      { cause: error, remediation: "Check the config path and file permissions, then retry." },
    );
  }
}

/**
 * True when `command` is on PATH or one of `appExecutables` (paths inside an
 * Applications folder) exists: desktop apps can be installed without their CLI.
 */
export async function isAppInstalled(input: {
  readonly command: string;
  readonly appExecutables: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly userHome: string;
}): Promise<boolean> {
  if ((await resolveCommandOnPath(input.command, input.environment, input.cwd)) !== undefined)
    return true;
  for (const applications of ["/Applications", join(input.userHome, "Applications")]) {
    for (const executable of input.appExecutables) {
      if (await isExecutableFile(join(applications, executable))) return true;
    }
  }
  return false;
}
