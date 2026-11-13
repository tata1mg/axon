import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { projectSessionDirectory } from "../axon-safehouse/session-paths.ts";
import { sha256 } from "../hash.ts";
import type { AxonPaths } from "./paths.ts";

/** Keep nested repositories and Git worktrees separate, but share settings within a checkout. */
export async function resolveProjectDirectory(cwd: string): Promise<string> {
  const directory = await realpath(cwd);
  let candidate = directory;
  while (true) {
    try {
      const marker = await lstat(join(candidate, ".git"));
      if (marker.isDirectory() || marker.isFile()) return candidate;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return directory;
    candidate = parent;
  }
}

export function projectConfigurationKey(project: string): string {
  return sha256(project);
}

/** Scope mutable Pi configuration without moving shared login, binaries or conversation storage. */
export async function resolveProjectAxonPaths(paths: AxonPaths, cwd: string): Promise<AxonPaths> {
  const projectDirectory = await resolveProjectDirectory(cwd);
  const key = projectConfigurationKey(projectDirectory);
  // The global Pi root already selects stable or isolated beta state.
  const directory = join(dirname(paths.pi), "projects", key);
  return Object.freeze({
    ...paths,
    projectDirectory,
    pi: join(directory, "pi"),
    piSessionDirectory: projectSessionDirectory(paths, await realpath(cwd)),
    piPackageState: join(directory, "pi-packages.json"),
    piPackageLock: join(paths.locks, `pi-packages-${key}.lock`),
  });
}
