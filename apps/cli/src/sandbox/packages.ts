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
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
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
      // A concurrently removed directory cannot contain an accessible dependency tree.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if ([".git", ".hg", ".svn"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (PACKAGE_PATH_MATCHERS.some((matcher) => matcher.test(path))) {
        // Keep the canonical target protected even when a dependency root is a symlink.
        packages.add(await canonicalPath(path));
      } else if (entry.isDirectory()) {
        // Do not follow arbitrary project symlinks into unrelated home/system trees.
        directories.push(path);
      }
    }
  }
  return [...packages];
}

/** Package links and user-installed command links must not expose writable targets. */
async function linkedPackagePaths(paths: readonly string[]): Promise<string[]> {
  const targets = new Set<string>();
  const directories = [...paths];
  while (directories.length) {
    const directory = directories.pop();
    if (!directory) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) targets.add(await canonicalPath(path));
      // Scoped npm packages have one extra directory level before package links.
      else if (entry.isDirectory() && entry.name.startsWith("@")) directories.push(path);
    }
  }
  return [...targets];
}

/** Conventional global stores plus canonical dependency roots in granted project trees. */
export async function installedPackagePaths(
  home: string,
  projects: readonly string[],
): Promise<string[]> {
  const paths = [
    ...SYSTEM_PACKAGE_PATHS,
    ...HOME_PACKAGE_PATHS.map((path) => join(home, path)),
    ...(await projectPackagePaths(projects)),
  ];
  const canonical = [...new Set(await Promise.all(paths.map((path) => canonicalPath(path))))];
  const packages = [...new Set([...canonical, ...(await linkedPackagePaths(canonical))])];
  // A parent package store already protects its descendants; avoid repeating
  // those exclusions in every generated Seatbelt grant.
  return packages.filter(
    (path) => !packages.some((otherPath) => otherPath !== path && isWithin(otherPath, path)),
  );
}
