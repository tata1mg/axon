import { intro } from "@clack/prompts";

import { resolveConfiguredPiVersion } from "../harnesses/pi/installation.ts";
import {
  classifyPiInvocation,
  currentPiInvocationEnvironment,
  isPiOffline,
  isPiPackageUpdate,
  isPiRpcMode,
} from "../harnesses/pi/setup/packages/invocation.ts";
import { resolveHarnessRegistration } from "../harnesses/registry.ts";
import { LauncherError } from "../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../launcher/exit-status.ts";
import { launchRegisteredHarness } from "../launcher/launch-harness.ts";
import { PRODUCT_IDENTITY } from "../product/identity.ts";
import { resolveAxonPaths } from "../product/paths.ts";
import { runStartupUpdate, scheduleBackgroundUpdate } from "../updater/startup.ts";
import { runBackgroundUpdate } from "../updater/update.ts";
import { ensureAuthenticatedSession } from "./auth/ensure-session.ts";
import { runLauncherProgram } from "./launcher-program.ts";

async function runDefaultHarness(): Promise<void> {
  const invocationEnvironment = currentPiInvocationEnvironment();
  if (
    !invocationEnvironment.ci &&
    invocationEnvironment.stdinIsTty &&
    invocationEnvironment.stdoutIsTty
  ) {
    intro(PRODUCT_IDENTITY.displayName);
  }

  // Bare axon and axon pi share one verification and browser-login path.
  // Noninteractive runs still validate, but never prompt for browser login.
  await dispatch(["pi"]);
}

export async function dispatch(
  argumentsVector: readonly string[],
  options: { readonly safehouseDisabled?: boolean } = {},
): Promise<void> {
  const [head, ...remainingArguments] = argumentsVector;
  // Reserve the leading launcher flag; never scan prompt text or tokens after `--`.
  if (head === "--no-safehouse") {
    await dispatch(
      remainingArguments[0] === "pi" ? remainingArguments : ["pi", ...remainingArguments],
      { safehouseDisabled: true },
    );
    return;
  }
  const safehouseDisabled =
    options.safehouseDisabled === true ||
    (head === "pi" && remainingArguments[0] === "--no-safehouse");
  const harnessArguments =
    head === "pi" && remainingArguments[0] === "--no-safehouse"
      ? remainingArguments.slice(1)
      : remainingArguments;
  if (head === undefined) {
    await runDefaultHarness();
    return;
  }
  if (head === "__background-update") {
    await runBackgroundUpdate();
    return;
  }
  const registration = resolveHarnessRegistration(head);

  if (registration !== undefined) {
    // Provider diagnostics need the managed version before login. Reading the pin
    // never resolves, installs or executes Pi, so no Axon Safehouse authorization is bypassed.
    if (
      registration.id === "pi" &&
      harnessArguments.length === 1 &&
      ["--version", "-v"].includes(harnessArguments[0] ?? "")
    ) {
      console.log(resolveConfiguredPiVersion(process.env));
      return;
    }
    if (
      registration.id === "pi" &&
      harnessArguments[0] === "update" &&
      !isPiPackageUpdate(harnessArguments)
    ) {
      throw new LauncherError(
        "axon pi update is disabled: Axon pins its own Pi executable",
        LAUNCHER_EXIT_STATUS.usage,
        {
          remediation:
            "Use axon pi update --extensions or axon pi update <source> for packages. Upgrade axon for a reviewed Pi version change.",
        },
      );
    }
    // Interactive launches update in the foreground; RPC/JSON/scripted ones in a
    // detached, throttled worker that takes effect on the next launch.
    await runStartupUpdate(harnessArguments, safehouseDisabled ? { safehouseDisabled } : {});
    await scheduleBackgroundUpdate(harnessArguments);
    const paths = resolveAxonPaths();
    const invocationKind = classifyPiInvocation(harnessArguments);
    // No Pi command may resolve, install, or launch its executable before verification.
    // RPC clients are the exception for a missing or expired login: the relay rejects
    // every managed request until the user signs in from the chat.
    const authentication = await ensureAuthenticatedSession(paths, {
      offline: isPiOffline(process.env, harnessArguments),
      interactive: invocationKind === "interactive",
      deferLogin: isPiRpcMode(harnessArguments),
    });
    if (authentication === "cancelled") return;
    await launchRegisteredHarness(registration, harnessArguments, {
      authenticationDeferred: authentication === "deferred",
      ...(safehouseDisabled ? { safehouseDisabled: true } : {}),
    });
    return;
  }

  // Launcher commands retain their own authentication and usage handling.
  await runLauncherProgram(argumentsVector);
}
