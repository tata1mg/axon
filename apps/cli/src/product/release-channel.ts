import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ReleaseChannel = "stable" | "beta";

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return value === "stable" || value === "beta";
}

export function releaseChannelForVersion(version: string): ReleaseChannel {
  return version.split("+", 1)[0]?.includes("-") ? "beta" : "stable";
}

/** Missing selection means stable. Never silently reset a damaged beta selection. */
export function readReleaseChannel(home: string): ReleaseChannel {
  try {
    const state: unknown = JSON.parse(readFileSync(join(home, "release-channel.json"), "utf8"));
    if (
      state &&
      typeof state === "object" &&
      "channel" in state &&
      isReleaseChannel(state.channel)
    ) {
      return state.channel;
    }
    throw new Error("invalid channel selection");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "stable";
    throw new Error("Cannot read the update channel. Repair release-channel.json before updating.");
  }
}

/** Diagnostics must remain available even if local selection is damaged. */
export function describeReleaseChannel(home: string): ReleaseChannel | "unknown" {
  try {
    return readReleaseChannel(home);
  } catch {
    return "unknown";
  }
}

export async function saveReleaseChannel(home: string, channel: ReleaseChannel): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, "release-channel.json");
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ channel })}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    // A cleanup error after the atomic rename must not report a failed commit.
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Isolate mutable prerelease state; never migrate stable settings/packages in place. */
export function releaseStateHome(home: string, version: string): string {
  return releaseChannelForVersion(version) === "beta" ? join(home, "channels", "beta") : home;
}
