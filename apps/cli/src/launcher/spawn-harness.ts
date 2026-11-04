import { resolveAxonPaths } from "../product/paths.ts";
import type { SandboxRpcTransport } from "../sandbox/rpc-configuration.ts";
import { flushProductTelemetry } from "../telemetry/client.ts";
import { emitProductEvent } from "../telemetry/product-events.ts";
import type { LaunchSpec } from "./contracts.ts";
import { LauncherError } from "./errors.ts";
import { exitLikeChild, LAUNCHER_EXIT_STATUS } from "./exit-status.ts";

const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/** Restart only a revoked profile; normal exits, user signals and lease expiry never relaunch. */
export async function spawnHarness(
  specification: LaunchSpec,
  restart?: () => Promise<LaunchSpec>,
  rpc?: SandboxRpcTransport,
): Promise<never> {
  let current = specification;
  try {
    while (true) {
      const result = await runHarness(current, restart !== undefined, rpc);
      if (!result.restart || !restart) return exitLikeChild(result);
      try {
        current = await restart();
      } catch (error) {
        // A failed rebuild must close the relay and invocation resources retained for restart.
        current.dispose?.();
        throw error;
      }
    }
  } finally {
    rpc?.dispose();
  }
}

async function runHarness(
  specification: LaunchSpec,
  allowRestart: boolean,
  rpc?: SandboxRpcTransport,
): Promise<{
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | number | null;
  readonly restart: boolean;
}> {
  let subprocess: Bun.Subprocess<"inherit" | "pipe", "inherit" | "pipe", "inherit">;
  let spawnError: Error | undefined;
  const startedAt = Date.now();
  // A read-capable session needs its own group so revocation reaches extensions too.
  // Terminal interrupts are forwarded explicitly because this group is not foreground.
  const detached = specification.revoked !== undefined;

  try {
    specification.revoked?.throwIfAborted();
    subprocess = Bun.spawn([specification.executable, ...specification.arguments], {
      cwd: specification.cwd,
      env: specification.environment,
      detached,
      stdin: rpc ? "pipe" : "inherit",
      stdout: rpc ? "pipe" : "inherit",
      stderr: "inherit",
      onExit: (_subprocess, _exitCode, _signalCode, error) => {
        spawnError = error;
      },
    });
  } catch (error) {
    emitProductEvent({
      category: "startup",
      stage: "spawn",
      outcome: "failed",
      reason: "application_failed",
      durationMs: Date.now() - startedAt,
    });
    specification.dispose?.();
    throw new LauncherError(
      `failed to start harness executable: ${specification.executable}`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      { cause: error, remediation: "Run axon doctor for executable diagnostics." },
    );
  }

  emitProductEvent({
    category: "startup",
    stage: "spawn",
    outcome: "success",
    durationMs: Date.now() - startedAt,
  });
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (detached) process.kill(-subprocess.pid, signal);
      else subprocess.kill(signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  let interrupted = false;
  let revoked = false;
  let expired = false;
  let restarting = false;
  const revoke = (): void => {
    revoked = true;
    // SIGTERM would leave revoked file grants usable during shutdown hooks.
    signalGroup("SIGKILL");
  };
  specification.revoked?.addEventListener("abort", revoke, { once: true });
  if (specification.revoked?.aborted) revoke();
  const terminalInterrupt = (): void => {
    interrupted = true;
    // Non-detached administrative commands already receive the foreground signal.
    if (detached) signalGroup("SIGINT");
  };
  process.on("SIGINT", terminalInterrupt);

  const forwardingHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED_SIGNALS) {
    const forwardSignal = (): void => {
      interrupted = true;
      if (subprocess.exitCode === null && subprocess.signalCode === null) {
        signalGroup(signal);
      }
    };

    forwardingHandlers.set(signal, forwardSignal);
    process.on(signal, forwardSignal);
  }

  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const expiry =
    specification.expiresAt === undefined
      ? undefined
      : setTimeout(
          () => {
            expired = true;
            console.error(
              "axon: backend sandbox authorization expired; restart axon pi to continue",
            );
            // Closing parent-owned capabilities immediately revokes all brokered network access.
            specification.dispose?.();
            signalGroup(detached ? "SIGKILL" : "SIGTERM");
            forceStop = setTimeout(() => {
              if (subprocess.exitCode === null && subprocess.signalCode === null)
                subprocess.kill("SIGKILL");
            }, 5_000);
          },
          Math.max(1, specification.expiresAt - Date.now()),
        );
  try {
    if (rpc) {
      if (!subprocess.stdin || !subprocess.stdout)
        throw new Error("RPC transport requires private child stdin and stdout pipes");
      rpc.attach(subprocess.stdin, subprocess.stdout);
    }
    await subprocess.exited;
  } finally {
    if (expiry !== undefined) clearTimeout(expiry);
    if (forceStop !== undefined) clearTimeout(forceStop);
    specification.revoked?.removeEventListener("abort", revoke);
    process.off("SIGINT", terminalInterrupt);
    for (const [signal, handler] of forwardingHandlers) {
      process.off(signal, handler);
    }
    // Reap extension descendants before granting the replacement profile.
    if (detached) signalGroup("SIGKILL");
    restarting =
      allowRestart &&
      revoked &&
      !interrupted &&
      !expired &&
      spawnError === undefined &&
      (specification.expiresAt === undefined || Date.now() < specification.expiresAt);
    await rpc?.detach(restarting);
    if (!restarting) {
      rpc?.dispose();
      await flushProductTelemetry(resolveAxonPaths(), specification.offline ?? false);
    }
    specification.dispose?.({ restarting });
  }

  if (spawnError !== undefined) {
    throw new LauncherError(
      `failed to start harness executable: ${specification.executable}`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      { cause: spawnError, remediation: "Run axon doctor for executable diagnostics." },
    );
  }

  return {
    exitCode: subprocess.exitCode,
    signalCode: subprocess.signalCode,
    restart: restarting,
  };
}
