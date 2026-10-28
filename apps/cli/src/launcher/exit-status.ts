import { constants } from "node:os";

export const LAUNCHER_EXIT_STATUS = Object.freeze({
  usage: 120,
  executableUnavailable: 121,
  materializationFailure: 122,
  profileFailure: 123,
  updateFailure: 124,
  unsupportedEnvironment: 125,
});

export type LauncherExitStatus = (typeof LAUNCHER_EXIT_STATUS)[keyof typeof LAUNCHER_EXIT_STATUS];

export function exitLikeChild(result: {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | number | null;
}): never {
  if (result.signalCode) {
    const signalNumber =
      typeof result.signalCode === "number"
        ? result.signalCode
        : constants.signals[result.signalCode];
    const signalName =
      typeof result.signalCode === "string"
        ? result.signalCode
        : Object.entries(constants.signals).find(([, number]) => number === signalNumber)?.[0];

    if (signalName !== undefined) {
      process.removeAllListeners(signalName);
    }
    process.kill(process.pid, result.signalCode);
    process.exit(128 + (signalNumber ?? 0));
  }

  process.exit(result.exitCode ?? 1);
}
