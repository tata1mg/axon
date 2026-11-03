import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NPM_MIRROR_REGISTRY,
  NPM_PUBLIC_REGISTRY,
  NpmInstallFailure,
  withNpmRegistryFallback,
} from "../src/harnesses/pi/npm-registry.ts";

const roots: string[] = [];

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "axon-npm-registry-"));
  roots.push(cwd);
  const npmPath = join(cwd, "fake npm");
  await writeFile(
    npmPath,
    `#!/usr/bin/env -S bun --no-env-file
const [action, subcommand, key] = process.argv.slice(2);
if (action !== "config" || subcommand !== "get") process.exit(9);
console.log(key === "registry" ? process.env.FAKE_REGISTRY : (process.env.FAKE_SCOPE_REGISTRY ?? "undefined"));
`,
  );
  await chmod(npmPath, 0o755);
  const environment: NodeJS.ProcessEnv = {
    HOME: cwd,
    PATH: process.env["PATH"],
    FAKE_REGISTRY: NPM_PUBLIC_REGISTRY,
  };
  return { cwd, npmPath, environment };
}

function unavailable(output = "npm error code ECONNRESET") {
  return new NpmInstallFailure(1, output);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed npm registry fallback", () => {
  for (const [primary, fallback] of [
    [NPM_PUBLIC_REGISTRY, "https://registry.yarnpkg.com/"],
    ["https://registry.yarnpkg.com/", NPM_PUBLIC_REGISTRY],
    ["https://registry.npmmirror.com/", NPM_PUBLIC_REGISTRY],
  ] as const) {
    test(`tries ${primary} then ${fallback} without changing inherited config`, async () => {
      const context = await fixture();
      context.environment["NPM_CONFIG_REGISTRY"] = primary.replace(/\/$/, "");
      const original = { ...context.environment };
      const attempts: NodeJS.ProcessEnv[] = [];
      const result = await withNpmRegistryFallback(context, async (environment) => {
        attempts.push(environment);
        if (attempts.length === 1) throw unavailable();
        return "installed";
      });
      expect(result).toBe("installed");
      expect(attempts[0]).toBe(context.environment);
      expect(attempts[1]?.["npm_config_registry"]).toBe(fallback);
      expect(attempts[1]?.["NPM_CONFIG_REGISTRY"]).toBeUndefined();
      expect(context.environment).toEqual(original);
    });
  }

  test("keeps the primary on success and preserves .npmrc", async () => {
    const context = await fixture();
    const configPath = join(context.cwd, ".npmrc");
    const config = `registry=${NPM_MIRROR_REGISTRY}\n`;
    await writeFile(configPath, config);
    context.environment["FAKE_REGISTRY"] = NPM_MIRROR_REGISTRY;
    let attempts = 0;
    await withNpmRegistryFallback(context, async (environment) => {
      attempts += 1;
      expect(environment).toBe(context.environment);
      expect(environment["npm_config_registry"]).toBeUndefined();
    });
    expect(attempts).toBe(1);
    expect(await readFile(configPath, "utf8")).toBe(config);
  });

  test("uses npm config get when the registry is not in the environment", async () => {
    const context = await fixture();
    context.environment["FAKE_REGISTRY"] = NPM_MIRROR_REGISTRY;
    const registries: (string | undefined)[] = [];
    await withNpmRegistryFallback(context, async (environment) => {
      registries.push(environment["npm_config_registry"]);
      if (registries.length === 1) throw unavailable("npm error code ETARGET");
    });
    expect(registries).toEqual([undefined, NPM_PUBLIC_REGISTRY]);
  });

  test("respects public scoped registries and overrides them only for the retry", async () => {
    const context = await fixture();
    context.environment["FAKE_SCOPE_REGISTRY"] = NPM_MIRROR_REGISTRY;
    context.environment["NPM_CONFIG_@EXAMPLE:REGISTRY"] = NPM_MIRROR_REGISTRY;
    let attempts = 0;
    await withNpmRegistryFallback({ ...context, scope: "@example" }, async (environment) => {
      attempts += 1;
      if (attempts === 1) throw unavailable("npm error code E404");
      expect(environment["npm_config_registry"]).toBe(NPM_PUBLIC_REGISTRY);
      expect(environment["npm_config_@example:registry"]).toBe(NPM_PUBLIC_REGISTRY);
      expect(environment["NPM_CONFIG_@EXAMPLE:REGISTRY"]).toBeUndefined();
    });
    expect(attempts).toBe(2);
  });

  test("does not send custom, authenticated, or private scoped registries to a public fallback", async () => {
    for (const registry of [
      "https://private.example/",
      "https://registry.npmjs.org/custom/",
      "https://token@registry.npmjs.org/",
      "http://registry.npmjs.org/",
    ]) {
      const context = await fixture();
      context.environment["npm_config_registry"] = registry;
      let attempts = 0;
      const error = unavailable();
      await expect(
        withNpmRegistryFallback(context, async () => {
          attempts += 1;
          throw error;
        }),
      ).rejects.toBe(error);
      expect(attempts).toBe(1);
    }
    const context = await fixture();
    context.environment["FAKE_SCOPE_REGISTRY"] = "https://private.example/";
    let attempts = 0;
    await expect(
      withNpmRegistryFallback({ ...context, scope: "@private" }, async () => {
        attempts += 1;
        throw unavailable();
      }),
    ).rejects.toBeInstanceOf(NpmInstallFailure);
    expect(attempts).toBe(1);

    // A public scope must not override a private default used by its dependencies.
    context.environment["FAKE_SCOPE_REGISTRY"] = NPM_MIRROR_REGISTRY;
    context.environment["npm_config_registry"] = "https://private.example/";
    attempts = 0;
    await expect(
      withNpmRegistryFallback({ ...context, scope: "@public" }, async () => {
        attempts += 1;
        throw unavailable();
      }),
    ).rejects.toBeInstanceOf(NpmInstallFailure);
    expect(attempts).toBe(1);
  });

  test("does not retry local, auth, script, integrity, cancellation, or spawn failures", async () => {
    const context = await fixture();
    context.environment["npm_config_registry"] = NPM_PUBLIC_REGISTRY;
    for (const error of [
      unavailable("npm error code EACCES"),
      unavailable("npm error code EINTEGRITY"),
      unavailable("npm error code ERESOLVE"),
      unavailable("npm error code E401"),
      unavailable("npm error code E403"),
      unavailable("npm error code ENOSPC"),
      unavailable("postinstall: ETIMEDOUT\nnpm error command failed"),
      unavailable("unknown error"),
      new NpmInstallFailure(130, "npm error code ECONNRESET"),
      new Error("npm ci terminated by signal SIGTERM ECONNRESET"),
      new Error("spawn npm ENOENT"),
    ]) {
      let attempts = 0;
      await expect(
        withNpmRegistryFallback(context, async () => {
          attempts += 1;
          throw error;
        }),
      ).rejects.toBe(error);
      expect(attempts).toBe(1);
    }
  });

  test("tries each public registry at most once and surfaces the final failure", async () => {
    const context = await fixture();
    context.environment["npm_config_registry"] = NPM_PUBLIC_REGISTRY;
    const lastError = unavailable("npm error code E503");
    let attempts = 0;
    await expect(
      withNpmRegistryFallback(context, async () => {
        attempts += 1;
        throw attempts === 1 ? unavailable() : lastError;
      }),
    ).rejects.toBe(lastError);
    expect(attempts).toBe(2);
  });

  test("rebases only public lock URLs in both directions without altering pins or integrity", async () => {
    const context = await fixture();
    context.environment["npm_config_registry"] = NPM_MIRROR_REGISTRY;
    const lockPath = join(context.cwd, "package-lock.json");
    const urls = [
      `${NPM_PUBLIC_REGISTRY}@example/tools/-/tools-1.0.0.tgz`,
      `${NPM_MIRROR_REGISTRY}dependency/-/dependency-2.0.0.tgz`,
      "https://registry.npmmirror.com/legacy/-/legacy-3.0.0.tgz",
      "https://pi.dev/releases/first-party.tgz",
      "https://private.example/dependency.tgz",
    ];
    const lock = {
      lockfileVersion: 3,
      packages: Object.fromEntries(
        urls.map((resolved, index) => [
          `node_modules/package-${index}`,
          { version: "1.0.0", resolved, integrity: `sha512-fixture-${index}` },
        ]),
      ),
    };
    await writeFile(lockPath, JSON.stringify(lock), { mode: 0o600 });
    let attempts = 0;
    await withNpmRegistryFallback(context, async (environment) => {
      attempts += 1;
      const expectedRegistry = environment["npm_config_registry"] as string;
      const current = JSON.parse(await readFile(lockPath, "utf8")) as typeof lock;
      for (const [index, entry] of Object.values(current.packages).entries()) {
        expect(entry.version).toBe("1.0.0");
        expect(entry.integrity).toBe(`sha512-fixture-${index}`);
        expect(entry.resolved).toBe(
          index === 0
            ? `${expectedRegistry}@example/tools/-/tools-1.0.0.tgz`
            : index === 1
              ? `${expectedRegistry}dependency/-/dependency-2.0.0.tgz`
              : index === 2
                ? `${expectedRegistry}legacy/-/legacy-3.0.0.tgz`
                : (urls[index] ?? ""),
        );
      }
      if (attempts === 1) throw unavailable();
    });
    expect(attempts).toBe(2);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
  });

  test("does not rewrite symlinked lockfiles", async () => {
    const context = await fixture();
    context.environment["npm_config_registry"] = NPM_MIRROR_REGISTRY;
    const outside = join(context.cwd, "outside.json");
    await writeFile(outside, "{}");
    await symlink(outside, join(context.cwd, "package-lock.json"));
    let attempts = 0;
    await expect(
      withNpmRegistryFallback(context, async () => {
        attempts += 1;
      }),
    ).rejects.toThrow("not a regular file");
    expect(attempts).toBe(0);
    expect(await readFile(outside, "utf8")).toBe("{}");
  });

  test("still runs the primary command when registry configuration cannot be read", async () => {
    const context = await fixture();
    let attempts = 0;
    await expect(
      withNpmRegistryFallback({ ...context, npmPath: "/missing/npm" }, async () => {
        attempts += 1;
        throw unavailable();
      }),
    ).rejects.toBeInstanceOf(NpmInstallFailure);
    expect(attempts).toBe(1);
  });
});
