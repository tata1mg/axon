import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { loadEncryptedSession } from "../cli/auth/session.ts";
import type {
  AxonSafehouseCommandOptions,
  AxonSafehouseCommandResult,
  AxonSafehouseSession,
  LaunchContext,
  LaunchSpec,
} from "../launcher/contracts.ts";
import { filesystemPreferencesRevision, watchFilesystemPreferences } from "./filesystem.ts";
import { createAxonSafehouseLaunchSpec, createAxonSafehouseResources } from "./launch.ts";
import {
  type AxonSafehouseAuthorization,
  assertAxonSafehouseSupported,
  authorizeAxonSafehouse,
  axonSafehouseFailure,
} from "./policy.ts";

async function readCommandOutput(
  stream: ReadableStream<Uint8Array> | undefined,
  signal: AbortSignal,
  onData: () => void,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const maximumBytes = 16 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      onData();
      const remaining = maximumBytes - retainedBytes;
      if (item.value.byteLength > remaining) truncated = true;
      if (remaining > 0) {
        const chunk = item.value.subarray(0, remaining);
        chunks.push(chunk);
        retainedBytes += chunk.byteLength;
      }
      // Drain even after truncation so a full pipe cannot deadlock the child.
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return (
    Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[Axon output limit reached]" : "")
  );
}

/** One authorization, runtime verification and baseline for the whole Axon invocation. */
export async function createAxonSafehouseSession(
  context: LaunchContext,
  suppliedAuthorization?: AxonSafehouseAuthorization,
): Promise<AxonSafehouseSession> {
  assertAxonSafehouseSupported();
  const authorization = suppliedAuthorization ?? (await authorizeAxonSafehouse(context.paths));
  const resources = await createAxonSafehouseResources(
    context.paths,
    context.environment,
    authorization,
  );
  const profiles = new Map<string, Promise<LaunchSpec>>();
  const activeCommands = new Set<() => void>();
  const activeOperations = new Set<() => void>();
  const stopWatching = watchFilesystemPreferences(context.paths, (requiresRestart) => {
    if (requiresRestart) for (const stop of activeOperations) stop();
    profiles.clear();
    // A settings change rescans package roots, picking up links created since.
    resources.packageScans.clear();
  });
  let disposed = false;
  let operationAuthorization: AxonSafehouseAuthorization | undefined;
  let pendingAuthorization: Promise<AxonSafehouseAuthorization> | undefined;

  // The login UI and setup may use the public boundary, but project operations may not.
  // A fresh authenticated policy must match the already-compiled boundary exactly.
  const authorizeOperation = async (): Promise<void> => {
    if (!authorization.bootstrap) return;
    const session = await loadEncryptedSession(context.paths);
    if (!session)
      throw axonSafehouseFailure("Sign in to Axon before running Axon Safehouse operations");
    if (operationAuthorization?.session !== session) {
      const pending = pendingAuthorization ?? authorizeAxonSafehouse(context.paths);
      pendingAuthorization = pending;
      try {
        const verified = await pending;
        if (!isDeepStrictEqual(verified.policy, authorization.policy)) {
          throw axonSafehouseFailure(
            "Axon Safehouse policy changed after login; restart the agent for fresh authorization",
          );
        }
        operationAuthorization = verified;
      } finally {
        if (pendingAuthorization === pending) pendingAuthorization = undefined;
      }
    }
    if (
      !operationAuthorization ||
      Date.now() >= operationAuthorization.expiresAt ||
      (await loadEncryptedSession(context.paths)) !== operationAuthorization.session
    ) {
      throw axonSafehouseFailure(
        "Axon Safehouse identity changed or authorization expired; retry after signing in",
      );
    }
  };

  const assertActive = (): void => {
    if (disposed || Date.now() >= authorization.expiresAt)
      throw axonSafehouseFailure("Axon Safehouse authorization expired or was closed");
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const stop of activeCommands) stop();
    activeCommands.clear();
    stopWatching();
    resources.dispose();
    clearTimeout(expiry);
  };
  const expiry = setTimeout(dispose, Math.max(1, authorization.expiresAt - Date.now()));
  expiry.unref();

  return {
    dispose,
    async configurationPolicy() {
      assertActive();
      if (context.catalogOnly)
        throw axonSafehouseFailure("RPC catalog probes cannot configure project permissions");
      const verified = await authorizeAxonSafehouse(context.paths);
      assertActive();
      // A settings change cannot silently replace backend filesystem limits or renew the lease.
      // Changed backend boundaries require a new Axon invocation, not just a new Pi child.
      if (!isDeepStrictEqual(verified.policy, authorization.policy))
        throw axonSafehouseFailure(
          "Backend Axon Safehouse policy changed; restart the agent before editing permissions",
        );
      if ((await loadEncryptedSession(context.paths)) !== verified.session)
        throw axonSafehouseFailure(
          "Axon identity changed while validating Axon Safehouse permissions",
        );
      assertActive();
      return verified.policy;
    },
    clientConfig(session) {
      assertActive();
      if (authorization.session !== undefined && authorization.session !== session)
        throw axonSafehouseFailure(
          "Axon identity changed during setup; restart for fresh authorization",
        );
      return authorization.clientConfig;
    },
    async wrap(specification, options) {
      assertActive();
      const revision = filesystemPreferencesRevision(context.paths);
      const wrapped = await createAxonSafehouseLaunchSpec(
        specification,
        context.paths,
        authorization,
        {
          resources,
          ...(context.catalogOnly ? { catalogOnly: true } : {}),
          ...(options?.runtimeReadPaths ? { runtimeReadPaths: options.runtimeReadPaths } : {}),
          ...(options?.packageAdministration
            ? {
                purpose: "administration" as const,
                writePaths: [context.paths.pi, join(context.cwd, ".pi")].flatMap((root) =>
                  ["npm", "git", "settings.json", "settings.json.lock"].map((entry) =>
                    join(root, entry),
                  ),
                ),
              }
            : {}),
        },
      );
      assertActive();
      if (revision !== filesystemPreferencesRevision(context.paths))
        throw axonSafehouseFailure(
          "Axon Safehouse settings changed during startup; retry the launch",
        );
      const brokered = specification.environment["PI_AXON_SAFEHOUSE_OPERATIONS"] === "1";
      const revocation = new AbortController();
      const stopWatchingSession = brokered
        ? watchFilesystemPreferences(context.paths, (requiresRestart) => {
            // Brokered workers compile fresh profiles for added grants. The chat's older,
            // narrower read-only profile remains safe until an actual revocation occurs.
            if (requiresRestart) revocation.abort();
          })
        : () => {};
      return {
        ...wrapped,
        ...(brokered ? { revoked: revocation.signal } : {}),
        dispose(options) {
          stopWatchingSession();
          // A replacement child reuses the same relay, authorization and resources.
          // Final disposal must still work if rebuilding the replacement fails.
          if (options?.restarting) return;
          try {
            wrapped.dispose?.();
          } finally {
            dispose();
          }
        },
      };
    },
    async run(specification, options) {
      assertActive();
      options.signal?.throwIfAborted();
      if (options.purpose === "operation") {
        if (context.catalogOnly)
          throw axonSafehouseFailure("RPC catalog probes cannot run project operations");
        await authorizeOperation();
      }
      assertActive();
      options.signal?.throwIfAborted();
      const revision = filesystemPreferencesRevision(context.paths);
      const writePaths = [...new Set(options.writePaths ?? [])].sort();
      // Probes/package administration never need a project's cwd or its configuration.
      // npm ci alone keeps its explicitly writable staging directory as cwd.
      const command = {
        ...specification,
        cwd:
          options.purpose === "operation" ||
          (options.purpose === "provision" && writePaths.includes(specification.cwd))
            ? specification.cwd
            : resources.temporary,
      };
      // Concurrent commands share compilation, but operation profiles are scoped to a settings revision.
      const key = JSON.stringify([
        options.purpose,
        command.cwd,
        specification.environment["PATH"],
        specification.environment["PI_CODING_AGENT_DIR"],
        writePaths,
        revision,
      ]);
      let pending = profiles.get(key);
      if (!pending) {
        pending = createAxonSafehouseLaunchSpec(command, context.paths, authorization, {
          purpose: options.purpose,
          // Every purpose inherits the user's optional host blocklist, not project file grants.
          project: context.cwd,
          writePaths,
          resources,
        }).catch((error: unknown) => {
          // Share in-flight compilation, not a failed attempt for the rest of the invocation.
          if (profiles.get(key) === pending) profiles.delete(key);
          throw error;
        });
        profiles.set(key, pending);
      }
      const wrapped = await pending;
      assertActive();
      options.signal?.throwIfAborted();
      if (
        options.purpose === "operation" &&
        revision !== filesystemPreferencesRevision(context.paths)
      )
        throw axonSafehouseFailure("Axon Safehouse settings changed; retry the operation");
      const profile = wrapped.arguments[1];
      if (!profile) throw axonSafehouseFailure("Missing Axon Safehouse command profile");
      const child = Bun.spawn(
        [wrapped.executable, "-f", profile, specification.executable, ...specification.arguments],
        {
          cwd: command.cwd,
          env: wrapped.environment,
          // Noninteractive helpers get their own process group, not the TUI's foreground group.
          detached: true,
          stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
          stdout: options.inheritOutput ? "inherit" : "pipe",
          stderr: options.inheritOutput ? "inherit" : "pipe",
          // The session lease bounds all commands. Only explicit operation deadlines
          // impose a shorter timeout; Pi's shell tool has no default deadline.
        },
      );
      const signalGroup = (signal: NodeJS.Signals): void => {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
            child.kill(signal);
        }
      };
      let backgroundCheck: ReturnType<typeof setInterval> | undefined;
      const releaseGroup = (): void => {
        if (backgroundCheck !== undefined) clearInterval(backgroundCheck);
        activeCommands.delete(stop);
        activeOperations.delete(stop);
      };
      const stop = (): void => {
        signalGroup("SIGKILL");
        releaseGroup();
      };
      // Probes keep a safety deadline. Installs may legitimately take a long time on slow
      // networks and are bounded by the session lease, like operations.
      const timeoutMs = options.timeoutMs ?? (options.purpose === "probe" ? 300_000 : undefined);
      let timedOut = false;
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              stop();
            }, timeoutMs);
      let preserveDescendants = false;
      const outputCancellation = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let parentExited = false;
      const armOutputIdleTimer = (): void => {
        if (!parentExited) return;
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        // Match Pi's post-exit idle grace: quiet inherited pipes must not hang a
        // command, but keep draining while output is actively arriving.
        idleTimer = setTimeout(() => outputCancellation.abort(), 100);
      };
      activeCommands.add(stop);
      if (options.purpose === "operation") activeOperations.add(stop);
      options.signal?.addEventListener("abort", stop, { once: true });
      const forwarding = new Map<NodeJS.Signals, () => void>();
      // The detached group is outside the terminal's foreground group. Without forwarding,
      // Ctrl+C or a closed terminal kills Axon and orphans an installer that still holds
      // provisioning grants. Brokered operations are reaped by session disposal instead.
      if (options.inheritOutput || options.purpose !== "operation") {
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
          const handler = (): void => signalGroup(signal);
          forwarding.set(signal, handler);
          process.on(signal, handler);
        }
      }
      try {
        const exited = child.exited.then((exitCode) => {
          parentExited = true;
          // Installers must never leave descendants holding provisioning grants.
          if (options.purpose !== "operation") stop();
          armOutputIdleTimer();
          return exitCode;
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          readCommandOutput(child.stdout, outputCancellation.signal, armOutputIdleTimer),
          readCommandOutput(child.stderr, outputCancellation.signal, armOutputIdleTimer),
          exited,
        ]);
        assertActive();
        options.signal?.throwIfAborted();
        if (
          options.purpose === "operation" &&
          revision !== filesystemPreferencesRevision(context.paths)
        )
          throw axonSafehouseFailure("Axon Safehouse settings changed; retry the operation");
        if (timedOut) throw new Error(`timeout:${(timeoutMs ?? 0) / 1000}`);
        // Background jobs keep this operation's Axon Safehouse boundary, never provisioning grants.
        // Retain ownership so a settings change or session disposal still kills them.
        if (options.purpose === "operation") {
          try {
            process.kill(-child.pid, 0);
            preserveDescendants = true;
            // Drop completed groups instead of retaining stale PIDs for the whole run.
            backgroundCheck = setInterval(() => {
              try {
                process.kill(-child.pid, 0);
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ESRCH")
                  releaseGroup();
              }
            }, 1_000);
            backgroundCheck.unref();
          } catch {
            // No remaining process group to retain.
          }
        }
        return { exitCode, signalCode: child.signalCode, stdout, stderr };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        outputCancellation.abort();
        if (!preserveDescendants) stop();
        options.signal?.removeEventListener("abort", stop);
        for (const [signal, handler] of forwarding) process.off(signal, handler);
      }
    },
  };
}

/** Missing Axon ownership is an error, never permission to spawn Pi directly. */
export function runAxonSafehouseCommand(
  context: LaunchContext,
  specification: LaunchSpec,
  options: AxonSafehouseCommandOptions,
): Promise<AxonSafehouseCommandResult> {
  if (!context.axonSafehouse)
    throw axonSafehouseFailure("Axon Safehouse is required before running Pi");
  return context.axonSafehouse.run(specification, options);
}

export async function withAxonSafehouseSession<Result>(
  context: LaunchContext,
  operation: (
    axonSafehouseContext: LaunchContext & { readonly axonSafehouse: AxonSafehouseSession },
  ) => Promise<Result>,
  suppliedAuthorization?: AxonSafehouseAuthorization,
): Promise<Result> {
  if (context.axonSafehouse) return operation({ ...context, axonSafehouse: context.axonSafehouse });
  const axonSafehouse = await createAxonSafehouseSession(context, suppliedAuthorization);
  try {
    return await operation({ ...context, axonSafehouse });
  } finally {
    axonSafehouse.dispose();
  }
}
