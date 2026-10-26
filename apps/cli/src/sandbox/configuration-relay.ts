import * as prompts from "@clack/prompts";
import { z } from "zod";

import { runSandboxMenu } from "../cli/commands/sandbox.ts";
import type { AxonPaths } from "../product/paths.ts";
import { readFilesystemPreferences } from "./filesystem.ts";

const configurationSchema = z.strictObject({});

/** Pi may request the editor, but only the human at Axon's terminal can choose and save grants. */
export function createSandboxConfigurationRelay(paths: AxonPaths, cwd: string) {
  const shutdown = new AbortController();
  let busy = false;
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

  return {
    async handle(request: Request, url: URL): Promise<Response> {
      // Report the parent's live invocation settings, never a persisted or child-supplied profile.
      if (
        url.pathname === "/_axon/sandbox/status" &&
        request.method === "GET" &&
        url.search === "" &&
        !shutdown.signal.aborted
      ) {
        try {
          const preferences = await readFilesystemPreferences(paths, cwd);
          return reply({ project: cwd, ...preferences });
        } catch {
          return reply({ error: "Current sandbox settings are unavailable" }, 503);
        }
      }
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
        // Pi may open the editor, but may not submit grants, argv, session data or a project.
        const body = await request.text();
        if (Buffer.byteLength(body) > 8192)
          return reply({ error: "Sandbox configuration request is too large" }, 413);
        configurationSchema.parse(JSON.parse(body));
        signal.throwIfAborted();
        const saved = await runSandboxMenu(paths, cwd, prompts, { signal });
        return reply({ opened: true, saved });
      } catch {
        return reply({ error: "Could not open sandbox settings; try /sandbox again" }, 503);
      } finally {
        busy = false;
      }
    },
    dispose(): void {
      // Release terminal prompts if Pi exits or its backend authorization expires.
      shutdown.abort();
    },
  };
}
