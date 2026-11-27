import { join } from "node:path";

import { processLogFile } from "../../logging/logger.ts";
import type { AxonPaths } from "../../product/paths.ts";

export function printPaths(paths: AxonPaths): void {
  const entries = [
    ["home", paths.home],
    ["logs", join(paths.home, "logs")],
    ["current process log", processLogFile(paths)],
    ["shared authentication file", paths.sharedAuthFile],
    ["shared authentication lock", paths.sharedAuthLock],
    ["managed binary", paths.managedBinary],
    ["previous binary", paths.previousBinary],
    ["Pi wrapper", paths.piWrapper],
    ["runtime", paths.runtime],
    ["active runtime", paths.runtimeCurrent],
    ["Pi agent directory", paths.pi],
    ["Pi session directory", paths.piSessions],
    ["Pi package state", paths.piPackageState],
    ["Pi package lock", paths.piPackageLock],
    ["staged binary", paths.stagedBinary],
    ["staged metadata", paths.stagedMetadata],
    ["locks", paths.locks],
    ["launcher state", paths.launcherState],
    ["update state", paths.updateState],
    ["rollback hold", paths.holdState],
  ] as const;

  for (const [label, path] of entries) {
    console.log(`${label}: ${path}`);
  }
}
