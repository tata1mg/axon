import { isPiOffline } from "../harnesses/pi/setup/packages/invocation.ts";
import { loadHarnessAdapter } from "../harnesses/registry.ts";
import { resolveAxonPaths } from "../product/paths.ts";
import { assertSandboxSupported, sandboxFailure } from "../sandbox/policy.ts";
import { withSandboxSession } from "../sandbox/session.ts";
import { emitProductEvent } from "../telemetry/product-events.ts";
import type {
  HarnessLaunchContext,
  HarnessRegistration,
  LaunchContext,
  LaunchSpec,
  SandboxSession,
} from "./contracts.ts";
import { isTrue, printDebugLaunchPreview } from "./debug-preview.ts";
import { createHarnessEnvironment } from "./environment.ts";
import { LauncherError } from "./errors.ts";
import { resolveExecutablePath } from "./executable.ts";
import { LAUNCHER_EXIT_STATUS } from "./exit-status.ts";
import { spawnHarness } from "./spawn-harness.ts";

const DEBUG_ENVIRONMENT_VARIABLE = "AXON_DEBUG";

export async function launchRegisteredHarness(
  registration: HarnessRegistration,
  userArguments: readonly string[],
): Promise<never> {
  const cwd = process.cwd();
  const inheritedEnvironment = process.env;
  const paths = resolveAxonPaths(inheritedEnvironment);
  assertSandboxSupported();
  if (isPiOffline(inheritedEnvironment, userArguments)) {
    throw sandboxFailure(
      "Offline Pi launches are disabled: fresh backend sandbox authorization is required",
    );
  }
  let nextArguments = userArguments;
  while (true) {
    nextArguments = await withSandboxSession(
      { cwd, environment: inheritedEnvironment, paths },
      (context) => launchSandboxedHarness(registration, nextArguments, Date.now(), context),
    );
    // The previous session has fully closed. Never reuse its authorization, profile or relays.
    console.error("axon: restarting with your saved sandbox permissions…");
  }
}

async function launchSandboxedHarness(
  registration: HarnessRegistration,
  userArguments: readonly string[],
  startedAt: number,
  sandboxedContext: LaunchContext & { readonly sandbox: SandboxSession },
): Promise<readonly string[]> {
  const { cwd, environment: inheritedEnvironment, paths } = sandboxedContext;
  const adapter = await loadHarnessAdapter(registration.id);
  const executable =
    adapter.resolveExecutable === undefined
      ? (await resolveExecutablePath(registration, inheritedEnvironment, cwd)).path
      : await adapter.resolveExecutable(sandboxedContext, registration, {
          userArguments,
          allowInstall: true,
        });

  const context: HarnessLaunchContext = Object.freeze({
    ...sandboxedContext,
    cwd,
    environment: inheritedEnvironment,
    paths,
    registration,
    executable,
  });

  try {
    await adapter.prepare(context, userArguments);
  } catch (error) {
    emitProductEvent({
      category: "startup",
      stage: "prepare",
      outcome: "failed",
      reason: "application_failed",
      durationMs: Date.now() - startedAt,
    });
    if (error instanceof LauncherError) {
      throw error;
    }

    throw new LauncherError(
      `failed to prepare the ${registration.id} harness`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      { cause: error, remediation: `Run axon doctor ${registration.id}.` },
    );
  }

  let specification: LaunchSpec;
  try {
    specification = await adapter.buildLaunchSpec(context, userArguments);
  } catch (error) {
    emitProductEvent({
      category: "startup",
      stage: "prepare",
      outcome: "failed",
      reason: "application_failed",
      durationMs: Date.now() - startedAt,
    });
    if (error instanceof LauncherError) {
      throw error;
    }

    throw new LauncherError(
      `failed to build the ${registration.id} launch command`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      { cause: error, remediation: `Run axon doctor ${registration.id}.` },
    );
  }

  if (specification.executable !== executable) {
    specification.dispose?.();
    throw new LauncherError(
      `${registration.id} adapter attempted to replace the allowlisted executable`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      { remediation: `Run axon doctor ${registration.id}.` },
    );
  }

  // Only the launcher may wrap the already-validated managed executable.
  try {
    specification = await sandboxedContext.sandbox.wrap({
      ...specification,
      environment: createHarnessEnvironment(specification.environment, {
        PI_AXON_LAUNCH_STARTED_AT: String(startedAt),
      }),
    });
  } catch (error) {
    specification.dispose?.();
    if (error instanceof LauncherError) throw error;
    throw sandboxFailure("Could not prepare the mandatory Safehouse sandbox");
  }

  if (isTrue(inheritedEnvironment[DEBUG_ENVIRONMENT_VARIABLE])) {
    printDebugLaunchPreview({
      harness: registration.id,
      executable: specification.executable,
      arguments: specification.arguments,
      cwd: specification.cwd,
    });
  }

  emitProductEvent({
    category: "startup",
    stage: "prepare",
    outcome: "success",
    durationMs: Date.now() - startedAt,
  });
  return spawnHarness(specification);
}
