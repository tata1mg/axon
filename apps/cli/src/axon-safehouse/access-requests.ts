import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import * as prompts from "@clack/prompts";

import type { AxonSafehouseMenuUI } from "../cli/commands/axon-safehouse.ts";
import type { AxonPaths } from "../product/paths.ts";
import {
  canonicalPath,
  editFilesystemPreferences,
  type FilesystemPreferences,
  filesystemPreferencesRevision,
  isWithin,
  protectedFilesystemPaths,
  readFilesystemPreferences,
  saveFilesystemPreferences,
} from "./filesystem.ts";
import { installedPackagePaths, isPackageWriteProtectedPath } from "./packages.ts";
import type { AxonSafehousePolicy } from "./policy.ts";

const REQUEST_LIFETIME_MS = 10 * 60_000;
const MAX_REQUESTS = 64;
const DENIED_ACCESS = /\b(?:EACCES|EPERM|permission denied|operation not permitted)\b/i;
interface AccessRequest {
  readonly id: string;
  readonly home: string;
  readonly project: string;
  readonly requestedPath: string;
  readonly path: string;
  readonly tool: string;
  readonly revision: number;
  readonly expiresAt: number;
  readonly projectModeChange: boolean;
}

// Approval endpoints accept only opaque IDs; the parent owns and validates every review scope.
const requests = new Map<string, AccessRequest>();

/** Only inspect error diagnostics, never successful file contents or command stdout. */
export function deniedFilesystemPaths(diagnostic: string): string[] {
  const paths = new Set<string>();
  for (const line of diagnostic.slice(0, 64 * 1024).split("\n")) {
    if (!DENIED_ACCESS.test(line)) continue;
    // Node/Python diagnostics quote the path; common Unix tools put it before the error.
    for (const match of line.matchAll(/['"]([^'"\n]+)['"]/g)) {
      if (match[1]) paths.add(match[1]);
    }
    const unix = /^(?:[^:\n]+: )?(.+?): (?:[Pp]ermission denied|[Oo]peration not permitted)\b/.exec(
      line,
    );
    if (unix?.[1]) paths.add(unix[1]);
    if (paths.size >= 8) break;
  }
  return [...paths].slice(0, 8);
}

async function draftForAccess(
  paths: AxonPaths,
  request: AccessRequest,
  original: FilesystemPreferences,
  mode: "allow-read" | "allow-write",
  policy: AxonSafehousePolicy,
): Promise<FilesystemPreferences> {
  if ((await canonicalPath(request.path)) !== request.path)
    throw new Error("This filesystem path changed since review; retry the operation");
  if (request.projectModeChange) {
    if (mode !== "allow-write") throw new Error("This project already has read-only access");
    return editFilesystemPreferences(
      paths,
      request.project,
      original,
      "mode",
      "read-write",
      policy,
    );
  }
  return editFilesystemPreferences(paths, request.project, original, mode, request.path, policy);
}

/** Record a bounded, canonical proposal only after an operation reports a filesystem denial. */
export async function createFilesystemAccessRequest(options: {
  readonly paths: AxonPaths;
  readonly project: string;
  readonly cwd: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly diagnostic: string;
  readonly authorize: () => Promise<AxonSafehousePolicy>;
}): Promise<string | undefined> {
  if (!DENIED_ACCESS.test(options.diagnostic)) return undefined;
  const policy = await options.authorize();
  for (const [id, request] of requests) {
    if (request.expiresAt <= Date.now()) requests.delete(id);
  }
  const project = await canonicalPath(options.project);
  const original = await readFilesystemPreferences(options.paths, project);
  const protectedPaths = await protectedFilesystemPaths(options.paths, policy);
  const explicitPath = options.input["path"];
  const candidates = [
    ...deniedFilesystemPaths(options.diagnostic),
    ...(options.tool !== "shell" && typeof explicitPath === "string" ? [explicitPath] : []),
  ];
  for (const candidate of candidates) {
    try {
      const requestedPath = await canonicalPath(candidate, options.cwd);
      // Explicit human denials must be changed deliberately in /safehouse, not by a tool retry.
      if (
        [...protectedPaths, ...original.denyPaths].some((denied) => isWithin(denied, requestedPath))
      )
        continue;
      let path = requestedPath;
      // Creating a file requires its directory. Show the actual existing grant scope to the user.
      while (true) {
        try {
          await lstat(path);
          break;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          const parent = dirname(path);
          if (parent === path) throw error;
          path = parent;
        }
      }
      const projectModeChange =
        original.projectMode === "read-only" && isWithin(project, requestedPath);
      if (projectModeChange) path = project;
      else {
        // A narrower write grant cannot override a read-only ancestor. Review the real scope.
        const readOnlyAncestor = original.readPaths
          .filter((entry) => isWithin(entry, requestedPath))
          .sort((left, right) => left.length - right.length)[0];
        if (readOnlyAncestor) path = readOnlyAncestor;
      }
      const request: AccessRequest = {
        id: randomUUID(),
        home: options.paths.home,
        project,
        requestedPath,
        path,
        tool: options.tool.replace(/\p{Cc}/gu, "?"),
        revision: filesystemPreferencesRevision(options.paths),
        expiresAt: Date.now() + REQUEST_LIFETIME_MS,
        projectModeChange,
      };
      const modes = await availableModes(options.paths, request, original, policy);
      if (modes.length === 0) continue;
      for (const existing of requests.values()) {
        if (
          existing.home === request.home &&
          existing.project === project &&
          existing.path === path &&
          existing.revision === request.revision
        )
          return existing.id;
      }
      while (requests.size >= MAX_REQUESTS) {
        const oldest = requests.keys().next().value;
        if (oldest === undefined) break;
        requests.delete(oldest);
      }
      requests.set(request.id, request);
      return request.id;
    } catch {
      // Unparseable, protected, missing or unsupported paths remain denied; never guess a wider grant.
    }
  }
  return undefined;
}

async function availableModes(
  paths: AxonPaths,
  request: AccessRequest,
  original: FilesystemPreferences,
  policy: AxonSafehousePolicy,
): Promise<("allow-read" | "allow-write")[]> {
  const modes: ("allow-read" | "allow-write")[] = [];
  for (const mode of ["allow-read", "allow-write"] as const) {
    if (mode === "allow-write" && isPackageWriteProtectedPath(request.requestedPath)) continue;
    try {
      const draft = await draftForAccess(paths, request, original, mode, policy);
      if (
        mode === "allow-write" &&
        draft.readPaths.some((path) => isWithin(path, request.requestedPath))
      )
        continue;
      if (JSON.stringify(draft) !== JSON.stringify(original)) modes.push(mode);
    } catch {
      // Backend restrictions decide which choices exist, not child-supplied UI data.
    }
  }
  if (modes.includes("allow-write")) {
    // Reject invalid/home/root grants before scanning. Never walk a denied external tree just
    // to offer a prompt; scan only the current project/grants and known global package roots.
    const packagePaths = await installedPackagePaths(homedir(), [
      request.project,
      ...original.readPaths,
      ...original.writePaths,
    ]);
    if (packagePaths.some((path) => isWithin(path, request.requestedPath)))
      return modes.filter((mode) => mode !== "allow-write");
  }
  return modes;
}

export function hasFilesystemAccessRequest(paths: AxonPaths, id: string): boolean {
  const request = requests.get(id);
  return request?.home === paths.home && request.expiresAt > Date.now();
}

/** Approval input and grant validation remain parent-owned, including during an active tool. */
export async function runFilesystemAccessPrompt(
  paths: AxonPaths,
  cwd: string,
  id: string,
  ui: AxonSafehouseMenuUI,
  options: {
    readonly signal: AbortSignal;
    readonly authorize: () => Promise<AxonSafehousePolicy>;
    readonly beforeSave?: () => Promise<void>;
    readonly liveGrant?: boolean;
  },
): Promise<boolean> {
  const request = requests.get(id);
  requests.delete(id); // A late or replayed dialog cannot reuse an approval.
  if (
    !request ||
    request.home !== paths.home ||
    request.project !== (await canonicalPath(cwd)) ||
    request.expiresAt <= Date.now() ||
    request.revision !== filesystemPreferencesRevision(paths)
  )
    throw new Error("This access request expired or permissions changed; retry the operation");
  options.signal.throwIfAborted();
  const original = await readFilesystemPreferences(paths, cwd);
  const policy = await options.authorize();
  const modes = await availableModes(paths, request, original, policy);
  if (!modes.length)
    throw new Error("This path cannot be granted under the current Safehouse policy");
  ui.intro("Axon Safehouse · blocked path");
  ui.note(
    [
      `${request.tool} reported denied filesystem access to: ${request.requestedPath}`,
      `Permission scope: ${request.path}`,
      ...(request.projectModeChange
        ? ["This changes access for the entire read-only project."]
        : []),
      "Directory grants include their contents, except protected or blocked paths.",
      "Permissions last only until this Axon process exits.",
      options.liveGrant
        ? "Your task will continue in this chat. Reads can retry; commands and edits are not automatically replayed."
        : "Applying permissions restarts Pi and resumes this chat. The operation is NOT rerun automatically.",
    ].join("\n"),
    "Allow access to this path?",
  );
  const choice = await ui.select<"no" | "allow-read" | "allow-write">({
    signal: options.signal,
    message: "Add this path to your Safehouse policy for this session?",
    initialValue: "no",
    options: [
      { value: "no", label: "No — keep this path blocked" },
      ...modes.map((mode) => ({
        value: mode,
        label: mode === "allow-read" ? "Yes — allow read-only" : "Yes — allow read and write",
        hint:
          mode === "allow-read"
            ? "inspect without changing files"
            : "edit, create and delete files",
      })),
    ],
  });
  if (prompts.isCancel(choice) || choice === "no") {
    ui.outro("Access was not granted. Your chat and permissions are unchanged.");
    return false;
  }
  if (!modes.includes(choice)) throw new Error("Invalid filesystem access choice");
  options.signal.throwIfAborted();
  if (request.expiresAt <= Date.now()) throw new Error("This filesystem access request expired");
  const currentPolicy = await options.authorize();
  if (!(await availableModes(paths, request, original, currentPolicy)).includes(choice))
    throw new Error("This filesystem access choice is no longer permitted");
  const draft = await draftForAccess(paths, request, original, choice, currentPolicy);
  await options.beforeSave?.();
  options.signal.throwIfAborted();
  await saveFilesystemPreferences(paths, cwd, draft, original, currentPolicy, {
    liveGrant: options.liveGrant === true,
    signal: options.signal,
  });
  ui.outro(
    options.liveGrant
      ? "Access granted for this Axon session. Continuing your task."
      : "Access granted for this Axon session. Resuming your chat; retry the operation when ready.",
  );
  return true;
}
