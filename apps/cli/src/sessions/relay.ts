import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { projectSessionDirectory } from "../axon-safehouse/session-paths.ts";
import { BUILD_INFO } from "../build-info.ts";
import type { AxonPaths } from "../product/paths.ts";
import { emitProductEvent } from "../telemetry/product-events.ts";
import { BackupApi, BackupApiError } from "./api.ts";
import { BackupLocalSettingsError, BackupPolicyError, SessionBackups } from "./backup.ts";
import { resumeSchema } from "./contracts.ts";
import { assertInside } from "./files.ts";

const captureSchema = z.strictObject({
  source: z.string().min(1).max(4096).optional(),
  nativeId: z.string().min(1).max(256),
  resume: resumeSchema,
  reason: z.enum(["session_start", "session_shutdown", "manual"]),
});

/** Backup credentials, queue state and signed uploads never enter the Pi process. */
export function createBackupRelay(paths: AxonPaths, cwd: string) {
  const backups = new SessionBackups(
    paths,
    new BackupApi(paths, BUILD_INFO.serviceOrigin),
    emitProductEvent,
  );
  const root = projectSessionDirectory(paths, cwd);
  return async (request: Request, url: URL): Promise<Response | undefined> => {
    if (!url.pathname.startsWith("/_axon/backups/")) return undefined;
    const reply = (value: unknown, status = 200) =>
      Response.json(value, {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    if (request.method !== "POST" || url.search !== "")
      return reply({ error: "Unavailable backup operation" }, 404);
    try {
      const body = await request.text();
      if (Buffer.byteLength(body) > 16384) return reply({ error: "Backup request too large" }, 413);
      const input: unknown = JSON.parse(body);
      if (url.pathname === "/_axon/backups/status" || url.pathname === "/_axon/backups/retry") {
        z.strictObject({}).parse(input);
        if (url.pathname.endsWith("/retry")) await backups.retry();
        return reply({ status: await backups.status() });
      }
      if (!["/_axon/backups/capture", "/_axon/backups/leaf"].includes(url.pathname)) {
        return reply({ error: "Unavailable backup operation" }, 404);
      }
      const capture = captureSchema.parse(input);
      if (capture.source) {
        if (!isAbsolute(capture.source) || !capture.source.endsWith(".jsonl"))
          throw new Error("Invalid session path");
        await assertInside(root, capture.source);
        if ((await lstat(capture.source)).nlink !== 1) throw new Error("Linked session file");
      }
      if (url.pathname.endsWith("/leaf")) {
        await backups.recordLeaf(capture.source, capture.nativeId, capture.resume);
        return reply({ status: "Selection saved" });
      }
      const status = await backups.boundary(
        capture.source,
        capture.nativeId,
        capture.resume,
        capture.reason,
        request.signal,
      );
      return reply({ status });
    } catch (error) {
      // Domain failures are safe status messages, not failures of the loopback transport.
      // Never relay arbitrary exception text: it may contain paths or credentials.
      if (error instanceof BackupLocalSettingsError || error instanceof BackupPolicyError)
        return reply({ status: error.message });
      if (error instanceof BackupApiError) {
        if (error.status === 401)
          return reply({ status: "Backup login required; sign in to Axon and retry" });
        if (error.status === 403)
          return reply({
            status: "Backup access denied; verify the signed-in account and permissions",
          });
        if (error.status === 503)
          return reply({
            status:
              "Backup service is disabled or unavailable; check backend private storage configuration",
          });
        return reply({
          status: `Backup service returned HTTP ${error.status}; retry later. Existing snapshots were retained`,
        });
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return reply({ error: "Invalid backup request" }, 400);
      return reply({ error: "Backup action failed safely; existing snapshots were retained" }, 503);
    }
  };
}
