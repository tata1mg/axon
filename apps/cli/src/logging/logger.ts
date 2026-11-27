import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BUILD_INFO } from "../build-info.ts";
import { createRelayRedactor } from "../cli/auth/relay-error-details.ts";
import type { EnvironmentOverrides } from "../launcher/environment.ts";
import { type AxonPaths, resolveAxonPaths } from "../product/paths.ts";
import { createProcessLogger, type ProcessLogger } from "./process-logger.cjs";
import processLoggerAsset from "./process-logger-preload.cjs" with { type: "file" };

let currentLogger: ProcessLogger | undefined;

export function processLogFile(paths: AxonPaths, pid: number = process.pid): string {
  return join(paths.home, "logs", `pid_${pid}`, "debug.log");
}

export function initializeLauncherLogging(): ProcessLogger {
  const redactor = createRelayRedactor();
  for (const [name, value] of Object.entries(process.env)) {
    if (/token|secret|password|credential|api[_-]?key|authorization|cookie/i.test(name)) {
      redactor.protectSecret(value);
    }
  }
  const logger = createProcessLogger(resolveAxonPaths().home, {
    redact: (message) => redactor.text(message, 64 * 1024),
  });
  currentLogger = logger;
  logger.install();
  logger.info("Axon launcher logging initialized", {
    pid: process.pid,
    version: BUILD_INFO.version,
    runtime: `bun/${Bun.version}`,
  });
  return logger;
}

export const log = {
  info: (...args: unknown[]): void => currentLogger?.info(...args),
  warn: (...args: unknown[]): void => currentLogger?.warn(...args),
  error: (...args: unknown[]): void => currentLogger?.error(...args),
  debug: (...args: unknown[]): void => currentLogger?.debug(...args),
};

/** Preload before Pi imports any package, without piping its terminal or RPC streams. */
export async function createPiLoggingOverrides(
  paths: AxonPaths,
  environment: NodeJS.ProcessEnv,
): Promise<EnvironmentOverrides> {
  // Never accept an ambient logging destination or an inherited preload marker.
  const cleared = {
    PI_AXON_LOG_HOME: undefined,
    PI_AXON_LOG_PRELOAD: undefined,
    PI_AXON_LOG_OPTION: undefined,
  };
  try {
    const bytes = await Bun.file(processLoggerAsset as unknown as string).bytes();
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const logsDirectory = join(paths.home, "logs");
    const directory = join(logsDirectory, "runtime");
    for (const parent of [paths.home, logsDirectory, directory]) {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const status = await lstat(parent);
      // A readable home is allowed, but other users must not be able to replace the preload path.
      const modeUnsafe =
        parent === paths.home ? (status.mode & 0o022) !== 0 : (status.mode & 0o077) !== 0;
      if (
        !status.isDirectory() ||
        (process.getuid !== undefined && status.uid !== process.getuid()) ||
        modeUnsafe
      ) {
        throw new Error("Unsafe logging directory");
      }
    }
    const preload = join(directory, `${hash}.cjs`);
    try {
      await writeFile(preload, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const status = await lstat(preload);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      (status.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && status.uid !== process.getuid()) ||
      !(await readFile(preload)).equals(bytes)
    ) {
      throw new Error("Unsafe logging preload");
    }
    // Node canonicalizes preload filenames, including macOS /var -> /private/var.
    const resolvedPreload = await realpath(preload);
    const option = `--require ${JSON.stringify(resolvedPreload)}`;
    return {
      PI_AXON_LOG_HOME: paths.home,
      PI_AXON_LOG_PRELOAD: resolvedPreload,
      PI_AXON_LOG_OPTION: option,
      NODE_OPTIONS: [option, environment["NODE_OPTIONS"]].filter(Boolean).join(" "),
    };
  } catch (error) {
    // Logging is optional infrastructure, never a new reason for startup to fail.
    log.warn("Could not enable Pi runtime file logging", error);
    return cleared;
  }
}
