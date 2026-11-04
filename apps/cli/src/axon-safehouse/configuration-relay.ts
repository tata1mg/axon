import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as prompts from "@clack/prompts";
import { z } from "zod";

import { runAxonSafehouseMenu } from "../cli/commands/axon-safehouse.ts";
import type { AxonSafehouseResumeSession } from "../launcher/contracts.ts";
import type { AxonPaths } from "../product/paths.ts";
import { assertInside } from "../sessions/files.ts";
import { canonicalPath, readFilesystemPreferences } from "./filesystem.ts";
import type { AxonSafehousePolicy } from "./policy.ts";

const configurationSchema = z.strictObject({
  sessionId: z.uuid(),
  sessionFile: z.string().min(1).max(4096).refine(isAbsolute).optional(),
});

/** Validate again after the old process group is gone, before constructing resume argv. */
export async function validateAxonSafehouseResumeSession(
  paths: AxonPaths,
  value: unknown,
): Promise<AxonSafehouseResumeSession> {
  const session = configurationSchema.parse(value);
  if (!session.sessionFile) return { sessionId: session.sessionId };
  if (!session.sessionFile.endsWith(".jsonl")) throw new Error("Invalid resume session file");
  await assertInside(paths.piSessions, session.sessionFile);
  const handle = await open(session.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid()))
      throw new Error("Unsafe resume session file");
    // Only inspect the bounded native header, never import transcript data as code or argv.
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const headerEnd = buffer.subarray(0, bytesRead).indexOf(10);
    if (headerEnd === -1) throw new Error("Missing resume session header");
    const header = z
      .object({ type: z.literal("session"), id: z.uuid() })
      .parse(JSON.parse(buffer.subarray(0, headerEnd).toString("utf8")));
    if (header.id !== session.sessionId) throw new Error("Resume session identity changed");
    return { sessionId: session.sessionId, sessionFile: await canonicalPath(session.sessionFile) };
  } finally {
    await handle.close();
  }
}

/** Pi may request the editor, but only the human at Axon's terminal can choose and save grants. */
export function createAxonSafehouseConfigurationRelay(
  paths: AxonPaths,
  cwd: string,
  /** The invocation's compiled boundary; saves must never validate against a newer policy. */
  authorize: () => Promise<AxonSafehousePolicy>,
  prepareRestart?: (session: AxonSafehouseResumeSession) => () => void,
) {
  const shutdown = new AbortController();
  let busy = false;
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

  return {
    async handle(request: Request, url: URL): Promise<Response> {
      // Report the parent's live invocation settings, never a persisted or child-supplied profile.
      if (
        url.pathname === "/_axon/axon-safehouse/status" &&
        request.method === "GET" &&
        url.search === "" &&
        !shutdown.signal.aborted
      ) {
        try {
          const preferences = await readFilesystemPreferences(paths, cwd);
          return reply({ project: cwd, ...preferences });
        } catch {
          return reply({ error: "Current Axon Safehouse settings are unavailable" }, 503);
        }
      }
      if (
        url.pathname !== "/_axon/axon-safehouse/configure" ||
        request.method !== "POST" ||
        url.search !== "" ||
        !prepareRestart ||
        !process.stdin.isTTY ||
        !process.stdout.isTTY ||
        shutdown.signal.aborted
      ) {
        return reply({ error: "Interactive Axon Safehouse configuration is unavailable" }, 404);
      }
      if (busy) return reply({ error: "The Axon Safehouse editor is already open" }, 409);
      busy = true;
      const signal = AbortSignal.any([request.signal, shutdown.signal]);
      let editorClosed: (() => void) | undefined;
      try {
        // Pi supplies only its resume identity, never grants, argv, transcript data or a project.
        const body = await request.text();
        if (Buffer.byteLength(body) > 8192)
          return reply({ error: "Axon Safehouse configuration request is too large" }, 413);
        const session = await validateAxonSafehouseResumeSession(paths, JSON.parse(body));
        signal.throwIfAborted();
        // Arm the resume target before saving can revoke and terminate the old process.
        editorClosed = prepareRestart(session);
        const saved = await runAxonSafehouseMenu(paths, cwd, prompts, { signal, authorize });
        return reply({ opened: true, saved });
      } catch {
        return reply(
          { error: "Could not open Axon Safehouse settings; try /safehouse again" },
          503,
        );
      } finally {
        busy = false;
        // A replacement TUI must not compete with the parent's terminal editor.
        editorClosed?.();
      }
    },
    dispose(): void {
      // Release terminal prompts if Pi exits or its backend authorization expires.
      shutdown.abort();
    },
  };
}
