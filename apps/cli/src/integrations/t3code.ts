import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ensurePiWrapper } from "../launcher/pi-wrapper.ts";
import { type AxonPaths, resolveAxonPaths } from "../product/paths.ts";
import {
  applyIntegrationConfig,
  type IntegrationSetupOptions,
  type IntegrationSetupResult,
  type IntegrationTarget,
  isAppInstalled,
  isObject,
  type JsonObject,
  objectSection,
  setupError,
} from "./json-config.ts";

/** Instance id of the Axon provider in T3 Code's `providerInstances`. */
const AXON_INSTANCE_ID = "axon";

/**
 * T3 Code's built-in providers, by default instance id (equal to the driver kind).
 * Claude (`claudeAgent`) stays as the user configured it. ACP Registry agents are
 * user-created instances with no default one, so there is nothing to disable.
 */
export const T3CODE_DISABLED_PROVIDERS = [
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "kiro",
  "pi",
  "muse",
  "fx",
] as const;

export type T3CodeSetupOptions = IntegrationSetupOptions;
export type T3CodeSetupResult = IntegrationSetupResult;

interface ConfigureT3CodeOptions extends T3CodeSetupOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly confirmReplacement?: (configPath: string) => Promise<boolean>;
  readonly detectInstallation?: () => Promise<boolean>;
}

/** Mirrors T3 Code's base directory: `T3CODE_HOME` (with `~` expanded), else `~/.t3`. */
export function defaultT3CodeSettingsPath(environment: NodeJS.ProcessEnv, userHome: string) {
  const configured = environment["T3CODE_HOME"]?.trim();
  const base = !configured
    ? join(userHome, ".t3")
    : configured === "~"
      ? userHome
      : configured.startsWith("~/")
        ? join(userHome, configured.slice(2))
        : resolve(configured);
  return join(base, "userdata", "settings.json");
}

/** Plain values only: T3 Code moves sensitive values to its secret store. */
function axonEnvironment(paths: AxonPaths): JsonObject[] {
  return [
    { name: "PI_CODING_AGENT_DIR", value: paths.pi, sensitive: false },
    { name: "PI_CODING_AGENT_SESSION_DIR", value: paths.piSessions, sensitive: false },
    { name: "PI_MODEL_RECOMMENDER_RPC", value: "1", sensitive: false },
    // T3 Code runs short-lived probes with --offline; Axon must verify online.
    { name: "AXON_IGNORE_OFFLINE", value: "1", sensitive: false },
  ];
}

/** Replaces Axon's variables in place and keeps any others the user added. */
function mergeEnvironment(
  target: IntegrationTarget,
  existing: unknown,
  required: readonly JsonObject[],
): JsonObject[] {
  if (existing === undefined) return [...required];
  if (
    !Array.isArray(existing) ||
    !existing.every((entry) => isObject(entry) && typeof entry["name"] === "string")
  ) {
    throw setupError(
      `${target.app} providerInstances.axon.environment must be an array of named variables; config left unchanged`,
    );
  }
  const byName = new Map(required.map((entry) => [entry["name"], entry]));
  const merged = existing.map((entry) => byName.get(entry["name"]) ?? entry);
  const present = new Set(existing.map((entry) => entry["name"]));
  return [...merged, ...required.filter((entry) => !present.has(entry["name"]))];
}

function mergeT3CodeConfig(target: IntegrationTarget, config: JsonObject, paths: AxonPaths) {
  const instances = objectSection(target, config, "providerInstances", "providerInstances");
  const existing = objectSection(
    target,
    instances,
    AXON_INSTANCE_ID,
    `providerInstances.${AXON_INSTANCE_ID}`,
  );
  const driverConfig = objectSection(
    target,
    existing,
    "config",
    `providerInstances.${AXON_INSTANCE_ID}.config`,
  );
  const axon = {
    ...existing,
    driver: "pi",
    displayName: "Axon",
    enabled: true,
    environment: mergeEnvironment(target, existing["environment"], axonEnvironment(paths)),
    config: {
      ...driverConfig,
      // A config-level `enabled: false` would also disable the instance.
      ...(driverConfig["enabled"] === undefined ? {} : { enabled: true }),
      binaryPath: paths.piWrapper,
    },
  };
  const disabled = Object.fromEntries(
    T3CODE_DISABLED_PROVIDERS.map((id) => {
      const instance = objectSection(target, instances, id, `providerInstances.${id}`);
      return [id, { ...instance, driver: instance["driver"] ?? id, enabled: false }];
    }),
  );
  return {
    replacesAxon: Object.hasOwn(instances, AXON_INSTANCE_ID),
    config: {
      ...config,
      providerInstances: { ...instances, ...disabled, [AXON_INSTANCE_ID]: axon },
    },
  };
}

/**
 * Adds Axon to T3 Code as a Pi provider run through the `axon-pi` wrapper, and turns
 * off the other built-in providers except Claude. T3 Code reloads the file itself.
 */
export async function configureT3Code(
  options: ConfigureT3CodeOptions = {},
): Promise<T3CodeSetupResult> {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const userHome = environment["HOME"] || homedir();
  const target: IntegrationTarget = {
    app: "T3 Code",
    setupCommand: "axon setup t3code",
    configPath: resolve(cwd, options.config ?? defaultT3CodeSettingsPath(environment, userHome)),
  };
  const paths = resolveAxonPaths(environment, userHome);

  return applyIntegrationConfig({
    ...options,
    target,
    emptyConfig: {},
    detectInstallation:
      options.detectInstallation ??
      (() =>
        isAppInstalled({
          command: "t3",
          appExecutables: [
            join("T3 Code.app", "Contents", "MacOS", "T3 Code"),
            join("T3 Code (Beta).app", "Contents", "MacOS", "T3 Code (Beta)"),
          ],
          environment,
          cwd,
          userHome,
        })),
    installRemediation:
      "Install T3 Code, or use --config <path> to select an existing T3 Code settings.json.",
    merge: (config) => mergeT3CodeConfig(target, config, paths),
    ensurePrerequisites: async () => {
      await mkdir(paths.bin, { recursive: true, mode: 0o700 });
      await ensurePiWrapper(paths);
    },
  });
}
