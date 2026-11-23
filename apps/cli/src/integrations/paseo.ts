import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { resolveAxonPaths } from "../product/paths.ts";
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

const DISABLED_PROVIDERS = [
  "pi",
  "opencode",
  "copilot",
  "codex",
  "claude",
  "muse",
  "antigravity",
] as const;

const AXON_TERMINAL_PROFILE = {
  id: "profile_mvt5ic5u_nj5mgc6ucq",
  name: "Axon",
  command: "axon",
  args: ["pi", "{{{prompt}}}"],
};

export type PaseoSetupOptions = IntegrationSetupOptions;
export type PaseoSetupResult = IntegrationSetupResult;

interface ConfigurePaseoOptions extends PaseoSetupOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly confirmReplacement?: (configPath: string) => Promise<boolean>;
  readonly detectInstallation?: () => Promise<boolean>;
}

function mergeTerminalProfiles(daemon: JsonObject): JsonObject[] {
  const profiles = daemon["terminalProfiles"];
  if (profiles === undefined) return [AXON_TERMINAL_PROFILE];
  if (!Array.isArray(profiles) || !profiles.every(isObject)) {
    throw setupError(
      "Paseo daemon.terminalProfiles must be an array of objects; config left unchanged",
    );
  }
  let found = false;
  const merged = profiles.map((profile) => {
    if (profile["id"] !== AXON_TERMINAL_PROFILE.id) return profile;
    found = true;
    return { ...profile, ...AXON_TERMINAL_PROFILE };
  });
  if (!found) merged.push(AXON_TERMINAL_PROFILE);
  return merged;
}

function mergePaseoConfig(
  target: IntegrationTarget,
  config: JsonObject,
  paths: ReturnType<typeof resolveAxonPaths>,
) {
  const section = (parent: JsonObject, key: string, name: string) =>
    objectSection(target, parent, key, name);
  const agents = section(config, "agents", "agents");
  const providers = section(agents, "providers", "agents.providers");
  const existing = providers["axon"];
  const provider = {
    ...(isObject(existing) ? existing : {}),
    extends: "pi",
    enabled: true,
    label: "Axon",
    command: [paths.managedBinary, "pi"],
    env: {
      ...(isObject(existing) && isObject(existing["env"]) ? existing["env"] : {}),
      PI_CODING_AGENT_DIR: paths.pi,
      PI_MODEL_RECOMMENDER_RPC: "1",
      PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
    },
  };
  const features = section(config, "features", "features");
  const daemon = section(config, "daemon", "daemon");
  return {
    replacesAxon: Object.hasOwn(providers, "axon"),
    config: {
      ...config,
      features: {
        ...features,
        dictation: {
          ...section(features, "dictation", "features.dictation"),
          enabled: true,
        },
        voiceMode: {
          ...section(features, "voiceMode", "features.voiceMode"),
          enabled: true,
        },
      },
      pluginsEnabled: true,
      daemon: {
        ...daemon,
        relay: {
          ...section(daemon, "relay", "daemon.relay"),
          enabled: true,
        },
        mcp: {
          ...section(daemon, "mcp", "daemon.mcp"),
          injectIntoAgents: true,
        },
        browserTools: {
          ...section(daemon, "browserTools", "daemon.browserTools"),
          enabled: true,
        },
        enableTerminalAgentHooks: true,
        terminalProfiles: mergeTerminalProfiles(daemon),
      },
      agents: {
        ...agents,
        providers: {
          ...providers,
          ...Object.fromEntries(
            DISABLED_PROVIDERS.map((id) => [
              id,
              { ...section(providers, id, `agents.providers.${id}`), enabled: false },
            ]),
          ),
          axon: provider,
        },
      },
    },
  };
}

/** Configure Axon and its Paseo defaults; models and unrelated profiles remain user-owned. */
export async function configurePaseo(
  options: ConfigurePaseoOptions = {},
): Promise<PaseoSetupResult> {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const userHome = environment["HOME"] || homedir();
  const target: IntegrationTarget = {
    app: "Paseo",
    setupCommand: "axon setup paseo",
    configPath: resolve(cwd, options.config ?? join(userHome, ".paseo", "config.json")),
  };
  const paths = resolveAxonPaths(environment, userHome);

  return applyIntegrationConfig({
    ...options,
    target,
    emptyConfig: { version: 1 },
    detectInstallation:
      options.detectInstallation ??
      (() =>
        isAppInstalled({
          command: "paseo",
          appExecutables: [join("Paseo.app", "Contents", "Resources", "bin", "paseo")],
          environment,
          cwd,
          userHome,
        })),
    installRemediation: "Install Paseo, or use --config <path> to select an existing Paseo config.",
    merge: (config) => mergePaseoConfig(target, config, paths),
  });
}
