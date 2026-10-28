import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type NormalizedPiPackage,
  resolveInstalledPackagePath,
} from "../../src/harnesses/pi/setup/packages/manifest.ts";

// Metadata-only installs for launcher tests; never download or execute package code.
export async function writePiPackageFixture(
  entry: NormalizedPiPackage,
  piAgentDirectory: string,
): Promise<void> {
  const directory = resolveInstalledPackagePath(entry, piAgentDirectory);
  if (entry.sourceKind === "git") {
    const commit =
      entry.versionPolicy.kind === "exact" ? entry.versionPolicy.commit : "a".repeat(40);
    if (commit === undefined) throw new Error(`Git fixture requires a commit: ${entry.id}`);
    // Git recognizes this detached HEAD without needing upstream commit objects.
    await mkdir(join(directory, ".git", "objects"), { recursive: true });
    await mkdir(join(directory, ".git", "refs"), { recursive: true });
    await Bun.write(join(directory, ".git", "HEAD"), `${commit}\n`);
    return;
  }

  const version = entry.versionPolicy.kind === "floating" ? "1.0.0" : entry.versionPolicy.version;
  if (entry.packageName === undefined || version === undefined) {
    throw new Error(`npm fixture requires a package name and version: ${entry.id}`);
  }
  await mkdir(directory, { recursive: true });
  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify({ name: entry.packageName, version }),
  );
}
