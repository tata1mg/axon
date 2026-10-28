import { confirm, isCancel } from "@clack/prompts";

import { currentPiInvocationEnvironment } from "../../harnesses/pi/setup/packages/invocation.ts";
import { configurePaseo, type PaseoSetupOptions } from "../../integrations/paseo.ts";

export async function runPaseoSetup(
  options: PaseoSetupOptions,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const invocation = currentPiInvocationEnvironment(environment);
  const interactive = !invocation.ci && invocation.stdinIsTty && invocation.stdoutIsTty;
  const result = await configurePaseo({
    ...options,
    environment,
    cwd,
    ...(interactive
      ? {
          confirmReplacement: async (configPath: string) => {
            const answer = await confirm({
              message: `Update the existing Axon provider in ${configPath}?`,
              initialValue: false,
            });
            return !isCancel(answer) && answer === true;
          },
        }
      : {}),
  });

  if (result.status === "cancelled") {
    console.log("Paseo setup cancelled; config left unchanged.");
    return;
  }
  if (result.status === "unchanged") {
    console.log(`Paseo already has the Axon provider configured: ${result.configPath}`);
    return;
  }
  console.log(`Paseo Axon provider configured: ${result.configPath}`);
  if (result.backupPath !== undefined)
    console.log(`Previous config backed up to: ${result.backupPath}`);
  console.log("Restart Paseo to load the Axon provider, then select Axon when starting a new chat.");
}
