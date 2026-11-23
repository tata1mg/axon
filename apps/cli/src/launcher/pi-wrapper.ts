import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";

import type { AxonPaths } from "../product/paths.ts";

const EXECUTABLE_MODE = 0o755;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Apps that run a Pi binary directly (`<binary> --mode rpc`, `<binary> --version`) have
 * no place for Axon's `pi` harness argument. This script adds it, so they can use
 * `axon-pi` wherever they accept a Pi binary path.
 */
export function piWrapperScript(managedBinary: string): string {
  return [
    "#!/bin/sh",
    "# Managed by axon: runs Pi through Axon for apps that launch a Pi binary directly.",
    `exec ${shellQuote(managedBinary)} pi "$@"`,
    "",
  ].join("\n");
}

async function isCurrent(path: string, content: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    return (
      status.isFile() &&
      (status.mode & 0o777) === EXECUTABLE_MODE &&
      (await readFile(path, "utf8")) === content
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Creates or repairs the wrapper; returns whether it changed. Axon owns this path. */
export async function ensurePiWrapper(paths: AxonPaths): Promise<boolean> {
  const content = piWrapperScript(paths.managedBinary);
  if (await isCurrent(paths.piWrapper, content)) return false;

  const temporaryPath = `${paths.piWrapper}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode: EXECUTABLE_MODE });
    // The process umask may have narrowed the creation mode.
    await chmod(temporaryPath, EXECUTABLE_MODE);
    await rename(temporaryPath, paths.piWrapper);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return true;
}
