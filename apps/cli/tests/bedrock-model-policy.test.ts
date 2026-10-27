import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPiEnvironment } from "../src/harnesses/pi/environment.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const root = resolve(import.meta.dir, "..");
const sources: { name: string; environment: NodeJS.ProcessEnv; savedToken?: boolean }[] = [
  { name: "bearer token", environment: { AWS_BEARER_TOKEN_BEDROCK: "test-bearer" } },
  { name: "saved /login token", environment: {}, savedToken: true },
  { name: "shared profile", environment: { AWS_PROFILE: "test" } },
  { name: "SSO profile", environment: { AWS_PROFILE: "test-sso" } },
  { name: "role profile", environment: { AWS_PROFILE: "test-role" } },
  {
    name: "IAM keys",
    environment: { AWS_ACCESS_KEY_ID: "test-access", AWS_SECRET_ACCESS_KEY: "test-secret" },
  },
  {
    name: "temporary IAM credentials",
    environment: {
      AWS_ACCESS_KEY_ID: "test-access",
      AWS_SECRET_ACCESS_KEY: "test-secret",
      AWS_SESSION_TOKEN: "test-session",
    },
  },
  {
    name: "container credentials",
    environment: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/test-credentials" },
  },
  {
    name: "web identity",
    environment: { AWS_WEB_IDENTITY_TOKEN_FILE: "/test-token", AWS_ROLE_ARN: "test-role" },
  },
];

async function listModels(home: string, environment: NodeJS.ProcessEnv, managed: boolean) {
  const child = Bun.spawn(
    [
      join(root, "node_modules/.bin/pi"),
      "--offline",
      "--no-extensions",
      ...(managed
        ? ["--extension", join(root, "src/harnesses/pi/resources/extensions/axon.ts")]
        : []),
      "--list-models",
    ],
    {
      cwd: home,
      env: {
        HOME: home,
        PATH: process.env["PATH"] ?? "",
        PI_CODING_AGENT_DIR: join(home, "pi"),
        PI_SKIP_VERSION_CHECK: "1",
        AWS_REGION: "us-east-1",
        ...environment,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  return stdout;
}

describe("managed Bedrock catalog", () => {
  test.each(sources)(
    "hides direct models with $name without changing credentials",
    async (source) => {
      const home = await mkdtemp(join(tmpdir(), "axon-bedrock-"));
      try {
        await mkdir(join(home, "pi"));
        await mkdir(join(home, ".aws"));
        const files = {
          [join(home, ".aws/credentials")]:
            "[test]\naws_access_key_id = test-access\naws_secret_access_key = test-secret\n",
          [join(home, ".aws/config")]:
            "[profile test-sso]\nsso_session = test\nsso_account_id = 123456789012\nsso_role_name = ReadOnly\nregion = us-east-1\n" +
            "[sso-session test]\nsso_start_url = https://example.awsapps.com/start\nsso_region = us-east-1\n" +
            "[profile test-role]\nrole_arn = arn:aws:iam::123456789012:role/test\nsource_profile = test\n",
          [join(home, "pi/auth.json")]: JSON.stringify(
            source.savedToken
              ? { "amazon-bedrock": { type: "api_key", key: "saved-test-token" } }
              : {},
          ),
          [join(home, "pi/models.json")]: JSON.stringify({
            providers: {
              // A user-configured direct model must not reappear above the empty catalog.
              "amazon-bedrock": {
                models: [
                  {
                    id: "axon-direct-test",
                    api: "bedrock-converse-stream",
                    baseUrl: "https://example.invalid",
                  },
                ],
              },
              // Bedrock-backed models routed through the gateway must stay selectable.
              litellm: {
                baseUrl: "https://gateway.invalid/v1",
                api: "openai-completions",
                apiKey: "gateway-test-key",
                models: [{ id: "bedrock-gateway-test" }],
              },
            },
          }),
        };
        await Promise.all(Object.entries(files).map(([path, content]) => writeFile(path, content)));
        // Prove each credential source would expose Bedrock in unmodified Pi.
        expect(await listModels(home, source.environment, false)).toContain("amazon-bedrock");
        const output = await listModels(home, source.environment, true);
        expect(output).not.toContain("amazon-bedrock");
        expect(output).toContain("litellm");
        expect(output).toContain("bedrock-gateway-test");
        for (const [path, content] of Object.entries(files)) {
          expect(await readFile(path, "utf8")).toBe(content);
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test("preserves general AWS configuration for tools without mutating the parent environment", () => {
    const inherited = {
      AWS_PROFILE: "test-sso",
      AWS_ACCESS_KEY_ID: "test-access",
      AWS_SECRET_ACCESS_KEY: "test-secret",
      AWS_SESSION_TOKEN: "test-session",
      AWS_SHARED_CREDENTIALS_FILE: "/custom/credentials",
      AWS_CONFIG_FILE: "/custom/config",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: "test-bearer",
    };
    const original = { ...inherited };
    const environment = createPiEnvironment(
      inherited,
      resolveAxonPaths({ AXON_HOME: "/managed/axon" }),
    );
    for (const [name, value] of Object.entries(inherited)) {
      expect(environment[name]).toBe(name === "AWS_BEARER_TOKEN_BEDROCK" ? undefined : value);
    }
    expect(inherited).toEqual(original);
  });
});
