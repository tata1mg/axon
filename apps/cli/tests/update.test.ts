import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILD_INFO, type BuildInfo } from "../src/build-info.ts";
import { LAUNCHER_EXIT_STATUS } from "../src/launcher/exit-status.ts";
import { withFileLock } from "../src/launcher/file-lock.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import {
  formatReleaseChecksums,
  hostReleaseTarget,
  RELEASE_TARGETS,
  releaseAssetNames,
} from "../src/product/release-targets.ts";
import { type UpdateProgressView, withUpdateProgress } from "../src/updater/progress.ts";
import { latestReleaseVersion, releaseHashes } from "../src/updater/release.ts";
import { runStartupUpdate, scheduleBackgroundUpdate } from "../src/updater/startup.ts";
import {
  automaticUpdatesAllowed,
  checkForUpdate,
  installUpdate,
  runBackgroundUpdate,
  type UpdateContext,
} from "../src/updater/update.ts";

const roots: string[] = [];
const servers: Bun.Server<undefined>[] = [];
const version = "0.2.0";
// Updates install only the host's native target, so Intel CI exercises darwin-x64.
const target = hostReleaseTarget() ?? "darwin-arm64";
const assets = releaseAssetNames(target);
// The installed launcher answers --version like a real release; updates refuse unknown versions.
const oldBinary = "#!/bin/sh\nprintf '%s\\n' '0.1.0'\n";

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

interface Fixture {
  readonly context: UpdateContext;
  readonly paths: ReturnType<typeof resolveAxonPaths>;
  readonly requests: string[];
  readonly setHash: (hash: string) => void;
  readonly setVersion: (version: string) => void;
}

async function fixture(
  binaryVersion = version,
  basePath = "",
  launchScript = "",
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "axon-update-"));
  roots.push(root);
  const paths = resolveAxonPaths({}, root);
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  await chmod(paths.bin, 0o700);
  await Bun.write(paths.managedBinary, oldBinary);
  await chmod(paths.managedBinary, 0o700);
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${binaryVersion}'; exit 0; fi\n${launchScript}\n`;
  const binary = new TextEncoder().encode(script);
  const archive = Bun.gzipSync(binary);
  let archiveHash = sha256(archive);
  let latest = version;
  const requests: string[] = [];
  const server: Bun.Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === `${basePath}/api/v1/cli/releases/latest/VERSION`)
        return new Response(`${latest}\n`);
      if (path === `${basePath}/api/v1/cli/releases/${version}/${assets.checksums}`) {
        return new Response(formatReleaseChecksums(target, archiveHash, sha256(binary)));
      }
      if (path === `${basePath}/api/v1/cli/releases/${version}/${assets.archive}`) {
        return Response.redirect(`http://127.0.0.1:${server.port}/archive`, 302);
      }
      if (path === "/archive") return new Response(archive);
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    context: {
      build: { ...BUILD_INFO, kind: "binary", version: "0.1.0", target },
      executable: paths.managedBinary,
      paths,
      client: { baseUrl: `${origin}${basePath}/api/v1/cli/releases` },
      verifySignature: async () => {},
    },
    paths,
    requests,
    setHash: (value) => {
      archiveHash = value;
    },
    setVersion: (value) => {
      latest = value;
    },
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const interactive = { ci: false, stdinIsTty: true, stdoutIsTty: true };
const silent: UpdateProgressView = { report: () => {}, done: () => {} };

function recordingProgress(events: string[]): UpdateProgressView {
  return {
    report: ({ stage, version }) => events.push(version ? `${stage} ${version}` : stage),
    done: () => events.push("done"),
  };
}

async function startup(
  f: Fixture,
  args: readonly string[] = [],
  environment: NodeJS.ProcessEnv = {},
) {
  const warnings: string[] = [];
  const restarts: (readonly string[])[] = [];
  await runStartupUpdate(args, {
    context: f.context,
    invocation: interactive,
    environment,
    warn: (message) => warnings.push(message),
    restart: async (_context, argumentsVector) => {
      restarts.push(argumentsVector);
    },
    progress: silent,
  });
  return { warnings, restarts };
}

describe("startup updates", () => {
  test("installs latest before continuing with unchanged Pi arguments, ignoring old throttle", async () => {
    const f = await fixture();
    await Bun.write(f.paths.updateState, JSON.stringify({ nextCheckAt: Date.now() + 86_400_000 }));
    const args = ["--resume", "session-id", "--", "hello world", "--offline"];
    const result = await startup(f, args);
    expect(await Bun.file(f.paths.managedBinary).text()).toContain(version);
    expect(result.restarts).toEqual([["pi", ...args]]);
    expect(result.warnings[0]).toContain(`updated to ${version}`);
  });

  test("checks every launch without restarting an up-to-date or newer binary", async () => {
    const f = await fixture();
    for (const latest of ["0.1.0", "0.0.9", "0.1.0"]) {
      f.setVersion(latest);
      expect(await startup(f)).toEqual({ warnings: [], restarts: [] });
    }
    expect(f.requests).toHaveLength(3);
    expect(await Bun.file(f.paths.managedBinary).text()).toBe(oldBinary);
  });

  test("warns and allows the old version on discovery, checksum, or managed-path failure", async () => {
    for (const failure of ["metadata", "checksum", "unmanaged"]) {
      const f = await fixture();
      if (failure === "metadata") f.setVersion("invalid");
      if (failure === "checksum") f.setHash("0".repeat(64));
      const result = await startup(
        failure === "unmanaged"
          ? { ...f, context: { ...f.context, executable: process.execPath } }
          : f,
      );
      expect(result.restarts).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("continuing with the current version");
      expect(await Bun.file(f.paths.managedBinary).text()).toBe(oldBinary);
    }
  });

  test("does not wait behind another updater's download or report it as a failure", async () => {
    const f = await fixture();
    await mkdir(f.paths.locks, { recursive: true, mode: 0o700 });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = () => {};
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const other = withFileLock(join(f.paths.locks, "update.lock"), async () => {
      acquired();
      await held;
    });
    await ready;
    try {
      const startedAt = Date.now();
      expect(await startup(f)).toEqual({ warnings: [], restarts: [] });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(await Bun.file(f.paths.managedBinary).text()).toBe(oldBinary);
    } finally {
      release();
      await other;
    }
  });

  test("continues on a release another process already installed, without downloading it", async () => {
    const f = await fixture();
    // The background worker renames a newer release over the binary this launcher runs.
    const replacement = join(f.paths.bin, "replacement");
    await Bun.write(replacement, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    await chmod(replacement, 0o700);
    await rename(replacement, f.paths.managedBinary);
    const args = ["hello"];
    const result = await startup(f, args);
    expect(result.restarts).toEqual([["pi", ...args]]);
    expect(result.warnings).toEqual([
      `axon: updated to ${version}; continuing with the new version.`,
    ]);
    expect(f.requests.some((path) => path.endsWith(assets.archive) || path === "/archive")).toBe(
      false,
    );
  });

  test("shows check, download, and verify progress, clearing it before the outcome", async () => {
    for (const [latest, expected] of [
      [version, ["check", `download ${version}`, `verify ${version}`, "done"]],
      ["0.1.0", ["check", "done"]],
      ["invalid", ["check", "done"]],
    ] as const) {
      const f = await fixture();
      f.setVersion(latest);
      const events: string[] = [];
      await runStartupUpdate([], {
        context: f.context,
        invocation: interactive,
        environment: {},
        warn: (message) => events.push(`warn: ${message}`),
        restart: async () => {},
        progress: recordingProgress(events),
      });
      expect(events.slice(0, expected.length)).toEqual([...expected]);
      expect(events.length - expected.length).toBe(latest === "0.1.0" ? 0 : 1);
    }
  });

  test("warns and continues if the updated launcher cannot start", async () => {
    const f = await fixture();
    const warnings: string[] = [];
    await runStartupUpdate([], {
      context: f.context,
      invocation: interactive,
      environment: {},
      restart: async () => {
        throw new Error("spawn failed");
      },
      warn: (message) => warnings.push(message),
      progress: silent,
    });
    expect(warnings.at(-1)).toContain("could not start the updated launcher");
  });

  test("skips offline, opted-out, administrative, scripted, CI, and source launches", async () => {
    const f = await fixture();
    for (const args of [
      ["--offline"],
      ["--help"],
      ["--version"],
      ["auth"],
      ["install", "npm:foo"],
      ["-p", "hi"],
      ["--mode", "rpc"],
    ]) {
      expect(await startup(f, args)).toEqual({ warnings: [], restarts: [] });
    }
    await startup(f, [], { AXON_NO_UPDATE: "1" });
    await startup(f, [], { PI_OFFLINE: "true" });
    for (const invocation of [
      { ...interactive, ci: true },
      { ...interactive, stdinIsTty: false },
      { ...interactive, stdoutIsTty: false },
    ]) {
      await runStartupUpdate([], { context: f.context, environment: {}, invocation });
    }
    await runStartupUpdate([], {
      context: { ...f.context, build: { ...f.context.build, kind: "dev" } },
      environment: {},
      invocation: interactive,
    });
    expect(f.requests).toEqual([]);
  });

  test("real relaunch preserves arguments, cwd, environment, and child exit/signal", async () => {
    for (const signal of [false, true]) {
      const f = await fixture(
        version,
        "",
        signal ? "kill -TERM $$" : `printf '%s\\n' "$PWD" "$STARTUP_TEST_VALUE" "$@"; exit 42`,
      );
      const runner = join(f.paths.home, "startup-runner.ts");
      const args = ["--resume", "session with spaces", "--", "hello world"];
      await Bun.write(
        runner,
        `
        import { runStartupUpdate } from ${JSON.stringify(join(import.meta.dir, "../src/updater/startup.ts"))};
        await runStartupUpdate(${JSON.stringify(args)}, {
          context: { ...${JSON.stringify(f.context)}, verifySignature: async () => {} },
          invocation: ${JSON.stringify(interactive)}, environment: {},
        });
        throw new Error("old launcher must not continue after a successful relaunch");
      `,
      );
      const child = Bun.spawn([process.execPath, runner], {
        cwd: f.paths.home,
        env: { ...process.env, STARTUP_TEST_VALUE: "inherited" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, error] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(error).toContain(`updated to ${version}`);
      if (signal) {
        expect(child.signalCode).toBe("SIGTERM");
      } else {
        expect(child.exitCode).toBe(42);
        expect(output.trim().split("\n")).toEqual([
          await realpath(f.paths.home),
          "inherited",
          "pi",
          ...args,
        ]);
      }
    }
  });

  test("metadata timeout also bounds a stalled response body", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("0."));
            },
          }),
        ),
    });
    servers.push(server);
    await expect(
      latestReleaseVersion({ baseUrl: `http://127.0.0.1:${server.port}`, metadataTimeoutMs: 25 }),
    ).rejects.toThrow();
  });
});

describe("CLI manual and background updates", () => {
  test("compares embedded and configured versions without downloading on --check", async () => {
    const f = await fixture();
    expect(await checkForUpdate(f.context)).toBe(version);
    expect(f.requests).toEqual(["/api/v1/cli/releases/latest/VERSION"]);
    f.setVersion("0.1.0");
    expect(await checkForUpdate(f.context)).toBeUndefined();
    f.setVersion("invalid");
    expect(checkForUpdate(f.context)).rejects.toThrow("canonical semantic version");
  });

  test("manual check and install report progress and always clear it", async () => {
    const f = await fixture();
    const events: string[] = [];
    const progress = recordingProgress(events);
    expect(
      await withUpdateProgress(
        (onProgress) => checkForUpdate({ ...f.context, onProgress }),
        progress,
      ),
    ).toBe(version);
    expect(
      await withUpdateProgress(
        (onProgress) => installUpdate({ ...f.context, onProgress }),
        progress,
      ),
    ).toBe(version);
    // Start over from the old release; an already-installed version is not downloaded again.
    await Bun.write(f.paths.managedBinary, oldBinary);
    f.setHash("0".repeat(64));
    await expect(
      withUpdateProgress((onProgress) => installUpdate({ ...f.context, onProgress }), progress),
    ).rejects.toThrow("could not update axon");
    expect(events).toEqual([
      "check",
      "done",
      "check",
      `download ${version}`,
      `verify ${version}`,
      "done",
      "check",
      `download ${version}`,
      "done",
    ]);
  });

  test("downloads, hashes, probes and atomically replaces the managed binary", async () => {
    const f = await fixture();
    expect(await installUpdate(f.context)).toBe(version);
    expect(await Bun.file(f.paths.managedBinary).text()).toContain(version);
    expect(await Bun.file(f.paths.previousBinary).text()).toBe(oldBinary);
    expect(f.requests).toContain(`/api/v1/cli/releases/${version}/${assets.checksums}`);
    expect(f.requests).toContain("/archive");
    expect((await readdir(f.paths.bin)).filter((name) => name.startsWith(".axon-update-"))).toEqual(
      [],
    );
  });

  test("updates below /axon without prefixing the redirected storage URL", async () => {
    const f = await fixture(version, "/axon");
    expect(await installUpdate(f.context)).toBe(version);
    expect(f.requests).toEqual([
      "/axon/api/v1/cli/releases/latest/VERSION",
      `/axon/api/v1/cli/releases/${version}/${assets.checksums}`,
      `/axon/api/v1/cli/releases/${version}/${assets.archive}`,
      "/archive",
    ]);
  });

  test("never replaces an existing binary on checksum or version mismatch", async () => {
    const badHash = await fixture();
    badHash.setHash("0".repeat(64));
    await expect(installUpdate(badHash.context)).rejects.toMatchObject({
      exitStatus: LAUNCHER_EXIT_STATUS.updateFailure,
    });
    expect(await Bun.file(badHash.paths.managedBinary).text()).toBe(oldBinary);
    expect(await Bun.file(badHash.paths.previousBinary).exists()).toBe(false);

    const wrongVersion = await fixture("0.3.0");
    await expect(installUpdate(wrongVersion.context)).rejects.toMatchObject({
      exitStatus: LAUNCHER_EXIT_STATUS.updateFailure,
    });
    expect(await Bun.file(wrongVersion.paths.managedBinary).text()).toBe(oldBinary);
  });

  test("restores the original executable if the backup path cannot be replaced", async () => {
    const f = await fixture();
    await mkdir(f.paths.previousBinary);
    await expect(installUpdate(f.context)).rejects.toMatchObject({
      exitStatus: LAUNCHER_EXIT_STATUS.updateFailure,
    });
    expect(await Bun.file(f.paths.managedBinary).text()).toBe(oldBinary);
    expect((await stat(f.paths.previousBinary)).isDirectory()).toBe(true);
  });

  test("refuses to mutate an unmanaged executable or downgrade", async () => {
    const f = await fixture();
    await expect(
      installUpdate({ ...f.context, executable: process.execPath }),
    ).rejects.toMatchObject({
      exitStatus: LAUNCHER_EXIT_STATUS.updateFailure,
    });
    f.setVersion("0.0.9");
    expect(await installUpdate(f.context)).toBeUndefined();
    expect(await Bun.file(f.paths.managedBinary).text()).toBe(oldBinary);
  });

  test("fails instead of replacing a binary whose installed version cannot be determined", async () => {
    for (const installed of ["#!/bin/sh\nexit 1\n", "#!/bin/sh\nprintf 'not-a-version\\n'\n"]) {
      const f = await fixture();
      await Bun.write(f.paths.managedBinary, installed);
      await expect(installUpdate(f.context)).rejects.toMatchObject({
        exitStatus: LAUNCHER_EXIT_STATUS.updateFailure,
      });
      expect(await Bun.file(f.paths.managedBinary).text()).toBe(installed);
      expect(f.requests.some((path) => path.endsWith(assets.archive) || path === "/archive")).toBe(
        false,
      );
    }
  });

  test("refuses to install a release built for another architecture", async () => {
    const f = await fixture();
    const otherTarget = RELEASE_TARGETS.find((candidate) => candidate !== target);
    await expect(
      installUpdate({ ...f.context, build: { ...f.context.build, target: String(otherTarget) } }),
    ).rejects.toMatchObject({ exitStatus: LAUNCHER_EXIT_STATUS.updateFailure });
    expect(f.requests).toEqual([]);
    expect(await Bun.file(f.paths.managedBinary).text()).toBe(oldBinary);
  });

  test("background worker verifies once and respects the check interval", async () => {
    const f = await fixture();
    const ciVariable = "CI";
    const oldCI = process.env[ciVariable];
    delete process.env[ciVariable];
    try {
      await runBackgroundUpdate(f.context);
      expect(await Bun.file(f.paths.managedBinary).text()).toContain(version);
      expect((await stat(f.paths.updateState)).mode & 0o077).toBe(0);
      const count = f.requests.length;
      await runBackgroundUpdate({ ...f.context, executable: f.paths.managedBinary });
      expect(f.requests.length).toBe(count);
    } finally {
      if (oldCI !== undefined) process.env[ciVariable] = oldCI;
    }
  });
  test("a worker that loses the lock defers further workers instead of leaving the check due", async () => {
    const f = await fixture();
    const ciVariable = "CI";
    const oldCI = process.env[ciVariable];
    delete process.env[ciVariable];
    await mkdir(f.paths.locks, { recursive: true, mode: 0o700 });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = () => {};
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    // A foreground `axon update` holds the lock for its whole download and writes no state.
    const other = withFileLock(join(f.paths.locks, "update.lock"), async () => {
      acquired();
      await held;
    });
    await ready;
    try {
      const startedAt = Date.now();
      await runBackgroundUpdate(f.context);
      const { nextCheckAt } = await Bun.file(f.paths.updateState).json();
      expect(nextCheckAt).toBeGreaterThan(startedAt);
      expect(nextCheckAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
      const spawned: (readonly string[])[] = [];
      await scheduleBackgroundUpdate(["--mode", "rpc"], {
        build: f.context.build,
        environment: {},
        invocation: { ci: false, stdinIsTty: false, stdoutIsTty: false },
        paths: f.paths,
        spawn: (command) => spawned.push(command),
      });
      expect(spawned).toEqual([]);
      expect(f.requests).toEqual([]);

      // A later deadline, such as the holder's own 24-hour throttle, is never shortened.
      const later = Date.now() + 86_400_000;
      await Bun.write(f.paths.updateState, JSON.stringify({ nextCheckAt: later }));
      await runBackgroundUpdate(f.context);
      expect((await Bun.file(f.paths.updateState).json()).nextCheckAt).toBe(later);
    } finally {
      release();
      await other;
      if (oldCI !== undefined) process.env[ciVariable] = oldCI;
    }
  });
});

describe("background update scheduling", () => {
  const piped = { ci: false, stdinIsTty: false, stdoutIsTty: false };
  const build: BuildInfo = { ...BUILD_INFO, kind: "binary", target };

  async function schedule(
    args: readonly string[],
    invocation = piped,
    environment: NodeJS.ProcessEnv = {},
    buildInfo = build,
    paths = resolveAxonPaths({}, join(tmpdir(), `axon-schedule-missing-${crypto.randomUUID()}`)),
  ): Promise<(readonly string[])[]> {
    const spawned: (readonly string[])[] = [];
    await scheduleBackgroundUpdate(args, {
      build: buildInfo,
      environment,
      invocation,
      paths,
      spawn: (command) => spawned.push(command),
    });
    return spawned;
  }

  test("spawns the detached worker for RPC, JSON, print, and piped launches", async () => {
    for (const args of [["--mode", "rpc"], ["--mode", "json", "hi"], ["-p", "hi"], []]) {
      expect(await schedule(args)).toEqual([[process.execPath, "__background-update"]]);
    }
    expect(await schedule(["--mode", "rpc"], interactive)).toHaveLength(1);
  });

  test("skips interactive, administrative, offline, opted-out, CI, and source launches", async () => {
    expect(await schedule([], interactive)).toEqual([]);
    for (const args of [["--help"], ["--version"], ["auth"], ["--mode", "rpc", "--offline"]]) {
      expect(await schedule(args)).toEqual([]);
    }
    expect(await schedule(["--mode", "rpc"], piped, { AXON_NO_UPDATE: "1" })).toEqual([]);
    expect(await schedule(["--mode", "rpc"], piped, { PI_OFFLINE: "1" })).toEqual([]);
    expect(await schedule(["--mode", "rpc"], { ...piped, ci: true })).toEqual([]);
    expect(await schedule(["--mode", "rpc"], piped, {}, { ...build, kind: "dev" })).toEqual([]);
  });

  test("does not start a worker while the check interval has not elapsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-schedule-"));
    roots.push(root);
    const paths = resolveAxonPaths({}, root);
    await Bun.write(paths.updateState, JSON.stringify({ nextCheckAt: Date.now() + 60_000 }));
    expect(await schedule(["--mode", "rpc"], piped, {}, build, paths)).toEqual([]);
    await Bun.write(paths.updateState, JSON.stringify({ nextCheckAt: Date.now() - 1 }));
    expect(await schedule(["--mode", "rpc"], piped, {}, build, paths)).toHaveLength(1);
  });

  test("a failing spawn never affects the launch", async () => {
    expect(
      await scheduleBackgroundUpdate(["--mode", "rpc"], {
        build,
        environment: {},
        invocation: piped,
        paths: resolveAxonPaths({}, join(tmpdir(), `axon-schedule-missing-${crypto.randomUUID()}`)),
        spawn: () => {
          throw new Error("spawn failed");
        },
      }),
    ).toBe(false);
  });
});

describe("automatic update gate", () => {
  const build: BuildInfo = { ...BUILD_INFO, kind: "binary", target };

  test("scheduler, startup, and worker share one CI and opt-out interpretation", () => {
    expect(automaticUpdatesAllowed(build, {})).toBe(true);
    for (const ci of ["0", "false", "no", ""]) {
      expect(automaticUpdatesAllowed(build, { CI: ci })).toBe(true);
    }
    for (const ci of ["1", "true", "TRUE", "yes"]) {
      expect(automaticUpdatesAllowed(build, { CI: ci })).toBe(false);
    }
    expect(automaticUpdatesAllowed(build, { AXON_NO_UPDATE: "1" })).toBe(false);
    expect(automaticUpdatesAllowed({ ...build, kind: "dev" }, {})).toBe(false);
  });
});

describe("release checksums", () => {
  test.each([...RELEASE_TARGETS])(
    "reads only %s hashes from its own checksum file",
    async (name) => {
      const names = releaseAssetNames(name);
      const archive = "a".repeat(64);
      const binary = "b".repeat(64);
      const requests: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request): Response {
          const path = new URL(request.url).pathname;
          requests.push(path);
          if (path === `/${version}/${names.checksums}`)
            return new Response(formatReleaseChecksums(name, archive, binary));
          return new Response("not found", { status: 404 });
        },
      });
      servers.push(server);
      const client = { baseUrl: `http://127.0.0.1:${server.port}` };
      expect(await releaseHashes(client, version, name)).toEqual({ archive, binary });
      expect(requests).toEqual([`/${version}/${names.checksums}`]);
      const otherTarget = RELEASE_TARGETS.find((candidate) => candidate !== name);
      await expect(releaseHashes(client, version, otherTarget ?? name)).rejects.toThrow();
    },
  );
});
