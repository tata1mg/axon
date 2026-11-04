import { join, resolve } from "node:path";

import type { AxonPaths } from "../product/paths.ts";

/** Matches the pinned Pi session manager; do not grant other projects' histories. */
export function projectSessionDirectory(paths: AxonPaths, cwd: string): string {
  const encoded = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(paths.piSessions, encoded);
}
