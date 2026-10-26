import type {
  LaunchContext,
  LaunchSpec,
  SandboxCommandOptions,
  SandboxCommandResult,
  SandboxSession,
} from "../launcher/contracts.ts";
import { filesystemPreferencesRevision, watchFilesystemPreferences } from "./filesystem.ts";
import { createSandboxLaunchSpec, createSandboxResources } from "./launch.ts";
import {
  assertSandboxSupported,
  authorizeSandbox,
  type SandboxAuthorization,
  sandboxFailure,
} from "./policy.ts";

async function readCommandOutput(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const maximumBytes = 16 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
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
    reader.releaseLock();
  }
  return (
    Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[Axon output limit reached]" : "")
  );
}

/** One authorization, runtime verification, baseline and proxy for the whole Axon invocation. */
export async function createSandboxSession(
  context: LaunchContext,
  suppliedAuthorization?: SandboxAuthorization,
): Promise<SandboxSession> {
  assertSandboxSupported();
  const authorization = suppliedAuthorization ?? (await authorizeSandbox(context.paths));
  const resources = await createSandboxResources(context.paths, context.environment, authorization);
  const profiles = new Map<string, Promise<LaunchSpec>>();
  const activeCommands = new Set<() => void>();
  const activeOperations = new Set<() => void>();
  const stopWatching = watchFilesystemPreferences(context.paths, () => {
    for (const stop of activeOperations) stop();
    profiles.clear();
  });
  let disposed = false;

  const assertActive = (): void => {
    if (disposed || Date.now() >= authorization.expiresAt)
      throw sandboxFailure("Axon sandbox authorization expired or was closed");
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
    clientConfig(session) {
      assertActive();
      if (authorization.session !== undefined && authorization.session !== session)
        throw sandboxFailure("Axon identity changed during setup; restart for fresh authorization");
      return authorization.clientConfig;
    },
    async wrap(specification) {
      assertActive();
      const wrapped = await createSandboxLaunchSpec(specification, context.paths, authorization, {
        resources,
      });
      return {
        ...wrapped,
        dispose() {
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
        options.purpose === "operation" ? revision : undefined,
      ]);
      let pending = profiles.get(key);
      if (!pending) {
        pending = createSandboxLaunchSpec(command, context.paths, authorization, {
          purpose: options.purpose,
          ...(options.purpose === "operation" ? { project: context.cwd } : {}),
          writePaths,
          resources,
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
        throw sandboxFailure("Sandbox settings changed; retry the operation");
      const profile = wrapped.arguments[1];
      if (!profile) throw sandboxFailure("Missing sandbox command profile");
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
          timeout: Math.max(
            1,
            Math.min(options.timeoutMs ?? 300_000, authorization.expiresAt - Date.now()),
          ),
          killSignal: "SIGKILL",
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
      const stop = (): void => signalGroup("SIGKILL");
      activeCommands.add(stop);
      if (options.purpose === "operation") activeOperations.add(stop);
      options.signal?.addEventListener("abort", stop, { once: true });
      const forwarding = new Map<NodeJS.Signals, () => void>();
      if (options.inheritOutput) {
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
          const handler = (): void => signalGroup(signal);
          forwarding.set(signal, handler);
          process.on(signal, handler);
        }
      }
      try {
        // Reap descendants before draining pipes; background helpers must not retain
        // provisioning permissions or keep stdout open after their parent exits.
        const exited = child.exited.finally(stop);
        const [stdout, stderr, exitCode] = await Promise.all([
          readCommandOutput(child.stdout),
          readCommandOutput(child.stderr),
          exited,
        ]);
        assertActive();
        options.signal?.throwIfAborted();
        if (
          options.purpose === "operation" &&
          revision !== filesystemPreferencesRevision(context.paths)
        )
          throw sandboxFailure("Sandbox settings changed; retry the operation");
        return { exitCode, signalCode: child.signalCode, stdout, stderr };
      } finally {
        stop();
        activeCommands.delete(stop);
        activeOperations.delete(stop);
        options.signal?.removeEventListener("abort", stop);
        for (const [signal, handler] of forwarding) process.off(signal, handler);
      }
    },
  };
}

/** Missing Axon ownership is an error, never permission to spawn Pi directly. */
export function runSandboxCommand(
  context: LaunchContext,
  specification: LaunchSpec,
  options: SandboxCommandOptions,
): Promise<SandboxCommandResult> {
  if (!context.sandbox) throw sandboxFailure("An Axon-owned sandbox is required before running Pi");
  return context.sandbox.run(specification, options);
}

export async function withSandboxSession<Result>(
  context: LaunchContext,
  operation: (
    sandboxedContext: LaunchContext & { readonly sandbox: SandboxSession },
  ) => Promise<Result>,
): Promise<Result> {
  if (context.sandbox) return operation({ ...context, sandbox: context.sandbox });
  const sandbox = await createSandboxSession(context);
  try {
    return await operation({ ...context, sandbox });
  } finally {
    sandbox.dispose();
  }
}
