import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { withFileLock } from "../launcher/file-lock.ts";
import type { AxonPaths } from "../product/paths.ts";
import { privateDirectory } from "../sessions/files.ts";
import { axonSafehouseFailure } from "./policy.ts";

export const SAFEHOUSE_VERSION = "0.12.0";
// GitHub release asset digest, pinned independently of download responses.
export const SAFEHOUSE_SHA256 = "6298e4c8e8c0668bd2f79d8f8da7f605071c0b1f15328f263304783db6fe2829";
const SAFEHOUSE_URL = `https://github.com/eugene1g/agent-safehouse/releases/download/v${SAFEHOUSE_VERSION}/safehouse.sh`;
const MAX_RUNTIME_BYTES = 1024 * 1024;

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
    if (!info.isFile() || info.size > MAX_RUNTIME_BYTES || info.uid !== process.getuid?.()) {
      throw axonSafehouseFailure("Safehouse runtime has unsafe ownership or type");
    }
    if (
      createHash("sha256")
        .update(await handle.readFile())
        .digest("hex") !== SAFEHOUSE_SHA256
    ) {
      throw axonSafehouseFailure("Safehouse runtime integrity verification failed");
    }
    return true;
  } finally {
    await handle.close();
  }
}

export async function ensureSafehouseRuntime(paths: AxonPaths): Promise<string> {
  const directory = join(paths.home, "axon-safehouse", "runtime", SAFEHOUSE_VERSION);
  await privateDirectory(directory);
  const executable = join(directory, "safehouse.sh");
  return withFileLock(join(paths.locks, "safehouse.lock"), async () => {
    if (await verifiedRuntime(executable)) return executable;
    console.error(`axon: downloading verified Agent Safehouse ${SAFEHOUSE_VERSION}...`);
    const response = await fetch(SAFEHOUSE_URL, {
      signal: AbortSignal.timeout(30_000),
      redirect: "follow",
    });
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("content-length")) > MAX_RUNTIME_BYTES
    ) {
      throw axonSafehouseFailure("Could not download the pinned Safehouse runtime");
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > MAX_RUNTIME_BYTES)
          throw axonSafehouseFailure("Safehouse download exceeds size limit");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const content = Buffer.concat(chunks);
    if (createHash("sha256").update(content).digest("hex") !== SAFEHOUSE_SHA256) {
      throw axonSafehouseFailure("Downloaded Safehouse runtime failed integrity verification");
    }
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
    Buffer.byteLength(policy) > 2 * MAX_RUNTIME_BYTES
  ) {
    throw axonSafehouseFailure("Safehouse policy generation failed");
  }
  return policy;
}
