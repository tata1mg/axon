import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareLaunchArguments } from "../src/cli/dispatch.ts";
import { ignoreOfflineRequest } from "../src/harnesses/pi/setup/packages/invocation.ts";
import { ensurePiWrapper, piWrapperScript } from "../src/launcher/pi-wrapper.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let fixtureDirectory: string;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "axon-pi-wrapper-"));
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function fixturePaths(name: string) {
  const paths = resolveAxonPaths({ HOME: join(fixtureDirectory, name) });
  await mkdir(paths.bin, { recursive: true });
  return paths;
}

describe("Pi wrapper", () => {
  test("is created next to the managed binary and forwards every argument to axon pi", async () => {
    const paths = await fixturePaths("forward");
    // Stand-in for the managed binary: echo its arguments one per line.
    await writeFile(paths.managedBinary, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', {
      mode: 0o755,
    });

    expect(paths.piWrapper).toBe(join(paths.bin, "axon-pi"));
    expect(await ensurePiWrapper(paths)).toBe(true);
    expect((await stat(paths.piWrapper)).mode & 0o777).toBe(0o755);

    const child = Bun.spawn([paths.piWrapper, "--mode", "rpc", "a b", "--", "$HOME"], {
      stdout: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).split("\n")).toEqual([
      "pi",
      "--mode",
      "rpc",
      "a b",
      "--",
      "$HOME",
      "",
    ]);
  });

  test("is left alone when current and repaired when changed", async () => {
    const paths = await fixturePaths("repair");
    expect(await ensurePiWrapper(paths)).toBe(true);
    expect(await ensurePiWrapper(paths)).toBe(false);

    await writeFile(paths.piWrapper, "#!/bin/sh\nexit 1\n");
    expect(await ensurePiWrapper(paths)).toBe(true);
    expect(await readFile(paths.piWrapper, "utf8")).toBe(piWrapperScript(paths.managedBinary));

    await chmod(paths.piWrapper, 0o644);
    expect(await ensurePiWrapper(paths)).toBe(true);
    expect((await stat(paths.piWrapper)).mode & 0o777).toBe(0o755);
  });

  test("quotes managed binary paths for the shell", () => {
    expect(piWrapperScript("/home/o'neil $x/bin/axon")).toContain(
      `exec '/home/o'\\''neil $x/bin/axon' pi "$@"`,
    );
  });
});

describe("AXON_IGNORE_OFFLINE", () => {
  test("is a no-op unless enabled", () => {
    const environment: NodeJS.ProcessEnv = { PI_OFFLINE: "1" };
    const args = ["--mode", "rpc", "--offline"];
    expect(ignoreOfflineRequest(environment, args)).toBe(args);
    expect(environment["PI_OFFLINE"]).toBe("1");

    const disabled: NodeJS.ProcessEnv = { AXON_IGNORE_OFFLINE: "0", PI_OFFLINE: "1" };
    expect(ignoreOfflineRequest(disabled, args)).toBe(args);
    expect(disabled["PI_OFFLINE"]).toBe("1");
  });

  test("drops --offline options and PI_OFFLINE but keeps message text after --", () => {
    const environment: NodeJS.ProcessEnv = { AXON_IGNORE_OFFLINE: "true", PI_OFFLINE: "1" };
    expect(
      ignoreOfflineRequest(environment, [
        "--mode",
        "rpc",
        "--offline",
        "--no-session",
        "--offline",
        "--",
        "--offline",
      ]),
    ).toEqual(["--mode", "rpc", "--no-session", "--", "--offline"]);
    expect(environment["PI_OFFLINE"]).toBeUndefined();
  });

  test("applies only to harness launches", () => {
    const environment: NodeJS.ProcessEnv = { AXON_IGNORE_OFFLINE: "1", PI_OFFLINE: "1" };
    expect(prepareLaunchArguments(["setup", "pi", "--offline"], environment)).toEqual([
      "setup",
      "pi",
      "--offline",
    ]);
    expect(environment["PI_OFFLINE"]).toBe("1");

    expect(prepareLaunchArguments(["pi", "--mode", "rpc", "--offline"], environment)).toEqual([
      "pi",
      "--mode",
      "rpc",
    ]);
    expect(environment["PI_OFFLINE"]).toBeUndefined();
  });
});
