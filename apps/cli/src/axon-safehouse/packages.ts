import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalPath, isWithin } from "./filesystem.ts";

// Match path components, including dependency trees created after policy compilation.
// Do not match a generic "packages" directory: monorepos keep editable source there.
const PACKAGE_PATH_PATTERNS = [
  "/(node_modules|[.]venv|venv|__pypackages__|site-packages|dist-packages|vendor|bower_components)(/|$)",
  "/[.]pi/(npm|git|bin|extensions)(/|$)",
  "/[.]yarn/(cache|unplugged)(/|$)",
  "/[.]pnp[.](cjs|loader[.]mjs)$",
];
const PACKAGE_PATH_MATCHERS = PACKAGE_PATH_PATTERNS.map((pattern) => new RegExp(pattern));
export const PACKAGE_WRITE_FILTERS = PACKAGE_PATH_PATTERNS.map(
  (pattern) => `(regex #${JSON.stringify(pattern)})`,
);

const SYSTEM_PACKAGE_PATHS = [
  "/Applications",
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
  "/System",
  "/nix/store",
  "/Library/Apple",
  "/Library/Developer",
  "/Library/Frameworks",
  "/Library/Java",
  "/Library/Perl",
  "/Library/Python",
  "/Library/Ruby",
  "/Library/R",
  "/private/var/db/receipts",
  "/private/var/db/pkg",
  "/private/var/lib/dpkg",
  "/private/var/lib/rpm",
];
const HOME_PACKAGE_PATHS = [
  ".local/bin",
  ".local/lib",
  ".local/pipx/venvs",
  ".local/share/pipx/venvs",
  ".local/share/uv/tools",
  ".local/share/claude",
  ".claude/local",
  ".claude/plugins",
  ".local/share/pnpm",
  ".local/share/fnm/node-versions",
  ".bun/bin",
  ".bun/install/global",
  ".npm-global",
  ".nvm/versions",
  ".fnm/node-versions",
  ".volta/tools",
  ".asdf/installs",
  ".pyenv/versions",
  ".conda/envs",
  ".local/share/mamba/envs",
  "anaconda3",
  "miniconda3",
  "miniforge3",
  "mambaforge",
  ".rbenv/versions",
  ".gem",
  ".cargo/bin",
  ".cargo/registry",
  ".cargo/git",
  ".rustup/toolchains",
  ".luarocks",
  "go/bin",
  "go/pkg",
  "Applications",
  "Library/pnpm",
  "Library/Python",
  "Library/R",
  "Library/Java/JavaVirtualMachines",
];

// Axon Safehouse runs as the same user, so a directory this scan cannot read or resolve
// is equally inaccessible to its tools. Skip it instead of failing the launch.
const SKIPPED_SCAN_ERRORS = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"]);

function skippableScanError(error: unknown): boolean {
  return error instanceof Error && "code" in error && SKIPPED_SCAN_ERRORS.has(String(error.code));
}

/** Resolve existing project dependency roots without descending into installed trees. */
async function projectPackagePaths(roots: readonly string[]): Promise<string[]> {
  const packages = new Set<string>();
  const visited = new Set<string>();
  const directories: string[] = [];
  for (const root of roots) {
    try {
      const path = await canonicalPath(root);
      if ((await lstat(path)).isDirectory()) directories.push(path);
    } catch (error) {
      if (!skippableScanError(error)) throw error;
    }
  }
  while (directories.length) {
    const directory = directories.pop();
    if (!directory || visited.has(directory)) continue;
    visited.add(directory);
    if (PACKAGE_PATH_MATCHERS.some((matcher) => matcher.test(directory))) {
      packages.add(await canonicalPath(directory));
      continue;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // Removed or unreadable directories cannot contain an accessible dependency tree.
      if (skippableScanError(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if ([".git", ".hg", ".svn"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (PACKAGE_PATH_MATCHERS.some((matcher) => matcher.test(path))) {
        // Keep the canonical target protected even when a dependency root is a symlink.
        try {
          packages.add(await canonicalPath(path));
        } catch (error) {
          if (!skippableScanError(error)) throw error;
        }
      } else if (entry.isDirectory()) {
        // Do not follow arbitrary project symlinks into unrelated home/system trees.
        directories.push(path);
      }
    }
  }
  return [...packages];
}

/**
 * Package links and user-installed command links must not expose writable targets.
 * Links into the user's own editable trees (workspace packages such as
 * node_modules/@org/lib -> packages/lib, or a self-reference) are source, not
 * installed code, so they stay governed by the project and grant rules.
 */
async function linkedPackagePaths(
  paths: readonly string[],
  editableRoots: readonly string[],
): Promise<string[]> {
  const targets = new Set<string>();
  const directories = [...paths];
  while (directories.length) {
    const directory = directories.pop();
    if (!directory) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (skippableScanError(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await canonicalPath(path);
        } catch (error) {
          if (skippableScanError(error)) continue;
          throw error;
        }
        const editableSource =
          !PACKAGE_PATH_MATCHERS.some((matcher) => matcher.test(target)) &&
          editableRoots.some((root) => isWithin(root, target) || isWithin(target, root));
        if (!editableSource) targets.add(target);
      }
      // Scoped npm packages have one extra directory level before package links.
      else if (entry.isDirectory() && entry.name.startsWith("@")) directories.push(path);
    }
  }
  return [...targets];
}

async function scanInstalledPackagePaths(
  home: string,
  projects: readonly string[],
): Promise<string[]> {
  const paths = [
    ...SYSTEM_PACKAGE_PATHS,
    ...HOME_PACKAGE_PATHS.map((path) => join(home, path)),
    ...(await projectPackagePaths(projects)),
  ];
  const canonical = [...new Set(await Promise.all(paths.map((path) => canonicalPath(path))))];
  const editableRoots: string[] = [];
  for (const project of projects) {
    try {
      editableRoots.push(await canonicalPath(project));
    } catch (error) {
      if (!skippableScanError(error)) throw error;
    }
  }
  const packages = [
    ...new Set([...canonical, ...(await linkedPackagePaths(canonical, editableRoots))]),
  ];
  // A parent package store already protects its descendants; avoid repeating
  // those exclusions in every generated Seatbelt grant.
  return packages.filter(
    (path) => !packages.some((otherPath) => otherPath !== path && isWithin(otherPath, path)),
  );
}

/** Per-invocation memo of package scans; cleared whenever Axon Safehouse settings change. */
export type PackageScanCache = Map<string, Promise<readonly string[]>>;

/**
 * Conventional global stores plus canonical dependency roots in granted project trees.
 * Walking a large project is expensive, so callers may share one scan per root set.
 * Dependency trees created later are still caught by PACKAGE_WRITE_FILTERS.
 */
export async function installedPackagePaths(
  home: string,
  projects: readonly string[],
  cache?: PackageScanCache,
): Promise<string[]> {
  if (!cache) return scanInstalledPackagePaths(home, projects);
  const key = JSON.stringify([home, [...new Set(projects)].sort()]);
  let pending = cache.get(key);
  if (!pending) {
    pending = scanInstalledPackagePaths(home, projects);
    cache.set(key, pending);
    // Never memoize a failed scan for the rest of the invocation.
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
  }
  return [...(await pending)];
}
