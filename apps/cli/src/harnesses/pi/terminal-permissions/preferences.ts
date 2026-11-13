import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { withFileLock } from "../../../launcher/file-lock.ts";

/** User-level only: never read project settings or session history for approval consent. */
export function terminalPreferencesPath(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment["HOME"] || homedir();
  const axonHome = environment["AXON_HOME"]?.trim() || join(home, ".axon");
  const agentDirectory = environment["PI_CODING_AGENT_DIR"]?.trim() || join(axonHome, "pi");
  return resolve(agentDirectory, "terminal-preferences.json");
}

/** Read on every authorization, not just startup: another process may have disabled YOLO. */
export function readYoloPreference(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (
      value !== null &&
      typeof value === "object" &&
      "version" in value &&
      value.version === 1 &&
      "yoloEnabled" in value &&
      value.yoloEnabled === true
    );
  } catch {
    // Missing, corrupt, or unreadable consent must never leave cached YOLO enabled.
    return false;
  }
}

export async function toggleYoloPreference(
  path: string,
  options: { readonly allowEnable: boolean; readonly signal?: AbortSignal },
): Promise<boolean> {
  // Serialize the read-modify-write across processes so concurrent toggles are not lost.
  return withFileLock(
    `${path}.lock`,
    async () => {
      const enabled = !readYoloPreference(path);
      if (enabled && !options.allowEnable) throw new Error("YOLO activation is unavailable");
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, yoloEnabled: enabled })}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        options.signal?.throwIfAborted();
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return enabled;
    },
    options.signal === undefined ? {} : { signal: options.signal },
  );
}

/** Polling survives atomic replacements and creation/deletion of the preference file. */
export function watchYoloPreference(path: string, onChange: () => void): () => void {
  watchFile(path, { interval: 500, persistent: false }, onChange);
  return () => unwatchFile(path, onChange);
}
