import type { HarnessLaunchContext } from "../../../launcher/contracts.ts";
import { isTrue } from "../../../launcher/debug-preview.ts";
import { LauncherError } from "../../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../../../product/identity.ts";
import { AXON_MANIFEST, EMBEDDED_PI_RESOURCES } from "../../../product/manifest.ts";
import {
  classifyPiInvocation,
  currentPiInvocationEnvironment,
  isPiOffline,
  type PiInvocationKind,
} from "./packages/invocation.ts";
import { synchronizePiPackages } from "./packages/sync.ts";
import { materializePiResources, type PiResourceMaterializationResult } from "./resources.ts";

const DEBUG_ENVIRONMENT_VARIABLE = "AXON_DEBUG";

export interface PiSetupResult {
  readonly invocationKind: PiInvocationKind;
  readonly offline: boolean;
  /** Present for every non-administrative launch. */
  readonly materialization?: PiResourceMaterializationResult;
}

async function prepareRequiredResources(
  context: HarnessLaunchContext,
  allowInstall: boolean,
  debug: boolean,
): Promise<PiResourceMaterializationResult> {
  try {
    const resources = await materializePiResources(context.paths, EMBEDDED_PI_RESOURCES);
    const packages = await synchronizePiPackages({
      allowInstall,
      context,
      manifest: AXON_MANIFEST,
    });
    for (const warning of packages.warnings) {
      console.error(`${PRODUCT_IDENTITY.command}: pi package warning: ${warning}`);
    }
    if (debug) {
      console.error(
        `${PRODUCT_IDENTITY.command}: pi resources: ${resources.runtimeDirectory}; packages: ${packages.manifestHash}`,
      );
    }
    return resources;
  } catch (error) {
    if (error instanceof LauncherError) {
      throw error;
    }
    throw new LauncherError(
      "failed to prepare required Pi resources",
      LAUNCHER_EXIT_STATUS.materializationFailure,
      {
        cause: error,
        remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`,
      },
    );
  }
}

export async function preparePiSetup(
  context: HarnessLaunchContext,
  userArguments: readonly string[],
): Promise<PiSetupResult> {
  const debug = isTrue(context.environment[DEBUG_ENVIRONMENT_VARIABLE]);
  const invocationKind = classifyPiInvocation(
    userArguments,
    currentPiInvocationEnvironment(context.environment),
  );
  const offline = isPiOffline(context.environment, userArguments);

  if (invocationKind === "administrative") {
    return { invocationKind, offline };
  }

  const materialization = await prepareRequiredResources(
    context,
    invocationKind === "interactive" && !offline,
    debug,
  );

  return { invocationKind, offline, materialization };
}
