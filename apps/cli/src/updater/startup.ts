import { BUILD_INFO, type BuildInfo } from "../build-info.ts";
import {
  classifyPiInvocation,
  currentPiInvocationEnvironment,
  isPiOffline,
  type PiInvocationEnvironment,
} from "../harnesses/pi/setup/packages/invocation.ts";
import { FileLockTimeoutError } from "../launcher/file-lock.ts";
import { spawnHarness } from "../launcher/spawn-harness.ts";
import { type AxonPaths, resolveAxonPaths } from "../product/paths.ts";
import { type UpdateProgressView, updateProgressView, withUpdateProgress } from "./progress.ts";
import {
  automaticUpdatesAllowed,
  backgroundCheckDue,
  installUpdate,
  type UpdateContext,
  updateContext,
} from "./update.ts";

/**
 * Startup must not sit behind another updater's download (typically the detached worker
 * started by an RPC or print launch). That update applies on the next launch instead.
 */
const STARTUP_LOCK_TIMEOUT_MS = 250;

interface StartupUpdateOptions {
  readonly context?: UpdateContext;
  readonly environment?: NodeJS.ProcessEnv;
  readonly invocation?: PiInvocationEnvironment;
  readonly restart?: (context: UpdateContext, argumentsVector: readonly string[]) => Promise<void>;
  readonly info?: (message: string) => void;
  readonly warn?: (message: string) => void;
  readonly progress?: UpdateProgressView;
}

/** Check every eligible launch, independently of the old background-check throttle. */
export async function runStartupUpdate(
  argumentsVector: readonly string[],
  options: StartupUpdateOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const invocation = options.invocation ?? currentPiInvocationEnvironment(environment);
  const build = options.context?.build ?? BUILD_INFO;
  if (
    !automaticUpdatesAllowed(build, environment) ||
    classifyPiInvocation(argumentsVector, invocation) !== "interactive" ||
    isPiOffline(environment, argumentsVector)
  ) {
    return;
  }

  const context = options.context ?? updateContext();
  const info = options.info ?? console.log;
  const warn = options.warn ?? console.error;
  try {
    // Metadata must fail quickly on an unavailable service. Downloads retain their
    // longer timeout and all existing checksum/signature/managed-path checks.
    const installed = await withUpdateProgress(
      (onProgress) =>
        installUpdate({
          ...context,
          client: { ...context.client, metadataTimeoutMs: 3_000 },
          lockTimeoutMs: STARTUP_LOCK_TIMEOUT_MS,
          onProgress,
        }),
      options.progress ?? updateProgressView(),
    );
    if (!installed) return;
    warn(`axon: updated to ${installed}; continuing with the new version.`);
  } catch (error) {
    // Another updater holds the lock and will finish on its own; this is not a failure.
    if (error instanceof Error && error.cause instanceof FileLockTimeoutError) return;
    warn(
      "axon: could not check for or install updates; continuing with the current version. Retry with axon update.",
    );
    return;
  }

  try {
    const restart = options.restart ?? restartUpdatedLauncher;
    await restart(context, ["pi", ...argumentsVector]);
  } catch {
    warn(
      "axon: could not start the updated launcher; continuing with the current version. Restart axon to retry.",
    );
  }
}

interface BackgroundUpdateScheduleOptions {
  readonly build?: BuildInfo;
  readonly environment?: NodeJS.ProcessEnv;
  readonly paths?: AxonPaths;
  readonly invocation?: PiInvocationEnvironment;
  readonly spawn?: (command: readonly string[], environment: NodeJS.ProcessEnv) => void;
}

/**
 * RPC, JSON, print, and piped launches cannot block on or print update progress:
 * their stdout belongs to a client protocol. Instead, start a detached worker that
 * throttles itself (see runBackgroundUpdate) and installs for the next launch.
 * The running process keeps its already-open executable inode. Throttled launches
 * are filtered here first, so frequent scripted launches do not each start a process.
 */
export async function scheduleBackgroundUpdate(
  argumentsVector: readonly string[],
  options: BackgroundUpdateScheduleOptions = {},
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const invocation = options.invocation ?? currentPiInvocationEnvironment(environment);
  const build = options.build ?? BUILD_INFO;
  if (
    !automaticUpdatesAllowed(build, environment) ||
    invocation.ci ||
    classifyPiInvocation(argumentsVector, invocation) !== "noninteractive" ||
    isPiOffline(environment, argumentsVector)
  ) {
    return false;
  }
  try {
    if (!(await backgroundCheckDue(options.paths ?? resolveAxonPaths(environment)))) return false;
    (options.spawn ?? spawnDetachedWorker)([process.execPath, "__background-update"], environment);
    return true;
  } catch {
    // An optional update must never affect the launch it piggybacks on.
    return false;
  }
}

function spawnDetachedWorker(command: readonly string[], environment: NodeJS.ProcessEnv): void {
  const worker = Bun.spawn([...command], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: environment,
  });
  worker.unref();
}

async function restartUpdatedLauncher(
  context: UpdateContext,
  argumentsVector: readonly string[],
): Promise<void> {
  // Reuse inherited stdio/cwd, signal forwarding, and child exit propagation.
  // The new launcher compares its own embedded version with latest, so it does
  // not recurse for the release we just installed. No persistent bypass flag.
  await spawnHarness({
    executable: context.paths.managedBinary,
    arguments: argumentsVector,
    cwd: process.cwd(),
    environment: process.env,
  });
}
