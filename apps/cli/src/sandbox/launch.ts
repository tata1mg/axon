import { rmSync } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";

import { readCertificates } from "../launcher/certificates.ts";
import type { LaunchSpec } from "../launcher/contracts.ts";
import type { AxonPaths } from "../product/paths.ts";
import { privateDirectory } from "../sessions/files.ts";
import { sandboxEnvironment } from "./environment.ts";
import {
  canonicalPath,
  isWithin,
  PI_STATE_DIRECTORIES,
  PI_STATE_FILES,
  protectedFilesystemPaths,
  readFilesystemPreferences,
  validateFilesystemPreferences,
  validateFilesystemProject,
} from "./filesystem.ts";
import { type PackageProxy, startPackageProxy } from "./package-proxy.ts";
import { type SandboxAuthorization, sandboxFailure } from "./policy.ts";
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
  "/private/etc/hosts",
  "/private/etc/resolv.conf",
  "/private/etc/services",
  "/private/etc/protocols",
  "/private/etc/localtime",
  "/private/etc/shells",
  "/dev",
];
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

function ancestorRules(path: string): string[] {
  const rules: string[] = [];
  let ancestor = dirname(path);
  while (true) {
    rules.push(`(allow file-read-metadata (literal ${quoted(ancestor)}))`);
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
    const info = await lstat(marker);
    if (info.isSymbolicLink()) throw sandboxFailure("Symlinked Git metadata is not supported");
    if (info.isDirectory()) return [await realpath(marker)];
    if (!info.isFile() || info.size > 8192) throw sandboxFailure("Invalid Git worktree metadata");
    const match = /^gitdir: (.+)\s*$/.exec(await readFile(marker, "utf8"));
    if (!match?.[1]) throw sandboxFailure("Invalid Git worktree metadata");
    const directory = await canonicalPath(match[1].trim(), project);
    const commonFile = join(directory, "commondir");
    const commonInfo = await lstat(commonFile);
    if (!commonInfo.isFile() || commonInfo.isSymbolicLink() || commonInfo.size > 8192) {
      throw sandboxFailure("Invalid shared Git metadata");
    }
    const common = await canonicalPath((await readFile(commonFile, "utf8")).trim(), directory);
    return [directory, common];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export interface SandboxResources {
  readonly baseline: string;
  readonly runDirectory: string;
  readonly temporary: string;
  readonly proxy: PackageProxy;
  readonly certificateEnvironment: NodeJS.ProcessEnv;
  dispose(): void;
}

interface SandboxLaunchOptions {
  readonly purpose?: "session" | "probe" | "provision";
  readonly writePaths?: readonly string[];
  readonly resources?: SandboxResources;
}

/** Verify/download once and share the immutable baseline and proxy across an Axon invocation. */
export async function createSandboxResources(
  paths: AxonPaths,
  environment: NodeJS.ProcessEnv,
  authorization: SandboxAuthorization,
): Promise<SandboxResources> {
  if (Date.now() >= authorization.expiresAt) throw sandboxFailure("Sandbox authorization expired");
  const runtime = await ensureSafehouseRuntime(paths);
  const runs = join(paths.home, "sandbox", "runs");
  await privateDirectory(runs);
  const runDirectory = await mkdtemp(join(runs, "session-"));
  let proxy: PackageProxy | undefined;
  try {
    const temporary = join(runDirectory, "tmp");
    await privateDirectory(temporary);
    proxy = await startPackageProxy(authorization.policy);
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
    const activeProxy = proxy;
    let disposed = false;
    return {
      baseline,
      runDirectory,
      temporary,
      proxy: activeProxy,
      certificateEnvironment,
      dispose() {
        if (disposed) return;
        disposed = true;
        activeProxy.dispose();
        rmSync(runDirectory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    proxy?.dispose();
    rmSync(runDirectory, { force: true, recursive: true });
    throw error;
  }
}

/** Safehouse supplies runtime/process rules; Axon replaces its permissive file/network defaults. */
export async function createSandboxLaunchSpec(
  specification: LaunchSpec,
  paths: AxonPaths,
  authorization: SandboxAuthorization,
  options: SandboxLaunchOptions = {},
): Promise<LaunchSpec> {
  const { policy, expiresAt } = authorization;
  const purpose = options.purpose ?? "session";
  if (Date.now() >= expiresAt) throw sandboxFailure("Sandbox authorization expired during startup");
  const project =
    purpose === "session"
      ? await validateFilesystemProject(paths, specification.cwd)
      : await canonicalPath(specification.cwd);
  const home = await canonicalPath(homedir());
  // Provisioning never inherits user project grants or grants access to project contents.
  const preferences =
    purpose === "session"
      ? await validateFilesystemPreferences(
          paths,
          project,
          await readFilesystemPreferences(paths, project),
          policy,
        )
      : { projectMode: "read-only" as const, readPaths: [], writePaths: [], denyPaths: [] };
  if (
    (!policy.allowAdditionalReadPaths && preferences.readPaths.length > 0) ||
    (!policy.allowAdditionalWritePaths && preferences.writePaths.length > 0)
  ) {
    throw sandboxFailure("Backend policy does not permit your additional filesystem grants");
  }
  const relayOrigin = specification.environment["PI_AXON_AUTH_RELAY_URL"];
  if (purpose === "session" && !relayOrigin)
    throw sandboxFailure("The parent-owned Axon relay is required");
  const relay = purpose === "session" && relayOrigin ? new URL(relayOrigin) : undefined;
  if (
    relay &&
    (relay.protocol !== "http:" ||
      relay.hostname !== "127.0.0.1" ||
      !/^\d+$/.test(relay.port) ||
      relay.origin !== relayOrigin)
  ) {
    throw sandboxFailure("Invalid parent-owned relay address");
  }
  const writePaths = await Promise.all(
    (options.writePaths ?? []).map((path) => canonicalPath(path)),
  );
  const piRoot = await canonicalPath(paths.pi);
  const runtimeRoot = await canonicalPath(paths.piRuntime);
  const provisionTargets = new Set([
    join(piRoot, "npm"),
    join(piRoot, "settings.json"),
    join(piRoot, "settings.json.lock"),
  ]);
  for (const path of writePaths) {
    if (
      purpose !== "provision" ||
      (!provisionTargets.has(path) &&
        !(dirname(path) === runtimeRoot && /^\.staging-[a-zA-Z0-9-]+$/.test(basename(path))))
    ) {
      throw sandboxFailure("Invalid Axon provisioning write target");
    }
    for (const protectedPath of policy.protectedPaths) {
      const protectedTarget = await canonicalPath(
        protectedPath.startsWith("~/") ? join(home, protectedPath.slice(2)) : protectedPath,
      );
      if (isWithin(protectedTarget, path) || isWithin(path, protectedTarget))
        throw sandboxFailure("Backend policy protects an Axon provisioning target");
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
    throw sandboxFailure(
      "Backend policy blocks essential Pi state; ask your administrator to allow Pi auth, settings and model state",
    );
  const resources =
    options.resources ??
    (await createSandboxResources(paths, specification.environment, authorization));
  const { baseline, runDirectory, temporary, proxy } = resources;
  try {
    const proxyPort = new URL(proxy.origin).port;
    const rules = [
      ";; Axon security boundary: replace all Safehouse filesystem/network grants.",
      '(deny file-read* file-write* (subpath "/"))',
      // dyld and system symlink resolution need directory-root reads, not just stat().
      '(allow file-read* (literal "/") (literal "/etc") (literal "/var"))',
      "(deny network*)",
      "(deny system-socket)",
      "(deny lsopen)",
    ];
    if (relay)
      rules.push(`(allow network-outbound (remote tcp ${quoted(`localhost:${relay.port}`)}))`);
    if (purpose !== "probe")
      rules.push(`(allow network-outbound (remote tcp ${quoted(`localhost:${proxyPort}`)}))`);
    for (const path of SYSTEM_READ_PATHS) rules.push(...(await readGrant(path)));
    for (const path of DEVICE_WRITE_PATHS) rules.push(pathRule("allow file-write*", path));
    rules.push('(allow file-write* (regex #"^/dev/(ttys|pty)[^/]*$"))');
    // Persistent Pi state is writable; executable packages remain read-only.
    for (const path of [paths.piRuntime, paths.runtime, paths.pi])
      rules.push(...(await readGrant(path)));
    for (const binary of ["node", "bun", "python3", "uv"]) {
      const executable = Bun.which(binary, {
        PATH: specification.environment["PATH"] ?? "/usr/bin:/bin",
      });
      if (executable) {
        const actual = await canonicalPath(executable);
        // Version-managed runtimes need their adjacent libraries as well as bin/.
        const root = binary === "node" || binary === "python3" ? dirname(dirname(actual)) : actual;
        if (root !== home && root !== parse(root).root && !isWithin(project, root))
          rules.push(...(await readGrant(root)));
      }
    }
    const writableDirectories = [temporary];
    if (purpose === "session") {
      await privateDirectory(projectSessionDirectory(paths, project));
      // Keep Pi's normal persistent session picker/resume behavior across projects.
      writableDirectories.push(...PI_STATE_DIRECTORIES.map((directory) => join(piRoot, directory)));
    } else {
      rules.push(pathRule("deny file-read* file-write*", await canonicalPath(paths.piSessions)));
    }
    for (const path of writableDirectories) {
      const canonical = await canonicalPath(path);
      rules.push(...ancestorRules(canonical), pathRule("allow file-read* file-write*", canonical));
    }
    rules.push(
      ...ancestorRules(project),
      purpose === "session"
        ? pathRule(
            preferences.projectMode === "read-write"
              ? "allow file-read* file-write*"
              : "allow file-read*",
            project,
          )
        : `(allow file-read-metadata (literal ${quoted(project)}))`,
    );
    for (const [entries, operation] of [
      [preferences.readPaths, "allow file-read*"],
      [preferences.writePaths, "allow file-read* file-write*"],
    ] as const) {
      for (const entry of entries) {
        const path = await canonicalPath(entry);
        rules.push(...ancestorRules(path), pathRule(operation, path));
      }
    }
    // Pi requires writable auth/settings/model files and their lock directories.
    // This is Pi's provider state, never the shared Axon/DeputyDev login credential.
    for (const path of purpose === "session" ? stateFiles : []) {
      if (dirname(path) !== piRoot)
        throw sandboxFailure("Pi state files must remain inside the managed Pi directory");
      rules.push(`(allow file-read* file-write* (literal ${quoted(path)}))`);
      rules.push(pathRule("allow file-read* file-write*", `${path}.lock`));
      // The provider's public catalog uses <file>.<pid>.<timestamp>.tmp + rename.
      // Permit only those sibling files, not writes to the whole agent directory.
      const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const temporaryPattern = `^${escapedPath}\\.[0-9]+\\.[0-9]+\\.tmp$`;
      rules.push(`(allow file-read* file-write* (regex #${quoted(temporaryPattern)}))`);
    }
    const repositories =
      purpose === "session" ? [project, ...preferences.readPaths, ...preferences.writePaths] : [];
    const metadata = [
      ...new Set(
        (
          await Promise.all(
            repositories.map(async (path) =>
              (await lstat(path)).isDirectory() ? gitMetadata(path) : [],
            ),
          )
        ).flat(),
      ),
    ];
    if (policy.localGit !== "deny") {
      for (const path of metadata) {
        rules.push(
          ...ancestorRules(path),
          pathRule(
            policy.localGit === "read-write" ? "allow file-read* file-write*" : "allow file-read*",
            path,
          ),
        );
      }
    }
    // Regex protects newly created .git directories too; path rules cover linked worktrees.
    const gitOperations =
      policy.localGit === "deny" ? "deny file-read* file-write*" : "deny file-write*";
    if (policy.localGit !== "read-write") {
      rules.push(`(${gitOperations} (regex #"/[.]git(/|$)"))`);
      for (const path of metadata) rules.push(pathRule(gitOperations, path));
    }
    for (const path of protectedPaths) {
      rules.push(pathRule("deny file-read* file-write*", await canonicalPath(path)));
    }
    const managedCodePaths = await Promise.all(
      [
        paths.piRuntime,
        paths.runtime,
        join(paths.pi, "npm"),
        join(paths.pi, "git"),
        join(paths.pi, "bin"),
        join(paths.pi, "extensions"),
        join(paths.home, "sandbox", "runtime"),
      ].map((path) => canonicalPath(path)),
    );
    for (const path of managedCodePaths) {
      const canonical = await canonicalPath(path);
      if (!writePaths.includes(canonical)) rules.push(pathRule("deny file-write*", canonical));
    }
    for (const path of writePaths) {
      rules.push(...ancestorRules(path), pathRule("allow file-read* file-write*", path));
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
      ...(policy.localGit === "deny" ? metadata : []),
    ];
    const deniedWritePaths = [
      ...deniedReadPaths,
      ...preferences.readPaths,
      ...(purpose === "session" && preferences.projectMode === "read-only" ? [project] : []),
      // Provisioning has no user grants and needs narrowly allowlisted staging paths.
      ...(purpose === "provision" ? [] : managedCodePaths),
      ...(policy.localGit === "read-write" ? [] : metadata),
    ];
    const gitFilter = '(regex #"/[.]git(/|$)")';
    const restrictedRules = restrictFilesystemGrants(
      rules,
      deniedReadPaths,
      deniedWritePaths,
      policy.localGit === "deny" ? [gitFilter] : [],
      policy.localGit === "read-write" ? [] : [gitFilter],
    );
    const profile = join(runDirectory, `profile-${crypto.randomUUID()}.sb`);
    await writeFile(profile, `${baseline}\n${restrictedRules.join("\n")}\n`, {
      mode: 0o400,
      flag: "wx",
    });
    // Compile and exercise the policy before launching Pi. A failure has no unsandboxed fallback.
    const probe = Bun.spawn(["/usr/bin/sandbox-exec", "-f", profile, "/usr/bin/true"], {
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
      throw sandboxFailure(
        "macOS rejected the generated Safehouse policy",
        new Error(
          `exit=${probeExit}; signal=${probe.signalCode ?? "none"}; ${probeDiagnostics.slice(0, 8192)}`,
        ),
      );
    if (Date.now() >= expiresAt) throw sandboxFailure("Sandbox authorization expired during setup");
    const environment = {
      ...sandboxEnvironment(specification.environment, home, temporary, proxy.authenticatedUrl),
      ...resources.certificateEnvironment,
    };
    if (purpose === "session") environment["PI_CODING_AGENT_DIR"] = paths.pi;
    if (purpose !== "session") {
      // Setup cannot inherit ambient provider credentials or the main session's relay capability.
      for (const name of Object.keys(environment)) {
        if (
          name.startsWith("LITELLM_") ||
          name.startsWith("OTEL_") ||
          (name.startsWith("PI_") && name !== "PI_CODING_AGENT_DIR" && name !== "PI_AXON_SANDBOX")
        )
          delete environment[name];
      }
      environment["PI_SKIP_VERSION_CHECK"] = "1";
      if (purpose === "probe") environment["PI_OFFLINE"] = "1";
    }
    let disposed = false;
    return Object.freeze({
      ...specification,
      executable: "/usr/bin/sandbox-exec",
      arguments: ["-f", profile, specification.executable, ...specification.arguments],
      environment,
      expiresAt,
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
