import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editFilesystemPreferences,
  type FilesystemPreferences,
  validateFilesystemPreferences,
} from "../src/axon-safehouse/filesystem.ts";
import { installedPackagePaths, type PackageScanCache } from "../src/axon-safehouse/packages.ts";
import type { AxonSafehousePolicy } from "../src/axon-safehouse/policy.ts";
import { startAuthenticatedRequestRelay } from "../src/cli/auth/request-relay.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "axon-safehouse-fs-")));
});
afterEach(async () => {
  await chmod(join(root, "project", "locked"), 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

function preferences(overrides: Partial<FilesystemPreferences> = {}): FilesystemPreferences {
  return {
    schemaVersion: 1,
    projectMode: "read-write",
    readPaths: [],
    writePaths: [],
    denyPaths: [],
    ...overrides,
  };
}

describe("Axon Safehouse package scan", () => {
  test("workspace links stay editable while external package links stay protected", async () => {
    const project = join(root, "project");
    const library = join(project, "packages", "lib");
    const external = join(root, "global-store", "tool");
    await mkdir(join(project, "node_modules", "@org"), { recursive: true });
    await mkdir(library, { recursive: true });
    await mkdir(external, { recursive: true });
    await symlink(library, join(project, "node_modules", "@org", "lib"));
    await symlink(project, join(project, "node_modules", "self"));
    await symlink(external, join(project, "node_modules", "tool"));

    const protectedPaths = await installedPackagePaths(join(root, "home"), [project]);

    expect(protectedPaths).toContain(join(project, "node_modules"));
    expect(protectedPaths).toContain(external);
    expect(protectedPaths).not.toContain(library);
    expect(protectedPaths).not.toContain(project);
  });

  test("skips unreadable directories instead of failing the launch", async () => {
    const project = join(root, "project");
    await mkdir(join(project, "locked", "data"), { recursive: true });
    await mkdir(join(project, "app", "node_modules"), { recursive: true });
    await chmod(join(project, "locked"), 0o000);

    const protectedPaths = await installedPackagePaths(join(root, "home"), [project]);

    expect(protectedPaths).toContain(join(project, "app", "node_modules"));
  });

  test("shares one scan per root set until the cache is cleared", async () => {
    const project = join(root, "project");
    await mkdir(join(project, "a", "node_modules"), { recursive: true });
    const cache: PackageScanCache = new Map();

    const first = await installedPackagePaths(join(root, "home"), [project], cache);
    await mkdir(join(project, "b", "vendor"), { recursive: true });
    expect(await installedPackagePaths(join(root, "home"), [project], cache)).toEqual(first);
    expect(cache.size).toBe(1);

    cache.clear();
    expect(await installedPackagePaths(join(root, "home"), [project], cache)).toContain(
      join(project, "b", "vendor"),
    );
  });
});

describe("Axon Safehouse filesystem grants", () => {
  test("a granted path deleted after approval no longer breaks validation", async () => {
    const paths = resolveAxonPaths({ HOME: join(root, "home") });
    const project = join(root, "project");
    const build = join(root, "other", "build");
    await mkdir(project, { recursive: true });
    await mkdir(build, { recursive: true });
    const approved = await validateFilesystemPreferences(
      paths,
      project,
      preferences({ writePaths: [build] }),
    );
    await rm(build, { recursive: true });

    expect(await validateFilesystemPreferences(paths, project, approved)).toEqual(approved);
    // Editing an unrelated rule re-validates the whole draft and must still succeed.
    const extra = join(root, "docs");
    await mkdir(extra);
    const edited = await editFilesystemPreferences(paths, project, approved, "allow-read", extra);
    expect(edited.writePaths).toEqual([build]);
    expect(edited.readPaths).toEqual([extra]);
  });

  test("a new grant must exist when it is added", async () => {
    const paths = resolveAxonPaths({ HOME: join(root, "home") });
    const project = join(root, "project");
    await mkdir(project, { recursive: true });

    await expect(
      editFilesystemPreferences(
        paths,
        project,
        preferences(),
        "allow-write",
        join(root, "typo-path"),
      ),
    ).rejects.toThrow("This path does not exist");
  });
});

describe("Axon Safehouse configuration relay", () => {
  test("the editor endpoints are unavailable without the invocation's policy check", async () => {
    const paths = resolveAxonPaths({ HOME: join(root, "home") });
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    const status = async (options: Parameters<typeof startAuthenticatedRequestRelay>[1]) => {
      const relay = startAuthenticatedRequestRelay(paths, options);
      try {
        const response = await fetch(`${relay.origin}/_axon/axon-safehouse/status`, {
          headers: { authorization: `Bearer ${relay.capability}` },
        });
        await response.body?.cancel();
        return response.status;
      } finally {
        relay.dispose();
      }
    };

    expect(await status({ cwd: project, allowAxonSafehouseConfiguration: true })).toBe(404);
    expect(
      await status({
        cwd: project,
        allowAxonSafehouseConfiguration: true,
        axonSafehouseConfigurationPolicy: async () => ({}) as AxonSafehousePolicy,
      }),
    ).toBe(200);
  });
});
