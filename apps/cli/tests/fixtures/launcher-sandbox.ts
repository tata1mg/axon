import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import type {
  LaunchContext,
  LaunchSpec,
  SandboxCommandOptions,
  SandboxCommandResult,
  SandboxSession,
} from "../../src/launcher/contracts.ts";
import { sandboxEnvironment } from "../../src/sandbox/environment.ts";
import { authorizeSandbox, sandboxFailure } from "../../src/sandbox/policy.ts";

const configuredRoot = process.env["AXON_LAUNCHER_FIXTURE_ROOT"];
if (!configuredRoot) throw new Error("Launcher sandbox fixture requires its temporary root");
const fixtureRoot = await realpath(configuredRoot);

/** Test only: exercise launcher dispatch without downloading or invoking Safehouse. */
export async function createFixtureSandbox(context: LaunchContext): Promise<SandboxSession> {
  // Keep real backend policy validation; a missing policy must still fail closed.
  const authorization = await authorizeSandbox(context.paths);
  let disposed = false;

  const prepareFixture = async (specification: LaunchSpec): Promise<LaunchSpec> => {
    if (disposed || Date.now() >= authorization.expiresAt)
      throw sandboxFailure("Launcher fixture sandbox authorization expired or was closed");
    const executable = await realpath(specification.executable);
    const difference = relative(fixtureRoot, executable);
    if (
      difference.startsWith(`..${sep}`) ||
      difference === ".." ||
      isAbsolute(difference) ||
      !executable.endsWith(`${sep}node_modules${sep}.bin${sep}pi`)
    ) {
      throw new Error("Launcher fixture may execute only its generated fake Pi executable");
    }
    const environment = sandboxEnvironment(
      specification.environment,
      fixtureRoot,
      fixtureRoot,
      "http://127.0.0.1:9",
    );
    // Fixture controls are not production sandbox passthroughs.
    for (const name of ["FAKE_PI_VERSION", "FAKE_EXIT_CODE", "FAKE_SIGNAL"] as const) {
      if (specification.environment[name] !== undefined)
        environment[name] = specification.environment[name];
    }
    return { ...specification, environment, expiresAt: authorization.expiresAt };
  };

  return {
    clientConfig(session) {
      if (session !== authorization.session)
        throw sandboxFailure("Launcher fixture identity changed during setup");
      return authorization.clientConfig;
    },
    wrap: prepareFixture,
    async run(specification, options) {
      options.signal?.throwIfAborted();
      const prepared = await prepareFixture(specification);
      const subprocess = Bun.spawn([prepared.executable, ...prepared.arguments], {
        cwd: prepared.cwd,
        env: prepared.environment,
        stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
        stdout: "pipe",
        stderr: "pipe",
        timeout: options.timeoutMs ?? 5_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      if (options.inheritOutput) {
        process.stdout.write(stdout);
        process.stderr.write(stderr);
      }
      return { stdout, stderr, exitCode, signalCode: subprocess.signalCode };
    },
    dispose() {
      disposed = true;
    },
  };
}

export async function withFixtureSandbox<Result>(
  context: LaunchContext,
  operation: (context: LaunchContext & { readonly sandbox: SandboxSession }) => Promise<Result>,
): Promise<Result> {
  const sandbox = await createFixtureSandbox(context);
  try {
    return await operation({ ...context, sandbox });
  } finally {
    sandbox.dispose();
  }
}

export function runFixtureCommand(
  context: LaunchContext,
  specification: LaunchSpec,
  options: SandboxCommandOptions,
): Promise<SandboxCommandResult> {
  if (!context.sandbox) throw sandboxFailure("An Axon-owned sandbox is required before running Pi");
  return context.sandbox.run(specification, options);
}
