import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as prompts from "@clack/prompts";
import { z } from "zod";

import { runSandboxMenu } from "../cli/commands/sandbox.ts";
import type { AxonPaths } from "../product/paths.ts";
import { formatHomePath } from "../sessions/display.ts";
import { assertInside } from "../sessions/files.ts";

const resumeSchema = z.strictObject({
  sessionId: z.uuid(),
  sessionFile: z.string().min(1).max(4096).optional(),
});

export interface SandboxRestartSession {
  readonly sessionId: string;
  readonly sessionFile?: string;
}

async function validateResumeSession(
  paths: AxonPaths,
  session: SandboxRestartSession,
): Promise<SandboxRestartSession> {
  if (!session.sessionFile) return { sessionId: session.sessionId };
  if (!isAbsolute(session.sessionFile) || !session.sessionFile.endsWith(".jsonl"))
    throw new Error("Invalid Pi session path");
  try {
    // Never let a sandbox request turn an arbitrary host file into a session input.
    await assertInside(paths.piSessions, session.sessionFile);
    const info = await lstat(session.sessionFile);
    if (info.nlink !== 1 || (process.getuid && info.uid !== process.getuid()))
      throw new Error("Unsafe Pi session file");
    return session;
  } catch (error) {
    // A fresh, empty session may not have written its first record yet.
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { sessionId: session.sessionId };
    throw error;
  }
}

/** Pi may request the editor, but only the human at Axon's terminal can choose and save grants. */
export function createSandboxConfigurationRelay(paths: AxonPaths, cwd: string) {
  const shutdown = new AbortController();
  let busy = false;
  let restartSession: SandboxRestartSession | undefined;
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

  return {
    async handle(request: Request, url: URL): Promise<Response> {
      if (
        url.pathname !== "/_axon/sandbox/configure" ||
        request.method !== "POST" ||
        url.search !== "" ||
        !process.stdin.isTTY ||
        !process.stdout.isTTY ||
        shutdown.signal.aborted
      ) {
        return reply({ error: "Interactive sandbox configuration is unavailable" }, 404);
      }
      if (busy) return reply({ error: "The sandbox editor is already open" }, 409);
      busy = true;
      const signal = AbortSignal.any([request.signal, shutdown.signal]);
      try {
        // Only resume metadata is accepted, never filesystem grants, argv or a project.
        const body = await request.text();
        if (Buffer.byteLength(body) > 8192)
          return reply({ error: "Sandbox configuration request is too large" }, 413);
        const input = resumeSchema.parse(JSON.parse(body));
        const resume = await validateResumeSession(paths, {
          sessionId: input.sessionId,
          ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
        });
        signal.throwIfAborted();
        const approved = await prompts.confirm({
          message: `Open sandbox settings for ${formatHomePath(cwd)}? Saving restarts Axon and resumes this session.`,
          initialValue: false,
          signal,
        });
        if (prompts.isCancel(approved) || !approved) return reply({ opened: false });
        const saved = await runSandboxMenu(paths, cwd, prompts, { signal, restartOnSave: true });
        // This state lives only in the parent, and is armed only after a confirmed atomic save.
        if (saved) restartSession = resume;
        return reply({ opened: true, restart: saved });
      } catch {
        return reply(
          { error: "Could not open sandbox settings; restart Pi or use axon sandbox" },
          503,
        );
      } finally {
        busy = false;
      }
    },
    async takeRestart(): Promise<SandboxRestartSession | undefined> {
      const session = restartSession;
      restartSession = undefined;
      // Recheck after graceful shutdown, before the next process consumes session data.
      return session ? validateResumeSession(paths, session) : undefined;
    },
    dispose(): void {
      // Release terminal prompts if Pi exits or its backend authorization expires.
      shutdown.abort();
    },
  };
}
