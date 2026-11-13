import { constants } from "node:fs";
import { chmod, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "../hash.ts";
import { withFileLock } from "../launcher/file-lock.ts";
import type { AxonPaths } from "../product/paths.ts";
import { privateDirectory } from "../sessions/files.ts";
import { axonSafehouseFailure } from "./policy.ts";
// Vendored verbatim from the upstream GitHub release; update with `bun run safehouse:update`.
import bundledSafehouseAsset from "./vendor/safehouse.sh" with { type: "file" };

export const SAFEHOUSE_VERSION = "0.12.0";
// GitHub release asset digest of vendor/safehouse.sh; `bun run safehouse:check` enforces it.
export const SAFEHOUSE_SHA256 = "6298e4c8e8c0668bd2f79d8f8da7f605071c0b1f15328f263304783db6fe2829";
export const SAFEHOUSE_MAX_BYTES = 1024 * 1024;
export const BUNDLED_SAFEHOUSE_PATH: string = bundledSafehouseAsset;

async function verifiedRuntime(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw axonSafehouseFailure("Safehouse runtime could not be read safely");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > SAFEHOUSE_MAX_BYTES || info.uid !== process.getuid?.()) {
      throw axonSafehouseFailure("Safehouse runtime has unsafe ownership or type");
    }
    if (sha256(await handle.readFile()) !== SAFEHOUSE_SHA256) {
      throw axonSafehouseFailure("Safehouse runtime integrity verification failed");
    }
    return true;
  } finally {
    await handle.close();
  }
}

/** Read the copy embedded in the Axon binary (or the repository file in source runs). */
async function bundledRuntime(): Promise<Uint8Array> {
  let content: Uint8Array;
  try {
    const file = Bun.file(BUNDLED_SAFEHOUSE_PATH);
    if (file.size > SAFEHOUSE_MAX_BYTES) throw new Error("oversized");
    content = await file.bytes();
  } catch {
    throw axonSafehouseFailure("Bundled Safehouse runtime is missing or unreadable");
  }
  if (sha256(content) !== SAFEHOUSE_SHA256) {
    throw axonSafehouseFailure("Bundled Safehouse runtime failed integrity verification");
  }
  return content;
}

/** Materialize the bundled runtime once per version; Seatbelt policy generation needs a real file. */
export async function ensureSafehouseRuntime(paths: AxonPaths): Promise<string> {
  const directory = join(paths.home, "axon-safehouse", "runtime", SAFEHOUSE_VERSION);
  await privateDirectory(directory);
  const executable = join(directory, "safehouse.sh");
  return withFileLock(join(paths.locks, "safehouse.lock"), async () => {
    if (await verifiedRuntime(executable)) return executable;
    const content = await bundledRuntime();
    const temporary = `${executable}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o500);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, executable);
      await chmod(executable, 0o500);
    } finally {
      await rm(temporary, { force: true });
    }
    await verifiedRuntime(executable);
    return executable;
  });
}

/** Generate policies only. The verified script never executes agent code outside Seatbelt. */
export async function generateSafehousePolicy(
  runtime: string,
  home: string,
  temporary: string,
): Promise<string> {
  const subprocess = Bun.spawn(
    ["/bin/bash", runtime, "--stdout", "--workdir=", "--trust-workdir-config=false"],
    {
      cwd: temporary,
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: temporary,
        LANG: "en_US.UTF-8",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  const [policy, , exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (
    exitCode !== 0 ||
    !policy.includes("(version 1)") ||
    Buffer.byteLength(policy) > 2 * SAFEHOUSE_MAX_BYTES
  ) {
    throw axonSafehouseFailure("Safehouse policy generation failed");
  }
  return policy;
}
