import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";

import type { AxonPaths } from "../product/paths.ts";
import { type AxonSafehousePolicy, axonSafehouseFailure } from "./policy.ts";

const PROTECTED_HOME_PATHS = [
  ".deputydev",
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gcloud",
  ".config/gh",
  ".config/nix",
  ".git-credentials",
  ".gitconfig",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "Library/Keychains",
];

export const PI_STATE_FILES = [
  "auth.json",
  "settings.json",
  "trust.json",
  "models.json",
  "models-store.json",
  "litellm-models-dev.json",
  "axon-changelog.json",
] as const;
// Agent definitions are user-owned persistent data, not executable extension packages.
export const PI_STATE_DIRECTORIES = ["sessions", "pi-org-telemetry", "agents"] as const;
export type FilesystemOperation = "allow-read" | "allow-write" | "deny" | "revoke" | "mode";

const pathList = z.array(z.string().min(1).max(4096)).max(64);
export const filesystemPreferencesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectMode: z.enum(["read-only", "read-write"]),
  readPaths: pathList,
  writePaths: pathList,
  denyPaths: pathList,
});
export type FilesystemPreferences = z.infer<typeof filesystemPreferencesSchema>;

// Parent-owned memory only: never read legacy profiles or share grants with another Axon process.
const invocationPreferences = new Map<string, FilesystemPreferences>();
const preferenceListeners = new Map<string, Set<() => void>>();
const preferenceRevisions = new Map<string, number>();

export function filesystemPreferencesRevision(paths: AxonPaths): number {
  return preferenceRevisions.get(paths.home) ?? 0;
}

export function watchFilesystemPreferences(paths: AxonPaths, changed: () => void): () => void {
  let listeners = preferenceListeners.get(paths.home);
  if (!listeners) {
    listeners = new Set();
    preferenceListeners.set(paths.home, listeners);
  }
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
    if (!listeners.size) preferenceListeners.delete(paths.home);
  };
}

function commitFilesystemPreferences(
  paths: AxonPaths,
  key: string,
  preferences: FilesystemPreferences,
): void {
  // Revoke active operations before publishing the new permissions.
  for (const changed of preferenceListeners.get(paths.home) ?? []) changed();
  invocationPreferences.set(key, structuredClone(preferences));
  preferenceRevisions.set(paths.home, filesystemPreferencesRevision(paths) + 1);
}

export function isWithin(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

/** Resolve symlinks, including existing ancestors of not-yet-created deny targets. */
export async function canonicalPath(path: string, cwd = process.cwd()): Promise<string> {
  if (
    Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw axonSafehouseFailure("Invalid filesystem permission path");
  }
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  let existing = resolve(cwd, expanded);
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(existing), ...suffix);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(relative(parent, existing));
      existing = parent;
    }
  }
}

export async function filesystemPreferencesPath(paths: AxonPaths, cwd: string): Promise<string> {
  const project = await canonicalPath(cwd);
  const key = createHash("sha256").update(project).digest("hex");
  return join(paths.home, "axon-safehouse", "filesystem", `${key}.json`);
}

export async function readFilesystemPreferences(
  paths: AxonPaths,
  cwd: string,
): Promise<FilesystemPreferences> {
  const value = invocationPreferences.get(await filesystemPreferencesPath(paths, cwd));
  if (value === undefined) {
    return {
      schemaVersion: 1,
      projectMode: "read-write",
      readPaths: [],
      writePaths: [],
      denyPaths: [],
    };
  }
  const parsed = filesystemPreferencesSchema.safeParse(value);
  if (!parsed.success) throw axonSafehouseFailure("Local filesystem permissions are invalid");
  return parsed.data;
}

export async function protectedFilesystemPaths(
  paths: AxonPaths,
  policy?: AxonSafehousePolicy,
): Promise<string[]> {
  const backendPaths = (policy?.protectedPaths ?? []).map((path) => {
    if (!isAbsolute(path) && !path.startsWith("~/"))
      throw axonSafehouseFailure("Backend protected paths must be absolute or home-relative");
    return path;
  });
  return Promise.all(
    [
      paths.sharedAuthDirectory,
      paths.bin,
      paths.staged,
      paths.locks,
      join(paths.home, "axon-safehouse", "filesystem"),
      ...PROTECTED_HOME_PATHS.map((path) => join(homedir(), path)),
      ...backendPaths,
    ].map((path) => canonicalPath(path)),
  );
}

/** Home, filesystem roots and Axon storage can never become a project. */
export async function isBlockedProjectDirectory(paths: AxonPaths, cwd: string): Promise<boolean> {
  const project = await canonicalPath(cwd);
  const home = await canonicalPath(homedir());
  const axonHome = await canonicalPath(paths.home);
  return (
    project === parse(project).root ||
    isWithin(project, home) ||
    isWithin(project, axonHome) ||
    isWithin(axonHome, project)
  );
}

/** A project profile can grant many repositories, but never the whole home or managed storage. */
export async function validateFilesystemProject(paths: AxonPaths, cwd: string): Promise<string> {
  const project = await canonicalPath(cwd);
  if (await isBlockedProjectDirectory(paths, project))
    throw axonSafehouseFailure(
      "Choose a project directory, not a home, system root or Axon runtime directory",
    );
  if (!(await lstat(project)).isDirectory())
    throw axonSafehouseFailure("The project must be a directory");
  return project;
}

export async function validateFilesystemPreferences(
  paths: AxonPaths,
  cwd: string,
  value: FilesystemPreferences,
  policy?: AxonSafehousePolicy,
): Promise<FilesystemPreferences> {
  const project = await validateFilesystemProject(paths, cwd);
  const preferences = filesystemPreferencesSchema.parse(value);
  if (
    (policy?.allowAdditionalReadPaths === false && preferences.readPaths.length > 0) ||
    (policy?.allowAdditionalWritePaths === false && preferences.writePaths.length > 0)
  )
    throw axonSafehouseFailure("Backend policy does not permit these additional filesystem grants");
  const home = await canonicalPath(homedir());
  const axonHome = await canonicalPath(paths.home);
  const protectedPaths = await protectedFilesystemPaths(paths, policy);
  const essentialPaths = await Promise.all(
    [
      ...PI_STATE_DIRECTORIES.map((directory) => join(paths.pi, directory)),
      ...PI_STATE_FILES.flatMap((filename) => [
        join(paths.pi, filename),
        join(paths.pi, `${filename}.lock`),
      ]),
    ].map((path) => canonicalPath(path)),
  );
  const assigned = new Set<string>();
  for (const key of ["readPaths", "writePaths", "denyPaths"] as const) {
    preferences[key] = [
      ...new Set(await Promise.all(preferences[key].map((path) => canonicalPath(path, project)))),
    ];
    for (const path of preferences[key]) {
      if (assigned.has(path)) throw axonSafehouseFailure(`Assign only one access mode to ${path}`);
      assigned.add(path);
      if (key === "denyPaths") {
        if (
          essentialPaths.some((essential) => isWithin(path, essential) || isWithin(essential, path))
        )
          throw axonSafehouseFailure(
            "Essential Pi state cannot be denied; choose a narrower project path",
          );
        continue;
      }
      if (
        path === parse(path).root ||
        isWithin(path, home) ||
        isWithin(path, axonHome) ||
        isWithin(axonHome, path)
      )
        throw axonSafehouseFailure(
          "Filesystem grants cannot include home roots or Axon-managed storage",
        );
      if (protectedPaths.some((protectedPath) => isWithin(protectedPath, path)))
        throw axonSafehouseFailure(`This path is protected: ${path}`);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error) {
        // A granted path deleted after approval (a cleaned build directory, say) grants
        // nothing until it is recreated; it must not break every later profile compile.
        // New grants are checked for existence when they are added.
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile() && !info.isDirectory())
        throw axonSafehouseFailure("Grant only regular files or directories");
    }
  }
  // Match the shared JSON reader's size bound so saved profiles can always be read back.
  if (Buffer.byteLength(JSON.stringify(preferences)) + 1 > 64 * 1024)
    throw axonSafehouseFailure("Filesystem permission profile exceeds the 64 KiB limit");
  // A parent directory grant still excludes any protected descendants at policy generation.
  return preferences;
}

export async function editFilesystemPreferences(
  paths: AxonPaths,
  cwd: string,
  preferences: FilesystemPreferences,
  operation: FilesystemOperation,
  value: string | readonly string[],
  policy?: AxonSafehousePolicy,
): Promise<FilesystemPreferences> {
  const next = filesystemPreferencesSchema.parse(preferences);
  if (operation === "mode") {
    next.projectMode = z.enum(["read-only", "read-write"]).parse(value);
  } else {
    const values = typeof value === "string" ? [value] : value;
    if (!values.length || values.some((path) => !path))
      throw axonSafehouseFailure("A path is required");
    for (const entry of values) {
      const path = await canonicalPath(entry, cwd);
      if (operation === "allow-read" || operation === "allow-write") {
        try {
          await lstat(path);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            throw axonSafehouseFailure(`This path does not exist: ${path}`);
          throw error;
        }
      }
      for (const key of ["readPaths", "writePaths", "denyPaths"] as const)
        next[key] = next[key].filter((existing) => existing !== path);
      if (operation === "allow-read") next.readPaths.push(path);
      else if (operation === "allow-write") next.writePaths.push(path);
      else if (operation === "deny") next.denyPaths.push(path);
    }
  }
  return validateFilesystemPreferences(paths, cwd, next, policy);
}

/** Commit a reviewed draft to this process only; never overwrite a stale editor's changes. */
export async function saveFilesystemPreferences(
  paths: AxonPaths,
  cwd: string,
  preferences: FilesystemPreferences,
  expected?: FilesystemPreferences,
  policy?: AxonSafehousePolicy,
): Promise<FilesystemPreferences> {
  const destination = await filesystemPreferencesPath(paths, cwd);
  const revision = filesystemPreferencesRevision(paths);
  const current = await readFilesystemPreferences(paths, cwd);
  if (expected && JSON.stringify(current) !== JSON.stringify(expected))
    throw axonSafehouseFailure("Filesystem permissions changed; reopen the editor before saving");
  const validated = await validateFilesystemPreferences(paths, cwd, preferences, policy);
  // Editors review canonical paths. A replaced symlink must not silently redirect an approval.
  if (JSON.stringify(validated) !== JSON.stringify(preferences))
    throw axonSafehouseFailure(
      "Filesystem paths changed since review; reopen the editor before saving",
    );
  if (filesystemPreferencesRevision(paths) !== revision)
    throw axonSafehouseFailure("Filesystem permissions changed; reopen the editor before saving");
  commitFilesystemPreferences(paths, destination, validated);
  return validated;
}
