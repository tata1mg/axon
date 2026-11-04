import { describe, expect, test } from "bun:test";
import { constants } from "node:os";

const exitStatusModule = new URL("../src/launcher/exit-status.ts", import.meta.url).href;

function runExitLikeChild(exitCode: number | null, signalCode: string | number | null) {
  return Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
        import { exitLikeChild } from ${JSON.stringify(exitStatusModule)};
        process.on("SIGTERM", () => process.exit(99));
        exitLikeChild(${JSON.stringify({ exitCode, signalCode })});
      `,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
}

describe("child exit status", () => {
  test.each([0, 42, null])("preserves exit code %s", async (exitCode) => {
    const child = runExitLikeChild(exitCode, null);
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(stderr).toBe("");
    expect(status).toBe(exitCode ?? 1);
    expect(child.signalCode).toBeNull();
  });

  test.each(["SIGTERM", constants.signals.SIGTERM])(
    "re-raises signal %s after removing listeners",
    async (signalCode) => {
      const child = runExitLikeChild(null, signalCode);
      const [, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

      expect(stderr).toBe("");
      expect(child.signalCode === "SIGTERM" || child.signalCode === constants.signals.SIGTERM).toBe(
        true,
      );
      expect(child.exitCode).toBeNull();
    },
  );
});
