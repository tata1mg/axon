import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { BUILD_INFO } from "../build-info.ts";
import { PRODUCT_IDENTITY } from "./identity.ts";
import { releaseStateHome } from "./release-channel.ts";

export interface AxonPaths {
  readonly home: string;
  /** Present for project-scoped launches; shared authentication and runtimes remain global. */
  readonly projectDirectory?: string;
  readonly piSessionDirectory?: string;
  readonly sharedAuthDirectory: string;
  readonly sharedAuthFile: string;
  readonly sharedAuthLock: string;
  readonly bin: string;
  readonly managedBinary: string;
  readonly previousBinary: string;
  readonly runtime: string;
  readonly runtimeCurrent: string;
  readonly pi: string;
  readonly piSessions: string;
  readonly piPackageState: string;
  readonly piPackageLock: string;
  readonly piInstallLock: string;
  readonly piRuntime: string;
  readonly piExecutableState: string;
  readonly piMcpSyncState: string;
  readonly materializationLock: string;
  readonly staged: string;
  readonly stagedBinary: string;
  readonly stagedMetadata: string;
  readonly locks: string;
  readonly launcherState: string;
  readonly updateState: string;
  readonly holdState: string;
}

export function resolveAxonPaths(
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = environment["HOME"] || process.env["HOME"] || homedir(),
): AxonPaths {
  const configuredHome = environment[PRODUCT_IDENTITY.homeEnvironmentVariable]?.trim();
  const home = resolve(configuredHome || join(userHome, PRODUCT_IDENTITY.defaultHomeDirectoryName));
  // Authentication belongs to the OS user, never to AXON_HOME or a project.
  const sharedAuthDirectory = resolve(userHome, PRODUCT_IDENTITY.sharedAuthDirectoryName);
  const bin = join(home, "bin");
  const stateHome =
    BUILD_INFO.kind === "binary" ? releaseStateHome(home, BUILD_INFO.version) : home;
  const runtime = join(stateHome, "runtime");
  const pi = join(stateHome, "pi");
  // Conversations are shared across release channels; only settings, packages and runtimes are isolated.
  const piSessions = join(home, "pi", "sessions");
  const locks = join(home, "locks");
  const staged = join(home, "staged");

  return Object.freeze({
    home,
    sharedAuthDirectory,
    sharedAuthFile: join(sharedAuthDirectory, PRODUCT_IDENTITY.sharedAuthFileName),
    sharedAuthLock: join(sharedAuthDirectory, "locks", "session.lock"),
    bin,
    managedBinary: join(bin, PRODUCT_IDENTITY.command),
    previousBinary: join(bin, `${PRODUCT_IDENTITY.command}.prev`),
    runtime,
    runtimeCurrent: join(runtime, "current"),
    pi,
    piSessions,
    piPackageState: join(stateHome, "pi-packages.json"),
    piPackageLock: join(locks, "pi-packages.lock"),
    piInstallLock: join(locks, "pi-install.lock"),
    piRuntime: join(stateHome, "pi-runtime"),
    piExecutableState: join(stateHome, "pi-executable.json"),
    piMcpSyncState: join(stateHome, "pi-mcp-sync.json"),
    materializationLock: join(locks, "materialization.lock"),
    staged,
    stagedBinary: join(staged, PRODUCT_IDENTITY.command),
    stagedMetadata: join(staged, "meta.json"),
    locks,
    launcherState: join(home, "state.json"),
    updateState: join(home, "update.json"),
    holdState: join(home, "hold.json"),
  });
}
