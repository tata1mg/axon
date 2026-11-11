import { homedir } from "node:os";
import { validateAxonSafehouseResumeSession } from "../axon-safehouse/configuration-relay.ts";
import { canonicalPath, isBlockedProjectDirectory } from "../axon-safehouse/filesystem.ts";
import {
  assertAxonSafehouseSupported,
  authorizeAxonSafehouseBootstrap,
  axonSafehouseFailure,
} from "../axon-safehouse/policy.ts";
import { createAxonSafehouseRpcTransport } from "../axon-safehouse/rpc-configuration.ts";
import { withAxonSafehouseSession } from "../axon-safehouse/session.ts";
import { piRestartArguments } from "../harnesses/pi/restart.ts";
import {
  isPiOffline,
  isPiRpcMode,
  piOptionTokens,
} from "../harnesses/pi/setup/packages/invocation.ts";
import { loadHarnessAdapter } from "../harnesses/registry.ts";
import { resolveAxonPaths } from "../product/paths.ts";
import { emitProductEvent } from "../telemetry/product-events.ts";
import type {
  AxonSafehouseResumeSession,
  AxonSafehouseSession,
  HarnessLaunchContext,
  HarnessRegistration,
  LaunchContext,
  LaunchSpec,
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
  options: { readonly authenticationDeferred?: boolean } = {},
): Promise<never> {
  const cwd = process.cwd();
  const inheritedEnvironment = process.env;
  const paths = resolveAxonPaths(inheritedEnvironment);
  assertAxonSafehouseSupported();
  if (isPiOffline(inheritedEnvironment, userArguments)) {
    throw axonSafehouseFailure(
      "Offline Pi launches are disabled: fresh backend Axon Safehouse authorization is required",
    );
  }
  const authorization = options.authenticationDeferred
    ? await authorizeAxonSafehouseBootstrap()
    : undefined;
  // Paseo's global catalog starts in homedir(), not a user-selected project.
  // Give that process only a private temporary cwd, never a grant to the home directory.
  const catalogOnly =
    isPiRpcMode(userArguments) &&
    !inheritedEnvironment["PASEO_AGENT_ID"] &&
    (await canonicalPath(cwd)) === (await canonicalPath(homedir())) &&
    !piOptionTokens(userArguments).some((argument) =>
      ["--session", "--continue", "-c", "--resume", "-r", "--extension", "-e"].includes(argument),
    );
  return withAxonSafehouseSession(
    {
      cwd,
      environment: inheritedEnvironment,
      paths,
      ...(catalogOnly ? { catalogOnly: true } : {}),
    },
    (context) =>
      launchAxonSafehouseHarness(
        registration,
        catalogOnly ? [...userArguments, "--no-session"] : userArguments,
        Date.now(),
        context,
        options,
      ),
    authorization,
  );
}

async function launchAxonSafehouseHarness(
  registration: HarnessRegistration,
  userArguments: readonly string[],
  startedAt: number,
  axonSafehouseContext: LaunchContext & { readonly axonSafehouse: AxonSafehouseSession },
  options: { readonly authenticationDeferred?: boolean },
): Promise<never> {
  const { cwd, environment: inheritedEnvironment, paths } = axonSafehouseContext;
  // Pi dispatches package subcommands only from the first argument.
  const packageAdministration = ["install", "remove", "uninstall", "update"].includes(
    userArguments[0] ?? "",
  );
  // Fail before installing or allocating anything: local package state needs a project.
  if (
    (packageAdministration || userArguments[0] === "mcp") &&
    userArguments.slice(1).some((argument) => argument === "-l" || argument === "--local") &&
    (await isBlockedProjectDirectory(paths, cwd))
  ) {
    throw new LauncherError(
      "Local Pi commands need a project directory",
      LAUNCHER_EXIT_STATUS.usage,
      {
        remediation:
          "Run this from your project directory, or drop -l/--local to manage global configuration or packages.",
      },
    );
  }
  const adapter = await loadHarnessAdapter(registration.id);
  const executable =
    adapter.resolveExecutable === undefined
      ? (await resolveExecutablePath(registration, inheritedEnvironment, cwd)).path
      : await adapter.resolveExecutable(axonSafehouseContext, registration, {
          userArguments,
          allowInstall: true,
        });

  let resumeSession: AxonSafehouseResumeSession | undefined;
  let editorClosed = Promise.resolve();
  const context: HarnessLaunchContext = Object.freeze({
    ...axonSafehouseContext,
    cwd,
    environment: inheritedEnvironment,
    paths,
    registration,
    executable,
    prepareAxonSafehouseRestart(session: AxonSafehouseResumeSession) {
      resumeSession = session;
      let finished: () => void = () => {};
      editorClosed = new Promise<void>((resolve) => {
        finished = resolve;
      });
      return finished;
    },
    ...(options.authenticationDeferred ? { authenticationDeferred: true } : {}),
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
  // Keep the parent-owned relay and its environment stable across child replacements.
  const originalSpecification = specification;
  // RPC clients supply a generated integration extension and sometimes an MCP file
  // outside the project. Grant only those explicit files, not their temporary directory.
  const runtimeReadPaths: string[] = [];
  const optionTokens = piOptionTokens(userArguments);
  for (let index = 0; index < optionTokens.length; index++) {
    if (["--extension", "-e", "--mcp-config"].includes(optionTokens[index] ?? "")) {
      const path = optionTokens[++index];
      if (path) runtimeReadPaths.push(path);
    }
  }
  const wrap = (candidate: LaunchSpec): Promise<LaunchSpec> =>
    axonSafehouseContext.axonSafehouse.wrap(
      {
        ...candidate,
        environment: createHarnessEnvironment(candidate.environment, {
          PI_AXON_LAUNCH_STARTED_AT: String(startedAt),
        }),
      },
      {
        runtimeReadPaths,
        packageAdministration,
      },
    );
  try {
    specification = await wrap(originalSpecification);
  } catch (error) {
    specification.dispose?.();
    if (error instanceof LauncherError) throw error;
    throw axonSafehouseFailure("Could not prepare mandatory Axon Safehouse protection");
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
  const rpc = isPiRpcMode(userArguments)
    ? createAxonSafehouseRpcTransport({
        paths,
        cwd,
        axonSafehouse: axonSafehouseContext.axonSafehouse,
        prepareRestart(session) {
          if (!context.prepareAxonSafehouseRestart)
            throw axonSafehouseFailure("The parent-owned Axon Safehouse restart is unavailable");
          return context.prepareAxonSafehouseRestart(session);
        },
      })
    : undefined;
  return spawnHarness(
    specification,
    async () => {
      await editorClosed;
      if (!resumeSession)
        throw axonSafehouseFailure(
          "Axon Safehouse permissions changed without a validated resume session",
        );
      const session = await validateAxonSafehouseResumeSession(paths, resumeSession);
      return wrap({
        ...originalSpecification,
        arguments: piRestartArguments(originalSpecification.arguments, session),
      });
    },
    rpc,
  );
}
