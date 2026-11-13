import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type FileLockOptions,
  FileLockTimeoutError,
  withFileLock,
} from "../src/launcher/file-lock.ts";

let root: string;
let lockPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-file-lock-"));
  lockPath = join(root, "settings.lock");
  await mkdir(lockPath);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function publishedOwner(): Promise<{ pid: number; token: string }> {
  const names = (await readdir(lockPath)).sort();
  // The atomic marker plus an owner.json copy for older Axon processes.
  expect(names).toHaveLength(2);
  const [name, legacy] = names;
  expect(legacy).toBe("owner.json");
  if (name === undefined) throw new Error("expected published lock ownership");
  const match = /^owner\.(\d+)\.\d+\.([a-f0-9-]{36})\.[a-f0-9]{12}$/.exec(name);
  if (match === null || match[2] === undefined) throw new Error("invalid owner marker");
  const owner = { pid: Number(match[1]), token: match[2] };
  expect(await Bun.file(join(lockPath, "owner.json")).json()).toMatchObject(owner);
  return owner;
}

/** Simulates a lock held by a live process this host cannot see (container, other machine). */
async function foreignMarker(createdAt: number): Promise<string> {
  const name = `owner.999999999.${createdAt}.${crypto.randomUUID()}.000000000000`;
  await mkdir(join(lockPath, name));
  return name;
}

async function timeout(options: FileLockOptions = {}): Promise<FileLockTimeoutError> {
  try {
    await withFileLock(
      lockPath,
      async () => {
        throw new Error("a held lock must not be acquired");
      },
      { timeoutMs: 0, ...options },
    );
  } catch (error) {
    expect(error).toBeInstanceOf(FileLockTimeoutError);
    return error as FileLockTimeoutError;
  }
  throw new Error("expected a lock timeout");
}

describe("abandoned file lock recovery", () => {
  test("recovers a fresh lock with a confirmed-dead owner without waiting for its age threshold", async () => {
    const owner = { createdAt: Date.now(), pid: 999_999_999, token: "abandoned" };
    await Bun.write(join(lockPath, "owner.json"), JSON.stringify(owner));

    const result = await withFileLock(
      lockPath,
      async () => {
        const replacement = await publishedOwner();
        expect(replacement.pid).toBe(process.pid);
        expect(replacement.token).not.toBe(owner.token);
        return "acquired";
      },
      { timeoutMs: 0 },
    );

    expect(result).toBe("acquired");
    expect(await readdir(root)).toEqual([]);
  });

  test("recovers a real process's lock after it exits without releasing it", async () => {
    await rm(lockPath, { recursive: true });
    const moduleUrl = new URL("../src/launcher/file-lock.ts", import.meta.url).href;
    const script = `
      import { withFileLock } from ${JSON.stringify(moduleUrl)};
      await withFileLock(${JSON.stringify(lockPath)}, async () => process.exit(0));
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, status] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const owner = await publishedOwner();
    expect(owner.pid).toBe(child.pid);

    expect(await withFileLock(lockPath, async () => "recovered", { timeoutMs: 0 })).toBe(
      "recovered",
    );
    expect(await readdir(root)).toEqual([]);
  });

  test("serializes concurrent callers recovering the same abandoned lock", async () => {
    await Bun.write(
      join(lockPath, "owner.json"),
      JSON.stringify({ createdAt: Date.now(), pid: 999_999_999, token: "abandoned" }),
    );
    let active = 0;
    let maximumActive = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        withFileLock(
          lockPath,
          async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await Bun.sleep(5);
            active -= 1;
            return index;
          },
          { retryDelayMs: 1, timeoutMs: 2_000 },
        ),
      ),
    );

    expect(results).toEqual(
      Array.from({ length: 12 }, (_, value) => ({ status: "fulfilled", value })),
    );
    expect(maximumActive).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });

  test("serializes separate processes competing to recover an abandoned lock", async () => {
    await Bun.write(
      join(lockPath, "owner.json"),
      JSON.stringify({ createdAt: Date.now(), pid: 999_999_999, token: "abandoned" }),
    );
    const moduleUrl = new URL("../src/launcher/file-lock.ts", import.meta.url).href;
    const guardPath = join(root, "critical-section");
    const script = `
      import { writeFile, unlink } from "node:fs/promises";
      import { withFileLock } from ${JSON.stringify(moduleUrl)};
      for (let attempt = 0; attempt < 5; attempt++) {
        await withFileLock(${JSON.stringify(lockPath)}, async () => {
          // Exclusive creation detects overlapping critical sections across processes.
          await writeFile(${JSON.stringify(guardPath)}, "active", { flag: "wx" });
          try { await Bun.sleep(3); }
          finally { await unlink(${JSON.stringify(guardPath)}); }
        }, { retryDelayMs: 1, timeoutMs: 5000 });
      }
    `;
    const children = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        const [stderr, status] = await Promise.all([
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stderr, status };
      }),
    );
    expect(results).toEqual(children.map(() => ({ stderr: "", status: 0 })));
    expect(await readdir(root)).toEqual([]);
  }, 10_000);

  test.each([undefined, "{invalid"])(
    "retains the grace period for missing or malformed owner metadata: %s",
    async (contents) => {
      if (contents !== undefined) await Bun.write(join(lockPath, "owner.json"), contents);
      // Two minutes old is still protected by the default five-minute grace period.
      const modifiedAt = new Date(Date.now() - 120_000);
      await utimes(lockPath, modifiedAt, modifiedAt);
      await timeout();
      expect((await lstat(lockPath)).isDirectory()).toBe(true);

      // Once the configured grace period has passed, the orphan can be reclaimed.
      expect(
        await withFileLock(lockPath, async () => "acquired", {
          timeoutMs: 0,
          staleAfterMs: 60_000,
        }),
      ).toBe("acquired");
      expect(await readdir(root)).toEqual([]);
    },
  );

  test("does not reclaim a lock whose owner changes during inspection", async () => {
    const owner = { createdAt: Date.now(), pid: 999_999_999, token: "unchanged-token" };
    const replacement = { ...owner, pid: process.pid };
    const ownerPath = join(lockPath, "owner.json");
    await Bun.write(ownerPath, JSON.stringify(owner));
    const originalKill = process.kill.bind(process);
    const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === owner.pid) {
        writeFileSync(ownerPath, JSON.stringify(replacement));
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return originalKill(pid, signal);
    });
    try {
      const error = await timeout();
      expect(error.message).toContain(`PID ${process.pid}) is still running`);
      expect(await Bun.file(ownerPath).json()).toEqual(replacement);
    } finally {
      kill.mockRestore();
    }
  });

  test("refuses to reclaim another user's lock even when its owner is dead", async () => {
    const getuid = process.getuid;
    if (getuid === undefined) return;
    const owner = { createdAt: Date.now(), pid: 999_999_999, token: "other-user" };
    await Bun.write(join(lockPath, "owner.json"), JSON.stringify(owner));
    const uid = spyOn(process, "getuid").mockReturnValue(getuid() + 1);
    try {
      await expect(
        withFileLock(lockPath, async () => "must not acquire", { timeoutMs: 0 }),
      ).rejects.toThrow("refusing to remove lock owned by uid");
      expect(await Bun.file(join(lockPath, "owner.json")).json()).toEqual(owner);
    } finally {
      uid.mockRestore();
    }
  });

  test("refuses to reclaim a symlinked lock directory", async () => {
    const target = join(root, "target");
    await mkdir(target);
    const owner = { createdAt: Date.now(), pid: 999_999_999, token: "symlink-target" };
    await Bun.write(join(target, "owner.json"), JSON.stringify(owner));
    await rm(lockPath, { recursive: true });
    await symlink(target, lockPath);

    await expect(
      withFileLock(lockPath, async () => "must not acquire", { timeoutMs: 0 }),
    ).rejects.toThrow("not a regular directory");
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(join(target, "owner.json")).json()).toEqual(owner);
  });
});

describe("lock compatibility and safety", () => {
  test("older Axon cleanup sees a live owner.json and never steals a held marker lock", async () => {
    await rm(lockPath, { recursive: true });
    await withFileLock(lockPath, async () => {
      const owner = await publishedOwner();
      // Pre-marker releases read only owner.json and keep live PIDs' locks.
      expect(owner.pid).toBe(process.pid);
    });
    expect(await readdir(root)).toEqual([]);
  });

  test("does not trust a missing PID from another host until the grace period passes", async () => {
    const name = await foreignMarker(Date.now());
    const error = await timeout();
    expect(error.message).toContain("could not be checked safely");
    expect(await readdir(lockPath)).toEqual([name]);

    await rm(join(lockPath, name), { recursive: true });
    await foreignMarker(Date.now() - 120_000);
    expect(
      await withFileLock(lockPath, async () => "acquired", { timeoutMs: 0, staleAfterMs: 60_000 }),
    ).toBe("acquired");
    expect(await readdir(root)).toEqual([]);
  });

  test("rejects a regular file at the lock path immediately", async () => {
    await rm(lockPath, { recursive: true });
    await Bun.write(lockPath, "not a lock");
    await expect(
      withFileLock(lockPath, async () => "must not acquire", { timeoutMs: 5_000 }),
    ).rejects.toThrow("not a regular directory");
    expect(await Bun.file(lockPath).text()).toBe("not a lock");
  });

  test("fails acquisition, releasing the marker, if owner.json cannot be published", async () => {
    await rm(lockPath, { recursive: true });
    const failure = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    const writeFile = spyOn(fsPromises, "writeFile").mockImplementation(async () => {
      throw failure;
    });
    let entered = false;
    try {
      await expect(
        withFileLock(lockPath, async () => {
          entered = true;
        }),
      ).rejects.toBe(failure);
    } finally {
      writeFile.mockRestore();
    }
    // Older Axon reads only owner.json; a marker-only lock must never guard a critical section.
    expect(entered).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  test("a failing release never hides the operation's own error", async () => {
    await rm(lockPath, { recursive: true });
    const failure = new Error("operation failed");
    try {
      await expect(
        withFileLock(lockPath, async () => {
          // Make release fail: owner files can no longer be removed from the lock directory.
          await chmod(lockPath, 0o500);
          throw failure;
        }),
      ).rejects.toBe(failure);
    } finally {
      await chmod(lockPath, 0o700);
    }
  });
});

describe("file lock timeout diagnostics", () => {
  test("does not reclaim a live owner's lock even when it is old", async () => {
    const owner = { createdAt: 1, pid: process.pid, token: "live-owner" };
    await Bun.write(join(lockPath, "owner.json"), JSON.stringify(owner));
    await utimes(lockPath, new Date(1), new Date(1));

    const error = await timeout({ staleAfterMs: 1 });

    expect(error.message).toContain(`owner process (PID ${process.pid}) is still running`);
    expect(error.remediation).toContain("Wait for the other operation");
    expect(error.remediation).toContain("Do not remove a lock that may still be in use");
    expect(error.remediation).not.toContain("automatically");
    expect(error.message).not.toContain(owner.token);
    expect(await Bun.file(join(lockPath, "owner.json")).json()).toEqual(owner);
  });

  test.each(["EPERM", "EACCES", "EINVAL"])(
    "does not treat a failed process check (%s) as proof that the owner is dead",
    async (code) => {
      const owner = { createdAt: 1, pid: 999_999_999, token: "unknown-status" };
      await Bun.write(join(lockPath, "owner.json"), JSON.stringify(owner));
      await utimes(lockPath, new Date(1), new Date(1));
      const kill = spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("could not inspect process"), { code });
      });
      try {
        const error = await timeout();
        expect(error.message).toContain("PID 999999999) could not be checked safely");
        expect(error.message).not.toContain("no longer running");
        expect(error.remediation).not.toContain("automatically");
        expect(await Bun.file(join(lockPath, "owner.json")).json()).toEqual(owner);
      } finally {
        kill.mockRestore();
      }
    },
  );

  test.each([
    undefined,
    "{invalid",
    '{"pid":123}',
    '{"createdAt":1,"pid":-1,"token":"invalid"}',
    '{"createdAt":1e400,"pid":123,"token":"invalid"}',
  ])("uses cautious advice when owner metadata is unavailable: %s", async (contents) => {
    if (contents !== undefined) await Bun.write(join(lockPath, "owner.json"), contents);

    const error = await timeout();

    expect(error.message).toContain(lockPath);
    expect(error.message).toContain("owner process could not be determined");
    expect(error.message).not.toContain("no longer running");
    expect(error.remediation).not.toContain("automatically");
  });
});
