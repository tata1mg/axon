import { isBlockedProjectDirectory } from "../../axon-safehouse/filesystem.ts";
import { withAxonSafehouseSession } from "../../axon-safehouse/session.ts";
import { synchronizePiMcpConfig } from "../../harnesses/pi/setup/mcp-config.ts";
import { synchronizePiPackages } from "../../harnesses/pi/setup/packages/sync.ts";
import { materializePiResources } from "../../harnesses/pi/setup/resources.ts";
import { loadHarnessAdapter, resolveHarnessRegistration } from "../../harnesses/registry.ts";
import type { PaseoSetupOptions } from "../../integrations/paseo.ts";
import type {
  HarnessLaunchContext,
  HarnessRegistration,
  LaunchContext,
} from "../../launcher/contracts.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { resolveExecutablePath } from "../../launcher/executable.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import { AXON_MANIFEST, EMBEDDED_PI_RESOURCES } from "../../product/manifest.ts";
import { resolveAxonPaths } from "../../product/paths.ts";
import { resolveProjectAxonPaths } from "../../product/project-paths.ts";
import { runPaseoSetup } from "./setup-paseo.ts";

export interface SetupOptions extends PaseoSetupOptions {
  readonly syncPackages?: boolean;
}

export async function runSetup(
  harnessToken: string,
  options: SetupOptions,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<void> {
  if (harnessToken === "paseo") {
    if (options.syncPackages === true) {
      throw new LauncherError(
        "--sync-packages applies only to Pi setup",
        LAUNCHER_EXIT_STATUS.usage,
      );
    }
    await runPaseoSetup(options, environment, cwd);
    return;
  }
  if (options.config !== undefined || options.yes === true) {
    throw new LauncherError(
      "--config and --yes apply only to Paseo setup",
      LAUNCHER_EXIT_STATUS.usage,
    );
  }
  if (options.syncPackages !== true) {
    throw new LauncherError("setup requires an explicit operation", LAUNCHER_EXIT_STATUS.usage, {
      remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`,
    });
  }

  const registration = resolveHarnessRegistration(harnessToken);
  if (registration?.id !== "pi") {
    throw new LauncherError(
      `setup supports pi or paseo, received: ${harnessToken}`,
      LAUNCHER_EXIT_STATUS.usage,
      { remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.` },
    );
  }

  const sharedPaths = resolveAxonPaths(environment);
  const paths = (await isBlockedProjectDirectory(sharedPaths, cwd))
    ? sharedPaths
    : await resolveProjectAxonPaths(sharedPaths, cwd);
  return withAxonSafehouseSession({ cwd, environment, paths }, (context) =>
    runAxonSafehouseSetup(registration, context),
  );
}

async function runAxonSafehouseSetup(
  registration: HarnessRegistration,
  launchContext: LaunchContext,
): Promise<void> {
  const { cwd, environment } = launchContext;
  const adapter = await loadHarnessAdapter(registration.id);
  // Explicit setup installs the isolated exact-version Pi runtime when absent.
  const executable =
    adapter.resolveExecutable === undefined
      ? (await resolveExecutablePath(registration, environment, cwd)).path
      : await adapter.resolveExecutable(launchContext, registration, {
          userArguments: [],
          allowInstall: true,
        });
  const context: HarnessLaunchContext = Object.freeze({
    ...launchContext,
    executable,
    registration,
  });

  const resources = await materializePiResources(context.paths, EMBEDDED_PI_RESOURCES);
  const packages = await synchronizePiPackages({
    allowInstall: true,
    context,
    manifest: AXON_MANIFEST,
  });
  const mcp = await synchronizePiMcpConfig({
    environment,
    force: true,
    stampPath: context.paths.piMcpSyncState,
  });

  for (const warning of packages.warnings) {
    console.error(`${PRODUCT_IDENTITY.command}: pi package warning: ${warning}`);
  }
  if (mcp.warning !== undefined) {
    console.error(`${PRODUCT_IDENTITY.command}: pi mcp warning: ${mcp.warning}`);
  }
  console.log(`Pi executable: ${executable}`);
  console.log(`Pi resources ready: ${resources.runtimeDirectory}`);
  console.log(
    packages.packages.length === 0
      ? "Pi required packages: none configured"
      : `Pi required packages ready: ${packages.packages.length}`,
  );
  console.log(
    `Pi MCP defaults: ${mcp.status}${
      mcp.addedServers.length === 0 ? "" : ` (added ${mcp.addedServers.join(", ")})`
    }; ${mcp.configPath}`,
  );
}
