import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { PRODUCT_IDENTITY } from "../../product/identity.ts";

export const NPM_PUBLIC_REGISTRY = "https://registry.npmjs.org/";
export const NPM_MIRROR_REGISTRY = "https://registry.npmmirror.com/";

/** Only completed npm failures are retryable; spawn errors and signals are not. */
export class NpmInstallFailure extends Error {
  constructor(
    readonly exitCode: number,
    readonly output: string,
  ) {
    super(`npm installation exited with status ${exitCode}`);
  }
}

interface NpmRegistryContext {
  /** npm's install root (including the effect of Pi's --prefix). */
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly npmPath?: string;
  readonly scope?: string;
}

// Availability failures only: do not retry authentication, permissions, integrity,
// dependency resolution, lifecycle scripts, or a cancelled subprocess.
const REGISTRY_FAILURE =
  /\b(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|ERR_SOCKET_TIMEOUT|FETCH_ERROR|E404|E408|E429|E500|E502|E503|E504|ETARGET|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)\b/i;
const LOCAL_FAILURE =
  /\b(?:E401|E403|EACCES|EPERM|EINTEGRITY|ERESOLVE|ENOSPC|ELIFECYCLE)\b|npm (?:ERR!|error) command (?:failed|sh\b|cmd\b)/i;

function publicRegistry(value: string): string | undefined {
  // Exact public origins only. Never send private package names or credentials
  // to a public fallback for a custom registry, path, or authenticated URL.
  const normalized = value.trim().replace(/\/$/, "");
  return [NPM_PUBLIC_REGISTRY, NPM_MIRROR_REGISTRY].find(
    (registry) => registry.slice(0, -1) === normalized,
  );
}

async function readRegistryConfig(
  context: NpmRegistryContext,
  key: string,
): Promise<string | undefined> {
  try {
    const child = Bun.spawn([context.npmPath ?? "npm", "config", "get", key], {
      cwd: context.cwd,
      env: context.environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return exitCode === 0 && child.signalCode === null ? output.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function configuredRegistry(context: NpmRegistryContext): Promise<string | undefined> {
  const configured =
    context.environment["npm_config_registry"] ??
    context.environment["NPM_CONFIG_REGISTRY"] ??
    (await readRegistryConfig(context, "registry"));
  const registry = configured === undefined ? undefined : publicRegistry(configured);
  // Even a public scoped package may depend on unscoped private packages. Do
  // not override a private default registry when retrying that scoped package.
  if (registry === undefined) return undefined;
  if (context.scope !== undefined) {
    const scoped = await readRegistryConfig(context, `${context.scope}:registry`);
    if (scoped === undefined) return undefined;
    if (scoped !== "undefined" && scoped !== "null" && scoped !== "") {
      return publicRegistry(scoped);
    }
  }
  return registry;
}

/** Rebase public tarball URLs in either direction, preserving pins and integrity. */
async function rewritePublicLockfile(directory: string, registry: string): Promise<void> {
  const path = join(directory, "package-lock.json");
  let status: Stats;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`npm lockfile is not a regular file: ${path}`);
  }
  let changed = false;
  const lock: unknown = JSON.parse(await Bun.file(path).text(), (key, value: unknown) => {
    if (key === "resolved" && typeof value === "string") {
      const previous = [NPM_PUBLIC_REGISTRY, NPM_MIRROR_REGISTRY].find((origin) =>
        value.startsWith(origin),
      );
      if (previous !== undefined && previous !== registry) {
        changed = true;
        return registry + value.slice(previous.length);
      }
    }
    return value;
  });
  if (!changed) return;
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`);
    await chmod(temporaryPath, status.mode & 0o777);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** Try the user's npm config first, then the other public registry at most once. */
export async function withNpmRegistryFallback<T>(
  context: NpmRegistryContext,
  attempt: (environment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  await mkdir(context.cwd, { recursive: true, mode: 0o700 });
  const primary = await configuredRegistry(context);
  if (primary !== undefined) await rewritePublicLockfile(context.cwd, primary);
  try {
    return await attempt(context.environment);
  } catch (error) {
    if (
      primary === undefined ||
      !(error instanceof NpmInstallFailure) ||
      error.exitCode >= 128 ||
      !REGISTRY_FAILURE.test(error.output) ||
      LOCAL_FAILURE.test(error.output)
    ) {
      throw error;
    }
    const fallback = primary === NPM_PUBLIC_REGISTRY ? NPM_MIRROR_REGISTRY : NPM_PUBLIC_REGISTRY;
    console.error(
      `${PRODUCT_IDENTITY.command}: npm registry request failed; retrying with ${fallback}`,
    );
    const environment = { ...context.environment };
    for (const key of Object.keys(environment)) {
      if (
        key.toLowerCase() === "npm_config_registry" ||
        key.toLowerCase() === `npm_config_${context.scope}:registry`
      ) {
        delete environment[key];
      }
    }
    environment["npm_config_registry"] = fallback;
    if (context.scope !== undefined) {
      environment[`npm_config_${context.scope}:registry`] = fallback;
    }
    // A failed npm install may also have written new public URLs into the lockfile.
    await rewritePublicLockfile(context.cwd, fallback);
    return attempt(environment);
  }
}
