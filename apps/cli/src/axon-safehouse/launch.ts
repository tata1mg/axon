import { rmSync } from "node:fs";
import { lstat, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse } from "node:path";

import { readCertificates } from "../launcher/certificates.ts";
import type { LaunchSpec } from "../launcher/contracts.ts";
import type { AxonPaths } from "../product/paths.ts";
import { privateDirectory } from "../sessions/files.ts";
import { axonSafehouseEnvironment } from "./environment.ts";
import {
  canonicalPath,
  type FilesystemPreferences,
  GIT_USER_PATHS,
  isBlockedProjectDirectory,
  isWithin,
  MCP_STATE_FILES,
  MCP_USER_PATHS,
  PI_STATE_DIRECTORIES,
  PI_STATE_FILES,
  protectedFilesystemPaths,
  readFilesystemPreferences,
  validateFilesystemPreferences,
  validateFilesystemProject,
} from "./filesystem.ts";
import { resolveGitAiBinary } from "./git-ai-binary.ts";
import { type NetworkProxy, startNetworkProxy } from "./package-proxy.ts";
import { installedPackagePaths, PACKAGE_WRITE_FILTERS, type PackageScanCache } from "./packages.ts";
import { type AxonSafehouseAuthorization, axonSafehouseFailure } from "./policy.ts";
import { restrictFilesystemGrants, restrictSafehouseBaseline } from "./profile.ts";
import { ensureSafehouseRuntime, generateSafehousePolicy } from "./runtime.ts";
import { projectSessionDirectory } from "./session-paths.ts";

const SYSTEM_READ_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
  "/System/Library",
  "/System/Volumes/Preboot",
  "/System/Cryptexes",
  "/Library/Apple",
  "/Library/Frameworks",
  "/Library/Developer",
  "/Library/Fonts",
  "/nix/store",
  "/private/var/db/timezone",
  "/private/var/db/dyld",
  "/private/var/select",
  "/private/etc/ssl",
  "/private/etc/ssh",
  "/private/etc/hosts",
  "/private/etc/resolv.conf",
  "/private/etc/services",
  "/private/etc/protocols",
  "/private/etc/localtime",
  "/private/etc/shells",
  "/dev",
];
const SYSTEM_WRITE_PATHS = ["/tmp", "/var"];
const USER_WRITE_PATHS = [".agents", ".claude", ".local/bin", ".paseo"];
const DEVICE_WRITE_PATHS = [
  "/dev/fd",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/null",
  "/dev/tty",
  "/dev/ptmx",
];

function quoted(value: string): string {
  // SBPL string literals share JSON's quote/backslash escaping for valid paths.
  return JSON.stringify(value);
}

function pathRule(operation: string, path: string): string {
  return `(${operation} (subpath ${quoted(path)}))`;
}

function ancestorRules(
  path: string,
  operation: "file-read-metadata" | "file-read*" = "file-read-metadata",
): string[] {
  const rules: string[] = [];
  let ancestor = dirname(path);
  while (true) {
    rules.push(`(allow ${operation} (literal ${quoted(ancestor)}))`);
    const parent = dirname(ancestor);
    if (parent === ancestor) return rules;
    ancestor = parent;
  }
}

async function readGrant(path: string): Promise<string[]> {
  const canonical = await canonicalPath(path);
  return [...ancestorRules(canonical), pathRule("allow file-read*", canonical)];
}

async function gitMetadata(project: string): Promise<string[]> {
  const marker = join(project, ".git");
  try {
    const info = await stat(marker);
    if (info.isDirectory()) return [await realpath(marker)];
    if (!info.isFile() || info.size > 8192)
      throw axonSafehouseFailure("Invalid Git worktree metadata");
    const match = /^gitdir: (.+)\s*$/.exec(await Bun.file(marker).text());
    if (!match?.[1]) throw axonSafehouseFailure("Invalid Git worktree metadata");
    const directory = await canonicalPath(match[1].trim(), project);
    const commonFile = join(directory, "commondir");
    const commonInfo = await lstat(commonFile).catch((error: unknown) => {
      // Submodules have a gitdir, but unlike linked worktrees need no commondir.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!commonInfo) return [directory];
    if (!commonInfo.isFile() || commonInfo.isSymbolicLink() || commonInfo.size > 8192) {
      throw axonSafehouseFailure("Invalid shared Git metadata");
    }
    const common = await canonicalPath((await Bun.file(commonFile).text()).trim(), directory);
    return [directory, common];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export interface AxonSafehouseResources {
  readonly baseline: string;
  readonly runDirectory: string;
  readonly temporary: string;
  readonly networkProxies: Map<string, Promise<NetworkProxy>>;
  readonly certificateEnvironment: NodeJS.ProcessEnv;
  /** Package-root scans shared by this invocation's profiles; cleared on settings changes. */
  readonly packageScans: PackageScanCache;
  dispose(): void;
}

interface AxonSafehouseLaunchOptions {
  readonly purpose?: "session" | "probe" | "provision" | "administration" | "operation";
  readonly project?: string;
  readonly writePaths?: readonly string[];
  readonly runtimeReadPaths?: readonly string[];
  readonly catalogOnly?: boolean;
  readonly resources?: AxonSafehouseResources;
}

/** Verify/download once and share the immutable baseline across an Axon invocation. */
export async function createAxonSafehouseResources(
  paths: AxonPaths,
  environment: NodeJS.ProcessEnv,
): Promise<AxonSafehouseResources> {
  const runtime = await ensureSafehouseRuntime(paths);
  const runs = join(paths.home, "axon-safehouse", "runs");
  await privateDirectory(runs);
  const runDirectory = await mkdtemp(join(runs, "session-"));
  const networkProxies = new Map<string, Promise<NetworkProxy>>();
  try {
    const temporary = join(runDirectory, "tmp");
    await privateDirectory(temporary);
    const baseline = restrictSafehouseBaseline(
      await generateSafehousePolicy(runtime, await canonicalPath(homedir()), runDirectory),
    );
    const certificateEnvironment: NodeJS.ProcessEnv = {};
    const configuredCertificates = environment["NODE_EXTRA_CA_CERTS"];
    if (configuredCertificates) {
      const certificates = await readCertificates(configuredCertificates);
      const certificatePath = join(temporary, "ca-certificates.pem");
      await writeFile(certificatePath, `${certificates.join("\n")}\n`, { mode: 0o400, flag: "wx" });
      for (const name of [
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "CURL_CA_BUNDLE",
        "REQUESTS_CA_BUNDLE",
      ])
        certificateEnvironment[name] = certificatePath;
    }
    let disposed = false;
    return {
      baseline,
      runDirectory,
      temporary,
      networkProxies,
      certificateEnvironment,
      packageScans: new Map(),
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const pending of networkProxies.values())
          void pending.then(
            (proxy) => proxy.dispose(),
            () => {},
          );
        networkProxies.clear();
        rmSync(runDirectory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    rmSync(runDirectory, { force: true, recursive: true });
    throw error;
  }
}

/** Safehouse supplies runtime/process rules; Axon replaces its permissive file/network defaults. */
export async function createAxonSafehouseLaunchSpec(
  specification: LaunchSpec,
  paths: AxonPaths,
  authorization: AxonSafehouseAuthorization,
  options: AxonSafehouseLaunchOptions = {},
): Promise<LaunchSpec> {
  const { policy } = authorization;
  const purpose = options.purpose ?? "session";
  const brokeredSession =
    purpose === "session" && specification.environment["PI_AXON_SAFEHOUSE_OPERATIONS"] === "1";
  const catalogOnly = options.catalogOnly === true && purpose === "session";
  const catalogDirectory = catalogOnly ? options.resources?.temporary : undefined;
  if (catalogOnly && !catalogDirectory)
    throw axonSafehouseFailure("RPC catalog requires Axon Safehouse");
  // Global package and MCP commands need no project. Run them from home or another
  // non-project directory in a private empty directory, without granting the home tree.
  const globalAdministration =
    (purpose === "administration" ||
      (purpose === "session" && specification.arguments[0] === "mcp")) &&
    (await isBlockedProjectDirectory(paths, options.project ?? specification.cwd));
  const isolatedDirectory =
    catalogDirectory ?? (globalAdministration ? options.resources?.temporary : undefined);
  if (globalAdministration && !isolatedDirectory)
    throw axonSafehouseFailure("Global administration requires Axon Safehouse resources");
  const projectAccess =
    !catalogOnly &&
    !globalAdministration &&
    (purpose === "operation" || purpose === "administration" || purpose === "session");
  const provisioning = purpose === "provision" || purpose === "administration";
  const project = isolatedDirectory
    ? await canonicalPath(isolatedDirectory)
    : purpose === "session" || purpose === "operation" || purpose === "administration"
      ? await validateFilesystemProject(paths, options.project ?? specification.cwd)
      : await canonicalPath(specification.cwd);
  const home = await canonicalPath(homedir());
  // Provisioning never inherits user project grants or grants access to project contents.
  const preferences: FilesystemPreferences = projectAccess
    ? await validateFilesystemPreferences(
        paths,
        project,
        await readFilesystemPreferences(paths, project),
        policy,
      )
    : {
        schemaVersion: 1,
        projectMode: "read-only",
        readPaths: [],
        writePaths: [],
        denyPaths: [],
        blockedHosts: [],
      };
  // Network preferences apply to every purpose, independently of project filesystem grants.
  const { blockedHosts } = await readFilesystemPreferences(
    paths,
    options.project ?? specification.cwd,
  );
  if (
    (!policy.allowAdditionalReadPaths && preferences.readPaths.length > 0) ||
    (!policy.allowAdditionalWritePaths && preferences.writePaths.length > 0)
  ) {
    throw axonSafehouseFailure("Backend policy does not permit your additional filesystem grants");
  }
  const relayOrigin = specification.environment["PI_AXON_AUTH_RELAY_URL"];
  if (purpose === "session" && !relayOrigin)
    throw axonSafehouseFailure("The parent-owned Axon relay is required");
  const relay = purpose === "session" && relayOrigin ? new URL(relayOrigin) : undefined;
  if (
    relay &&
    (relay.protocol !== "http:" ||
      relay.hostname !== "127.0.0.1" ||
      !/^\d+$/.test(relay.port) ||
      relay.origin !== relayOrigin)
  ) {
    throw axonSafehouseFailure("Invalid parent-owned relay address");
  }
  const requestedWritePaths = await Promise.all(
    (options.writePaths ?? []).map((path) => canonicalPath(path)),
  );
  // Without a project there is no local .pi to provision; keep only the managed targets.
  const blockedLocalRoot = globalAdministration
    ? await canonicalPath(join(specification.cwd, ".pi"))
    : undefined;
  const writePaths = requestedWritePaths.filter(
    (path) => !blockedLocalRoot || !isWithin(blockedLocalRoot, path),
  );
  const piRoot = await canonicalPath(paths.pi);
  const runtimeRoot = await canonicalPath(paths.piRuntime);
  const provisionTargets = new Set([
    join(piRoot, "npm"),
    join(piRoot, "git"),
    join(piRoot, "settings.json"),
    join(piRoot, "settings.json.lock"),
  ]);
  if (purpose === "administration" && !globalAdministration) {
    for (const entry of ["npm", "git", "settings.json", "settings.json.lock"])
      provisionTargets.add(await canonicalPath(join(project, ".pi", entry)));
  }
  for (const path of writePaths) {
    if (
      !provisioning ||
      (!provisionTargets.has(path) &&
        !(dirname(path) === runtimeRoot && /^\.staging-[a-zA-Z0-9-]+$/.test(basename(path))))
    ) {
      throw axonSafehouseFailure("Invalid Axon provisioning write target");
    }
    for (const protectedPath of policy.protectedPaths) {
      const protectedTarget = await canonicalPath(
        protectedPath.startsWith("~/") ? join(home, protectedPath.slice(2)) : protectedPath,
      );
      if (isWithin(protectedTarget, path) || isWithin(path, protectedTarget))
        throw axonSafehouseFailure("Backend policy protects an Axon provisioning target");
    }
  }
  const protectedPaths = await protectedFilesystemPaths(paths, policy);
  const stateFiles = await Promise.all(
    PI_STATE_FILES.map((filename) => canonicalPath(join(piRoot, filename))),
  );
  if (
    purpose === "session" &&
    stateFiles.some((path) => protectedPaths.some((protectedPath) => isWithin(protectedPath, path)))
  )
    throw axonSafehouseFailure(
      "Backend policy blocks essential Pi state; ask your administrator to allow Pi auth, settings, trust and model state",
    );
  const resources =
    options.resources ?? (await createAxonSafehouseResources(paths, specification.environment));
  const { baseline, runDirectory, temporary } = resources;
  try {
    let proxy: NetworkProxy | undefined;
    if (blockedHosts.length > 0) {
      const key = JSON.stringify(blockedHosts);
      let pending = resources.networkProxies.get(key);
      if (!pending) {
        pending = startNetworkProxy(blockedHosts).catch((error: unknown) => {
          if (resources.networkProxies.get(key) === pending) resources.networkProxies.delete(key);
          throw error;
        });
        resources.networkProxies.set(key, pending);
      }
      proxy = await pending;
    }
    const rules = [
      ";; Axon security boundary: replace all Safehouse filesystem/network grants.",
      '(deny file-read* file-write* (subpath "/"))',
      // dyld and system symlink resolution need directory-root reads, not just stat().
      '(allow file-read* (literal "/") (literal "/etc") (literal "/var"))',
      // No network policy gates: TCP/UDP, listeners and Unix sockets are available
      // in sessions, workers, probes and package setup alike.
      "(allow network*)",
      "(allow system-socket)",
      "(deny lsopen)",
    ];
    if (purpose === "session" && !catalogOnly) {
      // Safehouse's clipboard integration is opt-in. Give Pi's UI native copy/paste
      // access without granting the clipboard to brokered shell tools or installers.
      rules.push(
        '(allow mach-lookup (global-name "com.apple.pasteboard.1") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb"))',
      );
    }
    if (!catalogOnly && purpose !== "probe") {
      for (const entry of GIT_USER_PATHS) {
        const path = await canonicalPath(join(home, entry));
        rules.push(...ancestorRules(path), pathRule("allow file-read* file-write*", path));
      }
      const agent = specification.environment["SSH_AUTH_SOCK"];
      if (agent && isAbsolute(agent)) {
        const socket = join(await canonicalPath(dirname(agent)), basename(agent));
        rules.push(
          ...ancestorRules(socket),
          `(allow file-read-metadata (literal ${quoted(socket)}))`,
        );
      }
    }
    if (!catalogOnly && (purpose === "session" || purpose === "operation")) {
      for (const entry of MCP_USER_PATHS) {
        const path = await canonicalPath(join(home, entry));
        rules.push(...ancestorRules(path), pathRule("allow file-read* file-write*", path));
      }
      // Pi serializes each MCP server's OAuth refresh with a hashed lock directory.
      // Grant those locks without making the managed agent/runtime directory writable.
      const escapedRoot = piRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const refreshLockPattern = `^${escapedRoot}/mcp-auth-refresh-[0-9a-f]{16}\\.lock(/|$)`;
      rules.push(`(allow file-read* file-write* (regex #${quoted(refreshLockPattern)}))`);
    }
    // Discover optional user-installed git-ai outside Seatbelt, then expose only
    // its executable, never the rest of ~/.git-ai or another PATH directory.
    const gitAiCandidate =
      !catalogOnly && (purpose === "session" || purpose === "operation")
        ? await resolveGitAiBinary(specification.environment, home)
        : undefined;
    const gitAiBinary = gitAiCandidate ? await canonicalPath(gitAiCandidate) : undefined;
    if (gitAiBinary) rules.push(...(await readGrant(gitAiBinary)));
    for (const path of SYSTEM_READ_PATHS) rules.push(...(await readGrant(path)));
    for (const path of options.runtimeReadPaths ?? []) {
      const file = await canonicalPath(path, specification.cwd);
      // Extension directories keep their existing project grants; never grant an
      // arbitrary external directory merely because it appeared in the launch args.
      if (!(await lstat(file)).isFile()) continue;
      rules.push(...ancestorRules(file), `(allow file-read* (literal ${quoted(file)}))`);
    }
    for (const path of DEVICE_WRITE_PATHS) rules.push(pathRule("allow file-write*", path));
    rules.push('(allow file-write* (regex #"^/dev/(ttys|pty)[^/]*$"))');
    // Persistent Pi state is writable; executable packages remain read-only.
    for (const path of [paths.piRuntime, paths.runtime, paths.pi])
      rules.push(...(await readGrant(path)));
    const runtimePackagePaths: string[] = [];
    for (const binary of ["node", "bun", "python3", "uv"]) {
      const executable = Bun.which(binary, {
        PATH: specification.environment["PATH"] ?? "/usr/bin:/bin",
      });
      if (executable) {
        const actual = await canonicalPath(executable);
        runtimePackagePaths.push(actual);
        // Version-managed runtimes need their adjacent libraries as well as bin/.
        const root = binary === "node" || binary === "python3" ? dirname(dirname(actual)) : actual;
        if (!isWithin(root, home) && root !== parse(root).root && !isWithin(project, root)) {
          runtimePackagePaths.push(root);
          rules.push(...(await readGrant(root)));
        }
      }
    }
    // Resolve macOS's /tmp and /var aliases to their canonical /private/... paths,
    // and include the user's configured temporary directory as well.
    const writableDirectories = [temporary, ...SYSTEM_WRITE_PATHS, tmpdir()];
    if (purpose === "session") {
      if (!catalogOnly) await privateDirectory(projectSessionDirectory(paths, project));
      // Keep Pi's normal persistent session picker/resume behavior across projects.
      writableDirectories.push(
        ...PI_STATE_DIRECTORIES.map((directory) =>
          directory === "sessions" ? paths.piSessions : join(piRoot, directory),
        ),
      );
    } else {
      rules.push(pathRule("deny file-read* file-write*", await canonicalPath(paths.piSessions)));
    }
    for (const path of new Set(
      await Promise.all(writableDirectories.map((path) => canonicalPath(path))),
    )) {
      rules.push(...ancestorRules(path), pathRule("allow file-read* file-write*", path));
    }
    // getcwd needs parent-directory entries, but never recursive access to their contents.
    rules.push(
      ...ancestorRules(project, "file-read*"),
      projectAccess
        ? pathRule(
            !brokeredSession &&
              purpose !== "administration" &&
              preferences.projectMode === "read-write"
              ? "allow file-read* file-write*"
              : "allow file-read*",
            project,
          )
        : `(allow file-read-metadata (literal ${quoted(project)}))`,
    );
    // Shared agent configuration and user tools are session defaults, not
    // provisioning grants. Explicit denials and brokered write restrictions still win.
    const userWritePaths = projectAccess ? USER_WRITE_PATHS.map((path) => join(home, path)) : [];
    for (const [entries, operation] of [
      [preferences.readPaths, "allow file-read*"],
      [[...userWritePaths, ...preferences.writePaths], "allow file-read* file-write*"],
    ] as const) {
      for (const entry of entries) {
        const path = await canonicalPath(entry);
        rules.push(
          ...ancestorRules(path),
          pathRule(
            brokeredSession || purpose === "administration" ? "allow file-read*" : operation,
            path,
          ),
        );
      }
    }
    // Pi 1.5 also locks the trust store when only reading saved decisions during
    // package setup. Allow that lock without letting installers change decisions.
    if (provisioning) {
      const trustPath = await canonicalPath(join(piRoot, "trust.json"));
      if (dirname(trustPath) !== piRoot)
        throw axonSafehouseFailure("Pi state files must remain inside the managed Pi directory");
      rules.push(pathRule("allow file-read* file-write*", `${trustPath}.lock`));
    }
    // MCP management through a shell worker needs its config/OAuth state too, but
    // workers must not inherit writes to Pi's provider authentication or settings.
    const writableStateFiles =
      purpose === "session"
        ? stateFiles
        : purpose === "operation"
          ? stateFiles.filter((path) => MCP_STATE_FILES.some((name) => basename(path) === name))
          : [];
    // Pi and Axon require writable state files and their lock directories.
    // This is Pi's own state, never the shared Axon/DeputyDev login credential.
    for (const path of writableStateFiles) {
      if (dirname(path) !== piRoot)
        throw axonSafehouseFailure("Pi state files must remain inside the managed Pi directory");
      rules.push(`(allow file-read* file-write* (literal ${quoted(path)}))`);
      rules.push(pathRule("allow file-read* file-write*", `${path}.lock`));
      // The provider uses <file>.<pid>.<timestamp>.tmp; Axon's changelog uses a UUID.
      // Permit only those sibling files, not writes to the whole agent directory.
      const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const temporaryIdPattern =
        "([0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
      const temporaryPattern = `^${escapedPath}\\.([0-9]+\\.)?${temporaryIdPattern}\\.tmp$`;
      rules.push(`(allow file-read* file-write* (regex #${quoted(temporaryPattern)}))`);
    }
    const repositories = projectAccess
      ? [project, ...preferences.readPaths, ...preferences.writePaths]
      : [];
    const metadataEntries = (
      await Promise.all(
        repositories.map(async (path) => {
          try {
            const writable =
              path === project
                ? preferences.projectMode === "read-write"
                : preferences.writePaths.includes(path);
            return (await stat(path)).isDirectory()
              ? (await gitMetadata(path)).map((metadataPath) => ({ path: metadataPath, writable }))
              : [];
          } catch (error) {
            // A granted path removed since approval has no metadata to expose.
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
            throw error;
          }
        }),
      )
    ).flat();
    const metadata = [...new Set(metadataEntries.map((entry) => entry.path))];
    // Linked worktrees need their external metadata too. Git follows ordinary
    // filesystem access; a read-only repository must not gain metadata writes.
    const readOnlyMetadata = metadataEntries
      .filter((entry) => !entry.writable)
      .map((entry) => entry.path);
    for (const path of metadata) {
      rules.push(
        ...ancestorRules(path),
        pathRule(
          !brokeredSession && purpose !== "administration" && !readOnlyMetadata.includes(path)
            ? "allow file-read* file-write*"
            : "allow file-read*",
          path,
        ),
      );
    }
    for (const path of protectedPaths) {
      rules.push(pathRule("deny file-read* file-write*", await canonicalPath(path)));
    }
    const dependencyPaths = [
      ...runtimePackagePaths,
      ...(await installedPackagePaths(
        home,
        [...repositories, ...userWritePaths],
        resources.packageScans,
      )),
    ];
    for (const path of dependencyPaths) rules.push(...(await readGrant(path)));
    // Match existing trees by canonical path and future trees by path component.
    // Every broad grant, including /var, must exclude these installed dependencies.
    const packageWriteDenials = dependencyPaths.filter(
      (path) => !provisioning || !writePaths.some((target) => isWithin(path, target)),
    );
    // npx/uvx MCP servers install ephemeral dependencies in the private session cache.
    // Persistent dependency trees and the managed runtime remain read-only.
    const packageFilterExclusions = [
      ...writePaths,
      ...(purpose === "session" || purpose === "operation" ? [temporary] : []),
    ];
    const provisioningPackageFilters = PACKAGE_WRITE_FILTERS.map((filter) =>
      packageFilterExclusions.length
        ? `(require-all ${filter} ${packageFilterExclusions.map((path) => `(require-not (subpath ${quoted(path)}))`).join(" ")})`
        : filter,
    );
    for (const path of packageWriteDenials) rules.push(pathRule("deny file-write*", path));
    for (const filter of provisioningPackageFilters) rules.push(`(deny file-write* ${filter})`);
    const managedCodePaths = await Promise.all(
      [
        paths.piRuntime,
        paths.runtime,
        join(paths.pi, "npm"),
        join(paths.pi, "git"),
        join(paths.pi, "bin"),
        join(paths.pi, "extensions"),
        join(paths.home, "axon-safehouse", "runtime"),
        ...(gitAiBinary ? [gitAiBinary] : []),
      ].map((path) => canonicalPath(path)),
    );
    for (const path of managedCodePaths) {
      const canonical = await canonicalPath(path);
      if (!writePaths.includes(canonical)) rules.push(pathRule("deny file-write*", canonical));
    }
    const provisioningRules = writePaths.flatMap((path) => [
      ...ancestorRules(path),
      pathRule("allow file-read* file-write*", path),
    ]);
    if (purpose === "administration" && !globalAdministration) {
      // Local installs may create .pi itself, not arbitrary siblings or project files.
      const localRoot = await canonicalPath(join(project, ".pi"));
      provisioningRules.push(
        `(allow file-read-metadata file-write-create (literal ${quoted(localRoot)}))`,
      );
    }
    for (const path of preferences.denyPaths)
      rules.push(pathRule("deny file-read* file-write*", await canonicalPath(path)));
    const deniedReadPaths = [
      ...protectedPaths,
      ...preferences.denyPaths,
      ...(purpose === "session"
        ? []
        : [
            await canonicalPath(paths.piSessions),
            ...stateFiles.filter((path) => basename(path) === "auth.json"),
          ]),
    ];
    const managedWriteDenials = provisioning
      ? managedCodePaths.filter((path) => !writePaths.some((target) => isWithin(path, target)))
      : managedCodePaths;
    const metadataWriteDenials = purpose === "administration" ? metadata : readOnlyMetadata;
    const deniedWritePaths = [
      ...deniedReadPaths,
      ...preferences.readPaths,
      ...(brokeredSession ? [project, ...preferences.writePaths, ...metadata] : []),
      ...(projectAccess && preferences.projectMode === "read-only" ? [project] : []),
      ...managedWriteDenials,
      ...metadataWriteDenials,
      ...dependencyPaths,
    ];
    const restrictedRules = restrictFilesystemGrants(
      [...new Set(rules)],
      deniedReadPaths,
      deniedWritePaths,
      [],
      provisioningPackageFilters,
    );
    // Explicit package grants must not inherit session-only read-only exclusions.
    // Backend/user denies, managed code and the project's Git metadata still win.
    restrictedRules.push(
      ...restrictFilesystemGrants(
        provisioningRules,
        deniedReadPaths,
        [
          ...deniedReadPaths,
          ...managedWriteDenials,
          ...metadataWriteDenials,
          ...packageWriteDenials,
        ],
        [],
        provisioningPackageFilters,
      ),
    );
    const profile = join(runDirectory, `profile-${crypto.randomUUID()}.sb`);
    await writeFile(profile, `${baseline}\n${restrictedRules.join("\n")}\n`, {
      mode: 0o400,
      flag: "wx",
    });
    // Compile the policy and exercise getcwd before Pi starts; never execute outside Axon Safehouse.
    const probe = Bun.spawn(["/usr/bin/sandbox-exec", "-f", profile, "/bin/pwd"], {
      cwd: project,
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: 5_000,
    });
    const [probeDiagnostics, probeExit] = await Promise.all([
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    if (probeExit !== 0)
      throw axonSafehouseFailure(
        "Generated Safehouse policy failed its working-directory startup check",
        new Error(
          `exit=${probeExit}; signal=${probe.signalCode ?? "none"}; ${probeDiagnostics.slice(0, 8192)}`,
        ),
      );
    const environment = {
      ...axonSafehouseEnvironment(
        specification.environment,
        home,
        temporary,
        proxy?.authenticatedUrl,
        purpose === "session" || purpose === "operation",
      ),
      ...resources.certificateEnvironment,
    };
    if (purpose === "session") {
      environment["PI_CODING_AGENT_DIR"] = paths.pi;
      // Pin discovery to the canonical file granted above, including symlinked installs.
      if (gitAiBinary) environment["PI_AXON_GIT_AI_BIN"] = gitAiBinary;
    }
    if (purpose !== "session") {
      // Setup cannot inherit ambient provider credentials or the main session's relay capability.
      for (const name of Object.keys(environment)) {
        if (
          name.startsWith("LITELLM_") ||
          name.startsWith("OTEL_") ||
          (name.startsWith("PI_") && name !== "PI_CODING_AGENT_DIR" && name !== "PI_AXON_SAFEHOUSE")
        )
          delete environment[name];
      }
      environment["PI_SKIP_VERSION_CHECK"] = "1";
    }
    let disposed = false;
    return Object.freeze({
      ...specification,
      cwd: catalogOnly || globalAdministration ? project : specification.cwd,
      executable: "/usr/bin/sandbox-exec",
      arguments: ["-f", profile, specification.executable, ...specification.arguments],
      environment,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        specification.dispose?.();
        if (!options.resources) resources.dispose();
      },
    });
  } catch (error) {
    if (!options.resources) resources.dispose();
    throw error;
  }
}
