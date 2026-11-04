import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Mirrors `resolveGitAiBinary` in the git-ai Pi extension. That extension is embedded
 * as a standalone file asset, so the launcher cannot import it as a module without
 * making the compiled bundle depend on import order. Keep both lookups in sync.
 *
 * An explicit override is authoritative; otherwise prefer the official install, then PATH.
 */
export async function resolveGitAiBinary(
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): Promise<string | undefined> {
  const override = environment["PI_AXON_GIT_AI_BIN"]?.trim();
  const candidates = override
    ? [override]
    : [
        join(userHome, ".git-ai", "bin", "git-ai"),
        ...(environment["PATH"] ?? "")
          .split(delimiter)
          // Never discover executables through cwd or relative PATH entries.
          .filter((directory) => isAbsolute(directory))
          .map((directory) => join(directory, "git-ai")),
      ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Missing or inaccessible integrations are optional.
    }
  }
  return undefined;
}
