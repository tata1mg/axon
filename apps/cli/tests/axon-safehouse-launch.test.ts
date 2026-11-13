import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  await mkdir(temporary, { recursive: true });
  resources = {
    // Test only: a permissive baseline so the Axon rules alone decide file access.
    baseline: "(version 1)\n(allow default)",
    runDirectory,
    temporary,
    networkProxies: new Map(),
    certificateEnvironment: {},
    packageScans: new Map(),
    dispose() {},
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const authorization: AxonSafehouseAuthorization = {
  policy: {
    schemaVersion: 1,
    required: true,
    engine: "safehouse",
    policyId: "test",
    allowAdditionalReadPaths: true,
    allowAdditionalWritePaths: true,
    protectedPaths: [],
    readPaths: [],
    writePaths: [],
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

  test("launches from a repository subdirectory grant the checkout and its Git metadata", async () => {
    const repository = join(root, "repository");
    const subdirectory = join(repository, "packages", "foo");
    await mkdir(join(repository, ".git"), { recursive: true });
    await mkdir(subdirectory, { recursive: true });
    const { wrapped, profile } = await administration(subdirectory);

    // Pi still starts where the user launched it, and local .pi stays there.
    expect(wrapped.cwd).toBe(subdirectory);
    expect(profile).toContain(`(subpath ${JSON.stringify(repository)})`);
    expect(profile).toContain(JSON.stringify(join(repository, ".git")));
    expect(profile).toContain(`(subpath ${JSON.stringify(join(subdirectory, ".pi", "npm"))})`);
    expect(profile).not.toContain(JSON.stringify(join(repository, ".pi", "npm")));
  });
});

describe("Axon Safehouse backend filesystem grants", () => {
  async function launch(
    purpose: "session" | "operation" | "administration" | "provision",
    policy: Partial<AxonSafehouseAuthorization["policy"]>,
    environment: Record<string, string> = {},
  ) {
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    const paths = resolveAxonPaths({ HOME: join(root, "home") });
    await mkdir(paths.pi, { recursive: true });
    const wrapped = await createAxonSafehouseLaunchSpec(
      {
        executable: "/usr/bin/true",
        arguments: [],
        cwd: project,
        environment: { PATH: "/usr/bin:/bin", ...environment },
      },
      paths,
      { policy: { ...authorization.policy, ...policy } },
      { purpose, resources },
    );
    const profilePath = wrapped.arguments[1];
    if (!profilePath) throw new Error("missing profile");
    return (await Bun.file(profilePath).text()).split("\n");
  }
  // Grants are rewritten to (allow op (require-all (require-any (subpath P)) exclusions...)).
  function grant(profile: string[], operation: string, path: string): string | undefined {
    const prefix = `(allow ${operation} (require-all (require-any (subpath ${JSON.stringify(path)}))`;
    return profile.find((rule) => rule.startsWith(prefix));
  }
  async function directories() {
    const shared = join(root, "shared");
    const output = join(root, "output");
    await mkdir(shared, { recursive: true });
    await mkdir(output, { recursive: true });
    return { shared, output, policy: { readPaths: [shared], writePaths: [output] } };
  }
  const brokered = {
    PI_AXON_AUTH_RELAY_URL: "http://127.0.0.1:12345",
    PI_AXON_SAFEHOUSE_OPERATIONS: "1",
  };

  test("operations get backend read-only and read/write grants", async () => {
    const { shared, output, policy } = await directories();
    const profile = await launch("operation", policy);

    expect(grant(profile, "file-read*", shared)).toBeDefined();
    expect(grant(profile, "file-write*", shared)).toBeUndefined();
    expect(grant(profile, "file-read*", output)).toBeDefined();
    expect(grant(profile, "file-write*", output)).toBeDefined();
  });

  test("backend read paths are plain grants, not write ceilings", async () => {
    const { shared, output, policy } = await directories();
    const profile = await launch("operation", policy);

    // A write grant elsewhere is never narrowed by a backend read-only path.
    expect(grant(profile, "file-write*", output)).not.toContain(
      `(require-not (subpath ${JSON.stringify(shared)}))`,
    );
  });

  test("brokered sessions and administration downgrade backend write paths to read-only", async () => {
    for (const [purpose, environment] of [
      ["session", brokered],
      ["administration", {}],
    ] as const) {
      const { output, policy } = await directories();
      const profile = await launch(purpose, policy, environment);
      expect(grant(profile, "file-read*", output)).toBeDefined();
      expect(grant(profile, "file-write*", output)).toBeUndefined();
    }
  });

  test("provisioning never receives backend grants", async () => {
    const { shared, output, policy } = await directories();
    const profile = await launch("provision", policy);

    expect(grant(profile, "file-read*", shared)).toBeUndefined();
    expect(grant(profile, "file-read*", output)).toBeUndefined();
  });

  test("protected paths and installed packages stay excluded from backend write grants", async () => {
    const { output, policy } = await directories();
    const secret = join(output, "secret");
    await mkdir(secret);
    await mkdir(join(output, "node_modules", "left-pad"), { recursive: true });
    await Bun.write(join(output, "node_modules", "left-pad", "package.json"), "{}");
    const profile = await launch("operation", { ...policy, protectedPaths: [secret] });

    const write = grant(profile, "file-write*", output);
    expect(write).toContain(`(require-not (subpath ${JSON.stringify(secret)}))`);
    expect(write).toContain(
      `(require-not (subpath ${JSON.stringify(join(output, "node_modules"))}))`,
    );
    expect(grant(profile, "file-read*", output)).toContain(
      `(require-not (subpath ${JSON.stringify(secret)}))`,
    );
  });

  test("Git metadata follows the backend grant's access", async () => {
    const { shared, output, policy } = await directories();
    await mkdir(join(shared, ".git"));
    await mkdir(join(output, ".git"));
    const profile = await launch("operation", policy);

    expect(grant(profile, "file-write*", join(output, ".git"))).toBeDefined();
    expect(grant(profile, "file-read*", join(shared, ".git"))).toBeDefined();
    expect(grant(profile, "file-write*", join(shared, ".git"))).toBeUndefined();
  });

  test("grants of the filesystem root or home directory are rejected", async () => {
    for (const policy of [
      { readPaths: ["/"] },
      { writePaths: ["~/"] },
      { readPaths: [dirname(homedir())] },
    ]) {
      await expect(launch("operation", policy)).rejects.toThrow("root or home directory");
    }
  });
});
