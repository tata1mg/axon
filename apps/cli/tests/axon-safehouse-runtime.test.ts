import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkVendoredSafehouse, updateVendoredSafehouse } from "../scripts/update-safehouse.ts";
import {
  BUNDLED_SAFEHOUSE_PATH,
  ensureSafehouseRuntime,
  generateSafehousePolicy,
  SAFEHOUSE_MAX_BYTES,
  SAFEHOUSE_SHA256,
  SAFEHOUSE_VERSION,
} from "../src/axon-safehouse/runtime.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const projectRoot = resolve(import.meta.dir, "..");
const sha256 = (content: Uint8Array | string) => createHash("sha256").update(content).digest("hex");

let root: string;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-safehouse-runtime-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(root, { force: true, recursive: true });
});

function runtimePath(paths: ReturnType<typeof resolveAxonPaths>): string {
  return join(paths.home, "axon-safehouse", "runtime", SAFEHOUSE_VERSION, "safehouse.sh");
}

describe("bundled Agent Safehouse runtime", () => {
  test("the vendored script matches the pinned version and digest", async () => {
    const content = await Bun.file(BUNDLED_SAFEHOUSE_PATH).bytes();
    expect(content.byteLength).toBeLessThanOrEqual(SAFEHOUSE_MAX_BYTES);
    expect(sha256(content)).toBe(SAFEHOUSE_SHA256);
    expect(new TextDecoder().decode(content)).toContain(
      `safehouse_project_version_embedded="${SAFEHOUSE_VERSION}"`,
    );
  });

  test("materializes the bundled runtime without any network access", async () => {
    globalThis.fetch = (() => {
      throw new Error("Safehouse runtime must not use the network");
    }) as unknown as typeof fetch;
    const paths = resolveAxonPaths({ AXON_HOME: join(root, "home"), HOME: root });

    const executable = await ensureSafehouseRuntime(paths);
    expect(executable).toBe(runtimePath(paths));
    expect((await stat(executable)).mode & 0o777).toBe(0o500);
    expect(sha256(await Bun.file(executable).bytes())).toBe(SAFEHOUSE_SHA256);

    // A verified cached copy is reused as-is.
    const { mtimeMs } = await stat(executable);
    expect(await ensureSafehouseRuntime(paths)).toBe(executable);
    expect((await stat(executable)).mtimeMs).toBe(mtimeMs);
  });

  test("fails closed when the cached runtime was tampered with", async () => {
    const paths = resolveAxonPaths({ AXON_HOME: join(root, "home"), HOME: root });
    const executable = runtimePath(paths);
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, "#!/usr/bin/env bash\necho tampered\n", { mode: 0o500 });

    await expect(ensureSafehouseRuntime(paths)).rejects.toThrow(
      "Safehouse runtime integrity verification failed",
    );
  });

  test("refuses a symlink in place of the cached runtime", async () => {
    const paths = resolveAxonPaths({ AXON_HOME: join(root, "home"), HOME: root });
    const executable = runtimePath(paths);
    await mkdir(join(executable, ".."), { recursive: true });
    await symlink(BUNDLED_SAFEHOUSE_PATH, executable);

    await expect(ensureSafehouseRuntime(paths)).rejects.toThrow(
      "Safehouse runtime could not be read safely",
    );
  });

  test.skipIf(process.platform !== "darwin")(
    "the bundled runtime generates a Seatbelt policy",
    async () => {
      const paths = resolveAxonPaths({ AXON_HOME: join(root, "home"), HOME: root });
      const executable = await ensureSafehouseRuntime(paths);
      const temporary = join(root, "policy");
      await mkdir(temporary);
      expect(await generateSafehousePolicy(executable, root, temporary)).toContain("(version 1)");
    },
  );
});

describe("safehouse vendoring script", () => {
  async function fixtureRepository(): Promise<string> {
    const repository = join(root, "repository");
    await mkdir(join(repository, "src", "axon-safehouse"), { recursive: true });
    await cp(
      join(projectRoot, "src", "axon-safehouse", "runtime.ts"),
      join(repository, "src", "axon-safehouse", "runtime.ts"),
    );
    await cp(
      join(projectRoot, "src", "axon-safehouse", "vendor"),
      join(repository, "src", "axon-safehouse", "vendor"),
      { recursive: true },
    );
    return repository;
  }

  test("check accepts the committed vendored files", async () => {
    await expect(checkVendoredSafehouse({ repositoryRoot: projectRoot })).resolves.toBeUndefined();
  });

  test("check rejects a vendored script that does not match the pinned digest", async () => {
    const repository = await fixtureRepository();
    const script = join(repository, "src", "axon-safehouse", "vendor", "safehouse.sh");
    await writeFile(script, `${await Bun.file(script).text()}\n# edited\n`);

    await expect(checkVendoredSafehouse({ repositoryRoot: repository })).rejects.toThrow(
      "does not match SAFEHOUSE_SHA256",
    );
  });

  test("update refuses an asset that does not match the GitHub release digest", async () => {
    const repository = await fixtureRepository();
    const runtimeSource = join(repository, "src", "axon-safehouse", "runtime.ts");
    const before = await Bun.file(runtimeSource).text();
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return Response.json({
          assets: [
            {
              name: "safehouse.sh",
              digest: `sha256:${"0".repeat(64)}`,
              browser_download_url:
                "https://github.com/eugene1g/agent-safehouse/releases/download/v9.9.9/safehouse.sh",
            },
          ],
        });
      }
      return new Response('#!/usr/bin/env bash\nsafehouse_project_version_embedded="9.9.9"\n');
    }) as unknown as typeof fetch;

    await expect(
      updateVendoredSafehouse("9.9.9", { repositoryRoot: repository, fetch: fakeFetch }),
    ).rejects.toThrow("does not match the GitHub release digest");
    expect(await Bun.file(runtimeSource).text()).toBe(before);
  });
});
