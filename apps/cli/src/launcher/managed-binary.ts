import { stat } from "node:fs/promises";

import type { AxonPaths } from "../product/paths.ts";

export async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftStatus, rightStatus] = await Promise.all([stat(left), stat(right)]);
    return leftStatus.dev === rightStatus.dev && leftStatus.ino === rightStatus.ino;
  } catch {
    return false;
  }
}

/** Source runs and package-manager copies must not manage files in the Axon bin directory. */
export function isRunningManagedBinary(paths: AxonPaths): Promise<boolean> {
  return sameFile(process.execPath, paths.managedBinary);
}
