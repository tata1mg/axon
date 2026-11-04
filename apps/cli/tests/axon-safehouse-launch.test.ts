import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AxonSafehouseResources,
  createAxonSafehouseLaunchSpec,
} from "../src/axon-safehouse/launch.ts";
import type { AxonSafehouseAuthorization } from "../src/axon-safehouse/policy.ts";
import type { LaunchSpec } from "../src/launcher/contracts.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let root: string;
let resources: AxonSafehouseResources;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "axon-safehouse-launch-")));
  const runDirectory = join(root, "run");
  const temporary = join(runDirectory, "tmp");
  const gitBin = join(runDirectory, "git-bin");
  await mkdir(temporary, { recursive: true });
  await mkdir(gitBin, { recursive: true });
  await symlink("/usr/bin/git", join(gitBin, "git"));
  resources = {
    // Test only: a permissive baseline so the Axon rules alone decide file access.
    baseline: "(version 1)\n(allow default)",
    runDirectory,
    temporary,
    gitBin,
    proxy: {
      origin: "http://127.0.0.1:9",
      authenticatedUrl: "http://axon:test@127.0.0.1:9",
      authenticatedProvisioningUrl: "http://axon:provision@127.0.0.1:9",
      sshTunnels: [],
      dispose() {},
    },
    certificateEnvironment: {},
    packageScans: new Map(),
    dispose() {},
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const authorization: AxonSafehouseAuthorization = {
  expiresAt: Date.now() + 3_600_000,
  policy: {
    schemaVersion: 1,
    required: true,
    engine: "safehouse",
    policyId: "test",
    maxSessionSeconds: 3_600,
    network: "relay-and-package-proxy",
    remoteGit: false,
    remoteGitHosts: [],
    localGit: "read-only",
    allowAdditionalReadPaths: true,
    allowAdditionalWritePaths: true,
    packageRegistryHosts: [],
    packageGitHosts: [],
    protectedPaths: [],
  },
};

async function administration(cwd: string) {
  const paths = resolveAxonPaths({ HOME: join(root, "home") });
  await mkdir(paths.pi, { recursive: true });
  const specification: LaunchSpec = {
    executable: "/usr/bin/true",
    arguments: [],
    cwd,
    environment: { PATH: "/usr/bin:/bin" },
  };
  const writePaths = [paths.pi, join(cwd, ".pi")].flatMap((base) =>
    ["npm", "git", "settings.json", "settings.json.lock"].map((entry) => join(base, entry)),
  );
  const wrapped = await createAxonSafehouseLaunchSpec(specification, paths, authorization, {
    purpose: "administration",
    writePaths,
    resources,
  });
  const profilePath = wrapped.arguments[1];
  if (!profilePath) throw new Error("missing profile");
  return { paths, wrapped, profile: await Bun.file(profilePath).text() };
}

describe("Axon Safehouse package administration", () => {
  test("global package commands from home run without project access", async () => {
    const home = await realpath(homedir());
    const { paths, wrapped, profile } = await administration(home);

    // The real sandbox-exec probe compiled this profile; Pi starts in a private directory.
    expect(wrapped.cwd).toBe(await realpath(resources.temporary));
    expect(profile).not.toContain(`(subpath ${JSON.stringify(home)})`);
    expect(profile).not.toContain(JSON.stringify(join(home, ".pi")));
    // Grants are wrapped in require-all/require-not clauses, so match the granted subpaths.
    expect(profile).toContain(`(subpath ${JSON.stringify(join(await realpath(paths.pi), "npm"))})`);
  });

  test("package commands inside a project keep local .pi provisioning", async () => {
    const project = join(root, "project");
    await mkdir(project);
    const { wrapped, profile } = await administration(project);

    expect(wrapped.cwd).toBe(project);
    expect(profile).toContain(`(subpath ${JSON.stringify(project)})`);
    expect(profile).toContain(`(subpath ${JSON.stringify(join(project, ".pi", "npm"))})`);
  });
});
